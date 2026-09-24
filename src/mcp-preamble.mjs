// mcp-preamble.mjs — the block prepended once to a session when the local
// AgentDock MCP tunnel is up.
//
// Three things this has to get right, each learned from a real failure:
//
// 1. The agent's own tool list will NOT contain these tools. The Arena agent runs
//    in a remote sandbox, so it can only reach this machine over HTTP. Saying
//    "use the file_edit tool" makes it answer "I have no such tool" — observed.
//    So the preamble states the transport, not just the capability.
// 2. AgentDock resolves RELATIVE paths against ~/AgentDock, which is not the
//    user's project, so an agent writing "report.md" lands it somewhere nobody
//    looks.
// 3. An agent that only pastes generated content into its reply has not
//    delivered a file.
//
// Kept deliberately short: long first messages raise Arena's reCAPTCHA risk.
export const WORKSPACE_HEADER = "x-arena-workspace";

/** The header a caller uses to say which local directory this conversation is about. */
export function workspaceFromHeaders(headers) {
  const raw = String(headers?.[WORKSPACE_HEADER] || "").trim();
  if (!raw) return "";
  const absolute = /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("\\\\") || raw.startsWith("/");
  return absolute ? raw : "";
}

export function mcpPreamble({ url, token, workspace = "" }) {
  const ws = String(workspace || "").trim();
  const lines = [
    `[本地 MCP 已接入] 你的工具列表里不会有这些工具，请用 bash 走 HTTP JSON-RPC 调用：`,
    `endpoint: ${url}`,
    `header: Authorization: Bearer ${token}`,
    `调用格式: POST endpoint，头加 Authorization + Accept: application/json, text/event-stream，`,
    `          body {"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"<工具>","arguments":{…}}}`,
    `可用工具: read_file / list_dir / search_text / file_edit / exec_command / file_publish（先 tools/list 看全）`,
  ];
  if (ws) lines.push(`本地工作区: ${ws}`);
  lines.push(
    "约定:",
    "1) 读写本地文件走上面的端点，不是你的沙箱。",
    "2) 相对路径会解析到 ~/AgentDock，不是工作区——要落到工作区请传绝对路径。",
    "3) 你生成的文件必须写回本地（file_edit action=add 或 replace），不要只在回复里贴内容。",
    "4) 需要交付给人的产物用 file_publish 发布成 artifact。"
  );
  return lines.join("\n");
}
