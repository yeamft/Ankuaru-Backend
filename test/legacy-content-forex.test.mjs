import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createDatabase } from "../dist/infrastructure/database/index.js";
import { fetchLegacyContent, parseLegacyContentBody } from "../dist/modules/legacy/content-source.js";
import { fetchLegacyResources } from "../dist/modules/legacy/resource-source.js";
import { runLegacySync } from "../dist/modules/legacy/sync.js";
import { latestBankForex, parseBankForex, syncBankForex } from "../dist/modules/catalog/services/forex.service.js";
import { createTestDatabase, fixture, resetDatabase } from "./helpers.mjs";

let context;
let database;
before(async () => {
  context = await createTestDatabase();
  database = createDatabase(context.pool);
});
beforeEach(async () => {
  await resetDatabase(context.database);
  await context.database.exec("TRUNCATE bank_forex_snapshots");
});
after(() => context.database.close());

const base = "https://legacy.example/api";
const since = "2026-10-01T00:00:00Z";
const post = (id, type = "tender") => ({
  id, type, title: "Procurement conference announcement", source: "Trade Association",
  body: JSON.stringify([{ type: "paragraph", text: "<p>Details &amp; registration</p>" },
    { type: "image", url: "https://example.com/post.jpg" }]),
  createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-02T00:00:00Z",
});
const page = (posts, currentPage = 1, totalPages = 1) => ({ posts, pagination: { currentPage, totalPages } });
const snapshot = (id = 1, createdAt = "2026-09-25T09:17:21Z") => ({
  id, createdAt, updatedAt: createdAt, source: null,
  body: { "Awash Bank": { buyPrice: 160.81, sellPrice: 164.02 }, Average: { buyPrice: 160, sellPrice: 164 } },
});

test("typed content follows all pages, keeps explicit type and namespaces IDs", async () => {
  const requested = [];
  const content = await fetchLegacyContent(base, "event", undefined, async (url, init) => {
    assert.equal(url.pathname, "/api/Admin/fetchAllPost");
    assert.equal(init.method, "POST");
    const body = JSON.parse(init.body);
    assert.equal(body.type, "event");
    requested.push(body.page);
    return Response.json(page([post(body.page, "event")], body.page, 2));
  }, new Set(["post:1"]));
  assert.deepEqual(requested, [1, 2]);
  assert.equal(content.news.length, 1);
  assert.equal(content.news[0].id, "post:2");
  assert.equal(content.news[0].kind, "Event"); // Title contains procurement; explicit type wins.
  assert.equal(content.news[0].body, "Details & registration");
  assert.equal(content.news[0].imageUrl, "https://example.com/post.jpg");
  assert.equal(content.news[0].source, "Trade Association");
});

test("typed content rejects stalled pagination and respects a configured cutoff", async () => {
  await assert.rejects(fetchLegacyContent(base, "tender", undefined,
    async () => Response.json(page([post(1)], 1, 2))), /pagination did not advance/);
  const result = await fetchLegacyContent(base, "tender", since,
    async () => Response.json(page([post(1)])));
  assert.equal(result.news.length, 0);
  assert.deepEqual(parseLegacyContentBody('<script>bad()</script><p>Visible</p>'), { body: "Visible", imageUrl: null, linkUrl: null });
});

test("resources use the authenticated resource feed, follow pages and preserve document links", async () => {
  const requested = [];
  const result = await fetchLegacyResources(base, "test-token", async (url, init) => {
    assert.equal(url.pathname, "/api/Admin/fetchallresource");
    assert.equal(init.method, "POST");
    assert.equal(init.headers.authorization, "Bearer test-token");
    const body = JSON.parse(init.body);
    assert.equal(body.is_posted, true);
    requested.push(body.page);
    const row = {
      ...post(body.page, "resource"), title: `Market report ${body.page}`,
      body: JSON.stringify([{ type: "document", name: "Market report.pdf", url: "https://example.com/report.pdf" }]),
    };
    return Response.json(page([row, { id: `incomplete-${body.page}` }], body.page, 2));
  });
  assert.deepEqual(requested, [1, 2]);
  assert.equal(result.skipped, 2);
  assert.deepEqual(result.resources.map(row => row.id), ["resource:1", "resource:2"]);
  assert.equal(result.resources[0].type, "Report");
  assert.equal(result.resources[0].link, "https://example.com/report.pdf");
  assert.match(result.resources[0].body, /Market report.pdf/);
});

