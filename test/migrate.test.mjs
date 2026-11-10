import assert from "node:assert/strict";
import test from "node:test";
import { loadMigrations, migrate } from "../dist/infrastructure/database/index.js";
import { createDatabase, poolFor } from "./helpers.mjs";

test("migrations apply once, in order, and record their checksums", async () => {
  const database = createDatabase();
  try {
    const pool = poolFor(database);
    const migrations = await loadMigrations();
    assert.deepEqual(
      migrations.map(({ version }) => version),
      [1, 2, 3, 4, 5],
    );
    assert.deepEqual(
      await migrate(pool),
      migrations.map(({ name }) => name),
    );
    assert.deepEqual(await migrate(pool), []);
    const recorded = await database.query(
      "SELECT version, checksum FROM schema_migrations ORDER BY version",
    );
    assert.deepEqual(
      recorded.rows.map((row) => row.checksum),
      migrations.map(({ checksum }) => checksum),
    );
  } finally {
    await database.close();
  }
});

test("databases migrated by the Axum service are adopted without re-running migrations", async () => {
  const database = createDatabase();
  try {
    const pool = poolFor(database);
    const migrations = await loadMigrations();
    const earlier = migrations.filter(({ version }) => version < 4);
    for (const { sql } of earlier) await database.exec(sql);
    // The table sqlx maintains; only version and success matter for adoption.
    await database.exec(`
      CREATE TABLE _sqlx_migrations (version BIGINT PRIMARY KEY, description TEXT NOT NULL,
        success BOOLEAN NOT NULL);
      INSERT INTO _sqlx_migrations VALUES (1, 'initial', true), (2, 'accounts', true),
        (3, 'revoke inactive sessions', true);
      INSERT INTO traders (id, display_name) VALUES ('kept', 'Existing trader');
    `);
    // Re-running 001 would re-insert the demo seed listings.
    assert.deepEqual(await migrate(pool), ["004_remove_demo_data.sql", "005_catalog.sql"]);
    assert.deepEqual((await database.query("SELECT id FROM traders")).rows, [{ id: "kept" }]);
    assert.deepEqual((await database.query("SELECT id FROM listings")).rows, []);
  } finally {
    await database.close();
  }
});

test("failed sqlx migrations and edited migrations stop startup", async () => {
  const database = createDatabase();
  try {
    const pool = poolFor(database);
    const migrations = await loadMigrations();
    await database.exec(`
      CREATE TABLE _sqlx_migrations (version BIGINT PRIMARY KEY, description TEXT NOT NULL,
        success BOOLEAN NOT NULL);
      INSERT INTO _sqlx_migrations VALUES (1, 'initial', false);
    `);
    await assert.rejects(migrate(pool), /unknown or failed/);
    await database.exec("DROP TABLE _sqlx_migrations; DROP TABLE schema_migrations");

    await migrate(pool);
    const edited = migrations.map((migration) =>
      migration.version === 2 ? { ...migration, checksum: "edited" } : migration,
    );
    await assert.rejects(migrate(pool, edited), /002_accounts.sql changed/);
  } finally {
    await database.close();
  }
});
