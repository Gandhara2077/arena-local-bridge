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
