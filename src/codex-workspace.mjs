// codex-workspace.mjs — work out which local directory a Codex conversation is
// about, without asking the user to configure anything.
//
// Codex writes a rollout transcript per conversation:
//   ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<sessionId>.jsonl
//   ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<parent>_<sessionId>.jsonl
// The file carries the session id AND the working directory it ran in:
//   {"session_id":"01a0bfb3-...","cwd":"D:\\deepcode", ...}
// Codex also sends that same session id in the x-codex-session-id header, so the
// header is enough to recover the directory the conversation belongs to — the
// one thing a bridge serving several projects cannot otherwise know.
//
// The date directory is the day the conversation STARTED, not today: a session
// begun on the 16th is still appended to on the 24th. So the search is by file
// name across the whole tree rather than by guessing recent date directories.
import fs from "node:fs";
import path from "node:path";

/** Only the head of a transcript is read — `cwd` appears near the start. */
const HEAD_BYTES = 256 * 1024;

/** How recently a transcript must have been written to count as "the active one". */
export const RECENT_WINDOW_MS = 120_000;

/** Pull the first `"cwd"` value out of a transcript head. Pure, for tests. */
export function extractCwd(headText) {
  const m = String(headText || "").match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!m) return "";
  try {
    return JSON.parse(`"${m[1]}"`);
  } catch {
    return "";
  }
}

/**
 * Transcript file names belonging to a session. A plain conversation ends
 * "-<id>.jsonl"; a continued one is "<parent>_<child>.jsonl", so the id is
 * preceded by an underscore there. Pure, for tests.
 */
export function matchRolloutNames(names, sessionId) {
  const id = String(sessionId || "").trim().toLowerCase();
  if (!id) return [];
  const suffixes = [`-${id}.jsonl`, `_${id}.jsonl`];
  return (names || []).filter((n) => {
    const lower = String(n).toLowerCase();
    return suffixes.some((suffix) => lower.endsWith(suffix));
  });
}

function readCwdOf(file) {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(HEAD_BYTES);
      const read = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
      return extractCwd(buf.subarray(0, read).toString("utf8"));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

/**
 * The workspace of the one conversation Codex is actively writing right now.
 *
 * Needed because the bridge may not be able to see the client's session id at
 * all: on this machine Codex talks to a local proxy which forwards to the
 * bridge, and no x-* header survives the hop.
 *
 * Deliberately refuses to answer unless EXACTLY ONE transcript was written in
 * the recent window. Two active conversations means the caller cannot be
 * attributed to either, and pointing an agent at the wrong project is worse than
 * telling it nothing. Pure function of the listed files, for tests.
 */
export function soleRecentTranscript(transcripts, now = Date.now(), windowMs = RECENT_WINDOW_MS) {
  const cutoff = now - windowMs;
  const recent = (transcripts || []).filter((t) => Number(t.mtimeMs) >= cutoff);
  return recent.length === 1 ? recent[0].file : "";
}

export function resolveRecentCodexWorkspace({ sessionsRoot, now = Date.now(), windowMs = RECENT_WINDOW_MS } = {}) {
  if (!sessionsRoot) return "";
  let entries;
  try {
    entries = fs.readdirSync(sessionsRoot, { recursive: true });
  } catch {
    return "";
  }
  const transcripts = [];
  for (const relative of entries) {
    const name = String(relative);
    if (!name.toLowerCase().endsWith(".jsonl")) continue;
    const file = path.join(sessionsRoot, name);
    try {
      transcripts.push({ file, mtimeMs: fs.statSync(file).mtimeMs });
    } catch {
      /* raced with Codex rotating the file */
    }
  }
  const file = soleRecentTranscript(transcripts, now, windowMs);
  return file ? readCwdOf(file) : "";
}

/**
 * The workspace for a Codex conversation, or "" when it cannot be determined.
 * Never guesses: an unmatched session id yields "", and the caller falls back.
 */
export function resolveCodexWorkspace({ sessionsRoot, sessionId } = {}) {
  if (!sessionsRoot || !sessionId) return "";
  let entries;
  try {
    entries = fs.readdirSync(sessionsRoot, { recursive: true });
  } catch {
    return ""; // no Codex data here (or an older Node without recursive readdir)
  }
  const matches = matchRolloutNames(entries, sessionId);
  if (!matches.length) return "";

  let best = null;
  for (const relative of matches) {
    const file = path.join(sessionsRoot, String(relative));
    try {
      const mtime = fs.statSync(file).mtimeMs;
      if (!best || mtime > best.mtime) best = { file, mtime };
    } catch {
      /* raced with Codex rotating the file */
    }
  }
  return best ? readCwdOf(best.file) : "";
}
