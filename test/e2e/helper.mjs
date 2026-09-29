// E2E helper: a REAL http server (createServer from src/server.mjs) on an
// ephemeral loopback port, driven over REAL HTTP — with the bridge swapped for
// a programmable fake. Zero Playwright, zero network beyond loopback, zero
// credentials. The fake records every call so assertions can check what the
// HTTP layer actually handed the bridge, not just what it answered.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "../../src/server.mjs";

export const SESSION_ID = "11111111-2222-4333-8444-555555555555";
export const BRIDGE_KEY = "e2e-bridge-key";

export function createFakeBridge(overrides = {}) {
  const bridge = {
    calls: { converse: [], runAgent: [] },
    runtime: {
      requests: 0, errors: 0, completed: 0, lastLatencyMs: 0, totalLatencyMs: 0,
      lastSuccessAt: null, lastErrorAt: null, lastErrorType: null,
      toolResponses: 0, textResponses: 0,
    },
    healthPayload: () => ({ ok: true, version: "e2e" }),
    prometheusMetrics: () => "# HELP e2e no-op\n",
    credentials: {
      list: () => [{ email: "acct@test.local", label: "e2e" }],
      primary: () => ({ email: "acct@test.local" }),
      forSession: (email) => ({ email: email || "acct@test.local" }),
    },
    converse: async (sessionId, body, opts = {}) => {
      bridge.calls.converse.push({ sessionId, body, opts });
      return {
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
    },
    runAgent: async (body, headers) => {
      bridge.calls.runAgent.push({ body, headers });
      return {
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "agent" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
    },
    quotaSnapshot: async () => ({ email: "acct@test.local", percent: 42, percentSource: "e2e", usdStatus: "ok" }),
    recaptcha: { get: async () => "e2e-recaptcha-token" },
    browser: { withAccount: async (_account, fn) => fn() },
    ...overrides,
  };
  return bridge;
}

export async function startE2E({ config: configOverrides = {}, bridge: bridgeOverrides = {} } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "bridge-e2e-"));
  const dataDir = path.join(dir, "data");
  const archiveDir = path.join(dir, "archive");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(archiveDir, { recursive: true });
  // One archived session, owned by one account — the shape readArchiveSessions,
  // sessionAccountEmail and /v1/models all consume.
  fs.writeFileSync(
    path.join(archiveDir, "记录.json"),
    JSON.stringify([{ Url: `https://arena.ai/agent/${SESSION_ID}`, Model: "E2E Model", Title: "e2e", Email: "acct@test.local" }]),
    "utf8"
  );
  const config = {
    host: "127.0.0.1",
    port: 0,
    bridgeKey: BRIDGE_KEY,
    rateLimitRpm: 10_000,
    dataDir,
    archiveDir,
    agentdockDir: path.join(dir, "agentdock"),
    mcpEndpointFile: path.join(dataDir, "mcp-endpoint.json"),
    arenaSessions: "",
    ...configOverrides,
  };
  const bridge = createFakeBridge(bridgeOverrides);
  const server = createServer({ bridge, config });
  // A non-loopback config.host must not change where we actually listen: the
  // test only needs the LOGIC to see a foreign host, not the socket.
  const bindHost = configOverrides.bindHost || config.host;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, bindHost === "0.0.0.0" ? "127.0.0.1" : bindHost, resolve);
  });
  const port = server.address().port;
  config.port = port;
  return {
    bridge,
    config,
    port,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** One real HTTP request, with full control over every header (fetch hides Host). */
export function httpRequest(port, { method = "GET", reqPath = "/", headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path: reqPath, headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let jsonBody = null;
          try { jsonBody = JSON.parse(text); } catch { /* SSE or text */ }
          resolve({ status: res.statusCode, headers: res.headers, text, json: jsonBody });
        });
      }
    );
    req.on("error", reject);
    if (body !== null) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

export function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${BRIDGE_KEY}`, ...extra };
}

/** Wait until `cond()` is true (the server runs on its own clock), or throw. */
export async function waitFor(cond, ms = 2_000) {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor: condition never became true");
    await new Promise((r) => setTimeout(r, 10));
  }
}
