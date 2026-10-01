import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCompletion, RateLimiter, exposesBridgeKey, runReprobe, runFingerprintReprobe, extractCompletionText } from "../src/server.mjs";
import { appendRecord } from "../src/fingerprint/bank-store.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A Session's Model may only ever be attributed through its OWN Account. The
// pool also has a default pick, and the two are routinely different Accounts —
// substituting it is how a reprobe once ran its turn as the owner and then read
// the probe (and wrote the Model) as somebody else.
const PRIMARY = { email: "primary@example.com", cookieHeader: "arena-auth-prod-v1=p" };
const OWNER = { email: "owner@example.com", cookieHeader: "arena-auth-prod-v1=o" };

// Mirrors CredentialStore.forSession: an owner wins, an owner-less (legacy)
// Session falls back to the primary, and an unusable owner throws. The fake
// keeps that shape on purpose — the policy itself is tested against the real
// store in test/credentials.test.mjs.
function fakeCredentials({ ownerUsable = true } = {}) {
  return {
    primary: () => PRIMARY,
    forSession: (email) => {
      const owner = String(email || "").trim();
      if (!owner) return PRIMARY;
      if (!ownerUsable) throw Object.assign(new Error("session_account_unavailable"), { status: 409 });
      return owner === OWNER.email ? OWNER : PRIMARY;
    },
  };
}

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

test("runReprobe: an owner-less (legacy) Session uses the primary for BOTH steps", async () => {
  // 记录.json entries written before the Email column have no owner. The turn
  // and the probe read must still agree — falling back to the primary in one
  // step while the other ran against an empty account is the same mismatch that
  // made the reprobe attribute the wrong Model.
  const seen = [];
  const { found, failure } = await runReprobe({
    bridge: reprobeBridge({ seen }),
    sessionId: "s-legacy",
    accountEmail: "",
    prompt: "ping",
  });
  assert.equal(failure, null);
  assert.equal(found.model, "gpt-5-pro");
  assert.deepEqual(seen, [`lease:${PRIMARY.email}`, `turn:${PRIMARY.email}`, `page:${PRIMARY.email}`]);
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

// ── the fingerprint reprobe ─────────────────────────────────────────────────
//
// The probe-based reprobe above is kept, but the route it depends on is closed
// on current Arena. This path is the one that still produces an answer, so what
// matters here is not that it runs a turn — it is that it writes NOTHING unless
// the attribution cleared its gate.

const REPLY_FOR = (base, salt = 0, count = 240) =>
  Array.from({ length: count }, (_, i) => {
    const jitter = ((i * 37 + salt * 53) % 60) - 30;
    return Math.min(355, Math.max(1, base + jitter));
  }).join(" ");

const FLAT_REPLY = Array.from({ length: 240 }, (_, i) => (i % 355) + 1).join(" ");

/** A throwaway data dir holding a two-model, two-variant bank. */
function seededBankDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arena-fpreprobe-"));
  for (const [model, base] of [["m1", 70], ["m2", 270]]) {
    for (const variant of ["v1-instant", "v2-gut"]) {
      for (let rep = 0; rep < 3; rep++) {
        appendRecord(dir, { text: REPLY_FOR(base, rep), model, variant, requestedCount: 240 });
      }
    }
  }
  return dir;
}

/** A bridge whose converse returns `reply` and records which Account it used. */
function fingerprintBridge(reply, { seen = [], turnFails = false } = {}) {
  return {
    credentials: fakeCredentials(),
    browser: {
      withAccount: async (credential, fn) => {
        seen.push(`lease:${credential?.email}`);
        return fn();
      },
    },
    converse: async (id, body, options) => {
      seen.push(`turn:${options.account?.email}:${options.purpose}`);
      if (turnFails) throw new Error("turn died");
      return { choices: [{ message: { role: "assistant", content: reply } }] };
    },
  };
}

test("runFingerprintReprobe: the turn runs as the Session's owner, by its own purpose", async () => {
  const seen = [];
  const { outcome, failure } = await runFingerprintReprobe({
    bridge: fingerprintBridge(REPLY_FOR(70, 99), { seen }),
    sessionId: "s-1",
    accountEmail: OWNER.email,
    dataDir: seededBankDir(),
    variant: "v1-instant",
  });
  assert.equal(failure, null);
  assert.equal(outcome.status, "attributed");
  assert.equal(outcome.model, "m1");
  assert.deepEqual(seen, [`lease:${OWNER.email}`, `turn:${OWNER.email}:fingerprint`]);
});

test("runFingerprintReprobe: a reply matching nothing comes back unresolved with a near miss", async () => {
  const { outcome, failure } = await runFingerprintReprobe({
    bridge: fingerprintBridge(FLAT_REPLY),
    sessionId: "s-1",
    accountEmail: OWNER.email,
    dataDir: seededBankDir(),
    variant: "v1-instant",
  });
  assert.equal(failure, null);
  assert.equal(outcome.status, "unresolved");
  assert.equal(outcome.model, null, "an unresolved reprobe must not name a model");
  assert.ok(outcome.nearMiss);
});

test("runFingerprintReprobe: no bank means no turn is spent", async () => {
  const seen = [];
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "arena-fpempty-"));
  const { outcome, failure } = await runFingerprintReprobe({
    bridge: fingerprintBridge(REPLY_FOR(70), { seen }),
    sessionId: "s-1",
    accountEmail: OWNER.email,
    dataDir: empty,
    variant: "v1-instant",
  });
  assert.equal(failure, null);
  assert.equal(outcome.status, "failed");
  // The Account lease is context acquisition, not a turn; what must not happen
  // is a probe turn being sent to Arena to prove something we cannot use.
  assert.equal(seen.some((entry) => entry.startsWith("turn:")), false, `no turn expected, saw ${seen.join(", ")}`);
});

test("runFingerprintReprobe: a dead turn is reported, not thrown", async () => {
  const { outcome, failure } = await runFingerprintReprobe({
    bridge: fingerprintBridge("", { turnFails: true }),
    sessionId: "s-1",
    accountEmail: OWNER.email,
    dataDir: seededBankDir(),
    variant: "v1-instant",
  });
  assert.equal(outcome, null);
  assert.match(failure, /turn died/);
});

test("extractCompletionText reads the assistant text and tolerates everything else", () => {
  assert.equal(extractCompletionText({ choices: [{ message: { content: "42" } }] }), "42");
  assert.equal(extractCompletionText({ choices: [{ message: { content: null } }] }), "");
  assert.equal(extractCompletionText({}), "");
  assert.equal(extractCompletionText(null), "");
});
