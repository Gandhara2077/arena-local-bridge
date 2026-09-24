// agentdock.mjs — manages the local AgentDock MCP server + its public tunnel so
// the Arena cloud agent can reach this machine. Driven by the GUI (§4.26).
//   start(): token -> cloudflared quick tunnel -> publish endpoint -> AgentDock
//   stop():  kill both, remove the endpoint file (bridge then stops injecting)
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import crypto from "node:crypto";
import { log } from "./util.mjs";

const URL_RE = /https:\/\/[A-Za-z0-9._-]+\.trycloudflare\.com/;

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

function killPid(pid) {
  return new Promise((resolve) => {
    execFile("taskkill", ["/F", "/PID", String(pid)], () => resolve());
  });
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
      if (t) return t;
    } catch {
      /* generate below */
    }
    const t = crypto.randomBytes(32).toString("hex");
    try {
      fs.writeFileSync(file, t);
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
        fs.writeFileSync(t, payload);
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
    const mcpUrl = `${url}/mcp`;
    this.#publish(mcpUrl, token);
    log.info("agentdock", "public MCP bridge started", { url: mcpUrl });
    return this.status();
  }

  async stop() {
    const pids = [this.tunnel?.pid, this.service?.pid].filter(Boolean);
    for (const pid of pids) await killPid(pid);
    // Belt and braces: catch anything started outside this process.
    await new Promise((resolve) =>
      execFile("taskkill", ["/F", "/IM", "cloudflared.exe"], () => resolve())
    );
    await new Promise((resolve) =>
      execFile("taskkill", ["/F", "/IM", "agentdock.exe"], () => resolve())
    );
    this.tunnel = null;
    this.service = null;
    this.url = "";
    this.#unpublish();
    log.info("agentdock", "public MCP bridge stopped");
    return this.status();
  }
}
