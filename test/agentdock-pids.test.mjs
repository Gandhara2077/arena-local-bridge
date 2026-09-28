// Stopping a tunnel must only touch processes that are ours. The old code swept
// the whole system by image name, which killed anyone else's cloudflared too.
//
// The hard part is the PIDs read back from a previous run: a recycled PID can
// now belong to something completely unrelated, and an image NAME does not
// settle it — a different program can share the name. Identity comes from the
// executable path recorded when we spawned it.
//
// When the path of a live process cannot be established, the answer is "leave it
// alone": an orphan the user can kill is better than a stranger we killed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseProcessPathsCsv, pidsToStop } from "../src/agentdock.mjs";

const CSV = [
  '"ProcessId","ExecutablePath"',
  '"1234","C:\\AgentDock\\cloudflared.exe"',
  '"5678","C:\\AgentDock\\agentdock.exe"',
  '"9012","C:\\Windows\\explorer.exe"',
].join("\r\n");

const CLOUDFLARED = "C:\\AgentDock\\cloudflared.exe";

test("parseProcessPathsCsv: maps pid to executable path, skipping the header", () => {
  const paths = parseProcessPathsCsv(CSV);
  assert.equal(paths["1234"], CLOUDFLARED);
  assert.equal(paths["5678"], "C:\\AgentDock\\agentdock.exe");
  assert.equal(paths["9012"], "C:\\Windows\\explorer.exe");
});

test("parseProcessPathsCsv: empty, unreadable or path-less output yields an empty map", () => {
  assert.deepEqual(parseProcessPathsCsv(""), {});
  assert.deepEqual(parseProcessPathsCsv("Get-CimInstance : Access denied"), {});
  // A pid whose path the OS would not give up must not be invented.
  assert.deepEqual(parseProcessPathsCsv('"ProcessId","ExecutablePath"\r\n"1234",""'), {});
});

test("pidsToStop: PIDs we spawned this run are ours by construction", () => {
  assert.deepEqual(pidsToStop({ tracked: [1234, 5678] }), [1234, 5678]);
});

test("pidsToStop: a persisted PID is stopped only when its path still matches", () => {
  const persisted = [
    { pid: 1234, exe: CLOUDFLARED }, // still ours
    { pid: 9012, exe: CLOUDFLARED }, // recycled by explorer.exe
  ];
  const paths = { 1234: CLOUDFLARED, 9012: "C:\\Windows\\explorer.exe" };
  assert.deepEqual(pidsToStop({ persisted, paths }), [1234]);
});

test("pidsToStop: a persisted PID with no observable path is left alone", () => {
  // The probe failed (no PowerShell, access denied, process already gone). An
  // image-name match would have been enough here; a path is not, so we do not act.
  assert.deepEqual(pidsToStop({ persisted: [{ pid: 1234, exe: CLOUDFLARED }], paths: {} }), []);
});

test("pidsToStop: a legacy bare-number entry is unverifiable and skipped", () => {
  // An earlier version wrote [pid, pid]; there is no path to check them against.
  assert.deepEqual(pidsToStop({ persisted: [1234, 5678], paths: { 1234: CLOUDFLARED } }), []);
});

test("pidsToStop: path comparison tolerates case and slash direction", () => {
  const persisted = [{ pid: 1234, exe: "c:/agentdock/CLOUDFLARED.EXE" }];
  assert.deepEqual(pidsToStop({ persisted, paths: { 1234: CLOUDFLARED } }), [1234]);
});

test("pidsToStop: dedupes and drops junk", () => {
  const persisted = [{ pid: 1234, exe: CLOUDFLARED }];
  assert.deepEqual(
    pidsToStop({ tracked: [1234], persisted: [1234, 0, -1, 1.5, "1234", null], paths: { 1234: CLOUDFLARED } }),
    [1234]
  );
});

test("pidsToStop: never returns our own PID", () => {
  const args = {
    tracked: [999],
    persisted: [{ pid: 999, exe: CLOUDFLARED }],
    paths: { 999: CLOUDFLARED },
    selfPid: 999,
  };
  assert.deepEqual(pidsToStop(args), []);
});
