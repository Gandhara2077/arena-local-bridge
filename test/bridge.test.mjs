// A §4.33 / §4.36 regression suite: the idempotency key has to describe the
// CALLER's logical request, not the text we actually hand to Arena.
//
// Two things get added to the prompt after the logical request is known — the
// local MCP preamble (once per Session) and a random end-of-turn marker (once
// per request). If the key were derived from the finished text, the first
// attempt and its retry would hash differently, dedupe would miss, and a client
// timeout would send the turn into Arena a second time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareTurnInput, completedReplayKey, IDEMPOTENCY_HEADER } from "../src/bridge.mjs";

const SID_A = "3f2a1b4c-5d6e-4a7b-8c9d-0e1f2a3b4c5d";
const SID_B = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

test("prepareTurnInput: the key ignores the per-request end-of-turn marker", () => {
  const first = prepareTurnInput({ sessionId: SID_A, prompt: "hello", marker: "DONE-AAAA" });
  const retry = prepareTurnInput({ sessionId: SID_A, prompt: "hello", marker: "DONE-BBBB" });
  assert.equal(first.key, retry.key);
  // …even though what goes to Arena really does differ.
  assert.notEqual(first.finalPrompt, retry.finalPrompt);
});

test("prepareTurnInput: the key ignores the one-shot local MCP preamble", () => {
  const firstCall = prepareTurnInput({
    sessionId: SID_A,
    prompt: "hello",
    preamble: "[本地 MCP 已接入] endpoint: https://example.trycloudflare.com/mcp",
    marker: "DONE-AAAA",
  });
  // The retry carries no preamble: injection is once per Session (§4.25). A clear
  // repro of why the key must come from the caller's request — otherwise the first
  // attempt (preamble present) and the retry (preamble spent) never collide.
  const retry = prepareTurnInput({ sessionId: SID_A, prompt: "hello", marker: "DONE-BBBB" });
  assert.equal(firstCall.key, retry.key);
});

// Both ends of config.turnMarkerEnabled must yield the same key, otherwise
// flipping the switch would silently change dedupe behaviour for every session.
test("prepareTurnInput: the marker switch is transparent to the key", () => {
  const markerOn = prepareTurnInput({ sessionId: SID_A, prompt: "hello", marker: "DONE-AAAA" });
  const markerOff = prepareTurnInput({ sessionId: SID_A, prompt: "hello" });
  assert.equal(markerOn.key, markerOff.key);
  assert.equal(markerOff.finalPrompt, "hello");
  assert.ok(markerOn.finalPrompt.includes("DONE-AAAA"));
});

test("prepareTurnInput: different Session ⇒ different key", () => {
  const a = prepareTurnInput({ sessionId: SID_A, prompt: "hello" });
  const b = prepareTurnInput({ sessionId: SID_B, prompt: "hello" });
  assert.notEqual(a.key, b.key);
});

test("prepareTurnInput: different logical request ⇒ different key", () => {
  const a = prepareTurnInput({ sessionId: SID_A, prompt: "hello" });
  const b = prepareTurnInput({ sessionId: SID_A, prompt: "hello?" });
  assert.notEqual(a.key, b.key);
});

// Finished-result replay is a different decision from joining a running turn, and
// it only happens when the caller names the request. These four pin that down.
test("completedReplayKey: a request with no identity is never replayed", () => {
  // This is the whole point: sending the SAME prompt again is not proof of a retry.
  assert.equal(completedReplayKey({ sessionId: SID_A, prompt: "hello" }), "");
  assert.equal(completedReplayKey({ sessionId: SID_A, prompt: "hello", idempotencyKey: "" }), "");
  assert.equal(completedReplayKey({ sessionId: SID_A, prompt: "hello", idempotencyKey: "   " }), "");
});

test("completedReplayKey: the same identity replays, a different one does not", () => {
  const first = completedReplayKey({ sessionId: SID_A, prompt: "hello", idempotencyKey: "req-1" });
  const retry = completedReplayKey({ sessionId: SID_A, prompt: "hello", idempotencyKey: "req-1" });
  const other = completedReplayKey({ sessionId: SID_A, prompt: "hello", idempotencyKey: "req-2" });
  assert.notEqual(first, "");
  assert.equal(first, retry);
  assert.notEqual(first, other);
});

test("completedReplayKey: scoped to the Session and the prompt", () => {
  const base = completedReplayKey({ sessionId: SID_A, prompt: "hello", idempotencyKey: "req-1" });
  assert.notEqual(base, completedReplayKey({ sessionId: SID_B, prompt: "hello", idempotencyKey: "req-1" }));
  assert.notEqual(base, completedReplayKey({ sessionId: SID_A, prompt: "other", idempotencyKey: "req-1" }));
});

test("IDEMPOTENCY_HEADER: the caller-facing name is stable", () => {
  assert.equal(IDEMPOTENCY_HEADER, "x-arena-idempotency-key");
});

test("prepareTurnInput: keeps the existing Arena prompt shapes", () => {
  const bare = prepareTurnInput({ sessionId: SID_A, prompt: "hello" });
  assert.equal(bare.finalPrompt, "hello");

  const withPreamble = prepareTurnInput({ sessionId: SID_A, prompt: "hello", preamble: "PRE" });
  assert.equal(withPreamble.finalPrompt, "PRE\nhello");

  const withMarker = prepareTurnInput({ sessionId: SID_A, prompt: "hello", marker: "DONE-AAAA" });
  assert.equal(
    withMarker.finalPrompt,
    "hello\n\n（本轮任务完成后，请在最后单独一行原样输出这串标记，不要解释它：DONE-AAAA）"
  );
});
