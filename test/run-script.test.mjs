import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
const shellPath = (file) => file.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);

function runFixture(t, { defaultDirectory = false, mkdirFails = false, exit = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arena-run-script-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stubs = path.join(root, "stubs");
  const scriptDir = path.join(root, "script directory");
  const launchDir = path.join(root, "launch");
  for (const directory of [stubs, scriptDir, launchDir]) fs.mkdirSync(directory);
  const script = path.join(scriptDir, "run.sh");
  fs.writeFileSync(script, fs.readFileSync(new URL("../run.sh", import.meta.url), "utf8").replaceAll("\r\n", "\n"));
  const eventFile = path.join(root, "node-event.txt");
  fs.writeFileSync(path.join(stubs, "node"), '#!/usr/bin/env bash\nprintf "%s\\n" "$PWD" "$DATA_DIR" "$@" > "$FIXTURE_EVENT"\nexit "$FIXTURE_EXIT"\n', { mode: 0o755 });
  if (mkdirFails) fs.writeFileSync(path.join(stubs, "mkdir"), "#!/usr/bin/env bash\nexit 33\n", { mode: 0o755 });
  const dataDir = defaultDirectory ? path.join(root, "home/.arena-bridge") : path.join(root, "data directory");
  const result = spawnSync(bash, ["-c", 'export PATH="$FIXTURE_STUBS:/usr/bin:/bin"; exec bash "$FIXTURE_SCRIPT" ignored-argument'], {
    cwd: launchDir, encoding: "utf8", timeout: 10_000,
    env: { ...process.env, BASH_ENV: "", HOME: shellPath(path.join(root, "home")), DATA_DIR: defaultDirectory ? "" : shellPath(dataDir), FIXTURE_SCRIPT: shellPath(script), FIXTURE_STUBS: shellPath(stubs), FIXTURE_EVENT: shellPath(eventFile), FIXTURE_EXIT: String(exit) },
  });
  assert.ifError(result.error);
  return { ...result, dataDir, scriptDir, lines: fs.existsSync(eventFile) ? fs.readFileSync(eventFile, "utf8").trim().split("\n") : [] };
}

test("run.sh starts from its own directory, exports DATA_DIR and propagates Node exit", (t) => {
  const result = runFixture(t, { exit: 7 });
  assert.equal(result.status, 7, result.stderr);
  assert.ok(fs.statSync(result.dataDir).isDirectory());
  assert.deepEqual(result.lines, [shellPath(result.scriptDir), shellPath(result.dataDir), "src/index.mjs"]);
  assert.equal(result.stdout, `==> arena-bridge (local) | DATA_DIR=${shellPath(result.dataDir)}\n`);
});

test("run.sh defaults an empty DATA_DIR inside an isolated child home", (t) => {
  const result = runFixture(t, { defaultDirectory: true });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.statSync(result.dataDir).isDirectory());
  assert.equal(result.lines[1], shellPath(result.dataDir));
});

test("run.sh stops before Node when data directory creation fails", (t) => {
  const result = runFixture(t, { mkdirFails: true });
  assert.equal(result.status, 33, result.stderr);
  assert.deepEqual(result.lines, []);
  assert.equal(result.stdout, "");
});
