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
function turn(bridge, text, headers, extra = {}) {
  return bridge.converse(SESSION, { messages: [{ role: "user", content: text }] }, { headers, account: ACCOUNT, ...extra });
}

/**
 * Ticket 21 — decide and spend in one step: the two calls converse() makes
 * around a send that succeeded. For tests whose subject is the bookkeeping
 * (which fingerprint was recorded, whether the arming is still pending) rather
 * than the moment of spending, which has its own describe block below.
 */
function takeInjection(bridge, headers) {
  const decision = bridge.localCapabilityForTurn(SESSION, headers);
  bridge.commitLocalCapability(decision);
  return decision;
}

const writeEndpoint = (bridge, url, token) =>
  fs.writeFileSync(bridge.config.mcpEndpointFile, JSON.stringify({ url, token }), "utf8");

describe("owned local runtime workspace", () => {
  function localBridge(t) {
    const bridge = makeBridge();
    t.after(() => fs.rmSync(bridge.config.dataDir, { recursive: true, force: true }));
    bridge.config.mcpRuntime = "local";
    bridge.config.mcpOwner = "this-instance";
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "reinject-workspace-"));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    fs.writeFileSync(bridge.config.mcpEndpointFile, JSON.stringify({
      url: URL_A, token: "token-a", runtime: "local", owner: "this-instance", workspace,
    }));
    return { bridge, workspace };
  }

  test("the published explicit startup workspace is the fallback for reinjection and an ordinary turn", async (t) => {
    const { bridge, workspace } = localBridge(t);
    const armed = bridge.reinjectLocalCapability(SESSION);
    assert.equal(armed.pending, true);
    assert.equal(armed.workspace, workspace);
    assert.equal(armed.workspaceFrom, "local-runtime");
    await turn(bridge, "use my workspace");
    assert.ok(bridge.sent[0].includes(workspace));
    assert.match(bridge.sent[0], /endpoint: https:\/\/tunnel-a/);
  });

  test("a Local picker choice overrides remembered resolution, survives a failed send and still checks later workspaces", async (t) => {
    const { bridge, workspace } = localBridge(t);
    const selected = path.join(workspace, "selected");
    const remembered = path.join(workspace, "remembered");
    fs.mkdirSync(selected);
    fs.mkdirSync(remembered);
    const sessionsRoot = path.join(bridge.config.dataDir, "codex-sessions");
    fs.mkdirSync(sessionsRoot);
    fs.writeFileSync(path.join(sessionsRoot, `rollout-${CODEX_A}.jsonl`), JSON.stringify({ cwd: remembered }));
    bridge.config.codexSessionsDir = sessionsRoot;
    bridge.codexSessionBySession.set(SESSION, CODEX_A);
    assert.equal(bridge.reinjectLocalCapability(SESSION, { [WORKSPACE_HEADER]: selected }).workspace, selected);

    const append = bridge.appendAgentMessage;
    bridge.appendAgentMessage = async () => { throw new Error("Send button not found"); };
    await assert.rejects(turn(bridge, "hello"), /Send button not found/);
    assert.equal(bridge.mcpReinjectPending.has(SESSION), true);
    assert.equal(bridge.sent.length, 0);

    bridge.appendAgentMessage = append;
    await turn(bridge, "try again");
    assert.ok(bridge.sent[0].includes(`本地工作区: ${selected}`));
    assert.equal(bridge.mcpReinjectPending.has(SESSION), false);
    assert.equal(bridge.codexSessionBySession.get(SESSION), CODEX_A, "the picker does not replace the Codex binding");
    await assert.rejects(turn(bridge, "outside after injection was spent", { [WORKSPACE_HEADER]: path.dirname(workspace) }), {
      status: 409, code: "mcp_workspace_conflict",
    });
    assert.equal(bridge.sent.length, 1);
  });

  test("a Local picker choice yields to an explicit turn workspace without bypassing the running root", async (t) => {
    const { bridge, workspace } = localBridge(t);
    const selected = path.join(workspace, "selected");
    const current = path.join(workspace, "current");
    fs.mkdirSync(selected);
    fs.mkdirSync(current);
    bridge.reinjectLocalCapability(SESSION, { [WORKSPACE_HEADER]: selected });

    await assert.rejects(turn(bridge, "outside", { [WORKSPACE_HEADER]: path.dirname(workspace) }), {
      status: 409, code: "mcp_workspace_conflict",
    });
    assert.equal(bridge.sent.length, 0);
    assert.equal(bridge.mcpReinjectPending.has(SESSION), true);

    await turn(bridge, "current workspace", { [WORKSPACE_HEADER]: current });
    assert.ok(bridge.sent[0].includes(`本地工作区: ${current}`));
    assert.ok(!bridge.sent[0].includes(selected));
    assert.equal(bridge.mcpReinjectPending.has(SESSION), false);
  });

  test("a recognized different workspace is a 409, even after automatic injection was spent", async (t) => {
    const { bridge } = localBridge(t);
    await turn(bridge, "first turn");
    const other = path.join(bridge.config.dataDir, "other");
    fs.mkdirSync(other);
    const headers = { [WORKSPACE_HEADER]: other };
    assert.throws(() => bridge.reinjectLocalCapability(SESSION, headers), { status: 409, code: "mcp_workspace_conflict" });
    await assert.rejects(turn(bridge, "different workspace", headers), { status: 409, code: "mcp_workspace_conflict" });
    assert.equal(bridge.sent.length, 1);
  });

  test("an explicit startup selection overrides a configured startup default for no-header turns", async (t) => {
    const { bridge, workspace } = localBridge(t);
    bridge.config.mcpWorkspace = bridge.config.dataDir;
    assert.equal(bridge.reinjectLocalCapability(SESSION).workspace, workspace);
    await turn(bridge, "use the explicitly selected workspace");
    assert.ok(bridge.sent[0].includes(workspace));
  });

  test("local mode ignores legacy, foreign and loopback publications; legacy mode still accepts the old format", (t) => {
    const { bridge, workspace } = localBridge(t);
    for (const endpoint of [
      { url: URL_A, token: "t" },
      { url: URL_A, token: "t", runtime: "local", owner: "another-instance", workspace },
      { url: "http://127.0.0.1:8765/mcp", token: "t", runtime: "local", owner: "this-instance", workspace },
    ]) {
      fs.writeFileSync(bridge.config.mcpEndpointFile, JSON.stringify(endpoint));
      assert.equal(bridge.reinjectLocalCapability(SESSION).reason, "no local endpoint is up");
    }
    bridge.config.mcpRuntime = "agentdock";
    bridge.config.mcpWorkspace = workspace;
    writeEndpoint(bridge, URL_A, "t");
    assert.equal(bridge.reinjectLocalCapability(SESSION).pending, true);
  });
});

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

    // Ticket 21 — deciding is not spending. converse() decides when the turn is
    // admitted and spends once the prompt is Arena's; one turn is those two
    // calls around the send.
    const first = bridge.localCapabilityForTurn(SESSION, headers);
    assert.equal(first.injected, true);
    assert.match(first.preamble, /endpoint: https:\/\/tunnel-a/);
    assert.match(first.preamble, /本地工作区: \/Users\/me\/project/);
    assert.equal(bridge.mcpInjected.has(SESSION), false, "a decision alone has told Arena nothing");
    bridge.commitLocalCapability(first);
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
    bridge.commitLocalCapability(next);

    // The arming is one-shot: the turn after it is back to the normal rule.
    assert.equal(bridge.localCapabilityForTurn(SESSION, headers).injected, false);
  });

  test("the workspace is resolved again at the armed turn, not replayed from before", () => {
    const bridge = makeBridge();
    writeEndpoint(bridge, URL_A, "token-a");
    takeInjection(bridge, { [WORKSPACE_HEADER]: "/Users/me/old-project" });
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
    assert.equal(takeInjection(bridge, { [WORKSPACE_HEADER]: "/w" }).injected, true);
  });

  test("a configured default workspace satisfies it without any header", () => {
    const bridge = makeBridge();
    writeEndpoint(bridge, URL_A, "token-a");
    bridge.config.mcpWorkspace = "/srv/default-workspace";
    const outcome = bridge.reinjectLocalCapability(SESSION, {});
    assert.equal(outcome.pending, true);
    assert.equal(outcome.workspaceFrom, "config");
  });

  test("two recent transcripts still refuse guessing, but the user's selection reaches the next turn", async () => {
    const bridge = makeBridge();
    const sessionsRoot = path.join(bridge.config.dataDir, "codex-sessions");
    fs.mkdirSync(sessionsRoot);
    for (const [id, cwd] of [[CODEX_A, "/projects/A"], [CODEX_B, "/projects/B"]]) {
      fs.writeFileSync(path.join(sessionsRoot, `rollout-${id}.jsonl`), JSON.stringify({ cwd }));
    }
    bridge.config.codexSessionsDir = sessionsRoot;
    bridge.config.codexRecentWindowMs = 120_000;
    writeEndpoint(bridge, URL_A, "token-a");

    const refused = bridge.reinjectLocalCapability(SESSION, {});
    assert.equal(refused.pending, false);
    assert.equal(refused.reason, "no workspace recognized");
    assert.equal(bridge.mcpReinjectPending.has(SESSION), false);
    const armed = bridge.reinjectLocalCapability(SESSION, { [WORKSPACE_HEADER]: "/projects/B" });
    assert.equal(armed.workspace, "/projects/B");
    assert.equal(armed.pending, true);

    await turn(bridge, "hello", {});
    assert.match(bridge.sent[0], /本地工作区: \/projects\/B/);
    assert.equal(bridge.mcpReinjectPending.has(SESSION), false);
    assert.equal(bridge.codexSessionBySession.size, 0, "a picker choice is not a Codex session binding");
    assert.equal(bridge.reinjectLocalCapability(SESSION, {}).pending, false, "the selected path was one-shot");
  });

  test("an explicit turn workspace overrides the pending picker choice", async () => {
    const bridge = makeBridge();
    writeEndpoint(bridge, URL_A, "token-a");
    bridge.reinjectLocalCapability(SESSION, { [WORKSPACE_HEADER]: "/projects/selected" });
    await turn(bridge, "hello", { [WORKSPACE_HEADER]: "/projects/current" });
    assert.match(bridge.sent[0], /本地工作区: \/projects\/current/);
    assert.ok(!bridge.sent[0].includes("/projects/selected"));
    assert.equal(bridge.mcpReinjectPending.has(SESSION), false);
  });

  test("a re-injection without an explicit workspace still resolves the directory at the turn", async () => {
    const bridge = makeBridge();
    writeEndpoint(bridge, URL_A, "token-a");
    bridge.config.mcpWorkspace = "/projects/old-default";
    assert.equal(bridge.reinjectLocalCapability(SESSION, {}).pending, true);
    bridge.config.mcpWorkspace = "/projects/new-default";
    await turn(bridge, "hello", {});
    assert.match(bridge.sent[0], /本地工作区: \/projects\/new-default/);
  });

  test("re-arming a picker choice during a send preserves it for the following turn", async () => {
    const bridge = makeBridge();
    writeEndpoint(bridge, URL_A, "token-a");
    bridge.reinjectLocalCapability(SESSION, { [WORKSPACE_HEADER]: "/projects/A" });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let reached;
    const inside = new Promise((resolve) => { reached = resolve; });
    const append = bridge.appendAgentMessage;
    bridge.appendAgentMessage = async (...args) => {
      await append(...args);
      reached();
      await gate;
    };
    const running = turn(bridge, "first", {});
    await inside;
    bridge.reinjectLocalCapability(SESSION, { [WORKSPACE_HEADER]: "/projects/B" });
    release();
    await running;
    assert.match(bridge.sent[0], /本地工作区: \/projects\/A/);
    assert.equal(bridge.mcpReinjectPending.has(SESSION), true, "sending A must not consume a later choice of B");
    bridge.appendAgentMessage = append;
    await turn(bridge, "second", {});
    assert.match(bridge.sent[1], /本地工作区: \/projects\/B/);
    assert.equal(bridge.mcpReinjectPending.has(SESSION), false);
  });

  test("a new tunnel re-injects on its own (old line is dead)", () => {
    const bridge = makeBridge();
    writeEndpoint(bridge, URL_A, "token-a");
    assert.equal(takeInjection(bridge, { [WORKSPACE_HEADER]: "/w" }).injected, true);
    writeEndpoint(bridge, URL_B, "token-b");
    assert.equal(takeInjection(bridge, { [WORKSPACE_HEADER]: "/w" }).injected, true);
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
    assert.equal(takeInjection(bridge, { [WORKSPACE_HEADER]: "/w" }).injected, true);
    writeEndpoint(bridge, URL_A, "abcdefgh-NEW");
    assert.equal(takeInjection(bridge, { [WORKSPACE_HEADER]: "/w" }).injected, true);
  });
});

