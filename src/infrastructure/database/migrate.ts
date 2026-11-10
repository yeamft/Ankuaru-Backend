import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import type { Pool, PoolClient } from "pg";

// Resolves from both src/ (tsx) and dist/ (compiled).
const DIRECTORY = new URL("../../../migrations/", import.meta.url);
// Shared by every instance so only one applies migrations at a time.
const LOCK_ID = 4_142_026;

export type Migration = { version: number; name: string; sql: string; checksum: string };

export async function loadMigrations(directory: URL = DIRECTORY): Promise<Migration[]> {
  const names = (await readdir(directory)).filter((name) => /^\d+_.+\.sql$/.test(name));
  const migrations = await Promise.all(
    names.map(async (name) => {
      const sql = await readFile(new URL(name, directory), "utf8");
      return {
        version: Number(name.slice(0, name.indexOf("_"))),
        name,
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    }),
  );
  return migrations.sort((a, b) => a.version - b.version);
}

/**
 * The Axum service applied these migrations with sqlx. Record its successful
 * versions once so existing databases are not migrated a second time.
 */
async function adoptSqlxHistory(client: PoolClient, migrations: Migration[]) {
  const legacy = await client.query<{ present: boolean }>(
    "SELECT to_regclass('_sqlx_migrations') IS NOT NULL AS present",
  );
  if (!legacy.rows[0].present) return;
  const rows = await client.query<{ version: string; success: boolean }>(
    "SELECT version::text AS version, success FROM _sqlx_migrations ORDER BY version",
  );
  for (const row of rows.rows) {
    const migration = migrations.find(({ version }) => version === Number(row.version));
    if (!migration || !row.success) {
      throw new Error(`sqlx migration ${row.version} is unknown or failed; resolve it manually`);
    }
    await client.query(
      `INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)
       ON CONFLICT (version) DO NOTHING`,
      [migration.version, migration.name, migration.checksum],
    );
  }
}

/** Applies pending migrations, each in its own transaction. Returns the names applied. */
export async function migrate(pool: Pool, migrations?: Migration[]): Promise<string[]> {
  const available = migrations ?? (await loadMigrations());
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);
    try {
      await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version BIGINT PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
      await adoptSqlxHistory(client, available);
      const applied = new Map(
        (
          await client.query<{ version: string; checksum: string }>(
            "SELECT version::text AS version, checksum FROM schema_migrations",
          )
        ).rows.map((row) => [Number(row.version), row.checksum]),
      );
      const ran: string[] = [];
      for (const migration of available) {
        const checksum = applied.get(migration.version);
        if (checksum !== undefined) {
          if (checksum !== migration.checksum) {
            throw new Error(`Migration ${migration.name} changed after it was applied`);
          }
          continue;
        }
        await client.query("BEGIN");
        try {
          await client.query(migration.sql);
          await client.query(
            "INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)",
            [migration.version, migration.name, migration.checksum],
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
        ran.push(migration.name);
      }
      return ran;
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]);
    }
  } finally {
    client.release();
  }
}
