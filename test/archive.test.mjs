import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readEntries, appendEntry, removeEntries, updateModel } from "../src/archive.mjs";

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

// 删除 is the one irreversible archive operation — 记录.json is the only record
// these Sessions have, so what it leaves behind matters as much as what it takes.
const OTHER = "55555555-5555-4555-8555-555555555555";

function seed(dir, sessionId, model = "kimi-k3") {
  appendEntry(dir, {
    sessionId,
    model,
    url: `https://arena.ai/agent/${sessionId}`,
    email: "a@example.com",
    prompt: "hi",
  });
}

test("删除 removes the named session and leaves the others alone", () => {
  const dir = tmpArchive();
  seed(dir, SID);
  seed(dir, OTHER, "gpt-5");

  const removed = removeEntries(dir, [SID]);
  assert.equal(removed.length, 1);

  const left = readEntries(dir);
  assert.equal(left.length, 1);
  assert.ok(String(left[0].Url).includes(OTHER));
});

test("删除 refreshes the emptied model's 清单.md and the root 汇总.md", () => {
  const dir = tmpArchive();
  seed(dir, SID);
  const folder = readEntries(dir)[0].ModelFolder;

  removeEntries(dir, [SID]);

  assert.match(fs.readFileSync(path.join(dir, folder, "清单.md"), "utf8"), /共 0 条会话/);
  assert.match(fs.readFileSync(path.join(dir, "汇总.md"), "utf8"), /共 0 条会话/);
});

test("删除 accepts several sessions in one call", () => {
  const dir = tmpArchive();
  seed(dir, SID);
  seed(dir, OTHER);
  seed(dir, "66666666-6666-4666-8666-666666666666");

  const removed = removeEntries(dir, [SID, OTHER]);
  assert.equal(removed.length, 2);
  assert.equal(readEntries(dir).length, 1);
});

test("删除 of an unknown session changes nothing", () => {
  const dir = tmpArchive();
  seed(dir, SID);
  const before = JSON.stringify(readEntries(dir));

  const removed = removeEntries(dir, ["99999999-9999-4999-8999-999999999999"]);
  assert.equal(removed.length, 0);
  assert.equal(JSON.stringify(readEntries(dir)), before);
});

test("删除 matches the session id regardless of case", () => {
  const dir = tmpArchive();
  seed(dir, SID);
  const removed = removeEntries(dir, [SID.toUpperCase()]);
  assert.equal(removed.length, 1);
  assert.equal(readEntries(dir).length, 0);
});
