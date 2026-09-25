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

test("byEmail returns one named account, cookie decrypted", () => {
  const s = store();
  s.upsert({ email: "a@example.com", cookieHeader: "SESSION=aaa", password: "p", priority: 1 });
  s.upsert({ email: "b@example.com", cookieHeader: "SESSION=bbb", password: "p", priority: 2 });

  // Lookup is case-insensitive, like every other account lookup here.
  assert.equal(s.byEmail("b@EXAMPLE.com").email, "b@example.com");
  assert.equal(s.byEmail("b@example.com").cookieHeader, "SESSION=bbb");
});

test("byEmail answers null for an unknown or disabled account", () => {
  const s = store();
  s.upsert({ email: "a@example.com", cookieHeader: "a=1", password: "p", priority: 1 });

  assert.equal(s.byEmail("nobody@example.com"), null);
  assert.equal(s.byEmail(""), null);

  s.disable("a@example.com", "restricted");
  assert.equal(s.byEmail("a@example.com"), null);
});
