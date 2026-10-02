/**
 * The archive WRITE GATE, driven through the real HTTP endpoint.
 *
 * The unit tests around runFingerprintReprobe check the three outcomes, but the
 * decision that actually protects the archive — write on `attributed`, write
 * nothing on anything else — lives in the request handler. Testing the function
 * below it cannot see that decision, so this drives createServer for real and
 * inspects 记录.json afterwards.
 *
 * `记录.json` is the source of truth for every downstream reader, so a wrong
 * write here is the one failure that is not self-correcting.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "../src/server.mjs";
import { appendRecord } from "../src/fingerprint/bank-store.mjs";
import { readEntries } from "../src/archive.mjs";
import { readStore } from "../src/fingerprint/bank-store.mjs";

const OWNER = { email: "owner@example.com", cookieHeader: "arena-auth-prod-v1=o" };
const SESSION = "44444444-4444-4444-8444-444444444444";
const BRIDGE_KEY = "test-bridge-key";

const REPLY_FOR = (base, salt = 0, count = 240) =>
  Array.from({ length: count }, (_, i) => {
    const jitter = ((i * 37 + salt * 53) % 60) - 30;
    return Math.min(355, Math.max(1, base + jitter));
  }).join(" ");

const FLAT_REPLY = Array.from({ length: 240 }, (_, i) => (i % 355) + 1).join(" ");

/**
 * A scratch workspace: a two-model bank, and an archive whose one Session is
 * 未识别 — the state a 补标 is meant to fix.
 */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arena-fpgate-"));
  const dataDir = path.join(root, "data");
  const archiveDir = path.join(root, "archive");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(archiveDir, { recursive: true });

  for (const [model, base] of [["m1", 70], ["m2", 270]]) {
    for (const variant of ["v1-instant", "v2-gut"]) {
      for (let rep = 0; rep < 3; rep++) {
        appendRecord(dataDir, { text: REPLY_FOR(base, rep), model, variant, requestedCount: 240 });
      }
    }
  }

  fs.writeFileSync(
    path.join(archiveDir, "记录.json"),
    JSON.stringify([
      {
        Model: "未识别",
        Title: "未识别 · 10-01 11:00",
        Url: `https://arena.ai/agent/${SESSION}`,
        Email: OWNER.email,
        ModelFolder: "未识别（未捕获本轮 run 令牌，探针仍停留在上一轮）",
      },
    ]),
    "utf8"
  );
  return { root, dataDir, archiveDir };
}

