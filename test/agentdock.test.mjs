// The tunnel's bearer token and its public endpoint are written to disk in
// cleartext, and the endpoint file is what the bridge reads to decide whether
// to tell a Session about local tools. Nothing else on this machine needs to
// read them.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeSecretFile } from "../src/agentdock.mjs";

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("writeSecretFile: writes the content", () => {
  const file = path.join(tempDir("arena-secret-"), "auth-token.txt");
  writeSecretFile(file, "0123456789abcdef");
  assert.equal(fs.readFileSync(file, "utf8"), "0123456789abcdef");
});

test("writeSecretFile: overwrites an existing file rather than appending", () => {
  const file = path.join(tempDir("arena-secret-"), "mcp-endpoint.json");
  writeSecretFile(file, "first");
  writeSecretFile(file, "second");
  assert.equal(fs.readFileSync(file, "utf8"), "second");
});

// Deliberately visible as a skip: Windows does not implement POSIX mode bits,
// so `mode: 0o600` there is a no-op and stat reports 0666. The real protection
// on Windows is that these files move into the bridge's own DATA_DIR (W2); an
// ACL step would be its own ticket. Same level as credentials.json has today.
test("writeSecretFile: 收紧到 0600 —— 仅 POSIX 验证，Windows 上不验证", {
  skip: process.platform === "win32" && "Windows 不实现 POSIX 权限位，本平台无法验证这一条",
}, () => {
  const file = path.join(tempDir("arena-secret-"), "auth-token.txt");
  writeSecretFile(file, "0123456789abcdef");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
