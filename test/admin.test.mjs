import assert from "node:assert/strict";
import { before, beforeEach, after, test } from "node:test";
import { asAdmin, call, createTestDatabase, demoFixture, resetDatabase } from "./helpers.mjs";

let context;
before(async () => {
  context = await createTestDatabase();
});
beforeEach(async () => {
  await resetDatabase(context.database);
  await context.database.exec(`
    INSERT INTO traders (id, display_name, role, verified, status) VALUES
      ('buyer-demo', 'Test buyer', 'buyer', false, 'Active'),
      ('seller-demo', 'Test supplier', 'seller', true, 'Active');
    INSERT INTO listings (id, owner_id, reference, intent, category, product, status) VALUES
      ('post_002', 'seller-demo', 'TEST-002', 'sell', 'coffee', 'Coffee', 'Active');
  `);
});
after(() => context.database.close());

const query = async (sql, values) => (await context.database.query(sql, values)).rows;
const patch = (base, path, body) =>
  call(base, `/admin${path}`, { method: "PATCH", headers: asAdmin, body });

async function verification(traderId = "seller-demo") {
  const [row] = await query(
    `INSERT INTO verification_requests (trader_id, document_summary)
     VALUES ($1, 'Business license') RETURNING id`,
    [traderId],
  );
  return row.id;
}

async function rejectAudit() {
  await context.database.exec(`
    CREATE OR REPLACE FUNCTION reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Simulated audit storage failure'; END; $$;
    CREATE TRIGGER reject_audit BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION reject_audit();
  `);
}

test("admin endpoints require an administrator", async (t) => {
  const base = await demoFixture(t, context);
  for (const headers of [{}, { "x-demo-user-id": "seller-demo" }, { "x-demo-admin-id": "root" }]) {
    const response = await call(base, "/admin/overview", { headers });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, "admin_required");
  }
});

test("overview counts are numbers", async (t) => {
  const base = await demoFixture(t, context);
  await verification();
  const overview = await (await call(base, "/admin/overview", { headers: asAdmin })).json();
  assert.deepEqual(overview, {
    traders: 2,
    active_listings: 1,
    pending_review: 0,
    pending_offers: 0,
    pending_inquiries: 0,
    flagged: 0,
    open_inquiries: 0,
    pending_verifications: 1,
  });
});

test("verification preserves suspension and only approval activates a pending trader", async (t) => {
  const base = await demoFixture(t, context);
  for (const [beforeStatus, decision, afterStatus] of [
    ["Pending", "Approved", "Active"],
    ["Pending", "Declined", "Pending"],
    ["Suspended", "Approved", "Suspended"],
    ["Suspended", "Declined", "Suspended"],
    ["Active", "Declined", "Active"],
  ]) {
    await query("UPDATE traders SET status = $1, verified = false WHERE id = 'seller-demo'", [
      beforeStatus,
    ]);
    const id = await verification();
    const response = await patch(base, `/verifications/${id}`, { status: decision });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.status, decision);
    assert.equal(result.trader_name, "Test supplier");
    assert.deepEqual(await query("SELECT status, verified FROM traders WHERE id = 'seller-demo'"), [
      { status: afterStatus, verified: decision === "Approved" },
    ]);
  }
  const [{ count }] = await query(
    "SELECT count(*)::int AS count FROM audit_events WHERE action = 'verification.reviewed'",
  );
  assert.equal(count, 5);
});

test("verification rolls back the request and trader when the audit write fails", async (t) => {
  const base = await demoFixture(t, context);
  await query("UPDATE traders SET status = 'Pending', verified = false WHERE id = 'seller-demo'");
  const id = await verification();
  await rejectAudit();
  const response = await patch(base, `/verifications/${id}`, { status: "Approved" });
  assert.equal(response.status, 500);
  assert.deepEqual(await query("SELECT status, verified FROM traders WHERE id = 'seller-demo'"), [
    { status: "Pending", verified: false },
  ]);
  assert.deepEqual(
    await query("SELECT status, reviewed_by FROM verification_requests WHERE id = $1", [id]),
    [{ status: "Pending", reviewed_by: null }],
  );
});

test("admin changes roll back when the audit write fails", async (t) => {
  const base = await demoFixture(t, context);
  const [{ id: inquiryId }] = await query(
    `INSERT INTO inquiries (listing_id, buyer_id, seller_id, message)
     VALUES ('post_002', 'buyer-demo', 'seller-demo', 'Quote request') RETURNING id`,
  );
  await rejectAudit();

  assert.equal((await patch(base, "/listings/post_002", { status: "Flagged" })).status, 500);
  assert.deepEqual(await query("SELECT status FROM listings WHERE id = 'post_002'"), [
    { status: "Active" },
  ]);
  assert.equal((await patch(base, `/inquiries/${inquiryId}`, { status: "Closed" })).status, 500);
  assert.deepEqual(await query("SELECT status FROM inquiries WHERE id = $1", [inquiryId]), [
    { status: "New" },
  ]);
  const setting = await patch(base, "/settings/marketplace", { value: { maintenanceMode: true } });
  assert.equal(setting.status, 500);
  assert.deepEqual(
    await query(
      `SELECT (setting_value->>'maintenanceMode')::boolean AS on FROM platform_settings
       WHERE setting_key = 'marketplace'`,
    ),
    [{ on: false }],
  );
});

