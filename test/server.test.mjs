import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCompletion, RateLimiter, exposesBridgeKey, sessionDriver, runReprobe } from "../src/server.mjs";

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

// ── the whole reprobe, driven against a fake bridge ─────────────────────────
//
// This is the test the earlier version was missing: it asserts the turn and the
// probe read are the SAME Account, which is the thing that was actually wrong.
// `readSnapshot` runs for real against a fake page, so the page is the only
// stand-in.

const FAKE_PAGE = {
  // readSnapshot evaluates twice over: a one-arg origin check, then the two-arg
  // readInPage. Tell them apart by arity rather than by call order.
  evaluate: async (fn, opts) => (opts === undefined ? true : { model: "gpt-5-pro", percent: 7 }),
  goto: async () => {},
};

function reprobeBridge({ turnFails = false, seen = [] } = {}) {
  return {
    credentials: fakeCredentials(),
    browser: {
      withAccount: async (credential, fn) => {
        seen.push(`lease:${credential?.email}`);
        return fn();
      },
      getPage: async (credential) => {
        seen.push(`page:${credential?.email}`);
        return FAKE_PAGE;
      },
    },
    converse: async (id, body, options) => {
      seen.push(`turn:${options.account?.email}`);
      if (turnFails) throw new Error("turn died");
    },
  };
}

test("runReprobe: one Account drives both the turn and the probe read", async () => {
  const seen = [];
  const { found, failure } = await runReprobe({
    bridge: reprobeBridge({ seen }),
    sessionId: "s-1",
    accountEmail: OWNER.email,
    prompt: "ping",
  });
  assert.equal(failure, null);
  assert.equal(found.model, "gpt-5-pro");
  // The owner in all three places, and the primary nowhere — this is what used
  // to break: `turn:owner` followed by `page:primary`.
  assert.deepEqual(seen, [`lease:${OWNER.email}`, `turn:${OWNER.email}`, `page:${OWNER.email}`]);
  assert.equal(seen.some((entry) => entry.includes(PRIMARY.email)), false);
});

test("runReprobe: a failed turn does not read, so no stale Model can be archived", async () => {
  const seen = [];
  const { found, failure } = await runReprobe({
    bridge: reprobeBridge({ turnFails: true, seen }),
    sessionId: "s-1",
    accountEmail: OWNER.email,
    prompt: "ping",
  });
  assert.match(failure, /turn died/);
  assert.equal(found, null);
  assert.equal(seen.some((entry) => entry.startsWith("page:")), false);
});

test("runReprobe: an unusable owner reports the failure and reads nothing", async () => {
  const bridge = reprobeBridge({ seen: [] });
  bridge.credentials.forSession = () => {
    throw Object.assign(new Error("session_account_unavailable"), { status: 409 });
  };
  const { found, failure } = await runReprobe({
    bridge,
    sessionId: "s-1",
    accountEmail: OWNER.email,
    prompt: "ping",
  });
  assert.match(failure, /session_account_unavailable/);
  assert.equal(found, null);
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
