// local-mcp.mjs — our own Local MCP server: the six tools the preamble
// promises (read_file / list_dir / search_text / file_edit / exec_command /
// file_publish), speaking the same JSON-RPC envelope the remote agent already
// speaks, with every path handed to the ticket-11 path guard.
//
// Scope is deliberately a MINIMAL same-name subset of the real AgentDock
// 0.8.3 contracts (captured verbatim from its tools/list): no WSL runtimes,
// no patch envelopes, no background exec sessions, no signed publish URLs —
// the preamble only ever promised add/replace edits and plain command runs,
// and clients re-read OUR tools/list every session.
//
// Architecture notes taken from the author's own Arena模型助手 MCP bridge
// (assets/mcp-local-bridge.cjs): one shared tree walker for both listing and
// search, temp-file-then-rename atomic writes, a single send() for every
// response, and a blanket Origin ban (a browser can never carry our bearer,
// so 403-ing it at the door is pure defense-in-depth for the loopback port).
// Deliberately NOT adopted: token-in-URL routing (our clients present a
// Bearer header), Mcp-Session-Id bookkeeping (single tenant behind the
// bearer), JSON-RPC batch arrays (the preamble client sends one message per
// request), and schema validation (tool failures already come back as isError
// results the model can read).
//
// Decisions this file settles for ticket 12:
// - search_text is implemented in Node (an external grep would be exec by
//   another name and sidestep the boundary).
// - Responses are plain application/json. Measured against the real exe: it
//   answers JSON for the exact Accept the preamble sends, so JSON-only is
//   compatible, not a guess.
// - Relative paths are REJECTED (the old resolve-to-~/AgentDock behaviour was
//   the trap the preamble warns about); absolute paths only.
// - exec_command is a LOCAL SHELL, not a sandboxed executor (ADR 0011,
//   settling the P1 ticket-12 review found): the path guard pins its cwd to
//   the workspace, but the command itself runs with the bridge's full
//   local-user permissions and can reach anything that user can — the
//   file-tool boundary does NOT constrain it. The tool description and the
//   preamble disclose this to the model.

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { VERSION } from "./version.mjs";
import { decidePath } from "./path-guard.mjs";

// How symlink truth enters the guard: the real filesystem. A missing path
// throws, and the guard walks up to the nearest existing ancestor itself.
const resolveReal = (p) => fs.realpathSync.native(p);

const clamp = (value, fallback, cap) => Math.min(Number(value) > 0 ? Number(value) : fallback, cap);

// ── tool schemas (our minimal same-name subset) ─────────────────────────────

const str = (description) => ({ type: "string", description });
const int = (description, extra = {}) => ({ type: "integer", description, ...extra });
const bool = (description) => ({ type: "boolean", description });
const schema = (properties, required = []) => ({ type: "object", properties, required });

