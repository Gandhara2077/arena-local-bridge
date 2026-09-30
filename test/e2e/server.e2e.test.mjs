// E2E over REAL HTTP: real createServer, real sockets, real framing — the
// bridge is a programmable fake (see ./helper.mjs). These tests cover the one
// layer nothing else touches: routing and its order, auth, the loopback
// defense, OpenAI response shapes, SSE framing, validation and error shapes,
// rate limiting, and the busy-409 window. They assert PROTOCOL and system
// behavior, never model intelligence.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { VERSION } from "../../src/version.mjs";
import { startE2E, httpRequest, authHeaders, waitFor, BRIDGE_KEY, SESSION_ID } from "./helper.mjs";

const CHAT = { method: "POST", reqPath: "/v1/chat/completions" };
const chatBody = (extra = {}) => ({
  model: SESSION_ID,
  messages: [{ role: "user", content: "hi" }],
  ...extra,
});

describe("open edges (no key required)", () => {
  test("/health answers without a key and leaks no secret", async () => {
    const e2e = await startE2E();
    try {
      const res = await httpRequest(e2e.port, { reqPath: "/health" });
      assert.equal(res.status, 200);
      assert.equal(res.json.ok, true);
      assert.ok(Array.isArray(res.json.accounts));
      assert.equal(res.json.accounts[0].email, "acct@test.local");
      assert.equal(res.json.accounts[0].quota, null, "a fresh pool state has no cached reading yet");
      assert.equal(res.json.bridgeKey, undefined);
      assert.equal(res.json.apiKey, undefined);
    } finally { await e2e.close(); }
  });

  test("the GUI page is served without a key", async () => {
    const e2e = await startE2E();
    try {
      const res = await httpRequest(e2e.port, { reqPath: "/" });
      assert.equal(res.status, 200);
      assert.match(res.headers["content-type"], /text\/html/);
    } finally { await e2e.close(); }
  });
});

describe("the loopback defense", () => {
  test("a foreign Host header is rejected before anything else", async () => {
    const e2e = await startE2E();
    try {
      const res = await httpRequest(e2e.port, {
        reqPath: "/health",
        headers: { Host: "attacker.example" },
      });
      assert.equal(res.status, 403);
    } finally { await e2e.close(); }
  });

  test("a local Host with a foreign Origin is rejected too", async () => {
    const e2e = await startE2E();
    try {
      const res = await httpRequest(e2e.port, {
        reqPath: "/health",
        headers: { Host: `127.0.0.1:${e2e.port}`, Origin: "https://attacker.example" },
      });
      assert.equal(res.status, 403);
    } finally { await e2e.close(); }
  });

  test("/api/status hands out the key only while the bind is loopback", async () => {
    const local = await startE2E();
    try {
      const res = await httpRequest(local.port, { reqPath: "/api/status", headers: authHeaders() });
      assert.equal(res.status, 200);
      assert.equal(res.json.apiKey, BRIDGE_KEY);
    } finally { await local.close(); }

    const foreign = await startE2E({ config: { host: "0.0.0.0", bindHost: "127.0.0.1" } });
    try {
      const res = await httpRequest(foreign.port, { reqPath: "/api/status", headers: authHeaders() });
      assert.equal(res.status, 200);
      assert.equal(res.json.apiKey, "", "a non-loopback HOST can be spoofed — the key must not travel");
    } finally { await foreign.close(); }
  });
});

describe("bridge key auth", () => {
  test("keyed routes reject a missing or wrong key", async () => {
    const e2e = await startE2E();
    try {
      const missing = await httpRequest(e2e.port, { reqPath: "/v1/models" });
      assert.equal(missing.status, 401);
      assert.equal(missing.json.error.message, "Invalid bridge key");
      const wrong = await httpRequest(e2e.port, { reqPath: "/v1/models", headers: { Authorization: "Bearer nope" } });
      assert.equal(wrong.status, 401);
    } finally { await e2e.close(); }
  });

  test("/v1/models lists the archived session plus the ping probe", async () => {
    const e2e = await startE2E();
    try {
      const res = await httpRequest(e2e.port, { reqPath: "/v1/models", headers: authHeaders() });
      assert.equal(res.status, 200);
      assert.equal(res.json.object, "list");
      const ids = res.json.data.map((m) => m.id);
      assert.ok(ids.includes(SESSION_ID));
      assert.ok(ids.includes("ping"));
    } finally { await e2e.close(); }
  });
});

