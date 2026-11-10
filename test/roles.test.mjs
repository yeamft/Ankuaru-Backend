import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { digestToken } from "../dist/modules/auth/index.js";
import { call, createTestDatabase, fixture, resetDatabase } from "./helpers.mjs";

let context;
before(async () => {
  context = await createTestDatabase();
});
beforeEach(() => resetDatabase(context.database));
after(() => context.database.close());

const query = async (sql, values) => (await context.database.query(sql, values)).rows;

/** An active account with the given staff role, and Bearer headers for a live session. */
async function staff(accountRole, traderRole = "both") {
  const id = `usr_${randomUUID()}`;
  const token = randomBytes(32).toString("base64url");
  await query(
    "INSERT INTO traders (id, display_name, role, status) VALUES ($1, $2, $3, 'Active')",
    [id, accountRole, traderRole],
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

const admin = (base, path, headers, init = {}) => call(base, `/admin${path}`, { headers, ...init });

test("existing admins become super admins and the role list is enforced", async () => {
  await assert.rejects(
    query(
      "INSERT INTO traders (id, display_name) VALUES ('t1', 'T'); INSERT INTO accounts (id, email, password_hash, account_role) VALUES ('t1', 't1@example.com', 'x', 'admin')",
    ),
  );
});

test("each staff role reaches only its own areas", async (t) => {
  const base = await fixture(t, context);
  const roles = {
    user: await staff("user"),
    moderator: await staff("moderator"),
    content_manager: await staff("content_manager"),
    platform_admin: await staff("platform_admin"),
    super_admin: await staff("super_admin"),
  };
  const routes = {
    "/overview": ["moderator", "content_manager", "platform_admin", "super_admin"],
    "/listings": ["moderator", "platform_admin", "super_admin"],
    "/verifications": ["moderator", "platform_admin", "super_admin"],
    "/users": ["platform_admin", "super_admin"],
    "/settings": ["platform_admin", "super_admin"],
    "/roles": ["super_admin"],
  };
  for (const [path, allowed] of Object.entries(routes)) {
    for (const [role, { headers }] of Object.entries(roles)) {
      const response = await admin(base, path, headers);
      const expected = allowed.includes(role) ? 200 : 403;
      assert.equal(response.status, expected, `${role} GET ${path}`);
      if (expected === 403) {
        assert.equal(
          (await response.json()).error,
          role === "user" ? "admin_required" : "permission_denied",
        );
      }
    }
  }
  const posts = await call(base, "/content/admin/posts", { headers: roles.content_manager.headers });
  assert.equal(posts.status, 200);
  const denied = await call(base, "/content/admin/posts", { headers: roles.moderator.headers });
  assert.equal(denied.status, 403);

  const access = await (await admin(base, "/access", roles.moderator.headers)).json();
  assert.deepEqual(access, {
    id: roles.moderator.id,
    role: "moderator",
    permissions: ["console.view", "moderation.manage", "kyc.review"],
  });
});

test("super admins change role permissions, which apply at once and never reach reserved ones", async (t) => {
  const base = await fixture(t, context);
  const root = await staff("super_admin");
  const moderator = await staff("moderator");

  const listed = await (await admin(base, "/roles", root.headers)).json();
  assert.deepEqual(
    listed.roles.map(({ role, member_count, configurable }) => [role, member_count, configurable]),
    [
      ["moderator", 1, true],
      ["content_manager", 0, true],
      ["platform_admin", 0, true],
      ["super_admin", 1, false],
    ],
  );
  assert.ok(listed.permissions.find(({ key }) => key === "staff.manage").reserved);

  assert.equal((await admin(base, "/users", moderator.headers)).status, 403);
  const updated = await admin(base, "/roles/moderator", root.headers, {
    method: "PUT",
    body: { permissions: ["console.view", "users.manage"] },
  });
  assert.equal(updated.status, 200);
  assert.deepEqual((await updated.json()).permissions, ["console.view", "users.manage"]);
  assert.equal((await admin(base, "/users", moderator.headers)).status, 200);
  assert.equal((await admin(base, "/listings", moderator.headers)).status, 403);

  for (const [role, permissions, status] of [
    ["moderator", ["staff.manage"], 400],
    ["moderator", ["not.real"], 400],
    ["super_admin", [], 400],
    ["owner", [], 404],
  ]) {
    const response = await admin(base, `/roles/${role}`, root.headers, {
      method: "PUT",
      body: { permissions },
    });
    assert.equal(response.status, status, `${role} ${permissions}`);
  }
  assert.equal(
    (
      await admin(base, "/roles/moderator", moderator.headers, {
        method: "PUT",
        body: { permissions: [] },
      })
    ).status,
    403,
  );
  assert.deepEqual(await query("SELECT action, target_id FROM audit_events"), [
    { action: "role.permissions_updated", target_id: "moderator" },
  ]);
});

test("only super admins assign staff roles, and one active super admin always remains", async (t) => {
  const base = await fixture(t, context);
  const root = await staff("super_admin");
  const ops = await staff("platform_admin");
  const trader = await staff("user");

  const grant = (headers, body) => admin(base, "/admins", headers, { method: "POST", body });
  assert.equal((await grant(ops.headers, { user_id: trader.id, role: "moderator" })).status, 403);
  const granted = await grant(root.headers, { user_id: trader.id, role: "content_manager" });
  assert.equal(granted.status, 200);
  assert.equal((await granted.json()).account_role, "content_manager");
  assert.equal((await grant(root.headers, { user_id: trader.id, role: "owner" })).status, 400);
  assert.equal((await grant(root.headers, { user_id: root.id, role: "moderator" })).status, 400);

  const revoked = await admin(base, `/admins/${trader.id}`, root.headers, { method: "DELETE" });
  assert.equal((await revoked.json()).account_role, "user");

  // A platform admin manages traders but not other staff.
  const suspend = (headers, id) =>
    admin(base, `/traders/${id}`, headers, { method: "PATCH", body: { status: "Suspended" } });
  assert.equal((await suspend(ops.headers, root.id)).status, 403);
  assert.equal((await suspend(ops.headers, trader.id)).status, 200);

  const second = await staff("super_admin");
  assert.equal((await grant(second.headers, { user_id: root.id, role: "moderator" })).status, 200);
  const last = await grant(root.headers, { user_id: second.id, role: "moderator" });
  assert.equal(last.status, 403);
  assert.equal(
    (await admin(base, `/admins/${second.id}`, second.headers, { method: "DELETE" })).status,
    400,
  );
  assert.equal(
    (await suspend(second.headers, second.id)).status,
    400,
  );
});

test("platform admins cannot switch maintenance mode, super admins can", async (t) => {
  const base = await fixture(t, context);
  const root = await staff("super_admin");
  const ops = await staff("platform_admin");
  const save = (headers, value) =>
    admin(base, "/settings/marketplace", headers, { method: "PATCH", body: { value } });
  const current = {
    maintenanceMode: false,
    autoPublishVerified: false,
    telegramImportsRequireReview: true,
  };
  assert.equal((await save(ops.headers, { ...current, autoPublishVerified: true })).status, 200);
  const blocked = await save(ops.headers, { ...current, maintenanceMode: true });
  assert.equal(blocked.status, 403);
  assert.match((await blocked.json()).message, /maintenanceMode/);
  assert.equal((await save(root.headers, { ...current, maintenanceMode: true })).status, 200);
});
