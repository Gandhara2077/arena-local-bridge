import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCompletion, RateLimiter } from "../src/server.mjs";

test("validateCompletion accepts a valid request", () => {
  const err = validateCompletion({ model: "agent", messages: [{ role: "user", content: "hi" }], tools: [] });
  assert.equal(err, null);
});

test("validateCompletion rejects missing/invalid messages", () => {
  assert.ok(validateCompletion({}));
  assert.ok(validateCompletion({ messages: [] }));
  assert.ok(validateCompletion({ messages: [{ role: "bogus", content: "x" }] }));
  assert.ok(validateCompletion({ messages: "nope" }));
});

test("validateCompletion rejects non-array tools", () => {
  assert.ok(validateCompletion({ messages: [{ role: "user", content: "x" }], tools: "nope" }));
  assert.equal(validateCompletion({ messages: [{ role: "user", content: "x" }], tools: [] }), null);
});

test("RateLimiter allows up to rpm then blocks with retryAfter", () => {
  const limiter = new RateLimiter(3);
  const now = 1_000_000;
  assert.equal(limiter.allow("k", now).allowed, true);
  assert.equal(limiter.allow("k", now).allowed, true);
  assert.equal(limiter.allow("k", now).allowed, true);
  const blocked = limiter.allow("k", now);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfter >= 1);
  // window resets
  assert.equal(limiter.allow("k", now + 61_000).allowed, true);
});
