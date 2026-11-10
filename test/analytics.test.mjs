import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { asAdmin, call, createTestDatabase, demoFixture, resetDatabase } from "./helpers.mjs";

let context;
before(async () => {
  context = await createTestDatabase();
});
beforeEach(() => resetDatabase(context.database));
after(() => context.database.close());

const query = (sql, values) => context.database.query(sql, values);

async function seed() {
  await query("INSERT INTO traders (id, display_name, role, status, verified, phone_verified) VALUES ('t1', 'T1', 'both', 'Active', true, true)");
  const rows = [
    ["a", "sell", "export-coffee", 5, "USD", "Active", "1 day"],
    ["b", "sell", "export-coffee", 7, "USD", "Active", "2 days"],
    ["c", "buy", "export-coffee", 4, "USD", "Pending Review", "3 days"],
    ["d", "sell", "export-coffee", 300, "ETB", "Active", "3 days"],
    ["e", "sell", "roasted-coffee", null, "USD", "Active", "40 days"],
  ];
  for (const [id, intent, product, price, currency, status, age] of rows) {
    await query(
      `INSERT INTO listings (id, owner_id, reference, intent, category, product, price_amount, price_currency, status, created_at)
       VALUES ($1, 't1', $1, $2, 'coffee', $3, $4, $5, $6, now() - $7::interval)`,
      [id, intent, product, price, currency, status, age],
    );
  }
  await query("UPDATE listings SET views = CASE id WHEN 'a' THEN 11 WHEN 'b' THEN 13 WHEN 'c' THEN 17 WHEN 'd' THEN 19 ELSE 23 END");
}

test("analytics totals and daily series cover the chosen period", async (t) => {
  const base = await demoFixture(t, context);
  await seed();
  const response = await call(base, "/admin/analytics?days=30", { headers: asAdmin });
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.equal(body.totals.new_listings, 4);
  assert.equal(body.totals.previous_new_listings, 1);
  assert.equal(body.totals.new_offers, 3);
  assert.equal(body.totals.previous_new_offers, 1);
  assert.equal(body.totals.new_requests, 1);
  assert.equal(body.totals.previous_new_requests, 0);
  assert.equal(body.totals.views, 60);
  assert.equal(body.totals.previous_views, 23);
  assert.equal(body.totals.pending_review, 1);
  assert.equal(body.daily.length, 31);
  assert.equal(body.daily.reduce((sum, day) => sum + day.listings, 0), 4);
  assert.deepEqual(body.listings_by_category, [{ category: "coffee", name: "Coffee", sell: 3, buy: 1 }]);
  assert.equal((await call(base, "/admin/analytics?days=12", { headers: asAdmin })).status, 400);
});

test("trends compare prices within one currency, week by week and per product", async (t) => {
  const base = await demoFixture(t, context);
  await seed();
  const body = await (
    await call(base, "/admin/trends?days=30&category=coffee&currency=USD", { headers: asAdmin })
  ).json();
  const totals = body.weekly.reduce(
    (sum, week) => ({ sell: sum.sell + week.sell_posts, buy: sum.buy + week.buy_posts }),
    { sell: 0, buy: 0 },
  );
  assert.deepEqual(totals, { sell: 3, buy: 1 });
  assert.equal(body.weekly.reduce((sum, week) => sum + week.views, 0), 60);
  const coffee = body.products.find(({ product }) => product === "export-coffee");
  assert.equal(coffee.name, "Export Coffee");
  assert.equal(coffee.posts, 4);
  assert.equal(coffee.views, 60);
  // The ETB listing is a post, but not part of the USD average.
  assert.equal(coffee.avg_price, 5.33);
  assert.deepEqual(
    body.currencies.map(({ currency }) => currency),
    ["USD", "ETB"],
  );
});

test("trends choose the most used currency unless explicitly overridden", async (t) => {
  const base = await demoFixture(t, context);
  await seed();
  await query("UPDATE listings SET price_currency = 'ETB' WHERE id IN ('a', 'b')");
  const automatic = await (await call(base, "/admin/trends?days=30", { headers: asAdmin })).json();
  assert.equal(automatic.currency, "ETB");
  assert.equal(automatic.products[0].avg_price, 104);
  const explicit = await (await call(base, "/admin/trends?days=30&currency=USD", { headers: asAdmin })).json();
  assert.equal(explicit.currency, "USD");
  assert.equal(explicit.products[0].avg_price, 4);
});

test("empty analytics return zero counts and views for every supported period", async (t) => {
  const base = await demoFixture(t, context);
  for (const days of [7, 30, 90, 365]) {
    const response = await call(base, `/admin/analytics?days=${days}`, { headers: asAdmin });
    assert.equal(response.status, 200);
    const { totals } = await response.json();
    for (const key of ["new_offers", "previous_new_offers", "new_requests", "previous_new_requests", "views", "previous_views"]) {
      assert.equal(totals[key], 0, key);
    }
    const trends = await (await call(base, `/admin/trends?days=${days}`, { headers: asAdmin })).json();
    assert.equal(trends.currency, "USD");
    assert.deepEqual(trends.products, []);
    assert.ok(trends.weekly.length > 0);
    assert.ok(trends.weekly.every((week) => week.views === 0 && week.sell_posts === 0 && week.buy_posts === 0));
  }
});

test("user analytics include weekly signups and approval history", async (t) => {
  const base = await demoFixture(t, context);
  await seed();
  await query(
    "INSERT INTO accounts (id, email, password_hash, account_role, created_at) VALUES ('t1', 'trader@example.com', 'x', 'user', now() - interval '2 days')",
  );
  await query(
    "INSERT INTO verification_requests (trader_id, document_summary, status, reviewed_at) VALUES ('t1', 'Approved test request', 'Approved', now() - interval '1 day')",
  );

  const response = await call(base, "/admin/analytics/users?days=30", { headers: asAdmin });
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.equal(body.totals.joined, 1);
  assert.equal(body.totals.verified, 1);
  assert.equal(body.weekly.reduce((sum, week) => sum + week.traders, 0), 1);
  assert.equal(body.weekly.reduce((sum, week) => sum + week.approved, 0), 1);
});

test("news analytics are available to console viewers and include selected-post daily readership", async (t) => {
  const base = await demoFixture(t, context);
  await seed();
  const postId = randomUUID();
  await query(
    `INSERT INTO news_posts (id, title, summary, body, category, status, created_by, published_at)
     VALUES ($1, 'Analytics test post', 'A test summary.', 'A test body.', 'Market', 'Published', 't1', now() - interval '3 days')`,
    [postId],
  );
  await query(
    `INSERT INTO news_post_events (post_id, kind, visitor, read_seconds, created_at)
     VALUES ($1, 'view', 'reader-aaaa', 35, now() - interval '2 days'),
       ($1, 'view', 'reader-bbbb', 50, now() - interval '1 day'),
       ($1, 'share', 'reader-bbbb', null, now() - interval '1 day')`,
    [postId],
  );

  const response = await call(base, `/admin/analytics/news?days=30&post_id=${postId}`, { headers: asAdmin });
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.deepEqual(body.totals, { views: 2, readers: 2, shares: 1 });
  assert.equal(body.posts.length, 1);
  assert.equal(body.posts[0].avg_read_seconds, 43);
  assert.equal(body.daily.reduce((sum, day) => sum + day.views, 0), 2);
  assert.equal(
    (await call(base, `/admin/analytics/news?days=30&post_id=${postId}`)).status,
    403,
  );
});
