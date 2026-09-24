// probe.mjs — identify WHICH model answered a freshly created Arena session.
//
// PRIMARY PATH: reuse the Arena模型助手's own probe,
// `assets/arena-model-probe.inject.js` (v1.0.0+20260918.2), by injecting it
// into the Playwright page. That bundle is the real deal: a 966-model
// registry, protocol-level fingerprints, codename hints and its own
// trigger.dev run reader. Re-implementing it here was the wrong call — it
// produced "未识别" because the JWT scope shape differs per run.
//
// FALLBACK PATH: if the bundle is missing or injection fails, do a small
// Node-side query of the same trigger.dev API (kept below).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROBE_PATH = path.join(__dirname, "..", "assets", "arena-model-probe.inject.js");

let cachedSource = null;
export function probeSource() {
  if (cachedSource === null) {
    try {
      cachedSource = fs.readFileSync(PROBE_PATH, "utf8");
    } catch {
      cachedSource = "";
    }
  }
  return cachedSource;
}

// The host shell (that's us) hides the probe HUD; we render results ourselves.
const INIT_SNIPPET = "window.__MODEL_PROBE_OPTIONS__={showHUD:false};";

/**
 * Install the probe so it runs on every navigation of this page.
 * Must be called BEFORE the first goto, hence addInitScript.
 */
export async function installProbe(page) {
  const src = probeSource();
  if (!src) return { ok: false, error: "未找到 assets/arena-model-probe.inject.js" };
  await page.addInitScript(`${INIT_SNIPPET}\n${src}`);
  return { ok: true };
}

/**
 * Ask the in-page probe for the real model name, polling until it resolves.
 * Returns { model, runId, via } or { model: null, ... }.
 */
export async function readModelFromPage(page, { timeoutMs = 45_000, intervalMs = 1500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = { model: null, runId: null, error: null };
  while (Date.now() < deadline) {
    const snap = await page
      .evaluate(async () => {
        const api = window.__MODEL_PROBE__;
        if (!api) return { ready: false };
        const read = () => {
          try {
            return api.realModel ? api.realModel() : null;
          } catch {
            return null;
          }
        };
        let model = read();
        if (!model && typeof api.pollRunModels === "function") {
          try {
            await api.pollRunModels({ timeout: 8000 });
          } catch {
            /* keep polling */
          }
          model = read();
        }
        let state = null;
        try {
          state = api.runState ? api.runState() : null;
        } catch {
          state = null;
        }
        return {
          ready: true,
          model: model || null,
          runId: state?.runId || null,
          error: state?.lastError || null,
        };
      })
      .catch(() => ({ ready: false }));
    if (snap?.model) return { ...snap, via: "page-probe" };
    if (snap?.ready) last = { model: null, runId: snap.runId || null, error: snap.error || null };
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { ...last, via: "page-probe" };
}

/* ── Node-side fallback (only used if injection is unavailable) ─────────── */

const API = "https://api.trigger.dev/api/v1/runs";

function b64urlDecode(s) {
  const norm = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = norm + "=".repeat((4 - (norm.length % 4)) % 4);
  return Buffer.from(pad, "base64").toString("utf8");
}

/**
 * Decode the public run token (JWT) into { sid, runId, expires }.
 * Scope shape varies between runs, so take the first usable entry of each
 * kind instead of demanding exactly one (that strictness caused false
 * "会话与运行读取权限不匹配" failures).
 */
export function decodeRunToken(token, expectedSid = null, now = Date.now()) {
  if (typeof token !== "string" || token.length > 16384 || token.split(".").length !== 3) {
    throw new Error("运行令牌格式不符");
  }
  let payload;
  try {
    payload = JSON.parse(b64urlDecode(token.split(".")[1]));
  } catch {
    throw new Error("运行令牌无法解码");
  }
  if (payload?.pub !== true || payload.iss !== "https://id.trigger.dev") {
    throw new Error("不是公开运行令牌");
  }
  if (!Number.isFinite(payload.exp) || payload.exp * 1000 <= now + 5000) {
    throw new Error("运行令牌已过期");
  }
  const scopes = Array.isArray(payload.scopes) ? payload.scopes : [];
  const runs = scopes.filter((s) => typeof s === "string" && s.startsWith("read:runs:"));
  const sessions = scopes
    .filter((s) => typeof s === "string" && s.startsWith("read:sessions:"))
    .map((s) => s.slice("read:sessions:".length));
  const sid = expectedSid || sessions[0] || null;
  if (!runs.length) throw new Error("令牌未授予 run 读取权限");
  const runId = runs[0].slice("read:runs:".length);
  if (!/^run_[\w-]{1,100}$/.test(runId)) throw new Error("运行 ID 格式不符");
  return { sid, runId, expires: payload.exp * 1000 };
}

async function fetchJson(url, token, timeoutMs = 15_000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: ctl.signal,
    });
    if (!r.ok) throw Object.assign(new Error(`trigger.dev HTTP ${r.status}`), { status: r.status });
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

const MODEL_KEYS = ["model", "modelid", "model_id", "modelname", "model_name"];
const PROVIDER_KEYS = ["provider", "providerid", "provider_id", "providername", "provider_name"];

function pickString(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === "string" && v.trim() && v.length <= 200) return v.trim();
  }
  return null;
}

