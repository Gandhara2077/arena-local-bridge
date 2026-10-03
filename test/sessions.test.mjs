import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../src/sessions.mjs";

function temporaryStore(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "arena-session-store-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "sessions.json");
  return { filePath, store: new SessionStore({ filePath, ttlMs: 60_000 }) };
}

test("SessionStore persists, reloads, and deletes a session", (t) => {
  const { filePath, store } = temporaryStore(t);
  const state = { token: "run-1", updatedAt: Date.now() };
  store.set("session-1", state);

  const reloaded = new SessionStore({ filePath, ttlMs: 60_000 });
  assert.deepEqual(reloaded.get("session-1"), state);
  reloaded.delete("session-1");
  assert.equal(new SessionStore({ filePath, ttlMs: 60_000 }).get("session-1"), undefined);
});

test("SessionStore expires stale sessions on read and persistence", (t) => {
  const { filePath } = temporaryStore(t);
  const fresh = { token: "run-2", updatedAt: Date.now() };
  fs.writeFileSync(filePath, JSON.stringify({
    expired: { token: "stale", updatedAt: Date.now() - 120_000 },
    neverReadExpired: { token: "also-stale", updatedAt: Date.now() - 120_000 },
    fresh,
  }));

  const store = new SessionStore({ filePath, ttlMs: 60_000 });
  assert.equal(store.get("expired"), undefined);
  assert.deepEqual(store.get("fresh"), fresh);
  store.set("next", { token: "run-3", updatedAt: Date.now() });
  // `expired` was pruned by get(); this entry proves persist prunes stale values itself.
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf8")), {
    fresh,
    next: store.get("next"),
  });
});

test("SessionStore treats missing or malformed snapshots as an empty map", (t) => {
  const { filePath, store } = temporaryStore(t);
  assert.equal(store.size, 0);
  for (const contents of ["broken JSON", "null"]) {
    fs.writeFileSync(filePath, contents);
    assert.equal(new SessionStore({ filePath, ttlMs: 60_000 }).size, 0);
  }
});

test("SessionStore preserves TTL boundary, lazy deletion and snapshot framing", (t) => {
  const { filePath } = temporaryStore(t);
  t.mock.method(Date, "now", () => 100_000);
  const boundary = { updatedAt: 40_000, token: "synthetic" };
  fs.writeFileSync(filePath, JSON.stringify({ boundary, expired: { updatedAt: 39_999 }, empty: null }));
  const store = new SessionStore({ filePath, ttlMs: 60_000 });
  assert.equal(store.size, 3);
  assert.deepEqual(store.get("boundary"), boundary);
  assert.equal(store.get("expired"), undefined);
  assert.equal(store.size, 2);
  assert.ok(Object.hasOwn(JSON.parse(fs.readFileSync(filePath, "utf8")), "expired"));
  store.persist();
  assert.equal(store.size, 1);
  assert.equal(fs.readFileSync(filePath, "utf8"), JSON.stringify({ boundary }, null, 2));
  assert.equal(fs.existsSync(`${filePath}.tmp`), false);
  if (process.platform !== "win32") assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
});
