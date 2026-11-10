import assert from "node:assert/strict";
import { before, beforeEach, after, test } from "node:test";
import {
  asBuyer,
  asSeller,
  call,
  createTestDatabase,
  demoFixture,
  fixture,
  resetDatabase,
} from "./helpers.mjs";

let context;
before(async () => {
  context = await createTestDatabase();
});
beforeEach(() => resetDatabase(context.database));
after(() => context.database.close());

const offer = { intent: "sell", category: "coffee", product: "Export Coffee" };

async function createListing(base, headers = asSeller, body = offer) {
  const response = await call(base, "/listings", { method: "POST", headers, body });
  assert.equal(response.status, 201, await response.clone().text());
  return response.json();
}

for (const headers of [
  { authorization: "Bearer seller-demo" },
  { "x-demo-user-id": "seller-demo" },
  { "x-user-id": "seller-demo" },
  {},
]) {
  test(`production rejects unverified identity ${JSON.stringify(headers)}`, async (t) => {
    const base = await fixture(t, context);
    const response = await call(base, "/my-listings", { headers });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await response.json()).error, "unauthorized");
  });
}

test("production rejects demo admin access", async (t) => {
  const base = await fixture(t, context);
  const response = await call(base, "/admin/overview", {
    headers: { "x-demo-admin-id": "admin-demo" },
  });
  assert.equal(response.status, 403);
});

test("development rejects arbitrary user identities", async (t) => {
  const base = await demoFixture(t, context);
  const response = await call(base, "/my-listings", {
    headers: { "x-demo-user-id": "someone-else" },
  });
  assert.equal(response.status, 401);
});

test("listing creation stores the resolved identity, normalizes fields, and ignores spoofed owners", async (t) => {
  const base = await demoFixture(t, context);
  const listing = await createListing(
    base,
    { ...asSeller, "x-user-id": "spoofed" },
    {
      ...offer,
      owner_id: "spoofed",
      quantity: "  480 Quintal ",
      description: "   ",
      price_amount: 4.25,
      price_currency: " etb ",
      available_from: "2026-12-01",
    },
  );
  assert.equal(listing.owner_id, "seller-demo");
  assert.match(listing.id, /^lst_[0-9a-f]{32}$/);
  assert.equal(
    listing.reference,
    `ANK-IOI-${new Date().getUTCFullYear()}-${listing.id.slice(4, 12)}`,
  );
  assert.equal(listing.quantity, "480 Quintal");
  assert.equal(listing.description, null);
  assert.equal(listing.price_amount, 4.25);
  assert.equal(listing.price_currency, "ETB");
  assert.equal(listing.available_from, "2026-12-01");
  // Verified traders' listings wait for staff approval.
  assert.equal(listing.status, "Pending Review");
  assert.equal(listing.source, "web");
  assert.equal(listing.owner_name, null);
  assert.equal(listing.owner_verified, false);

  const detail = await call(base, `/listings/${listing.id}`);
  assert.deepEqual(await detail.json(), listing);
  const missing = await call(base, "/listings/missing");
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, "listing_not_found");
});

test("listings keep coffee attributes and show the owner's public profile", async (t) => {
  const base = await demoFixture(t, context);
  await context.database.query(
    "INSERT INTO traders (id, display_name, verified, status) VALUES ('seller-demo', 'Sidama Union', true, 'Active')",
  );
  const listing = await createListing(base, asSeller, {
    ...offer,
    region: " Sidama ",
    grade: "1",
    process: "washed",
    transaction_type: "horizontal",
  });
  assert.deepEqual(
    [listing.region, listing.grade, listing.process, listing.transaction_type],
    ["Sidama", "1", "washed", "horizontal"],
  );
  assert.equal(listing.owner_name, "Sidama Union");
  assert.equal(listing.owner_verified, true);
  const [listed] = await (await call(base, "/listings")).json();
  assert.equal(listed.owner_name, "Sidama Union");
});

