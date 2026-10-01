// server.mjs — OpenAI-compatible HTTP surface (drop-in for the omni bridge):
//   GET  /health /ready /metrics /v1/models /models
//   POST /v1/chat/completions /chat/completions  (stream + non-stream)
//   POST /recaptcha
// Includes Bearer auth, rate limiting, request-size limits and precise errors.
//
// arena-local-bridge contract: a UUID `model` (e.g. "01a0b8d8-...") is treated as
// an EXISTING Arena session id and routed to the converse-only driver (never
// creates a session — session creation + model selection belong to the
// Arena模型助手 real browser). Any non-UUID `model` uses the legacy runAgent flow.
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./util.mjs";
import { AgentDockManager } from "./agentdock.mjs";
import { stats as archiveStats, readEntries, removeEntries, sessionAccountEmail, sessionIdFromUrl, updateModel } from "./archive.mjs";
import { Harvester } from "./harvest.mjs";
import { BatchTest } from "./batchtest.mjs";
import { readSnapshot } from "./probe/index.mjs";
import { identify, bankStatus, variantIds, probePrompt } from "./fingerprint/index.mjs";
import { VERSION } from "./version.mjs";
import {
  bind,
  clientSessionId,
  emptyState,
  forgetSession,
  groupSessions,
  markDead,
  markOk,
  markUsed,
  resolveBinding,
  setAccountQuota,
  unbind,
} from "./pool.mjs";
import { WORKSPACE_HEADER } from "./mcp-preamble.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── ModelPool state ───────────────────────────────────────────────────────
// 记录.json stays the single source of truth for session BUSINESS data. This
// sidecar only holds derived state (ok / suspected-dead, last used, bindings).
// It is disposable: delete it and every session simply reads as `ok` again.
function poolStateFile(config) {
  return path.join(config.dataDir, "pool-state.json");
}

function loadPoolState(config) {
  try {
    const parsed = JSON.parse(fs.readFileSync(poolStateFile(config), "utf8"));
    if (parsed && typeof parsed === "object" && parsed.sessions && parsed.bindings) {
      // A sidecar from a future/older shape would be silently misread; drop it.
      if (parsed.version === emptyState().version) return parsed;
    }
  } catch {
    /* missing or corrupt sidecar: start clean */
  }
  return emptyState();
}

/** The one place the "nothing picked in the GUI" 409 is worded. */
function noActiveSessionError() {
  return Object.assign(
    new Error(
      'No active session selected. Open the GUI (http://127.0.0.1:20140/), click "选用此模型" on a session, ' +
        'then retry — or pass model as that session UUID directly. Note: model:"active" only works after a session is selected.'
    ),
    { status: 409, code: "no_active_session" }
  );
}

/**
 * 补标 — drive one real turn to make the probe learn a Model, then read the
 * probe and hand the Model back for archiving.
 *
 * The owner is resolved ONCE and drives both steps, and both sit inside one
 * lease, so a credential refresh cannot swap the context between the run and the
 * read that attributes its Model. Reading the probe through the pool's default
 * pick instead would answer with whichever Account ran last and write THAT
 * Model into this Session — which is why the two steps are inseparable here
 * rather than a line apart at the call site.
 *
 * `forSession` is used directly, with no wrapper: it already owns this policy —
 * the owner wins, an owner-less (legacy) Session falls back to the pool's
 * primary, and an owner that cannot be used is a 409. A wrapper here that
 * restated that policy is exactly where it got restated wrong once.
 *
 * A failed turn skips the read: nothing new ran, so the only thing a read could
 * return is the previous run's Model.
 *
 * Extracted from the request handler so this — the part that has actually been
 * wrong once — can be driven directly in a test.
 */
