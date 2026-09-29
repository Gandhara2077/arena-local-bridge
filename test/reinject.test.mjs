// Ticket 14 — the manual re-injection entry, on a REAL Bridge (its constructor
// is passive: config + credentials + recaptcha, no browser, no network). The
// endpoint FILE is the switch: written by the launcher, deleted when the tunnel
// stops. The page-writing half is not these tests' business — the seam is.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Bridge, IDEMPOTENCY_HEADER, CODEX_SESSION_HEADER } from "../src/bridge.mjs";
import { WORKSPACE_HEADER } from "../src/mcp-preamble.mjs";
import { injectionPlan } from "../src/mcp-preamble.mjs";

const SESSION = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const URL_A = "https://tunnel-a.trycloudflare.com/mcp";
const URL_B = "https://tunnel-b.trycloudflare.com/mcp";
// Codex names its own conversation — a different id space from the Arena UUID.
const CODEX_A = "01a0bd57-e17a-7fd1-a4bf-e9ad5adfd7fd";
const CODEX_B = "01a0bfb3-49c2-7d01-a99c-1d6682022310";
const ACCOUNT = { email: "acct@test.local" };

function makeBridge(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "reinject-"));
  const config = {
    ...overrides,
    dataDir,
    mcpEndpointFile: path.join(dataDir, "mcp-endpoint.json"),
    codexSessionsDir: path.join(dataDir, "no-codex-here"),
    codexRecentWindowMs: 0,
    mcpWorkspace: "",
    // Everything below is unrelated to injection but read by the constructor /
    // other policies; keep them boring.
    host: "127.0.0.1",
    port: 0,
    bridgeKey: "k",
    maxQueue: 8,
    maxToolCalls: 8,
    turnMarkerEnabled: false,
    resultCacheTtlMs: 60_000,
    readBudgetMs: 0,
    readRetryMax: 0,
    readRetryDelayMs: 0,
    toolPolicy: "deny",
    toolAllowBudgetMs: 0,
    toolAllowMaxReads: 0,
  };
  const bridge = new Bridge({
    config,
    credentials: { primary: () => ACCOUNT, forSession: () => ACCOUNT, list: () => [ACCOUNT] },
    recaptcha: { get: async () => "token" },
  });
  // converse()'s page-writing half is not these tests' business — the seam is
  // appendAgentMessage (what goes out) and readLatestTurn (what comes back), so
  // one real turn costs no Playwright and no network.
  bridge.browser = { withAccount: async (_account, fn) => fn(), getPage: async () => ({}) };
  bridge.sent = [];
  bridge.appendAgentMessage = async (_page, _state, prompt) => {
    bridge.sent.push(prompt);
  };
  bridge.readLatestTurn = async () => ({
    text: "ok",
    nativeCalls: [],
    turns: [],
    timing: { breakReason: "turn+marker" },
  });
  return bridge;
}

/** One real turn through converse(), on the double above. */
function turn(bridge, text, headers) {
  return bridge.converse(SESSION, { messages: [{ role: "user", content: text }] }, { headers, account: ACCOUNT });
}

const writeEndpoint = (bridge, url, token) =>
  fs.writeFileSync(bridge.config.mcpEndpointFile, JSON.stringify({ url, token }), "utf8");

