// Exercise the compiled Windows launcher against real, disposable HTTP children.
// Removing instance matching, the ownership job, or the control pipe must break
// these checks; no Arena account, personal state or installed browser is used.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = path.join(ROOT, "bin", "build-launcher.ps1");
const RUNTIME = path.join(ROOT, "bin", "gui-runtime.mjs");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await sleep(50);
  }
  assert.fail("condition did not become true before timeout");
}

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function health(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

function launch(exe, args, env) {
  const process = spawn(exe, ["--no-browser", "--console-errors", ...args], {
    env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  let output = "";
  process.stdout.on("data", (chunk) => { output += chunk; });
  process.stderr.on("data", (chunk) => { output += chunk; });
  const done = new Promise((resolve, reject) => {
    // A broken health/stop branch must fail this check, not leave a hidden
    // owner waiting forever. This handle was created here and is ours to close.
    const timer = setTimeout(() => {
      process.kill();
      reject(new Error("launcher did not exit within 20 seconds"));
    }, 20_000);
    timer.unref();
    process.once("error", (error) => { clearTimeout(timer); reject(error); });
    process.once("exit", (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
  return { process, done };
}

const CHILD = `
import fs from "node:fs";
import http from "node:http";
import { spawn } from "node:child_process";
const root = process.cwd();
fs.appendFileSync("boots.txt", process.pid + "\\n");
fs.writeFileSync("seen.json", JSON.stringify({
  node: process.execPath, data: process.env.DATA_DIR, host: process.env.HOST,
  key: process.env.ARENA_AGENT_BRIDGE_KEY, archive: process.env.ARENA_ARCHIVE_DIR,
  workspace: process.env.ARENA_MCP_WORKSPACE, headed: process.env.ARENA_HEADED,
}));
if (process.env.FIXTURE_MODE === "crash") throw new Error("synthetic boot failure");
if (process.env.FIXTURE_MODE === "descendant") {
  spawn(process.execPath, ["-e", "require('fs').writeFileSync('descendant.txt', 'alive'); setInterval(() => require('fs').appendFileSync('descendant.txt', '.'), 50)"], {
    cwd: root, stdio: "ignore", windowsHide: true,
  });
}
const server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ service: "arena-bridge", ok: true, version: "fixture",
    launcherInstance: process.env.FIXTURE_MODE === "wrong-health" ? "another-process" : process.env.ARENA_LAUNCHER_INSTANCE,
    pid: process.pid,
  }));
});
server.listen(Number(process.env.PORT), "127.0.0.1");
process.on("SIGTERM", () => {
  fs.writeFileSync("stopped.txt", "graceful");
  server.close(() => process.exit(0));
});
`;

describe("the Windows executable launcher", { skip: process.platform !== "win32" }, () => {
  let scratch;
  let builtExe;
  const running = [];

  before(() => {
    scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "arena-launcher-")));
    builtExe = path.join(scratch, "build output 空格", "ArenaLocalBridge.exe");
    const built = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", BUILD, "-OutputPath", builtExe], {
      stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", windowsHide: true,
    });
    assert.equal(built.status, 0, `launcher build failed: ${built.stderr || built.stdout}`);
    assert.ok(fs.existsSync(builtExe), "the build did not produce ArenaLocalBridge.exe");
  });

  after(async () => {
    for (const item of running) {
      const stopped = launch(item.exe, ["--stop"], item.env);
      await stopped.done;
      await item.owner?.done;
    }
    assert.equal(path.dirname(path.resolve(scratch)), fs.realpathSync.native(os.tmpdir()));
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  async function fixture(mode = "healthy") {
    const dir = fs.mkdtempSync(path.join(scratch, "安装 空格 & ! ' % "));
    fs.mkdirSync(path.join(dir, "src"));
    fs.mkdirSync(path.join(dir, "bin"));
    fs.mkdirSync(path.join(dir, "runtime"));
    fs.copyFileSync(builtExe, path.join(dir, "ArenaLocalBridge.exe"));
    fs.copyFileSync(process.execPath, path.join(dir, "runtime", "node.exe"));
    fs.copyFileSync(RUNTIME, path.join(dir, "bin", "gui-runtime.mjs"));
    fs.writeFileSync(path.join(dir, "src", "index.mjs"), CHILD);
    const port = await freePort();
    const env = { ...process.env, PORT: String(port), FIXTURE_MODE: mode,
      HOST: "0.0.0.0", DATA_DIR: "must-not-use-inherited-state",
      ARENA_NODE_PATH: "missing-user-node.exe", ARENA_LAUNCHER_TIMEOUT_MS: mode === "wrong-health" ? "1500" : "10000" };
    delete env.ARENA_AGENT_BRIDGE_KEY;
    delete env.ARENA_ARCHIVE_DIR;
    delete env.ARENA_MCP_WORKSPACE;
    const item = { dir, port, env, exe: path.join(dir, "ArenaLocalBridge.exe") };
    running.push(item);
    return item;
  }

  test("starts with bundled Node and preserves literal UTF-8 settings in a spaced Unicode path", async () => {
    const item = await fixture();
    const archive = path.join(item.dir, "归档 & ' % !");
    const workspace = path.join(item.dir, "工作区 空格");
    fs.writeFileSync(path.join(item.dir, "archive-dir.txt"), `\uFEFF${archive}\r\n`);
    fs.writeFileSync(path.join(item.dir, "mcp-workspace.txt"), `${workspace}\n`);
    item.owner = launch(item.exe, [], item.env);
    const current = await until(() => health(item.port));
    assert.ok(current.launcherInstance, "a launcher instance must identify its own health response");
    const seen = JSON.parse(fs.readFileSync(path.join(item.dir, "seen.json"), "utf8"));
    assert.equal(seen.node.toLowerCase(), path.join(item.dir, "runtime", "node.exe").toLowerCase());
    assert.equal(seen.data, path.join(item.dir, ".arena-gui"));
    assert.equal(seen.host, "127.0.0.1");
    assert.equal(seen.key, "local-dev-key");
    assert.equal(seen.archive, archive);
    assert.equal(seen.workspace, workspace);
    assert.equal(seen.headed, "1");
    const duplicate = await launch(item.exe, [], item.env).done;
    assert.equal(duplicate.code, 0, duplicate.output);
    assert.equal((await health(item.port)).pid, current.pid);
    assert.equal(fs.readFileSync(path.join(item.dir, "boots.txt"), "utf8").trim().split(/\r?\n/).length, 1);
    assert.equal((await launch(item.exe, ["--stop"], item.env).done).code, 0);
    assert.equal((await item.owner.done).code, 0);
    assert.equal(fs.readFileSync(path.join(item.dir, "stopped.txt"), "utf8"), "graceful");
    assert.equal(await health(item.port), null);
  });

  test("an occupied port is rejected without touching an unrelated healthy listener", async () => {
    const item = await fixture();
    const unrelated = http.createServer((req, res) => res.end(JSON.stringify({ service: "arena-bridge", ok: true })));
    await new Promise((resolve) => unrelated.listen(item.port, "127.0.0.1", resolve));
    try {
      const failed = await launch(item.exe, [], item.env).done;
      assert.equal(failed.code, 1);
      assert.match(failed.output, /port.*in use/i);
      assert.equal((await health(item.port)).ok, true);
      assert.equal((await launch(item.exe, ["--stop"], item.env).done).code, 0);
      assert.equal((await health(item.port)).ok, true);
      assert.equal(fs.existsSync(path.join(item.dir, "boots.txt")), false);
    } finally {
      await new Promise((resolve) => unrelated.close(resolve));
    }
  });

  test("does not accept a 200 health response from another launcher instance", async () => {
    const item = await fixture("wrong-health");
    const failed = await launch(item.exe, [], item.env).done;
    assert.equal(failed.code, 1);
    assert.match(failed.output, /health|timeout/i);
    assert.equal(await health(item.port), null);
  });

  test("reports early child failure with the local log path", async () => {
    const item = await fixture("crash");
    const failed = await launch(item.exe, [], item.env).done;
    assert.equal(failed.code, 1);
    assert.match(failed.output, /exited|failed/i);
    assert.ok(failed.output.includes(path.join(item.dir, ".arena-gui", "bridge.log")));
    assert.match(fs.readFileSync(path.join(item.dir, ".arena-gui", "bridge.log"), "utf8"), /synthetic boot failure/);
  });

  test("graceful stop also releases only this launcher's descendant job", async () => {
    const item = await fixture("descendant");
    item.owner = launch(item.exe, [], item.env);
    await until(() => health(item.port));
    const pulse = path.join(item.dir, "descendant.txt");
    await until(() => fs.existsSync(pulse));
    assert.equal((await launch(item.exe, ["--stop"], item.env).done).code, 0);
    assert.equal((await item.owner.done).code, 0);
    const stoppedSize = fs.statSync(pulse).size;
    await sleep(300);
    assert.equal(fs.statSync(pulse).size, stoppedSize, "an owned descendant survived stop");
  });

  test("rejects ambiguous multiline path files before starting a child", async () => {
    const item = await fixture();
    const setting = `${item.dir}\nC:\\another-path\n`;
    fs.writeFileSync(path.join(item.dir, "archive-dir.txt"), setting);
    const failed = await launch(item.exe, [], item.env).done;
    assert.equal(failed.code, 1);
    assert.match(failed.output, /archive-dir\.txt/);
    assert.equal(fs.existsSync(path.join(item.dir, "boots.txt")), false);
    assert.equal(fs.readFileSync(path.join(item.dir, "archive-dir.txt"), "utf8"), setting);
  });
});
