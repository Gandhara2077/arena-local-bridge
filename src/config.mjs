// config.mjs — environment parsing + fail-fast validation (standalone, neutral).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectBrowser } from "./browser-detect.mjs";

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
    // ADR 0005 — the portable release ships no Chromium, so a browser already
    // on this machine is the first choice. ARENA_AGENT_CHROME still wins: it is
    // the manual entry for when we looked in the wrong places.
    chromePath: env.ARENA_AGENT_CHROME || detectBrowser({ env }).path,
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
    // §4.33 — how long a FINISHED turn may be replayed instead of being re-sent to
    // Arena (guards a client retry that arrives after the run already completed).
    // Only requests carrying an explicit identity are ever replayed, so re-asking
    // the same thing by hand always starts a new turn. 0 disables.
    resultCacheTtlMs: Number(env.ARENA_RESULT_CACHE_TTL_MS || 120_000),
    // A public endpoint is published only while an explicitly enabled tunnel
    // is up. A loopback listener alone is never injected into Arena.
    mcpEndpointFile: env.ARENA_MCP_ENDPOINT_FILE || path.join(dataDir, "mcp-endpoint.json"),
    mcpRuntime: String(env.ARENA_MCP_RUNTIME || "local").trim().toLowerCase(),
    localMcpPort: Number(env.ARENA_LOCAL_MCP_PORT ?? 8765),
    cloudflaredPath: String(env.ARENA_CLOUDFLARED_PATH || "").trim(),
    // Optional compatibility runtime; there is no install-directory probing.
    agentdockDir: String(env.ARENA_AGENTDOCK_DIR || "").trim(),
    // Explicit startup workspace. The GUI may supply one instead; neither
    // recent transcripts nor a client header can grant roots to the listener.
    mcpWorkspace: String(env.ARENA_MCP_WORKSPACE || "").trim(),
    // ADR 0008 — skill roots the user EXPLICITLY listed (path.delimiter-
    // separated absolute directories, e.g. ARENA_SKILL_ROOTS="C:\a;C:\b").
    // They become read-only roots next to the workspace; anything unlisted
    // stays outside the boundary, so the home is never opened wholesale.
    skillRoots: parseRootList(env.ARENA_SKILL_ROOTS, "ARENA_SKILL_ROOTS"),
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
  if (!["local", "agentdock"].includes(config.mcpRuntime)) {
    throw new Error(`Invalid ARENA_MCP_RUNTIME: ${config.mcpRuntime}`);
  }
  if (!Number.isInteger(config.localMcpPort) || config.localMcpPort < 0 || config.localMcpPort > 65535) {
    throw new Error(`Invalid ARENA_LOCAL_MCP_PORT: ${config.localMcpPort}`);
  }
  if (config.cloudflaredPath && !path.isAbsolute(config.cloudflaredPath)) {
    throw new Error("ARENA_CLOUDFLARED_PATH must be an absolute executable path");
  }
  return config;
}

function parseRootList(raw, label) {
  return String(raw || "")
    .split(path.delimiter)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      // decidePath resolves every root against the process cwd; letting a
      // relative path through would silently grant a directory that depends
      // on where the bridge was started from. Fail fast at the config gate.
      if (!path.isAbsolute(part)) {
        throw new Error(`${label} entries must be absolute paths: ${part}`);
      }
      return part;
    });
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