const TOOL_SCHEMAS = [
  {
    name: "read_file",
    description: "Read a text file from the workspace. Absolute paths only.",
    inputSchema: schema({
      path: str("Absolute path inside the workspace."),
      start_line: int("1-based start line."),
      end_line: int("Inclusive end line."),
      max_bytes: int("Maximum output bytes. Defaults to 262144.", { minimum: 1, maximum: 4_194_304 }),
    }, ["path"]),
  },
  {
    name: "list_dir",
    description: "List a directory from the workspace. Absolute paths only.",
    inputSchema: schema({
      path: str("Absolute directory path inside the workspace."),
      max_depth: int("Maximum traversal depth. Defaults to 1.", { minimum: 1, maximum: 20 }),
      entry_type: { type: "string", enum: ["any", "file", "directory"], description: "Defaults to any." },
      max_entries: int("Maximum returned entries. Defaults to 200.", { minimum: 1, maximum: 5000 }),
    }, ["path"]),
  },
  {
    name: "search_text",
    description:
      "Search file contents for text or a regex, recursively, from an absolute path inside the workspace.",
    inputSchema: schema({
      query: str("Text or regex query."),
      path: str("Absolute start path inside the workspace. Defaults to the workspace root."),
      regex: bool("Treat query as a regex."),
      case_sensitive: bool("Use case-sensitive search."),
      max_results: int("Maximum matches. Defaults to 100.", { minimum: 1, maximum: 1000 }),
    }, ["query"]),
  },
  {
    name: "file_edit",
    description: "Create (add) or edit (replace) a text file inside the workspace. Absolute paths only.",
    inputSchema: schema({
      action: { type: "string", enum: ["add", "replace"], description: "add creates a new file; replace edits an existing one." },
      path: str("Absolute target path inside the workspace."),
      content: str("Text content for action=add."),
      old: str("Exact text to replace for action=replace."),
      new: str("Replacement text for action=replace."),
      replace_all: bool("Replace every match instead of only the first."),
      expected_matches: int("Required number of matches for action=replace. Defaults to 1.", { minimum: 0 }),
      overwrite: bool("Allow add to replace an existing file."),
    }, ["action"]),
  },
  {
    name: "exec_command",
    description:
      "Run a shell command with its cwd pinned inside the workspace. It runs as the local user " +
      "the bridge signs in as, so it can reach whatever that user can reach: pinning the cwd " +
      "constrains where a command starts, not what it is able to read or write (ADR 0011). Stay " +
      "inside the workspace unless the user asked otherwise, and ask before touching anything " +
      "outside it or before destructive actions.",
    inputSchema: schema({
      cmd: str("Command to run."),
      workdir: str("Absolute working directory inside the workspace. Defaults to the workspace root."),
      timeout_ms: int("Kill the command after this long. Defaults to 120000, capped at 600000.", { minimum: 1, maximum: 600_000 }),
      max_output_bytes: int("Maximum captured output bytes. Defaults to 262144.", { minimum: 1, maximum: 4_194_304 }),
    }, ["cmd"]),
  },
  {
    name: "file_publish",
    description:
      "Copy a finished workspace file into the bridge's published folder for the user to collect, and return that path.",
    inputSchema: schema({
      path: str("Absolute source path inside the workspace."),
    }, ["path"]),
  },
];

// ── JSON-RPC plumbing ────────────────────────────────────────────────────────

const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
const send = (res, status, body) => {
  res.writeHead(status, body === undefined ? undefined : { "Content-Type": "application/json" });
  res.end(body === undefined ? "" : JSON.stringify(body));
};

function toolResult(text, isError = false) {
  const out = { content: [{ type: "text", text }] };
  if (isError) out.isError = true;
  return out;
}

/** Constant-time bearer comparison: hash both sides so lengths never leak. */
function tokenMatches(expected, presented) {
  if (!expected || !presented) return false;
  const a = crypto.createHash("sha256").update(String(expected)).digest();
  const b = crypto.createHash("sha256").update(String(presented)).digest();
  return crypto.timingSafeEqual(a, b);
}

// ── the six tools ────────────────────────────────────────────────────────────

function guard({ roots }, targetPath, intent) {
  const decision = decidePath(
    { path: targetPath, intent, workspaceRoots: roots.workspaceRoots, readOnlyRoots: roots.readOnlyRoots, privateRoots: roots.privateRoots },
    { resolve: resolveReal },
  );
  if (!decision.allowed) throw Object.assign(new Error(decision.reason), { denied: true });
  return decision;
}

function readWholeFile(file, maxBytes) {
  const stat = fs.statSync(file);
  if (stat.isDirectory()) throw new Error("path is a directory, not a file");
  // Read at most maxBytes bytes off the disk — a stat.size beyond the cap must
  // not turn into a whole-file read of a multi-gigabyte log.
  const handle = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(Math.min(stat.size, maxBytes));
    const read = fs.readSync(handle, buf, 0, buf.length, 0);
    return { text: buf.toString("utf8", 0, read), truncated: read < stat.size };
  } finally {
    fs.closeSync(handle);
  }
}

