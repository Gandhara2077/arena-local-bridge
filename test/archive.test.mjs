import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readEntries, appendEntry, updateModel } from "../src/archive.mjs";

// 补标 rewrites 记录.json — the source of truth. CONTRIBUTING asks for
// regression tests on session-handling changes, so it gets its own file even
// though it needs a real temp dir (unlike the pure pool functions).
function tmpArchive() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "arena-archive-"));
}

const SID = "44444444-4444-4444-8444-444444444444";

test("补标 fills in the Model of a session that was archived as 未识别", () => {
  const dir = tmpArchive();
  appendEntry(dir, { sessionId: SID, model: "", url: `https://arena.ai/agent/${SID}`, email: "a@example.com", prompt: "hi" });
  const before = readEntries(dir).find((e) => String(e.Url).includes(SID));
  assert.equal(before.Model, "未识别");

  const updated = updateModel(dir, SID, "kimi-k3");
  assert.equal(updated.Model, "kimi-k3");

  const stored = readEntries(dir).find((e) => String(e.Url).includes(SID));
  assert.equal(stored.Model, "kimi-k3");
  assert.equal(stored.ModelFolder, "kimi-k3");
});

test("补标 keeps the original collection time in the title", () => {
  const dir = tmpArchive();
  appendEntry(dir, { sessionId: SID, model: "", url: `https://arena.ai/agent/${SID}`, email: "a@example.com", prompt: "hi" });
  const before = readEntries(dir).find((e) => String(e.Url).includes(SID));
  const tail = String(before.Title).split(" · ").slice(1).join(" · ");
  const updated = updateModel(dir, SID, "kimi-k3");
  assert.equal(updated.Title, `kimi-k3 · ${tail}`);
});

test("补标 returns null when no archived entry carries that session", () => {
  const dir = tmpArchive();
  assert.equal(updateModel(dir, "99999999-9999-4999-8999-999999999999", "kimi-k3"), null);
});
