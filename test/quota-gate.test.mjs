// Ticket 10, option A: the quota read's busy check and its queue slot are one
// synchronous step, so a turn can never slip between "looked free" and "took
// the converse page". These tests run the REAL Bridge — constructed with tmp
// paths, then its public `browser` property swapped for a fixed fake — so the
// gate, the real #serialized queue and its counters are all production code.
// No real browser, no network.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Bridge } from "../src/bridge.mjs";

function realBridgeWith({ getPage }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quota-gate-"));
  const bridge = new Bridge({
    config: {
      omniRoot: "",
      chromePath: "",
      proxy: "",
      sessionFile: path.join(dir, "sessions.json"),
      sessionTtlMs: 60_000,
      dataDir: dir,
      mcpEndpointFile: "",
      maxQueue: 10,
    },
    credentials: { forSession: () => ({ email: "acct@test.local" }) },
    recaptcha: {},
  });
  bridge.browser = {
    withAccount: (_account, fn) => fn(),
    // Poisoned on purpose: if the gate lets a call through, the error below is
    // what surfaces — never the busy shape. That is what makes the busy
    // assertions meaningful rather than tautological.
    getPage: getPage ?? (async () => { throw new Error("page-fake-stop"); }),
  };
  return bridge;
}

describe("the quota gate (ticket 10, option A)", () => {
  test("a running turn makes the quota read reject busy, before any page is touched", async () => {
    const bridge = realBridgeWith({});
    bridge.runtime.activeRequests = 1;
    await assert.rejects(
      bridge.quotaSnapshot(),
      (err) => err.status === 409 && err.code === "busy",
    );
  });

  test("queued work makes the quota read reject busy too", async () => {
    const bridge = realBridgeWith({});
    bridge.runtime.queueDepth = 1;
    await assert.rejects(
      bridge.quotaSnapshot(),
      (err) => err.status === 409 && err.code === "busy",
    );
  });

  test("with the queue free, the read proceeds all the way to page acquisition", async () => {
    const bridge = realBridgeWith({});
    await assert.rejects(
      bridge.quotaSnapshot(),
      (err) => err.message === "page-fake-stop",
      "the gate must not reject a free queue",
    );
  });

  test("a second quota read while the first is in flight is rejected — no same-page race", async () => {
    // The first read never finishes (its page promise never settles), so the
    // second one arrives while the queue slot is genuinely held.
    const bridge = realBridgeWith({ getPage: () => new Promise(() => {}) });
    const first = bridge.quotaSnapshot();
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(
      bridge.quotaSnapshot(),
      (err) => err.status === 409 && err.code === "busy",
    );
    // Nothing to await: the first read is abandoned with this throwaway fake.
    void first;
  });
});
