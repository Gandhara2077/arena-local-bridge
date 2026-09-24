// format.mjs — converts OpenAI/Claude-Code messages into the exact prompt
// shape the Arena Agent composer accepts, plus the external-tool transport
// contract. Preserved 1:1 from the proven v4.1 behavior.
import crypto from "node:crypto";
import { record, compactText, compactSchema } from "./util.mjs";

export function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      const item = record(part);
      if (typeof item.text === "string") return item.text;
      if (item.type === "tool_result") {
        const inner = typeof item.content === "string" ? item.content : JSON.stringify(item.content ?? "");
        return `Tool result (${item.tool_use_id || "tool"}): ${inner}`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function requestedTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .map((raw) => record(raw).function)
    .filter((fn) => fn && typeof fn.name === "string")
    .map((fn) => ({
      name: fn.name,
      normalized: fn.name.toLowerCase().replace(/[^a-z0-9]/g, ""),
      description: typeof fn.description === "string" ? compactText(fn.description.replace(/\s+/g, " "), 220) : "",
      parameters: compactSchema(fn.parameters),
    }));
}

export function toolSystemPrompt(tools, includeSchemas = false) {
  const list = requestedTools(tools);
  if (!list.length) return "";
  return [
    "CRITICAL CLAUDE CODE EXTERNAL-TOOL TRANSPORT CONTRACT (applies to this turn):",
    "- You are reasoning for Claude Code on the user's real machine. Arena's workspace is NOT the user's machine.",
    "- NEVER invoke Arena built-in tools/functions (shell, Bash, write_file, read_file, edit_file, ask_user, web, browser, or agents).",
    "- To request an action, PRINT a literal plain-text XML block and nothing else:",
    '  <tool>{"name":"EXACT_EXTERNAL_NAME","arguments":{...}}</tool>',
    "- The XML is ordinary visible text, NOT an Arena function call. Do not execute it yourself.",
    "- You may print multiple <tool> blocks only when the actions are independent and safe to run in parallel.",
    "- Use exact external names and valid JSON. Never invent results. After emitting blocks, stop and wait for Tool results.",
    "- A completed Tool result is authoritative. Never repeat the same successful call. If it failed, diagnose and issue a corrected call.",
    "- Ask through AskUserQuestion only for a genuinely blocking decision; otherwise make a sensible engineering choice and proceed.",
    "- Keep chain-of-thought private. Return concise progress/final results outside tool calls.",
    `External tool names: ${list.map((t) => t.name).join(", ")}`,
    ...(includeSchemas
      ? [
          "External schemas:",
          ...list.map(
            (t) => `- ${t.name}${t.description ? `: ${t.description}` : ""}\n  schema: ${JSON.stringify(t.parameters)}`
          ),
        ]
      : []),
    "REMINDER: do not call an Arena tool. Print literal <tool> JSON text for the bridge instead.",
  ].join("\n");
}

