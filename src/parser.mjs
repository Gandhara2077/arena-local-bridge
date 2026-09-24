// parser.mjs — parses Arena Agent SSE output into text/reasoning/tokens and
// converts tool requests (XML text or native events) into Claude-Code
// OpenAI-style tool_calls with validation and duplicate guards.
import crypto from "node:crypto";
import { record, looseJson } from "./util.mjs";
import { requestedTools, contentText } from "./format.mjs";

export function parsePublicToken(html) {
  for (const re of [
    /\\"publicAccessToken\\":\\"([^\\"]+)/,
    /"publicAccessToken":"([^"]+)"/,
    /publicAccessToken[^A-Za-z0-9_-]+([A-Za-z0-9._-]{80,})/,
  ]) {
    const m = String(html || "").match(re);
    if (m) return m[1];
  }
  return "";
}

/**
 * Parse the SSE stream returned by /ai-proxy/realtime/v1/sessions/:id/out.
 * Returns { text, reasoning, token, lastNodeId, lastEventId, requiresReview, nativeCalls }.
 */
export function parseAgentOutput(raw) {
  let text = "";
  let reasoning = "";
  let token = "";
  let lastNodeId = null;
  let lastEventId = "";
  let requiresReview = false;
  const nativeById = new Map();
  const nativeCalls = [];
  const normalizedRaw = String(raw || "").replace(/\r\n/g, "\n");
  const finalBoundary = normalizedRaw.lastIndexOf("\n\n");
  const completeRaw = finalBoundary >= 0 ? normalizedRaw.slice(0, finalBoundary) : "";
  for (const block of completeRaw.split(/\n\n+/)) {
    const blockLines = block.split("\n");
    const idLine = blockLines.find((line) => line.startsWith("id: "));
    if (idLine) lastEventId = idLine.slice(4).trim();
    const dataLine = blockLines.find((line) => line.startsWith("data: "));
    if (!dataLine) continue;
    let event;
    try {
      event = JSON.parse(dataLine.slice(6));
    } catch {
      continue;
    }
    for (const record of Array.isArray(event.records) ? event.records : []) {
      if (Array.isArray(record.headers)) {
        for (const [name, value] of record.headers) {
          if (String(name).toLowerCase() === "public-access-token") token = String(value);
        }
      }
      if (!record.body) continue;
      let body;
      try {
        body = JSON.parse(record.body);
      } catch {
        continue;
      }
      const data = body.data || {};
      if (data.type === "text-delta" && typeof data.delta === "string") text += data.delta;
      if ((data.type === "reasoning-delta" || data.type === "thinking-delta") && typeof data.delta === "string")
        reasoning += data.delta;
      if (data.type === "tool-input-start" && data.toolCallId) {
        nativeById.set(String(data.toolCallId), {
          id: String(data.toolCallId),
          name: String(data.toolName || ""),
          rawInput: "",
        });
      }
      if (data.type === "tool-input-delta" && data.toolCallId) {
        const id = String(data.toolCallId);
        const current = nativeById.get(id) || { id, name: String(data.toolName || ""), rawInput: "" };
        current.rawInput += String(data.inputTextDelta || "");
        nativeById.set(id, current);
      }
      if ((data.type === "tool-input-available" || data.type === "tool-input-error") && data.toolCallId) {
        const id = String(data.toolCallId);
        const current = nativeById.get(id) || { id, name: "", rawInput: "" };
        current.name = String(data.toolName || current.name || "");
        current.input = data.input && typeof data.input === "object" ? data.input : looseJson(current.rawInput);
        if (!current.emitted && current.input && typeof current.input === "object") {
          current.emitted = true;
          nativeCalls.push(current);
        }
        nativeById.set(id, current);
      }
      if (data.type === "finish") {
        lastNodeId = data.messageMetadata?.nodeId || lastNodeId;
        requiresReview = data.messageMetadata?.requiresReview === true;
      }
    }
  }
  return { text, reasoning, token, lastNodeId, lastEventId, requiresReview, nativeCalls };
}

export function externalToolDefinition(tools, name) {
  return (Array.isArray(tools) ? tools : [])
    .map((item) => record(item).function)
    .find((fn) => fn && fn.name === name);
}

