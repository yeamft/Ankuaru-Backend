import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { Authentication } from "../dist/modules/auth/index.js";
import { importLegacyData, importLegacyNews } from "../dist/modules/legacy/import.js";
import { parseNews, parseOffers, parseUsers } from "../dist/modules/legacy/source.js";
import { createDatabase } from "../dist/infrastructure/database/index.js";
import { createTestDatabase, fixture, resetDatabase } from "./helpers.mjs";

let context;
let pool;
let database;
before(async () => {
  context = await createTestDatabase();
  ({ pool } = context);
  database = createDatabase(pool);
});
beforeEach(() => resetDatabase(context.database));
after(() => context.database.close());

const since = "2026-10-01T00:00:00+03:00";
const sourceUser = {
  id: "legacy-user-42",
  chat_id: "telegram-42",
  name: "Original trader",
  business_name: "Original Trading",
  city: "Addis Ababa",
  contact_information: "+251912345678",
  is_active: true,
  createdAt: "2024-01-02T03:04:05.000Z",
  phone: "+251912345678",
};
const sourceOffer = {
  id: "offer-77",
  chat_id: "telegram-42",
  product_name: "Export Coffee",
  offer_type: "sell",
  createdAt: "2026-10-05T10:00:00.000Z",
  updatedAt: "2026-10-06T10:00:00.000Z",
  status: true,
  hidden_by_admin: false,
  quantity: 20,
  measurement: "Quintal",
  price: "500",
  price_currency: "ETB",
  description: "Source description",
  region: "Sidama",
  grade: "2",
  process: "Washed",
  transaction: "Horizontal",
  image_filelink: null,
  season: null,
  type: null,
  class: null,
  size: null,
  brand: null,
  route: "CoffeeandMainCommodity",
  categoryId: "coffee",
};
const sourceData = (offers = [sourceOffer], users = [sourceUser]) => ({ users, offers, since });

test("legacy parsing normalizes source IDs and drops credential and privilege fields", () => {
  const [user] = parseUsers([{
    ...sourceUser,
    id: 42,
    chat_id: 84,
    contact_information: "0912-345-678",
    password: "must-not-import",
    role: "super_admin",
  }]);
  assert.equal(user.id, "42");
  assert.equal(user.chat_id, "84");
  assert.equal(user.phone, "+251912345678");
  assert.equal("password" in user, false);
  assert.equal("role" in user, false);

  const [offer] = parseOffers([{
    ...sourceOffer,
    id: 77,
    createdAt: "2026-09-30T20:59:59.000Z",
  }, sourceOffer], sourceOffer.route, "coffee", since);
  assert.equal(offer.id, "offer-77");
  assert.equal(offer.categoryId, "coffee");
});

test("import is repeatable, preserves local listing activity, and never resurrects deletions", async () => {
  const first = await importLegacyData(database, sourceData());
  assert.deepEqual(first, { usersInserted: 1, listingsInserted: 1, usersSeen: 1, offersSeen: 1 });

  const [listing] = (await pool.query("SELECT * FROM listings WHERE source = $1", ["legacy-ankuaru"])).rows;
  assert.equal(listing.owner_id, sourceUser.id);
  assert.equal(listing.intent, "sell");
  assert.equal(listing.category, "coffee");
  assert.equal(listing.product, "Export Coffee");
  assert.equal(listing.status, "Active");
  assert.equal(listing.quantity, "20 Quintal");
  assert.equal(Number(listing.price_amount), 500);
  assert.equal(listing.price_currency, "ETB");
  assert.equal(new Date(listing.created_at).toISOString(), sourceOffer.createdAt);

  await pool.query(
    "UPDATE listings SET views = 13, status = 'Closed', description = 'Edited locally' WHERE id = $1",
    [listing.id],
  );
  const changedSource = {
    ...sourceOffer,
    product_name: "Changed source product",
    description: "Changed source description",
  };
  const repeated = await importLegacyData(database, sourceData([changedSource]));
  assert.deepEqual(repeated, { usersInserted: 0, listingsInserted: 0, usersSeen: 1, offersSeen: 1 });
  const [unchanged] = (await pool.query("SELECT * FROM listings WHERE id = $1", [listing.id])).rows;
  assert.equal(unchanged.views, 13);
  assert.equal(unchanged.status, "Closed");
  assert.equal(unchanged.product, "Export Coffee");
  assert.equal(unchanged.description, "Edited locally");

  await pool.query("DELETE FROM listings WHERE id = $1", [listing.id]);
  await importLegacyData(database, sourceData());
  assert.equal((await pool.query("SELECT id FROM listings WHERE id = $1", [listing.id])).rows.length, 0);
  const [tombstone] = (await pool.query(
    "SELECT listing_id FROM legacy_listing_imports WHERE source_key = $1",
    [`${sourceOffer.route}:${sourceOffer.id}`],
  )).rows;
  assert.equal(tombstone.listing_id, null);
});

