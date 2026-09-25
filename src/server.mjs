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
import { stats as archiveStats, readEntries, sessionAccountEmail, sessionIdFromUrl, updateModel } from "./archive.mjs";
import { Harvester } from "./harvest.mjs";
import { BatchTest } from "./batchtest.mjs";
import { installProbe, readModelFromPage } from "./probe.mjs";
import {
  bind,
  clientSessionId,
  emptyState,
  groupSessions,
  markDead,
  markOk,
  markUsed,
  resolveBinding,
  unbind,
} from "./pool.mjs";

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

/** The shared browser page for operator actions (caller drives the navigation). */
async function sessionPageFor(bridge) {
  const credential = bridge.credentials?.primary?.() || null;
  return bridge.browser.getPage(credential?.cookieHeader || "", credential?.updatedAt);
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
      };
    })
    .filter((s) => s.sessionId);
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
   * Shared entry guard for the two ModelPool actions that drive one real turn.
   * Returns the validated session id, or null when a response was already sent.
   */
  async function poolSessionId(req, res) {
    const body = await readBody(req);
    const sid = String(body.sessionId || "").trim();
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
    if (url.pathname === "/health" || url.pathname === "/ready") return json(res, 200, bridge.healthPayload());

    // ── GUI (local, unauthenticated) ───────────────────────────────────────
    // The web GUI is the entry point for picking an archived Arena session and
    // surfacing the local API/proxy URLs. It runs on 127.0.0.1 only and exposes
    // nothing secret beyond the local base URL + the user's own session list,
    // so it is intentionally served without the bridge key (the chat API and
    // /recaptcha below stay behind the key).
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
        apiKey: config.bridgeKey,
        activeSession,
        model: activeSession,
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
    // 补标 — re-run the probe against an existing session and, if a Model is
    // finally identified, write it back into 记录.json (the source of truth).
    if (req.method === "POST" && url.pathname === "/api/pool/reprobe") {
      try {
        const sid = await poolSessionId(req, res);
        if (!sid) return;
        // installProbe must run BEFORE the navigation: it uses addInitScript.
        const page = await sessionPageFor(bridge);
        await installProbe(page);
        await page.goto(`https://arena.ai/agent/${sid}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
        const found = await readModelFromPage(page, { timeoutMs: 20_000 });
        if (!found?.model) {
          return json(res, 200, { ok: false, sessionId: sid, unresolved: true, error: found?.error || null });
        }
        const updated = updateModel(config.archiveDir, sid, found.model);
        log.info("server", "pool reprobe", { sessionId: sid, model: found.model, updated: Boolean(updated) });
        return json(res, 200, { ok: true, sessionId: sid, model: found.model, updated: Boolean(updated) });
      } catch (error) {
        return json(res, 500, { error: { message: error instanceof Error ? error.message : String(error) } });
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
        const token = await bridge.recaptcha.get(credential?.cookieHeader, true);
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
      "X-Arena-Bridge-Version": "5.0.0",
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
        payload = await bridge.runAgent(body, req.headers);
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