export function resolveNativeToolName(nativeName, tools) {
  const requested = requestedTools(tools);
  const byNorm = new Map(requested.map((tool) => [tool.normalized, tool.name]));
  const normalized = String(nativeName || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const aliases = {
    shell: "Bash",
    bash: "Bash",
    executecommand: "Bash",
    readfile: "Read",
    writefile: "Write",
    editfile: "Edit",
    askuser: "AskUserQuestion",
    askuserquestion: "AskUserQuestion",
    websearch: "WebSearch",
    fetchpage: "WebFetch",
    webfetch: "WebFetch",
    glob: "Glob",
    grep: "Grep",
  };
  const exact = byNorm.get(normalized);
  if (exact) return exact;
  const alias = aliases[normalized];
  return alias && requested.some((tool) => tool.name === alias) ? alias : "";
}

export function normalizeAskUserArguments(args) {
  const sourceQuestions = Array.isArray(args.questions)
    ? args.questions
    : args.question
      ? [
          {
            question: args.question,
            header: args.header,
            options: args.options,
            multiSelect: args.multiSelect,
          },
        ]
      : [];
  const questions = sourceQuestions.slice(0, 4).map((raw, index) => {
    const question = record(raw);
    const options = (Array.isArray(question.options) ? question.options : [])
      .slice(0, 4)
      .map((rawOption) => {
        const option = record(rawOption);
        return {
          label: String(option.label || option.id || "Option").slice(0, 80),
          description: String(option.description || option.label || option.id || "Option"),
          ...(typeof option.preview === "string" ? { preview: option.preview } : {}),
        };
      });
    while (options.length < 2) {
      options.push({
        label: options.length ? "Other choice" : "Continue",
        description: options.length ? "Choose another available approach" : "Continue with the proposed approach",
      });
    }
    return {
      question: String(question.question || `Please choose an option for question ${index + 1}?`),
      header: String(question.header || "Choice").slice(0, 12),
      options,
      multiSelect: question.multiSelect === true,
    };
  });
  return { questions };
}

export function normalizeNativeArguments(externalName, input) {
  const args = { ...record(input) };
  if (["Read", "Write", "Edit", "NotebookEdit"].includes(externalName) && args.file_path === undefined && args.path !== undefined) {
    args.file_path = args.path;
  }
  if (externalName === "Edit") {
    if (args.old_string === undefined && args.old_text !== undefined) args.old_string = args.old_text;
    if (args.new_string === undefined && args.new_text !== undefined) args.new_string = args.new_text;
  }
  if (externalName === "AskUserQuestion") return normalizeAskUserArguments(args);
  if (externalName === "WebFetch" && args.url === undefined && args.href !== undefined) args.url = args.href;
  if (externalName === "WebSearch" && args.query === undefined && args.search_query !== undefined) args.query = args.search_query;
  return args;
}

export function minimallyValidAgainstSchema(value, schema, depth = 0) {
  if (!schema || typeof schema !== "object" || depth > 5) return true;
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((item) => minimallyValidAgainstSchema(value, item, depth + 1)))
    return false;
  if (Array.isArray(schema.oneOf) && !schema.oneOf.some((item) => minimallyValidAgainstSchema(value, item, depth + 1)))
    return false;
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    if (Array.isArray(schema.required) && schema.required.some((key) => value[key] === undefined || value[key] === null))
      return false;
    const properties = record(schema.properties);
    return Object.entries(properties).every(
      ([key, child]) => value[key] === undefined || minimallyValidAgainstSchema(value[key], child, depth + 1)
    );
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) return false;
    if (Number.isFinite(schema.minItems) && value.length < schema.minItems) return false;
    if (Number.isFinite(schema.maxItems) && value.length > schema.maxItems) return false;
    return !schema.items || value.every((item) => minimallyValidAgainstSchema(item, schema.items, depth + 1));
  }
  if (schema.type === "string" && typeof value !== "string") return false;
  if ((schema.type === "number" || schema.type === "integer") && typeof value !== "number") return false;
  if (schema.type === "boolean" && typeof value !== "boolean") return false;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  return true;
}

