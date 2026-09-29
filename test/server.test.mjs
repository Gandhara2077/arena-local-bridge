import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCompletion, RateLimiter, exposesBridgeKey, sessionDriver } from "../src/server.mjs";

// A Session's Model may only ever be attributed through its OWN Account. The
// pool also has a default pick, and the two are routinely different Accounts —
// substituting it is how a reprobe once ran its turn as the owner and then read
// the probe (and wrote the Model) as somebody else.
const PRIMARY = { email: "primary@example.com", cookieHeader: "arena-auth-prod-v1=p" };
const OWNER = { email: "owner@example.com", cookieHeader: "arena-auth-prod-v1=o" };

function fakeCredentials({ ownerUsable = true } = {}) {
  return {
    primary: () => PRIMARY,
    forSession: (email) => {
      if (!ownerUsable) throw Object.assign(new Error("session_account_unavailable"), { status: 409 });
      return email === OWNER.email ? OWNER : null;
    },
  };
}

test("sessionDriver: drives by the Session's owner, never the pool's primary", () => {
  const driver = sessionDriver(fakeCredentials(), OWNER.email);
  assert.equal(driver, OWNER);
  assert.notEqual(driver, PRIMARY);
});

test("sessionDriver: an unknown owner is null, not the primary", () => {
  assert.equal(sessionDriver(fakeCredentials(), ""), null);
  assert.equal(sessionDriver(fakeCredentials(), undefined), null);
  assert.equal(sessionDriver(fakeCredentials(), "   "), null);
});

test("sessionDriver: an unusable owner surfaces its 409 instead of degrading", () => {
  // Falling back to the primary here would turn "this Session has no usable
  // Account" into "attribute some other Account's Model to it".
  assert.throws(() => sessionDriver(fakeCredentials({ ownerUsable: false }), OWNER.email), /session_account_unavailable/);
});

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

// /api/status returns the bridge key. That is fine while only this machine can
// reach us, and not fine the moment HOST is pointed somewhere else, because the
// Host check is then spoofable. See ADR 0004.
test("exposesBridgeKey: only while the listener is loopback", () => {
  assert.equal(exposesBridgeKey({ host: "127.0.0.1" }), true);
  assert.equal(exposesBridgeKey({ host: "localhost" }), true);
  assert.equal(exposesBridgeKey({ host: "::1" }), true);
  assert.equal(exposesBridgeKey({ host: "0.0.0.0" }), false);
  assert.equal(exposesBridgeKey({ host: "192.168.1.5" }), false);
  assert.equal(exposesBridgeKey({ host: "" }), false);
  assert.equal(exposesBridgeKey({}), false);
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
