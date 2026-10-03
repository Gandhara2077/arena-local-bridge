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

// A quick-tunnel URL is a credential: the random subdomain is what keeps it
// unguessable, and anyone holding it plus the token can reach this machine's
// workspace. Keep the service domain so a log still says which tunnel came up,
// hide the part that makes it ours.
export function maskTunnelUrl(url) {
  try {
    const parsed = new URL(String(url));
    const host = parsed.hostname;
    // An IP literal or `localhost` carries nothing to hide. Checked explicitly
    // rather than left to label counting: assigning a masked value to an IPv4
    // host is silently ignored by URL, which would make this look correct for
    // the wrong reason.
    const isIp = /^\d+(\.\d+){3}$/.test(host) || host.startsWith("[");
    const labels = host.split(".");
    if (!isIp && labels.length > 2) parsed.hostname = `***.${labels.slice(-2).join(".")}`;
    return parsed.toString();
  } catch {
    return String(url ?? "").replace(/[A-Za-z0-9._-]{8,}/g, "***");
  }
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
  let value = String(raw ?? "").trim();
  for (const [pattern, replacement] of [
    [/^```(?:json)?\s*/i, ""],
    [/\s*```$/i, ""],
    [/([{,]\s*)([A-Za-z_][A-Za-z0-9_-]*)(\s*:)/g, '$1"$2"$3'],
    [/,\s*([}\]])/g, "$1"],
    [/\bTrue\b/g, "true"],
    [/\bFalse\b/g, "false"],
    [/\bNone\b/g, "null"],
  ]) value = value.replace(pattern, replacement);

  for (const candidate of [value, value.replace(/'/g, '"')]) {
    try {
      return JSON.parse(candidate);
    } catch {
      // The second candidate accepts the existing single-quote convention.
    }
  }
  return null;
}

// ── tiny structured JSON logger ──────────────────────────────
function writeLog(method, level, event, msg, fields) {
  const err = level === "error" && fields.err instanceof Error ? fields.err : null;
  const entry = { ts: new Date().toISOString(), level, event, msg, ...fields };
  if (err) {
    entry.errorName = err.name;
    entry.errorMessage = err.message;
    entry.errorStack = err.stack ? err.stack.split("\n").slice(0, 6).join(" | ") : "";
    delete entry.err;
  }
  console[method](JSON.stringify(entry));
}

export const log = {
  info(event, msg, fields = {}) {
    writeLog("log", "info", event, msg, fields);
  },
  warn(event, msg, fields = {}) {
    writeLog("warn", "warn", event, msg, fields);
  },
  error(event, msg, fields = {}) {
    writeLog("error", "error", event, msg, fields);
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
      const capped = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      const delayMs = Math.round(capped * (0.7 + Math.random() * 0.6));
      log.warn("retry", `${label} attempt ${attempt}/${attempts} failed; retrying in ${delayMs}ms`, {
        attempt,
        errorType: error?.name || "Error",
      });
      await sleep(delayMs);
    }
  }
  throw lastError;
}