function extractFromNode(root) {
  const out = { model: null, provider: null, effort: null, operationName: null };
  const seen = new WeakSet();
  const visit = (value, depth) => {
    if (depth > 40 || !value || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (value.ai && typeof value.ai === "object") {
      out.model = out.model || pickString(value.ai, MODEL_KEYS);
      out.provider = out.provider || pickString(value.ai, PROVIDER_KEYS);
      out.operationName = out.operationName || pickString(value.ai, ["operationName", "operation", "operation_name"]);
    }
    for (const [key, child] of Object.entries(value)) {
      const lower = String(key).toLowerCase();
      if (typeof child === "string") {
        if (!out.model && (MODEL_KEYS.includes(lower) || lower.includes("request.model") || lower.includes("response.model"))) {
          out.model = child.trim() || null;
        }
        if (!out.provider && PROVIDER_KEYS.includes(lower)) out.provider = child.trim() || null;
        if (!out.effort && /^(reasoning_effort|reasoningeffort|thinkinglevel|thinking_level)$/.test(lower)) {
          out.effort = child.trim() || null;
        }
      }
      if (child && typeof child === "object" && Object.keys(child).length === 1 && "stringValue" in child) {
        visit(child.stringValue, depth + 1);
        continue;
      }
      visit(child, depth + 1);
    }
  };
  visit(root, 0);
  return out;
}

function scanTrace(json) {
  const results = [];
  const seen = new WeakSet();
  const visit = (span) => {
    if (!span || typeof span !== "object" || seen.has(span)) return;
    seen.add(span);
    const data = span.data || {};
    for (const c of [data.properties, data.events, data.output, span.properties, span.events, span.output, span]) {
      if (!c || typeof c !== "object") continue;
      const hit = extractFromNode(c);
      if (hit.model) {
        results.push({
          model: hit.model,
          provider: hit.provider || null,
          effort: hit.effort || null,
          message: typeof data.message === "string" ? data.message : "",
          spanId: span.id || span.spanId || null,
        });
        return;
      }
    }
    for (const child of Array.isArray(span.children) ? span.children : []) visit(child);
  };
  visit(json?.trace?.rootSpan || json?.rootSpan || json?.trace || json);
  const settled = results.find((r) => /token\.usage|spend|generate|completion|ai\./i.test(r.message || ""));
  return settled || results[0] || null;
}

async function scanEvents(token, runId, timeoutMs) {
  const json = await fetchJson(`${API}/${encodeURIComponent(runId)}/events`, token, timeoutMs);
  const spans = Array.isArray(json?.data) ? json.data : Array.isArray(json?.events) ? json.events : Array.isArray(json) ? json : [];
  for (const c of spans.filter((e) => e && (e.spanId || e.id)).slice(0, 24)) {
    const spanId = c.spanId || c.id;
    try {
      const detail = await fetchJson(`${API}/${encodeURIComponent(runId)}/spans/${encodeURIComponent(spanId)}`, token, timeoutMs);
      const hit = extractFromNode(detail?.span || detail?.data || detail);
      if (hit.model) return { model: hit.model, provider: hit.provider, effort: hit.effort, spanId };
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Node-side identification — fallback only. */
export async function probeModel(token, { attempts = 6, intervalMs = 1500, timeoutMs = 15_000 } = {}) {
  const { sid, runId } = decodeRunToken(token);
  let lastError = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      const hit = scanTrace(await fetchJson(`${API}/${encodeURIComponent(runId)}/trace`, token, timeoutMs));
      if (hit?.model) return { ...hit, sid, runId, attempt: i, via: "node-fallback" };
    } catch (error) {
      lastError = error;
      if (error?.status === 429) throw new Error("Trace 接口限流（HTTP 429）");
    }
    try {
      const hit = await scanEvents(token, runId, timeoutMs);
      if (hit?.model) return { ...hit, sid, runId, attempt: i, via: "node-fallback" };
    } catch (error) {
      lastError = error;
    }
    if (i < attempts) await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { model: null, provider: null, effort: null, sid, runId, error: lastError?.message || null, via: "node-fallback" };
}
