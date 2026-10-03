// Only child_process is doubled. The runtime, protected files, bridge and HTTP
// endpoints are real; no executable or public tunnel is launched.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { LocalMcpRuntime } from "../src/local-mcp-runtime.mjs";
import { createServer } from "../src/server.mjs";
import { Bridge } from "../src/bridge.mjs";
import { httpRequest, waitFor, SESSION_ID } from "./e2e/helper.mjs";

function setup(t, mode = "url") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-transport-"));
  const dataDir = path.join(dir, "data");
  const workspace = path.join(dir, "workspace");
  fs.mkdirSync(dataDir);
  fs.mkdirSync(workspace);
  const cloudflaredPath = path.join(dir, "cloudflared.exe");
  fs.writeFileSync(cloudflaredPath, "synthetic executable placeholder");
  const children = [];
  const original = childProcess.spawn;
  childProcess.spawn = (exe, args, options) => {
    assert.equal(exe, cloudflaredPath);
    assert.ok(args.includes("--no-autoupdate"));
    assert.match(args[args.indexOf("--url") + 1], /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    assert.equal(options.windowsHide, true);
    assert.equal(options.shell, undefined);
    const child = new EventEmitter();
    Object.assign(child, { pid: 41234 + children.length, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough(), killed: false });
    child.unref = () => {};
    child.kill = () => {
      child.killed = true;
      child.signalCode = "SIGKILL";
      child.emit("exit", null, "SIGKILL");
      return true;
    };
    children.push(child);
    setImmediate(() => {
      if (mode === "error") child.emit("error", new Error("synthetic spawn failure"));
      else if (mode === "exit") { child.exitCode = 7; child.emit("exit", 7); }
      else if (mode === "url") {
        child.stderr.write("public https://synthetic-sec");
        child.stderr.write("ret.trycloudflare.com\n");
      }
    });
    return child;
  };
  syncBuiltinESMExports();
  const config = {
    dataDir, mcpRuntime: "local", localMcpPort: 0, cloudflaredPath, mcpWorkspace: "",
    mcpEndpointFile: path.join(dataDir, "mcp-endpoint.json"), skillRoots: [],
    host: "127.0.0.1", port: 0, bridgeKey: "synthetic-bridge-key", rateLimitRpm: 10000,
    codexSessionsDir: path.join(dir, "no-transcripts"), codexRecentWindowMs: 0,
    archiveDir: "", arenaSessions: SESSION_ID, maxQueue: 8, maxToolCalls: 8,
    turnMarkerEnabled: false, readBudgetMs: 0, readRetryMax: 0, resultCacheTtlMs: 0, toolPolicy: "block",
  };
  const runtime = new LocalMcpRuntime(config);
  const cleanup = [];
  t.after(async () => {
    for (const close of cleanup) await close();
    await runtime.stop();
    childProcess.spawn = original;
    syncBuiltinESMExports();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, workspace, config, runtime, children, cleanup };
}

test("GUI start -> owned publication -> reinject -> real chat turn uses the selected workspace without config/headers/Codex", async (t) => {
  const { config, workspace, children, cleanup } = setup(t);
  const account = { email: "synthetic@test.local" };
  const bridge = new Bridge({ config, credentials: { list: () => [account], primary: () => account, forSession: () => account }, recaptcha: {} });
  bridge.browser = { withAccount: async (_account, fn) => fn(), getPage: async () => ({}) };
  const sent = [];
  bridge.appendAgentMessage = async (_page, _state, prompt) => sent.push(prompt);
  bridge.readLatestTurn = async () => ({ text: "synthetic response", nativeCalls: [], turns: [], timing: {} });
  const server = createServer({ bridge, config });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => { await server.stopMcp(); await new Promise((resolve) => server.close(resolve)); });
  const request = (reqPath, body) => httpRequest(server.address().port, { method: "POST", reqPath, headers: { Authorization: `Bearer ${config.bridgeKey}` }, body });
  const start = await request("/api/mcp/start", { workspace });
  assert.equal(start.status, 200, start.text);
  assert.equal(start.json.runtime, "local");
  assert.equal(start.json.bridgeInjecting, true);
  assert.equal(start.json.transportRunning, true);
  assert.equal(start.json.url, "https://synthetic-secret.trycloudflare.com/mcp");
  const publication = JSON.parse(fs.readFileSync(config.mcpEndpointFile, "utf8"));
  assert.equal(publication.workspace, fs.realpathSync.native(workspace));
  assert.equal(publication.owner, config.mcpOwner);
  const reinject = await request("/api/mcp/reinject", {});
  assert.equal(reinject.status, 200, reinject.text);
  assert.equal(reinject.json.pending, true);
  assert.equal(reinject.json.workspaceFrom, "local-runtime");
  assert.equal((await request("/v1/chat/completions", { model: SESSION_ID, messages: [{ role: "user", content: "hello" }] })).status, 200);
  assert.ok(sent[0].includes(publication.workspace));
  assert.ok(sent[0].includes(start.json.url));
  const conflict = await request("/api/mcp/reinject", { workspace: config.dataDir });
  assert.equal(conflict.status, 409, conflict.text);
  const chatConflict = await httpRequest(server.address().port, {
    method: "POST", reqPath: "/v1/chat/completions", headers: { Authorization: `Bearer ${config.bridgeKey}`, "x-arena-workspace": config.dataDir },
    body: { model: SESSION_ID, messages: [{ role: "user", content: "another workspace" }] },
  });
  assert.equal(chatConflict.status, 409, chatConflict.text);
  assert.equal(sent.length, 1);
  await request("/api/mcp/stop", {});
  assert.equal(children[0].killed, true);
  assert.equal(fs.existsSync(config.mcpEndpointFile), false);
  assert.equal(fs.existsSync(path.join(config.dataDir, "local-mcp-pids.json")), false);
  const logs = fs.readdirSync(config.dataDir).filter((name) => name.endsWith(".log"));
  assert.equal(logs.length, 1);
  const logText = fs.readFileSync(path.join(config.dataDir, logs[0]), "utf8");
  assert.ok(logText.includes("https://***.trycloudflare.com"));
  assert.ok(!logText.includes("synthetic-secret"));
});

