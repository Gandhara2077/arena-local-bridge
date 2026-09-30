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
//   3. fill it, then rename over the target — same directory, so the protected
//      file simply becomes the target, and nobody ever reads a half-written
//      secret.
//
// A failure at any step removes the temporary file and rethrows: the previous
// contents (or the absence of a file) are left exactly as they were.
//
// `fill` is the only thing the two writers below do differently, and neither of
// them has to know how big the secret is: one has the bytes in hand, the other
// copies them from the file they are already in. Neither reads anything into
// this process, which is why no size has to be ruled out in advance.
function stageProtectedFile(target, fill) {
  const tmp = `${target}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  let handle = null;
  try {
    handle = fs.openSync(tmp, "wx", 0o600);
    protectFreshFile(tmp);
    fs.closeSync(handle);
    handle = null;
    fill(tmp);
    fs.renameSync(tmp, target);
  } catch (error) {
    if (handle !== null) {
      try {
        fs.closeSync(handle);
      } catch {
        /* already gone */
      }
    }
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // An icacls step that stopped right after `/reset` leaves the staged file
      // with no access for anyone — measured: the owner cannot even read it — so
      // whether it can be deleted comes down to the parent directory's ACL and
      // to what the platform's delete path does with an unreadable file. Give
      // this account its access back and retry. Every step here is best effort:
      // the file is empty, and the error the caller needs is the one that
      // stopped the write, not a cleanup failure.
      try {
        protectFreshFile(tmp);
      } catch {
        /* nothing left to try */
      }
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* nothing left to try */
      }
    }
    throw error;
  }
}

// A secret this module holds, written owner-only or not written at all.
export function writeSecretFile(file, data) {
  stageProtectedFile(file, (tmp) => fs.writeFileSync(tmp, data));
}

// Windows has no POSIX mode bits: measured there, a file written with
// `mode: 0o600` and then chmod'ed still reports 0666, so a secret keeps
// whatever ACL its directory hands down — and a DATA_DIR placed under a shared
// tree hands it to every authenticated user (this project's own .arena-gui
// inherits `Authenticated Users:(M)`). icacls is the platform's mechanism, and
// the one a Windows administrator would look for anyway.
//
// Pure, so the rule is assertable without a disk. Three invocations, in order,
// and the first two exist because of what a brand-new file can be carrying:
//
//   1. `/grant:r` this account, while the file still holds the ACL it was born
//      with. This is the only step that fails for a reason we did not cause (a
//      name icacls cannot resolve), and it changes nothing anybody else can
//      see, so failing here costs the file nothing.
//   2. `/reset` throws away every EXPLICIT entry and re-applies what the parent
//      inherits. This is the step that cannot be replaced by `/remove:g`: a new
//      file's explicit entries are whatever Windows gave it, and that is not a
//      fixed list. When the parent directory hands nothing down, CreateFile
//      falls back to the process token's DEFAULT DACL — owner, Administrators
//      and SYSTEM on the machines measured here, but the algorithm that builds
//      it is implementation-defined (MS-DTYP, "Algorithm for Creating a Security
//      Descriptor"), so this module cannot name it and must not assume it. It
//      takes our own entry from step 1 with it, hence the grant again below.
//      It does not touch the OWNER — that is `/setowner` — so one grant after it
//      is enough.
//   3. `/inheritance:r` drops what the parent hands down, and `/grant:r` leaves
//      full control with this account and nobody else.
//
// Why three calls and not one: icacls refuses to combine `/reset` with
// `/inheritance` or `/grant` on a single command line, and it validates the
// whole command line BEFORE acting, so it is a syntax refusal rather than an
// ordering surprise. Measured on this machine: exit 87
// (ERROR_INVALID_PARAMETER), with the file's ACL untouched.
export function icaclsFreshFileCommands(file, account) {
  return [
    [file, "/grant:r", `${account}:(F)`],
    [file, "/reset"],
    [file, "/inheritance:r", "/grant:r", `${account}:(F)`],
  ];
}

// Fully qualified, so icacls picks the right account on a domain-joined
// machine — USERDOMAIN is the computer name for a local account.
export function currentAccount() {
  const name = String(process.env.USERNAME || "").trim() || os.userInfo().username;
  const domain = String(process.env.USERDOMAIN || "").trim();
  return domain && !name.includes("\\") ? `${domain}\\${name}` : name;
}

// Owner-only for a file this module has just created, or say that you could
// not. writeSecretFile is the only caller, and being the only caller is what
// makes the several icacls calls of icaclsFreshFileCommands safe here: the file
// is empty when this runs (the secret is written after it returns) and it was
// created a moment ago, so a failure anywhere in the sequence costs nothing but
// discarding it. That is exactly what restrictSecretFile cannot do — a file that
// already holds a secret has no safe intermediate state to stop in.
function protectFreshFile(file) {
  if (process.platform !== "win32") {
    fs.chmodSync(file, 0o600);
    return;
  }
  const account = currentAccount();
  try {
    for (const args of icaclsFreshFileCommands(file, account)) {
      execFileSync("icacls", args, { windowsHide: true, stdio: "ignore" });
    }
  } catch (error) {
    throw Object.assign(
      new Error(`could not make ${file} owner-only (${account}): ${String(error?.message || error)}`),
      { code: "secret_not_restricted" }
    );
  }
}

// Make one file owner-only, or say that you could not.
//
// On Windows this REPLACES the file — a fresh, already-protected copy is renamed
// over it — instead of tightening the ACL where it stands. The reason is the
// shape of the job rather than the number of icacls calls: an icacls sequence
// has no safe state to be interrupted in, and this file is not empty. Measured:
// a file left right after `/reset` is one its own owner cannot even read. On a
// staged, still-empty file that is harmless (see protectFreshFile); on a file
// that already holds a secret it would be a window in which the secret is either
// exposed or beyond repair. Building the replacement and renaming it into place
// is one step that either happened or did not, and it is the step writeSecretFile
// already takes — both go through stageProtectedFile — so the file icacls ever
// sees is one this module created itself, and the module keeps one rule instead
// of two.
//
// The copy is the platform's, not this process's: nothing is read into memory,
// so an existing .env of any size can still be tightened. A size limit here
// would be a new way for the startup pass to give up on a file it used to
// tighten, and giving up quietly is the one outcome this module exists to avoid.
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
  stageProtectedFile(file, (tmp) => fs.copyFileSync(file, tmp));
}