test("resources reject stalled, invalid and incomplete pagination", async () => {
  await assert.rejects(fetchLegacyResources(base, "test-token",
    async () => Response.json(page([post(1, "resource")], 1, 2))), /pagination did not advance/);
  await assert.rejects(fetchLegacyResources(base, "test-token",
    async () => Response.json(page([], 1, 2))), /incomplete page/);
  await assert.rejects(fetchLegacyResources(base, "test-token",
    async () => Response.json(page([], 1, 1001))));
});

test("resources require a token and handle the legacy empty-list response", async () => {
  await assert.rejects(fetchLegacyResources(base, undefined, async () => {
    assert.fail("Missing credentials must fail before a network request");
  }), /LEGACY_API_TOKEN/);
  assert.deepEqual(await fetchLegacyResources(base, "test-token", async () =>
    Response.json({ message: "No resources found" }, { status: 404 })), { resources: [], skipped: 0 });
  await assert.rejects(fetchLegacyResources(base, "test-token", async () =>
    Response.json({ error: "Unauthorized" }, { status: 401 })), /Legacy API read failed/);
});

test("document-only tenders preserve their PDF and reject unsafe attachment URLs", async () => {
  const row = post(1);
  row.body = JSON.stringify([
    { type: "document", name: "Bid requirements.pdf", url: "https://example.com/bid.pdf" },
    { type: "document", name: "Unsafe", url: "javascript:alert(1)" },
  ]);
  const content = await fetchLegacyContent(base, "tender", undefined, async () => Response.json(page([row])));
  assert.equal(content.news[0].linkUrl, "https://example.com/bid.pdf");
  assert.equal(content.news[0].body, "Bid requirements.pdf: https://example.com/bid.pdf");
  const { importLegacyNews } = await import("../dist/modules/legacy/import.js");
  await importLegacyNews(database, content);
  assert.equal((await context.pool.query("SELECT link_url FROM news_posts")).rows[0].link_url, "https://example.com/bid.pdf");
});

test("continuous sync adds new tenders/events, preserves edits/deletions and isolates feed failures", async () => {
  let eventId = 2;
  const fetcher = async (url, init) => {
    if (url.pathname.endsWith("fetchnewsdetails")) return new Response("Unavailable", { status: 503 });
    if (url.pathname.endsWith("getAllExchangeRates")) return Response.json({ data: [snapshot()] });
    const { type } = JSON.parse(init.body);
    if (type === "news") return Response.json(page([]));
    return Response.json(page([post(type === "tender" ? 1 : eventId, type)]));
  };
  const options = { baseUrl: base, since, newsSince: since, listings: false };
  const first = await runLegacySync(database, options, { fetcher });
  assert.equal(first.tender.newsInserted, 1);
  assert.equal(first.event.newsInserted, 1);
  assert.equal(first.forex.snapshots, 1);
  assert.equal(first.resources, undefined);
  assert.equal(first.errors.length, 2);
  assert.match(first.errors[0], /^news:/);
  assert.match(first.errors[1], /resources:.*LEGACY_API_TOKEN/);
  await context.pool.query("UPDATE news_posts SET title = 'Local edit' WHERE kind = 'Tender'");
  await context.pool.query("DELETE FROM news_posts WHERE kind = 'Event'");
  const second = await runLegacySync(database, options, { fetcher });
  assert.equal(second.tender.newsInserted, 0);
  assert.equal(second.event.newsInserted, 0);
  eventId = 3;
  const third = await runLegacySync(database, options, { fetcher });
  assert.equal(third.event.newsInserted, 1);
  const rows = (await context.pool.query("SELECT title, kind FROM news_posts ORDER BY kind")).rows;
  assert.equal(rows.length, 2);
  assert.equal(rows.find(row => row.kind === "Tender").title, "Local edit");
});

