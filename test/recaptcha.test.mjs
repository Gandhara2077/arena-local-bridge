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
