// One concrete lifecycle for our existing Local MCP server. Workspace roots
// come only from explicit startup/configuration, never from project discovery.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createLocalMcpServer } from "./local-mcp.mjs";
import { buildRoots, decidePath } from "./path-guard.mjs";
import { readOrCreateToken, tokenFilePath, readEndpointFile, openMaskedLog, pidsToStop } from "./agentdock.mjs";
import { writeSecretFile } from "./secret.mjs";

const realpath = (p) => fs.realpathSync.native(p);
const failure = (message, status = 400, code = "mcp_invalid_workspace") =>
  Object.assign(new Error(message), { status, code });
const samePath = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

function directory(value) {
  if (typeof value !== "string" || !path.isAbsolute(value.trim())) {
    throw failure("An explicit absolute workspace directory is required (GUI workspace or ARENA_MCP_WORKSPACE)");
  }
  try {
    const resolved = realpath(value.trim());
    if (!fs.statSync(resolved).isDirectory()) throw new Error("not a directory");
    return resolved;
  } catch {
    throw failure("Workspace must be an existing absolute directory");
  }
}

export class LocalMcpRuntime {
  constructor(config) {
    this.config = config;
    this.owner = crypto.randomUUID();
    this.listener = null;
    this.starting = null;
    this.stopping = null;
    this.workspace = "";
    this.localUrl = "";
    this.token = "";
    this.lastError = "";
    this.tunnel = null;
    this.tunnelLog = null;
    this.controller = null;
    this.publicUrl = "";
    this.endpointFile = "";
    this.pidFile = "";
    this.reservationFile = "";
    this.revoked = false;
  }

  status() {
    const running = Boolean(this.listener?.listening) && !this.revoked;
    const published = readEndpointFile(this.endpointFile);
    const injecting = running && Boolean(this.publicUrl) && published?.owner === this.owner && published.url === this.publicUrl;
    return {
      runtime: "local", installed: true, running, servicePortOpen: running,
      workspace: this.workspace, localUrl: running ? this.localUrl : "",
      token: running ? this.token : "", url: injecting ? this.publicUrl : "", bridgeInjecting: injecting,
      transportConfigured: Boolean(this.config.cloudflaredPath), transportRunning: Boolean(this.tunnel),
      cleanupPending: this.revoked,
      lastError: this.lastError,
    };
  }

