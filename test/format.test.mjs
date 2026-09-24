import { test } from "node:test";
import assert from "node:assert/strict";
import { formatMessages, sessionKey, latestTurn, contentText } from "../src/format.mjs";

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
