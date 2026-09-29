// agentdock.mjs — manages the local AgentDock MCP server + its public tunnel so
// the Arena cloud agent can reach this machine. Driven by the GUI (§4.26).
//   start(): token -> cloudflared quick tunnel -> publish endpoint -> AgentDock
//   stop():  kill both, remove the endpoint file (bridge then stops injecting)
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import crypto from "node:crypto";
import { log, maskTunnelUrl } from "./util.mjs";

// One regex, used only through `match` and `replace` — both of which reset
// `lastIndex`, so the `/g` cannot drift between calls. `.test` / `.exec` would
// be stateful here; there are none.
const URL_RE = /https:\/\/[A-Za-z0-9._-]+\.trycloudflare\.com/g;

// cloudflared prints the public URL into its own log file, and that URL is a
// credential — the same one #04 keeps out of OUR log lines. The children's
// output pipes are the last point where those bytes are still ours, so both
// logs are written by us from a filtered stream. Redacting them afterwards is
// not an option: the child holds its file open (Windows will not let us delete
// it) and a retry prints a fresh URL, so a one-shot truncate leaves a hole.
//
// Lines, not chunks. A read boundary can land inside the URL, and deciding per
// chunk would both write the two halves out unmasked AND fail to recognise the
// URL at all — the URL discovery reads these same lines.
function createLineSplitter(onLine) {
  let carry = "";
  return {
    push(chunk) {
      const text = carry + String(chunk ?? "");
      let start = 0;
      for (let end = text.indexOf("\n"); end >= 0; end = text.indexOf("\n", start)) {
        onLine(text.slice(start, end + 1));
        start = end + 1;
      }
      carry = text.slice(start);
    },
    flush() {
      const rest = carry;
      carry = "";
      if (rest) onLine(rest);
    },
  };
}

function mask(text) {
  return text.replace(URL_RE, (url) => maskTunnelUrl(url));
}

// A log file whose every line is masked on the way out. `onLine` sees the line
// RAW — that is how the tunnel's URL is still found — so the callback may look
// at it, never write it anywhere. Same job shape as writeSecretFile above: keep
// the bytes that matter out of reach.
export function openMaskedLog(file, onLine = () => {}) {
  const stream = fs.createWriteStream(file, { flags: "a" });
  // A log we cannot write must not take the process down with it: the raw-fd
  // version this replaces swallowed these errors too.
  stream.on("error", () => {});
  const splitters = [];
  return {
    // One splitter per source. stdout and stderr arrive independently, and a
    // shared buffer would glue half of one line onto half of another.
    pump(source) {
      const splitter = createLineSplitter((line) => {
        onLine(line);
        stream.write(mask(line));
      });
      splitters.push(splitter);
      source.setEncoding("utf8");
      source.on("data", (chunk) => splitter.push(chunk));
    },
    // Resolves once the bytes are actually on disk, so a caller can wait for it.
    // A stream that already failed will never emit `close` again — waiting on
    // that would hang `stop()` for good, hence the check.
    close() {
      for (const splitter of splitters) splitter.flush();
      if (stream.closed || stream.destroyed) return Promise.resolve();
      return new Promise((resolve) => {
        stream.once("close", resolve);
        stream.end();
      });
    },
  };
}

// The bearer token and the public endpoint are secrets: holding both is enough
// to read and write this machine's workspace through the tunnel. Same 0o600 the
// credential store already applies to credentials.json — see the note in
// test/agentdock.test.mjs about what that does and does not buy on Windows.
// Same three steps the credential store uses (write a .tmp, rename over the
// target, then chmod): `mode` only applies to a file this call creates, so
// writing straight to an existing target would leave it at its old permissions.
export function writeSecretFile(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function portOpen(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const s = net.connect(port, host);
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    s.setTimeout(700, () => done(false));
  });
}

// One spawn, every process: the executable path of a live PID can only come from
// the OS. `tasklist` gives names only, and `wmic` is missing on newer Windows and
// blacklisted on some machines, so CIM over PowerShell is the portable choice.
const PROCESS_PATHS_ARGS = [
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  "Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath | ConvertTo-Csv -NoTypeInformation",
];

