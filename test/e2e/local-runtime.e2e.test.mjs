// Ticket 19: the GUI/API starts our real MCP listener without AgentDock.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { loadConfig } from "../../src/config.mjs";
import { startE2E, httpRequest, authHeaders } from "./helper.mjs";

test("Local MCP is the default; legacy runtime and transport require explicit configuration", () => {
  const config = loadConfig({}, { requireBridgeKey: false });
  assert.equal(config.mcpRuntime, "local");
  assert.equal(config.agentdockDir, "");
  assert.equal(config.cloudflaredPath, "");
  assert.equal(config.localMcpPort, 8765);
  assert.equal(loadConfig({ ARENA_MCP_RUNTIME: "agentdock" }, { requireBridgeKey: false }).mcpRuntime, "agentdock");
  assert.equal(loadConfig({ ARENA_LOCAL_MCP_PORT: "0" }, { requireBridgeKey: false }).localMcpPort, 0);
  for (const env of [{ ARENA_MCP_RUNTIME: "other" }, { ARENA_LOCAL_MCP_PORT: "1.5" }, { ARENA_LOCAL_MCP_PORT: "65536" }, { ARENA_CLOUDFLARED_PATH: "cloudflared.exe" }]) {
    assert.throws(() => loadConfig(env, { requireBridgeKey: false }));
  }
});

async function fixture(t, config = {}) {
  const ep = await startE2E({ config: { localMcpPort: 0, skillRoots: [], ...config } });
  t.after(async () => {
    await api(ep, "/api/mcp/stop");
    await ep.close();
    fs.rmSync(path.dirname(ep.config.dataDir), { recursive: true, force: true });
  });
  return ep;
}

function api(ep, reqPath, body = {}) {
  return httpRequest(ep.port, { method: "POST", reqPath, headers: authHeaders(), body });
}

function rpc(state, method, params, headers = {}) {
  const url = new URL(state.localUrl);
  return httpRequest(Number(url.port), {
    method: "POST", reqPath: url.pathname,
    headers: { Authorization: `Bearer ${state.token}`, ...headers },
    body: { jsonrpc: "2.0", id: 1, method, params },
  });
}

const tool = async (state, name, args) => (await rpc(state, "tools/call", { name, arguments: args })).json.result;
const text = (result) => result.content.map((entry) => entry.text).join("\n");

