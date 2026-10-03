import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { formatMessages, sessionKey, latestTurn, contentText, requestedTools, CLIENT_SESSION_HEADERS, firstHeader } from "../src/format.mjs";

const BASH_TOOL = [
  { type: "function", function: { name: "Bash", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
];

test("contentText handles string, array, tool_result", () => {
  assert.equal(contentText("hi"), "hi");
  assert.equal(contentText([{ type: "text", text: "a" }, { type: "text", text: "b" }]), "a\nb");
  assert.equal(contentText([{ type: "tool_result", tool_use_id: "t1", content: "out" }]), "Tool result (t1): out");
});

test("formatMessages keeps current turn and strips system-reminder", () => {
  const messages = [
    { role: "system", content: "You are Claude Code, Anthropic's official CLI for Claude. [stock harness]" },
    { role: "user", content: "<system-reminder>ignore</system-reminder> build the thing" },
  ];
  const prompt = formatMessages(messages, false, [], null);
  assert.ok(prompt.includes("CURRENT TURN"));
  assert.ok(prompt.includes("build the thing"));
  assert.ok(!prompt.includes("system-reminder"));
  assert.ok(!prompt.includes("You are Claude Code, Anthropic's official CLI"));
});

test("formatMessages includes tool contract when tools provided", () => {
  const messages = [{ role: "user", content: "run ls" }];
  const prompt = formatMessages(messages, true, BASH_TOOL, null);
  assert.ok(prompt.includes("EXTERNAL-TOOL TRANSPORT CONTRACT"));
  assert.ok(prompt.includes("External tool names: Bash"));
  assert.ok(prompt.includes("schema:"));
});

test("formatMessages warns NO TOOLS when none registered", () => {
  const prompt = formatMessages([{ role: "user", content: "hi" }], false, [], null);
  assert.ok(prompt.includes("NO TOOLS AVAILABLE"));
  assert.ok(prompt.includes("Answer the user's request directly"));
});

test("formatMessages does not warn NO TOOLS when tools exist", () => {
  const prompt = formatMessages([{ role: "user", content: "hi" }], true, BASH_TOOL, null);
  assert.ok(!prompt.includes("NO TOOLS AVAILABLE"));
  assert.ok(prompt.includes("EXTERNAL-TOOL TRANSPORT CONTRACT"));
});

test("formatMessages includes personal profile when provided", () => {
  const profile = { enabled: true, language: "fa", autonomy: "high" };
  const prompt = formatMessages([{ role: "user", content: "hi" }], false, [], profile);
  assert.ok(prompt.includes("PERSONAL ARENA PROFILE"));
  assert.ok(prompt.includes("Preferred language: fa"));
});

test("sessionKey resolves explicit headers first", () => {
  const key = sessionKey({ messages: [{ role: "user", content: "x" }] }, { "x-codex-session-id": "sess-123" });
  assert.equal(key, "sess-123");
});

test("shared client-session headers are ordered and skip blank values", () => {
  assert.deepEqual(CLIENT_SESSION_HEADERS, ["x-codex-session-id", "x-session-id", "x-omniroute-session"]);
  assert.equal(firstHeader({
    "x-codex-session-id": "  ",
    "x-session-id": " session-2 ",
    "x-omniroute-session": "session-3",
  }, CLIENT_SESSION_HEADERS), "session-2");
  assert.equal(firstHeader({}, CLIENT_SESSION_HEADERS), "");
});

test("sessionKey applies the shared header order and fallback precedence", () => {
  const body = {
    metadata: {
      session_id: "metadata-snake",
      sessionId: "metadata-camel",
      user_id: JSON.stringify({ session_id: "user-id" }),
    },
    session_id: "body-session",
    conversation_id: "conversation",
    prompt_cache_key: "prompt-cache",
    messages: [{ role: "user", content: "x" }],
  };
  assert.equal(sessionKey(body, {
    "x-codex-session-id": " codex ",
    "x-session-id": "session",
    "x-omniroute-session": "omni",
  }), "codex");
  assert.equal(sessionKey(body, { "x-codex-session-id": " ", "x-session-id": " session ", "x-omniroute-session": "omni" }), "session");
  assert.equal(sessionKey(body, { "x-omniroute-session": " omni " }), "omni");
  assert.equal(sessionKey(body, {}), "metadata-snake");
  assert.equal(sessionKey({ ...body, metadata: { sessionId: "metadata-camel" } }, {}), "metadata-camel");
  assert.equal(sessionKey({ ...body, metadata: { user_id: JSON.stringify({ session_id: "user-id" }) } }, {}), "user-id");
  assert.equal(sessionKey({ ...body, metadata: {} }, {}), "body-session");
  assert.equal(sessionKey({ ...body, metadata: {}, session_id: "", conversation_id: "conversation" }, {}), "conversation");
  assert.equal(sessionKey({ ...body, metadata: {}, session_id: "", conversation_id: "", prompt_cache_key: "prompt-cache" }, {}), "prompt-cache");
});

test("sessionKey falls back to prompt hash", () => {
  const key = sessionKey({ messages: [{ role: "user", content: "hello world" }] }, {});
  assert.ok(key.startsWith("prompt-") && key.length === 7 + 64);
});

test("latestTurn slices from last assistant message", () => {
  const messages = [
    { role: "user", content: "a" },
    { role: "assistant", content: "b" },
    { role: "user", content: "c" },
    { role: "tool", tool_call_id: "t", content: "d" },
  ];
  const sliced = latestTurn(messages);
  assert.equal(sliced.length, 3);
  assert.equal(sliced[0].role, "assistant");
});

test("formatMessages preserves the complete plain-chat prompt", () => {
  assert.equal(formatMessages([{ role: "user", content: "hello" }], false, [], { enabled: false }), [
    "CURRENT TURN — answer/execute this latest user request now:\nhello",
    "User: hello",
    "CURRENT-TURN RULE: Respond to the CURRENT TURN at the top of this prompt, not an earlier message. Earlier assistant/user text is historical context only. If the current turn is a Tool result, continue from that exact result.",
    "NO TOOLS AVAILABLE: This request has no external tools. Do not attempt to run, propose, or reference any tool, command, or function. Answer the user's request directly with text only.",
  ].join("\n\n"));
});

test("formatMessages preserves the full stock-runtime, profile and tool-result prompt", () => {
  const messages = [
    { role: "system", content: "You are Claude Code, Anthropic's official CLI for Claude. fixture" },
    { role: "developer", content: "Keep the rules." },
    { role: "user", content: "Earlier request" },
    { role: "assistant", content: "Checking", tool_calls: [{ id: "t", function: { name: "Bash", arguments: JSON.stringify({ command: "pwd" }) } }] },
    { role: "tool", tool_call_id: "t", content: [{ type: "text", text: "output" }] },
  ];
  const prompt = formatMessages(messages, true, BASH_TOOL, { ownerName: "Fixture", language: "zh", customInstructions: "Stay precise" });
  assert.equal(crypto.createHash("sha256").update(prompt).digest("hex"), "18a17dd1c054a0e2ee21714cd78435644841eeba662145463a2e74735c5c128e");
});

test("requestedTools filters invalid entries and compacts descriptions and schemas", () => {
  assert.deepEqual(requestedTools([null, {}, { function: { name: 4 } }, {
    function: { name: "Read_File", description: "two\n words", parameters: { type: "object", description: "discard", properties: { path: { type: "string" } } } },
  }]), [{ name: "Read_File", normalized: "readfile", description: "two words", parameters: { type: "object", properties: { path: { type: "string" } } } }]);
});