function killPid(pid) {
  return new Promise((resolve) => {
    execFile("taskkill", ["/F", "/PID", String(pid)], () => resolve());
  });
}

function capture(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) =>
      resolve(error ? "" : String(stdout || ""))
    );
  });
}

// `Get-CimInstance Win32_Process | ConvertTo-Csv` → { pid: "C:\…\x.exe" }. Pure,
// so the deciding rule can be tested without spawning anything. A pid the OS
// would not give a path for is omitted rather than guessed at.
export function parseProcessPathsCsv(csv) {
  const paths = {};
  for (const line of String(csv || "").split(/\r?\n/)) {
    const m = line.match(/^"(\d+)","(.+?)"$/);
    if (!m) continue; // header row, blank line, an error notice, an empty path
    const pid = Number(m[1]);
    if (Number.isSafeInteger(pid) && m[2].trim()) paths[String(pid)] = m[2];
  }
  return paths;
}

// Which PIDs may we stop?
//   tracked   — spawned by THIS process, ours by construction
//   persisted — left over from an earlier run. A recycled PID can belong to
//               anything, and sharing an image name proves nothing, so the only
//               evidence accepted is that the executable path is the one
//               recorded when we spawned it. No observable path ⇒ not ours.
export function pidsToStop({ tracked = [], persisted = [], paths = {}, selfPid = 0 } = {}) {
  const samePath = (a, b) =>
    String(a || "").replace(/\\/g, "/").toLowerCase() === String(b || "").replace(/\\/g, "/").toLowerCase();
  const out = [];
  for (const entry of [...tracked, ...persisted]) {
    // New records are { pid, exe }; a legacy bare number has no path to check.
    const record = entry && typeof entry === "object" ? entry : null;
    const pid = record ? record.pid : entry;
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === selfPid) continue;
    if (out.includes(pid)) continue;
    const ours = tracked.includes(pid) || (record && record.exe && samePath(paths[String(pid)], record.exe));
    if (ours) out.push(pid);
  }
  return out;
}

// The two credential-bearing files live ONLY in the data directory. The
// install dir is a third-party tree: we neither write secrets into it nor read
// legacy copies back out of it — two locations would mean two sources of
// truth. Files an older version left behind in the install dir are ignored,
// never migrated, never cleaned.
export function tokenFilePath(dataDir) {
  // No data directory configured ⇒ no file at all: a token is generated per
  // process rather than landing in whatever directory happens to be around.
  // (The pid file's `dataDir || dir` fallback must NOT be copied here — a
  // credential file has no business falling back to a third-party directory.)
  return dataDir ? path.join(dataDir, "auth-token.txt") : "";
}

export function readOrCreateToken(file) {
  if (file) {
    try {
      const t = fs.readFileSync(file, "utf8").trim();
      if (t) {
        // An install that predates the 0o600 rule would keep its old permissions
        // forever, because we only ever generate a token once.
        try {
          fs.chmodSync(file, 0o600);
        } catch {
          /* ignore */
        }
        return t;
      }
    } catch {
      /* generate below */
    }
    const t = crypto.randomBytes(32).toString("hex");
    try {
      writeSecretFile(file, t);
    } catch {
      /* ignore */
    }
    return t;
  }
  return crypto.randomBytes(32).toString("hex");
}