// One shared depth-first walker for list_dir and search_text. `descend`
// decides which directories to enter (search skips node_modules/.git;
// list_dir with entry_type=file stays flat — a directory is not a file, so we
// do not enter it looking for one).
function* walkTree(root, ctx, { maxDepth = Infinity, descend = null } = {}) {
  let names;
  try {
    names = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of names) {
    const full = path.join(root, entry.name);
    try { guard(ctx, full, "read"); } catch (error) {
      if (error.denied) continue;
      throw error;
    }
    yield { entry, full };
    if (entry.isDirectory() && maxDepth > 1 && (!descend || descend(entry))) {
      yield* walkTree(full, ctx, { maxDepth: maxDepth - 1, descend });
    }
  }
}

function toolReadFile(args, ctx) {
  guard(ctx, args.path, "read");
  const { text, truncated } = readWholeFile(args.path, clamp(args.max_bytes, 262_144, 4_194_304));
  // Line slicing only means something on the full text: after a byte cut the
  // line numbers the caller asked for no longer correspond to the real file.
  if (!truncated && (args.start_line !== undefined || args.end_line !== undefined)) {
    const lines = text.split("\n");
    const start = Math.max(1, Number(args.start_line) || 1);
    const end = Math.min(lines.length, Number(args.end_line) || lines.length);
    return toolResult(lines.slice(start - 1, end).join("\n"));
  }
  return toolResult(truncated ? `${text}\n[truncated]` : text);
}

function toolListDir(args, ctx) {
  guard(ctx, args.path, "read");
  const filter = args.entry_type || "any";
  const out = [];
  for (const { entry, full } of walkTree(args.path, ctx, {
    maxDepth: clamp(args.max_depth, 1, 20),
    descend: filter === "file" ? () => false : null,
  })) {
    const isDir = entry.isDirectory();
    if (filter === "file" && isDir) continue;
    if (filter === "directory" && !isDir) continue;
    if (out.length >= clamp(args.max_entries, 200, 5000)) break;
    const rel = path.relative(args.path, full).split(path.sep).join("/");
    out.push(`${rel}${isDir ? "/" : ""}`);
  }
  return toolResult(out.join("\n"));
}

// search_text — Node self-implementation. A spawned grep would be exec by
// another name and sidestep the boundary this server exists to enforce.
const SEARCH_SKIP_DIRS = new Set(["node_modules", ".git"]);
const SEARCH_MAX_FILE_BYTES = 1_000_000;
const SEARCH_MAX_FILES = 20_000;
const SEARCH_MAX_LINE_CHARS = 2_000;
const SEARCH_MAX_TOTAL_BYTES = 50_000_000;

function toolSearchText(args, ctx) {
  const start = args.path || ctx.roots.workspaceRoots[0];
  if (!start) throw new Error("no workspace configured");
  guard(ctx, start, "read");
  const maxResults = clamp(args.max_results, 100, 1000);
  const flags = args.case_sensitive ? "" : "i";
  const matcher = args.regex
    ? ((re) => (line) => re.test(line))(new RegExp(args.query, flags))
    : ((needle) => (line) => line.toLowerCase().includes(needle))(
        args.case_sensitive ? args.query : String(args.query).toLowerCase(),
      );
  // The match input is capped per line: a catastrophic regex supplied by the
  // remote model then backtracks over a bounded string, never over a whole
  // file. Not a formal guarantee — a hard one needs a worker with a timeout —
  // but the budget caps what any single call can chew.
  const matches = [];
  let scanned = 0;
  let scannedBytes = 0;
  for (const { entry, full } of walkTree(start, ctx, { descend: (dir) => !SEARCH_SKIP_DIRS.has(dir.name) })) {
    if (matches.length >= maxResults || scanned >= SEARCH_MAX_FILES || scannedBytes >= SEARCH_MAX_TOTAL_BYTES) break;
    if (!entry.isFile()) continue;
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (stat.size > SEARCH_MAX_FILE_BYTES) continue;
    scanned += 1;
    scannedBytes += stat.size;
    let text;
    try {
      text = fs.readFileSync(full, "utf8");
    } catch {
      continue; // binary or unreadable
    }
    if (text.includes("\0")) continue; // binary
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].slice(0, SEARCH_MAX_LINE_CHARS);
      if (matcher(line)) {
        matches.push(`${full}:${i + 1}: ${line.trim().slice(0, 400)}`);
        if (matches.length >= maxResults) break;
      }
    }
  }
  return toolResult(matches.length ? matches.join("\n") : "no matches");
}

