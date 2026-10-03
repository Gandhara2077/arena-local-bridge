import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
const shellPath = (file) => file.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);

function warpFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arena-warp-script-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stubs = path.join(root, "stubs");
  const scriptDir = path.join(root, "script directory");
  const warpDir = options.defaultDirectory ? path.join(root, "home/.warp") : path.join(root, "warp directory");
  for (const directory of [stubs, scriptDir, warpDir]) fs.mkdirSync(directory, { recursive: true });
  const script = path.join(scriptDir, "warp.sh");
  fs.writeFileSync(script, fs.readFileSync(new URL("../warp.sh", import.meta.url), "utf8").replaceAll("\r\n", "\n"));
  const eventFile = path.join(root, "events.txt");
  const readyFile = path.join(root, "ready");
  const prefix = '#!/bin/bash\nprintf -v event "%s\\t" "${0##*/}" "$PWD" "$@"\nprintf "%s\\n" "$event" >> "$FIXTURE_EVENTS"\n';
  const binaryTemplate = path.join(root, "wireproxy-fixture");
  fs.writeFileSync(binaryTemplate, prefix + "exit 0\n", { mode: 0o755 });
  if (options.installed) {
    fs.copyFileSync(binaryTemplate, path.join(warpDir, "wireproxy"));
    fs.chmodSync(path.join(warpDir, "wireproxy"), 0o755);
    fs.writeFileSync(path.join(warpDir, "wireproxy.conf"), "existing fixture config");
  }
  // Only file operations and pure text utilities can fall through to real tools.
  for (const tool of ["dirname", "mkdir", "chmod", "rm", "grep", "seq", "tail"]) {
    fs.writeFileSync(path.join(stubs, tool), `#!/bin/bash\nexec /usr/bin/${tool} "$@"\n`, { mode: 0o755 });
  }
  const commands = {
    curl: prefix + `
      if [[ "$*" == *api.ipify.org* ]]; then
        [[ "$FIXTURE_IP_FAIL" == 1 ]] && exit 6
        printf '%s' "$FIXTURE_IP"
      else
        [[ "$FIXTURE_DOWNLOAD_FAIL" == 1 ]] && exit 23
        while (($#)); do
          if [[ "$1" == -o ]]; then printf archive > "$2"; break; fi
          shift
        done
      fi
    `,
    wget: prefix + 'printf archive > "$2"\n',
    tar: prefix + 'while (($#)); do if [[ "$1" == -C ]]; then /usr/bin/cp "$FIXTURE_BINARY" "$2/wireproxy"; break; fi; shift; done\n',
    node: prefix + 'while (($#)); do if [[ "$1" == --out ]]; then printf "fixture config" > "$2"; break; fi; shift; done\n',
    ss: prefix + 'if [[ "$FIXTURE_LISTEN" == 1 || -f "$FIXTURE_READY" ]]; then printf "LISTEN 127.0.0.1:%s\\n" "$SOCKS_PORT"; fi\n',
    nohup: prefix + 'if [[ "$FIXTURE_START_FAIL" == 1 ]]; then echo "fixture launch failure"; exit 1; fi\nprintf ready > "$FIXTURE_READY"\nexec "$@"\n',
    sleep: prefix + 'exec /usr/bin/sleep 0.005\n',
  };
  for (const [tool, source] of Object.entries(commands)) {
    if (tool === "curl" && options.wget) continue;
    fs.writeFileSync(path.join(stubs, tool), source, { mode: 0o755 });
  }
  const result = spawnSync(bash, ["-c", 'export PATH="$FIXTURE_STUBS"; exec /bin/bash "$FIXTURE_SCRIPT"'], {
    cwd: root, encoding: "utf8", timeout: 15_000,
    env: { ...process.env, BASH_ENV: "", HOME: shellPath(path.join(root, "home")), WARP_DIR: options.defaultDirectory ? "" : shellPath(warpDir), SOCKS_PORT: "4567", FIXTURE_STUBS: shellPath(stubs), FIXTURE_SCRIPT: shellPath(script), FIXTURE_EVENTS: shellPath(eventFile), FIXTURE_READY: shellPath(readyFile), FIXTURE_BINARY: shellPath(binaryTemplate), FIXTURE_LISTEN: options.listening ? "1" : "0", FIXTURE_START_FAIL: options.startFails ? "1" : "0", FIXTURE_DOWNLOAD_FAIL: options.downloadFails ? "1" : "0", FIXTURE_IP_FAIL: options.ipFails ? "1" : "0", FIXTURE_IP: "198.51.100.5" },
  });
  assert.ifError(result.error);
  const events = fs.existsSync(eventFile) ? fs.readFileSync(eventFile, "utf8").trim().split("\n").map((line) => line.split("\t").slice(0, -1)) : [];
  return { ...result, warpDir, scriptDir, events };
}

