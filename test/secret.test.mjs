// The tunnel's bearer token, its public endpoint and the Arena credential store
// all land on disk, and the endpoint file is what the bridge reads to decide
// whether to tell a Session about local tools. Nobody else on this machine needs
// to read them.
//
// "Nobody else" is a POSIX mode bit here and an ACL on Windows — Windows does
// not implement the former, so each platform gets its own observable assertion
// rather than one test that quietly passes everywhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { writeSecretFile, icaclsRestrictArgs, currentAccount } from "../src/secret.mjs";

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

test("writeSecretFile: leaves no temporary file, and never adopts the old fixed name", () => {
  const dir = tempDir("arena-secret-");
  const file = path.join(dir, "mcp-endpoint.json");
  writeSecretFile(file, "first");
  assert.deepEqual(fs.readdirSync(dir), ["mcp-endpoint.json"]);

  // A leftover from the implementation that used `${file}.tmp`: it must not be
  // clobbered, and it must not be the file that ends up holding the secret.
  const legacy = `${file}.tmp`;
  fs.writeFileSync(legacy, "keep me");
  writeSecretFile(file, "second");
  assert.equal(fs.readFileSync(legacy, "utf8"), "keep me");
  assert.equal(fs.readFileSync(file, "utf8"), "second");
  assert.equal(fs.readdirSync(dir).length, 2);
});

// ── POSIX ───────────────────────────────────────────────────────────────────

test("writeSecretFile: 收紧到 0600 —— 仅 POSIX 验证，Windows 上不验证", {
  skip: process.platform === "win32" && "Windows 不实现 POSIX 权限位，本平台无法验证这一条",
}, () => {
  const file = path.join(tempDir("arena-secret-"), "auth-token.txt");
  writeSecretFile(file, "0123456789abcdef");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

// ── Windows ─────────────────────────────────────────────────────────────────

// `icacls` prints `<path> <identity>:(rights)` for the first entry and indented
// `<identity>:(rights)` for the rest, then a success footer whose wording is
// localized (「已成功处理 1 个文件」). Only the entry lines carry `:(...)`.
export function parseIcalsAces(stdout, file) {
  const aces = [];
  for (const raw of String(stdout || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const body = line.startsWith(file) ? line.slice(file.length).trim() : line;
    const m = body.match(/^(.+?):(\(.*\))$/);
    if (m) aces.push({ identity: m[1], rights: m[2] });
  }
  return aces;
}

test("parseIcalsAces: reads the entries and ignores the localized footer", () => {
  const file = "D:/data/.arena-gui/auth-token.txt";
  const stdout = [`${file} PC-HOST\\me:(F)`, "", "已成功处理 1 个文件; 处理 0 个文件时失败", ""].join("\r\n");
  assert.deepEqual(parseIcalsAces(stdout, file), [{ identity: "PC-HOST\\me", rights: "(F)" }]);
});

test("parseIcalsAces: an inherited ACL shows up as other people having access", () => {
  // Measured on this project's own DATA_DIR: a file that only inherits is
  // readable by every authenticated user, which is what the ACL step denies.
  const stdout = [
    "D:/repo/.arena-gui NT AUTHORITY\\SYSTEM:(I)(F)",
    "                  BUILTIN\\Administrators:(I)(F)",
    "                  NT AUTHORITY\\Authenticated Users:(I)(M)",
    "                  BUILTIN\\Users:(I)(RX)",
  ].join("\r\n");
  const aces = parseIcalsAces(stdout, "D:/repo/.arena-gui");
  assert.equal(aces.length, 4);
  assert.ok(aces.some((a) => a.identity === "NT AUTHORITY\\Authenticated Users"));
});

test("icaclsRestrictArgs: drops inheritance and grants only the given account", () => {
  assert.deepEqual(icaclsRestrictArgs("D:/data/auth-token.txt", "PC-HOST\\me"), [
    "D:/data/auth-token.txt",
    "/inheritance:r",
    "/grant:r",
    "PC-HOST\\me:(F)",
  ]);
});

test("currentAccount: names one account, qualified when a domain is known", () => {
  assert.ok(currentAccount().length > 0);
  assert.equal((currentAccount().match(/\\/g) || []).length <= 1, true);
});

// Windows: `mode: 0o600` and chmod are no-ops there, so what has to hold is the
// ACL — one entry, ours, full control. Anything else still on the file (SYSTEM,
// Administrators, Authenticated Users…) came from the directory and means the
// secret is not owner-only.
// The secret is either owner-only or absent. A file that the documentation calls
// private and the filesystem does not is worse than a failed write, so the
// failure has to reach the caller — and it must leave nothing behind.
test("writeSecretFile: a secret that could not be made owner-only is not written at all", {
  skip: process.platform !== "win32" && "Windows 之外的平台只有 chmod，没有会失败的独立收紧步骤",
}, () => {
  const dir = tempDir("arena-secret-");
  const file = path.join(dir, "auth-token.txt");
  const before = { USERDOMAIN: process.env.USERDOMAIN, USERNAME: process.env.USERNAME };
  try {
    // An account icacls cannot resolve fails the same way a missing icacls does
    // (measured: exit 1332), without having to break PATH for the whole process.
    process.env.USERDOMAIN = "NOPE";
    process.env.USERNAME = "no-such-user-xyz";
    assert.throws(() => writeSecretFile(file, "0123456789abcdef"), /owner-only/);
  } finally {
    process.env.USERDOMAIN = before.USERDOMAIN;
    process.env.USERNAME = before.USERNAME;
  }
  assert.equal(fs.existsSync(file), false, "nothing may be left at the target");
  assert.deepEqual(fs.readdirSync(dir), [], "and no temporary file either");
});

test("writeSecretFile: on Windows the ACL really is owner-only", {
  skip: process.platform !== "win32" && "Windows 之外的平台走 POSIX 权限位，见上面那条",
}, () => {
  const file = path.join(tempDir("arena-secret-"), "auth-token.txt");
  writeSecretFile(file, "0123456789abcdef");
  const stdout = execFileSync("icacls", [file], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    windowsHide: true,
  });
  const aces = parseIcalsAces(stdout, file);
  assert.equal(aces.length, 1, `expected one entry, got ${JSON.stringify(aces)}`);
  assert.match(aces[0].identity, new RegExp(`(^|\\\\)${os.userInfo().username}$`, "i"));
  assert.equal(aces[0].rights, "(F)");
});
