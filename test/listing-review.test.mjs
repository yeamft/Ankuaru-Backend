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

const offer = { intent: "sell", category: "coffee", product: "Export Coffee" };

async function post(base, owner, body = offer) {
  const response = await call(base, "/listings", { method: "POST", headers: owner.headers, body });
  assert.equal(response.status, 201, await response.clone().text());
  return response.json();
}

const review = (base, staff, id, action, body) =>
  call(base, `/admin/listings/${id}/${action}`, { method: "POST", headers: staff.headers, body });
const publicIds = async (base) =>
  (await (await call(base, "/listings")).json()).map(({ id }) => id);

test("verified traders' listings wait for staff approval before reaching the market", async (t) => {
  const base = await fixture(t, context);
  const seller = await person({ traderRole: "seller" });
  const moderator = await person({ accountRole: "moderator" });

  const listing = await post(base, seller);
  assert.equal(listing.status, "Pending Review");
  assert.deepEqual(await publicIds(base), []);

  const queue = await call(base, "/admin/listings?status=Pending%20Review", {
    headers: moderator.headers,
  });
  assert.deepEqual((await queue.json()).map(({ id }) => id), [listing.id]);

  const approved = await review(base, moderator, listing.id, "approve");
  assert.equal(approved.status, 200);
  const body = await approved.json();
  assert.equal(body.status, "Active");
  assert.equal(body.reviewed_by, moderator.id);
  assert.deepEqual(await publicIds(base), [listing.id]);
  assert.equal((await review(base, moderator, listing.id, "approve")).status, 409);
  assert.deepEqual(await query("SELECT action FROM audit_events"), [{ action: "listing.approved" }]);
});

test("a rejection tells the owner why, and they can resubmit", async (t) => {
  const base = await fixture(t, context);
  const seller = await person();
  const moderator = await person({ accountRole: "moderator" });
  const listing = await post(base, seller);

  assert.equal((await review(base, moderator, listing.id, "reject", {})).status, 400);
  const rejected = await review(base, moderator, listing.id, "reject", {
    reason: "Add the grade and a photo of the lot.",
  });
  assert.equal((await rejected.json()).status, "Rejected");

  const mine = await (await call(base, "/my-listings", { headers: seller.headers })).json();
  assert.equal(mine[0].status, "Rejected");
  assert.equal(mine[0].review_note, "Add the grade and a photo of the lot.");

  const resubmitted = await call(base, `/my-listings/${listing.id}/publish`, {
    method: "POST",
    headers: seller.headers,
  });
  const again = await resubmitted.json();
  assert.equal(again.status, "Pending Review");
  assert.equal(again.review_note, null);
});

test("only moderating staff review, never their own listings, and approval cannot be skipped", async (t) => {
  const base = await fixture(t, context);
  const seller = await person();
  const writer = await person({ accountRole: "content_manager" });
  const moderator = await person({ accountRole: "moderator" });
  const listing = await post(base, seller);

  assert.equal((await review(base, writer, listing.id, "approve")).status, 403);
  assert.equal((await review(base, seller, listing.id, "approve")).status, 403);
  const skip = await call(base, `/admin/listings/${listing.id}`, {
    method: "PATCH",
    headers: moderator.headers,
    body: { status: "Active" },
  });
  assert.equal(skip.status, 409);

  const own = await post(base, moderator);
  const self = await review(base, moderator, own.id, "approve");
  assert.equal(self.status, 403);
  assert.equal((await self.json()).error, "cannot_review_own_listing");
});

test("unverified traders keep drafts until verified, and unverified owners cannot be approved", async (t) => {
  const base = await fixture(t, context);
  const newcomer = await person({ verified: false });
  const moderator = await person({ accountRole: "moderator" });

  const draft = await post(base, newcomer);
  assert.equal(draft.status, "Draft");
  const submit = await call(base, `/my-listings/${draft.id}/publish`, {
    method: "POST",
    headers: newcomer.headers,
  });
  assert.equal(submit.status, 403);

  // A listing that reached review before its owner lost verification.
  await query("UPDATE listings SET status = 'Pending Review' WHERE id = $1", [draft.id]);
  const blocked = await review(base, moderator, draft.id, "approve");
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).error, "owner_not_verified");
});

