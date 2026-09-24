// config.mjs — environment parsing + fail-fast validation (standalone, neutral).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function loadDotEnv(envPath) {
  const out = {};
  let raw;
  try {
    raw = fs.readFileSync(envPath, "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split("\n")) {
    const i = line.indexOf("=");
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    if (!key) continue;
    const value = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    out[key] = value;
  }
  return out;
}

export function loadConfig(env = {}, { requireBridgeKey = true } = {}) {
  const dataDir = env.DATA_DIR || path.join(os.homedir(), ".arena-bridge");
  const port = Number(env.PORT || 20140);
  const host = env.HOST || "127.0.0.1";
  const bridgeKey = env.ARENA_AGENT_BRIDGE_KEY || "";
  if (requireBridgeKey && !bridgeKey) {
    throw new Error(
      "ARENA_AGENT_BRIDGE_KEY is required. Run install.sh (it auto-generates one) or set it in the environment / DATA_DIR/.env."
    );
  }
  const proxyRaw = env.ARENA_AGENT_PROXY;
  const proxy =
    proxyRaw === undefined || proxyRaw === "" || proxyRaw === "none" ? "" : proxyRaw;
  const config = {
    dataDir,
    envPath: path.join(dataDir, ".env"),
    sessionFile: path.join(dataDir, "sessions.json"),
    credentialsFile: path.join(dataDir, "credentials.json"),
    profileFile: path.join(dataDir, "profile.json"),
    // optional one-time migration from an omni-route style sqlite vault (opt-in)
    omniDbPath: env.ARENA_OMNI_DB || "",
    omniRoot: env.OMNI_ROOT || "",
    host,
    port,
    bridgeKey,
    chromePath: env.ARENA_AGENT_CHROME || "",
    proxy,
    recaptchaSiteKey:
      env.ARENA_RECAPTCHA_SITE_KEY || "6LeTGMcsAAAAALuIlkVwIxaAuZA8VledA6d3Nnb0",
    sessionTtlMs: Number(env.ARENA_SESSION_TTL_MS || 12 * 60 * 60 * 1000),
    refreshMarginSec: Number(env.ARENA_REFRESH_MARGIN_SEC || 1200),
    recaptchaTtlMs: Number(env.ARENA_RECAPTCHA_TTL_MS || 110_000),
    rateLimitRpm: Number(env.ARENA_RATE_LIMIT_RPM || 100),
    maxToolCalls: Number(env.ARENA_MAX_TOOL_CALLS || 8),
    maxQueue: Number(env.ARENA_MAX_QUEUE || 8),
    arenaSessions: env.ARENA_SESSIONS || "",
    archiveDir: env.ARENA_ARCHIVE_DIR || "",
    // §4.23 — what to do when the Arena agent invokes its OWN sandbox tool.
    //   allow (default): let it run and keep reading until the agent's final text
    //   block: stop the remote run and report that tools are not executed
    //   map:   surface the calls as OpenAI tool_calls for the client to execute
    toolPolicy: String(env.ARENA_TOOL_POLICY || "allow").toLowerCase(),
    toolAllowBudgetMs: Number(env.ARENA_TOOL_ALLOW_BUDGET_MS || 0), // 0 = no deadline for tool-turn follow-up reads (§4.37)
    toolAllowMaxReads: Number(env.ARENA_TOOL_ALLOW_MAX_READS || 8),
    // §4.35 / §4.37 — a turn may legitimately run for minutes (several tool
    // steps). The old 110s read budget cut those off mid-turn, which looked like
    // the client "stopping" while Arena was still working. Content streams
    // continuously now, so a generous budget is safe. Default 0 = NO budget: the
    // bridge waits for Arena indefinitely and NEVER aborts the read on its own
    // (a self-abort is exactly what made Codex time out and retry). Set
    // ARENA_READ_BUDGET_MS to a positive ms value to cap it.
    readBudgetMs: Number(env.ARENA_READ_BUDGET_MS || 0),
    // §4.36 — ask the agent to echo a per-request random marker on the last line.
    // Seeing it means the turn really finished (no need to infer from finishes or
    // quiet gaps). Fresh nonce per request ⇒ it can never appear in replayed
    // history, so it doubles as "this is OUR turn".
    turnMarkerEnabled: String(env.ARENA_TURN_MARKER ?? "1") !== "0",
    // §4.30 — bounded re-reads when /out ends (or only replays) without our answer.
    readRetryMax: Number(env.ARENA_READ_RETRY_MAX || 3),
    readRetryDelayMs: Number(env.ARENA_READ_RETRY_DELAY_MS || 3_000),
    // §4.33 — how long an identical request may be answered from cache instead of
    // being re-sent to Arena (guards client retries after a timeout). Kept short
    // on purpose: re-asking the same thing by hand inside this window would also
    // hit the cache. 0 disables.
    resultCacheTtlMs: Number(env.ARENA_RESULT_CACHE_TTL_MS || 120_000),
    // §4.25 — file written by start-arena-mcp.ps1 while the tunnel is up
    // ({ url, token }); absent/empty => no injection.
    mcpEndpointFile: env.ARENA_MCP_ENDPOINT_FILE || path.join(dataDir, "mcp-endpoint.json"),
    // §4.26 — folder holding agentdock.exe + cloudflared.exe (GUI 一键启动用)
    agentdockDir: env.ARENA_AGENTDOCK_DIR || detectAgentdockDir(),
    // Which local directory this conversation is about. The MCP preamble tells
    // the Arena agent to write generated files here — without it, AgentDock's
    // relative paths resolve to ~/AgentDock, which is not the user's project.
    // Unset => the preamble simply omits the workspace line.
    mcpWorkspace: String(env.ARENA_MCP_WORKSPACE || "").trim(),
    // Codex writes one transcript per conversation under here, carrying both the
    // session id (which Codex sends as x-codex-session-id) and the working
    // directory it ran in — enough to recover a conversation's workspace with no
    // client-side configuration.
    codexSessionsDir: env.ARENA_CODEX_SESSIONS_DIR || path.join(os.homedir(), ".codex", "sessions"),
    // How recently a Codex transcript must have been written to be treated as
    // "the conversation calling us right now". Only used when exactly one
    // transcript falls inside the window — see resolveRecentCodexWorkspace.
    codexRecentWindowMs: Number(env.ARENA_CODEX_RECENT_WINDOW_MS || 120_000),
    migrateFromOmni: String(env.ARENA_MIGRATE_FROM_OMNI ?? "0") === "1",
    profile: loadProfile(path.join(dataDir, "profile.json")),
  };
  if (!Number.isFinite(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error(`Invalid PORT: ${config.port}`);
  }
  return config;
}

// §4.26 — find an AgentDock install under ~/Downloads (…/AgentDock-*/agentdock.exe)
// so the GUI works without setting ARENA_AGENTDOCK_DIR by hand.
function detectAgentdockDir() {
  try {
    const downloads = path.join(os.homedir(), "Downloads");
    for (const name of fs.readdirSync(downloads)) {
      if (!/^agentdock/i.test(name)) continue;
      const dir = path.join(downloads, name);
      if (fs.existsSync(path.join(dir, "agentdock.exe"))) return dir;
    }
  } catch {
    /* ignore */
  }
  return "";
}

function loadProfile(profileFile) {
  const defaults = {
    enabled: true,
    ownerName: "",
    language: "fa",
    autonomy: "high",
    codingStyle: "production-grade, clean, modular, secure",
    defaultStack: "Follow the repository; ask only if the stack is genuinely ambiguous",
    responseStyle: "concise progress, precise final summary",
    customInstructions: "",
  };
  try {
    const parsed = JSON.parse(fs.readFileSync(profileFile, "utf8"));
    return { ...defaults, ...(parsed && typeof parsed === "object" ? parsed : {}) };
  } catch {
    return defaults;
  }
}