test("active legacy listings are public while their unclaimed owners remain unverified", async (t) => {
  await importLegacyData(database, sourceData());
  const base = await fixture(t, context);

  const response = await fetch(`${base}/api/listings?category=coffee`);
  assert.equal(response.status, 200);
  const listings = await response.json();
  const listing = listings.find(({ source_reference }) => source_reference === "CoffeeandMainCommodity:offer-77");
  assert.ok(listing);
  assert.equal(listing.owner_id, sourceUser.id);
  assert.equal(listing.owner_verified, false);

  const detail = await fetch(`${base}/api/listings/${encodeURIComponent(listing.id)}`);
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).id, listing.id);
});

const sourceNews = {
  id: "news-88",
  title: "Coffee export prices hold after the October auctions",
  titleAm: null,
  url: "https://telegra.ph/coffee-october-auctions",
  viewCount: 12,
  createdAt: "2026-10-05T09:00:00.000Z",
  updatedAt: "2026-10-05T09:00:00.000Z",
  summary: "Washed lots from Yirgacheffe held their levels through the first October sessions.",
  body: "Exporters reported steady demand for washed Grade 1 coffee after the October auctions opened.",
  imageUrl: "https://example.com/coffee.jpg",
  category: "Export",
  kind: "News",
};

test("news parsing keeps posts from the offer cutoff and drops earlier rows", () => {
  const [item] = parseNews({
    entries: [{
      id: 88,
      title: "Coffee export prices hold after the October auctions",
      url: "https://telegra.ph/coffee-october-auctions",
      view_count: 12,
      createdAt: "2026-09-30T20:59:59.000Z",
    }, {
      id: 89,
      title: "Coffee export prices hold after the October auctions",
      url: "https://telegra.ph/coffee-october-auctions",
      view_count: 12,
      createdAt: "2026-10-01T00:00:00+03:00",
    }],
  }, since);
  assert.equal(item.id, "89");
  assert.equal(item.category, "Export");
  assert.equal(item.kind, "News");
  assert.match(item.body, /Original article/);
  assert.equal(parseNews({
    entries: [{
      id: 1,
      title: "The enterprise invites eligible bidders for the supply of Construction Materials",
      url: "https://telegra.ph/tender-1",
      createdAt: "2026-10-02T00:00:00.000Z",
    }],
  }, since)[0].kind, "Tender");
  assert.equal(parseNews({
    entries: [{
      id: 2,
      title: "4th Intra-African Trade Fair (IATF2025)",
      url: "https://telegra.ph/event-1",
      createdAt: "2026-10-02T00:00:00.000Z",
    }],
  }, since)[0].kind, "Event");
});

