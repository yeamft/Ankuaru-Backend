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

/** An active account with a live session; `verified` covers identity and phone. */
async function person({ accountRole = "user", traderRole = "both", verified = true } = {}) {
  const id = `usr_${randomUUID()}`;
  const token = randomBytes(32).toString("base64url");
  await query(
    `INSERT INTO traders (id, display_name, role, status, verified, phone_verified)
     VALUES ($1, $2, $3, 'Active', $4, $4)`,
    [id, `${accountRole} ${traderRole}`, traderRole, verified],
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

const json = async (response, status) => {
  const text = await response.text();
  assert.equal(response.status, status, text);
  return text ? JSON.parse(text) : null;
};

test("products keep a trading unit and description", async (t) => {
  const base = await fixture(t, context);
  const admin = await person({ accountRole: "platform_admin" });
  const created = await json(
    await call(base, "/catalog/admin/products", {
      method: "POST",
      headers: admin.headers,
      body: { category_id: "coffee", name: "Green Beans Test", unit: "Bag", description: "Sorted by hand." },
    }),
    201,
  );
  assert.equal(created.unit, "Bag");
  assert.equal(created.description, "Sorted by hand.");

  const updated = await json(
    await call(base, `/catalog/admin/products/${created.id}`, {
      method: "PATCH",
      headers: admin.headers,
      body: { unit: "MT" },
    }),
    200,
  );
  assert.equal(updated.unit, "MT");
  await json(
    await call(base, `/catalog/admin/products/${created.id}`, {
      method: "PATCH",
      headers: admin.headers,
      body: { unit: "Tonne" },
    }),
    400,
  );

  const catalog = await json(await call(base, "/catalog/admin", { headers: admin.headers }), 200);
  const product = catalog.flatMap((category) => category.products).find((item) => item.id === created.id);
  assert.equal(product.unit, "MT");
  assert.ok(product.created_at);
});

test("attributes and their values are managed by catalog staff", async (t) => {
  const base = await fixture(t, context);
  const admin = await person({ accountRole: "platform_admin" });
  const moderator = await person({ accountRole: "moderator" });

  await json(
    await call(base, "/catalog/admin/attributes", { headers: moderator.headers }),
    403,
  );
  const attribute = await json(
    await call(base, "/catalog/admin/attributes", {
      method: "POST",
      headers: admin.headers,
      body: { category_id: "coffee", name: "Screen Size", input_type: "select", required: true },
    }),
    201,
  );
  assert.equal(attribute.input_type, "select");
  assert.deepEqual(attribute.values, []);
  await json(
    await call(base, "/catalog/admin/attributes", {
      method: "POST",
      headers: admin.headers,
      body: { category_id: "coffee", name: "screen size" },
    }),
    409,
  );

  const value = await json(
    await call(base, `/catalog/admin/attributes/${attribute.id}/values`, {
      method: "POST",
      headers: admin.headers,
      body: { name: "Screen 15", aliases: ["S15", "s15"] },
    }),
    201,
  );
  assert.deepEqual(value.aliases, ["s15"]);
  await json(
    await call(base, `/catalog/admin/attributes/${attribute.id}/values`, {
      method: "POST",
      headers: admin.headers,
      body: { name: "screen 15" },
    }),
    409,
  );

  const list = await json(await call(base, "/catalog/admin/attributes", { headers: admin.headers }), 200);
  assert.equal(list.find((item) => item.id === attribute.id).values.length, 1);

  await json(await call(base, `/catalog/admin/values/${value.id}`, { method: "DELETE", headers: admin.headers }), 200);
  await json(await call(base, `/catalog/admin/values/not-a-uuid`, { method: "DELETE", headers: admin.headers }), 404);
  await json(
    await call(base, `/catalog/admin/attributes/${attribute.id}`, { method: "DELETE", headers: admin.headers }),
    200,
  );
});

test("reference prices are recorded, listed and removed", async (t) => {
  const base = await fixture(t, context);
  const admin = await person({ accountRole: "platform_admin" });
  const [{ id: productId }] = await query("SELECT id FROM catalog_products ORDER BY id LIMIT 1");
  const today = new Date().toISOString().slice(0, 10);

  const price = await json(
    await call(base, "/catalog/admin/prices", {
      method: "POST",
      headers: admin.headers,
      body: { product_id: productId, price: 1250.5, currency: "ETB", market: "Addis Ababa", date: today },
    }),
    201,
  );
  assert.equal(price.price, 1250.5);
  await json(
    await call(base, "/catalog/admin/prices", {
      method: "POST",
      headers: admin.headers,
      body: { product_id: productId, price: 10, market: "Addis Ababa", date: "2999-01-01" },
    }),
    400,
  );
  const prices = await json(await call(base, "/catalog/admin/prices", { headers: admin.headers }), 200);
  assert.equal(prices.length, 1);
  await json(await call(base, `/catalog/admin/prices/${price.id}`, { method: "DELETE", headers: admin.headers }), 200);
});

test("resources are drafted, published and only published ones are public", async (t) => {
  const base = await fixture(t, context);
  const editor = await person({ accountRole: "content_manager" });
  const resource = await json(
    await call(base, "/content/admin/resources", {
      method: "POST",
      headers: editor.headers,
      body: { title: "Coffee export guide", type: "Guide", summary: "Steps to export green coffee.", status: "Draft" },
    }),
    201,
  );
  assert.deepEqual(await json(await call(base, "/content/resources"), 200), []);
  await json(
    await call(base, "/content/admin/resources", {
      method: "POST",
      headers: editor.headers,
      body: { title: "How to grade", type: "Video", summary: "A short video on grading.", link: "" },
    }),
    400,
  );
  await json(
    await call(base, `/content/admin/resources/${resource.id}`, {
      method: "PUT",
      headers: editor.headers,
      body: { ...resource, status: "Published" },
    }),
    200,
  );
  const published = await json(await call(base, "/content/resources"), 200);
  assert.equal(published.length, 1);
  await json(
    await call(base, `/content/admin/resources/${resource.id}`, { method: "DELETE", headers: editor.headers }),
    200,
  );
});

test("public news, tender and event feeds support validated limits", async (t) => {
  const base = await fixture(t, context);
  const editor = await person({ accountRole: "content_manager" });
  const kinds = [
    ["News", "/content/news"],
    ["Tender", "/content/tenders"],
    ["Event", "/content/events"],
  ];
  const publishedIds = new Map();

  for (const [kind] of kinds) {
    for (let index = 0; index < 2; index += 1) {
      const post = await json(
        await call(base, "/content/admin/posts", {
          method: "POST",
          headers: editor.headers,
          body: {
            title: `${kind} notice ${index + 1}`,
            summary: `Published ${kind.toLowerCase()} notice summary.`,
            body: `Details for published ${kind.toLowerCase()} notice.`,
            category: "Market",
            kind,
            source: "ANKUARU",
            status: "Published",
          },
        }),
        201,
      );
      if (index === 0) publishedIds.set(kind, post.id);
    }
  }

  for (const [kind, path] of kinds) {
    const firstPageResponse = await call(base, `${path}?limit=1`);
    const firstPage = await json(firstPageResponse, 200);
    assert.equal(firstPage.length, 1);
    const cursor = firstPageResponse.headers.get("x-next-cursor");
    assert.ok(cursor);
    const secondPage = await json(
      await call(base, `${path}?limit=1&cursor=${encodeURIComponent(cursor)}`),
      200,
    );
    assert.equal(secondPage.length, 1);
    assert.notEqual(firstPage[0].id, secondPage[0].id);
    assert.equal((await json(await call(base, path), 200)).length, 2);
    const detail = await json(
      await call(base, `${path}/${publishedIds.get(kind)}`),
      200,
    );
    assert.equal(detail.kind, kind);
    const wrongKindPath =
      kind === "News" ? "/content/events" : kind === "Event" ? "/content/news" : "/content/events";
    await json(await call(base, `${wrongKindPath}/${publishedIds.get(kind)}`), 404);
    await json(await call(base, `${path}?limit=101`), 400);
    await json(await call(base, `${path}?limit=invalid`), 400);
  }
});

test("news views and shares are counted per post, with unique readers", async (t) => {
  const base = await fixture(t, context);
  const editor = await person({ accountRole: "content_manager" });
  const post = await json(
    await call(base, "/content/admin/posts", {
      method: "POST",
      headers: editor.headers,
      body: {
        title: "Coffee prices rise",
        summary: "Export prices rose this week.",
        body: "Prices for grade 1 coffee rose by five percent.",
        category: "Market",
        source: "ANKUARU",
        status: "Published",
      },
    }),
    201,
  );
  for (const visitor of ["visitor-aaaa", "visitor-aaaa", "visitor-bbbb"])
    await json(
      await call(base, `/content/news/${post.id}/events`, {
        method: "POST",
        body: { kind: "view", visitor, read_seconds: 60 },
      }),
      202,
    );
  await json(
    await call(base, `/content/news/${post.id}/events`, {
      method: "POST",
      body: { kind: "share", visitor: "visitor-bbbb" },
    }),
    202,
  );
  await json(
    await call(base, `/content/news/${randomUUID()}/events`, {
      method: "POST",
      body: { kind: "view", visitor: "visitor-aaaa" },
    }),
    404,
  );

  const stats = await json(
    await call(base, "/content/admin/news-statistics?days=30", { headers: editor.headers }),
    200,
  );
  const row = stats.posts.find((item) => item.id === post.id);
  assert.equal(row.views, 3);
  assert.equal(row.readers, 2);
  assert.equal(row.shares, 1);
  assert.equal(row.avg_read_seconds, 60);
  assert.equal(stats.daily.at(-1).views, 3);
});

test("staff post listings for traders, count views, and delete unused ones", async (t) => {
  const base = await fixture(t, context);
  const moderator = await person({ accountRole: "moderator" });
  const seller = await person({ traderRole: "seller" });
  const unverified = await person({ traderRole: "seller", verified: false });

  const listing = await json(
    await call(base, "/admin/listings", {
      method: "POST",
      headers: moderator.headers,
      body: {
        owner_id: seller.id,
        status: "Active",
        intent: "sell",
        category: "coffee",
        product: "Export Coffee",
        quantity: "120",
        price_amount: 5000,
        price_currency: "ETB",
        region: "Sidama",
      },
    }),
    201,
  );
  assert.equal(listing.status, "Active");
  assert.equal(listing.source, "admin");
  assert.equal(listing.views, 0);

  await json(
    await call(base, "/admin/listings", {
      method: "POST",
      headers: moderator.headers,
      body: { owner_id: unverified.id, status: "Active", intent: "sell", category: "coffee", product: "Export Coffee" },
    }),
    409,
  );
  // A buyer-only rule still applies: sellers cannot post buy requests.
  await json(
    await call(base, "/admin/listings", {
      method: "POST",
      headers: moderator.headers,
      body: { owner_id: seller.id, intent: "buy", category: "coffee", product: "Export Coffee" },
    }),
    403,
  );

  await json(await call(base, `/listings/${listing.id}`), 200);
  await json(await call(base, `/listings/${listing.id}`), 200);
  const [{ views }] = await query("SELECT views FROM listings WHERE id = $1", [listing.id]);
  assert.equal(views, 2);

  const sells = await json(await call(base, "/admin/listings?intent=sell", { headers: moderator.headers }), 200);
  assert.ok(sells.every((item) => item.intent === "sell"));
  assert.equal(sells.find((item) => item.id === listing.id).views, 2);

  await json(
    await call(base, `/admin/listings/${listing.id}`, { method: "DELETE", headers: moderator.headers }),
    200,
  );
  await json(
    await call(base, `/admin/listings/${listing.id}`, { method: "DELETE", headers: moderator.headers }),
    404,
  );
});
