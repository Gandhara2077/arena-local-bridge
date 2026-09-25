import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CredentialStore } from "../src/credentials.mjs";
import { sessionAccountEmail, sessionIdFromUrl } from "../src/archive.mjs";

// A Session is driven by the Account that created it. The archive is the only
// place that records the link, so these tests cover the whole rule end to end:
// 记录.json -> sessionAccountEmail() -> credentials.forSession().
//
// Regression cover for the defect this replaced: the bridge drove every Session
// with credentials.primary(), so changing the pool's order (or failing over to
// another account) silently re-pointed every existing Session at a new account.

const SID_A = "01a0bd57-e17a-7fd1-a4bf-e9ad5adfd7fd";
const SID_B = "01a0bfb3-49c2-7d01-a99c-1d6682022310";
const OWNER = "owner@example.com";
const OTHER = "other@example.com";

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-account-"));
  const archiveDir = path.join(dir, "archive");
  fs.mkdirSync(archiveDir, { recursive: true });
  return { dir, archiveDir, credentialsFile: path.join(dir, "credentials.json") };
}

function writeArchive(archiveDir, entries) {
  fs.writeFileSync(path.join(archiveDir, "记录.json"), JSON.stringify(entries), "utf8");
}

function entry(sessionId, email) {
  return { Url: `https://arena.ai/agent/${sessionId}`, Model: "gpt-5", Title: "t", Email: email || "" };
}

function store(credentialsFile, accounts) {
  const s = new CredentialStore({ filePath: credentialsFile, secret: "test-secret" });
  for (const a of accounts) s.upsert({ cookieHeader: "SESSION=x", password: "p", ...a });
  return s;
}

test("sessionIdFromUrl reads the uuid, and refuses anything else", () => {
  assert.equal(sessionIdFromUrl(`https://arena.ai/agent/${SID_A}`), SID_A);
  assert.equal(sessionIdFromUrl(`https://arena.ai/agent/${SID_A.toUpperCase()}`), SID_A);
  assert.equal(sessionIdFromUrl("https://arena.ai/agent"), "");
  assert.equal(sessionIdFromUrl(""), "");
  assert.equal(sessionIdFromUrl(undefined), "");
});

test("sessionAccountEmail answers only for sessions the archive knows", () => {
  const { archiveDir } = workspace();
  writeArchive(archiveDir, [entry(SID_A, OWNER), entry(SID_B, "")]);
  assert.equal(sessionAccountEmail(archiveDir, SID_A), OWNER);
  // No Email recorded is no owner to report — not an empty-string owner.
  assert.equal(sessionAccountEmail(archiveDir, SID_B), "");
  assert.equal(sessionAccountEmail(archiveDir, ""), "");
  assert.equal(sessionAccountEmail(path.join(archiveDir, "nope"), SID_A), "");
});

test("the owning Account drives the Session, not the pool's top-ranked one", () => {
  const { archiveDir, credentialsFile } = workspace();
  writeArchive(archiveDir, [entry(SID_A, OWNER)]);
  // OTHER outranks OWNER, so a primary()-based driver would pick the wrong one.
  const credentials = store(credentialsFile, [
    { email: OTHER, priority: 1 },
    { email: OWNER, priority: 5 },
  ]);
  assert.equal(credentials.primary().email, OTHER);

  const chosen = credentials.forSession(sessionAccountEmail(archiveDir, SID_A));
  assert.equal(chosen.email, OWNER);
  assert.equal(chosen.cookieHeader, "SESSION=x");
  // Account lookup is case-insensitive, like every other lookup in the store.
  assert.equal(credentials.forSession(OWNER.toUpperCase()).email, OWNER);
});

test("re-ordering the pool does not move a Session to another Account", () => {
  const { archiveDir, credentialsFile } = workspace();
  writeArchive(archiveDir, [entry(SID_A, OWNER)]);
  const credentials = store(credentialsFile, [
    { email: OWNER, priority: 1 },
    { email: OTHER, priority: 2 },
  ]);
  assert.equal(credentials.forSession(sessionAccountEmail(archiveDir, SID_A)).email, OWNER);

  // Whoever now ranks first, the Session still belongs to its owner.
  credentials.setPriority(OWNER, 9);
  assert.equal(credentials.primary().email, OTHER);
  assert.equal(credentials.forSession(sessionAccountEmail(archiveDir, SID_A)).email, OWNER);
});

test("a disabled owner is a hard 409, never a silent substitution", () => {
  const { archiveDir, credentialsFile } = workspace();
  writeArchive(archiveDir, [entry(SID_A, OWNER)]);
  const credentials = store(credentialsFile, [
    { email: OTHER, priority: 1 },
    { email: OWNER, priority: 2 },
  ]);
  credentials.disable(OWNER, "restricted");

  assert.throws(
    () => credentials.forSession(sessionAccountEmail(archiveDir, SID_A)),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.code, "session_account_unavailable");
      assert.match(error.message, /disabled/);
      return true;
    }
  );
});

test("an owner missing from the pool is a hard 409 too", () => {
  const { archiveDir, credentialsFile } = workspace();
  writeArchive(archiveDir, [entry(SID_A, "ghost@example.com")]);
  const credentials = store(credentialsFile, [{ email: OTHER, priority: 1 }]);

  assert.throws(
    () => credentials.forSession(sessionAccountEmail(archiveDir, SID_A)),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.code, "session_account_unavailable");
      assert.match(error.message, /no such account/);
      return true;
    }
  );
});

test("a Session the archive does not know falls back to the pool default", () => {
  const { archiveDir, credentialsFile } = workspace();
  writeArchive(archiveDir, [entry(SID_A, OWNER)]);
  const credentials = store(credentialsFile, [
    { email: OTHER, priority: 1 },
    { email: OWNER, priority: 2 },
  ]);

  // SID_B was never archived: there is no owner to honour, so today's
  // behaviour applies — a wrong guess still fails loudly on the Arena side.
  assert.equal(credentials.forSession(sessionAccountEmail(archiveDir, SID_B)).email, OTHER);
  assert.equal(credentials.forSession("").email, OTHER);
});
