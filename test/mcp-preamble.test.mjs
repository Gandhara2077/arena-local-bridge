import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mcpPreamble, injectionPlan, workspaceFromHeaders, WORKSPACE_HEADER } from "../src/mcp-preamble.mjs";

const URL = "https://example.trycloudflare.com/mcp";
const TOKEN = "abc123";

test("the preamble always carries the endpoint and its bearer token", () => {
  const text = mcpPreamble({ url: URL, token: TOKEN });
  assert.match(text, /endpoint: https:\/\/example\.trycloudflare\.com\/mcp/);
  assert.match(text, /header: Authorization: Bearer abc123/);
});

test("the workspace line appears only when a workspace is configured", () => {
  assert.ok(!mcpPreamble({ url: URL, token: TOKEN }).includes("本地工作区"));
  assert.match(mcpPreamble({ url: URL, token: TOKEN, workspace: "D:\\work\\proj" }), /本地工作区: D:\\work\\proj/);
  assert.ok(!mcpPreamble({ url: URL, token: TOKEN, workspace: "   " }).includes("本地工作区"));
});

test("it tells the agent that relative paths never land in the workspace", () => {
  // Neutral phrasing on purpose: the upstream is AgentDock today (relative
  // paths resolve to ~/AgentDock) and our own server after ticket 18/19
  // (relative paths are rejected outright) — both mean "not the workspace".
  const text = mcpPreamble({ url: URL, token: TOKEN });
  assert.match(text, /一律传绝对路径/);
  assert.match(text, /不会落到工作区/);
  assert.ok(!/请传绝对路径/.test(text), "the old ~/AgentDock-only phrasing must be gone");
});

test("it requires generated files to be written back, not pasted into the reply", () => {
  const text = mcpPreamble({ url: URL, token: TOKEN });
  assert.match(text, /file_edit action=add/);
  assert.match(text, /不要只在回复里贴内容/);
});

test("it names the publish tool for deliverables", () => {
  assert.match(mcpPreamble({ url: URL, token: TOKEN }), /file_publish/);
});

test("it discloses that exec_command is a local shell outside the file boundary (ADR 0011)", () => {
  const text = mcpPreamble({ url: URL, token: TOKEN });
  assert.match(text, /完整权限/);
  assert.match(text, /不受上述文件边界限制/);
  assert.match(text, /先问用户/);
});

test("it says the tools are reached over HTTP, not from the agent's own tool list", () => {
  const text = mcpPreamble({ url: URL, token: TOKEN });
  assert.match(text, /你的工具列表里不会有这些工具/);
  assert.match(text, /HTTP JSON-RPC/);
  assert.match(text, /tools\/call/);
  assert.match(text, /Accept: application\/json, text\/event-stream/);
});

test("the caller's workspace comes from its request header", () => {
  assert.equal(workspaceFromHeaders({ [WORKSPACE_HEADER]: "D:\\work\\proj" }), "D:\\work\\proj");
  assert.equal(workspaceFromHeaders({ [WORKSPACE_HEADER]: "  /home/me/proj  " }), "/home/me/proj");
  assert.equal(workspaceFromHeaders({ [WORKSPACE_HEADER]: "\\\\server\\share" }), "\\\\server\\share");
});

test("a relative or empty workspace header is ignored", () => {
  assert.equal(workspaceFromHeaders({ [WORKSPACE_HEADER]: "proj" }), "");
  assert.equal(workspaceFromHeaders({ [WORKSPACE_HEADER]: "./proj" }), "");
  assert.equal(workspaceFromHeaders({ [WORKSPACE_HEADER]: "   " }), "");
  assert.equal(workspaceFromHeaders({}), "");
  assert.equal(workspaceFromHeaders(null), "");
});

test("it stays short enough not to raise the reCAPTCHA risk", () => {
  const text = mcpPreamble({ url: URL, token: TOKEN, workspace: "D:\\work\\proj" });
  // The budget grew when the preamble had to start naming the transport (the
  // agent's tool list never contains these tools), but it must stay a preamble,
  // not a manual: long first messages raise Arena's reCAPTCHA risk.
  assert.ok(text.length < 900, `preamble is ${text.length} chars`);
  assert.ok(text.split("\n").length <= 14);
});

// Ticket 14's seam: whether a session may be injected again, decided without
// touching the filesystem.
describe("injectionPlan (once per Session, unless forced)", () => {
  test("no endpoint means nothing to inject", () => {
    assert.deepEqual(injectionPlan({ injected: "", endpoint: "" }), { inject: false, reason: "no local endpoint is up" });
  });

  test("a session never told gets its first injection", () => {
    assert.equal(injectionPlan({ injected: "", endpoint: "fp-a" }).inject, true);
  });

  test("the same endpoint again is refused — that IS the once-per-Session guard", () => {
    assert.deepEqual(injectionPlan({ injected: "fp-a", endpoint: "fp-a" }), {
      inject: false,
      reason: "already injected into this session",
    });
  });

  test("a new endpoint (new tunnel, new URL + token) re-injects", () => {
    assert.equal(injectionPlan({ injected: "fp-a", endpoint: "fp-b" }).inject, true);
    assert.match(injectionPlan({ injected: "fp-a", endpoint: "fp-b" }).reason, /endpoint changed/);
  });

  test("force overrides the guard — that is the manual entry", () => {
    assert.equal(injectionPlan({ injected: "fp-a", endpoint: "fp-a", force: true }).inject, true);
    assert.match(injectionPlan({ injected: "fp-a", endpoint: "fp-a", force: true }).reason, /manual/);
    // …but force cannot invent an endpoint: with no tunnel there is nothing to say.
    assert.equal(injectionPlan({ injected: "fp-a", endpoint: "", force: true }).inject, false);
  });
});
