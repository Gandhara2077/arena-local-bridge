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

const URL_RE = /https:\/\/[A-Za-z0-9._-]+\.trycloudflare\.com/;

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

// The two processes this module owns. A PID read back from an earlier run is
// only ours if the process still answers to one of these names.
const OUR_IMAGES = new Set(["cloudflared.exe", "agentdock.exe"]);

function killPid(pid) {
  return new Promise((resolve) => {
    execFile("taskkill", ["/F", "/PID", String(pid)], () => resolve());
  });
}

// `tasklist /FO CSV /NH` → { pid: "image.name" }. Pure, so the deciding rule can
// be tested without spawning anything.
export function parseTasklistCsv(csv) {
  const names = {};
  for (const line of String(csv || "").split(/\r?\n/)) {
    const m = line.match(/^"([^"]+)","(\d+)"/);
    if (!m) continue; // header row, blank line, "INFO:" notice
    const pid = Number(m[2]);
    if (Number.isSafeInteger(pid)) names[String(pid)] = m[1].toLowerCase();
  }
  return names;
}

// Which PIDs may we stop?
//   tracked   — spawned by THIS process, ours by construction
//   persisted — left over from an earlier run; a recycled PID can belong to
//               anything, so it only qualifies while its image name is one of ours
function capture(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true }, (error, stdout) => resolve(error ? "" : String(stdout || "")));
  });
}

export function pidsToStop({ tracked = [], persisted = [], names = {}, selfPid = 0 } = {}) {
  const out = [];
  for (const pid of [...tracked, ...persisted]) {
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === selfPid) continue;
    if (out.includes(pid)) continue;
    const ours = tracked.includes(pid) || OUR_IMAGES.has(String(names[String(pid)] || "").toLowerCase());
    if (ours) out.push(pid);
  }
  return out;
}

export class AgentDockManager {
  constructor({ dir = "", dataDir = "", endpointFile = "" } = {}) {
    this.dir = String(dir || "").trim();
    this.dataDir = String(dataDir || "").trim();
    this.endpointFile = String(endpointFile || "").trim();
    this.tunnel = null;
    this.service = null;
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
    return {
      tunnel: path.join(this.dir, "tunnel.log"),
      tunnelErr: path.join(this.dir, "tunnel.err.log"),
      run: path.join(this.dir, "run-public.log"),
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
    const file = path.join(this.dir, "auth-token.txt");
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

  #publish(url, token) {
    const payload = JSON.stringify({ url, token, started: new Date().toISOString() }, null, 2);
    const targets = [path.join(this.dir, "mcp-endpoint.json"), this.endpointFile].filter(Boolean);
    for (const t of targets) {
      try {
        writeSecretFile(t, payload);
      } catch {
        /* ignore */
      }
    }
  }

  #unpublish() {
    const targets = [path.join(this.dir, "mcp-endpoint.json"), this.endpointFile].filter(Boolean);
    for (const t of targets) {
      try {
        fs.rmSync(t, { force: true });
      } catch {
        /* ignore */
      }
    }
  }

  async status() {
    const endpoint = (() => {
      try {
        return JSON.parse(fs.readFileSync(this.endpointFile || path.join(this.dir, "mcp-endpoint.json"), "utf8"));
      } catch {
        return null;
      }
    })();
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
    await this.#stopPids({ persisted: this.#readPersistedPids() });

    const { agentdock, cloudflared } = this.exe;
    const logs = this.logPaths;
    for (const p of [logs.tunnel, logs.tunnelErr]) {
      try {
        fs.rmSync(p, { force: true });
      } catch {
        /* ignore */
      }
    }
    const outFd = fs.openSync(logs.tunnel, "a");

    // 1) tunnel FIRST — we need its public URL before AgentDock can boot
    //    (AGENTDOCK_SERVER_URL is required or MCP rejects tunnel calls with 403).
    this.tunnel = spawn(
      cloudflared,
      ["tunnel", "--url", "http://127.0.0.1:8765", "--no-autoupdate", "--protocol", "http2"],
      { detached: true, stdio: ["ignore", outFd, outFd] }
    );
    this.tunnel.on("error", (e) => {
      this.lastError = String(e?.message || e);
    });
    this.tunnel.unref?.();

    let url = "";
    for (let i = 0; i < 60 && !url; i++) {
      await sleep(1000);
      for (const p of [logs.tunnel, logs.tunnelErr]) {
        try {
          const m = fs.readFileSync(p, "utf8").match(URL_RE);
          if (m) {
            url = m[0];
            break;
          }
        } catch {
          /* not created yet */
        }
      }
    }
    if (!url) {
      await this.stop();
      const msg = "cloudflared did not report a public URL within 60s (see tunnel.log)";
      this.lastError = msg;
      throw Object.assign(new Error(msg), { status: 504, code: "tunnel_timeout" });
    }

    // 2) AgentDock bound to localhost, with the public URL declared
    const token = this.#token();
    const runFd = fs.openSync(logs.run, "a");
    this.service = spawn(agentdock, ["-log-level", "info"], {
      detached: true,
      stdio: ["ignore", runFd, runFd],
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
    this.service.unref?.();

    this.url = url;
    try {
      fs.writeFileSync(this.pidFile, JSON.stringify([this.tunnel?.pid, this.service?.pid].filter(Boolean)));
    } catch {
      /* ignore */
    }
    const mcpUrl = `${url}/mcp`;
    this.#publish(mcpUrl, token);
    // Never log the URL itself: its random subdomain is what makes the tunnel
    // unguessable, so a log line is a credential leak (logs get pasted around).
    log.info("agentdock", "public MCP bridge started", { url: maskTunnelUrl(mcpUrl) });
    return this.status();
  }

  #readPersistedPids() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.pidFile, "utf8"));
      return Array.isArray(raw) ? raw.filter((pid) => Number.isSafeInteger(pid)) : [];
    } catch {
      return [];
    }
  }

  #clearPersistedPids() {
    try {
      fs.rmSync(this.pidFile, { force: true });
    } catch {
      /* ignore */
    }
  }

  async #stopPids({ tracked = [], persisted = [] } = {}) {
    const names = parseTasklistCsv(await capture("tasklist", ["/FO", "CSV", "/NH"]));
    const pids = pidsToStop({ tracked, persisted, names, selfPid: process.pid });
    for (const pid of pids) await killPid(pid);
    if (pids.length) log.info("agentdock", "stopping tunnel processes", { pids });
    return pids;
  }

  async stop() {
    // Only what we started — never a sweep by image name, which used to take out
    // anyone else's cloudflared along with ours.
    await this.#stopPids({
      tracked: [this.tunnel?.pid, this.service?.pid].filter(Boolean),
      persisted: this.#readPersistedPids(),
    });
    this.#clearPersistedPids();
    this.tunnel = null;
    this.service = null;
    this.url = "";
    this.#unpublish();
    log.info("agentdock", "public MCP bridge stopped");
    return this.status();
  }
}
