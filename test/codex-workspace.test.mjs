import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  extractCwd,
  matchRolloutNames,
  resolveCodexWorkspace,
  resolveRecentCodexWorkspace,
  soleRecentTranscript,
} from "../src/codex-workspace.mjs";

const SID = "01a0bd57-e17a-7fd1-a4bf-e9ad5adfd7fd";
const OTHER = "01a0bfb3-49c2-7d01-a99c-1d6682022310";

function root() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-sessions-"));
}

function writeRollout(sessionsRoot, relDir, name, body) {
  const dir = path.join(sessionsRoot, relDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, body, "utf8");
  return file;
}

test("extractCwd recovers a Windows path, unescaping backslashes", () => {
  assert.equal(extractCwd('{"payload":{},"cwd":"D:\\\\deepcode\\\\proj"}'), "D:\\deepcode\\proj");
});

test("extractCwd returns nothing when the transcript has no cwd", () => {
  assert.equal(extractCwd('{"ordinal":0}'), "");
  assert.equal(extractCwd(""), "");
});

test("matchRolloutNames accepts both the plain and the continued filename", () => {
  const names = [
    `2026/09/20/rollout-2026-09-20T13-44-08-${OTHER}_${SID}.jsonl`,
    `2026/09/21/rollout-2026-09-21T00-43-13-${SID}.jsonl`,
    `2026/09/21/rollout-2026-09-21T00-43-13-${OTHER}.jsonl`,
  ];
  assert.deepEqual(matchRolloutNames(names, SID), [
    `2026/09/20/rollout-2026-09-20T13-44-08-${OTHER}_${SID}.jsonl`,
    `2026/09/21/rollout-2026-09-21T00-43-13-${SID}.jsonl`,
  ]);
  assert.deepEqual(matchRolloutNames(names, ""), []);
});

test("resolveCodexWorkspace finds the conversation by its session id", () => {
  const sessions = root();
  writeRollout(sessions, "2026/09/20", `rollout-2026-09-20T12-55-36-${SID}.jsonl`,
    `{"session_id":"${SID}","cwd":"D:\\\\deepcode"}`);
  assert.equal(resolveCodexWorkspace({ sessionsRoot: sessions, sessionId: SID }), "D:\\deepcode");
});

test("it finds a long-running conversation whose date directory is long past", () => {
  const sessions = root();
  writeRollout(sessions, "2026/09/16", `rollout-2026-09-16T23-17-08-${SID}.jsonl`,
    '{"cwd":"D:\\\\old\\\\project"}');
  assert.equal(resolveCodexWorkspace({ sessionsRoot: sessions, sessionId: SID }), "D:\\old\\project");
});

test("resolveCodexWorkspace returns nothing for an unknown session instead of guessing", () => {
  const sessions = root();
  writeRollout(sessions, "2026/09/20", `rollout-2026-09-20T12-55-36-${OTHER}.jsonl`, '{"cwd":"D:\\\\unrelated"}');
  assert.equal(resolveCodexWorkspace({ sessionsRoot: sessions, sessionId: SID }), "");
});

test("resolveCodexWorkspace tolerates a missing root and empty input", () => {
  assert.equal(resolveCodexWorkspace({ sessionsRoot: path.join(os.tmpdir(), "nope-" + SID), sessionId: SID }), "");
  assert.equal(resolveCodexWorkspace({ sessionsRoot: "", sessionId: SID }), "");
  assert.equal(resolveCodexWorkspace({ sessionsRoot: "/tmp", sessionId: "" }), "");
});

test("soleRecentTranscript answers only when exactly one conversation is active", () => {
  const now = 1_000_000;
  const fresh = now - 5_000;
  const stale = now - 10 * 60_000;
  assert.equal(soleRecentTranscript([{ file: "a", mtimeMs: fresh }], now), "a");
  assert.equal(soleRecentTranscript([{ file: "a", mtimeMs: fresh }, { file: "b", mtimeMs: fresh }], now), "");
  assert.equal(soleRecentTranscript([{ file: "a", mtimeMs: stale }], now), "");
  assert.equal(soleRecentTranscript([], now), "");
});

test("resolveRecentCodexWorkspace finds the one active conversation's directory", () => {
  const sessions = root();
  writeRollout(sessions, "2026/09/20", `rollout-2026-09-20T13-44-08-${OTHER}_${SID}.jsonl`,
    '{"cwd":"D:\\\\deepcode\\\\objects"}');
  const out = resolveRecentCodexWorkspace({ sessionsRoot: sessions });
  assert.equal(out, "D:\\deepcode\\objects");
});

test("resolveRecentCodexWorkspace stays silent when two conversations are active", () => {
  const sessions = root();
  writeRollout(sessions, "2026/09/20", `rollout-a-${SID}.jsonl`, '{"cwd":"D:\\\\one"}');
  writeRollout(sessions, "2026/09/21", `rollout-b-${OTHER}.jsonl`, '{"cwd":"D:\\\\two"}');
  assert.equal(resolveRecentCodexWorkspace({ sessionsRoot: sessions }), "");
});

test("resolveRecentCodexWorkspace ignores a conversation left idle", () => {
  const sessions = root();
  writeRollout(sessions, "2026/09/20", `rollout-${SID}.jsonl`, '{"cwd":"D:\\\\one"}');
  const old = new Date(Date.now() - 30 * 60_000);
  fs.utimesSync(path.join(sessions, "2026/09/20", `rollout-${SID}.jsonl`), old, old);
  assert.equal(resolveRecentCodexWorkspace({ sessionsRoot: sessions }), "");
});

test("a transcript with no cwd yields nothing rather than a wrong path", () => {
  const sessions = root();
  writeRollout(sessions, "2026/09/20", `rollout-2026-09-20T12-55-36-${SID}.jsonl`, '{"ordinal":0}');
  assert.equal(resolveCodexWorkspace({ sessionsRoot: sessions, sessionId: SID }), "");
});