test("invalid listings are rejected without being stored", async (t) => {
  const base = await demoFixture(t, context);
  for (const [body, error] of [
    [{ intent: "sell" }, "invalid_listing"],
    [{ ...offer, intent: "swap" }, "invalid_listing"],
    [{ ...offer, product: "  " }, "invalid_listing"],
    [{ ...offer, price_amount: -1 }, "invalid_price"],
    [{ ...offer, price_amount: "12" }, "invalid_price"],
    [{ ...offer, price_currency: "" }, "invalid_currency"],
    [{ ...offer, price_currency: "TOO-LONG-CODE" }, "invalid_currency"],
    [{ ...offer, available_from: "2026-02-30" }, "invalid_listing"],
    [{ ...offer, quantity: 12 }, "invalid_listing"],
    [{ ...offer, grade: 1 }, "invalid_listing"],
    [{ ...offer, region: "x".repeat(101) }, "invalid_listing"],
  ]) {
    const response = await call(base, "/listings", { method: "POST", headers: asSeller, body });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await response.json()).error, error);
  }
  for (const query of ["intent=invalid", "intent=buy&intent=sell", "category=a&category=b"]) {
    assert.equal((await call(base, `/listings?${query}`)).status, 400);
  }
  assert.equal((await context.database.query("SELECT * FROM listings")).rows.length, 0);
});

test("the public market lists only live listings and supports filters", async (t) => {
  const base = await demoFixture(t, context);
  const sell = await createListing(base);
  const buy = await createListing(base, asBuyer, { ...offer, intent: "buy", category: "pulses" });
  const hidden = await createListing(base);
  // New listings await review; approve the two that should be live.
  await context.database.query("UPDATE listings SET status = 'Active' WHERE id = ANY($1)", [
    [sell.id, buy.id],
  ]);
  const ids = async (query) =>
    (await (await call(base, `/listings${query}`)).json()).map((item) => item.id);
  assert.deepEqual(await ids(""), [buy.id, sell.id]);
  assert.deepEqual(await ids("?intent=sell"), [sell.id]);
  assert.deepEqual(await ids("?category=pulses"), [buy.id]);
  // Search matches every word, case-insensitively, and treats % and _ literally.
  await context.database.query("UPDATE listings SET region = 'Guji', grade = 'Grade 1' WHERE id = $1", [sell.id]);
  assert.deepEqual(await ids("?search=guji"), [sell.id]);
  assert.deepEqual(await ids("?search=GUJI%20grade"), [sell.id]);
  assert.deepEqual(await ids("?search=guji%20pulses"), []);
  assert.deepEqual(await ids("?search=%25"), []);
  assert.equal((await call(base, `/listings/${hidden.id}`)).status, 404);
  assert.deepEqual(
    (await (await call(base, "/my-listings", { headers: asSeller })).json()).map(({ id }) => id),
    [hidden.id, sell.id],
  );
});

