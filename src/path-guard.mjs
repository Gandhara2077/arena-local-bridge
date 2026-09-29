// path-guard.mjs — the one decision every Local MCP file operation goes
// through: workspace in, explicit read-only roots read-only, everything else
// out, and the bridge's own data directory denied EVEN when it sits inside the
// workspace (it holds every account's cookies and the bridge key — ADR 0003
// / 0006). A boundary guarded only in exec_command is no boundary at all:
// read_file without this check would stroll out of the workspace.
//
// Pure on purpose: no fs, no process side effects. Symlink truth enters
// through the injected `resolve` (fs.realpathSync.native in production, with a
// lexical fallback for paths that do not exist yet — a write target is often
// not on disk when it is judged). Tests inject a stub to express link escapes.

import path from "node:path";

const INTENTS = new Set(["read", "write", "exec"]);

// Windows filenames are case-insensitive; folding both sides keeps `C:\WS` and
// `c:\ws` from becoming a loophole. Case-sensitive platforms compare as-is, so
// a workspace may legally hold both `Foo` and `foo`.
function fold(p) {
  return process.platform === "win32" ? String(p).toLowerCase() : p;
}

/** Is `target` inside (or equal to) `root`? Segment-accurate: a sibling whose
 *  name merely extends the root's name (`/ws` vs `/ws2`) is NOT inside. */
function within(root, target) {
  const rel = path.relative(fold(root), fold(target));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Resolve as much of `target` as exists on disk, and keep the not-yet-existing
 * tail lexical. Resolving only the final path is not enough: a WRITE target
 * usually does not exist yet, so its realpath fails outright — and if its
 * PARENT is a symlink pointing out of the workspace, the lexical fallback
 * would wave the escape through. Walking up to the nearest existing ancestor
 * and rejoining the tail keeps those writes honest.
 */
function resolveTarget(target, resolve) {
  let p = target;
  const tail = [];
  for (;;) {
    try {
      const real = resolve(p);
      return tail.length ? path.join(real, ...tail) : real;
    } catch {
      const parent = path.dirname(p);
      if (parent === p) return target; // nothing on disk resolves; judge lexically
      tail.unshift(path.basename(p));
      p = parent;
    }
  }
}

/**
 * Decide one path. Returns
 *   { allowed: true, mode: "read-write" | "read-only" }
 *   { allowed: false, reason }
 * and never throws — a malformed path is a denial, not a crash.
 *
 * `resolve` is applied to the target AND every root so a symlink cannot land
 * the target outside while the root stays where it appears to be. When it
 * throws (target not on disk yet), the lexically normalized path is used:
 * that is exactly what a write target is.
 */
export function decidePath(
  { path: target, intent, workspaceRoots = [], readOnlyRoots = [], privateRoots = [] },
  { resolve = (p) => p } = {}
) {
  const deny = (reason) => ({ allowed: false, reason });
  if (!INTENTS.has(intent)) return deny(`unknown intent: ${String(intent)}`);
  if (typeof target !== "string" || !target.trim()) return deny("path must be a non-empty string");
  if (!path.isAbsolute(target)) return deny(`path must be absolute: ${target}`);

  const lexical = path.resolve(target);
  const real = resolveTarget(lexical, resolve);

  const rootsOf = (list) =>
    list.map((r) => {
      try {
        return resolve(path.resolve(r));
      } catch {
        return path.resolve(r);
      }
    });

  // Order IS the rule: the data directory wins even over the workspace.
  for (const root of rootsOf(privateRoots)) {
    if (within(root, real)) return deny("path is inside the bridge data directory, which no tool may touch");
  }
  for (const root of rootsOf(workspaceRoots)) {
    if (within(root, real)) return { allowed: true, mode: "read-write" };
  }
  for (const root of rootsOf(readOnlyRoots)) {
    if (within(root, real)) {
      if (intent === "read") return { allowed: true, mode: "read-only" };
      return deny("path is in a read-only root: reads only, no writes, no execution");
    }
  }
  return deny("path is outside the workspace and every granted root");
}

/**
 * The roots object every decidePath consumer receives, assembled in one place:
 * the workspace stays read-write, the config's EXPLICIT skill roots become
 * read-only roots (ADR 0008 — only listed directories are opened, never the
 * home wholesale), and the data directory lands in privateRoots so it stays
 * denied even when a workspace or skill root would otherwise cover it —
 * decidePath checks privateRoots first.
 *
 * A skill root may NOT overlap the workspace in either direction. That is a
 * configuration error, not a precedence question: decidePath checks
 * workspaceRoots before readOnlyRoots, so an overlap would silently make the
 * "read-only" root writable and "skill roots are read-only" would be a lie.
 * Fail fast here instead.
 *
 * The `resolve` hook is the same contract decidePath takes
 * (fs.realpathSync.native in production): overlap is judged on REAL paths, so
 * a skill root that is a symlink or junction into the workspace cannot slip
 * past the lexical comparison and end up writable as part of the workspace.
 * A root that is not on disk yet cannot be resolved — fall back to its lexical
 * path, exactly as decidePath's rootsOf does.
 */
export function buildRoots(
  { skillRoots = [], dataDir = "" } = {},
  workspaceRoots = [],
  { resolve = (p) => p } = {},
) {
  const realRoot = (root) => {
    try {
      return resolve(path.resolve(root));
    } catch {
      return path.resolve(root);
    }
  };
  for (const skill of skillRoots) {
    for (const ws of workspaceRoots) {
      const skillReal = realRoot(skill);
      const wsReal = realRoot(ws);
      if (within(skillReal, wsReal) || within(wsReal, skillReal)) {
        throw new Error(
          `skill root ${skill} overlaps workspace ${ws}: skill roots are read-only and must not intersect the workspace`,
        );
      }
    }
  }
  return {
    workspaceRoots: [...workspaceRoots],
    readOnlyRoots: [...skillRoots],
    privateRoots: dataDir ? [dataDir] : [],
  };
}