// Ticket 21 — WHEN the injection is spent. It is decided when the turn is
// admitted and spent once the prompt is Arena's, so the two ways a turn can die
// land on opposite sides of that line: before the send nothing is spent (the
// model was never told), after the send nothing comes back (the model has seen
// it, and repeating it would duplicate).
describe("when a turn spends the injection", () => {
  const readTurn = () => ({ text: "ok", nativeCalls: [], turns: [], timing: { breakReason: "turn+marker" } });
  const headers = () => ({ [WORKSPACE_HEADER]: "/Users/me/project" });

  test("a turn that dies before Arena gets the prompt keeps it, and the next one still carries it", async () => {
    const bridge = makeBridge();
    writeEndpoint(bridge, URL_A, "token-a");
    bridge.appendAgentMessage = async () => {
      throw new Error("Send button not found");
    };

    await assert.rejects(turn(bridge, "hello", headers()));
    assert.equal(bridge.sent.length, 0, "the prompt never left");
    assert.equal(bridge.mcpInjected.has(SESSION), false, "…so nothing was spent");

    bridge.appendAgentMessage = async (_page, _state, prompt) => {
      bridge.sent.push(prompt);
    };
    await turn(bridge, "hello again", headers());
    assert.equal(bridge.sent.length, 1);
    assert.match(bridge.sent[0], /endpoint: https:\/\/tunnel-a/, "the preamble is still there for the turn that goes out");
    assert.equal(bridge.mcpInjected.has(SESSION), true);
  });

  test("an armed re-injection survives a turn that dies before Arena gets the prompt", async () => {
    const bridge = makeBridge();
    writeEndpoint(bridge, URL_A, "token-a");
    await turn(bridge, "hello", headers());
    assert.equal(bridge.mcpReinjectPending.has(SESSION), false, "the automatic injection already came and went");

    assert.equal(bridge.reinjectLocalCapability(SESSION, headers()).pending, true);
    bridge.appendAgentMessage = async () => {
      throw new Error("composer never became ready");
    };
    await assert.rejects(turn(bridge, "second", headers()));
    assert.equal(bridge.mcpReinjectPending.has(SESSION), true, "the arming is still there to be delivered");

    bridge.appendAgentMessage = async (_page, _state, prompt) => {
      bridge.sent.push(prompt);
    };
    await turn(bridge, "second", headers());
    assert.equal(bridge.sent.length, 2);
    assert.match(bridge.sent[1], /endpoint: https:\/\/tunnel-a/);
    assert.equal(bridge.mcpReinjectPending.has(SESSION), false, "spent by the turn that really went out");
  });

  test("a picker choice survives a failed send and is consumed by the next successful send", async () => {
    const bridge = makeBridge();
    writeEndpoint(bridge, URL_A, "token-a");
    bridge.reinjectLocalCapability(SESSION, { [WORKSPACE_HEADER]: "/projects/selected" });
    const append = bridge.appendAgentMessage;
    bridge.appendAgentMessage = async () => { throw new Error("Send button not found"); };
    await assert.rejects(turn(bridge, "hello", {}), /Send button not found/);
    assert.equal(bridge.mcpReinjectPending.has(SESSION), true);
    assert.equal(bridge.sent.length, 0);

    bridge.appendAgentMessage = append;
    await turn(bridge, "try again", {});
    assert.match(bridge.sent[0], /本地工作区: \/projects\/selected/);
    assert.equal(bridge.mcpReinjectPending.has(SESSION), false);
  });

  test("a turn that dies after Arena got the prompt keeps it spent, so it is never delivered twice", async () => {
    const bridge = makeBridge();
    writeEndpoint(bridge, URL_A, "token-a");
    bridge.readLatestTurn = async () => {
      throw new Error("stream broke");
    };

    await assert.rejects(turn(bridge, "hello", headers()));
    assert.equal(bridge.sent.length, 1, "the prompt did go out");
    assert.match(bridge.sent[0], /endpoint: https:\/\/tunnel-a/);

    bridge.readLatestTurn = async () => readTurn();
    await turn(bridge, "hello again", headers());
    assert.equal(bridge.sent.length, 2);
    assert.ok(
      !bridge.sent[1].includes("endpoint: https://tunnel-a"),
      "Arena already has the preamble; sending it again would duplicate it",
    );
  });

  test("an internal probe (injectMcp:false) takes nothing", async () => {
    const bridge = makeBridge();
    writeEndpoint(bridge, URL_A, "token-a");

    await turn(bridge, "体检", headers(), { injectMcp: false });
    assert.equal(bridge.mcpInjected.has(SESSION), false, "a health check must not spend the one-shot");
    assert.ok(!bridge.sent[0].includes("endpoint:"));

    await turn(bridge, "hello", headers());
    assert.match(bridge.sent[1], /endpoint: https:\/\/tunnel-a/, "…so the real conversation is still told");
    assert.equal(bridge.mcpInjected.has(SESSION), true);
  });

  test("two turns racing on one Session carry the preamble once, not twice", async () => {
    const bridge = makeBridge();
    writeEndpoint(bridge, URL_A, "token-a");

    await Promise.all([turn(bridge, "one", headers()), turn(bridge, "two", headers())]);
    assert.equal(bridge.sent.length, 2, "both turns did run");
    assert.equal(
      bridge.sent.filter((p) => p.includes("endpoint: https://tunnel-a")).length,
      1,
      "decide and spend are both inside the queue, so the second turn reads the first one's ledger",
    );
  });

  // The test above dies in the READ, which is the side that must not un-spend the
  // injection. But a read failure that looks like a torn-down page is also the
  // trigger for converse's ONE retry — and that retry used to run the whole
  // attempt again, send included. Arena then had the same message, preamble and
  // all, twice. The error has to be the one the retry actually matches; a plain
  // "stream broke" never reaches this path.
  test("the retry after a page teardown re-reads the session instead of re-sending", async () => {
    const bridge = makeBridge();
    writeEndpoint(bridge, URL_A, "token-a");
    const page = {
      landed: "",
      url: () => page.landed,
      goto: async (url) => {
        page.landed = url;
      },
    };
    // Only the PAGE died: the browser is still connected, which is why converse
    // keeps it (and why these tests never need a close()).
    bridge.browser = {
      withAccount: async (_account, fn) => fn(),
      getPage: async () => page,
      browser: { isConnected: () => true },
    };

    let reads = 0;
    bridge.readLatestTurn = async () => {
      reads += 1;
      if (reads === 1) throw new Error("Target page, context or browser has been closed");
      return readTurn();
    };

    const answer = await turn(bridge, "hello", headers());
    assert.equal(answer.choices[0].message.content, "ok", "the retried read is what answers the turn");
    assert.equal(reads, 2, "the first read died, the retry read again");
    assert.equal(bridge.sent.length, 1, "one send however many reads: the prompt was already Arena's");
    assert.match(bridge.sent[0], /endpoint: https:\/\/tunnel-a/);
    assert.equal(
      bridge.sent.filter((p) => p.includes("endpoint: https://tunnel-a")).length,
      1,
      "a second send would have delivered the one-shot preamble twice",
    );
    assert.equal(page.landed, `https://arena.ai/agent/${SESSION}`, "the retry needs the origin: its fetches are relative");
  });

  test("the retry does not navigate again when the page is already on the session", async () => {
    const bridge = makeBridge();
    writeEndpoint(bridge, URL_A, "token-a");
    const navigations = [];
    const page = {
      url: () => `https://arena.ai/agent/${SESSION}`,
      goto: async (url) => {
        navigations.push(url);
      },
    };
    bridge.browser = {
      withAccount: async (_account, fn) => fn(),
      getPage: async () => page,
      browser: { isConnected: () => true },
    };

    let reads = 0;
    bridge.readLatestTurn = async () => {
      reads += 1;
      if (reads === 1) throw new Error("Execution context was destroyed");
      return readTurn();
    };

    await turn(bridge, "hello", headers());
    assert.equal(bridge.sent.length, 1);
    assert.deepEqual(navigations, [], "a page already on the session must not pay the 18-48s navigation again");
  });
});