export function prepareExternalToolCall(name, rawInput, tools, idPrefix = "arena_agent", index = 0) {
  const definition = externalToolDefinition(tools, name);
  if (!definition) return null;
  let input = rawInput;
  if (typeof input === "string") input = looseJson(input);
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const normalized = normalizeNativeArguments(name, input);
  const parameters = record(definition.parameters);
  const properties = record(parameters.properties);
  const args = Object.keys(properties).length
    ? Object.fromEntries(Object.entries(normalized).filter(([key]) => Object.hasOwn(properties, key)))
    : normalized;
  const required = Array.isArray(parameters.required) ? parameters.required : [];
  if (required.some((key) => args[key] === undefined || args[key] === null)) return null;
  if (!minimallyValidAgainstSchema(args, parameters)) return null;
  return {
    id: `${idPrefix}_${Date.now()}_${index}_${crypto.randomBytes(3).toString("hex")}`,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

export function parseToolCalls(text, tools, maxParallel = 8) {
  const names = requestedTools(tools);
  const byNorm = new Map(names.map((tool) => [tool.normalized, tool.name]));
  const calls = [];
  const signatures = new Set();
  const ranges = [];
  const re = /<(?:tool|tool_call)>\s*([\s\S]*?)\s*<\/(?:tool|tool_call)>/gi;
  let match;
  while ((match = re.exec(String(text || ""))) && calls.length < maxParallel) {
    const parsed = looseJson(match[1]);
    if (!parsed) continue;
    const emitted = String(parsed.name || parsed.tool || parsed.command || "");
    const normalized = emitted.toLowerCase().replace(/[^a-z0-9]/g, "");
    const exact = names.find((tool) => tool.name === emitted)?.name;
    const resolved = exact || byNorm.get(normalized) || resolveNativeToolName(emitted, tools);
    if (!resolved) continue;
    const args = parsed.arguments ?? parsed.input ?? parsed.params ?? {};
    const call = prepareExternalToolCall(resolved, args, tools, "arena_agent_text", calls.length);
    if (!call) continue;
    const signature = toolCallSignature(call);
    if (signatures.has(signature)) continue;
    signatures.add(signature);
    calls.push(call);
    ranges.push([match.index, re.lastIndex]);
  }
  let content = String(text || "");
  for (const [start, end] of ranges.reverse()) content = content.slice(0, start) + content.slice(end);
  return { content: content.trim(), toolCalls: calls.length ? calls : null };
}

export function parseNativeToolCalls(nativeCalls, tools, maxParallel = 8) {
  const calls = [];
  const signatures = new Set();
  for (const nativeCall of Array.isArray(nativeCalls) ? nativeCalls : []) {
    if (calls.length >= maxParallel) break;
    const name = resolveNativeToolName(nativeCall.name, tools);
    if (!name) continue;
    const call = prepareExternalToolCall(name, nativeCall.input, tools, "arena_agent_native", calls.length);
    if (!call) continue;
    const signature = toolCallSignature(call);
    if (signatures.has(signature)) continue;
    signatures.add(signature);
    calls.push(call);
  }
  return calls.length ? calls : null;
}

export function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

export function toolCallSignature(call) {
  const fn = record(call?.function);
  const name = String(fn.name || "");
  const parsed = typeof fn.arguments === "string" ? looseJson(fn.arguments) : fn.arguments;
  const args = record(parsed);
  const primaryByTool = {
    Bash: ["command"],
    Read: ["file_path", "offset", "limit", "pages"],
    Write: ["file_path", "content"],
    Edit: ["file_path", "old_string", "new_string", "replace_all"],
    Glob: ["pattern", "path"],
    Grep: ["pattern", "path", "glob", "type", "output_mode"],
    WebFetch: ["url", "prompt"],
    WebSearch: ["query", "allowed_domains", "blocked_domains"],
  };
  const keys = primaryByTool[name];
  const identity = keys
    ? Object.fromEntries(keys.filter((key) => args[key] !== undefined).map((key) => [key, args[key]]))
    : Object.fromEntries(Object.entries(args).filter(([key]) => !["description", "timeout"].includes(key)));
  return `${name}:${JSON.stringify(stableValue(identity))}`;
}

export function toolResultLooksFailed(message, text) {
  if (message?.is_error === true || message?.error === true) return true;
  try {
    const parsed = JSON.parse(String(text || ""));
    if (parsed?.is_error === true || parsed?.status === "error" || parsed?.success === false) return true;
  } catch {
    /* not json */
  }
  return /^(?:error\b|failed\b|permission denied\b|command failed\b|tool error\b|exception\b)/i.test(
    String(text || "").trim()
  );
}

export function repeatedToolGuard(body, toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return null;
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const previousCalls = [];
  let latestResult = "";
  let latestName = "tool";
  let latestFailed = false;
  const namesById = new Map();
  for (const message of messages) {
    if (message?.role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        const fn = record(call?.function);
        previousCalls.push(toolCallSignature(call));
        if (call?.id) namesById.set(call.id, String(fn.name || "tool"));
      }
    }
    if (message?.role === "tool") {
      latestResult = contentText(message.content);
      latestName = namesById.get(message.tool_call_id) || String(message.name || "tool");
      latestFailed = toolResultLooksFailed(message, latestResult);
    }
  }
  if (!latestResult || latestFailed) return null;
  const repeated = toolCalls.every((call) => previousCalls.includes(toolCallSignature(call)));
  if (!repeated) return null;
  return [
    `The external ${latestName} operation already succeeded and was intentionally not executed twice.`,
    "Authoritative result:",
    String(latestResult),
  ].join("\n");
}