test("list endpoints page newest first through a cursor without gaps or repeats", async (t) => {
  const base = await demoFixture(t, context);
  // Equal timestamps exercise the ID tie-breaker.
  await context.database.exec(`
    INSERT INTO listings (id, owner_id, reference, intent, category, product, created_at)
    SELECT 'lst_' || lpad(n::text, 3, '0'), 'seller-demo', 'REF-' || n, 'sell', 'coffee', 'Coffee',
           timestamptz '2026-01-01' + (n / 3) * interval '1 microsecond'
    FROM generate_series(1, 7) AS n;
  `);
  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    const response = await call(
      base,
      `/listings?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      { headers: { origin: "http://localhost:8080" } },
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("access-control-expose-headers"), /X-Next-Cursor/i);
    const items = await response.json();
    assert.ok(items.every((item) => !("_k0" in item) && !("_k1" in item)));
    seen.push(...items.map((item) => item.id));
    cursor = response.headers.get("x-next-cursor");
    pages++;
  } while (cursor);
  assert.equal(pages, 3);
  assert.deepEqual(seen, [
    "lst_007",
    "lst_006",
    "lst_005",
    "lst_004",
    "lst_003",
    "lst_002",
    "lst_001",
  ]);

  for (const query of ["limit=0", "limit=101", "limit=ten", "cursor=nope"]) {
    const response = await call(base, `/listings?${query}`);
    assert.equal(response.status, 400, query);
  }
  const forged = Buffer.from(JSON.stringify(["not a time", "x"])).toString("base64url");
  const response = await call(base, `/listings?cursor=${forged}`);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "invalid_input");
});

test("telegram imports are held for review, strip phone numbers, and are idempotent", async (t) => {
  const base = await demoFixture(t, context);
  const body = {
    message_id: " tg-100 ",
    text: "I Want To: Sell\nRegion: Guji\nGrade: 1\nQuantity: 60 bags\nCoffee, call 0912345678",
  };
  const first = await call(base, "/imports/telegram", { method: "POST", headers: asSeller, body });
  assert.equal(first.status, 201);
  const imported = await first.json();
  assert.equal(imported.duplicate, false);
  assert.equal(imported.listing.status, "Pending Review");
  assert.equal(imported.listing.source_reference, "tg-100");
  assert.equal(imported.listing.grade, "G1");
  assert.match(imported.listing.reference, /^ANK-TG-\d{4}-[0-9a-f]{8}$/);
  assert.ok(!imported.listing.description.includes("0912345678"));

  const again = await call(base, "/imports/telegram", { method: "POST", headers: asBuyer, body });
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), { listing: imported.listing, duplicate: true });
  assert.deepEqual(await (await call(base, "/listings")).json(), []);

  const chat = await call(base, "/imports/telegram", {
    method: "POST",
    headers: asSeller,
    body: { message_id: "tg-101", text: "Good morning everyone" },
  });
  assert.equal(chat.status, 422);
  const empty = await call(base, "/imports/telegram", {
    method: "POST",
    headers: asSeller,
    body: { message_id: "x".repeat(129), text: "coffee for sale" },
  });
  assert.equal(empty.status, 400);
});

test("inquiries reach the seller, stay private to both parties, and follow status rules", async (t) => {
  const base = await demoFixture(t, context);
  const listing = await createListing(base);
  const post = (headers, body, id = listing.id) =>
    call(base, `/listings/${id}/inquiries`, { method: "POST", headers, body });

  assert.equal((await post(asBuyer, { message: "  " })).status, 400);
  assert.equal((await post(asBuyer, { message: "Hi" }, "missing")).status, 404);
  const own = await post(asSeller, { message: "Hi" });
  assert.equal((await own.json()).error, "cannot_inquire_on_own_listing");

  const created = await post(asBuyer, { message: "  Is 60 bags available?  " });
  assert.equal(created.status, 201);
  const inquiry = await created.json();
  assert.deepEqual(
    {
      buyer: inquiry.buyer_id,
      seller: inquiry.seller_id,
      message: inquiry.message,
      status: inquiry.status,
    },
    { buyer: "buyer-demo", seller: "seller-demo", message: "Is 60 bags available?", status: "New" },
  );
  for (const headers of [asBuyer, asSeller]) {
    const list = await (await call(base, "/inquiries", { headers })).json();
    assert.deepEqual(
      list.map(({ id }) => id),
      [inquiry.id],
    );
    assert.equal(list[0].listing_reference, listing.reference);
    assert.equal(list[0].listing_product, "Export Coffee");
  }

  const patch = (headers, body, id = inquiry.id) =>
    call(base, `/inquiries/${id}`, { method: "PATCH", headers, body });
  assert.equal((await patch(asSeller, { status: "Archived" })).status, 400);
  assert.equal((await patch(asSeller, { status: "Closed" }, "not-a-uuid")).status, 400);
  const updated = await patch(asSeller, { status: "Responded" });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).status, "Responded");

  // Inquiries on a closed listing are refused.
  await context.database.query("UPDATE listings SET status = 'Closed' WHERE id = $1", [listing.id]);
  assert.equal((await post(asBuyer, { message: "Still there?" })).status, 404);
});

async function openStream(base, headers) {
  const controller = new AbortController();
  const response = await call(base, "/events", { headers, signal: controller.signal });
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  return {
    response,
    close: () => controller.abort(),
    /** Resolves with the next frame that is not a comment or retry hint. */
    async next() {
      for (;;) {
        const end = buffer.indexOf("\n\n");
        if (end >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (frame.startsWith("retry:") || frame.startsWith(":")) continue;
          return frame;
        }
        const { value, done } = await reader.read();
        if (done) return null;
        buffer += value;
      }
    },
  };
}

test("new inquiries are pushed to the seller's event stream only", async (t) => {
  const base = await demoFixture(t, context);
  const listing = await createListing(base);
  const seller = await openStream(base, asSeller);
  const buyer = await openStream(base, asBuyer);
  t.after(() => {
    seller.close();
    buyer.close();
  });
  assert.equal(seller.response.status, 200);
  assert.equal(seller.response.headers.get("content-type"), "text/event-stream");

  const created = await call(base, `/listings/${listing.id}/inquiries`, {
    method: "POST",
    headers: asBuyer,
    body: { message: "Price for 60 bags?" },
  });
  const inquiry = await created.json();
  const frame = await seller.next();
  const data = JSON.parse(
    frame
      .split("\n")
      .find((line) => line.startsWith("data: "))
      .slice(6),
  );
  assert.match(frame, /^id: evt_/);
  assert.match(frame, /\nevent: inquiry.created\n/);
  assert.equal(data.event_type, "inquiry.created");
  assert.equal(data.recipient_user_id, "seller-demo");
  assert.deepEqual(data.inquiry, inquiry);

  // The buyer's stream receives nothing for the seller's event.
  const quiet = await Promise.race([
    buyer.next(),
    new Promise((resolve) => setTimeout(() => resolve("quiet"), 200)),
  ]);
  assert.equal(quiet, "quiet");
});

test("event streams require a session and close when it is revoked", async (t) => {
  const base = await fixture(t, context, { heartbeatMs: 50 });
  assert.equal((await call(base, "/events")).status, 401);

  const registered = await call(base, "/auth/register", {
    method: "POST",
    body: {
      email: "stream@example.com",
      password: "a long test password",
      display_name: "Stream test",
    },
  });
  const { access_token: token } = await registered.json();
  const stream = await openStream(base, { authorization: `Bearer ${token}` });
  t.after(() => stream.close());
  assert.equal(stream.response.status, 200);
  await call(base, "/auth/logout", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(await stream.next(), null);
});

test("aborted transactions publish no events", async (t) => {
  const base = await demoFixture(t, context);
  const listing = await createListing(base);
  const seller = await openStream(base, asSeller);
  t.after(() => seller.close());
  const created = await call(base, `/listings/${listing.id}/inquiries`, {
    method: "POST",
    headers: asBuyer,
    body: { message: "First" },
  });
  const inquiry = await created.json();
  assert.match(await seller.next(), /event: inquiry.created/);

  // A notification for a real inquiry, raised in a transaction that rolls back.
  const client = await context.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_notify('ankuaru_events', $1)", [
      JSON.stringify({
        id: "evt_rolled_back",
        event_type: "inquiry.created",
        recipient_user_id: "seller-demo",
        inquiry_id: inquiry.id,
        occurred_at: new Date().toISOString(),
      }),
    ]);
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
  const quiet = await Promise.race([
    seller.next(),
    new Promise((resolve) => setTimeout(() => resolve("quiet"), 200)),
  ]);
  assert.equal(quiet, "quiet");
});

test("malformed and oversized JSON return JSON errors", async (t) => {
  const base = await demoFixture(t, context);
  const malformed = await call(base, "/listings", { method: "POST", body: "{" });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error, "invalid_json");
  const large = await call(base, "/listings", {
    method: "POST",
    body: { product: "x".repeat(1024 * 1024) },
  });
  assert.equal(large.status, 413);
  assert.equal((await large.json()).error, "payload_too_large");
});

test("health reports the database, preview origins pass CORS, and unknown routes return JSON", async (t) => {
  const base = await fixture(t, context);
  const health = await call(base, "/health", { headers: { origin: "http://localhost:8080" } });
  assert.equal(health.status, 200);
  assert.equal(health.headers.get("access-control-allow-origin"), "http://localhost:8080");
  const previewOrigin = "https://preview.example.expo.app";
  const preflight = await call(base, "/api/auth/login", {
    method: "OPTIONS",
    headers: {
      origin: previewOrigin,
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization,content-type",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), previewOrigin);
  assert.match(preflight.headers.get("access-control-allow-methods") ?? "", /POST/);
  assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /authorization/i);
  const body = await health.json();
  assert.deepEqual(
    { service: body.service, status: body.status, database: body.database },
    { service: "ankuaru-api", status: "up", database: "up" },
  );
  assert.equal(typeof body.latency_ms, "number");
  if (body.pool) assert.equal(typeof body.pool.total, "number");

  const broken = await fixture(t, {
    ...context,
    pool: { query: () => Promise.reject(new Error("down")) },
  });
  const degraded = await call(broken, "/health");
  assert.equal(degraded.status, 503);
  assert.equal((await degraded.json()).database, "down");

  const missing = await call(base, "/missing");
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, "not_found");
});
