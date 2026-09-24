// cookie.mjs — arena.ai cookie header <-> Playwright cookie objects,
// plus auth-token expiry parsing. Pure module (testable).
import { record } from "./util.mjs";

export const AUTH_PREFIX = "arena-auth-prod-v1";

export function cookieHeaderToObjects(raw) {
  return String(raw ?? "")
    .split(";")
    .map((x) => x.trim())
    .filter((x) => x.includes("="))
    .map((x) => {
      const i = x.indexOf("=");
      return {
        name: x.slice(0, i),
        value: x.slice(i + 1),
        domain: "arena.ai",
        path: "/",
        secure: true,
        httpOnly: false,
        sameSite: "Lax",
      };
    });
}

export function cookieObjectsToHeader(objects) {
  const list = Array.isArray(objects) ? objects : [];
  return list.map((c) => `${c.name}=${c.value}`).join("; ");
}

/** Extract the joined value of arena-auth-prod-v1[.N] chunks. */
export function getAuthValue(raw) {
  const parts = String(raw ?? "")
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p.includes("="))
    .map((p) => {
      const i = p.indexOf("=");
      return [p.slice(0, i), p.slice(i + 1)];
    });
  let value = parts.find(([name]) => name === AUTH_PREFIX)?.[1] || "";
  if (!value) {
    const chunks = new Map(
      parts
        .filter(([name]) => /^arena-auth-prod-v1\.\d+$/.test(name))
        .map(([name, v]) => [Number(name.split(".").at(-1)), v])
    );
    for (let i = 0; chunks.has(i); i++) value += chunks.get(i);
  }
  return value;
}

/** Return the auth token's expires_at epoch-ms (0 when unparsable).
 *  Arena stores expires_at in SECONDS; normalize to ms. */
export function authExpiryMs(raw) {
  try {
    const value = getAuthValue(raw);
    if (!value.startsWith("base64-")) return 0;
    const payload = JSON.parse(Buffer.from(value.slice(7), "base64").toString("utf8"));
    let expiresAt = Number(payload.expires_at || 0);
    if (expiresAt > 0 && expiresAt < 1e12) expiresAt *= 1000; // seconds -> ms
    return expiresAt;
  } catch {
    return 0;
  }
}

export function secondsToExpiry(raw, now = Date.now()) {
  const exp = authExpiryMs(raw);
  if (!exp) return null; // unknown -> treat as fresh
  return Math.round((exp - now) / 1000);
}

export function cookieObjectsForProfile(raw) {
  return cookieHeaderToObjects(raw);
}