  async start({ workspace } = {}) {
    if (this.stopping) await this.stopping;
    const selected = directory(workspace || this.workspace || this.config.mcpWorkspace);
    if (this.workspace && !samePath(selected, this.workspace)) {
      throw failure("Local MCP is already authorized for a different workspace; stop it before switching", 409, "mcp_workspace_conflict");
    }
    if (this.starting) return this.starting;
    if (this.listener?.listening && !this.revoked) return this.status();
    if (this.revoked || this.tunnel || this.reservationFile) {
      throw failure("The previous Local MCP transport still needs cleanup; retry stop before starting", 409, "mcp_runtime_conflict");
    }
    let roots;
    try {
      roots = buildRoots(this.config, [selected], { resolve: realpath });
    } catch (error) {
      throw failure(error.message);
    }
    const usable = decidePath({ path: selected, intent: "exec", ...roots }, { resolve: realpath });
    if (!usable.allowed) throw failure(usable.reason);
    this.workspace = selected;
    this.lastError = "";
    this.controller = new AbortController();
    this.starting = this.#start(roots).catch(async (error) => {
      this.lastError = error.message;
      await this.#cleanup();
      throw error;
    }).finally(() => { this.starting = null; });
    return this.starting;
  }

  async #start(roots) {
    const dataDir = path.resolve(this.config.dataDir);
    fs.mkdirSync(dataDir, { recursive: true });
    if (this.config.cloudflaredPath) this.#reserveTransport(dataDir);
    const tokenFile = tokenFilePath(dataDir);
    this.#privateFile(tokenFile, dataDir);
    this.token = readOrCreateToken(tokenFile);
    const listener = createLocalMcpServer({ token: this.token, roots });
    this.listener = listener;
    await new Promise((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(this.config.localMcpPort ?? 8765, "127.0.0.1", () => {
        listener.removeListener("error", reject);
        resolve();
      });
    });
    this.controller.signal.throwIfAborted();
    this.localUrl = `http://127.0.0.1:${listener.address().port}/mcp`;
    if (this.config.cloudflaredPath) await this.#startTransport(dataDir);
    return this.status();
  }

  #privateFile(file, dataDir) {
    const decision = decidePath({ path: file, intent: "write", workspaceRoots: [dataDir] }, { resolve: realpath });
    if (!decision.allowed) throw failure("MCP credential and lifecycle files must remain inside DATA_DIR (including symlink targets)", 400, "mcp_secret_path");
  }

  #reserveTransport(dataDir) {
    const exe = this.config.cloudflaredPath;
    if (!path.isAbsolute(exe) || !fs.existsSync(exe) || !fs.statSync(exe).isFile()) {
      throw failure("ARENA_CLOUDFLARED_PATH must name an existing absolute executable", 400, "mcp_transport_not_found");
    }
    const endpointFile = this.config.mcpEndpointFile;
    if (!endpointFile || !path.isAbsolute(endpointFile)) throw failure("Local MCP public endpoint must be inside DATA_DIR", 400, "mcp_secret_path");
    this.#privateFile(endpointFile, dataDir);
    const pidFile = path.join(dataDir, "local-mcp-pids.json");
    const reservationFile = path.join(dataDir, "local-mcp.lock");
    this.#privateFile(pidFile, dataDir);
    this.#privateFile(reservationFile, dataDir);
    let handle;
    try {
      handle = fs.openSync(reservationFile, "wx", 0o600);
    } catch (error) {
      if (error.code === "EEXIST") throw failure("Another Local MCP transport owns this DATA_DIR reservation", 409, "mcp_runtime_conflict");
      throw error;
    }
    this.reservationFile = reservationFile;
    try { fs.writeFileSync(handle, this.owner); } finally { fs.closeSync(handle); }
    // Even an unreadable or malformed pre-existing file belongs to someone
    // else. Never turn read failure into permission to overwrite it.
    if (fs.existsSync(endpointFile) || fs.existsSync(pidFile)) {
      throw failure("An existing MCP endpoint or process record must be resolved before starting this transport", 409, "mcp_runtime_conflict");
    }
    this.endpointFile = endpointFile;
    this.pidFile = pidFile;
  }

  async #startTransport(dataDir) {
    const { signal } = this.controller;
    let acceptUrl;
    let timer;
    let abort;
    const reportedUrl = new Promise((resolve, reject) => {
      const finish = (error, url) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        error ? reject(error) : resolve(url);
      };
      abort = () => finish(signal.reason);
      acceptUrl = (url) => finish(null, url);
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => this.controller.abort(failure("cloudflared did not report a public URL within 60s", 504, "tunnel_timeout")), 60_000);
      if (signal.aborted) abort();
    });
    this.tunnelLog = openMaskedLog(path.join(dataDir, `local-mcp-${this.owner}.log`), (line) => {
      const url = line.match(/https:\/\/[A-Za-z0-9_-]+\.trycloudflare\.com\b/);
      if (url) acceptUrl(url[0]);
    });
    try {
      signal.throwIfAborted();
      const child = spawn(this.config.cloudflaredPath,
        ["tunnel", "--url", this.localUrl, "--no-autoupdate", "--protocol", "http2"],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      this.tunnel = child;
      const failed = (error) => {
        if (this.tunnel !== child) return;
        this.lastError = error.message;
        this.controller.abort(error);
        if (!this.starting) void this.stop().catch(() => {});
      };
      child.on("error", (error) => failed(failure(`cloudflared failed: ${error.message}`, 502, "tunnel_failed")));
      child.on("exit", (code) => failed(failure(`cloudflared exited (code ${code})`, 502, "tunnel_exited")));
      this.tunnelLog.pump(child.stdout);
      this.tunnelLog.pump(child.stderr);
      child.stdout.unref?.();
      child.stderr.unref?.();
      child.unref?.();
      writeSecretFile(this.pidFile, JSON.stringify({ owner: this.owner, records: [{ pid: child.pid, exe: this.config.cloudflaredPath }] }));
      const url = await reportedUrl;
      signal.throwIfAborted();
      this.publicUrl = `${url}/mcp`;
      writeSecretFile(this.endpointFile, JSON.stringify({
        url: this.publicUrl, token: this.token, started: new Date().toISOString(),
        runtime: "local", workspace: this.workspace, owner: this.owner,
      }, null, 2));
      // Bridge accepts this instance's endpoint only after publication succeeds.
      this.config.mcpOwner = this.owner;
    } catch (error) {
      this.controller.abort(error);
      await reportedUrl.catch(() => {});
      throw error;
    }
  }

  async #cleanup() {
    if (this.config.mcpOwner === this.owner) this.config.mcpOwner = "";
    const listener = this.listener;
    // Revoke tools before trying to kill transport. If the OS refuses the kill,
    // keep this port occupied by a refusal handler: a still-live tunnel must
    // never expose another service that subsequently binds the same port.
    if (listener?.listening) {
      this.revoked = true;
      listener.removeAllListeners("request");
      listener.on("request", (_req, res) => {
        res.writeHead(503, { "Content-Type": "application/json", Connection: "close" });
        res.end(JSON.stringify({ error: "Local MCP access revoked; transport cleanup pending" }));
      });
      listener.closeAllConnections();
    }
    const child = this.tunnel;
    this.tunnel = null;
    let error;
    const removeOwned = (file) => {
      if (readEndpointFile(file)?.owner !== this.owner) return;
      try { fs.rmSync(file, { force: true }); } catch (cause) { error ||= cause; }
    };
    removeOwned(this.endpointFile);
    // Child identity is retained in memory; never sweep another instance's
    // persisted PIDs, image names, or unverifiable recycled PIDs.
    if (child?.exitCode === null && child.signalCode === null && pidsToStop({ tracked: [child.pid], selfPid: process.pid }).includes(child.pid)) {
      try {
        await new Promise((resolve, reject) => {
          const done = () => { clearTimeout(timer); resolve(); };
          const timer = setTimeout(() => {
            child.removeListener("exit", done);
            reject(new Error("cloudflared did not exit after stop"));
          }, 5_000);
          child.once("exit", done);
          try {
            const sent = child.kill("SIGKILL");
            if (!sent && (child.exitCode !== null || child.signalCode !== null)) done();
          } catch (cause) {
            clearTimeout(timer);
            child.removeListener("exit", done);
            reject(cause);
          }
        });
      } catch (cause) {
        error ||= cause;
        this.tunnel = child; // retain actual child identity for a later stop
      }
    }
    child?.stdout.destroy();
    child?.stderr.destroy();
    if (this.tunnelLog) await this.tunnelLog.close();
    this.tunnelLog = null;
    if (listener?.listening && !this.tunnel) {
      await new Promise((resolve) => {
        listener.close(resolve);
        listener.closeAllConnections();
      });
    }
    if (!this.tunnel) {
      this.listener = null;
      this.revoked = false;
    }
    this.localUrl = "";
    this.workspace = "";
    this.token = "";
    this.publicUrl = "";
    if (!this.tunnel) removeOwned(this.pidFile);
    if (this.reservationFile && !error) {
      try {
        if (fs.readFileSync(this.reservationFile, "utf8") === this.owner) fs.rmSync(this.reservationFile);
      } catch (cause) { if (cause.code !== "ENOENT") error ||= cause; }
    }
    if (error) {
      this.revoked = true;
      this.lastError = error.message;
      throw error;
    }
    this.endpointFile = "";
    this.pidFile = "";
    this.reservationFile = "";
  }

  async stop() {
    if (this.stopping) return this.stopping;
    this.controller?.abort(failure("Local MCP startup cancelled by stop", 409, "mcp_start_cancelled"));
    this.stopping = (async () => {
      await this.starting?.catch(() => {});
      await this.#cleanup();
      return this.status();
    })().finally(() => { this.stopping = null; });
    return this.stopping;
  }
}
