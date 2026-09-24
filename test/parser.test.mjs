import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAgentOutput, parseToolCalls, parseNativeToolCalls, toolCallSignature, repeatedToolGuard } from "../src/parser.mjs";

const BASH_TOOL = [
  {
    type: "function",
    function: {
      name: "Bash",
      description: "run a shell command",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
  },
];

test("parseAgentOutput collects text deltas + token + node id", () => {
  const raw = [
    'id: e1',
    'data: {"records":[{"headers":[["public-access-token","tok-abc"]],"body":"{\\"data\\":{\\"type\\":\\"text-delta\\",\\"delta\\":\\"Hello \\"}}"}]}',
    "",
    "id: e2",
    'data: {"records":[{"body":"{\\"data\\":{\\"type\\":\\"text-delta\\",\\"delta\\":\\"world\\"}}"}]}',
    "",
    "id: e3",
    'data: {"records":[{"body":"{\\"data\\":{\\"type\\":\\"finish\\",\\"messageMetadata\\":{\\"nodeId\\":\\"n7\\",\\"requiresReview\\":false}}}"}]}',
    "",
    "",
  ].join("\n");
  const out = parseAgentOutput(raw);
  assert.equal(out.text, "Hello world");
  assert.equal(out.token, "tok-abc");
  assert.equal(out.lastNodeId, "n7");
  assert.equal(out.lastEventId, "e3");
  assert.equal(out.nativeCalls.length, 0);
});

test("parseAgentOutput captures native tool calls", () => {
  const raw = [
    'data: {"records":[{"body":"{\\"data\\":{\\"type\\":\\"tool-input-start\\",\\"toolCallId\\":\\"t1\\",\\"toolName\\":\\"Bash\\"}}"}]}',
    "",
    'data: {"records":[{"body":"{\\"data\\":{\\"type\\":\\"tool-input-delta\\",\\"toolCallId\\":\\"t1\\",\\"inputTextDelta\\":\\"{\\\\\\"command\\\\\\":\\\\\\"ls -la\\\\\\"}\\"}}"}]}',
    "",
    'data: {"records":[{"body":"{\\"data\\":{\\"type\\":\\"tool-input-available\\",\\"toolCallId\\":\\"t1\\",\\"toolName\\":\\"Bash\\"}}"}]}',
    "",
    'data: {"records":[{"body":"{\\"data\\":{\\"type\\":\\"finish\\",\\"messageMetadata\\":{\\"nodeId\\":\\"n1\\"}}"}]}',
    "",
  ].join("\n");
  const out = parseAgentOutput(raw);
  assert.equal(out.nativeCalls.length, 1);
  assert.equal(out.nativeCalls[0].name, "Bash");
  assert.deepEqual(out.nativeCalls[0].input, { command: "ls -la" });
});

test("parseToolCalls extracts XML tool blocks and strips them from content", () => {
  const text = 'I will check.\n<tool>{"name":"Bash","arguments":{"command":"ls -la"}}</tool>\nDone.';
  const { content, toolCalls } = parseToolCalls(text, BASH_TOOL);
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].function.name, "Bash");
  assert.deepEqual(JSON.parse(toolCalls[0].function.arguments), { command: "ls -la" });
  assert.ok(!content.includes("<tool>"));
  assert.ok(content.includes("I will check."));
});

test("parseToolCalls ignores unregistered tools", () => {
  const text = '<tool>{"name":"FakeTool","arguments":{"x":1}}</tool>';
  const { toolCalls } = parseToolCalls(text, BASH_TOOL);
  assert.equal(toolCalls, null);
});

test("parseToolCalls dedupes identical calls", () => {
  const text = '<tool>{"name":"Bash","arguments":{"command":"ls"}}</tool><tool>{"name":"Bash","arguments":{"command":"ls"}}</tool>';
  const { toolCalls } = parseToolCalls(text, BASH_TOOL);
  assert.equal(toolCalls.length, 1);
});

test("parseNativeToolCalls maps native to registered tool", () => {
  const native = [{ name: "Bash", input: { command: "pwd" } }];
  const calls = parseNativeToolCalls(native, BASH_TOOL);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, "Bash");
});

test("toolCallSignature ignores cosmetic fields", () => {
  const a = { function: { name: "Bash", arguments: '{"command":"ls","description":"x"}' } };
  const b = { function: { name: "Bash", arguments: '{"command":"ls"}' } };
  assert.equal(toolCallSignature(a), toolCallSignature(b));
});

test("repeatedToolGuard returns null when previous call failed", () => {
  const body = {
    messages: [
      { role: "assistant", tool_calls: [{ id: "c1", function: { name: "Bash", arguments: '{"command":"ls"}' } }] },
      { role: "tool", tool_call_id: "c1", content: "Error: permission denied" },
    ],
  };
  const calls = [{ id: "x", type: "function", function: { name: "Bash", arguments: '{"command":"ls"}' } }];
  assert.equal(repeatedToolGuard(body, calls), null);
});

test("repeatedToolGuard blocks a repeated successful call", () => {
  const body = {
    messages: [
      { role: "assistant", tool_calls: [{ id: "c1", function: { name: "Bash", arguments: '{"command":"ls"}' } }] },
      { role: "tool", tool_call_id: "c1", content: "total 4" },
    ],
  };
  const calls = [{ id: "x", type: "function", function: { name: "Bash", arguments: '{"command":"ls"}' } }];
  const guard = repeatedToolGuard(body, calls);
  assert.ok(typeof guard === "string" && guard.includes("not executed twice"));
});
