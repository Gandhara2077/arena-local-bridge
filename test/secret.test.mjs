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
import { writeSecretFile, icaclsFreshFileCommands, restrictSecretFile, currentAccount } from "../src/secret.mjs";

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

// The ACL as icacls reports it: raw text for parseIcalsAces. `stdio: ignore` for
// stdin only — a child spawned with a piped stdin hangs on this machine (EBUSY).
function readAcl(file) {
  return execFileSync("icacls", [file], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    windowsHide: true,
  });
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

// Nothing here enumerates a principal, which is the whole design: what a new
// file carries is whatever Windows decided to give it, and this module is not in
// a position to name that — so it clears it instead.
test("icaclsFreshFileCommands: reset what Windows put there, cut inheritance, leave only the given account", () => {
  assert.deepEqual(icaclsFreshFileCommands("D:/data/auth-token.txt", "PC-HOST\\me"), [
    // First, and non-destructively: the only step that can fail on a name it
    // cannot resolve, so a bad account costs the file nothing.
    ["D:/data/auth-token.txt", "/grant:r", "PC-HOST\\me:(F)"],
    // Then drop every explicit entry — the one added above included, and every
    // one this module never saw. No `/remove:g` list can stand in for this.
    ["D:/data/auth-token.txt", "/reset"],
    // And finally cut inheritance, leaving full control with this account alone.
    ["D:/data/auth-token.txt", "/inheritance:r", "/grant:r", "PC-HOST\\me:(F)"],
  ]);
});

// The case the sequence exists for, and the one a single command built on
// `/remove:g` cannot pass: a NEW file whose explicit entries are not the two OS
// principals. That is not exotic — a new file's explicit ACL is whatever Windows
// gave it, and when the parent directory hands nothing down that is the process
// token's DEFAULT DACL, whose algorithm is implementation-defined. A third
// account is one of the things it may contain, so assuming it does not is an
// assumption this module cannot afford. Planted below the way a hand-run
// `icacls /grant` would leave one.
test("icaclsFreshFileCommands: a file that already carries a third account ends up with only this one", {
  skip: process.platform !== "win32" && "Windows 之外的平台没有 ACL 这一层，见上面那条",
}, () => {
  const file = path.join(tempDir("arena-secret-"), "fresh.txt");
  fs.writeFileSync(file, "");
  execFileSync("icacls", [file, "/grant", "*S-1-5-11:(R)"], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  assert.equal(
    parseIcalsAces(readAcl(file), file).length > 1,
    true,
    "the sample must start out carrying more than owner-only"
  );

  for (const args of icaclsFreshFileCommands(file, currentAccount())) {
    execFileSync("icacls", args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  }

  const aces = parseIcalsAces(readAcl(file), file);
  assert.equal(aces.length, 1, `expected one entry, got ${JSON.stringify(aces)}`);
  assert.match(aces[0].identity, new RegExp(`(^|\\\\)${os.userInfo().username}$`, "i"));
  assert.equal(aces[0].rights, "(F)");
});

// The case three accounts try to hide behind: an entry this module never wrote
// and cannot enumerate. `Authenticated Users` (SID S-1-5-11) stands in for any
// of them, and it is planted the way a bygone install or a hand-run
// `icacls /grant` would leave one.
test("restrictSecretFile: an explicit grant to a third account does not survive", {
  skip: process.platform !== "win32" && "Windows 之外的平台只有 chmod，见上面那条",
}, () => {
  const file = path.join(tempDir("arena-secret-"), "auth-token.txt");
  fs.writeFileSync(file, "0123456789abcdef");
  execFileSync("icacls", [file, "/grant", "*S-1-5-11:(R)"], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const planted = parseIcalsAces(readAcl(file), file);
  assert.equal(planted.length > 1, true, "the sample must really carry a third-party entry");

  restrictSecretFile(file);

  const aces = parseIcalsAces(readAcl(file), file);
  assert.equal(aces.length, 1, `expected one entry, got ${JSON.stringify(aces)}`);
  assert.match(aces[0].identity, new RegExp(`(^|\\\\)${os.userInfo().username}$`, "i"));
  assert.equal(aces[0].rights, "(F)");
  assert.equal(fs.readFileSync(file, "utf8"), "0123456789abcdef", "tightening must not lose the secret");
});

// Why the Windows path REPLACES the file instead of tightening the ACL where it
// stands, in one observation: a read-only target fails the rename (measured:
// EPERM), and that failure has to be the whole story. An icacls sequence cannot
// promise as much — clearing an explicit third-party entry takes `/reset`, which
// re-applies the directory's inheritance and cannot share a command line with
// the grant that follows it, so a failure between the two leaves the file wider
// than it was found.
test("restrictSecretFile: a file it cannot replace keeps the ACL — and the secret — it came with", {
  skip: process.platform !== "win32" && "Windows 之外的平台走 chmod，原地且原子，见上面那条",
}, () => {
  const dir = tempDir("arena-secret-");
  const file = path.join(dir, "auth-token.txt");
  fs.writeFileSync(file, "0123456789abcdef");
  execFileSync("icacls", [file, "/grant", "*S-1-5-11:(R)"], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const before = parseIcalsAces(readAcl(file), file);
  assert.equal(before.length > 1, true, "the sample must start out wider than owner-only");

  // Nothing in an ACL-only path would notice a read-only file; icacls changes
  // its ACL happily. The rename does notice, which is the difference held here.
  fs.chmodSync(file, 0o444);
  try {
    assert.throws(() => restrictSecretFile(file), "a replacement that did not happen must not read as success");
  } finally {
    fs.chmodSync(file, 0o666); // so the temporary directory can be cleaned up
  }

  assert.deepEqual(
    parseIcalsAces(readAcl(file), file),
    before,
    "no half-applied ACL: the entries are exactly the ones the file came with"
  );
  assert.equal(fs.readFileSync(file, "utf8"), "0123456789abcdef", "and the secret is still there");
  assert.deepEqual(fs.readdirSync(dir), ["auth-token.txt"], "and no temporary file was left behind");
});

test("restrictSecretFile: refuses a file far larger than a secret", {
  skip: process.platform !== "win32" && "只有 Windows 的替换路径把内容读进内存",
}, () => {
  const dir = tempDir("arena-secret-");
  const file = path.join(dir, "auth-token.txt");
  // Sparse: the size is what the guard reads, not the bytes.
  const big = fs.openSync(file, "w");
  fs.ftruncateSync(big, 128 * 1024);
  fs.closeSync(big);

  assert.throws(() => restrictSecretFile(file), (error) => error.code === "secret_too_large");
  assert.deepEqual(fs.readdirSync(dir), ["auth-token.txt"], "and nothing was staged next to it");
});

test("currentAccount: names one account, qualified when a domain is known", () => {
  assert.ok(currentAccount().length > 0);
  assert.equal((currentAccount().match(/\\/g) || []).length <= 1, true);
});

// Windows: `mode: 0o600` and chmod are no-ops there, so what has to hold is the
// ACL — one entry, ours, full control. Anything else still on the file (SYSTEM,
// Administrators, Authenticated Users…) came from the directory and means the
// secret is not owner-only. That holds for every file this module tightens, not
// only the ones it creates: see the third-account case above.
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