test("warp.sh reuses installed binary/config and an already listening isolated proxy", (t) => {
  const result = warpFixture(t, { installed: true, listening: true, defaultDirectory: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.events.map(([name]) => name), ["ss", "ss", "curl"]);
  assert.equal(fs.readFileSync(path.join(result.warpDir, "wireproxy.conf"), "utf8"), "existing fixture config");
  assert.match(result.stdout, /SOCKS5 listening on 127\.0\.0\.1:4567/);
  assert.match(result.stdout, /WARP exit IP: 198\.51\.100\.5/);
  assert.match(result.stdout, /ARENA_AGENT_PROXY=socks5:\/\/127\.0\.0\.1:4567/);
});

test("warp.sh downloads through the curl stub, writes config and starts only a stub binary", (t) => {
  const result = warpFixture(t);
  assert.equal(result.status, 0, result.stderr);
  const download = result.events.find(([name, , flag]) => name === "curl" && flag === "-fsSL");
  assert.deepEqual(download.slice(2), ["-fsSL", "https://github.com/pufferffish/wireproxy/releases/download/v1.0.9/wireproxy_linux_amd64.tar.gz", "-o", `${shellPath(result.warpDir)}/wp.tgz`]);
  const registration = result.events.find(([name]) => name === "node");
  assert.deepEqual(registration.slice(1), [shellPath(result.scriptDir), "bin/warp-setup.mjs", "--out", `${shellPath(result.warpDir)}/wireproxy.conf`, "--port", "4567"]);
  const start = result.events.find(([name]) => name === "nohup");
  assert.deepEqual(start.slice(1), [shellPath(result.warpDir), "./wireproxy", "-c", "wireproxy.conf"]);
  assert.equal(fs.existsSync(path.join(result.warpDir, "wp.tgz")), false);
  assert.equal(fs.readFileSync(path.join(result.warpDir, "wireproxy.conf"), "utf8"), "fixture config");
});

test("warp.sh falls back to the wget stub when curl is absent", (t) => {
  const result = warpFixture(t, { wget: true, listening: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.events.filter(([name]) => name === "wget").length, 1);
  assert.match(result.stdout, /WARP exit IP: unknown/);
  assert.match(result.stderr, /WARN: could not reach the internet through WARP yet/);
});

test("warp.sh stops after 15 failed readiness polls and reports the isolated log", (t) => {
  const result = warpFixture(t, { installed: true, startFails: true });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.events.filter(([name]) => name === "sleep").length, 15);
  assert.equal(result.events.filter(([name]) => name === "ss").length, 17);
  assert.equal(result.events.some(([name]) => name === "curl"), false);
  assert.match(result.stderr, /ERROR: wireproxy did not start/);
  assert.match(result.stderr, /fixture launch failure/);
});

test("warp.sh keeps a listening proxy usable when the exit-IP check fails", (t) => {
  const result = warpFixture(t, { installed: true, listening: true, ipFails: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /WARP exit IP: unknown/);
  assert.match(result.stderr, /WARN: could not reach the internet through WARP yet/);
});

test("warp.sh fails before registration or launch when the download fails", (t) => {
  const result = warpFixture(t, { downloadFails: true });
  assert.equal(result.status, 23, result.stderr);
  assert.deepEqual(result.events.map(([name]) => name), ["curl"]);
  assert.equal(fs.existsSync(path.join(result.warpDir, "wireproxy.conf")), false);
});
