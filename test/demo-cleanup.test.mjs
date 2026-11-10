import assert from "node:assert/strict";
import test from "node:test";
import { loadMigrations, migrate } from "../dist/infrastructure/database/index.js";
import { createDatabase, poolFor } from "./helpers.mjs";

test("new databases contain settings but no demo records", async () => {
  const database = createDatabase();
  try {
    await migrate(poolFor(database));
    for (const table of ["traders", "listings", "inquiries"]) {
      assert.deepEqual((await database.query(`SELECT * FROM ${table}`)).rows, []);
    }
    assert.equal((await database.query("SELECT * FROM platform_settings")).rows.length, 2);
  } finally {
    await database.close();
  }
});

test("cleanup removes seeded listings and their inquiries, preserving user-created records", async () => {
  const database = createDatabase();
  try {
    const pool = poolFor(database);
    const migrations = await loadMigrations();
    await migrate(
      pool,
      migrations.filter(({ version }) => version < 4),
    );
    await database.exec(`
      INSERT INTO traders (id, display_name) VALUES ('real-trader', 'Actual trader');
      INSERT INTO accounts (id, email, password_hash) VALUES ('real-trader', 'actual@example.test', 'test-only');
      INSERT INTO listings (id, owner_id, reference, intent, category, product) VALUES
        ('real-listing', 'real-trader', 'REAL-1', 'sell', 'coffee', 'Coffee'),
        ('local-listing', 'seller-demo', 'LOCAL-1', 'buy', 'coffee', 'Coffee');
      INSERT INTO inquiries (listing_id, buyer_id, seller_id, message) VALUES
        ('post_002', 'buyer-demo', 'seller-demo', 'Old seed inquiry'),
        ('real-listing', 'real-trader', 'real-trader', 'Actual inquiry');
    `);
    assert.deepEqual(await migrate(pool, migrations), [
      "004_remove_demo_data.sql",
      "005_catalog.sql",
    ]);
    assert.deepEqual((await database.query("SELECT id FROM listings ORDER BY id")).rows, [
      { id: "local-listing" },
      { id: "real-listing" },
    ]);
    assert.deepEqual((await database.query("SELECT message FROM inquiries")).rows, [
      { message: "Actual inquiry" },
    ]);
    assert.deepEqual((await database.query("SELECT id FROM accounts")).rows, [
      { id: "real-trader" },
    ]);
    assert.deepEqual((await database.query("SELECT id FROM traders ORDER BY id")).rows, [
      { id: "real-trader" },
      { id: "seller-demo" },
    ]);
  } finally {
    await database.close();
  }
});
