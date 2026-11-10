import assert from "node:assert/strict";
import { before, beforeEach, after, test } from "node:test";
import { digestToken } from "../dist/modules/auth/index.js";
import { createTestDatabase, fixture as appFixture, resetDatabase } from "./helpers.mjs";

let context;
let pool;
let store;
before(async () => {
  context = await createTestDatabase();
  ({ pool, store } = context);
});
beforeEach(() => resetDatabase(context.database));
after(() => context.database.close());

const fixture = (t, options) => appFixture(t, context, options);

const registration = {
  email: "trader@example.com",
  password: "a long test password",
  display_name: "Test trader",
  role: "seller",
};
function request(base, path, body, token, method = "POST") {
  return fetch(`${base}/api${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function register(base, overrides = {}) {
  const response = await request(base, "/auth/register", { ...registration, ...overrides });
  assert.equal(response.status, 201, await response.clone().text());
  return response.json();
}

test("registration persists a trader, salted password, and hashed session atomically", async (t) => {
  const base = await fixture(t);
  const response = await request(base, "/auth/register", {
    ...registration,
    email: "  Trader@Example.COM  ",
  });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const account = await response.json();
  assert.equal(account.user.email, "trader@example.com");
  assert.equal(account.user.account_role, "user");
  assert.equal(account.user.verified, false);
  assert.match(account.access_token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(account.token_type, "Bearer");
  assert.equal(account.user.password_hash, undefined);
  const credentials = await store.credentials(account.user.email);
  assert.match(credentials.password_hash, /^scrypt-v1\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
  assert.ok(!credentials.password_hash.includes(registration.password));
  const sessions = await pool.query("SELECT * FROM account_sessions");
  assert.equal(sessions.rows[0].token_hash, digestToken(account.access_token));
  assert.notEqual(sessions.rows[0].token_hash, account.access_token);
  const me = await request(base, "/auth/me", undefined, account.access_token, "GET");
  assert.deepEqual((await me.json()).user, account.user);

  const duplicate = await request(base, "/auth/register", {
    ...registration,
    email: "TRADER@example.com",
  });
  assert.equal(duplicate.status, 409);
  assert.equal((await pool.query("SELECT * FROM traders")).rows.length, 1);
  assert.equal((await pool.query("SELECT * FROM account_sessions")).rows.length, 1);
});

test("login rejects wrong/unknown/suspended credentials with the same error and logout revokes one session", async (t) => {
  const base = await fixture(t);
  const account = await register(base);
  let expectedError;
  for (const body of [
    { email: registration.email, password: "incorrect password" },
    { email: "unknown@example.com", password: registration.password },
  ]) {
    const response = await request(base, "/auth/login", body);
    assert.equal(response.status, 401);
    const error = await response.json();
    if (expectedError) assert.deepEqual(error, expectedError);
    expectedError = error;
  }
  const login = await request(base, "/auth/login", {
    email: "TRADER@example.com",
    password: registration.password,
  });
  assert.equal(login.status, 200);
  const session = await login.json();
  assert.equal(session.user.password_hash, undefined);
  assert.notEqual(session.access_token, account.access_token);
  assert.equal((await request(base, "/auth/logout", undefined, session.access_token)).status, 204);
  assert.equal(
    (await request(base, "/auth/me", undefined, session.access_token, "GET")).status,
    401,
  );
  assert.equal(
    (await request(base, "/auth/me", undefined, account.access_token, "GET")).status,
    200,
  );
  await pool.query("UPDATE traders SET status = 'Suspended' WHERE id = $1", [account.user.id]);
  const suspended = await request(base, "/auth/login", {
    email: registration.email,
    password: registration.password,
  });
  assert.equal(suspended.status, 401);
  assert.deepEqual(await suspended.json(), expectedError);
  assert.equal(
    (await request(base, "/auth/me", undefined, account.access_token, "GET")).status,
    401,
  );
});

test("production marketplace and admin routes use the verified account and current role", async (t) => {
  const base = await fixture(t);
  const account = await register(base);
  const listing = await request(
    base,
    "/listings",
    { intent: "sell", category: "coffee", product: "Coffee" },
    account.access_token,
  );
  assert.equal(listing.status, 201);
  assert.equal((await listing.json()).owner_id, account.user.id);
  const myListings = await fetch(`${base}/api/my-listings?user_id=someone-else`, {
    headers: {
      authorization: `Bearer ${account.access_token}`,
      "x-user-id": "spoofed",
      "x-demo-user-id": "seller-demo",
    },
  });
  assert.equal(myListings.status, 200);
  assert.deepEqual(
    (await myListings.json()).map((item) => item.owner_id),
    [account.user.id],
  );
  assert.equal(
    (await request(base, "/admin/overview", undefined, account.access_token, "GET")).status,
    403,
  );
  await pool.query("UPDATE accounts SET account_role = 'super_admin' WHERE id = $1", [account.user.id]);
  const overview = await request(base, "/admin/overview", undefined, account.access_token, "GET");
  assert.equal(overview.status, 200);
  assert.equal((await overview.json()).traders, 1);
  await pool.query("UPDATE accounts SET account_role = 'user' WHERE id = $1", [account.user.id]);
  assert.equal(
    (await request(base, "/admin/overview", undefined, account.access_token, "GET")).status,
    403,
  );
});

test("profile updates are restricted to the authenticated trader and reject privilege fields", async (t) => {
  const base = await fixture(t);
  const first = await register(base);
  const second = await register(base, { email: "second@example.com" });
  const update = await request(
    base,
    "/auth/me",
    { display_name: "  Updated name  ", role: "buyer" },
    first.access_token,
    "PATCH",
  );
  assert.equal(update.status, 200);
  assert.equal((await update.json()).user.display_name, "Updated name");
  const unchanged = await request(base, "/auth/me", undefined, second.access_token, "GET");
  assert.equal((await unchanged.json()).user.display_name, registration.display_name);
  for (const body of [
    { account_role: "super_admin" },
    { verified: true },
    { id: second.user.id },
    { status: "Active" },
    { email: "new@example.com" },
    {},
    { role: "admin" },
  ]) {
    assert.equal((await request(base, "/auth/me", body, first.access_token, "PATCH")).status, 400);
  }
});

test("password change verifies the old password and revokes all sessions", async (t) => {
  const base = await fixture(t);
  const account = await register(base);
  const login = await request(base, "/auth/login", {
    email: registration.email,
    password: registration.password,
  });
  assert.equal(login.status, 200);
  const second = await login.json();
  const replacement = "a different long password";
  assert.equal(
    (
      await request(
        base,
        "/auth/password",
        { current_password: "wrong", new_password: replacement },
        account.access_token,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await request(
        base,
        "/auth/password",
        { current_password: registration.password, new_password: replacement },
        account.access_token,
      )
    ).status,
    204,
  );
  for (const token of [account.access_token, second.access_token]) {
    assert.equal((await request(base, "/auth/me", undefined, token, "GET")).status, 401);
  }
  assert.equal(
    (
      await request(base, "/auth/login", {
        email: registration.email,
        password: registration.password,
      })
    ).status,
    401,
  );
  assert.equal(
    (await request(base, "/auth/login", { email: registration.email, password: replacement }))
      .status,
    200,
  );
});

test("expired, malformed, and forged sessions cannot fall back to demo identity", async (t) => {
  const base = await fixture(t, { environment: "development", allowDemoAuth: true });
  const account = await register(base);
  await pool.query("UPDATE account_sessions SET expires_at = now() - interval '1 second'");
  for (const token of [account.access_token, "x".repeat(43), "buyer-demo", "bad token"]) {
    const response = await fetch(`${base}/api/my-listings`, {
      headers: { authorization: `Bearer ${token}`, "x-demo-user-id": "buyer-demo" },
    });
    assert.equal(response.status, 401);
  }
  await store.cleanup();
  assert.equal((await pool.query("SELECT * FROM account_sessions")).rows.length, 0);
});

test("validation prevents privileged registration, weak passwords, and malformed profiles", async (t) => {
  const base = await fixture(t);
  for (const overrides of [
    { email: "bad" },
    { password: "short" },
    { password: "x".repeat(1025) },
    { display_name: " " },
    { role: "admin" },
    { account_role: "super_admin" },
    { verified: true },
  ]) {
    assert.equal(
      (await request(base, "/auth/register", { ...registration, ...overrides })).status,
      400,
    );
  }
  assert.equal((await pool.query("SELECT * FROM accounts")).rows.length, 0);
});

test("rate limits persist across gateway instances and expire", async (t) => {
  const first = await fixture(t);
  const second = await fixture(t);
  for (let i = 0; i < 30; i++) {
    assert.equal((await request(first, "/auth/login", { email: "bad" })).status, 400);
  }
  const blocked = await request(second, "/auth/register", registration);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get("retry-after"), "900");
  await pool.query("UPDATE auth_rate_limits SET expires_at = now() - interval '1 second'");
  assert.equal((await request(second, "/auth/login", { email: "bad" })).status, 400);
});

test("login cannot create a session with a stale password hash", async (t) => {
  const base = await fixture(t);
  const account = await register(base);
  const credentials = await store.credentials(account.user.email);
  await pool.query("UPDATE accounts SET password_hash = 'changed' WHERE id = $1", [
    account.user.id,
  ]);
  assert.equal(
    await store.createSession(account.user.id, credentials.password_hash, {
      tokenHash: "stale",
      expiresAt: new Date(Date.now() + 60000),
    }),
    false,
  );
  assert.equal(
    (await pool.query("SELECT * FROM account_sessions WHERE token_hash = 'stale'")).rows.length,
    0,
  );
});

test("configured account storage disables implicit demo access", async (t) => {
  const base = await fixture(t, { environment: "development" });
  assert.equal((await fetch(`${base}/api/my-listings`)).status, 401);
  assert.equal(
    (await fetch(`${base}/api/admin/overview`, { headers: { "x-demo-admin-id": "admin-demo" } }))
      .status,
    403,
  );
});

test("suspension revokes sessions permanently and restoration requires a new login", async (t) => {
  const base = await fixture(t);
  const account = await register(base);
  await pool.query("UPDATE traders SET status = 'Suspended' WHERE id = $1", [account.user.id]);
  assert.equal(
    (await pool.query("SELECT * FROM account_sessions WHERE account_id = $1", [account.user.id]))
      .rows.length,
    0,
  );
  await pool.query("UPDATE traders SET status = 'Active' WHERE id = $1", [account.user.id]);
  assert.equal(
    (await request(base, "/auth/me", undefined, account.access_token, "GET")).status,
    401,
  );
  assert.equal(
    (
      await request(base, "/auth/login", {
        email: registration.email,
        password: registration.password,
      })
    ).status,
    200,
  );
});

test("rolling back suspension also rolls back session revocation", async (t) => {
  const base = await fixture(t);
  const account = await register(base);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE traders SET status = 'Suspended' WHERE id = $1", [account.user.id]);
    assert.equal(
      (
        await client.query("SELECT * FROM account_sessions WHERE account_id = $1", [
          account.user.id,
        ])
      ).rows.length,
      0,
    );
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
  assert.equal(
    (await request(base, "/auth/me", undefined, account.access_token, "GET")).status,
    200,
  );
});

test("rate limits are keyed by a hash, so client addresses are not stored", async (t) => {
  const base = await fixture(t);
  assert.equal((await request(base, "/auth/login", { email: "bad" })).status, 400);
  const keys = (await pool.query("SELECT key FROM auth_rate_limits")).rows.map((row) => row.key);
  assert.equal(keys.length, 1);
  assert.match(keys[0], /^[a-f0-9]{64}$/);
  assert.ok(!keys[0].includes("127.0.0.1"));
});
