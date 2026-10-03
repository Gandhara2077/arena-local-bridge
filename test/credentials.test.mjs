import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CredentialStore } from "../src/credentials.mjs";

// The account pool: which account gets used, and what happens when one is
// rejected. Regression cover for `priority: Number(priority) || 1`, which made
// priority 0 unusable, so no account could ever outrank the first one.
function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arena-creds-"));
  return new CredentialStore({ filePath: path.join(dir, "credentials.json"), secret: "test-secret" });
}

// forSession is what decides which Account drives a Session, and its policy is
// the whole point of it. Not previously covered anywhere — which is how a
// wrapper around it came to restate the policy wrongly.
test("forSession: a Session's owner wins over the primary", () => {
  const s = store();
  s.upsert({ email: "primary@example.com", cookieHeader: "a=1", password: "p", priority: 1 });
  s.upsert({ email: "owner@example.com", cookieHeader: "b=2", password: "p", priority: 9 });
  assert.equal(s.primary().email, "primary@example.com");
  assert.equal(s.forSession("owner@example.com").email, "owner@example.com");
});

test("forSession: a Session with no owner falls back to the primary", () => {
  const s = store();
  s.upsert({ email: "primary@example.com", cookieHeader: "a=1", password: "p", priority: 1 });
  // Records archived before the Email column existed have no owner at all, so
  // "" has to keep meaning "use whatever the pool considers primary".
  assert.equal(s.forSession("").email, "primary@example.com");
  assert.equal(s.forSession("   ").email, "primary@example.com");
  assert.equal(s.forSession(undefined).email, "primary@example.com");
});

test("forSession: an owner that cannot be used is a 409, never a substitution", () => {
  const s = store();
  s.upsert({ email: "primary@example.com", cookieHeader: "a=1", password: "p", priority: 1 });
  s.upsert({ email: "gone@example.com", cookieHeader: "b=2", password: "p", priority: 2 });
  s.disable("gone@example.com", "restricted");

  // Handing back the primary here would turn "this Session has no usable
  // Account" into "attribute some other Account's Model to it".
  assert.throws(
    () => s.forSession("nobody@example.com"),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.code, "session_account_unavailable");
      return true;
    }
  );
  assert.throws(() => s.forSession("gone@example.com"), (error) => error.status === 409);
});

test("upsert accepts priority 0 so a new account can outrank the first", () => {
  const s = store();
  s.upsert({ email: "old@example.com", cookieHeader: "a=1", password: "p", priority: 1 });
  s.upsert({ email: "new@example.com", cookieHeader: "b=2", password: "p", priority: 0 });
  assert.equal(s.primary().email, "new@example.com");
});

test("primary skips a disabled account and falls through to the next", () => {
  const s = store();
  s.upsert({ email: "first@example.com", cookieHeader: "a=1", password: "p", priority: 1 });
  s.upsert({ email: "second@example.com", cookieHeader: "b=2", password: "p", priority: 2 });
  assert.equal(s.primary().email, "first@example.com");

  s.disable("first@example.com", "session not usable");
  assert.equal(s.primary().email, "second@example.com");
});

test("primary returns null when every account has been rejected", () => {
  const s = store();
  s.upsert({ email: "only@example.com", cookieHeader: "a=1", password: "p", priority: 1 });
  s.disable("only@example.com", "restricted");
  assert.equal(s.primary(), null);
});

test("ensure explains that accounts exist but are unusable", () => {
  const s = store();
  s.upsert({ email: "only@example.com", cookieHeader: "a=1", password: "p", priority: 1 });
  s.disable("only@example.com", "restricted");
  assert.throws(() => s.ensure(), /All 1 Arena account\(s\) are unusable: only@example\.com \(restricted\)/);
});

test("selectNext skips already-tried accounts without disabling them", () => {
  const s = store();
  s.upsert({ email: "a@example.com", cookieHeader: "a=1", password: "p", priority: 1 });
  s.upsert({ email: "b@example.com", cookieHeader: "b=2", password: "p", priority: 2 });
  assert.equal(s.selectNext([]).email, "a@example.com");
  assert.equal(s.selectNext(["a@example.com"]).email, "b@example.com");
  assert.equal(s.selectNext(["a@example.com", "b@example.com"]), null);
});

test("replaceCookie re-enables an account that had been disabled", () => {
  const s = store();
  s.upsert({ email: "a@example.com", cookieHeader: "a=1", password: "p", priority: 1 });
  s.disable("a@example.com", "restricted");
  assert.equal(s.primary(), null);

  s.replaceCookie("a@example.com", "a=refreshed");
  const primary = s.primary();
  assert.equal(primary.email, "a@example.com");
  assert.equal(primary.cookieHeader, "a=refreshed");
});

test("disable records why, and list never exposes cookie values", () => {
  const s = store();
  s.upsert({ email: "a@example.com", cookieHeader: "SESSION=super-secret", password: "p", priority: 1 });
  s.disable("a@example.com", "session not usable");

  const [row] = s.list();
  assert.deepEqual(Object.keys(row).sort(), [
    "cookieExpirySeconds",
    "disabled",
    "email",
    "hasPassword",
    "lastError",
    "priority",
    "updatedAt",
  ]);
  assert.equal(row.disabled, true);
  assert.equal(row.lastError, "session not usable");
  assert.ok(!JSON.stringify(row).includes("super-secret"));
});

test("the pool survives a reload, including disabled state", () => {
  const s = store();
  s.upsert({ email: "a@example.com", cookieHeader: "a=1", password: "p", priority: 1 });
  s.upsert({ email: "b@example.com", cookieHeader: "b=2", password: "p", priority: 2 });
  s.disable("a@example.com", "restricted");

  const reopened = new CredentialStore({ filePath: s.filePath, secret: "test-secret" }).load();
  assert.equal(reopened.primary().email, "b@example.com");
  assert.equal(reopened.list().find((r) => r.email === "a@example.com").disabled, true);
});

test("a corrupt credential file cannot be replaced by upsert or save", (t) => {
  for (const original of ["{broken", "[]", '{"version":1,"accounts":{}}']) {
    const s = store();
    t.after(() => fs.rmSync(path.dirname(s.filePath), { recursive: true, force: true }));
    fs.writeFileSync(s.filePath, original);
    s.load();
    assert.throws(() => s.upsert({ email: "synthetic@test.local", cookieHeader: "a=1", password: "p" }), /credential.*read/i);
    assert.throws(() => s.save(), /credential.*read/i);
    assert.equal(s.primary(), null, "a refused update must not change the in-memory account pool");
    assert.equal(fs.readFileSync(s.filePath, "utf8"), original);
  }
});

test("an unreadable credential path cannot be replaced by a new store", (t) => {
  const s = store();
  t.after(() => fs.rmSync(path.dirname(s.filePath), { recursive: true, force: true }));
  fs.mkdirSync(s.filePath);
  fs.writeFileSync(path.join(s.filePath, "keep.txt"), "original bytes");
  s.load();
  assert.throws(() => s.upsert({ email: "synthetic@test.local", cookieHeader: "a=1", password: "p" }), /credential.*read/i);
  assert.equal(s.primary(), null);
  assert.equal(fs.readFileSync(path.join(s.filePath, "keep.txt"), "utf8"), "original bytes");
});
