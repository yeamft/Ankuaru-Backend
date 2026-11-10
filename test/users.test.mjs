import assert from "node:assert/strict";
import { before, beforeEach, after, test } from "node:test";
import { call, createTestDatabase, fixture, resetDatabase } from "./helpers.mjs";

let context;
before(async () => {
  context = await createTestDatabase();
});
beforeEach(() => resetDatabase(context.database));
after(() => context.database.close());

const query = async (sql, values) => (await context.database.query(sql, values)).rows;

/** Registers an account and returns its id and Bearer headers. */
async function account(base, email, name = email.split("@")[0], role = "user") {
  const response = await call(base, "/auth/register", {
    method: "POST",
    body: { email, password: "a-long-password-123", display_name: name, role: "both" },
  });
  assert.equal(response.status, 201, await response.clone().text());
  const { user, access_token } = await response.json();
  if (role === "admin")
    await query("UPDATE accounts SET account_role = 'super_admin' WHERE id = $1", [user.id]);
  return { id: user.id, headers: { authorization: `Bearer ${access_token}` } };
}

const admin = (base, path, headers, init = {}) => call(base, `/admin${path}`, { headers, ...init });

test("admins list accounts newest first, with search and filters", async (t) => {
  const base = await fixture(t, context);
  const root = await account(base, "root@example.com", "Root", "admin");
  await account(base, "sidama@example.com", "Sidama Union");
  await account(base, "guji_100%@example.com", "Guji Traders");

  const list = async (search, headers = root.headers) =>
    (await admin(base, `/users${search}`, headers)).json();
  const all = await list("");
  assert.deepEqual(
    all.map(({ email }) => email),
    ["guji_100%@example.com", "sidama@example.com", "root@example.com"],
  );
  assert.deepEqual(Object.keys(all[0]).sort(), [
    "account_role",
    "active_listings",
    "created_at",
    "display_name",
    "email",
    "id",
    "last_sign_in_at",
    "role",
    "status",
    "verified",
  ]);
  assert.deepEqual(
    (await list("?q=SIDAMA")).map(({ email }) => email),
    ["sidama@example.com"],
  );
  // LIKE wildcards are matched literally.
  assert.deepEqual(
    (await list("?q=100%25")).map(({ email }) => email),
    ["guji_100%@example.com"],
  );
  assert.deepEqual((await list("?q=_")).length, 1);
  assert.deepEqual(
    (await list("?account_role=super_admin")).map(({ email }) => email),
    ["root@example.com"],
  );
  assert.equal((await admin(base, "/users?account_role=owner", root.headers)).status, 400);

  // Paged through a cursor.
  const first = await admin(base, "/users?limit=2", root.headers);
  const cursor = first.headers.get("x-next-cursor");
  assert.ok(cursor);
  assert.deepEqual(
    (await (await admin(base, `/users?limit=2&cursor=${cursor}`, root.headers)).json()).map(
      ({ email }) => email,
    ),
    ["root@example.com"],
  );

  // Regular accounts cannot see the list.
  const trader = await account(base, "trader@example.com");
  assert.equal((await admin(base, "/users", trader.headers)).status, 403);
});

test("admins grant and revoke admin access, and every change is audited", async (t) => {
  const base = await fixture(t, context);
  const root = await account(base, "root@example.com", "Root", "admin");
  const ops = await account(base, "ops@example.com", "Ops");
  const grant = (body) => admin(base, "/admins", root.headers, { method: "POST", body });

  assert.equal((await admin(base, "/overview", ops.headers)).status, 403);
  const granted = await grant({ email: " OPS@example.com " });
  assert.equal(granted.status, 200);
  assert.equal((await granted.json()).account_role, "super_admin");
  // The new admin's existing session gains access straight away.
  assert.equal((await admin(base, "/overview", ops.headers)).status, 200);
  assert.equal((await grant({ user_id: ops.id })).status, 200);

  assert.equal((await grant({ email: "nobody@example.com" })).status, 404);
  assert.equal((await grant({})).status, 400);
  assert.equal((await grant({ email: "a@b.c", user_id: ops.id })).status, 400);

  const revoked = await admin(base, `/admins/${ops.id}`, root.headers, { method: "DELETE" });
  assert.equal(revoked.status, 200);
  assert.equal((await revoked.json()).account_role, "user");
  assert.equal((await admin(base, "/overview", ops.headers)).status, 403);
  assert.equal(
    (await admin(base, `/admins/${ops.id}`, root.headers, { method: "DELETE" })).status,
    404,
  );

  assert.deepEqual(
    await query("SELECT actor_id, action, target_id FROM audit_events ORDER BY created_at"),
    [
      { actor_id: root.id, action: "staff_role.granted:super_admin", target_id: ops.id },
      { actor_id: root.id, action: "staff_role.revoked", target_id: ops.id },
    ],
  );
});

test("admins cannot lock the marketplace out of administration", async (t) => {
  const base = await fixture(t, context);
  const root = await account(base, "root@example.com", "Root", "admin");
  const ops = await account(base, "ops@example.com", "Ops", "admin");
  const error = async (response) => (await response.json()).error;

  assert.equal(
    await error(await admin(base, `/admins/${root.id}`, root.headers, { method: "DELETE" })),
    "cannot_remove_own_admin",
  );
  assert.equal(
    await error(
      await admin(base, `/traders/${root.id}`, root.headers, {
        method: "PATCH",
        body: { status: "Suspended" },
      }),
    ),
    "cannot_suspend_self",
  );

  // Suspending the other admin is fine while root stays active...
  const suspended = await admin(base, `/traders/${ops.id}`, root.headers, {
    method: "PATCH",
    body: { status: "Suspended" },
  });
  assert.equal(suspended.status, 200);
  // ...and a suspended account cannot be promoted.
  const grant = await admin(base, "/admins", root.headers, {
    method: "POST",
    body: { user_id: ops.id },
  });
  assert.equal(await error(grant), "account_not_active");

  // An actor that is not itself an account (the local demo admin) still cannot
  // remove or suspend the last active administrator.
  const demo = await fixture(t, context, { environment: "test", allowDemoAuth: true });
  const asDemoAdmin = { "x-demo-admin-id": "admin-demo" };
  assert.equal(
    await error(await admin(demo, `/admins/${root.id}`, asDemoAdmin, { method: "DELETE" })),
    "last_admin",
  );
  assert.equal(
    await error(
      await admin(demo, `/traders/${root.id}`, asDemoAdmin, {
        method: "PATCH",
        body: { status: "Suspended" },
      }),
    ),
    "last_admin",
  );
  assert.deepEqual(await query("SELECT account_role FROM accounts WHERE id = $1", [root.id]), [
    { account_role: "super_admin" },
  ]);
});