export function readEndpointFile(file) {
  if (!file) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export class AgentDockManager {
  constructor({ dir = "", dataDir = "", endpointFile = "" } = {}) {
    this.dir = String(dir || "").trim();
    this.dataDir = String(dataDir || "").trim();
    this.endpointFile = String(endpointFile || "").trim();
    this.tunnel = null;
    this.service = null;
    this.logSinks = [];
    this.url = "";
    this.lastError = "";
  }

  get exe() {
    return {
      agentdock: path.join(this.dir, "agentdock.exe"),
      cloudflared: path.join(this.dir, "cloudflared.exe"),
    };
  }

  // PIDs we own, kept so a run that never got to clean up (crash, closed
  // console) can still be swept on the next start.
  get pidFile() {
    return path.join(this.dataDir || this.dir, "agentdock-pids.json");
  }

  get logPaths() {
    // One file per child, both streams in it. `legacyTunnelErr` is not written
    // any more — it is listed so a copy left by an older version, which has the
    // unmasked URL in it, is cleared on the next start like the others.
    return {
      tunnel: path.join(this.dir, "tunnel.log"),
      run: path.join(this.dir, "run-public.log"),
      legacyTunnelErr: path.join(this.dir, "tunnel.err.log"),
    };
  }

  installed() {
    try {
      return Boolean(this.dir) && fs.existsSync(this.exe.agentdock) && fs.existsSync(this.exe.cloudflared);
    } catch {
      return false;
    }
  }

  #token() {
    return readOrCreateToken(tokenFilePath(this.dataDir));
  }

  #publish(url, token) {
    if (!this.endpointFile) return;
    const payload = JSON.stringify({ url, token, started: new Date().toISOString() }, null, 2);
    try {
      writeSecretFile(this.endpointFile, payload);
    } catch {
      /* ignore */
    }
  }

  #unpublish() {
    if (!this.endpointFile) return;
    try {
      fs.rmSync(this.endpointFile, { force: true });
    } catch {
      /* ignore */
    }
  }

  async status() {
    const endpoint = readEndpointFile(this.endpointFile);
    return {
      installed: this.installed(),
      dir: this.dir,
      running: Boolean(this.tunnel || this.service) || (await portOpen(8765)),
      servicePortOpen: await portOpen(8765),
      url: endpoint?.url || this.url || "",
      token: endpoint?.token || "",
      bridgeInjecting: Boolean(endpoint?.url && endpoint?.token),
      lastError: this.lastError,
    };
  }

  async start() {
    if (!this.installed()) {
      const msg = `AgentDock not found in ${this.dir || "(unset)"} — set ARENA_AGENTDOCK_DIR`;
      this.lastError = msg;
      throw Object.assign(new Error(msg), { status: 500, code: "agentdock_not_found" });
    }
    if (this.tunnel || this.service) return this.status();

    // Sweep leftovers from a run that never got to clean up before we add ours.
    await this.#stopPids({ persisted: this.#readPersisted() });

    const { agentdock, cloudflared } = this.exe;
    const logs = this.logPaths;
    // Per run, not appended across runs: anything an older version left behind
    // has the unmasked URL in it, and a file that grows forever is not worth
    // keeping either.
    for (const file of [logs.tunnel, logs.run, logs.legacyTunnelErr]) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* ignore */
      }
    }

    // Both child logs go to disk through us, so the public URL is masked on the
    // way out — the acceptance is about what ends up on disk, and both children
    // are handed that URL (one prints it, one gets it as an env var). This is
    // also where the URL is READ from: the line the callback sees is still raw,
    // and only the copy written to the file is masked.
    //
    // The trade: the tunnel still outlives this process (detached), but its log
    // no longer does. Nothing reads the file after we are gone, and the next
    // start clears it — worst case it stops growing.
    let url = "";
    const tunnelLog = openMaskedLog(logs.tunnel, (line) => {
      if (url) return;
      const found = line.match(URL_RE);
      if (found) url = found[0];
    });
    this.logSinks = [tunnelLog];

    // 1) tunnel FIRST — we need its public URL before AgentDock can boot
    //    (AGENTDOCK_SERVER_URL is required or MCP rejects tunnel calls with 403).
    this.tunnel = spawn(
      cloudflared,
      ["tunnel", "--url", "http://127.0.0.1:8765", "--no-autoupdate", "--protocol", "http2"],
      { detached: true, stdio: ["ignore", "pipe", "pipe"] }
    );
    this.tunnel.on("error", (e) => {
      this.lastError = String(e?.message || e);
    });
    // The Node docs are explicit: a child's piped stdio is referenced by this
    // process's event loop, and `child.unref()` alone does not lift that — the
    // pipe handles themselves must be unref'd as well. Otherwise a bridge that
    // wants to exit naturally (tests, graceful shutdown) can be held open by a
    // detached tunnel that outlives it. Unref'd pipes still deliver `data`
    // while the loop runs for other reasons (the HTTP server), so masking and
    // URL discovery are unaffected — see test/agentdock-lifecycle.test.mjs.
    tunnelLog.pump(this.tunnel.stdout);
    tunnelLog.pump(this.tunnel.stderr);
    this.tunnel.stdout.unref?.();
    this.tunnel.stderr.unref?.();
    this.tunnel.unref?.();

    for (let i = 0; i < 60 && !url; i++) await sleep(1000);
    if (!url) {
      await this.stop();
      const msg = "cloudflared did not report a public URL within 60s (see tunnel.log)";
      this.lastError = msg;
      throw Object.assign(new Error(msg), { status: 504, code: "tunnel_timeout" });
    }

    // 2) AgentDock bound to localhost, with the public URL declared
    const token = this.#token();
    const serviceLog = openMaskedLog(logs.run);
    this.logSinks.push(serviceLog);
    this.service = spawn(agentdock, ["-log-level", "info"], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        AGENTDOCK_AUTH_TOKEN: token,
        AGENTDOCK_SERVER_URL: url,
        AGENTDOCK_HOST: "127.0.0.1",
        AGENTDOCK_PORT: "8765",
      },
    });
    this.service.on("error", (e) => {
      this.lastError = String(e?.message || e);
    });
    serviceLog.pump(this.service.stdout);
    serviceLog.pump(this.service.stderr);
    this.service.stdout.unref?.();
    this.service.stderr.unref?.();
    this.service.unref?.();

    this.url = url;
    this.#persistSpawned();
    const mcpUrl = `${url}/mcp`;
    this.#publish(mcpUrl, token);
    // Never log the URL itself: its random subdomain is what makes the tunnel
    // unguessable, so a log line is a credential leak (logs get pasted around).
    log.info("agentdock", "public MCP bridge started", { url: maskTunnelUrl(mcpUrl) });
    return this.status();
  }

  #readPersisted() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.pidFile, "utf8"));
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  #persistSpawned() {
    const records = [
      this.tunnel?.pid && { pid: this.tunnel.pid, exe: this.exe.cloudflared },
      this.service?.pid && { pid: this.service.pid, exe: this.exe.agentdock },
    ].filter(Boolean);
    try {
      // Reusing the secret writer for the atomic .tmp + rename: a half-written
      // file would be read back as a truncated pid list and kill nothing.
      writeSecretFile(this.pidFile, JSON.stringify(records));
    } catch {
      /* ignore */
    }
  }

  #clearPersisted() {
    try {
      fs.rmSync(this.pidFile, { force: true });
    } catch {
      /* ignore */
    }
  }

  async #stopPids({ tracked = [], persisted = [] } = {}) {
    // Only worth asking the OS when there is something from an earlier run to
    // check; our own children need no evidence.
    const paths = persisted.length
      ? parseProcessPathsCsv(await capture("powershell", PROCESS_PATHS_ARGS))
      : {};
    const pids = pidsToStop({ tracked, persisted, paths, selfPid: process.pid });
    for (const pid of pids) await killPid(pid);
    if (pids.length) log.info("agentdock", "stopping tunnel processes", { pids });
    return pids;
  }

  async stop() {
    // Only what we started — never a sweep by image name, which used to take out
    // anyone else's cloudflared along with ours.
    await this.#stopPids({
      tracked: [this.tunnel?.pid, this.service?.pid].filter(Boolean),
      persisted: this.#readPersisted(),
    });
    this.#clearPersisted();
    const sinks = this.logSinks;
    this.logSinks = [];
    await Promise.all(sinks.map((sink) => sink.close()));
    this.tunnel = null;
    this.service = null;
    this.url = "";
    this.#unpublish();
    log.info("agentdock", "public MCP bridge stopped");
    return this.status();
  }
}
