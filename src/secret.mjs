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

// ── writing a secret file ───────────────────────────────────────────────────

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
    restrictSecretFile(tmp);
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
// then grant full control to this account and nobody else.
export function icaclsRestrictArgs(file, account) {
  return [file, "/inheritance:r", "/grant:r", `${account}:(F)`];
}

// Fully qualified, so icacls picks the right account on a domain-joined
// machine — USERDOMAIN is the computer name for a local account.
export function currentAccount() {
  const name = String(process.env.USERNAME || "").trim() || os.userInfo().username;
  const domain = String(process.env.USERDOMAIN || "").trim();
  return domain && !name.includes("\\") ? `${domain}\\${name}` : name;
}

// Make one file owner-only, or say that you could not. Throwing rather than
// warning is deliberate: "we failed to protect it" is not something a caller
// may go on believing succeeded, and only the caller knows whether to abort.
// Callers that are tightening a file they did NOT create (a copy left by an
// older version) may catch this and report it — see readOrCreateToken.
export function restrictSecretFile(file) {
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