describe("POST /v1/chat/completions — non-streaming", () => {
  test("a UUID model routes to converse with the session id, headers included", async () => {
    const e2e = await startE2E();
    try {
      const res = await httpRequest(e2e.port, {
        ...CHAT,
        headers: authHeaders({ "x-arena-idempotency-key": "e2e-key-1" }),
        body: chatBody(),
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.object, "chat.completion");
      assert.equal(res.json.choices[0].message.role, "assistant");
      assert.ok(res.json.usage);
      assert.ok(res.headers["x-arena-bridge-request-id"]);
      assert.equal(res.headers["x-arena-bridge-version"], VERSION);

      assert.equal(e2e.bridge.calls.converse.length, 1);
      const call = e2e.bridge.calls.converse[0];
      assert.equal(call.sessionId, SESSION_ID);
      assert.deepEqual(call.body.messages, [{ role: "user", content: "hi" }]);
      // The HTTP layer's one idempotency duty: hand the header to the bridge
      // intact. (Deduping itself lives in the bridge and is unit-tested there.)
      assert.equal(call.opts.headers["x-arena-idempotency-key"], "e2e-key-1");
      assert.equal(call.opts.headers.authorization, `Bearer ${BRIDGE_KEY}`);
    } finally { await e2e.close(); }
  });

  test("a bridge failure surfaces error.status, the code and a request_id", async () => {
    const e2e = await startE2E({
      bridge: {
        converse: async () => {
          throw Object.assign(new Error("session gone"), { status: 503, code: "session_gone" });
        },
      },
    });
    try {
      const res = await httpRequest(e2e.port, { ...CHAT, headers: authHeaders(), body: chatBody() });
      assert.equal(res.status, 503);
      assert.equal(res.json.error.type, "arena_agent_error");
      assert.equal(res.json.error.code, "session_gone");
      assert.ok(res.json.error.request_id);
    } finally { await e2e.close(); }
  });

  test("a bridge failure without a status falls back to 502", async () => {
    const e2e = await startE2E({ bridge: { converse: async () => { throw new Error("boom"); } } });
    try {
      const res = await httpRequest(e2e.port, { ...CHAT, headers: authHeaders(), body: chatBody() });
      assert.equal(res.status, 502);
      assert.equal(res.json.error.message, "boom");
    } finally { await e2e.close(); }
  });

  test("no active session is an actionable 409, not a silent fallback", async () => {
    const e2e = await startE2E();
    try {
      const res = await httpRequest(e2e.port, {
        ...CHAT,
        headers: authHeaders(),
        body: { messages: [{ role: "user", content: "hi" }] },
      });
      assert.equal(res.status, 409);
      assert.equal(res.json.error.code, "no_active_session");
      assert.equal(e2e.bridge.calls.runAgent.length, 0, "it must never fall through to session creation");
    } finally { await e2e.close(); }
  });

  test("a non-UUID model falls through to the legacy runAgent flow", async () => {
    const e2e = await startE2E();
    try {
      const res = await httpRequest(e2e.port, {
        ...CHAT,
        headers: authHeaders(),
        body: chatBody({ model: "agent" }),
      });
      assert.equal(res.status, 200);
      assert.equal(e2e.bridge.calls.runAgent.length, 1);
      assert.equal(e2e.bridge.calls.converse.length, 0);
    } finally { await e2e.close(); }
  });
});

describe("POST /v1/chat/completions — streaming (SSE)", () => {
  test("the stream opens immediately, carries deltas, and closes with [DONE]", async () => {
    const e2e = await startE2E({
      bridge: {
        converse: async (_sid, _body, opts = {}) => {
          // Simulate the bridge pushing a delta out of the page mid-turn.
          if (opts.onDelta) opts.onDelta("partial ");
          return {
            object: "chat.completion",
            choices: [{ index: 0, message: { role: "assistant", content: "partial answer" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          };
        },
      },
    });
    try {
      const res = await httpRequest(e2e.port, {
        ...CHAT,
        headers: authHeaders(),
        body: chatBody({ stream: true }),
      });
      assert.equal(res.status, 200);
      assert.match(res.headers["content-type"], /text\/event-stream/);
      const frames = res.text.split("\n\n").filter((f) => f.startsWith("data: "));
      const events = frames
        .filter((f) => f !== "data: [DONE]")
        .map((f) => JSON.parse(f.slice(6)));
      assert.equal(events[0].choices[0].delta.role, "assistant", "first frame is a valid chunk, not a comment");
      const contents = events.map((e) => e.choices[0].delta.content).filter(Boolean);
      assert.ok(contents.includes("partial "), "a mid-turn push reaches the client as its own chunk");
      const finish = events.find((e) => e.choices[0].finish_reason);
      assert.equal(finish.choices[0].finish_reason, "stop");
      assert.equal(frames.at(-1), "data: [DONE]", "the last data frame is the bare [DONE] sentinel");
      assert.ok(res.text.endsWith("data: [DONE]\n\n"));
    } finally { await e2e.close(); }
  });
});

describe("validation and error shapes", () => {
  test("an invalid body is a 400 with the OpenAI error shape and a request_id", async () => {
    const e2e = await startE2E();
    try {
      const res = await httpRequest(e2e.port, {
        ...CHAT,
        headers: authHeaders(),
        body: { model: SESSION_ID, messages: [] },
      });
      assert.equal(res.status, 400);
      assert.equal(res.json.error.type, "invalid_request_error");
      assert.ok(res.json.error.request_id);
    } finally { await e2e.close(); }
  });

  test("unparseable JSON is a 400, not a crash", async () => {
    const e2e = await startE2E();
    try {
      const res = await httpRequest(e2e.port, {
        ...CHAT,
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: "{not json",
      });
      assert.equal(res.status, 400);
      assert.ok(res.json.error.message);
    } finally { await e2e.close(); }
  });

  test("a wrong route is a self-documenting 404", async () => {
    const e2e = await startE2E();
    try {
      const res = await httpRequest(e2e.port, { method: "GET", reqPath: "/v1/chat/completions", headers: authHeaders() });
      assert.equal(res.status, 404);
      assert.equal(res.json.error.method, "GET");
      assert.equal(res.json.error.path, "/v1/chat/completions");
      assert.match(res.json.error.hint, /POST/);
    } finally { await e2e.close(); }
  });

  test("the rate limiter answers 429 with Retry-After on the real route", async () => {
    const e2e = await startE2E({ config: { rateLimitRpm: 1 } });
    try {
      const first = await httpRequest(e2e.port, { ...CHAT, headers: authHeaders(), body: chatBody() });
      assert.equal(first.status, 200);
      const second = await httpRequest(e2e.port, { ...CHAT, headers: authHeaders(), body: chatBody() });
      assert.equal(second.status, 429);
      assert.equal(second.json.error.type, "rate_limited");
      assert.ok(Number(second.headers["retry-after"]) > 0);
    } finally { await e2e.close(); }
  });
});

describe("operator endpoints over real HTTP", () => {
  test("/api/pool/verify drives one turn; a second while it runs is 409 busy", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const e2e = await startE2E({
      bridge: {
        converse: async (sessionId, body, opts) => {
          e2e.bridge.calls.converse.push({ sessionId, body, opts });
          await gate;
          return {
            choices: [{ message: { role: "assistant", content: "OK" } }],
          };
        },
      },
    });
    try {
      const first = httpRequest(e2e.port, {
        method: "POST", reqPath: "/api/pool/verify",
        headers: authHeaders(), body: { sessionId: SESSION_ID },
      });
      await waitFor(() => e2e.bridge.calls.converse.length === 1);
      const second = await httpRequest(e2e.port, {
        method: "POST", reqPath: "/api/pool/verify",
        headers: authHeaders(), body: { sessionId: SESSION_ID },
      });
      assert.equal(second.status, 409);
      assert.equal(second.json.error.code, "busy");
      release();
      const done = await first;
      assert.equal(done.status, 200);
      assert.equal(done.json.alive, true);
      assert.equal(done.json.sessionId, SESSION_ID);
    } finally { await e2e.close(); }
  });

  test("/api/account/quota records the reading into pool state", async () => {
    const e2e = await startE2E();
    try {
      const res = await httpRequest(e2e.port, {
        method: "POST", reqPath: "/api/account/quota", headers: authHeaders(), body: {},
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.email, "acct@test.local");
      assert.equal(res.json.percent, 42);
      assert.ok(
        existsSync(path.join(e2e.config.dataDir, "pool-state.json")),
        "the cached reading must survive a restart",
      );
    } finally { await e2e.close(); }
  });

  test("a busy rejection from the bridge's own gate surfaces as 409, not 500", async () => {
    const e2e = await startE2E({
      bridge: {
        quotaSnapshot: async () => {
          throw Object.assign(new Error("A turn is in flight; retry when it finishes."), {
            status: 409,
            code: "busy",
          });
        },
      },
    });
    try {
      const res = await httpRequest(e2e.port, {
        method: "POST", reqPath: "/api/account/quota", headers: authHeaders(), body: {},
      });
      assert.equal(res.status, 409);
      assert.equal(res.json.error.code, "busy");
    } finally { await e2e.close(); }
  });
});

describe("POST /api/mcp/reinject — the manual entry for a session whose workspace arrived late", () => {
  // Nothing is injected by the call itself: it ARMS the next real turn, which
  // is the only thing that carries the preamble to the model.
  const outcome = { injected: false, pending: true, reason: "armed: the next turn re-injects", workspace: "/w", workspaceFrom: "request-header" };

  test("it defaults to the active session and returns what happened", async (t) => {
    const calls = [];
    const ctx = await startE2E({ bridge: { reinjectLocalCapability: async (sessionId, headers) => { calls.push({ sessionId, headers }); return outcome; } } });
    t.after(() => ctx.close());
    await httpRequest(ctx.port, { method: "POST", reqPath: "/api/active-session", headers: authHeaders({ "Content-Type": "application/json" }), body: { sessionId: SESSION_ID } });
    const res = await httpRequest(ctx.port, { method: "POST", reqPath: "/api/mcp/reinject", headers: authHeaders({ "Content-Type": "application/json" }), body: {} });
    assert.equal(res.status, 200);
    assert.deepEqual(calls.map((c) => c.sessionId), [SESSION_ID]);
    assert.equal(res.json.sessionId, SESSION_ID);
    assert.equal(res.json.pending, true);
    assert.equal(res.json.workspace, "/w");
    assert.equal(res.json.hint, "");
  });

  test("the x-arena-workspace header is forwarded — it is the documented contract", async (t) => {
    const calls = [];
    const ctx = await startE2E({ bridge: { reinjectLocalCapability: async (sessionId, headers) => { calls.push({ sessionId, headers }); return outcome; } } });
    t.after(() => ctx.close());
    await httpRequest(ctx.port, {
      method: "POST",
      reqPath: "/api/mcp/reinject",
      headers: authHeaders({ "Content-Type": "application/json", "x-arena-workspace": "/from-header" }),
      body: { sessionId: SESSION_ID, workspace: "/from-body" },
    });
    assert.equal(calls[0].headers["x-arena-workspace"], "/from-header", "the header wins over the body field");
  });

  test("a refusal comes back with the reason AND how to fix it", async (t) => {
    const ctx = await startE2E({ bridge: { reinjectLocalCapability: async () => ({ injected: false, pending: false, reason: "no workspace recognized", workspace: "", workspaceFrom: "none" }) } });
    t.after(() => ctx.close());
    const res = await httpRequest(ctx.port, { method: "POST", reqPath: "/api/mcp/reinject", headers: authHeaders({ "Content-Type": "application/json" }), body: { sessionId: SESSION_ID } });
    assert.equal(res.status, 200);
    assert.equal(res.json.injected, false);
    assert.equal(res.json.pending, false);
    assert.equal(res.json.reason, "no workspace recognized");
    // Ticket 24: this route's usual caller is the GUI button, which has no
    // headers to set, so the remedies it can actually perform come first.
    assert.match(res.json.hint, /mcp-workspace\.txt/);
    assert.match(res.json.hint, /x-arena-workspace/);
  });

  test("no session anywhere is an actionable 400, and the key still guards it", async (t) => {
    const ctx = await startE2E({ bridge: { reinjectLocalCapability: async () => outcome } });
    t.after(() => ctx.close());
    const res = await httpRequest(ctx.port, { method: "POST", reqPath: "/api/mcp/reinject", headers: authHeaders({ "Content-Type": "application/json" }), body: { sessionId: "" } });
    assert.equal(res.status, 400);
    const noKey = await httpRequest(ctx.port, { method: "POST", reqPath: "/api/mcp/reinject", headers: { "Content-Type": "application/json" }, body: { sessionId: SESSION_ID } });
    assert.equal(noKey.status, 401);
  });
});
