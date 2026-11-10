import assert from "node:assert/strict";
import test from "node:test";
import { parseTelegramListing } from "../dist/modules/marketplace/index.js";

test("imports a structured coffee offer without the contact number", () => {
  const post = parseTelegramListing(
    "I Want To: Sell\nProduct Name: Export Coffee\nRegion: Sidama\nGrade: 2\nProcess: Washed\nTransaction: Horizontal\nQuantity: 480 Quintal\nDescription: Call 0912345678",
  );
  assert.equal(post.intent, "sell");
  assert.equal(post.region, "Sidama");
  assert.equal(post.grade, "G2");
  assert.equal(post.process, "Washed");
  assert.equal(post.transaction_type, "Horizontal");
  assert.equal(post.quantity, "480 Quintal");
  assert.ok(!post.description.includes("0912345678"));
  assert.ok(post.description.includes("[contact removed]"));
});

test("reads informal buy requests and keeps short numbers", () => {
  const post = parseTelegramListing("Looking for Guji coffee g1 and g-2 unwashed, 20 bags");
  assert.equal(post.intent, "buy");
  assert.equal(post.region, "Guji");
  assert.equal(post.grade, "G1 & G2");
  assert.equal(post.process, "Unwashed");
  assert.equal(post.quantity, null);
  assert.ok(post.description.includes("20 bags"));
});

test("ignores non-coffee chat and coffee chat without a trade intent", () => {
  assert.equal(parseTelegramListing("I have a moisture tester for sale"), null);
  assert.equal(parseTelegramListing("Coffee prices went up today"), null);
});
