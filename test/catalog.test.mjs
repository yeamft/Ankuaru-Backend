import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { digestToken } from "../dist/modules/auth/index.js";
import { call, createTestDatabase, fixture, resetDatabase } from "./helpers.mjs";

let context;
before(async () => {
  context = await createTestDatabase();
});
beforeEach(async () => {
  await resetDatabase(context.database);
  // Products added by a test are removed; the seeded catalog stays.
  await context.database.exec(
    "DELETE FROM catalog_products WHERE id NOT IN ('export-coffee', 'roasted-coffee', 'reject-coffee') AND key <> 'general'; UPDATE catalog_products SET active = true, name = initcap(replace(key, '-', ' ')) WHERE id = 'reject-coffee';",
  );
});
after(() => context.database.close());

const query = async (sql, values) => (await context.database.query(sql, values)).rows;

async function person(accountRole = "user", verified = true) {
  const id = `usr_${randomUUID()}`;
  const token = randomBytes(32).toString("base64url");
  await query(
    "INSERT INTO traders (id, display_name, role, status, verified, phone_verified) VALUES ($1, $1, 'both', 'Active', $2, $2)",
    [id, verified],
  );
  await query(
    "INSERT INTO accounts (id, email, password_hash, account_role) VALUES ($1, $2, 'x', $3)",
    [id, `${id}@example.com`, accountRole],
  );
  await query(
    "INSERT INTO account_sessions (token_hash, account_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
    [digestToken(token), id],
  );
  return { id, headers: { authorization: `Bearer ${token}` } };
}

const staff = (base, who, path, method = "GET", body) =>
  call(base, `/catalog/admin${path}`, { method, headers: who.headers, body });

test("platform admins add, rename, retire and restore products", async (t) => {
  const base = await fixture(t, context);
  const ops = await person("platform_admin");

  const created = await staff(base, ops, "/products", "POST", {
    category_id: "oil-seeds",
    name: "White Sesame (Humera)",
    name_am: "ነጭ ሰሊጥ",
  });
  assert.equal(created.status, 201, await created.clone().text());
  const sesame = await created.json();
  assert.equal(sesame.id, "oil-seeds-white-sesame-humera");
  assert.equal(sesame.key, "white-sesame-humera");

  const duplicate = await staff(base, ops, "/products", "POST", {
    category_id: "oil-seeds",
    name: "white sesame humera",
  });
  assert.equal(duplicate.status, 409);
  assert.equal(
    (await staff(base, ops, "/products", "POST", { category_id: "nope", name: "Teff" })).status,
    404,
  );

  const renamed = await staff(base, ops, `/products/${sesame.id}`, "PATCH", { name: "Humera Sesame" });
  assert.equal((await renamed.json()).name, "Humera Sesame");

  const publicNames = async () =>
    (await (await call(base, "/catalog")).json())
      .find(({ id }) => id === "oil-seeds")
      .products.map(({ name }) => name);
  assert.ok((await publicNames()).includes("Humera Sesame"));
  await staff(base, ops, `/products/${sesame.id}`, "PATCH", { active: false });
  assert.ok(!(await publicNames()).includes("Humera Sesame"));
  const staffView = await (await staff(base, ops, "")).json();
  const retired = staffView.find(({ id }) => id === "oil-seeds").products.find(({ id }) => id === sesame.id);
  assert.equal(retired.active, false);
  assert.equal(retired.listing_count, 0);

  assert.deepEqual(
    (await query("SELECT action FROM audit_events ORDER BY created_at")).map(({ action }) => action),
    ["product.created", "product.updated", "product.retired"],
  );
});

test("only staff with the permission manage products", async (t) => {
  const base = await fixture(t, context);
  for (const role of ["user", "moderator", "content_manager"]) {
    const who = await person(role);
    const response = await staff(base, who, "/products", "POST", { category_id: "coffee", name: "Green" });
    assert.equal(response.status, 403, role);
  }
  const root = await person("super_admin");
  assert.equal((await staff(base, root, "")).status, 200);
});

test("listings must use an active catalog product, and show its current name", async (t) => {
  const base = await fixture(t, context);
  const ops = await person("platform_admin");
  const seller = await person();
  const post = (product) =>
    call(base, "/listings", {
      method: "POST",
      headers: seller.headers,
      body: { intent: "sell", category: "coffee", product },
    });

  assert.equal((await post("Unknown Bean")).status, 400);
  const byName = await post("Export Coffee");
  assert.equal(byName.status, 201);
  const listing = await byName.json();
  assert.equal(listing.product, "export-coffee");
  assert.equal(listing.product_name, "Export Coffee");

  await staff(base, ops, "/products/reject-coffee", "PATCH", { active: false });
  assert.equal((await post("reject-coffee")).status, 400);

  // A product in use cannot be deleted, only retired.
  const blocked = await staff(base, ops, "/products/export-coffee", "DELETE");
  assert.equal(blocked.status, 409);
  const extra = await (await staff(base, ops, "/products", "POST", { category_id: "coffee", name: "Green Beans" })).json();
  const deleted = await staff(base, ops, `/products/${extra.id}`, "DELETE");
  assert.deepEqual(await deleted.json(), { id: extra.id, deleted: true });
});

test("the public price board shows each product's latest price, change and trend, and the USD/ETB rate", async (t) => {
  const base = await fixture(t, context);
  const empty = await (await call(base, "/catalog/prices/latest")).json();
  assert.deepEqual(empty, { prices: [], exchange_rate: null });

  const admin = await person("super_admin");
  await query(
    `INSERT INTO market_prices (product_id, price, currency, market, price_date, created_by) VALUES
      ('export-coffee', 5.5, 'USD', 'ECX', current_date - 14, $1),
      ('export-coffee', 5.0, 'USD', 'ECX', current_date - 7, $1),
      ('export-coffee', 5.5, 'USD', 'ECX', current_date, $1),
      ('oil-seeds-general', 9000, 'ETB', 'Humera', current_date, $1),
      ('roasted-coffee', 1200, 'ETB', 'Addis', current_date - 400, $1)`,
    [admin.id],
  );
  await query(
    `INSERT INTO exchange_rates (base_currency, quote_currency, rate, effective_at, created_by) VALUES
      ('USD', 'ETB', 150, now() - interval '2 days', $1), ('USD', 'ETB', 155.25, now() - interval '1 day', $1),
      ('EUR', 'ETB', 170, now(), $1)`,
    [admin.id],
  );

  const board = await (await call(base, "/catalog/prices/latest")).json();
  // Prices older than 180 days drop off; coffee sorts before oil seeds.
  assert.deepEqual(board.prices.map((row) => row.product_id), ["export-coffee", "oil-seeds-general"]);
  const coffee = board.prices[0];
  assert.equal(coffee.price, 5.5);
  assert.equal(coffee.previous_price, 5);
  assert.equal(coffee.change_percent, 10);
  assert.deepEqual(coffee.history.map((point) => point.price), [5.5, 5, 5.5]);
  assert.equal(board.prices[1].change_percent, null);
  assert.equal(board.exchange_rate.rate, 155.25);
  assert.equal(board.exchange_rate.base_currency, "USD");
});