export function formatMessages(messages, includeTools, tools, profile) {
  const sourceMessages = Array.isArray(messages) ? messages : [];
  const lines = [];
  const system = [];
  let sawToolActivity = false;
  const callNames = new Map();
  const currentMessage = [...sourceMessages].reverse().find((m) => ["user", "tool"].includes(String(m?.role || "")));
  const currentRole = String(currentMessage?.role || "user");
  const currentText = compactText(
    contentText(currentMessage?.content)
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "")
      .trim(),
    24_000
  );
  const stripReminders = (value) =>
    String(value).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "");
  for (const raw of sourceMessages) {
    const message = record(raw);
    const role = String(message.role || "user");
    let text = stripReminders(contentText(message.content)).trim();
    text = compactText(text, role === "system" ? 12_000 : 24_000).trim();
    if (role === "system" || role === "developer") {
      if (/^You are Claude Code, Anthropic's official CLI for Claude\./.test(text)) {
        text = [
          "Runtime context: you are the production-grade coding/reasoning engine behind Claude Code on the user's real machine.",
          "Solve the CURRENT TURN autonomously and precisely. Inspect relevant files before edits, make minimal correct changes, run appropriate verification, and continue the tool loop until the task is actually complete.",
          "For coding tasks: understand the repository first, preserve its conventions, avoid placeholders, handle errors and edge cases, protect secrets, and verify with the narrowest useful tests/lint/typecheck/build.",
          "Never claim an action succeeded without its external Tool result. Never use Arena's remote workspace or built-in tools.",
          "Use the external-tool transport below for every filesystem, shell, web, question, todo, workflow, or agent action. Use parallel calls only when independent.",
          "Do not over-plan or ask unnecessary questions. Make reversible sensible defaults; ask only when a decision is truly blocking or destructive.",
          "Prior messages are context only; never answer an earlier user message instead of the CURRENT TURN. Match the user's language (including Persian/Finglish).",
        ].join(" ");
      }
      if (text) system.push(text);
      continue;
    }
    if (role === "assistant") {
      if (/^Available agent types for the Agent tool:/.test(text)) continue;
      const parts = [];
      if (text) parts.push(text);
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        const fn = record(record(call).function);
        const name = typeof fn.name === "string" ? fn.name : "";
        const args = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments || {});
        if (call.id) callNames.set(call.id, name);
        parts.push(`<tool>{"name":${JSON.stringify(name)},"arguments":${args || "{}"}}</tool>`);
        sawToolActivity = true;
      }
      if (parts.length) lines.push(`Assistant: ${parts.join("\n")}`);
      continue;
    }
    if (role === "tool") {
      const name = callNames.get(message.tool_call_id) || message.name || "tool";
      lines.push(`Tool result (${name}): ${text || "(no output)"}`);
      sawToolActivity = true;
      continue;
    }
    if (text) lines.push(`User: ${text}`);
  }
  if (sawToolActivity) {
    lines.push(
      "The external tool call above already ran and its Tool result is authoritative. " +
        "Do NOT repeat that successful call. Use the result to choose the next different tool, " +
        "or give the final answer when the task is complete."
    );
  }
  const chunks = [];
  if (currentText) {
    chunks.push(
      currentRole === "tool"
        ? `CURRENT TURN — authoritative external Tool result to process now:\n${currentText}`
        : `CURRENT TURN — answer/execute this latest user request now:\n${currentText}`
    );
  }
  const personal = record(profile);
  if (personal.enabled !== false) {
    chunks.push(
      [
        "PERSONAL ARENA PROFILE (owner-approved preferences):",
        personal.ownerName ? `- Owner: ${compactText(personal.ownerName, 120)}` : "",
        `- Preferred language: ${compactText(personal.language || "fa", 80)}`,
        `- Autonomy: ${compactText(personal.autonomy || "high", 80)}`,
        `- Coding style: ${compactText(personal.codingStyle || "production-grade", 500)}`,
        `- Default stack policy: ${compactText(personal.defaultStack || "follow repository", 500)}`,
        `- Response style: ${compactText(personal.responseStyle || "precise", 300)}`,
        personal.customInstructions ? `- Custom instructions: ${compactText(personal.customInstructions, 4_000)}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    );
  }
  if (system.filter(Boolean).length) chunks.push(system.filter(Boolean).join("\n\n"));
  if (lines.length) chunks.push(compactText(lines.join("\n\n"), 64_000));
  chunks.push(
    "CURRENT-TURN RULE: Respond to the CURRENT TURN at the top of this prompt, not an earlier message. " +
      "Earlier assistant/user text is historical context only. If the current turn is a Tool result, continue from that exact result."
  );
  const contract = toolSystemPrompt(tools, includeTools);
  if (contract) chunks.push(contract);
  else if (requestedTools(tools).length === 0 && currentRole !== "tool") {
    // No external tools registered: tell the model explicitly so it does not
    // reach for Arena's own sandbox tools on a plain chat request.
    chunks.push(
      "NO TOOLS AVAILABLE: This request has no external tools. " +
        "Do not attempt to run, propose, or reference any tool, command, or function. " +
        "Answer the user's request directly with text only."
    );
  }
  return chunks.join("\n\n");
}

export function sessionKey(body, headers) {
  const metadata = record(body.metadata);
  let userSession = "";
  if (typeof metadata.user_id === "string") {
    try {
      userSession = String(JSON.parse(metadata.user_id).session_id || "");
    } catch {
      /* ignore */
    }
  }
  const explicit =
    headers["x-codex-session-id"] ||
    headers["x-session-id"] ||
    headers["x-omniroute-session"] ||
    metadata.session_id ||
    metadata.sessionId ||
    userSession ||
    body.session_id ||
    body.conversation_id ||
    body.prompt_cache_key;
  if (explicit) return String(explicit).slice(0, 512);
  const first = (body.messages || []).find((m) => m.role === "user") || body.messages?.[0] || {};
  return `prompt-${crypto.createHash("sha256").update(contentText(first.content).slice(0, 4096)).digest("hex")}`;
}

export function latestTurn(messages) {
  if (!Array.isArray(messages)) return [];
  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      lastAssistant = i;
      break;
    }
  }
  return lastAssistant >= 0 ? messages.slice(lastAssistant) : messages;
}