// Write through a unique, exclusively-created sibling temp file and rename, so
// a crash can never leave a half-written target, two concurrent edits can
// never share a temp, and a user file that happens to be named like our old
// fixed `.mcp-tmp` suffix can never be clobbered.
function writeFileAtomic(file, data) {
  for (;;) {
    const temp = `${file}.mcp-tmp-${crypto.randomBytes(6).toString("hex")}`;
    try {
      // wx: exclusive create — a colliding name is retried, never overwritten.
      fs.writeFileSync(temp, data, { flag: "wx" });
    } catch (error) {
      if (error?.code === "EEXIST") continue; // 48-bit random name collided
      throw error;
    }
    try {
      fs.renameSync(temp, file);
      return;
    } catch (error) {
      fs.rmSync(temp, { force: true });
      throw error;
    }
  }
}

function toolFileEdit(args, ctx) {
  guard(ctx, args.path, "write");
  if (args.action === "add") {
    if (fs.existsSync(args.path) && !args.overwrite) {
      throw new Error("file already exists; pass overwrite to replace it");
    }
    const content = String(args.content ?? "");
    fs.mkdirSync(path.dirname(args.path), { recursive: true });
    writeFileAtomic(args.path, Buffer.from(content, "utf8"));
    return toolResult(`wrote ${args.path} (${Buffer.byteLength(content, "utf8")} bytes)`);
  }
  if (args.action === "replace") {
    if (typeof args.old !== "string") throw new Error("action=replace requires the exact text in `old`");
    const text = fs.readFileSync(args.path, "utf8");
    const parts = text.split(args.old);
    const matches = parts.length - 1;
    const expected = Number(args.expected_matches ?? 1);
    if (matches !== expected) {
      throw new Error(`expected ${expected} match(es), found ${matches}`);
    }
    // The replacement is a FUNCTION so `new` stays literal: with a string,
    // String.replace would expand `$&`, `` $` ``, `$'`, `$1`… inside it —
    // data corruption for a tool whose contract is "swap exact text for
    // exact text". (replace_all already joins literally; now both agree.)
    const next = args.replace_all
      ? parts.join(String(args.new ?? ""))
      : text.replace(args.old, () => String(args.new ?? ""));
    writeFileAtomic(args.path, Buffer.from(next, "utf8"));
    return toolResult(`replaced ${matches} occurrence(s) in ${args.path}`);
  }
  throw new Error(`unsupported action: ${String(args.action)}`);
}

/**
 * exec_command's policy, pure and separately testable (the seam ticket 12
 * mandates): which cwd the command runs in, and the resource caps. The path
 * guard is applied by the caller against the returned cwd — intent "exec".
 * Per ADR 0011 the cwd is a PIN, not a sandbox: the command itself runs with
 * the bridge's full local-user permissions.
 */
export function execPlan(args = {}, roots) {
  const cwd = String(args.workdir || "").trim() || roots.workspaceRoots[0];
  if (!cwd) throw new Error("no workspace configured");
  return {
    cwd,
    timeoutMs: clamp(args.timeout_ms, 120_000, 600_000),
    maxOutputBytes: clamp(args.max_output_bytes, 262_144, 4_194_304),
  };
}

