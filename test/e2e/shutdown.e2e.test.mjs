// Real index boot, real API and real Local MCP. Browser/account prototypes and
// one stop failure are narrowly doubled in a child preloader; no login/network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { httpRequest, waitFor } from "./helper.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("shutdown cleanup failure leaves the keyed API available for stop retry; confirmed cleanup permits exit", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-shutdown-"));
  const dataDir = path.join(dir, "data");
  const workspace = path.join(dir, "workspace");
  fs.mkdirSync(dataDir);
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(dataDir, ".env"), `STORAGE_ENCRYPTION_KEY=${"a".repeat(64)}\n`);
  const eventFile = path.join(dir, "events.txt");
  const preload = path.join(dir, "preload.mjs");
  const source = (file) => pathToFileURL(path.join(ROOT, "src", file)).href;
  fs.writeFileSync(preload, `
    import fs from "node:fs";
    import { CredentialStore } from ${JSON.stringify(source("credentials.mjs"))};
    import { ArenaBrowser } from ${JSON.stringify(source("arena-login.mjs"))};
    import { LocalMcpRuntime } from ${JSON.stringify(source("local-mcp-runtime.mjs"))};
    const events = ${JSON.stringify(eventFile)};
    const record = (text) => fs.appendFileSync(events, text + "\\n");
    const account = { email: "synthetic@test.local", cookieHeader: "synthetic-cookie" };
    CredentialStore.prototype.load = function () { return this; };
    CredentialStore.prototype.ensure = () => account;
    CredentialStore.prototype.primary = () => account;
    CredentialStore.prototype.list = () => [account];
    CredentialStore.prototype.selectNext = () => null;
    CredentialStore.prototype.loginSecretFor = () => null;
    CredentialStore.prototype.expirySummary = () => "synthetic";
    ArenaBrowser.prototype.getPage = async () => ({});
    ArenaBrowser.prototype.close = async () => record("browser-closed");
    let failOnce = true;
    const stop = LocalMcpRuntime.prototype.stop;
    LocalMcpRuntime.prototype.stop = async function () {
      if (failOnce) {
        failOnce = false;
        record("cleanup-failed");
        throw new Error("synthetic cleanup failure");
      }
      const result = await stop.call(this);
      record("cleanup-succeeded");
      return result;
    };
    process.on("message", (message) => {
      if (message === "shutdown") process.emit("SIGTERM");
    });
  `);
  const allocation = http.createServer();
  await new Promise((resolve) => allocation.listen(0, "127.0.0.1", resolve));
  const port = allocation.address().port;
  await new Promise((resolve) => allocation.close(resolve));
  const child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, path.join(ROOT, "src", "index.mjs")], {
    cwd: ROOT, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: {
      ...process.env, DATA_DIR: dataDir, HOST: "127.0.0.1", PORT: String(port),
      ARENA_AGENT_BRIDGE_KEY: "synthetic-shutdown-key", ARENA_AGENT_CHROME: process.execPath,
      ARENA_MCP_RUNTIME: "local", ARENA_LOCAL_MCP_PORT: "0", ARENA_CLOUDFLARED_PATH: "",
      ARENA_SKILL_ROOTS: "", ARENA_AGENT_PROXY: "none", ARENA_ARCHIVE_DIR: "",
    },
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitFor(() => output.includes(`listening on http://127.0.0.1:${port}`) || child.exitCode !== null, 5_000);
  assert.equal(child.exitCode, null, output);
  const request = (reqPath, body) => httpRequest(port, {
    method: body ? "POST" : "GET", reqPath,
    headers: { Authorization: "Bearer synthetic-shutdown-key" }, body: body || null,
  });
  const state = await request("/api/mcp/start", { workspace });
  assert.equal(state.status, 200, state.text);
  child.send("shutdown");
  await waitFor(() => fs.existsSync(eventFile));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(child.exitCode, null, `cleanup failed but process exited:\n${output}`);
  assert.equal((await request("/api/mcp/status")).status, 200);
  assert.equal((await request("/api/mcp/stop", {})).json.running, false);
  assert.ok(!fs.readFileSync(eventFile, "utf8").includes("browser-closed"));
  child.send("shutdown");
  assert.equal(await exited, 0, output);
  assert.match(fs.readFileSync(eventFile, "utf8"), /cleanup-failed\ncleanup-succeeded[\s\S]*browser-closed/);
  await assert.rejects(httpRequest(port), /ECONNREFUSED|socket hang up/);
});
