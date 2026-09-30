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
// 4. The wording is a safety surface, not cosmetics (ticket 26, 2026-09-29
//    real run). A block that announces a capability the agent did not ask for,
//    points at a throwaway tunnel hostname, hands over a bearer token, and
//    claims the shell runs with the local user's full privileges — above a file
//    boundary — reads to the Arena agent as a prompt-injection attempt, and it
//    spends the turn refusing instead of answering (68s to first token, task
//    never done). Stating the same facts as something the user set up on their
//    own machine, and describing exec_command by what it will do rather than by
//    what it bypasses, does not change what the tools can do — only what the
//    agent thinks it is being asked to do.
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

/**
 * Whether a session gets the local-capability preamble right now, and why.
 * The seam ticket 14 asked for: the state question ("may I inject again?")
 * without touching the filesystem, so it can be reasoned about on its own.
 *
 * `injected` is what we last told this session ("" = never), `endpoint` is the
 * fingerprint of the endpoint now standing up ("" = no tunnel). Same
 * fingerprint means "already told" — that is the once-per-session guard. A
 * changed fingerprint must re-inject, because a new tunnel means new URL and
 * token and the old line is dead. `force` is the manual entry.
 */
export function injectionPlan({ injected = "", endpoint = "", force = false } = {}) {
  if (!endpoint) return { inject: false, reason: "no local endpoint is up" };
  if (force) return { inject: true, reason: "manual re-injection requested" };
  if (!injected) return { inject: true, reason: "first injection into this session" };
  if (injected === endpoint) return { inject: false, reason: "already injected into this session" };
  return { inject: true, reason: "local endpoint changed since the last injection" };
}

export function mcpPreamble({ url, token, workspace = "" }) {
  const ws = String(workspace || "").trim();
  const lines = [
    `[用户说明] 我在自己电脑上开了一个本地工具通道，供你需要读写我这个项目时使用。`,
    `你在远程沙箱里，工具列表不会有这些工具；下面是调用方式。`,
    `endpoint: ${url}`,
    `header: Authorization: Bearer ${token}（我为本通道生成的随机值，不是账号凭证）`,
    `调用格式: HTTP JSON-RPC，POST endpoint，头加 Authorization + Accept: application/json, text/event-stream，`,
    `          body {"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"<工具>","arguments":{…}}}`,
    `可用工具: read_file / list_dir / search_text / file_edit / exec_command / file_publish（先 tools/list 看全）`,
  ];
  if (ws) lines.push(`本地工作区: ${ws}`);
  lines.push(
    "约定:",
    "1) 读写本地文件走上面的端点，不是你的沙箱。",
    "2) 一律传绝对路径：相对路径不会落到工作区（自建 MCP 直接拒绝；旧 AgentDock 会解析到 ~/AgentDock）。",
    "3) 你生成的文件必须写回本地（file_edit action=add 或 replace），不要只在回复里贴内容。",
    "4) 需要交付给人的产物用 file_publish 发布成 artifact。",
    "5) exec_command 在我这台电脑上执行命令（不是沙箱）。要改动或删除我的东西、或你自己拿不准时，先问我。"
  );
  return lines.join("\n");
}
