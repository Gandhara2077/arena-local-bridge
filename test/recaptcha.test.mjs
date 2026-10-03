// The token broker mints on a page of its own, and a token is shared by every
// caller. Two requests arriving together used to both drive that one page —
// each navigating while the other was mid-flight — and both paid for a token
// that only one of them could keep.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RecaptchaBroker } from "../src/recaptcha.mjs";

function fakeBrowser({ token = "token-value", fail = false } = {}) {
  const calls = [];
  return {
    calls,
    freshRecaptchaToken: async () => {
      calls.push(1);
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (fail) throw new Error("recaptcha unavailable");
      return token;
    },
  };
}

test("get: concurrent callers share one mint", async () => {
  const browser = fakeBrowser();
  const broker = new RecaptchaBroker({ browser, siteKey: "k" });
  const [first, second] = await Promise.all([broker.get({ email: "a@b" }, true), broker.get({ email: "a@b" }, true)]);
  assert.equal(first, "token-value");
  assert.equal(second, "token-value");
  assert.equal(browser.calls.length, 1, "两次请求只该铸造一次");
});

test("get: a cached token is returned without minting again", async () => {
  const browser = fakeBrowser();
  const broker = new RecaptchaBroker({ browser, siteKey: "k" });
  await broker.get({ email: "a@b" }, true);
  await broker.get({ email: "a@b" });
  assert.equal(browser.calls.length, 1);
});

test("get: the mint is released after a failure, so the next call can retry", async () => {
  const browser = fakeBrowser({ fail: true });
  const broker = new RecaptchaBroker({ browser, siteKey: "k" });
  await assert.rejects(broker.get({ email: "a@b" }, true), /unavailable/);
  await assert.rejects(broker.get({ email: "a@b" }, true), /unavailable/);
  assert.equal(browser.calls.length, 2, "失败不该把后续调用永久挡在门外");
  assert.equal(broker.status().errors, 2);
});

test("forced refresh failure reuses a fresh token but expiry boundary rejects it", async (t) => {
  let now = 1_000;
  t.mock.method(Date, "now", () => now);
  const credential = { email: "synthetic@example.com" };
  const failure = new Error("fixture offline");
  let calls = 0;
  const broker = new RecaptchaBroker({ siteKey: "fixture-key", ttlMs: 1_000, browser: {
    freshRecaptchaToken: async (received, key) => {
      assert.equal(received, credential);
      assert.equal(key, "fixture-key");
      if (++calls > 1) throw failure;
      return "fixture-token";
    },
  } });
  assert.equal(await broker.get(credential), "fixture-token");
  now = 1_500;
  assert.equal(await broker.get(credential, true), "fixture-token");
  assert.deepEqual(broker.status(), { cached: true, ageMs: 500, ttlMs: 1_000, generations: 1, errors: 1, lastError: "fixture offline" });
  now = 2_000;
  assert.equal(broker.isFresh(), false);
  await assert.rejects(broker.get(credential), (error) => error === failure);
  assert.equal(broker.pendingMint, null);
});

test("all concurrent callers share rejection and a subsequent mint succeeds", async () => {
  let rejectMint;
  let calls = 0;
  const failure = new Error("shared failure");
  const broker = new RecaptchaBroker({ siteKey: "k", browser: {
    freshRecaptchaToken: () => ++calls === 1
      ? new Promise((resolve, reject) => { rejectMint = reject; })
      : Promise.resolve("recovered"),
  } });
  const first = broker.get({}, true);
  const second = broker.get({}, true);
  rejectMint(failure);
  const settled = await Promise.allSettled([first, second]);
  assert.ok(settled.every((result) => result.status === "rejected" && result.reason === failure));
  assert.equal(calls, 1);
  assert.equal(broker.status().errors, 1);
  assert.equal(broker.pendingMint, null);
  assert.equal(await broker.get({}, true), "recovered");
  assert.equal(broker.status().lastError, null);
  assert.equal(broker.status().generations, 1);
});