function toolExecCommand(args, ctx) {
  const { cwd, timeoutMs, maxOutputBytes } = execPlan(args, ctx.roots);
  guard(ctx, cwd, "exec");
  return new Promise((resolve) => {
    const child = spawn(String(args.cmd ?? ""), {
      shell: true,
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      // ADR 0011: the cwd is a pin, not a sandbox. Free execution, no
      // whitelist, no confirmation. Detached so we can kill the whole tree
      // on timeout.
      detached: process.platform !== "win32",
    });
    // Cap by BYTES: chunks are Buffers until the very end, and a multi-byte
    // UTF-8 tail is simply cut — the schema promises bytes, not characters.
    const chunks = [];
    let total = 0;
    let killed = false;
    let settled = false;
    const collect = (chunk) => {
      if (total < maxOutputBytes) {
        chunks.push(chunk);
        total += chunk.length;
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const finish = (suffix, isError = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(toolResult(Buffer.concat(chunks).subarray(0, maxOutputBytes).toString("utf8") + suffix, isError));
    };
    const killTree = () => {
      killed = true;
      // Kill the whole tree, not just the shell: with shell:true the direct
      // child is cmd.exe/sh and a bare kill() would leave the real command
      // running while its stdio keeps close() waiting.
      try {
        if (process.platform === "win32") {
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        } else {
          process.kill(-child.pid);
        }
      } catch {
        child.kill();
      }
      child.stdout.destroy();
      child.stderr.destroy();
      // SIGTERM can be ignored; a command that survives this long gets two
      // more seconds, then the result is delivered without it — close() must
      // never be the only thing standing between the caller and an answer.
      try {
        if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
      setTimeout(() => finish("\n[timed out and was killed]"), 2_000);
    };
    const timer = setTimeout(killTree, timeoutMs);
    child.on("error", (e) => finish(`failed to start: ${e.message}`, true));
    child.on("close", (code) => {
      finish(`${killed ? "\n[timed out and was killed]" : ""}\n[exit code: ${code}]`);
    });
  });
}

function toolFilePublish(args, ctx) {
  guard(ctx, args.path, "read");
  const destDir = ctx.roots.privateRoots?.[0]
    ? path.join(ctx.roots.privateRoots[0], "published")
    : "";
  if (!destDir) throw new Error("no data directory configured to publish into");
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, `${Date.now()}-${path.basename(args.path)}`);
  fs.copyFileSync(args.path, dest);
  return toolResult(`published to ${dest}`);
}

const TOOLS = {
  read_file: toolReadFile,
  list_dir: toolListDir,
  search_text: toolSearchText,
  file_edit: toolFileEdit,
  exec_command: toolExecCommand,
  file_publish: toolFilePublish,
};

// ── the server ───────────────────────────────────────────────────────────────

/**
 * The Local MCP endpoint. `roots` is the ticket-11 boundary exactly:
 * { workspaceRoots, readOnlyRoots, privateRoots }. `token` is the bearer the
 * remote agent presents (the data directory's auth-token.txt in production).
 */
export function createLocalMcpServer({ token, roots }) {
  const ctx = { roots, token };
  return http.createServer((req, res) => {
    // Browsers can never carry our bearer, but a web page can still knock on
    // the loopback port: ban them outright (DNS-rebinding posture, ADR 0004).
    if (req.headers.origin) return send(res, 403, { error: "browser origins not allowed" });
    const auth = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!tokenMatches(token, auth)) {
      return send(res, 401, { error: "invalid bearer token" });
    }
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" });
      return res.end();
    }
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 5_000_000) tooLarge = true;
      else chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) return send(res, 413, rpcError(null, -32700, "Request too large"));
      let message;
      try {
        message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return send(res, 400, rpcError(null, -32700, "Parse error"));
      }
      void handleMessage(message, ctx).then((reply) => {
        // A notification (no id): nothing to answer.
        if (reply === undefined) return send(res, 202);
        send(res, 200, reply);
      });
    });
  });
}

async function handleMessage(message, ctx) {
  const { id, method, params } = message || {};
  if (id === undefined || id === null) return undefined; // notification
  switch (method) {
    case "initialize":
      return ok(id, {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "arena-local-bridge", version: VERSION },
      });
    case "tools/list":
      return ok(id, { tools: TOOL_SCHEMAS });
    case "tools/call": {
      const name = String(params?.name || "");
      const tool = TOOLS[name];
      if (!tool) return rpcError(id, -32602, `unknown tool: ${name}`);
      try {
        return ok(id, await tool(params?.arguments || {}, ctx));
      } catch (error) {
        // Denials and tool-level failures are RESULTS with isError, so the
        // remote model can read the reason and correct course.
        return ok(id, toolResult(error.message || String(error), true));
      }
    }
    default:
      return rpcError(id, -32601, `method not found: ${String(method)}`);
  }
}
