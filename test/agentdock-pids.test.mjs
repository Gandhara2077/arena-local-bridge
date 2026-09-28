// Stopping a tunnel must only touch processes that are ours. The old code swept
// the whole system by image name, which killed anyone else's cloudflared too.
//
// The hard part is the PIDs read back from a previous run: a recycled PID can
// now belong to something completely unrelated, so those are only touched once
// their image name confirms they are still one of ours.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTasklistCsv, pidsToStop } from "../src/agentdock.mjs";

const TASKLIST = [
  '"Image Name","PID","Session Name","Session#","Mem Usage"',
  '"cloudflared.exe","1234","Console","1","12,345 K"',
  '"agentdock.exe","5678","Console","1","8,000 K"',
  '"explorer.exe","9012","Console","1","100,000 K"',
].join("\r\n");

test("parseTasklistCsv: maps pid to image name, skipping the header", () => {
  const names = parseTasklistCsv(TASKLIST);
  assert.equal(names["1234"], "cloudflared.exe");
  assert.equal(names["5678"], "agentdock.exe");
  assert.equal(names["9012"], "explorer.exe");
});

test("parseTasklistCsv: empty or malformed output yields an empty map", () => {
  assert.deepEqual(parseTasklistCsv(""), {});
  assert.deepEqual(parseTasklistCsv("INFO: No tasks are running."), {});
});

test("pidsToStop: PIDs we spawned this run are ours by construction", () => {
  const pids = pidsToStop({ tracked: [1234, 5678], persisted: [], names: {} });
  assert.deepEqual(pids, [1234, 5678]);
});

test("pidsToStop: a persisted PID is only stopped once its image name confirms it", () => {
  const names = { 1234: "cloudflared.exe", 9012: "explorer.exe" };
  // 1234 still is cloudflared → ours. 9012 has been recycled by explorer → not ours.
  assert.deepEqual(pidsToStop({ tracked: [], persisted: [1234, 9012], names }), [1234]);
});

test("pidsToStop: a persisted PID that is no longer running is dropped", () => {
  assert.deepEqual(pidsToStop({ tracked: [], persisted: [4321], names: {} }), []);
});

test("pidsToStop: dedupes and drops junk", () => {
  const names = { 1234: "cloudflared.exe" };
  assert.deepEqual(
    pidsToStop({ tracked: [1234], persisted: [1234, 0, -1, 1.5, "1234", null], names }),
    [1234]
  );
});

test("pidsToStop: never returns our own PID", () => {
  assert.deepEqual(pidsToStop({ tracked: [999], persisted: [999], names: {}, selfPid: 999 }), []);
});