test("with auto-publish on, verified traders' listings go live at once", async (t) => {
  const base = await fixture(t, context);
  await query(
    `UPDATE platform_settings SET setting_value = setting_value || '{"autoPublishVerified": true}'::jsonb
     WHERE setting_key = 'marketplace'`,
  );
  const seller = await person();
  const listing = await post(base, seller);
  assert.equal(listing.status, "Active");
  assert.deepEqual(await publicIds(base), [listing.id]);
});

const mine = (base, owner, id, method = "GET", path = "", body) =>
  call(base, `/my-listings/${id}${path}`, { method, headers: owner.headers, body });

test("editing a rejected listing sends it back to review with the reason cleared", async (t) => {
  const base = await fixture(t, context);
  const seller = await person();
  const moderator = await person({ accountRole: "moderator" });
  const listing = await post(base, seller);
  await review(base, moderator, listing.id, "reject", { reason: "Add the grade." });

  const edited = await mine(base, seller, listing.id, "PUT", "", {
    ...offer,
    intent: "buy", // ignored: a listing keeps its intent
    grade: "1",
    quantity: "40 MT",
  });
  assert.equal(edited.status, 200, await edited.clone().text());
  const body = await edited.json();
  assert.equal(body.status, "Pending Review");
  assert.equal(body.grade, "1");
  assert.equal(body.intent, "sell");
  assert.equal(body.review_note, null);
});

test("editing a live listing takes it off the market until approved again", async (t) => {
  const base = await fixture(t, context);
  const seller = await person();
  const moderator = await person({ accountRole: "moderator" });
  const listing = await post(base, seller);
  await review(base, moderator, listing.id, "approve");
  assert.deepEqual(await publicIds(base), [listing.id]);

  const edited = await mine(base, seller, listing.id, "PUT", "", { ...offer, price_amount: 6 });
  assert.equal((await edited.json()).status, "Pending Review");
  assert.deepEqual(await publicIds(base), []);
});

test("drafts stay drafts when edited, and only the owner can change a listing", async (t) => {
  const base = await fixture(t, context);
  const newcomer = await person({ verified: false });
  const other = await person();
  const draft = await post(base, newcomer);

  const edited = await mine(base, newcomer, draft.id, "PUT", "", { ...offer, quantity: "5 MT" });
  assert.equal((await edited.json()).status, "Draft");
  assert.equal((await mine(base, other, draft.id, "PUT", "", offer)).status, 404);
  assert.equal((await mine(base, other, draft.id, "POST", "/close")).status, 404);
  assert.equal((await mine(base, other, draft.id, "DELETE")).status, 404);
  assert.equal((await mine(base, newcomer, draft.id, "PUT", "", { intent: "sell" })).status, 400);
});

test("owners close listings for good, and delete only drafts and rejections", async (t) => {
  const base = await fixture(t, context);
  const seller = await person();
  const moderator = await person({ accountRole: "moderator" });
  const live = await post(base, seller);
  await review(base, moderator, live.id, "approve");

  assert.equal((await mine(base, seller, live.id, "DELETE")).status, 409);
  const closed = await mine(base, seller, live.id, "POST", "/close");
  assert.equal((await closed.json()).status, "Closed");
  assert.deepEqual(await publicIds(base), []);
  assert.equal((await mine(base, seller, live.id, "POST", "/close")).status, 409);
  assert.equal((await mine(base, seller, live.id, "PUT", "", offer)).status, 409);

  const rejected = await post(base, seller);
  await review(base, moderator, rejected.id, "reject", { reason: "Duplicate listing." });
  const deleted = await mine(base, seller, rejected.id, "DELETE");
  assert.deepEqual(await deleted.json(), { id: rejected.id, deleted: true });
  assert.deepEqual(await query("SELECT id FROM listings WHERE id = $1", [rejected.id]), []);
});