/** Start a real server on an ephemeral port and return a request helper. */
async function withServer({ dataDir, archiveDir }, reply, fn) {
  const seen = [];
  const bridge = {
    credentials: {
      primary: () => OWNER,
      forSession: () => OWNER,
      list: () => [OWNER],
    },
    browser: {
      withAccount: async (credential, action) => {
        seen.push(`lease:${credential?.email}`);
        return action();
      },
    },
    converse: async (id, body, options) => {
      seen.push(`turn:${options?.purpose}`);
      return { choices: [{ message: { role: "assistant", content: reply } }] };
    },
  };
  const config = {
    host: "127.0.0.1",
    port: 0,
    bridgeKey: BRIDGE_KEY,
    dataDir,
    archiveDir,
    rateLimitRpm: 600,
    agentdockDir: path.join(dataDir, "agentdock"),
    mcpEndpointFile: path.join(dataDir, "mcp-endpoint.json"),
    arenaSessions: "",
  };
  const server = createServer({ bridge, config });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const post = (body) =>
    fetch(`http://127.0.0.1:${port}/api/pool/fingerprint-reprobe`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${BRIDGE_KEY}` },
      body: JSON.stringify(body),
    });
  try {
    return await fn({ post, seen, port });
  } finally {
    // fetch keeps the connection alive, and a server with a live keep-alive
    // socket will not close — so drop the sockets first. closeAllConnections
    // is Node 18.2+; the fallback keeps this working on an older runtime.
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

const modelOf = (archiveDir) => readEntries(archiveDir)[0]?.Model;

test("a cleared attribution writes the Model into 记录.json", async () => {
  const fx = fixture();
  await withServer(fx, REPLY_FOR(70, 99), async ({ post }) => {
    const res = await post({ sessionId: SESSION });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.model, "m1");
    assert.equal(body.updated, true);
  });
  assert.equal(modelOf(fx.archiveDir), "m1");
});

test("an unresolved attribution leaves 记录.json UNTOUCHED", async () => {
  const fx = fixture();
  await withServer(fx, FLAT_REPLY, async ({ post }) => {
    const res = await post({ sessionId: SESSION });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, false);
    assert.equal(body.unresolved, true);
    assert.equal(body.nearMiss !== undefined, true, "a near miss should be reported");
  });
  assert.equal(modelOf(fx.archiveDir), "未识别", "an unresolved result must not write a model");
});

test("a failed attribution leaves 记录.json UNTOUCHED", async () => {
  const fx = fixture();
  await withServer(fx, "1 2 3 4 5", async ({ post }) => {
    const res = await post({ sessionId: SESSION });
    assert.equal((await res.json()).unresolved, true);
  });
  assert.equal(modelOf(fx.archiveDir), "未识别");
});

test("dryRun reports an attribution without writing it", async () => {
  const fx = fixture();
  const before = readStore(fx.dataDir).records.length;
  await withServer(fx, REPLY_FOR(70, 99), async ({ post }) => {
    const res = await post({ sessionId: SESSION, dryRun: true });
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.model, "m1");
    assert.equal(body.dryRun, true);
    assert.equal(body.updated, false);
  });
  assert.equal(modelOf(fx.archiveDir), "未识别", "a dry run must not write");
  // A dry run must also leave the bank alone. Growing it from an experiment
  // would slowly contaminate the very data the next attribution is made from.
  assert.equal(readStore(fx.dataDir).records.length, before, "a dry run must not add a bank record");
});

test("an unknown probe variant is rejected before any turn runs", async () => {
  const fx = fixture();
  await withServer(fx, REPLY_FOR(70), async ({ post, seen }) => {
    const res = await post({ sessionId: SESSION, variant: "nope" });
    assert.equal(res.status, 400);
    assert.equal(seen.some((e) => e.startsWith("turn:")), false);
  });
});

test("a non-UUID sessionId is rejected", async () => {
  const fx = fixture();
  await withServer(fx, REPLY_FOR(70), async ({ post }) => {
    const res = await post({ sessionId: "not-a-uuid" });
    assert.equal(res.status, 400);
  });
});

test("pool actions reject non-object JSON bodies without rereading the request", async () => {
  const fx = fixture();
  const before = readStore(fx.dataDir).records.length;
  await withServer(fx, REPLY_FOR(70), async ({ port, seen }) => {
    for (const action of ["fingerprint-reprobe", "reprobe", "verify"]) {
      for (const body of [null, [], 17, "invalid"]) {
        const res = await fetch(`http://127.0.0.1:${port}/api/pool/${action}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${BRIDGE_KEY}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(5000),
        });
        assert.equal(res.status, 400, `${action}: ${JSON.stringify(body)}`);
        assert.match((await res.json()).error.message, /JSON object/);
      }
    }
    assert.equal(seen.length, 0, "invalid input must not start an Arena turn");
  });
  assert.equal(modelOf(fx.archiveDir), "未识别");
  assert.equal(readStore(fx.dataDir).records.length, before);
});

test("the route is keyed like every other operator action", async () => {
  const fx = fixture();
  await withServer(fx, REPLY_FOR(70), async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/pool/fingerprint-reprobe`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong" },
      body: JSON.stringify({ sessionId: SESSION }),
    });
    assert.equal(res.status, 401);
  });
  assert.equal(modelOf(fx.archiveDir), "未识别");
});

test("the status endpoint reports the bank without spending a turn", async () => {
  const fx = fixture();
  await withServer(fx, REPLY_FOR(70), async ({ seen, port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/fingerprint/status`, {
      headers: { authorization: `Bearer ${BRIDGE_KEY}` },
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ready, true);
    assert.deepEqual(body.modelIds, ["m1", "m2"]);
    assert.equal(seen.length, 0, "reading the bank status must not touch the browser");
  });
});
