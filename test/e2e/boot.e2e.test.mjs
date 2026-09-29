// Booting the real entry point, because "the key is written owner-only or not at
// all" is a property of the ORDER of the steps in main(): writing the key first
// and tightening the file afterwards passes every secret.mjs test while still
// leaving an unprotected key on disk when the tighten fails.
//
// ARENA_AGENT_CHROME points at a path that does not exist, so boot stops at the
// self-check right after the key step — no browser, no port, no credential
// store, no network. The exit status is 1 in every case here, so what each test
// asserts is where in the boot it got, and what it left behind.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function boot(dataDir, env = {}) {
  const result = spawnSync(process.execPath, [path.join(ROOT, "src", "index.mjs")], {
    cwd: ROOT,
    // stdin must be ignored: with the default (a pipe) spawning a node here
    // fails with EBUSY before it ever starts. Same root cause as the icacls
    // call in secret.mjs, which needs explicit pipes for the same reason.
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      ARENA_AGENT_BRIDGE_KEY: "test-key",
      ARENA_AGENT_CHROME: path.join(dataDir, "no-such-browser"),
      ...env,
    },
  });
  return { ...result, output: `${result.stdout || ""}${result.stderr || ""}` };
}

function tempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "arena-boot-"));
}

// The failing-icacls account below only exists on Windows, and so does the
// property: POSIX has one mechanism (chmod) that does not fail on its own.
const onlyWhereItCanFail = {
  skip: process.platform !== "win32" && "收紧步骤只有 Windows 会失败，POSIX 用 chmod",
};

test("boot: a key whose file cannot be made owner-only is not written at all", onlyWhereItCanFail, () => {
  const dataDir = tempDataDir();
  // An account icacls cannot resolve fails the way a missing icacls does.
  const r = boot(dataDir, { USERDOMAIN: "NOPE", USERNAME: "no-such-user-xyz" });
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /owner-only/);
  assert.deepEqual(fs.readdirSync(dataDir), [], "no .env, and no temporary file either");
});

test("boot: a key whose file can be made owner-only is written, with nothing to complain about", onlyWhereItCanFail, () => {
  const dataDir = tempDataDir();
  const r = boot(dataDir);
  assert.equal(r.status, 1, r.output);
  const text = fs.readFileSync(path.join(dataDir, ".env"), "utf8");
  assert.match(text, /^STORAGE_ENCRYPTION_KEY=[0-9a-f]{64}$/m);
  assert.doesNotMatch(r.output, /owner-only/, "the ACL step must have succeeded silently");
});

test("boot: an existing .env that cannot be tightened still boots on its own key", onlyWhereItCanFail, () => {
  const dataDir = tempDataDir();
  const envPath = path.join(dataDir, ".env");
  fs.writeFileSync(envPath, `STORAGE_ENCRYPTION_KEY=${"a".repeat(64)}\n`);
  const r = boot(dataDir, { USERDOMAIN: "NOPE", USERNAME: "no-such-user-xyz" });
  assert.equal(r.status, 1, r.output);
  // Refusing to start would leave an existing install with no way in, so this
  // one is reported and not fatal — the boot carries on to the browser check.
  assert.match(r.output, /owner-only/);
  assert.doesNotMatch(r.output, /"msg":"fatal"/);
  assert.match(fs.readFileSync(envPath, "utf8"), /STORAGE_ENCRYPTION_KEY=a{64}/, "the file is left as it was");
});
