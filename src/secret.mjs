// secret.mjs - fail-closed credential key resolution, and the one way this
// project puts a secret on disk.
//
// Added during local security review. The original code fell back to a
// hardcoded, publicly known key ("arena-bridge-local-key") whenever
// STORAGE_ENCRYPTION_KEY was absent. Because the KDF salt in crypto.mjs is
// also a fixed constant and this source is public, anyone could derive the
// key offline and decrypt credentials.json. A missing key is now a hard error.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";

export function requireSecret(dotEnv) {
  const secret = dotEnv && dotEnv.STORAGE_ENCRYPTION_KEY;
  if (!secret || secret === "arena-bridge-local-key") {
    throw new Error(
      "STORAGE_ENCRYPTION_KEY is missing or is the known insecure fallback. " +
      "Refusing to start with a publicly derivable key. " +
      "Set STORAGE_ENCRYPTION_KEY to 64 random hex chars in DATA_DIR/.env " +
      "(install.sh generates one via `openssl rand -hex 32`)."
    );
  }
  return secret;
}

// ── putting a secret on disk ────────────────────────────────────────────────

// A secret is written owner-only or not written at all. Anything else would be
// a file that the documentation calls private and the filesystem does not, and
// the failure has to reach the caller, which is the only one that knows what
// "this secret could not be protected" means for its own operation.
//
// The order is the point:
//
//   1. a UNIQUE, exclusively-created .tmp — a fixed `${file}.tmp` is a collision
//      between two writers and a name an older run may have left behind;
//   2. restrict it BEFORE the secret is in it, so there is no window in which
//      the secret sits in the directory under the directory's own ACL;
//   3. write, close, and rename over the target — same directory, so the
//      protected file simply becomes the target, and nobody ever reads a
//      half-written secret.
//
// A failure at any step removes the temporary file and rethrows: the previous
// contents (or the absence of a file) are left exactly as they were.
export function writeSecretFile(file, data) {
  const tmp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  let handle = null;
  try {
    handle = fs.openSync(tmp, "wx", 0o600);
    protectFreshFile(tmp);
    fs.writeSync(handle, data);
    fs.closeSync(handle);
    handle = null;
    fs.renameSync(tmp, file);
  } catch (error) {
    if (handle !== null) {
      try {
        fs.closeSync(handle);
      } catch {
        /* already gone */
      }
    }
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

// Windows has no POSIX mode bits: measured there, a file written with
// `mode: 0o600` and then chmod'ed still reports 0666, so a secret keeps
// whatever ACL its directory hands down — and a DATA_DIR placed under a shared
// tree hands it to every authenticated user (this project's own .arena-gui
// inherits `Authenticated Users:(M)`). icacls is the platform's mechanism, and
// the one a Windows administrator would look for anyway.
//
// Pure, so the rule is assertable without a disk: drop the inherited entries,
// drop the OS's own full-control principals, then grant full control to this
// account and nobody else.
//
// The middle step is not redundant. `/inheritance:r` only removes entries the
// file INHERITED — and Windows does not always give a new file any: when the
// parent directory holds no inheritable ACE, CreateFile falls back to the
// process token's default DACL, which is owner + Administrators + SYSTEM as
// three EXPLICIT entries that `/inheritance:r` cannot touch. That is not a
// hypothetical: the GitHub runner's temp directory is such a parent, so the
// previous arguments produced a three-entry ACL in exactly the environment this
// project's CI runs in, while a developer machine (whose temp directory does
// hand ACEs down) came out at one. Naming the two by SID rather than by name
// keeps it working on a localized Windows, where the display names are
// translated.
export function icaclsRestrictArgs(file, account) {
  return [
    file,
    "/inheritance:r",
    "/remove:g",
    "*S-1-5-18", // NT AUTHORITY\SYSTEM
    "*S-1-5-32-544", // BUILTIN\Administrators
    "/grant:r",
    `${account}:(F)`,
  ];
}

// Fully qualified, so icacls picks the right account on a domain-joined
// machine — USERDOMAIN is the computer name for a local account.
export function currentAccount() {
  const name = String(process.env.USERNAME || "").trim() || os.userInfo().username;
  const domain = String(process.env.USERDOMAIN || "").trim();
  return domain && !name.includes("\\") ? `${domain}\\${name}` : name;
}

// Owner-only for a file this module has just created, in ONE icacls call.
// writeSecretFile is the only caller, and that is the point: a file we made
// ourselves carries nothing but what Windows itself put there, which is exactly
// what icaclsRestrictArgs takes away (the two OS principals, and whatever the
// directory inherits). A file that arrived from somewhere else can carry
// entries none of that covers, so it does not come through here — see
// restrictSecretFile below, which cannot make that call with this one.
function protectFreshFile(file) {
  if (process.platform !== "win32") {
    fs.chmodSync(file, 0o600);
    return;
  }
  const account = currentAccount();
  try {
    execFileSync("icacls", icaclsRestrictArgs(file, account), { windowsHide: true, stdio: "ignore" });
  } catch (error) {
    throw Object.assign(
      new Error(`could not make ${file} owner-only (${account}): ${String(error?.message || error)}`),
      { code: "secret_not_restricted" }
    );
  }
}

// The largest file that may be tightened by the replace path below: these hold
// a token, a key or a small JSON blob, and a path that has become something else
// is worth reporting rather than reading into memory.
const MAX_SECRET_BYTES = 64 * 1024;

// Make one file owner-only, or say that you could not.
//
// On Windows this REPLACES the file — a fresh, already-protected copy is renamed
// over it — instead of tightening the ACL where it stands. Two reasons:
//
//   - icacls cannot clear an ACL it did not write in one call. An explicit grant
//     to some third account survives both `/inheritance:r` (which only touches
//     what the file inherited) and `/grant:r` (which only replaces our own
//     entry), so removing it takes `/reset` — and `/reset` cannot share a
//     command line with `/inheritance` or `/grant` (measured: exit 87, the whole
//     command line is validated before anything runs). So the tightening is
//     three separate calls, and three calls are not a transaction: one failing
//     halfway leaves whatever the calls before it produced. After `/reset` that
//     is the directory's inherited ACL, which can be WIDER than the one the call
//     found on a file somebody had locked down by hand.
//   - Building the replacement and renaming it into place is one step that
//     either happened or did not, and it is the step writeSecretFile already
//     takes. So the file icacls ever sees is one this module created, and the
//     module keeps one rule instead of two.
//
// What it costs: the file's identity changes (inode, creation time, hard links)
// and the old copy must not be read-only, because a read-only target fails the
// rename. That failure reaches the caller with the original file untouched.
//
// POSIX keeps the in-place path: chmod is one atomic syscall, it rewrites
// nothing, and it has no `/reset` to make a mess with.
//
// Throwing rather than warning is deliberate: "we failed to protect it" is not
// something a caller may go on believing succeeded, and only the caller knows
// whether to abort. Callers that are tightening a file they did NOT create (a
// copy left by an older version) may catch this and report it — see
// readOrCreateToken.
export function restrictSecretFile(file) {
  if (process.platform !== "win32") {
    fs.chmodSync(file, 0o600);
    return;
  }
  const { size } = fs.statSync(file);
  if (size > MAX_SECRET_BYTES) {
    throw Object.assign(
      new Error(`refusing to make ${file} owner-only: ${size} bytes is not a secret`),
      { code: "secret_too_large" }
    );
  }
  writeSecretFile(file, fs.readFileSync(file));
}