for (const mode of ["error", "exit"]) test(`transport ${mode} rolls back the listener and only owned records`, async (t) => {
  const { config, workspace, runtime, children } = setup(t, mode);
  await assert.rejects(runtime.start({ workspace }), /cloudflared|synthetic spawn failure/);
  assert.equal(runtime.status().running, false);
  assert.equal(fs.existsSync(config.mcpEndpointFile), false);
  assert.equal(fs.existsSync(path.join(config.dataDir, "local-mcp-pids.json")), false);
  assert.equal(children.length, 1);
});

test("stop cancels startup before a URL and unexpected tunnel exit revokes the endpoint and listener", async (t) => {
  const { workspace, runtime, config, children } = setup(t, "silent");
  const pending = runtime.start({ workspace });
  const rejected = assert.rejects(pending, /cancelled/);
  await waitFor(() => children.length === 1);
  await runtime.stop();
  await rejected;
  assert.equal(runtime.status().running, false);
  const again = runtime.start({ workspace });
  await waitFor(() => children.length === 2);
  children[1].stdout.write("https://synthetic-secret.trycloudflare.com\n");
  await again;
  children[1].exitCode = 9;
  children[1].emit("exit", 9);
  await waitFor(() => !runtime.status().running);
  assert.equal(fs.existsSync(config.mcpEndpointFile), false);
  assert.match(runtime.status().lastError, /cloudflared exited/);
});

test("foreign endpoint, PID record and concurrent instance reservations are never overwritten or removed", async (t) => {
  const { config, workspace, runtime, children, cleanup } = setup(t);
  const foreign = JSON.stringify({ owner: "foreign", url: "https://legacy.example", token: "legacy" });
  fs.writeFileSync(config.mcpEndpointFile, foreign);
  await assert.rejects(runtime.start({ workspace }), { status: 409 });
  await runtime.stop();
  assert.equal(fs.readFileSync(config.mcpEndpointFile, "utf8"), foreign);
  assert.equal(children.length, 0);
  fs.rmSync(config.mcpEndpointFile);
  const pidFile = path.join(config.dataDir, "local-mcp-pids.json");
  fs.writeFileSync(pidFile, foreign);
  await assert.rejects(runtime.start({ workspace }), { status: 409 });
  assert.equal(fs.readFileSync(pidFile, "utf8"), foreign);
  fs.rmSync(pidFile);
  const other = new LocalMcpRuntime({ ...config, localMcpPort: 0 });
  cleanup.push(() => other.stop());
  const starts = await Promise.allSettled([runtime.start({ workspace }), other.start({ workspace })]);
  assert.equal(starts.filter((r) => r.status === "fulfilled").length, 1);
  const winner = starts[0].status === "fulfilled" ? runtime : other;
  const loser = winner === runtime ? other : runtime;
  const record = fs.readFileSync(config.mcpEndpointFile, "utf8");
  await loser.stop();
  assert.equal(fs.readFileSync(config.mcpEndpointFile, "utf8"), record);
  await winner.stop();
});