test("GUI startup body grants one explicit workspace and all six tools work over authenticated loopback HTTP", async (t) => {
  const ep = await fixture(t);
  const workspace = path.dirname(ep.config.dataDir);
  const skills = fs.mkdtempSync(path.join(path.dirname(workspace), "runtime-skills-"));
  t.after(() => fs.rmSync(skills, { recursive: true, force: true }));
  ep.config.skillRoots = [skills];
  const source = path.join(workspace, "hello.txt");
  const skillFile = path.join(skills, "SKILL.md");
  fs.writeFileSync(source, "hello runtime\n");
  fs.writeFileSync(skillFile, "read-only skill\n");
  fs.writeFileSync(path.join(ep.config.dataDir, "private.txt"), "private contents");

  const status = await httpRequest(ep.port, { reqPath: "/api/mcp/status", headers: authHeaders() });
  assert.equal(status.json.runtime, "local");
  assert.equal(status.json.installed, true);
  assert.equal(status.json.running, false);
  const response = await api(ep, "/api/mcp/start", { workspace });
  assert.equal(response.status, 200, response.text);
  const state = response.json;
  assert.equal(state.workspace, fs.realpathSync.native(workspace));
  assert.match(state.localUrl, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  assert.equal(state.running, true);
  assert.equal(state.servicePortOpen, true);
  assert.equal(state.bridgeInjecting, false);
  assert.equal(state.url, "", "loopback must never be published as Arena reachable");
  assert.equal(fs.existsSync(ep.config.mcpEndpointFile), false);
  assert.equal((await rpc(state, "initialize")).json.result.serverInfo.name, "arena-local-bridge");
  assert.deepEqual((await rpc(state, "tools/list")).json.result.tools.map((entry) => entry.name).sort(),
    ["exec_command", "file_edit", "file_publish", "list_dir", "read_file", "search_text"]);
  assert.match(text(await tool(state, "read_file", { path: source })), /hello runtime/);
  assert.match(text(await tool(state, "list_dir", { path: workspace })), /hello\.txt/);
  assert.match(text(await tool(state, "search_text", { path: workspace, query: "hello runtime" })), /hello runtime/);
  const edited = path.join(workspace, "created.txt");
  assert.equal((await tool(state, "file_edit", { action: "add", path: edited, content: "created" })).isError, undefined);
  assert.equal(fs.readFileSync(edited, "utf8"), "created");
  const executed = await tool(state, "exec_command", { cmd: `"${process.execPath}" -e "console.log(process.cwd())"` });
  assert.equal(executed.isError, undefined, text(executed));
  // Windows may expand the temporary directory's short user name in cwd.
  assert.equal(fs.realpathSync.native(text(executed).split(/\r?\n/)[0]), state.workspace);
  const published = await tool(state, "file_publish", { path: edited });
  assert.equal(published.isError, undefined, text(published));
  assert.equal(fs.readFileSync(text(published).replace(/^published to /, ""), "utf8"), "created");
  assert.match(text(await tool(state, "read_file", { path: skillFile })), /read-only skill/);
  for (const [name, args] of [
    ["file_edit", { action: "replace", path: skillFile, old: "skill", new: "changed" }],
    ["exec_command", { cmd: "echo harmless", workdir: skills }],
    ["read_file", { path: path.join(ep.config.dataDir, "private.txt") }],
    ["read_file", { path: path.join(path.dirname(workspace), "outside.txt") }],
  ]) assert.equal((await tool(state, name, args)).isError, true, `${name} should be denied`);
  assert.equal((await rpc(state, "tools/list", {}, { Authorization: "Bearer incorrect" })).status, 401);
  assert.equal((await rpc(state, "tools/list", {}, { Origin: "http://localhost" })).status, 403);
  const stopped = await api(ep, "/api/mcp/stop");
  assert.equal(stopped.json.running, false);
  await assert.rejects(rpc(state, "tools/list"), /ECONNREFUSED|socket hang up/);
});

test("repeated/concurrent starts share the selected workspace and conflicting starts are 409", async (t) => {
  const ep = await fixture(t);
  const workspace = path.dirname(ep.config.dataDir);
  const other = path.join(workspace, "other");
  fs.mkdirSync(other);
  const starts = await Promise.all([api(ep, "/api/mcp/start", { workspace }), api(ep, "/api/mcp/start", { workspace })]);
  for (const result of starts) assert.equal(result.status, 200, result.text);
  assert.equal(starts[0].json.localUrl, starts[1].json.localUrl);
  const again = await api(ep, "/api/mcp/start");
  assert.equal(again.status, 200);
  assert.equal(again.json.workspace, starts[0].json.workspace);
  const conflict = await api(ep, "/api/mcp/start", { workspace: other });
  assert.equal(conflict.status, 409, conflict.text);
  assert.equal(conflict.json.error.code, "mcp_workspace_conflict");
});

test("missing/invalid workspace and overlapping skills fail before a listener is granted", async (t) => {
  const ep = await fixture(t);
  for (const body of [{}, { workspace: "relative" }, { workspace: path.join(ep.config.dataDir, "missing") }, { workspace: ep.config.mcpEndpointFile }]) {
    assert.equal((await api(ep, "/api/mcp/start", body)).status, 400);
  }
  ep.config.skillRoots = [path.dirname(ep.config.dataDir)];
  assert.equal((await api(ep, "/api/mcp/start", { workspace: path.dirname(ep.config.dataDir) })).status, 400);
  assert.equal((await httpRequest(ep.port, { reqPath: "/api/mcp/status", headers: authHeaders() })).json.running, false);
});

test("local start and stop preserve foreign/legacy endpoint and process records", async (t) => {
  const ep = await fixture(t);
  const endpoint = JSON.stringify({ url: "https://legacy.trycloudflare.com/mcp", token: "legacy" });
  const pids = JSON.stringify({ owner: "another-instance", records: [{ pid: process.pid, exe: process.execPath }] });
  const pidFile = path.join(ep.config.dataDir, "local-mcp-pids.json");
  fs.writeFileSync(ep.config.mcpEndpointFile, endpoint);
  fs.writeFileSync(pidFile, pids);
  assert.equal((await api(ep, "/api/mcp/start", { workspace: path.dirname(ep.config.dataDir) })).status, 200);
  await api(ep, "/api/mcp/stop");
  assert.equal(fs.readFileSync(ep.config.mcpEndpointFile, "utf8"), endpoint);
  assert.equal(fs.readFileSync(pidFile, "utf8"), pids);
});

test("HTTP server shutdown preserves unmanaged legacy records in explicitly selected compatibility mode", async () => {
  const ep = await startE2E({ config: { mcpRuntime: "agentdock" } });
  const endpoint = JSON.stringify({ url: "https://legacy.trycloudflare.com/mcp", token: "legacy" });
  const pidFile = path.join(ep.config.dataDir, "agentdock-pids.json");
  fs.writeFileSync(ep.config.mcpEndpointFile, endpoint);
  fs.writeFileSync(pidFile, "[]");
  try {
    await ep.close();
    assert.equal(fs.readFileSync(ep.config.mcpEndpointFile, "utf8"), endpoint);
    assert.equal(fs.readFileSync(pidFile, "utf8"), "[]");
  } finally {
    fs.rmSync(path.dirname(ep.config.dataDir), { recursive: true, force: true });
  }
});

test("closing the HTTP server closes its owned local listener", async () => {
  const ep = await startE2E({ config: { localMcpPort: 0, skillRoots: [] } });
  try {
    const response = await api(ep, "/api/mcp/start", { workspace: path.dirname(ep.config.dataDir) });
    assert.equal(response.status, 200, response.text);
    await ep.close();
    // Server close initiates cleanup synchronously; its MCP close callback may
    // settle one tick after the API close callback, so observe the actual port.
    const url = new URL(response.json.localUrl);
    await assert.rejects(new Promise((resolve, reject) => {
      const req = http.get(url, resolve);
      req.on("error", reject);
    }), /ECONNREFUSED|socket hang up/);
  } finally {
    fs.rmSync(path.dirname(ep.config.dataDir), { recursive: true, force: true });
  }
});
