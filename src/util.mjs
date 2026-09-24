// util.mjs — tiny helpers shared across the bridge (pure, no I/O deps)
import crypto from "node:crypto";

export function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function maskEmail(email) {
  const s = String(email || "");
  if (!s.includes("@")) return s ? `${s.slice(0, 2)}***` : "-";
  const [user, domain] = s.split("@");
  return `${user.slice(0, 1)}***@${domain}`;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function randomId(prefix = "id") {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;
}

export function compactText(value, maxLength) {
  const text = String(value ?? "");
  if (text.length <= maxLength) return text;
  const head = Math.floor(maxLength * 0.72);
  const tail = maxLength - head;
  return `${text.slice(0, head)}\n...[compacted ${text.length - maxLength} chars]...\n${text.slice(-tail)}`;
}

export function compactSchema(value, depth = 0) {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 4) return {};
  const out = {};
  for (const key of ["type", "format", "default", "const"]) {
    if (value[key] !== undefined) out[key] = value[key];
  }
  if (Array.isArray(value.enum)) out.enum = value.enum.slice(0, 40);
  if (Array.isArray(value.required)) out.required = value.required;
  if (value.additionalProperties !== undefined) out.additionalProperties = value.additionalProperties;
  if (value.items && typeof value.items === "object") out.items = compactSchema(value.items, depth + 1);
  if (value.properties && typeof value.properties === "object") {
    out.properties = Object.fromEntries(
      Object.entries(value.properties).map(([name, schema]) => [name, compactSchema(schema, depth + 1)])
    );
  }
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(value[key])) out[key] = value[key].slice(0, 8).map((v) => compactSchema(v, depth + 1));
  }
  return out;
}

export function looseJson(raw) {
  const value = String(raw ?? "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_-]*)(\s*:)/g, '$1"$2"$3')
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/\bTrue\b/g, "true")
    .replace(/\bFalse\b/g, "false")
    .replace(/\bNone\b/g, "null");
  try {
    return JSON.parse(value);
  } catch {
    try {
      return JSON.parse(value.replace(/'/g, '"'));
    } catch {
      return null;
    }
  }
}

// ── tiny structured JSON logger ──────────────────────────────
function iso() {
  return new Date().toISOString();
}

export const log = {
  info(event, msg, fields = {}) {
    console.log(JSON.stringify({ ts: iso(), level: "info", event, msg, ...fields }));
  },
  warn(event, msg, fields = {}) {
    console.warn(JSON.stringify({ ts: iso(), level: "warn", event, msg, ...fields }));
  },
  error(event, msg, fields = {}) {
    const err = fields.err instanceof Error ? fields.err : null;
    const out = { ts: iso(), level: "error", event, msg, ...fields };
    if (err) {
      out.errorName = err.name;
      out.errorMessage = err.message;
      out.errorStack = err.stack ? err.stack.split("\n").slice(0, 6).join(" | ") : "";
      delete out.err;
    }
    console.error(JSON.stringify(out));
  },
};

// ── retry with exponential backoff + jitter ──────────────────
export async function retry(fn, { attempts = 3, baseMs = 500, maxMs = 8000, shouldRetry = () => true, label = "op" } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !shouldRetry(error)) throw error;
      const backoff = Math.min(maxMs, baseMs * 2 ** (attempt - 1)) * (0.7 + Math.random() * 0.6);
      log.warn("retry", `${label} attempt ${attempt}/${attempts} failed; retrying in ${Math.round(backoff)}ms`, {
        attempt,
        errorType: error?.name || "Error",
      });
      await sleep(Math.round(backoff));
    }
  }
  throw lastError;
}