test("news import is repeatable and never resurrects deletions", async () => {
  const payload = { news: [sourceNews], since };
  const first = await importLegacyNews(database, payload);
  assert.deepEqual(first, { newsInserted: 1, newsUpdated: 0, newsSeen: 1 });
  const [post] = (await pool.query("SELECT * FROM news_posts WHERE title = $1", [sourceNews.title])).rows;
  assert.equal(post.status, "Published");
  assert.equal(post.category, "Export");
  assert.equal(post.kind, "News");
  assert.equal(post.source, "ANKUARU");
  assert.equal(new Date(post.published_at).toISOString(), sourceNews.createdAt);
  assert.equal(post.created_by, "legacy-news");

  await pool.query("UPDATE news_posts SET summary = 'Edited locally', body = 'Edited locally body' WHERE id = $1", [post.id]);
  const repeated = await importLegacyNews(database, {
    news: [{ ...sourceNews, title: "Changed source title", body: "Changed source body that is long enough" }],
    since,
  });
  assert.deepEqual(repeated, { newsInserted: 0, newsUpdated: 0, newsSeen: 1 });
  const [unchanged] = (await pool.query("SELECT summary, body FROM news_posts WHERE id = $1", [post.id])).rows;
  assert.equal(unchanged.summary, "Edited locally");
  assert.equal(unchanged.body, "Edited locally body");

  await pool.query("DELETE FROM news_posts WHERE id = $1", [post.id]);
  await importLegacyNews(database, payload);
  assert.equal((await pool.query("SELECT id FROM news_posts WHERE id = $1", [post.id])).rows.length, 0);
  const [tombstone] = (await pool.query(
    "SELECT news_post_id FROM legacy_news_imports WHERE source_id = $1",
    [sourceNews.id],
  )).rows;
  assert.equal(tombstone.news_post_id, null);
});

test("imported news is listed on the public news feed", async (t) => {
  await importLegacyNews(database, { news: [sourceNews], since });
  const base = await fixture(t, context);
  const response = await fetch(`${base}/api/content/news`);
  assert.equal(response.status, 200);
  const posts = await response.json();
  const post = posts.find(({ title }) => title === sourceNews.title);
  assert.ok(post);
  assert.equal(post.body, sourceNews.body);
  assert.equal(post.category, "Export");
  assert.equal(post.imageUrl, sourceNews.imageUrl);
});

test("verified registration claims the imported profile without changing its identity or granting privileges", async (t) => {
  await importLegacyData(database, sourceData());
  const base = await fixture(t, context, {
    auth: new Authentication(context.store, 86400, { environment: "test" }),
  });
  const otpResponse = await fetch(`${base}/api/auth/phone-otp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phone: sourceUser.phone }),
  });
  assert.equal(otpResponse.status, 200);
  const { development_code: phoneOtp } = await otpResponse.json();

  const response = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "legacy-claim@example.com",
      password: "a long enough test password",
      display_name: "Untrusted replacement name",
      phone: sourceUser.phone,
      city: "Untrusted replacement city",
      role: "buyer",
      phone_otp: phoneOtp,
    }),
  });
  assert.equal(response.status, 201, await response.clone().text());
  const { user, access_token: accessToken } = await response.json();
  assert.equal(user.id, sourceUser.id);
  assert.equal(user.display_name, sourceUser.name);
  assert.equal(user.business_name, sourceUser.business_name);
  assert.equal(user.city, sourceUser.city);
  assert.equal(user.phone_verified, true);
  assert.equal(user.verified, false);
  assert.equal(user.account_role, "user");
  assert.equal("password_hash" in user, false);

  const [claimed] = (await pool.query(
    `SELECT claimed_at, claim_phone, claim_blocked
     FROM legacy_users WHERE source_id = $1`,
    [sourceUser.id],
  )).rows;
  assert.ok(claimed.claimed_at);
  assert.equal(claimed.claim_phone, sourceUser.phone);
  assert.equal(claimed.claim_blocked, false);
  const [account] = (await pool.query("SELECT account_role FROM accounts WHERE id = $1", [sourceUser.id])).rows;
  assert.equal(account.account_role, "user");
  assert.equal(typeof accessToken, "string");
});
