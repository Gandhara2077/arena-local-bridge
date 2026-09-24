import { test } from "node:test";
import assert from "node:assert/strict";
import { mcpPreamble, workspaceFromHeaders, WORKSPACE_HEADER } from "../src/mcp-preamble.mjs";

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

test("it tells the agent that relative paths do not land in the workspace", () => {
  assert.match(mcpPreamble({ url: URL, token: TOKEN }), /相对路径(会)?解析到 ~\/AgentDock/);
});

test("it requires generated files to be written back, not pasted into the reply", () => {
  const text = mcpPreamble({ url: URL, token: TOKEN });
  assert.match(text, /file_edit action=add/);
  assert.match(text, /不要只在回复里贴内容/);
});

test("it names the publish tool for deliverables", () => {
  assert.match(mcpPreamble({ url: URL, token: TOKEN }), /file_publish/);
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