export async function runReprobe({ bridge, sessionId, accountEmail, prompt }) {
  try {
    // The Session's owner — or the pool's primary when the archive has none
    // (legacy records predate the Email column). An owner that cannot be used
    // throws, and the report keeps the shape the endpoint already answered with.
    const account = bridge.credentials.forSession(accountEmail);
    const found = await bridge.browser.withAccount(account, async () => {
      await bridge.converse(
        sessionId,
        { messages: [{ role: "user", content: prompt }] },
        { injectMcp: false, account, accountEmail, purpose: "reprobe" }
      );
      // The same page the turn above just ran on, by the same purpose: it is
      // the one holding that run's state. Up to 20s on it, hence the lease.
      return readSnapshot(await bridge.browser.getPage(account, "reprobe"), { timeoutMs: 20_000 });
    });
    return { found, failure: null };
  } catch (error) {
    return { found: null, failure: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 补标 via the numeric fingerprint — the path that still works now that the
 * probe's route to a model name is gone.
 *
 * The probe used to learn the Model by observing a run. That route is closed:
 * Arena no longer issues the run-scoped token the trace needs, and nothing else
 * in agent mode carries a model id. What it leaves us is the reply itself, and
 * the reply is enough to fingerprint.
 *
 * This runs a probe turn, attributes the answer against the collected bank, and
 * reports what it got. It is deliberately explicit about the three outcomes:
 *
 *   attributed — a model name, with the margin that earned it
 *   unresolved — a fingerprint was taken but did not clear the gate; the near
 *                miss is reported and NOTHING is written to the archive
 *   failed     — no usable fingerprint, so no claim at all
 *
 * Writing only on a cleared gate is the whole point. The archive's Model column
 * is read by everything downstream, so a guess written there is worse than the
 * 未识别 it replaces.
 */
export async function runFingerprintReprobe({ bridge, sessionId, accountEmail, dataDir, variant, store = true }) {
  try {
    const account = bridge.credentials.forSession(accountEmail);
    const outcome = await bridge.browser.withAccount(account, () =>
      identify({
        dataDir,
        variant,
        store,
        ask: async (prompt) => {
          const payload = await bridge.converse(
            sessionId,
            { messages: [{ role: "user", content: prompt }] },
            { injectMcp: false, account, accountEmail, purpose: "fingerprint" }
          );
          return extractCompletionText(payload);
        },
      })
    );
    return { outcome, failure: null };
  } catch (error) {
    return { outcome: null, failure: error instanceof Error ? error.message : String(error) };
  }
}

/** The assistant text out of an OpenAI-shaped completion, or "". */
export function extractCompletionText(payload) {
  const message = payload?.choices?.[0]?.message;
  return typeof message?.content === "string" ? message.content : "";
}

function busyError() {
  return { error: { message: "A turn is in flight; retry when it finishes.", code: "busy" } };
}

function savePoolState(config, state) {
  const file = poolStateFile(config);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1), "utf8");
  fs.renameSync(tmp, file);
}

/**
 * Read the Arena模型助手 "模型归档/记录.json" and return the usable sessions.
 * Each archived entry carries Url = https://arena.ai/agent/<uuid>; that uuid is
 * exactly the `model` value the bridge's converse-only driver expects.
 */
export function readArchiveSessions(archiveDir) {
  // archive.mjs owns the one rule for reading 记录.json; this only reshapes it.
  return readEntries(archiveDir)
    .map((e) => {
      return {
        sessionId: sessionIdFromUrl(e.Url),
        model: e.Model || "",
        title: e.Title || "",
        url: e.Url || "",
        email: e.Email || "",
        collectedAt: e.CollectedAt || "",
        prompt: e.Prompt || "",
        effort: e.Effort || "",
      };
    })
    .filter((s) => s.sessionId);
}

/** Hostnames that mean "this machine". Anything else cannot be us. */
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Did this request come from this machine's loopback?
 *
 * Binding 127.0.0.1 is not enough on its own. A web page can point its own
 * domain at 127.0.0.1 (DNS rebinding) and is then same-origin with us, free to
 * read every response — including /api/status, which hands out the bridge key.
 * The Host header is what breaks that: after rebinding it still carries the
 * attacker's domain, not ours.
 *
 * A foreign Origin is rejected for the same reason one step earlier. The GUI is
 * served from this origin, so its own POSTs carry a local Origin and still work.
 */
function isLocalRequest(req) {
  const name = String(req.headers.host || "").replace(/:\d+$/, "").toLowerCase();
  if (!LOCAL_HOSTS.has(name)) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return LOCAL_HOSTS.has(new URL(origin).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * /api/status hands the bridge key to the caller so the GUI can show it and the
 * user can paste it into a client. That is acceptable only while this process is
 * reachable from this machine alone: with a non-loopback HOST the Host check can
 * simply be spoofed, and the key would go out with the response. HOST is an env
 * override, so the invariant behind ADR 0004 is asserted here rather than assumed.
 */
export function exposesBridgeKey(config) {
  return LOCAL_HOSTS.has(String(config?.host || "").toLowerCase());
}

function json(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), ...headers });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 5_000_000) {
        reject(Object.assign(new Error("Request too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (error) {
        reject(Object.assign(error, { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

/** Validate the OpenAI request shape; return error string or null. */
export function validateCompletion(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "request body must be a JSON object";
  if (!Array.isArray(body.messages) || body.messages.length === 0) return "messages must be a non-empty array";
  for (const m of body.messages) {
    if (!m || typeof m !== "object") return "each message must be an object";
    if (!["system", "developer", "user", "assistant", "tool"].includes(m.role))
      return `unsupported role: ${m.role}`;
  }
  if (body.tools !== undefined && !Array.isArray(body.tools)) return "tools must be an array";
  if (body.max_tokens !== undefined && typeof body.max_tokens !== "number") return "max_tokens must be a number";
  if (body.temperature !== undefined && typeof body.temperature !== "number") return "temperature must be a number";
  return null;
}

export class RateLimiter {
  constructor(rpm) {
    this.rpm = Math.max(1, rpm);
    this.windows = new Map();
  }
  allow(key, now = Date.now()) {
    const winMs = 60_000;
    const entry = this.windows.get(key) || { count: 0, start: now };
    if (now - entry.start > winMs) {
      entry.count = 0;
      entry.start = now;
    }
    entry.count += 1;
    this.windows.set(key, entry);
    return { allowed: entry.count <= this.rpm, retryAfter: Math.ceil((winMs - (now - entry.start)) / 1000) || 1 };
  }
}

/** Arena session ids are UUIDv4; treat a UUID `model` as "talk to this session". */
export function isSessionId(model) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(model || ""));
}

export function createServer({ bridge, config }) {
  const limiter = new RateLimiter(config.rateLimitRpm);
  const startedAt = Date.now();
  // §4.26 — GUI one-click control of the local AgentDock MCP server + tunnel.
  const agentdock = new AgentDockManager({
    dir: config.agentdockDir,
    dataDir: config.dataDir,
    endpointFile: config.mcpEndpointFile,
  });
  // The session currently selected in the GUI as the "active" model provider.
  // Clients may use model: "active" (or omit model) to target it.
  let activeSession = String(config.arenaSessions || "").split(",").map((s) => s.trim()).filter(Boolean)[0] || "";
  // Derived ModelPool state (health + bindings). See poolStateFile() above.
  let poolState = loadPoolState(config);
  // Turns currently being driven by the bridge. Manual health checks must not
  // navigate the shared browser page while one is running.
  let turnsInFlight = 0;

  /**
   * Accounts with their last quota reading attached. The reading is a cached
   * observation, so it travels with its own checkedAt — callers must show when
   * it was taken rather than presenting it as live.
   */
  function accountsWithQuota() {
    return (bridge.credentials.list() || []).map((a) => ({
      ...a,
      quota: poolState.accounts?.[String(a.email || "").toLowerCase()] || null,
    }));
  }

  /**
   * Shared entry guard for the two ModelPool actions that drive one real turn.
   * Returns the validated session id, or null when a response was already sent.
   */
  async function poolSessionId(req, res, body = null) {
    // A request body stream can only be read once: readBody resolves on `end`,
    // and a second call re-registers listeners that will never fire again, so
    // the request hangs instead of failing. Callers that need a field of their
    // own must pass the body they already read rather than reading it again.
    const parsed = body ?? (await readBody(req));
    const sid = String(parsed.sessionId || "").trim();
    if (!isSessionId(sid)) {
      json(res, 400, { error: { message: "sessionId must be a UUID" } });
      return null;
    }
    if (turnsInFlight > 0) {
      json(res, 409, busyError());
      return null;
    }
    return sid;
  }

  // 连抽 (session harvesting) + 批量测试. Both are LOCAL operator tools and sit
  // behind the bridge key below; the status endpoints are read-only but still
  // keyed, because they expose account/session metadata.
  const harvester = new Harvester({
    bridge,
    credentials: bridge.credentials,
    archiveDir: config.archiveDir,
  });
  const batch = new BatchTest({
    origin: `http://${config.host}:${config.port}`,
    bridgeKey: config.bridgeKey,
    sessions: readArchiveSessions(config.archiveDir),
  });

  const server = http.createServer(async (req, res) => {
    // Only this machine may talk to us — see isLocalRequest() for why the
    // loopback bind alone is not enough.
    if (!isLocalRequest(req)) {
      return json(res, 403, { error: { message: "This server only answers requests from this machine." } });
    }
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    // Some OpenAI-compatible clients (and hand-written curl) append a trailing
    // slash to every path ("/v1/models/", "/v1/chat/completions/"). That used to
    // fall through to a confusing 404. Normalize it away (except for the root).
    if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
      url.pathname = url.pathname.replace(/\/+$/, "");
    }
    const clientKey = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?") + "|" +
      String(req.headers.authorization || "").slice(0, 24);

    // /health stays open: it is the readiness probe used by install.sh and
    // run.sh, and it exposes no credentials.
    if (url.pathname === "/health" || url.pathname === "/ready") {
      const payload = bridge.healthPayload();
      payload.accounts = accountsWithQuota();
      return json(res, 200, payload);
    }

    // ── GUI (local, unauthenticated) ───────────────────────────────────────
    // The web GUI is the entry point for picking an archived Arena session and
    // surfacing the local API/proxy URLs. These routes are served WITHOUT the
    // bridge key (the chat API and /recaptcha below stay behind it).
    //
    // They are not free of secrets, though: /api/status among them hands the key
    // out, because the GUI has no other way to show it to the user who has to
    // paste it into a client. What makes that acceptable is the request check
    // above, not an absence of secrets — a foreign Host or Origin is answered
    // 403, so only this machine's own processes get a reply, and those can read
    // DATA_DIR/.env (where the key comes from) anyway. See ADR 0004.
    if (url.pathname === "/" || url.pathname === "/gui") {
      try {
        const html = fs.readFileSync(path.join(__dirname, "gui.html"), "utf8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(html);
      } catch {
        return json(res, 500, { error: { message: "GUI template not found" } });
      }
    }
    if (url.pathname === "/api/sessions") {
      const sessions = readArchiveSessions(config.archiveDir);
      batch.sessions = sessions;
      // `groups` is the ModelPool view: the same sessions, organised by Model,
      // with 未识别 in its own bucket. Derived, never stored.
      return json(res, 200, {
        archiveDir: config.archiveDir,
        sessions,
        groups: groupSessions(sessions, poolState),
      });
    }
    // Read-only aggregate for the GUI overview (model count / per-model counts).
    if (url.pathname === "/api/archive/stats") {
      return json(res, 200, archiveStats(config.archiveDir));
    }
    if (req.method === "POST" && url.pathname === "/api/active-session") {
      try {
        const body = await readBody(req);
        const sid = String(body.sessionId || "").trim();
        if (!isSessionId(sid)) return json(res, 400, { error: { message: "sessionId must be a UUID" } });
        activeSession = sid;
        log.info("server", "active session set", { sessionId: sid });
        return json(res, 200, { ok: true, activeSession });
      } catch (error) {
        return json(res, 400, { error: { message: error instanceof Error ? error.message : String(error) } });
      }
    }
    if (url.pathname === "/api/status") {
      const origin = `http://${config.host}:${config.port}`;
      return json(res, 200, {
        origin,
        apiBase: `${origin}/v1`,
        chatEndpoint: `${origin}/v1/chat/completions`,
        proxyUrl: `${origin}/v1`,
        apiKey: exposesBridgeKey(config) ? config.bridgeKey : "",
        activeSession,
        model: activeSession,
        accounts: accountsWithQuota(),
      });
    }

    // Hardened: authenticate before serving any other route. Previously
    // /metrics, /recaptcha and /v1/models answered without a bridge key, so
    // any local process could mint reCAPTCHA tokens with your account.
    const auth = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!config.bridgeKey || auth !== config.bridgeKey) {
      return json(res, 401, { error: { message: "Invalid bridge key" } });
    }

    // §4.26 — one-click local MCP bridge (AgentDock + cloudflared tunnel).
    if (url.pathname === "/api/mcp/status") {
      return json(res, 200, await agentdock.status());
    }

    // Ticket 14 — the manual re-injection entry: resolve the workspace of a
    // Session that was created before we knew it (or whose workspace changed)
    // and inject once more. Defaults to the GUI's active session; the body may
    // name another one. Nothing is silent: the response carries `reason`
    // whether or not anything was injected.
    if (req.method === "POST" && url.pathname === "/api/mcp/reinject") {
      try {
        const body = (await readBody(req)) || {};
        const sessionId = String(body.sessionId || "").trim() || activeSession;
        if (!isSessionId(sessionId)) {
          return json(res, 400, { error: { message: "sessionId must be a UUID (or set an active session first)" } });
        }
        // The header is the documented workspace contract, so it wins over the
        // body field the GUI sends for convenience.
        const workspace = String(req.headers[WORKSPACE_HEADER] || body.workspace || "").trim();
        const outcome = await bridge.reinjectLocalCapability(sessionId, { [WORKSPACE_HEADER]: workspace });
        // Ticket 24 — the caller of this route is usually the GUI button, not a
        // client with headers to set. So the head of the hint names the two
        // remedies that audience can actually perform; the header stays last,
        // because it is the one thing a GUI user cannot do.
        const hint = outcome.injected || outcome.pending
          ? ""
          : outcome.reason === "no local endpoint is up"
            ? "本机 MCP 还没起来：先点「一键启动」。"
            : `没认出工作区：先在目标项目里跑一轮真实对话（Bridge 会记住这个 Session 属于哪个项目），` +
              `或放一个 mcp-workspace.txt / 设置 ARENA_MCP_WORKSPACE 作为默认值。` +
              `HTTP 客户端可以直接带 ${WORKSPACE_HEADER} 头。`;
        return json(res, 200, { sessionId, ...outcome, hint });
      } catch (error) {
        return json(res, 500, { error: { message: error instanceof Error ? error.message : String(error) } });
      }
    }

    // ── ModelPool actions (operator-initiated, so they go behind the key) ───
    // Which client conversations are currently pinned to which Session. The GUI
    // shows these so a binding can be inspected and dropped by hand.
    if (url.pathname === "/api/pool/bindings") {
      const bindings = Object.entries(poolState.bindings || {}).map(([clientId, b]) => ({
        clientId,
        sessionId: b.sessionId,
        boundAt: b.boundAt || null,
        state: poolState.sessions?.[b.sessionId]?.state || "ok",
      }));
      return json(res, 200, { bindings });
    }
    // Drop a Binding so the client falls back to the GUI-selected session.
    if (req.method === "POST" && url.pathname === "/api/pool/unbind") {
      try {
        const body = await readBody(req);
        const clientId = String(body.clientId || "").trim();
        if (!clientId) return json(res, 400, { error: { message: "clientId is required" } });
        poolState = unbind(poolState, clientId);
        savePoolState(config, poolState);
        return json(res, 200, { ok: true });
      } catch (error) {
        return json(res, 400, { error: { message: error instanceof Error ? error.message : String(error) } });
      }
    }
    // 体检 — a page that merely renders is not proof a session can still answer,
    // so this drives one real turn. The nonce makes the probe unique: the bridge
    // serves identical (session + prompt) pairs from its idempotency cache, so a
    // fixed probe string would look "alive" forever without ever reaching Arena.
    // Note this DOES append one short message to that session's transcript.
    if (req.method === "POST" && url.pathname === "/api/pool/verify") {
      try {
        const sid = await poolSessionId(req, res);
        if (!sid) return;
        const probe = `[arena-bridge health check ${crypto.randomBytes(4).toString("hex")}] Reply with just: OK`;
        let alive = false;
        let failure = null;
        turnsInFlight += 1;
        try {
          const payload = await bridge.converse(
            sid,
            { messages: [{ role: "user", content: probe }] },
            // 体检 drives the Session too, so it must use the owning Account —
            // otherwise it would report on a session it cannot actually open.
            { injectMcp: false, accountEmail: sessionAccountEmail(config.archiveDir, sid) }
          );
          alive = Array.isArray(payload?.choices) && payload.choices.length > 0;
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
        } finally {
          turnsInFlight -= 1;
        }
        poolState = alive
          ? markOk(poolState, sid)
          : markDead(poolState, sid, new Date().toISOString());
        savePoolState(config, poolState);
        log.info("server", "pool verify", { sessionId: sid, alive });
        return json(res, 200, { ok: true, sessionId: sid, alive, error: failure });
      } catch (error) {
        return json(res, 500, { error: { message: error instanceof Error ? error.message : String(error) } });
      }
    }
    // 补标 — identify the Model for a Session that was archived as 未识别, and
    // write it back into 记录.json (the source of truth).
    //
    // It has to drive a real turn to do that. The probe learns the Model by
    // observing a run; merely loading the Session page produces no run, so a
    // "just re-read the page" version of this could never succeed. The cost is
    // the same as 体检: a short message is appended to the transcript.
    if (req.method === "POST" && url.pathname === "/api/pool/reprobe") {
      try {
        const sid = await poolSessionId(req, res);
        if (!sid) return;
        const prompt = `[arena-bridge model probe ${crypto.randomBytes(4).toString("hex")}] Reply with just: OK`;
        turnsInFlight += 1;
        let outcome;
        try {
          outcome = await runReprobe({
            bridge,
            sessionId: sid,
            accountEmail: sessionAccountEmail(config.archiveDir, sid),
            prompt,
          });
        } finally {
          turnsInFlight -= 1;
        }
        const { found, failure } = outcome;
        if (!found?.model) {
          return json(res, 200, { ok: false, sessionId: sid, unresolved: true, error: failure || found?.error || null });
        }
        const updated = updateModel(config.archiveDir, sid, found.model);
        log.info("server", "pool reprobe", { sessionId: sid, model: found.model, updated: Boolean(updated) });
        return json(res, 200, { ok: true, sessionId: sid, model: found.model, updated: Boolean(updated) });
      } catch (error) {
        return json(res, 500, { error: { message: error instanceof Error ? error.message : String(error) } });
      }
    }

    // 补标（指纹） — identify a Model by fingerprint when the probe cannot.
    //
    // The 补标 route above reads the Model from a run the probe observed. That
    // route is closed on current Arena: the run-scoped token the trace needs is
    // no longer issued, so it answers `unresolved` every time. This one asks a
    // different question — what numbers does this Session's model pick — and
    // answers from a bank collected earlier.
    //
    // It writes to 记录.json ONLY when the attribution clears its gate. A near
    // miss is reported and discarded: the Model column feeds everything
    // downstream, so a plausible guess there is worse than 未识别.
    //
    // `dryRun` takes the fingerprint and reports it without touching the store
    // or the archive, which is how a bank gets validated against known Sessions.
    if (req.method === "POST" && url.pathname === "/api/pool/fingerprint-reprobe") {
      try {
        const body = await readBody(req).catch(() => ({}));
        const sid = await poolSessionId(req, res, body);
        if (!sid) return;
        const dryRun = Boolean(body.dryRun);
        const variant = body.variant ?? variantIds()[0];
        try {
          probePrompt(variant);
        } catch {
          return json(res, 400, { error: { message: `unknown probe variant: ${variant}` } });
        }
        const store = !dryRun;
        turnsInFlight += 1;
        let outcome;
        try {
          outcome = await runFingerprintReprobe({
            bridge,
            sessionId: sid,
            accountEmail: sessionAccountEmail(config.archiveDir, sid),
            dataDir: config.dataDir,
            variant,
            store,
          });
        } finally {
          turnsInFlight -= 1;
        }
        const { outcome: result, failure } = outcome;
        if (!result || result.status === "failed") {
          return json(res, 200, { ok: false, sessionId: sid, unresolved: true, error: failure || result?.reason || null });
        }
        if (result.status === "unresolved") {
          log.info("server", "pool fingerprint reprobe unresolved", {
            sessionId: sid,
            nearMiss: result.nearMiss,
            margin: Number(result.margin?.toFixed(3)),
          });
          return json(res, 200, {
            ok: false,
            sessionId: sid,
            unresolved: true,
            nearMiss: result.nearMiss,
            margin: result.margin,
            confidence: result.confidence,
            error: result.reason,
          });
        }
        if (dryRun) {
          return json(res, 200, { ok: true, sessionId: sid, model: result.model, margin: result.margin, confidence: result.confidence, updated: false, dryRun: true });
        }
        const updated = updateModel(config.archiveDir, sid, result.model);
        log.info("server", "pool fingerprint reprobe", {
          sessionId: sid,
          model: result.model,
          margin: Number(result.margin.toFixed(3)),
          updated: Boolean(updated),
        });
        return json(res, 200, {
          ok: true,
          sessionId: sid,
          model: result.model,
          margin: result.margin,
          confidence: result.confidence,
          updated: Boolean(updated),
        });
      } catch (error) {
        return json(res, 500, { error: { message: error instanceof Error ? error.message : String(error) } });
      }
    }

    // What the fingerprint bank currently holds, and whether it can attribute.
    // Reported separately from any turn so the answer to "is this usable yet"
    // costs nothing.
    if (req.method === "GET" && url.pathname === "/api/fingerprint/status") {
      try {
        return json(res, 200, { ok: true, ...bankStatus(config.dataDir) });
      } catch (error) {
        return json(res, 500, { error: { message: error instanceof Error ? error.message : String(error) } });
      }
    }

    // 删除 — drop Sessions from the archive for good. This is the one
    // irreversible operator action here, so it is keyed and explicit: the GUI
    // confirms first, and the response says exactly what went. Only the local
    // archive is touched; the Session on Arena's side is not ours to remove.
    if (req.method === "POST" && url.pathname === "/api/pool/delete") {
      try {
        const body = await readBody(req);
        const requested = (Array.isArray(body.sessionIds) ? body.sessionIds : [body.sessionId])
          .map((s) => String(s || "").trim())
          .filter(isSessionId);
        if (!requested.length) {
          return json(res, 400, { error: { message: "sessionIds must be a non-empty array of UUIDs" } });
        }
        const removed = removeEntries(config.archiveDir, requested);
        const gone = removed.map((e) => sessionIdFromUrl(e.Url)).filter(Boolean);
        // Derived state must not outlive the Session: a stale health row is
        // harmless, but a stale Binding would keep pointing callers at nothing.
        for (const sid of gone) poolState = forgetSession(poolState, sid);
        if (gone.some((sid) => sid.toLowerCase() === activeSession.toLowerCase())) activeSession = "";
        savePoolState(config, poolState);
        log.info("server", "pool delete", { requested: requested.length, removed: gone.length });
        return json(res, 200, { ok: true, requested: requested.length, removed: gone, notFound: requested.length - gone.length });
      } catch (error) {
        return json(res, 500, { error: { message: error instanceof Error ? error.message : String(error) } });
      }
    }

    // 额度 — read the active account's remaining quota on demand. Manual only,
    // and never another account: switching credential tears down that Account's
    // browser context, which would kill whatever turn is in flight.
    //
    // It reads the page a turn leaves behind, so it shares that page — and it is
    // counted as a turn in flight for the same reason a turn is: everything that
    // checks this counter is about to drive that page too.
    if (req.method === "POST" && url.pathname === "/api/account/quota") {
      try {
        if (turnsInFlight > 0) return json(res, 409, busyError());
        turnsInFlight += 1;
        let snap;
        try {
          snap = await bridge.quotaSnapshot();
        } finally {
          turnsInFlight -= 1;
        }
        poolState = setAccountQuota(poolState, snap.email, snap);
        savePoolState(config, poolState);
        log.info("server", "account quota", {
          account: snap.email,
          percent: snap.percent,
          percentSource: snap.percentSource,
          usdStatus: snap.usdStatus,
        });
        return json(res, 200, snap);
      } catch (error) {
        // Log it: a 500 handed to the GUI with no server-side record is
        // undiagnosable, and this endpoint drives a real browser.
        log.error("server", "account quota failed", {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? String(error.stack).split("\n").slice(0, 5).join(" | ") : null,
        });
        // The bridge's own gate (ticket 10) rejects with status 409 when a turn
        // holds the serialized queue — surface that shape instead of 500.
        return json(res, Number(error.status || 500), {
          error: {
            message: error instanceof Error ? error.message : String(error),
            ...(error?.code ? { code: error.code } : {}),
          },
        });
      }
    }

    // ── 连抽 / 批量测试 ──────────────────────────────────────────────────
    if (url.pathname === "/api/harvest/status") {
      return json(res, 200, harvester.status());
    }
    if (req.method === "POST" && url.pathname === "/api/harvest/start") {
      const body = await readBody(req);
      const result = await harvester.start({
        count: Number(body.count || 0),
        prompt: String(body.prompt || ""),
        intervalMs: Number(body.intervalMs || 3000),
      });
      if (!result.ok) return json(res, 400, { error: { message: result.error } });
      return json(res, 200, result);
    }
    if (req.method === "POST" && url.pathname === "/api/harvest/stop") {
      return json(res, 200, harvester.stop());
    }
    if (url.pathname === "/api/test/status") {
      return json(res, 200, batch.status());
    }
    if (req.method === "POST" && url.pathname === "/api/test/start") {
      const body = await readBody(req);
      batch.sessions = readArchiveSessions(config.archiveDir);
      const result = batch.start({
        sessionIds: Array.isArray(body.sessionIds) ? body.sessionIds.map(String) : [],
        prompt: String(body.prompt || ""),
        concurrency: Number(body.concurrency || 1),
      });
      if (!result.ok) return json(res, 400, { error: { message: result.error } });
      return json(res, 200, result);
    }
    if (req.method === "POST" && url.pathname === "/api/test/stop") {
      return json(res, 200, batch.stop());
    }
    if (req.method === "POST" && url.pathname === "/api/mcp/start") {
      try {
        return json(res, 200, await agentdock.start());
      } catch (error) {
        return json(res, Number(error.status || 500), {
          error: { message: error instanceof Error ? error.message : String(error), code: error.code || "mcp_start_failed" },
        });
      }
    }
    if (req.method === "POST" && url.pathname === "/api/mcp/stop") {
      try {
        return json(res, 200, await agentdock.stop());
      } catch (error) {
        return json(res, 500, { error: { message: error instanceof Error ? error.message : String(error) } });
      }
    }

    if (url.pathname === "/v1/models" || url.pathname === "/models") {
      if (config.archiveDir) {
        const data = readArchiveSessions(config.archiveDir).map((s) => ({
          id: s.sessionId,
          object: "model",
          created: 0,
          owned_by: "arena-session",
          name: s.model,
        }));
        data.push({ id: "ping", object: "model", created: 0, owned_by: "arena-bridge", name: "健康探针 ping（立即返回，不驱动浏览器）" });
        return json(res, 200, { object: "list", data });
      }
      const known = String(config.arenaSessions || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const data = known.length
        ? known.map((id) => ({ id, object: "model", created: 0, owned_by: "arena-session" }))
        : [{ id: "agent", object: "model", created: 0, owned_by: "arena-agent" }];
      data.push({ id: "ping", object: "model", created: 0, owned_by: "arena-bridge", name: "健康探针 ping（立即返回，不驱动浏览器）" });
      return json(res, 200, { object: "list", data });
    }

    if (url.pathname === "/metrics") {
      const body = bridge.prometheusMetrics();
      res.writeHead(200, {
        "Content-Type": "text/plain; version=0.0.4",
        "Content-Length": Buffer.byteLength(body),
      });
      return res.end(body);
    }

    if (req.method === "POST" && url.pathname === "/recaptcha") {
      const credential = bridge.credentials.primary();
      try {
        const token = await bridge.recaptcha.get(credential, true);
        return json(res, 200, { token, action: "chat_submit" });
      } catch (error) {
        return json(
          res,
          503,
          { error: { message: "Fresh Arena reCAPTCHA token unavailable", type: "recaptcha_broker_error" } },
          { "Retry-After": "5" }
        );
      }
    }

    if (req.method !== "POST" || !["/v1/chat/completions", "/chat/completions"].includes(url.pathname)) {
      // Self-documenting 404: echo the path/method and list the valid endpoints,
      // so a wrong URL (e.g. "/v1/v1/chat/completions" or a GET) is obvious.
      return json(res, 404, {
        error: {
          message: "Not found",
          path: url.pathname,
          method: req.method,
          hint:
            "Valid endpoints: POST /v1/chat/completions (chat), GET /v1/models (models), GET / (GUI), GET /health. " +
            "Set base_url to http://127.0.0.1:20140/v1 and DO NOT append /v1 again; chat must use POST.",
        },
      });
    }

    const rate = limiter.allow(clientKey);
    if (!rate.allowed) {
      return json(res, 429, { error: { message: "Rate limit exceeded", type: "rate_limited" } }, { "Retry-After": String(rate.retryAfter) });
    }

    const requestId = crypto.randomUUID();
    const startedAtReq = Date.now();
    bridge.runtime.requests += 1;
    const responseHeaders = {
      "X-Arena-Bridge-Version": VERSION,
      "X-Arena-Bridge-Request-Id": requestId,
    };
    // Set when a streaming (SSE) response has been opened early; used by the
    // catch below to report errors in-band once headers are already sent.
    let sseHeartbeat = null;
    try {
      const body = await readBody(req);
      const validationError = validateCompletion(body);
      if (validationError) {
        bridge.runtime.errors += 1;
        return json(res, 400, { error: { message: validationError, type: "invalid_request_error", request_id: requestId } }, responseHeaders);
      }
      log.info("server", "chat completion request", { requestId, messages: body.messages.length, stream: body.stream === true });
      // Which workspace hint arrived. Codex is expected to send its session id,
      // which the bridge traces back to the directory that session ran in; when
      // this is absent the workspace cannot be recovered at all, so it is worth
      // seeing on every request rather than only when the MCP preamble injects.
      log.info("server", "workspace hints", {
        requestId,
        codexSessionId: String(req.headers["x-codex-session-id"] || "").trim() || null,
        workspaceHeader: String(req.headers["x-arena-workspace"] || "").trim() || null,
        headersSeen: Object.keys(req.headers).filter((h) => h.startsWith("x-")).join(","),
      });
      // Architecture split: a UUID `model` means "converse with this existing
      // Arena session" (converse-only, never creates a session — that is owned
      // by the Arena模型助手 real browser). model "active" (or omitted) targets
      // the session picked in the GUI. Any other non-UUID `model` falls back to
      // the legacy omni runAgent flow (which may create a session).
      const model = (body.model || "active").trim();
      // Which conversation the caller thinks it is having, if it tells us.
      const clientSid = clientSessionId(req.headers);
      let target = null;
      if (isSessionId(model)) {
        target = model;
        // Passing a UUID is an explicit choice: remember it, so a later
        // request that omits `model` lands on the same Session (and keeps
        // its context) instead of drifting to whatever the GUI picked since.
        if (clientSid) {
          poolState = bind(poolState, clientSid, target, new Date().toISOString());
          savePoolState(config, poolState);
        }
      } else if (model === "active") {
        // "active" (or an omitted model) means "use the session picked in the
        // GUI". If nothing is picked, fail with a CLEAR, actionable 409 instead
        // of silently falling back to the legacy runAgent flow (which tries to
        // create a session and is blocked by reCAPTCHA — see §4.10/§4.11).
        if (clientSid) {
          const bound = resolveBinding(poolState, clientSid);
          if (bound.ok) {
            target = bound.sessionId;
          } else if (bound.code === "bound_session_dead") {
            // Never substitute another Session: context lives on the bound one,
            // so silently switching would answer with a different conversation.
            throw Object.assign(
              new Error(
                `Your bound session ${bound.sessionId} is marked suspected-dead. ` +
                  'Pick another session (GUI → 选用此模型, or pass its UUID as model), ' +
                  `or POST /api/pool/unbind with clientId "${clientSid}" to drop the binding.`
              ),
              { status: 409, code: "bound_session_dead" }
            );
          }
        }
        // A Binding is only ever created by an EXPLICIT choice (passing a session
        // UUID as `model`). "active" is not a choice, so it does not bind —
        // otherwise a client that merely omits `model` would get frozen to
        // whichever session the GUI happened to have selected.
        if (!target) {
          if (!activeSession) throw noActiveSessionError();
          target = activeSession;
        }
      }
      // Resolve the owning Account BEFORE any response is opened. Streaming
      // clients get their 200 + SSE headers up front (§4.13.9), so anything
      // thrown later is delivered mid-stream and reads as "connection dropped"
      // instead of as the 409 it actually is. Resolving here keeps it clean.
      const accountEmail = target ? sessionAccountEmail(config.archiveDir, target) : "";
      let account = null;
      if (target) account = bridge.credentials.forSession(accountEmail);
      // Streaming clients get the SSE response opened IMMEDIATELY — before we
      // drive the (slow) Arena round-trip — plus a keep-alive heartbeat. Without
      // this the client sees zero bytes for 17-180s and aborts with a timeout
      // (exactly what cliproxyapi's stream:true health check hits — see §4.13.9).
      const streaming = body.stream === true;
      const streamId = `chatcmpl-arena-${requestId}`;
      const streamCreated = Math.floor(Date.now() / 1000);
      let streamedAny = false;
      // §4.33 — write OpenAI chunks as they arrive. The bridge pushes each text
      // delta out of the page context while the turn is still running, so the
      // client sees real content within seconds instead of only at the very end
      // (that stall was what tripped its stream-idle timeout and caused retries).
      const writeChunk = (delta, finish = null) => {
        if (res.writableEnded) return;
        try {
          res.write(
            `data: ${JSON.stringify({
              id: streamId,
              object: "chat.completion.chunk",
              created: streamCreated,
              model: model || "active",
              choices: [{ index: 0, delta, finish_reason: finish }],
            })}\n\n`
          );
        } catch {
          /* client already gone */
        }
      };
      if (streaming) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
          Connection: "keep-alive",
          ...responseHeaders,
        });
        // First frame is a VALID OpenAI chunk (not a bare ": comment"), so even a
        // strict SSE/JSON decoder sees something parseable from the first byte.
        writeChunk({ role: "assistant", content: "" });
        // Keep-alives are VALID empty-delta EVENTS (not comments) and now run for
        // the WHOLE turn — including the quiet stretches while Arena executes a
        // tool — so no layer in between can judge the stream as stalled (§4.32/§4.35).
        sseHeartbeat = setInterval(() => {
          if (!res.writableEnded) writeChunk({});
        }, 10_000);
        sseHeartbeat.unref?.();
      }
      const onDelta = streaming
        ? (text) => {
            streamedAny = true;
            writeChunk({ content: text });
          }
        : null;
      let payload;
      if (model === "ping" || model === "health") {
        // Lightweight probe model: a VALID completion INSTANTLY, without touching
        // the (slow) headed browser. Point a health/probe model here so it never
        // queues behind multi-minute Arena work.
        payload = {
          id: `chatcmpl-arena-ping-${Date.now()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };
      } else if (target) {
        turnsInFlight += 1;
        try {
          // The owning Account was resolved before the stream opened, so a
          // disabled owner has already become a clean 409 by now.
          payload = await bridge.converse(target, body, { onDelta, headers: req.headers, account, accountEmail });
          poolState = markUsed(poolState, target, new Date().toISOString());
        } catch (error) {
          // A real failure is the only trusted dead signal — never a timeout,
          // never an age heuristic. See docs/agents + spec 0001.
          poolState = markDead(poolState, target, new Date().toISOString());
          savePoolState(config, poolState);
          throw error;
        } finally {
          turnsInFlight -= 1;
        }
        savePoolState(config, poolState);
      } else {
        // Counted like the Session path above. It drives the same page a turn
        // does, so an unwatched run here is what lets an on-demand quota read
        // (which refuses only while turnsInFlight > 0) land on it mid-run.
        turnsInFlight += 1;
        try {
          payload = await bridge.runAgent(body, req.headers);
        } finally {
          turnsInFlight -= 1;
        }
      }
      if (sseHeartbeat) {
        clearInterval(sseHeartbeat);
        sseHeartbeat = null;
      }
      const elapsed = Date.now() - startedAtReq;
      bridge.runtime.completed += 1;
      bridge.runtime.lastLatencyMs = elapsed;
      bridge.runtime.totalLatencyMs += elapsed;
      bridge.runtime.lastSuccessAt = new Date().toISOString();
      const hasToolCalls = Array.isArray(payload?.choices?.[0]?.message?.tool_calls);
      if (hasToolCalls) bridge.runtime.toolResponses += 1;
      else bridge.runtime.textResponses += 1;
      if (streaming) {
        const message = payload?.choices?.[0]?.message || {};
        if (!streamedAny) {
          // Nothing was pushed while reading (tool-call turn, error turn, or a
          // path that produced text only at the end) — emit it as one chunk so
          // the stream still carries the answer. §4.33
          const streamedCalls = Array.isArray(message.tool_calls)
            ? message.tool_calls.map((call, index) => ({ index, ...call }))
            : null;
          if (message.reasoning_content) writeChunk({ reasoning_content: message.reasoning_content });
          if (streamedCalls) writeChunk({ content: message.content ?? null, tool_calls: streamedCalls });
          else if (message.content) writeChunk({ content: message.content });
        }
        writeChunk({}, payload?.choices?.[0]?.finish_reason || "stop");
        res.write("data: [DONE]\n\n");
        return res.end();
      }
      return json(res, 200, payload, responseHeaders);
    } catch (error) {
      if (sseHeartbeat) {
        clearInterval(sseHeartbeat);
        sseHeartbeat = null;
      }
      bridge.runtime.errors += 1;
      bridge.runtime.lastLatencyMs = Date.now() - startedAtReq;
      bridge.runtime.lastErrorAt = new Date().toISOString();
      bridge.runtime.lastErrorType = String(error?.code || error?.name || error?.status || "unknown").slice(0, 80);
      const status = Number(error.status || 502);
      const retrySeconds = Number(error.retryAfter || (status === 429 ? 60 : status === 503 ? 10 : 0));
      const retryAfter = retrySeconds > 0 ? { "Retry-After": String(retrySeconds) } : {};
      log.error("server", "completion failed", {
        requestId,
        status,
        errorType: error?.name || "Error",
        message: error?.message,
      });
      const errorBody = {
        error: {
          message: error instanceof Error ? error.message : String(error),
          type: "arena_agent_error",
          ...(error && error.code ? { code: error.code } : {}),
          request_id: requestId,
        },
      };
      // If the streaming response was already opened we can no longer change the
      // HTTP status, so report the failure in-band as an SSE error event.
      if (res.headersSent) {
        try {
          // Standard OpenAI-style in-band error frame — plain `data:` only (no
          // custom event name) so strict stream decoders don't choke.
          res.write(`data: ${JSON.stringify(errorBody)}\n\n`);
          res.write("data: [DONE]\n\n");
        } catch {
          /* client already gone */
        }
        return res.end();
      }
      return json(res, status, errorBody, { ...retryAfter, ...responseHeaders });
    }
  });

  // §4.37 — the bridge sets NO request timeout. A single turn can legitimately
  // take many minutes (several Arena tool steps, or a long generation), and any
  // server-side abort here is what made Codex time out and retry the same
  // request. Content streams continuously, so the client's stream-idle timeout
  // never trips; we only stop when Arena's stream closes or the turn settles.
  // 0 disables Node's per-request timeout entirely. (Set ARENA_READ_BUDGET_MS
  // for an upper bound if you want one — but the bridge itself won't time out.)
  server.requestTimeout = 0;
  // Keep idle keep-alive sockets open LONGER than a pooled client's idle
  // timeout. A 5s keepAliveTimeout let pooled clients (e.g. reqwest, which
  // cliproxyapi uses; its pool idles ~90s) reuse an already-closed socket and
  // fail with "error sending request for url ..." (a transport error, not an
  // HTTP/path error). headersTimeout must be greater than keepAliveTimeout.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.maxHeadersCount = 128;
  server.startTime = startedAt;

  return server;
}