test("sync imports authenticated resources, preserves local edits/deletions and isolates resource failures", async (t) => {
  const publicBase = await fixture(t, context);
  let title = "Market resource guide";
  let unavailable = false;
  const fetcher = async (url, init) => {
    if (url.pathname.endsWith("fetchnewsdetails")) return new Response(null, { status: 503 });
    if (url.pathname.endsWith("getAllExchangeRates")) return Response.json({ data: [snapshot()] });
    if (!url.pathname.endsWith("fetchallresource")) return Response.json(page([]));
    assert.equal(init.headers.authorization, "Bearer test-token");
    if (unavailable) return new Response(null, { status: 503 });
    return Response.json(page([{ ...post(1, "resource"), title }]));
  };
  const options = { baseUrl: base, since, newsSince: since, listings: false, token: "test-token" };
  assert.equal((await runLegacySync(database, options, { fetcher })).resources.resourcesInserted, 1);
  const response = await fetch(`${publicBase}/api/content/resources`);
  assert.equal(response.status, 200);
  assert.equal((await response.json())[0].title, title);
  title = "Updated market resource guide";
  assert.equal((await runLegacySync(database, options, { fetcher })).resources.resourcesUpdated, 1);
  await context.pool.query("UPDATE resources SET title = 'Local guide title'");
  title = "Latest market resource guide";
  assert.equal((await runLegacySync(database, options, { fetcher })).resources.resourcesUpdated, 0);
  assert.equal((await context.pool.query("SELECT title FROM resources")).rows[0].title, "Local guide title");
  await context.pool.query("DELETE FROM resources");
  assert.equal((await runLegacySync(database, options, { fetcher })).resources.resourcesInserted, 0);
  unavailable = true;
  const failed = await runLegacySync(database, options, { fetcher });
  assert.ok(failed.errors.some(error => error.startsWith("resources:")));
  assert.equal(failed.forex.snapshots, 1);
});

test("forex rejects invalid payloads and treats missing/implausible rates as unavailable", () => {
  const input = snapshot();
  input.body["Other Bank"] = { buyPrice: "", sellPrice: 16457 };
  const [parsed] = parseBankForex({ data: [input] });
  assert.equal(parsed.rates.length, 2);
  assert.deepEqual(parsed.rates[1], { bank: "Other Bank", buying: null, selling: null });
  assert.deepEqual(parseBankForex([{ ...input, body: JSON.stringify(input.body) }])[0].rates, parsed.rates);
  assert.throws(() => parseBankForex({ data: [{ ...input, createdAt: "bad date" }] }));
});

