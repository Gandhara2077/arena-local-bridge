import { test } from "node:test";
import assert from "node:assert/strict";
import {
  UNRESOLVED,
  emptyState,
  clientSessionId,
  groupSessions,
  markDead,
  markOk,
  markUsed,
  bind,
  unbind,
  forgetSession,
  resolveBinding,
} from "../src/pool.mjs";

const SESSION_A = {
  sessionId: "11111111-1111-4111-8111-111111111111",
  model: "kimi-k3",
  title: "kimi-k3 · 09-20 10:00",
  url: "https://arena.ai/agent/11111111-1111-4111-8111-111111111111",
  email: "a@example.com",
  collectedAt: "2026-09-20 10:00:00",
  prompt: "hi",
};

const SESSION_B = {
  ...SESSION_A,
  sessionId: "22222222-2222-4222-8222-222222222222",
  title: "kimi-k3 · 09-21 10:00",
  url: "https://arena.ai/agent/22222222-2222-4222-8222-222222222222",
  email: "b@example.com",
  collectedAt: "2026-09-21 10:00:00",
};

const UNRESOLVED_SESSION = {
  ...SESSION_A,
  sessionId: "33333333-3333-4333-8333-333333333333",
  model: UNRESOLVED,
  url: "https://arena.ai/agent/33333333-3333-4333-8333-333333333333",
  collectedAt: "2026-09-22 10:00:00",
};

function groupFor(groups, model) {
  return groups.find((g) => g.model === model);
}

test("groupSessions puts sessions of the same Model into one ModelPool", () => {
  const groups = groupSessions([SESSION_A, SESSION_B], emptyState());
  assert.equal(groups.length, 1);
  const pool = groupFor(groups, "kimi-k3");
  assert.equal(pool.sessions.length, 2);
  assert.equal(pool.unresolved, false);
});

test("groupSessions keeps Unresolved sessions in their own bucket, not as a Model", () => {
  const groups = groupSessions([SESSION_A, UNRESOLVED_SESSION], emptyState());
  assert.equal(groups.length, 2);
  const bucket = groups.find((g) => g.unresolved);
  assert.equal(bucket.model, UNRESOLVED);
  assert.equal(bucket.sessions.length, 1);
  assert.equal(bucket.sessions[0].sessionId, UNRESOLVED_SESSION.sessionId);
});

test("groupSessions treats an empty Model as Unresolved", () => {
  const groups = groupSessions([{ ...SESSION_A, model: "" }], emptyState());
  assert.equal(groups.length, 1);
  assert.equal(groups[0].unresolved, true);
});

test("groupSessions reports how many sessions are ok and how many are Suspected Dead", () => {
  let state = emptyState();
  state = markDead(state, SESSION_A.sessionId, "2026-09-23T00:00:00.000Z");
  const groups = groupSessions([SESSION_A, SESSION_B], state);
  const pool = groupFor(groups, "kimi-k3");
  assert.equal(pool.total, 2);
  assert.equal(pool.ok, 1);
  assert.equal(pool.suspectedDead, 1);
});

test("groupSessions reports the most recent collection time and the most recent use", () => {
  let state = emptyState();
  state = markUsed(state, SESSION_A.sessionId, "2026-09-21T09:00:00.000Z");
  state = markUsed(state, SESSION_B.sessionId, "2026-09-22T09:00:00.000Z");
  const pool = groupFor(groupSessions([SESSION_A, SESSION_B], state), "kimi-k3");
  assert.equal(pool.lastCollectedAt, "2026-09-21 10:00:00");
  assert.equal(pool.lastUsedAt, "2026-09-22T09:00:00.000Z");
});

test("groupSessions lists which Accounts contributed to the pool", () => {
  const pool = groupFor(groupSessions([SESSION_A, SESSION_B], emptyState()), "kimi-k3");
  assert.deepEqual(pool.accounts.sort(), ["a@example.com", "b@example.com"]);
});

test("groupSessions returns no pools for no sessions", () => {
  assert.deepEqual(groupSessions([], emptyState()), []);
});

