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
import { workspaceFromHeaders } from "./mcp-preamble.mjs";

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

/**
 * Every transcript under `sessionsRoot`, as {name, file, mtimeMs}. The one
 * filesystem read both resolvers share: the recursive listing happens once, and
 * a file that vanishes mid-walk (Codex rotating it) is simply skipped.
 */
function listTranscripts(sessionsRoot) {
  if (!sessionsRoot) return [];
  let entries;
  try {
    entries = fs.readdirSync(sessionsRoot, { recursive: true });
  } catch {
    return []; // no Codex data here (or an older Node without recursive readdir)
  }
  const out = [];
  for (const relative of entries) {
    const name = String(relative);
    if (!name.toLowerCase().endsWith(".jsonl")) continue;
    const file = path.join(sessionsRoot, name);
    try {
      out.push({ name, file, mtimeMs: fs.statSync(file).mtimeMs });
    } catch {
      /* raced with Codex rotating the file */
    }
  }
  return out;
}

export function resolveRecentCodexWorkspace({ sessionsRoot, now = Date.now(), windowMs = RECENT_WINDOW_MS } = {}) {
  const file = soleRecentTranscript(listTranscripts(sessionsRoot), now, windowMs);
  return file ? readCwdOf(file) : "";
}

/**
 * The workspace for a Codex conversation, or "" when it cannot be determined.
 * Never guesses: an unmatched session id yields "", and the caller falls back.
 */
export function resolveCodexWorkspace({ sessionsRoot, sessionId } = {}) {
  const id = String(sessionId || "").trim();
  if (!id) return "";
  const all = listTranscripts(sessionsRoot);
  const wanted = new Set(matchRolloutNames(all.map((t) => t.name), id));
  let best = null;
  for (const t of all) {
    if (!wanted.has(t.name)) continue;
    if (!best || t.mtimeMs > best.mtimeMs) best = t;
  }
  return best ? readCwdOf(best.file) : "";
}

/**
 * The local directory this conversation is about, plus where the answer came
 * from (so the caller can log the provenance). One bridge serves several
 * conversations, so precedence, highest first:
 *
 *   1. an explicit x-arena-workspace header — the caller knows best
 *   2. the cwd Codex recorded for the session id it sent us
 *   3. the single transcript Codex is writing right now — the fallback for when
 *      no session id survives the local proxy hop on this machine
 *   4. the configured default
 *
 * Never invents a path; source "none" means the caller should omit the line.
 */
export function resolveWorkspace({ headers = null, sessionsRoot = "", windowMs = RECENT_WINDOW_MS, fallback = "" } = {}) {
  const fromCaller = workspaceFromHeaders(headers);
  if (fromCaller) return { workspace: fromCaller, source: "request-header" };

  const sessionId = String(headers?.["x-codex-session-id"] || "").trim();
  if (sessionId) {
    const fromCodex = resolveCodexWorkspace({ sessionsRoot, sessionId });
    if (fromCodex) return { workspace: fromCodex, source: "codex-session" };
  }

  const fromRecent = resolveRecentCodexWorkspace({ sessionsRoot, windowMs });
  if (fromRecent) return { workspace: fromRecent, source: "codex-recent" };

  const configured = String(fallback || "").trim();
  return { workspace: configured, source: configured ? "config" : "none" };
}