test("sync refreshes images on older tender pages and serves them without replacing local edits", async (t) => {
  const publicBase = await fixture(t, context);
  let imageUrl = null;
  const requested = [];
  const fetcher = async (url, init) => {
    if (url.pathname.endsWith("fetchnewsdetails")) return new Response(null, { status: 503 });
    if (url.pathname.endsWith("getAllExchangeRates")) return Response.json({ data: [snapshot()] });
    const { type, page: currentPage } = JSON.parse(init.body);
    if (type !== "tender") return Response.json(page([]));
    requested.push(currentPage);
    const row = post(currentPage);
    row.title = `Tender announcement ${currentPage}`;
    row.body = JSON.stringify([
      { type: "paragraph", text: "Original tender details" },
      ...(currentPage === 2 && imageUrl ? [{ type: "image", url: imageUrl }] : []),
    ]);
    return Response.json(page([row], currentPage, 2));
  };
  const options = { baseUrl: base, since, newsSince: since, listings: false };
  assert.equal((await runLegacySync(database, options, { fetcher })).tender.newsInserted, 2);
  const { rows: [target] } = await context.pool.query("SELECT news_post_id FROM legacy_news_imports WHERE source_id = 'post:2'");
  await context.pool.query("UPDATE news_posts SET title = 'Local title', body = 'Local tender details' WHERE id = $1", [target.news_post_id]);

  imageUrl = "https://example.com/added-later.jpg";
  requested.length = 0;
  assert.equal((await runLegacySync(database, options, { fetcher })).tender.newsUpdated, 1);
  assert.deepEqual(requested, [1, 2]);
  const response = await fetch(`${publicBase}/api/content/tenders`);
  assert.equal(response.status, 200);
  const tender = (await response.json()).find(item => item.id === target.news_post_id);
  assert.equal(tender.imageUrl, imageUrl);
  assert.equal(tender.title, "Local title");
  assert.equal(tender.body, "Local tender details");
  assert.equal((await runLegacySync(database, options, { fetcher })).tender.newsUpdated, 0);

  imageUrl = "https://example.com/replaced.jpg";
  assert.equal((await runLegacySync(database, options, { fetcher })).tender.newsUpdated, 1);
  imageUrl = null;
  assert.equal((await runLegacySync(database, options, { fetcher })).tender.newsUpdated, 1);
  imageUrl = "https://example.com/restored.jpg";
  assert.equal((await runLegacySync(database, options, { fetcher })).tender.newsUpdated, 1);

  await context.pool.query("UPDATE news_posts SET image_url = 'https://example.com/local.jpg' WHERE id = $1", [target.news_post_id]);
  imageUrl = "https://example.com/another-source-image.jpg";
  assert.equal((await runLegacySync(database, options, { fetcher })).tender.newsUpdated, 0);
  assert.equal((await context.pool.query("SELECT image_url FROM news_posts WHERE id = $1", [target.news_post_id])).rows[0].image_url, "https://example.com/local.jpg");

  await context.pool.query("UPDATE news_posts SET image_url = NULL WHERE id = $1", [target.news_post_id]);
  imageUrl = "https://example.com/latest.jpg";
  assert.equal((await runLegacySync(database, options, { fetcher })).tender.newsUpdated, 0);
  assert.equal((await context.pool.query("SELECT image_url FROM news_posts WHERE id = $1", [target.news_post_id])).rows[0].image_url, null);
  await context.pool.query("DELETE FROM news_posts WHERE id = $1", [target.news_post_id]);
  assert.equal((await runLegacySync(database, options, { fetcher })).tender.newsInserted, 0);
});

test("forex is public, uses latest publication, updates corrections, and survives a failed sync", async (t) => {
  const publicBase = await fixture(t, context);
  const empty = await fetch(`${publicBase}/api/catalog/forex/latest`);
  assert.equal(empty.status, 200);
  assert.equal((await empty.json()).snapshot, null);
  const newer = snapshot(2, "2026-09-26T09:00:00Z");
  let feed = { data: [newer, snapshot()] };
  await syncBankForex(database, base, async () => Response.json(feed));
  newer.body["Awash Bank"].buyPrice = 162;
  newer.updatedAt = "2026-09-26T12:00:00Z";
  await syncBankForex(database, base, async () => Response.json(feed));
  assert.equal((await context.pool.query("SELECT count(*) FROM bank_forex_snapshots")).rows[0].count, 2);
  await assert.rejects(syncBankForex(database, base, async () => new Response(null, { status: 503 })));
  const response = await fetch(`${publicBase}/api/catalog/forex/latest`);
  const data = await response.json();
  assert.equal(data.snapshot.rates[0].buying, 162);
  assert.equal(data.snapshot.effective_at, "2026-09-26T09:00:00.000Z");
  // A delayed, older response must not overwrite a corrected snapshot.
  feed = { data: [snapshot(2, "2026-09-26T09:00:00Z")] };
  await syncBankForex(database, base, async () => Response.json(feed));
  assert.equal((await latestBankForex(database)).snapshot.rates[0].buying, 162);
});