test("suspension revokes sessions, and an audit failure restores them", async (t) => {
  const base = await demoFixture(t, context);
  await context.database.exec(`
    INSERT INTO accounts (id, email, password_hash) VALUES ('seller-demo', 'seller@example.com', 'test-hash');
    INSERT INTO account_sessions (token_hash, account_id, expires_at)
      VALUES ('test-token', 'seller-demo', now() + interval '1 day');
  `);
  await rejectAudit();
  assert.equal((await patch(base, "/traders/seller-demo", { status: "Suspended" })).status, 500);
  assert.deepEqual(await query("SELECT status FROM traders WHERE id = 'seller-demo'"), [
    { status: "Active" },
  ]);
  assert.equal((await query("SELECT * FROM account_sessions")).length, 1);

  await context.database.exec("DROP TRIGGER reject_audit ON audit_events");
  for (const status of ["Suspended", "Active"]) {
    const response = await patch(base, "/traders/seller-demo", { status });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, status);
    assert.equal((await query("SELECT * FROM account_sessions")).length, 0);
  }
  const [{ count }] = await query(
    "SELECT count(*)::int AS count FROM audit_events WHERE action = 'trader.updated'",
  );
  assert.equal(count, 2);
});

test("only one of two competing verification reviews commits", async (t) => {
  const base = await demoFixture(t, context);
  const id = await verification();
  const results = await Promise.all(
    ["Approved", "Declined"].map((status) => patch(base, `/verifications/${id}`, { status })),
  );
  assert.deepEqual(results.map(({ status }) => status).sort(), [200, 404]);
  const [{ count }] = await query(
    "SELECT count(*)::int AS count FROM audit_events WHERE action = 'verification.reviewed'",
  );
  assert.equal(count, 1);
});

test("trader updates validate input and report listing activity", async (t) => {
  const base = await demoFixture(t, context);
  for (const [body, error] of [
    [{}, "empty_trader_update"],
    [{ status: null, verified: null }, "empty_trader_update"],
    [{ status: "Banned" }, "invalid_trader_status"],
    [{ verified: "yes" }, "invalid_trader_verified"],
  ]) {
    const response = await patch(base, "/traders/seller-demo", body);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, error);
  }
  assert.equal((await patch(base, "/traders/nobody", { verified: true })).status, 404);
  const updated = await (await patch(base, "/traders/seller-demo", { verified: false })).json();
  assert.equal(updated.verified, false);
  assert.equal(updated.active_listings, 1);

  const traders = await (await call(base, "/admin/traders", { headers: asAdmin })).json();
  assert.deepEqual(
    traders.map(({ id, active_listings }) => [id, active_listings]),
    [
      ["seller-demo", 1],
      ["buyer-demo", 0],
    ],
  );
});

test("verification queue lists pending requests first across pages", async (t) => {
  const base = await demoFixture(t, context);
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push(await verification(i % 2 ? "buyer-demo" : "seller-demo"));
  // Decide the two oldest requests; the two newest stay pending.
  for (const id of ids.slice(0, 2)) {
    assert.equal((await patch(base, `/verifications/${id}`, { status: "Declined" })).status, 200);
  }
  const first = await call(base, "/admin/verifications?limit=3", { headers: asAdmin });
  const firstPage = await first.json();
  const cursor = first.headers.get("x-next-cursor");
  assert.ok(cursor);
  const second = await call(base, `/admin/verifications?limit=3&cursor=${cursor}`, {
    headers: asAdmin,
  });
  const secondPage = await second.json();
  assert.equal(second.headers.get("x-next-cursor"), null);
  const all = [...firstPage, ...secondPage];
  assert.deepEqual(
    all.map(({ status }) => status),
    ["Pending", "Pending", "Declined", "Declined"],
  );
  assert.deepEqual(all.map(({ id }) => id).sort(), [...ids].sort());
  assert.ok(all.every((row) => !("rank" in row) && !("_k0" in row)));
});

test("admin inquiry oversight omits message bodies", async (t) => {
  const base = await demoFixture(t, context);
  await query(
    `INSERT INTO inquiries (listing_id, buyer_id, seller_id, message)
     VALUES ('post_002', 'buyer-demo', 'seller-demo', 'Private terms')`,
  );
  const [row] = await (await call(base, "/admin/inquiries", { headers: asAdmin })).json();
  assert.equal(row.listing_reference, "TEST-002");
  assert.equal(row.message, undefined);
  assert.ok(row.received_at);
});

test("settings accept only known keys with object values", async (t) => {
  const base = await demoFixture(t, context);
  for (const [key, value] of [
    ["unknown", {}],
    ["marketplace", []],
    ["marketplace", "on"],
    ["marketplace", null],
  ]) {
    assert.equal((await patch(base, `/settings/${key}`, { value })).status, 400);
  }
  const updated = await patch(base, "/settings/notifications", { value: { emailAlerts: false } });
  assert.equal(updated.status, 200);
  assert.deepEqual((await updated.json()).setting_value, { emailAlerts: false });
  const settings = await (await call(base, "/admin/settings", { headers: asAdmin })).json();
  assert.deepEqual(
    settings.map(({ setting_key }) => setting_key),
    ["marketplace", "notifications"],
  );
});