test("markDead records the failure time and leaves the input state untouched", () => {
  const before = emptyState();
  const after = markDead(before, SESSION_A.sessionId, "2026-09-23T00:00:00.000Z");
  assert.equal(before.sessions[SESSION_A.sessionId], undefined);
  assert.equal(after.sessions[SESSION_A.sessionId].state, "suspected-dead");
  assert.equal(after.sessions[SESSION_A.sessionId].lastFailedAt, "2026-09-23T00:00:00.000Z");
});

test("markOk clears a Suspected Dead session", () => {
  let state = markDead(emptyState(), SESSION_A.sessionId, "2026-09-23T00:00:00.000Z");
  state = markOk(state, SESSION_A.sessionId);
  assert.equal(state.sessions[SESSION_A.sessionId].state, "ok");
});

test("bind then resolveBinding returns the same Session for the same client", () => {
  const state = bind(emptyState(), "client-1", SESSION_A.sessionId, "2026-09-23T00:00:00.000Z");
  const result = resolveBinding(state, "client-1");
  assert.deepEqual(result, { ok: true, sessionId: SESSION_A.sessionId });
});

test("resolveBinding reports no binding when the client is unknown", () => {
  assert.deepEqual(resolveBinding(emptyState(), "client-1"), { ok: false, code: "no_binding" });
});

test("resolveBinding refuses a dead binding instead of silently switching session", () => {
  let state = bind(emptyState(), "client-1", SESSION_A.sessionId, "2026-09-23T00:00:00.000Z");
  state = markDead(state, SESSION_A.sessionId, "2026-09-23T01:00:00.000Z");
  const result = resolveBinding(state, "client-1");
  assert.deepEqual(result, {
    ok: false,
    code: "bound_session_dead",
    sessionId: SESSION_A.sessionId,
  });
});

test("unbind drops the binding", () => {
  let state = bind(emptyState(), "client-1", SESSION_A.sessionId, "2026-09-23T00:00:00.000Z");
  state = unbind(state, "client-1");
  assert.deepEqual(resolveBinding(state, "client-1"), { ok: false, code: "no_binding" });
});

// 删除 a Session must not leave derived state behind. A stale health row is
// harmless, but a stale Binding would keep pointing callers at a Session that
// no longer exists — worse than no binding, because the failure moves to Arena.
test("forgetSession drops the health entry and keeps the others", () => {
  let state = markDead(emptyState(), SESSION_A.sessionId, "2026-09-23T00:00:00.000Z");
  state = markUsed(state, SESSION_B.sessionId, "2026-09-23T00:00:00.000Z");

  state = forgetSession(state, SESSION_A.sessionId);

  assert.equal(state.sessions[SESSION_A.sessionId], undefined);
  assert.ok(state.sessions[SESSION_B.sessionId]);
});

test("forgetSession drops every binding that pointed at the session", () => {
  let state = bind(emptyState(), "client-1", SESSION_A.sessionId, null);
  state = bind(state, "client-2", SESSION_B.sessionId, null);

  state = forgetSession(state, SESSION_A.sessionId);

  assert.equal(state.bindings["client-1"], undefined);
  assert.ok(state.bindings["client-2"]);
  assert.deepEqual(resolveBinding(state, "client-1"), { ok: false, code: "no_binding" });
});

test("forgetSession matches the id regardless of case, and ignores empty input", () => {
  let state = bind(emptyState(), "client-1", SESSION_A.sessionId, null);
  state = forgetSession(state, SESSION_A.sessionId.toUpperCase());
  assert.equal(state.bindings["client-1"], undefined);

  const untouched = emptyState();
  assert.equal(forgetSession(untouched, ""), untouched);
});

test("clientSessionId prefers the standard session header", () => {
  const headers = { "x-codex-session-id": "from-codex", "x-session-id": "from-session" };
  assert.equal(clientSessionId(headers), "from-codex");
});

test("clientSessionId falls back through the headers format.mjs already reads", () => {
  assert.equal(clientSessionId({ "x-session-id": "from-session" }), "from-session");
  assert.equal(clientSessionId({ "x-omniroute-session": "from-omni" }), "from-omni");
});

test("clientSessionId is empty when the client sends no session header", () => {
  assert.equal(clientSessionId({}), "");
});
