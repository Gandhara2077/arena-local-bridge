// A §4.33 / §4.36 regression suite. The idempotency keys have to describe the
// CALLER's logical request, not the text we actually hand to Arena.
//
// Two things get added to the prompt after the logical request is known — the
// local MCP preamble (once per Session) and a random end-of-turn marker (once
// per request). A key derived from the finished text would differ between an
// attempt and its retry: dedupe would miss, the client's timeout would send the
// turn into Arena a second time, and a named retry would never hit the result
// cache. Both keys are therefore derived inside this one function, from the one
// argument that is still logical — and the finished text is only reachable
// through the `decorate` it hands back, so a caller cannot key off it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareTurnInput, IDEMPOTENCY_HEADER } from "../src/bridge.mjs";

const SID_A = "3f2a1b4c-5d6e-4a7b-8c9d-0e1f2a3b4c5d";
const SID_B = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const PREAMBLE = "[本地 MCP 已接入] endpoint: https://example.trycloudflare.com/mcp";

// ── the inflight key: joins a run that is still going ────────────────────────

test("prepareTurnInput: the inflight key ignores the per-request marker", () => {
  const first = prepareTurnInput({ sessionId: SID_A, prompt: "hello" });
  const retry = prepareTurnInput({ sessionId: SID_A, prompt: "hello" });
  assert.equal(first.inflightKey, retry.inflightKey);
  // …even though what goes to Arena really does differ.
  assert.notEqual(first.decorate({ marker: "DONE-AAAA" }), retry.decorate({ marker: "DONE-BBBB" }));
});

test("prepareTurnInput: the inflight key ignores the one-shot MCP preamble", () => {
  // The retry carries no preamble: injection is once per Session (§4.25).
  const firstCall = prepareTurnInput({ sessionId: SID_A, prompt: "hello" });
  const retry = prepareTurnInput({ sessionId: SID_A, prompt: "hello" });
  firstCall.decorate({ preamble: PREAMBLE, marker: "DONE-AAAA" });
  retry.decorate({ marker: "DONE-BBBB" });
  assert.equal(firstCall.inflightKey, retry.inflightKey);
});

test("prepareTurnInput: the marker switch is transparent to the inflight key", () => {
  const markerOn = prepareTurnInput({ sessionId: SID_A, prompt: "hello" });
  const markerOff = prepareTurnInput({ sessionId: SID_A, prompt: "hello" });
  assert.equal(markerOn.inflightKey, markerOff.inflightKey);
  assert.equal(markerOff.decorate(), "hello");
  assert.ok(markerOn.decorate({ marker: "DONE-AAAA" }).includes("DONE-AAAA"));
});

test("prepareTurnInput: the inflight key is scoped to Session and request", () => {
  const base = prepareTurnInput({ sessionId: SID_A, prompt: "hello" }).inflightKey;
  assert.notEqual(base, prepareTurnInput({ sessionId: SID_B, prompt: "hello" }).inflightKey);
  assert.notEqual(base, prepareTurnInput({ sessionId: SID_A, prompt: "hello?" }).inflightKey);
});

// ── the replay key: replays a run that already finished ──────────────────────

// This is the one that would have caught the bug: the previous version derived
// the replay key from the DECORATED prompt at the call site, so the preamble and
// the fresh marker leaked back into it and a named retry could never match. The
// two attempts below differ in every decoration and must still replay.
test("prepareTurnInput: a named retry replays across differing decorations", () => {
  const first = prepareTurnInput({ sessionId: SID_A, prompt: "hello", idempotencyKey: "req-1" });
  const retry = prepareTurnInput({ sessionId: SID_A, prompt: "hello", idempotencyKey: "req-1" });
  first.decorate({ preamble: PREAMBLE, marker: "DONE-AAAA" });
  retry.decorate({ marker: "DONE-BBBB" });
  assert.notEqual(first.replayKey, "");
  assert.equal(first.replayKey, retry.replayKey);
});

test("prepareTurnInput: an unnamed request has no replay key", () => {
  // Sending the same prompt again is not proof of a retry, so there is nothing
  // to match against and the second prompt starts a new turn.
  for (const idempotencyKey of [undefined, "", "   "]) {
    assert.equal(prepareTurnInput({ sessionId: SID_A, prompt: "hello", idempotencyKey }).replayKey, "");
  }
});

test("prepareTurnInput: the replay key follows the caller's identity", () => {
  const first = prepareTurnInput({ sessionId: SID_A, prompt: "hello", idempotencyKey: "req-1" }).replayKey;
  const sameId = prepareTurnInput({ sessionId: SID_A, prompt: "hello", idempotencyKey: "req-1" }).replayKey;
  const otherId = prepareTurnInput({ sessionId: SID_A, prompt: "hello", idempotencyKey: "req-2" }).replayKey;
  assert.equal(first, sameId);
  assert.notEqual(first, otherId);
});

test("prepareTurnInput: the replay key is scoped to Session and request", () => {
  const base = prepareTurnInput({ sessionId: SID_A, prompt: "hello", idempotencyKey: "req-1" }).replayKey;
  assert.notEqual(base, prepareTurnInput({ sessionId: SID_B, prompt: "hello", idempotencyKey: "req-1" }).replayKey);
  assert.notEqual(base, prepareTurnInput({ sessionId: SID_A, prompt: "other", idempotencyKey: "req-1" }).replayKey);
});

test("prepareTurnInput: the two keys never collide", () => {
  const r = prepareTurnInput({ sessionId: SID_A, prompt: "hello", idempotencyKey: "req-1" });
  assert.notEqual(r.inflightKey, r.replayKey);
});

test("IDEMPOTENCY_HEADER: the caller-facing name is stable", () => {
  assert.equal(IDEMPOTENCY_HEADER, "x-arena-idempotency-key");
});

// ── what actually goes to Arena ─────────────────────────────────────────────

test("prepareTurnInput: keeps the existing Arena prompt shapes", () => {
  const plain = prepareTurnInput({ sessionId: SID_A, prompt: "hello" });
  assert.equal(plain.decorate(), "hello");
  assert.equal(plain.decorate({ preamble: "PRE" }), "PRE\nhello");
  assert.equal(
    plain.decorate({ marker: "DONE-AAAA" }),
    "hello\n\n（本轮任务完成后，请在最后单独一行原样输出这串标记，不要解释它：DONE-AAAA）"
  );
  // Decorating never rewrote the request the keys were derived from.
  assert.equal(plain.decorate({ preamble: "PRE", marker: "DONE-AAAA" }), "PRE\nhello\n\n（本轮任务完成后，请在最后单独一行原样输出这串标记，不要解释它：DONE-AAAA）");
});
