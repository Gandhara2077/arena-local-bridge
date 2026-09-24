// pool.mjs — ModelPool: an index and locator over archived Sessions.
//
// A ModelPool is "every Session of one Model". It is NOT a scheduler: it never
// picks a Session on the caller's behalf, because conversation context lives on
// the Arena side and is bound to one specific Session — switching Sessions
// silently would drop that context.
//
// Everything here is pure: state in, state out. Persistence lives in server.mjs
// so the interesting logic stays testable without touching the filesystem.
//
// 术语（见 CONTEXT.md）: Model / Session / ModelPool / 未识别 / 绑定 / 疑似失效
import { CLIENT_SESSION_HEADERS, firstHeader } from "./format.mjs";

export const UNRESOLVED = "未识别";

const STATE_VERSION = 1;
const OK = "ok";
const DEAD = "suspected-dead";

/** The empty pool state. Sessions default to `ok`; only real failures move them. */
export function emptyState() {
  return { version: STATE_VERSION, sessions: {}, bindings: {} };
}

/**
 * 未识别 is a missing Model, not a Model of its own. The harvester also writes
 * longer variants ("未识别（未捕获本轮 run 令牌…）"), so match on the prefix.
 */
export function isUnresolved(model) {
  const m = String(model || "").trim();
  return m === "" || m.startsWith(UNRESOLVED);
}

/**
 * Which client conversation a request belongs to, if the client tells us.
 * Reuses format.mjs's header list so a binding lands on the same identity the
 * rest of the bridge already keys on — no second, drifting implementation.
 */
export function clientSessionId(headers) {
  return firstHeader(headers, CLIENT_SESSION_HEADERS);
}

function withSession(state, sessionId, patch) {
  const prev = state.sessions?.[sessionId] || { state: OK, lastFailedAt: null, lastUsedAt: null };
  return {
    ...state,
    sessions: { ...state.sessions, [sessionId]: { ...prev, ...patch } },
  };
}

/** A request really failed against this Session: the only trusted dead signal. */
export function markDead(state, sessionId, at = null) {
  return withSession(state, sessionId, { state: DEAD, lastFailedAt: at });
}

/** Clear the dead mark (used when a manual check proves the Session alive). */
export function markOk(state, sessionId) {
  return withSession(state, sessionId, { state: OK, lastFailedAt: null });
}

export function markUsed(state, sessionId, at = null) {
  return withSession(state, sessionId, { lastUsedAt: at });
}

export function bind(state, clientId, sessionId, at = null) {
  return { ...state, bindings: { ...state.bindings, [clientId]: { sessionId, boundAt: at } } };
}

export function unbind(state, clientId) {
  const bindings = { ...state.bindings };
  delete bindings[clientId];
  return { ...state, bindings };
}

/**
 * Resolve a client's Binding. Never substitutes another Session: a dead binding
 * is reported so the caller can choose, because switching would drop context.
 */
export function resolveBinding(state, clientId) {
  const binding = state.bindings?.[clientId];
  if (!binding) return { ok: false, code: "no_binding" };
  if (state.sessions?.[binding.sessionId]?.state === DEAD) {
    return { ok: false, code: "bound_session_dead", sessionId: binding.sessionId };
  }
  return { ok: true, sessionId: binding.sessionId };
}

/**
 * Derive ModelPools from the flat archived Sessions plus the pool state.
 * 未识别 gets its own bucket instead of masquerading as a Model.
 */
export function groupSessions(sessions, state) {
  const st = state || emptyState();
  const buckets = new Map();
  for (const s of sessions || []) {
    const key = isUnresolved(s.model) ? UNRESOLVED : String(s.model).trim();
    if (!buckets.has(key)) buckets.set(key, []);
    const record = st.sessions?.[s.sessionId];
    buckets.get(key).push({
      ...s,
      unresolved: isUnresolved(s.model),
      state: record?.state || OK,
      lastUsedAt: record?.lastUsedAt || null,
      lastFailedAt: record?.lastFailedAt || null,
    });
  }
  const groups = [];
  for (const [model, list] of buckets) {
    const dead = list.filter((s) => s.state === DEAD).length;
    groups.push({
      model,
      unresolved: model === UNRESOLVED,
      sessions: list,
      total: list.length,
      ok: list.length - dead,
      suspectedDead: dead,
      lastCollectedAt: list.map((s) => s.collectedAt).filter(Boolean).sort().pop() || null,
      lastUsedAt: list.map((s) => s.lastUsedAt).filter(Boolean).sort().pop() || null,
      accounts: [...new Set(list.map((s) => s.email).filter(Boolean))],
    });
  }
  // Real Models first (alphabetical), the 未识别 bucket last.
  return groups.sort((a, b) => {
    if (a.unresolved !== b.unresolved) return a.unresolved ? 1 : -1;
    return a.model.localeCompare(b.model);
  });
}
