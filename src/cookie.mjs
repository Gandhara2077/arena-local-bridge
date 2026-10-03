// cookie.mjs — arena.ai cookie header <-> Playwright cookie objects,
// plus auth-token expiry parsing. Pure module (testable).
export const AUTH_PREFIX = "arena-auth-prod-v1";

export function cookieHeaderToObjects(raw) {
  const cookies = [];
  for (const segment of String(raw ?? "").split(";")) {
    const pair = segment.trim();
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    cookies.push({
      name: pair.slice(0, separator),
      value: pair.slice(separator + 1),
      domain: "arena.ai",
      path: "/",
      secure: true,
      httpOnly: false,
      sameSite: "Lax",
    });
  }
  return cookies;
}

export function cookieObjectsToHeader(objects) {
  const list = Array.isArray(objects) ? objects : [];
  return list.map((c) => `${c.name}=${c.value}`).join("; ");
}

/** Extract the joined value of arena-auth-prod-v1[.N] chunks. */
export function getAuthValue(raw) {
  const cookies = cookieHeaderToObjects(raw);
  const direct = cookies.find(({ name }) => name === AUTH_PREFIX);
  if (direct?.value) return direct.value;

  const chunks = new Map();
  for (const { name, value } of cookies) {
    const match = /^arena-auth-prod-v1\.(\d+)$/.exec(name);
    if (match) chunks.set(Number(match[1]), value);
  }
  const ordered = [];
  while (chunks.has(ordered.length)) ordered.push(chunks.get(ordered.length));
  return ordered.join("");
}

/** Return the auth token's expires_at epoch-ms (0 when unparsable).
 *  Arena stores expires_at in SECONDS; normalize to ms. */
export function authExpiryMs(raw) {
  try {
    const value = getAuthValue(raw);
    if (!value.startsWith("base64-")) return 0;
    const json = Buffer.from(value.slice("base64-".length), "base64").toString("utf8");
    const expiresAt = Number(JSON.parse(json).expires_at || 0);
    return expiresAt > 0 && expiresAt < 1e12 ? expiresAt * 1000 : expiresAt;
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
