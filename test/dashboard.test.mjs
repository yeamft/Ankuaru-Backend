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

const query = (statement, values) => context.database.query(statement, values);

async function person(name) {
  const id = `usr_${randomUUID()}`;
  const token = randomBytes(32).toString("base64url");
  await query(
    "INSERT INTO traders (id, display_name, role, status, verified, phone_verified) VALUES ($1, $2, 'both', 'Active', true, true)",
    [id, name],
  );
  await query(
    "INSERT INTO accounts (id, email, password_hash, account_role) VALUES ($1, $2, 'x', 'user')",
    [id, `${id}@example.com`],
  );
  await query(
    "INSERT INTO account_sessions (token_hash, account_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
    [digestToken(token), id],
  );
  return { id, headers: { authorization: `Bearer ${token}` } };
}

test("trader dashboard returns session-scoped period totals and daily series", async (t) => {
  const base = await fixture(t, context);
  const owner = await person("Dashboard owner");
  const other = await person("Other trader");
  await query(
    `INSERT INTO listings (id, owner_id, reference, intent, category, product, status, created_at, views)
     VALUES ('own-current', $1, 'OWN-CURRENT', 'sell', 'coffee', 'coffee', 'Active', now() - interval '1 day', 12),
       ('own-previous', $1, 'OWN-PREVIOUS', 'buy', 'coffee', 'coffee', 'Closed', now() - interval '10 days', 4),
       ('other-current', $2, 'OTHER-CURRENT', 'sell', 'coffee', 'coffee', 'Active', now() - interval '1 day', 2)`,
    [owner.id, other.id],
  );
  await query(
    `INSERT INTO inquiries (listing_id, buyer_id, seller_id, message, status, created_at)
     VALUES ('own-current', $2, $1, 'Current received', 'New', now() - interval '1 day'),
       ('own-current', $1, $2, 'Current sent', 'Responded', now() - interval '2 days'),
       ('own-previous', $2, $1, 'Previous received', 'Closed', now() - interval '10 days'),
       ('own-previous', $1, $2, 'Previous sent', 'New', now() - interval '11 days')`,
    [owner.id, other.id],
  );

  const response = await call(base, "/my-dashboard?days=7", { headers: owner.headers });
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.deepEqual(body.totals, {
    received: 1,
    previous_received: 1,
    sent: 1,
    previous_sent: 1,
    posted: 1,
    previous_posted: 1,
    active_listings: 1,
    new_received: 1,
  });
  assert.equal(body.daily.length, 7);
  assert.equal(body.daily.reduce((sum, day) => sum + day.received, 0), 1);
  assert.equal(body.daily.reduce((sum, day) => sum + day.sent, 0), 1);
  assert.equal(body.daily.reduce((sum, day) => sum + day.posted, 0), 1);

  assert.equal((await call(base, "/my-dashboard?days=14", { headers: owner.headers })).status, 400);
  assert.equal((await call(base, "/my-dashboard?days=7")).status, 401);

  const listingsResponse = await call(base, "/my-listings?limit=100", { headers: owner.headers });
  assert.equal(listingsResponse.status, 200, await listingsResponse.clone().text());
  const listings = await listingsResponse.json();
  const own = listings.find((listing) => listing.id === "own-current");
  assert.equal(own.views, 12);
  assert.equal(own.inquiries_count, 2);
  assert.ok(listings.every((listing) => listing.owner_id === owner.id));
});
