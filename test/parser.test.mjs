import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePublicToken, parseAgentOutput, parseToolCalls, parseNativeToolCalls, toolCallSignature, repeatedToolGuard, prepareExternalToolCall, minimallyValidAgainstSchema } from "../src/parser.mjs";

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

const frame = (data, id = "") => `${id ? `id: ${id}\n` : ""}data: ${JSON.stringify({ records: [{ body: JSON.stringify({ data }) }] })}\n\n`;

test("SSE ignores trailing incomplete frames and preserves complete CRLF events", () => {
  const raw = (frame({ type: "text-delta", delta: "complete" }, "kept")
    + frame({ type: "text-delta", delta: "partial" }, "ignored").trimEnd()).replace(/\n/g, "\r\n");
  const parsed = parseAgentOutput(raw);
  assert.equal(parsed.text, "complete");
  assert.equal(parsed.lastEventId, "kept");
  assert.equal(parseAgentOutput(frame({ type: "text-delta", delta: "partial" }).trimEnd()).text, "");
});

test("SSE malformed frames keep event ids while later reasoning and finish data survive", () => {
  const parsed = parseAgentOutput(frame({ type: "reasoning-delta", delta: "one" })
    + frame({ type: "thinking-delta", delta: "two" })
    + frame({ type: "finish", messageMetadata: { nodeId: "node", requiresReview: true } })
    + 'id: invalid\ndata: not-json\n\n'
    + 'data: {"records":[{"headers":[["PUBLIC-ACCESS-TOKEN","token"]],"body":"bad"}]}\n\n');
  assert.equal(parsed.reasoning, "onetwo");
  assert.equal(parsed.lastNodeId, "node");
  assert.equal(parsed.requiresReview, true);
  assert.equal(parsed.lastEventId, "invalid");
  assert.equal(parsed.token, "token");
});

test("native input deltas without a start are assembled and emitted only once", () => {
  const parsed = parseAgentOutput(frame({ type: "tool-input-delta", toolCallId: "t", toolName: "shell", inputTextDelta: '{"command":' })
    + frame({ type: "tool-input-delta", toolCallId: "t", inputTextDelta: '"pwd"}' })
    + frame({ type: "tool-input-available", toolCallId: "t" })
    + frame({ type: "tool-input-error", toolCallId: "t" }));
  assert.equal(parsed.nativeCalls.length, 1);
  assert.deepEqual(parsed.nativeCalls[0].input, { command: "pwd" });
  assert.equal(parseNativeToolCalls([...parsed.nativeCalls, ...parsed.nativeCalls], BASH_TOOL).length, 1);
});

test("tool extraction retains invalid, duplicate and capped blocks in content", () => {
  const block = (command) => `<tool_call>${JSON.stringify({ name: "execute_command", input: { command, extra: "discard" } })}</tool_call>`;
  const invalid = '<tool>{"name":"Bash","arguments":{"command":3}}</tool>';
  const result = parseToolCalls(`before${invalid}${block("a")}${block("a")}${block("b")}${block("c")}after`, BASH_TOOL, 2);
  assert.deepEqual(result.toolCalls.map((call) => JSON.parse(call.function.arguments)), [{ command: "a" }, { command: "b" }]);
  assert.equal(result.content, `before${invalid}${block("a")}${block("c")}after`);
});

test("schema preparation rejects missing and wrong types and strips unregistered properties", () => {
  assert.equal(prepareExternalToolCall("Bash", {}, BASH_TOOL), null);
  assert.equal(prepareExternalToolCall("Bash", { command: false }, BASH_TOOL), null);
  assert.equal(prepareExternalToolCall("Bash", [], BASH_TOOL), null);
  assert.equal(prepareExternalToolCall("Unknown", {}, BASH_TOOL), null);
  const call = prepareExternalToolCall("Bash", '{"command":"ok","extra":true}', BASH_TOOL);
  assert.deepEqual(JSON.parse(call.function.arguments), { command: "ok" });
  const arraySchema = { type: "array", minItems: 1, maxItems: 2, items: { type: "string", enum: ["ok"] } };
  for (const invalid of [[], ["bad"], ["ok", "ok", "ok"], "ok"]) assert.equal(minimallyValidAgainstSchema(invalid, arraySchema), false);
  assert.equal(minimallyValidAgainstSchema(["ok"], arraySchema), true);
  assert.equal(minimallyValidAgainstSchema(true, { anyOf: [{ type: "string" }, { type: "number" }] }), false);
});

test("public tokens preserve escaped, JSON and loose HTML compatibility", () => {
  assert.equal(parsePublicToken(String.raw`\"publicAccessToken\":\"escaped`), "escaped");
  assert.equal(parsePublicToken('"publicAccessToken":"json"'), "json");
  const longToken = "a".repeat(80);
  assert.equal(parsePublicToken(`publicAccessToken : ${longToken}`), longToken);
  assert.equal(parsePublicToken("missing"), "");
});