for (const record of ["endpoint", "PID"]) test(`first ${record} publication preserves a foreign record created during startup`, async (t) => {
  const { config, workspace, runtime, children } = setup(t, "silent");
  const target = record === "endpoint" ? config.mcpEndpointFile : path.join(config.dataDir, "local-mcp-pids.json");
  const foreign = JSON.stringify({ owner: "foreign", url: "https://legacy.example", token: "legacy", records: [] });
  const pending = runtime.start({ workspace });
  const rejected = assert.rejects(pending, { code: "EEXIST" });
  // PID publication follows the listener's async listen callback; endpoint
  // publication follows the child's async URL report. Exercise both windows.
  if (record === "endpoint") await waitFor(() => children.length === 1);
  fs.writeFileSync(target, foreign);
  await waitFor(() => children.length === 1);
  children[0].stdout.write("https://synthetic-secret.trycloudflare.com\n");
  await rejected;
  assert.equal(fs.readFileSync(target, "utf8"), foreign);
  assert.equal(children[0].killed, true);
  assert.equal(runtime.status().running, false);
  assert.equal(config.mcpOwner, undefined);
  assert.equal(fs.existsSync(path.join(config.dataDir, "local-mcp.lock")), false);
  assert.deepEqual(fs.readdirSync(config.dataDir).filter((name) => name.endsWith(".tmp")), []);
});

test("transport configuration and secret paths fail closed before spawning", async (t) => {
  const { config, workspace, runtime, children, dir } = setup(t);
  config.cloudflaredPath = "cloudflared.exe";
  await assert.rejects(runtime.start({ workspace }), { status: 400 });
  config.cloudflaredPath = path.join(dir, "absent.exe");
  await assert.rejects(runtime.start({ workspace }), { status: 400 });
  config.cloudflaredPath = path.join(dir, "cloudflared.exe");
  config.mcpEndpointFile = path.join(workspace, "exposed-endpoint.json");
  await assert.rejects(runtime.start({ workspace }), { status: 400 });
  assert.equal(children.length, 0);
  assert.equal(runtime.status().running, false);
});

test("a failed child stop revokes access but retains ownership records for a safe retry", async (t) => {
  const { config, workspace, runtime, children, cleanup } = setup(t);
  const state = await runtime.start({ workspace });
  const child = children[0];
  const kill = child.kill;
  cleanup.push(() => { child.kill = kill; });
  child.kill = () => { throw new Error("synthetic kill failure"); };
  await assert.rejects(runtime.stop(), /synthetic kill failure/);
  assert.equal(runtime.status().running, false);
  assert.equal(runtime.status().bridgeInjecting, false);
  assert.equal(runtime.status().cleanupPending, true);
  assert.equal(runtime.status().localUrl, "");
  assert.equal(config.mcpOwner, "");
  assert.equal(fs.existsSync(config.mcpEndpointFile), false);
  assert.equal(fs.existsSync(path.join(config.dataDir, "local-mcp-pids.json")), true);
  assert.equal(fs.existsSync(path.join(config.dataDir, "local-mcp.lock")), true);
  const port = Number(new URL(state.localUrl).port);
  const contender = http.createServer();
  cleanup.push(() => new Promise((resolve) => contender.close(resolve)));
  await assert.rejects(new Promise((resolve, reject) => {
    contender.once("error", reject);
    contender.listen(port, "127.0.0.1", resolve);
  }), { code: "EADDRINUSE" });
  const denied = await httpRequest(port, {
    method: "POST", reqPath: "/mcp", headers: { Authorization: `Bearer ${state.token}` },
    body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  });
  assert.equal(denied.status, 503, denied.text);
  assert.equal(denied.json.result, undefined);
  await assert.rejects(runtime.start({ workspace }), { status: 409 });
  child.kill = kill;
  await runtime.stop();
  assert.equal(child.killed, true);
  assert.equal(runtime.status().cleanupPending, false);
  assert.equal(fs.existsSync(path.join(config.dataDir, "local-mcp-pids.json")), false);
  await new Promise((resolve, reject) => {
    contender.once("error", reject);
    contender.listen(port, "127.0.0.1", resolve);
  });
});