describe("manual re-injection", () => {
  test("with no endpoint file there is nothing to re-inject, and it says why", () => {
    const bridge = makeBridge();
    const outcome = bridge.reinjectLocalCapability(SESSION);
    assert.equal(outcome.injected, false);
    assert.equal(outcome.reason, "no local endpoint is up");
  });

  test("a Session injected once can be injected again on request", () => {
    const bridge = makeBridge();
    writeEndpoint(bridge, URL_A, "token-a");
    const headers = { [WORKSPACE_HEADER]: "/Users/me/project" };

    // The automatic first turn.
    const first = bridge.localCapabilityForTurn(SESSION, headers);
    assert.equal(first.injected, true);
    assert.match(first.preamble, /endpoint: https:\/\/tunnel-a/);
    assert.match(first.preamble, /本地工作区: \/Users\/me\/project/);
    assert.equal(
      injectionPlan({
        injected: bridge.mcpInjected.get(SESSION),
        endpoint: bridge.mcpInjected.get(SESSION),
        force: false,
      }).inject,
      false,
      "without a request the Session is told once per endpoint",
    );

    // The manual entry only ARMS — nothing is sent to Arena by it.
    const armed = bridge.reinjectLocalCapability(SESSION, headers);
    assert.equal(armed.injected, false);
    assert.equal(armed.pending, true);
    assert.equal(armed.preamble, undefined, "a preamble generated here would never reach the model");

    // …and the next real turn is the thing that actually delivers it.
    const next = bridge.localCapabilityForTurn(SESSION, headers);
    assert.equal(next.injected, true, "the armed turn must carry the preamble again");
    assert.equal(next.pending, true);
    assert.match(next.preamble, /本地工作区: \/Users\/me\/project/);

    // The arming is one-shot: the turn after it is back to the normal rule.
    assert.equal(bridge.localCapabilityForTurn(SESSION, headers).injected, false);
  });

  test("the workspace is resolved again at the armed turn, not replayed from before", () => {
    const bridge = makeBridge();
    writeEndpoint(bridge, URL_A, "token-a");
    bridge.localCapabilityForTurn(SESSION, { [WORKSPACE_HEADER]: "/Users/me/old-project" });
    bridge.reinjectLocalCapability(SESSION, { [WORKSPACE_HEADER]: "/Users/me/new-project" });
    const moved = bridge.localCapabilityForTurn(SESSION, { [WORKSPACE_HEADER]: "/Users/me/new-project" });
    assert.equal(moved.workspace, "/Users/me/new-project");
    assert.match(moved.preamble, /\/Users\/me\/new-project/);
    assert.ok(!moved.preamble.includes("old-project"));
  });

  test("an unresolvable workspace means NO local capability, and the reason comes back", () => {
    const bridge = makeBridge();
    writeEndpoint(bridge, URL_A, "token-a");
    const outcome = bridge.reinjectLocalCapability(SESSION, {});
    assert.equal(outcome.injected, false);
    assert.equal(outcome.pending, false);
    assert.equal(outcome.reason, "no workspace recognized");
    // Refusing must not arm anything nor burn the turn-injection: once the
    // caller supplies a workspace (header or config), the normal path works.
    assert.equal(bridge.mcpReinjectPending.has(SESSION), false);
    assert.equal(bridge.mcpInjected.has(SESSION), false);
    assert.equal(bridge.localCapabilityForTurn(SESSION, { [WORKSPACE_HEADER]: "/w" }).injected, true);
  });

  test("a configured default workspace satisfies it without any header", () => {
    const bridge = makeBridge();
    writeEndpoint(bridge, URL_A, "token-a");
    bridge.config.mcpWorkspace = "/srv/default-workspace";
    const outcome = bridge.reinjectLocalCapability(SESSION, {});
    assert.equal(outcome.pending, true);
    assert.equal(outcome.workspaceFrom, "config");
  });

  test("a new tunnel re-injects on its own (old line is dead)", () => {
    const bridge = makeBridge();
    writeEndpoint(bridge, URL_A, "token-a");
    assert.equal(bridge.localCapabilityForTurn(SESSION, { [WORKSPACE_HEADER]: "/w" }).injected, true);
    writeEndpoint(bridge, URL_B, "token-b");
    assert.equal(bridge.localCapabilityForTurn(SESSION, { [WORKSPACE_HEADER]: "/w" }).injected, true);
  });

  // The point of the arming: it is SPENT by a turn, so it may only be spent by
  // a turn. Both ways a converse can be answered without touching Arena — a
  // named retry served from the idempotency cache, and a retry that joins a run
  // still in flight — used to consume it, and the workspace never arrived.
  test("a request answered from the idempotency cache does not spend the arming", async () => {
    const bridge = makeBridge();
    writeEndpoint(bridge, URL_A, "token-a");
    const headers = { [WORKSPACE_HEADER]: "/Users/me/project", [IDEMPOTENCY_HEADER]: "req-1" };

    await turn(bridge, "hello", headers);
    assert.equal(bridge.sent.length, 1);
    assert.match(bridge.sent[0], /endpoint: https:\/\/tunnel-a/, "the first turn tells the Session by itself");
    assert.equal(bridge.reinjectLocalCapability(SESSION, headers).pending, true);

    // The client's retry of the same named request never reaches Arena.
    const replayed = await turn(bridge, "hello", headers);
    assert.equal(replayed.choices[0].message.content, "ok");
    assert.equal(bridge.sent.length, 1, "a replay must not open a second turn");
    assert.equal(bridge.mcpReinjectPending.has(SESSION), true, "the arming must survive the replay");

    // …so the turn that does go out is the one that carries it.
    await turn(bridge, "a different question", headers);
    assert.equal(bridge.sent.length, 2);
    assert.match(bridge.sent[1], /endpoint: https:\/\/tunnel-a/);
    assert.match(bridge.sent[1], /本地工作区: \/Users\/me\/project/);
    assert.equal(bridge.mcpReinjectPending.has(SESSION), false, "spent by the turn that actually went out");
  });

  test("a request that joins an in-flight turn does not spend the arming either", async () => {
    const bridge = makeBridge();
    writeEndpoint(bridge, URL_A, "token-a");
    const headers = { [WORKSPACE_HEADER]: "/Users/me/project" };
    await turn(bridge, "hello", headers);

    // Hold the next turn open at the point it has already taken what it spends,
    // so a retry of it arrives while it is still running.
    let release = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let reached = () => {};
    const inside = new Promise((resolve) => {
      reached = resolve;
    });
    bridge.appendAgentMessage = async (_page, _state, prompt) => {
      bridge.sent.push(prompt);
      reached();
      await gate;
    };

    const running = turn(bridge, "second question", headers);
    await inside;
    // Armed AFTER the running turn took its preamble: only the joiner could
    // spend it now, and the joiner never reaches Arena.
    assert.equal(bridge.reinjectLocalCapability(SESSION, headers).pending, true);
    const joining = turn(bridge, "second question", headers);
    assert.equal(bridge.mcpReinjectPending.has(SESSION), true, "the joiner must not spend the arming");

    release();
    const [first, second] = await Promise.all([running, joining]);
    assert.equal(first, second, "the joiner was handed the same run");
    assert.equal(bridge.sent.length, 2, "one turn ran, not two");
    assert.equal(bridge.mcpReinjectPending.has(SESSION), true, "nothing real has run since the arming");

    // …and the next real turn is still the one that delivers it.
    await turn(bridge, "a third question", headers);
    assert.equal(bridge.sent.length, 3);
    assert.match(bridge.sent[2], /endpoint: https:\/\/tunnel-a/);
    assert.equal(bridge.mcpReinjectPending.has(SESSION), false);
  });

  // The GUI asks for a re-injection; it has no Codex request to read the
  // session id from, and with two projects being talked to at once the
  // "most recent transcript" fallback refuses to answer (soleRecentTranscript:
  // exactly one, or nothing). The id the Session was last served with is what
  // makes "re-inject into THIS session" mean the right directory.
  test("the workspace comes from the Codex session this Session was served with", async () => {
    const bridge = makeBridge({ codexRecentWindowMs: 120_000 });
    const sessionsRoot = path.join(bridge.config.dataDir, "codex-sessions");
    const rollout = (codexId, cwd) => {
      const file = path.join(sessionsRoot, "2026", "09", "29", `rollout-2026-09-29T10-00-00-${codexId}.jsonl`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `{"session_id":"${codexId}","cwd":"${cwd}"}\n`, "utf8");
    };
    rollout(CODEX_A, "/projects/A");
    rollout(CODEX_B, "/projects/B");
    bridge.config.codexSessionsDir = sessionsRoot;
    writeEndpoint(bridge, URL_A, "token-a");

    // A Codex turn arrives naming its conversation; the automatic injection uses
    // it, and the bridge remembers which conversation this Session belongs to.
    await turn(bridge, "hello", { [CODEX_SESSION_HEADER]: CODEX_A });
    assert.match(bridge.sent[0], /本地工作区: \/projects\/A/);

    // The manual entry carries no header at all — two transcripts are recent, so
    // guessing would be wrong. It must still find A.
    const armed = bridge.reinjectLocalCapability(SESSION, {});
    assert.equal(armed.pending, true, "the remembered Codex session is what makes this resolvable");
    assert.equal(armed.workspace, "/projects/A");
    assert.equal(armed.workspaceFrom, "codex-session");

    await turn(bridge, "again", { [CODEX_SESSION_HEADER]: CODEX_A });
    assert.equal(bridge.sent.length, 2);
    assert.match(bridge.sent[1], /本地工作区: \/projects\/A/);
  });

  // A 503 is not a turn: the queue refuses it before Arena is reached, so it may
  // not spend the one-shot arming either.
  test("a request the queue refuses does not spend the arming", async () => {
    const bridge = makeBridge();
    writeEndpoint(bridge, URL_A, "token-a");
    const headers = { [WORKSPACE_HEADER]: "/Users/me/project" };
    assert.equal(bridge.reinjectLocalCapability(SESSION, headers).pending, true);

    bridge.runtime.queueDepth = bridge.config.maxQueue;
    await assert.rejects(turn(bridge, "hello", headers), (error) => error.status === 503 && error.code === "bridge_queue_full");
    assert.equal(bridge.sent.length, 0, "a refused request must not reach Arena");
    assert.equal(bridge.mcpReinjectPending.has(SESSION), true, "…and must not spend the arming");

    bridge.runtime.queueDepth = 0;
    await turn(bridge, "hello", headers);
    assert.match(bridge.sent[0], /endpoint: https:\/\/tunnel-a/);
    assert.equal(bridge.mcpReinjectPending.has(SESSION), false);
  });

  test("a rotated token behind the same URL is a different endpoint (full-token fingerprint)", () => {
    const bridge = makeBridge();
    // Same URL, same first 8 characters: a prefix fingerprint would call these
    // identical and skip the re-injection the new token needs.
    writeEndpoint(bridge, URL_A, "abcdefgh-OLD");
    assert.equal(bridge.localCapabilityForTurn(SESSION, { [WORKSPACE_HEADER]: "/w" }).injected, true);
    writeEndpoint(bridge, URL_A, "abcdefgh-NEW");
    assert.equal(bridge.localCapabilityForTurn(SESSION, { [WORKSPACE_HEADER]: "/w" }).injected, true);
  });
});