test("kill returning false without an exit signal does not release transport ownership or its port", async (t) => {
  const { config, workspace, runtime, children, cleanup } = setup(t);
  const state = await runtime.start({ workspace });
  const child = children[0];
  const kill = child.kill;
  cleanup.push(() => { child.kill = kill; });
  child.kill = () => false;
  await assert.rejects(runtime.stop(), /did not exit after stop/);
  assert.equal(runtime.status().transportRunning, true);
  assert.equal(fs.existsSync(path.join(config.dataDir, "local-mcp-pids.json")), true);
  assert.equal((await httpRequest(Number(new URL(state.localUrl).port))).status, 503);
  child.kill = kill;
  await runtime.stop();
  assert.equal(child.killed, true);
});

test("a credential path through a junction outside DATA_DIR is refused without touching the target", async (t) => {
  const { config, workspace, runtime, children } = setup(t);
  const link = path.join(config.dataDir, "escape");
  fs.symlinkSync(workspace, link, process.platform === "win32" ? "junction" : "dir");
  const outside = path.join(workspace, "endpoint.json");
  const contents = "untouched target";
  fs.writeFileSync(outside, contents);
  config.mcpEndpointFile = path.join(link, "endpoint.json");
  await assert.rejects(runtime.start({ workspace }), { status: 400, code: "mcp_secret_path" });
  assert.equal(children.length, 0);
  assert.equal(fs.readFileSync(outside, "utf8"), contents);
});

test("automatic shutdown rejects a start already queued behind an ordinary stop", async (t) => {
  const { config, workspace, children, cleanup } = setup(t);
  const account = { email: "synthetic@test.local" };
  const bridge = new Bridge({ config, credentials: { list: () => [account], primary: () => account, forSession: () => account }, recaptcha: {} });
  const server = createServer({ bridge, config });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => { await server.stopMcp(); await new Promise((resolve) => server.close(resolve)); });
  const request = (reqPath, body) => httpRequest(server.address().port, { method: "POST", reqPath, headers: { Authorization: `Bearer ${config.bridgeKey}` }, body });
  const started = await request("/api/mcp/start", { workspace });
  assert.equal(started.status, 200, started.text);
  const child = children[0];
  const kill = child.kill;
  cleanup.unshift(() => { child.kill = kill; });
  let killing = false;
  child.kill = () => { killing = true; return true; };
  const stopping = request("/api/mcp/stop", {});
  await waitFor(() => killing);
  const received = new Promise((resolve) => server.once("request", (req) => req.once("end", resolve)));
  const queued = request("/api/mcp/start", { workspace });
  await received;
  // Let readBody's continuation enter runtime.start while stop is still pending.
  await new Promise((resolve) => setImmediate(resolve));
  const shutdown = server.stopMcp();
  child.signalCode = "SIGKILL";
  child.emit("exit", null, "SIGKILL");
  await shutdown;
  assert.equal((await stopping).status, 200);
  const response = await queued;
  assert.equal(response.status, 409, response.text);
  assert.equal(response.json.error.code, "mcp_shutdown");
  assert.equal(children.length, 1);
  assert.equal((await request("/api/mcp/start", { workspace })).status, 409);
  const status = await httpRequest(server.address().port, { reqPath: "/api/mcp/status", headers: { Authorization: `Bearer ${config.bridgeKey}` } });
  assert.equal(status.json.running, false);
  await assert.rejects(httpRequest(Number(new URL(started.json.localUrl).port)), /ECONNREFUSED|socket hang up/);
});
