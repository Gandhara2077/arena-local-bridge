// Real entry point, encrypted store and loopback HTTP. Only Arena browser I/O is
// doubled in a child preloader; these fixtures never contact Arena or use real
// credentials. An empty account store must remain useful for the first login.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CredentialStore } from "../../src/credentials.mjs";
import { loadDotEnv } from "../../src/config.mjs";
import { VERSION } from "../../src/version.mjs";
import { httpRequest, waitFor } from "./helper.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const KEY = "synthetic-onboarding-key";
const EMAIL = "first@test.local";
const PASSWORD = " synthetic-password ";
const COOKIE = "arena-auth-prod-v1=synthetic-cookie";
const NEW_PASSWORD = "new synthetic password";
const NEW_COOKIE = "arena-auth-prod-v1=synthetic-new-cookie";
const SECRET = "a".repeat(64);
const SESSION = "11111111-2222-4333-8444-555555555555";

async function startOnboarding(t, { stored = false, disabled = false, pendingLogin = false, defaultHome = false, invalidCredentials = null, delayedStoredOutcome = "" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arena first run 中文 "));
  const expectedHome = path.join(dir, "expected home");
  const dataDir = defaultHome ? path.join(expectedHome, ".arena-bridge") : path.join(dir, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  if (stored || defaultHome) {
    fs.writeFileSync(path.join(dataDir, ".env"), `STORAGE_ENCRYPTION_KEY=${SECRET}\nARENA_SESSIONS=${SESSION}\n`);
  }
  if (stored) {
    const store = new CredentialStore({ filePath: path.join(dataDir, "credentials.json"), secret: SECRET });
    store.upsert({ email: EMAIL, cookieHeader: COOKIE, password: PASSWORD });
    if (disabled) store.disable(EMAIL, "synthetic restricted account");
  }
  if (invalidCredentials !== null) fs.writeFileSync(path.join(dataDir, "credentials.json"), invalidCredentials);
  const eventsFile = path.join(dir, "browser-events.txt");
  const preload = path.join(dir, "preload.mjs");
  const source = (file) => pathToFileURL(path.join(ROOT, "src", file)).href;
  fs.writeFileSync(preload, `
    import fs from "node:fs";
    import os from "node:os";
    import { ArenaBrowser } from ${JSON.stringify(source("arena-login.mjs"))};
    const record = (text) => fs.appendFileSync(${JSON.stringify(eventsFile)}, text + "\\n");
    ${defaultHome ? `os.homedir = () => ${JSON.stringify(expectedHome)};` : ""}
    ArenaBrowser.prototype.getPage = async () => { record("get-page"); return {}; };
    ArenaBrowser.prototype.login = async (email, password) => {
      record("login");
      if (email === "reject@test.local") throw new Error(password + " ${COOKIE}");
      ${pendingLogin ? `await new Promise((resolve) => process.once("message", resolve));` : ""}
      ${delayedStoredOutcome ? `
        if (password === ${JSON.stringify(PASSWORD)}) {
          record("old-login-pending");
          await new Promise((resolve) => process.once("message", resolve));
          setImmediate(() => record("old-login-settled"));
          ${delayedStoredOutcome === "failure" ? 'throw new Error("synthetic old-password login failed");' : ""}
        }
      ` : ""}
      return { email, password, cookieHeader: password === ${JSON.stringify(NEW_PASSWORD)} ? ${JSON.stringify(NEW_COOKIE)} : ${JSON.stringify(COOKIE)} };
    };
    process.on("message", (message) => {
      if (message === "shutdown") process.emit("SIGTERM");
    });
  `);
  const allocation = http.createServer();
  await new Promise((resolve) => allocation.listen(0, "127.0.0.1", resolve));
  const port = allocation.address().port;
  await new Promise((resolve) => allocation.close(resolve));
  const marker = "synthetic-launcher-instance";
  const child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, path.join(ROOT, "src", "index.mjs")], {
    cwd: ROOT, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: {
      ...process.env, DATA_DIR: defaultHome ? undefined : dataDir,
      HOME: defaultHome ? path.join(dir, "ignored home") : process.env.HOME,
      HOST: "127.0.0.1", PORT: String(port),
      ARENA_AGENT_BRIDGE_KEY: KEY, ARENA_AGENT_CHROME: process.execPath,
      ARENA_LAUNCHER_INSTANCE: marker, ARENA_MCP_RUNTIME: "local", ARENA_LOCAL_MCP_PORT: "0",
      ARENA_CLOUDFLARED_PATH: "", ARENA_SKILL_ROOTS: "", ARENA_AGENT_PROXY: "none",
      ARENA_ARCHIVE_DIR: "", ARENA_MIGRATE_FROM_OMNI: "0", ARENA_OMNI_DB: "", ARENA_SESSIONS: undefined,
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
  return {
    child, port, marker, dataDir,
    events: () => fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, "utf8") : "",
    output: () => output,
    get: (reqPath) => httpRequest(port, { reqPath }),
    login: (body, headers = { Authorization: `Bearer ${KEY}` }) => httpRequest(port, {
      method: "POST", reqPath: "/api/accounts/login", headers, body,
    }),
  };
}

test("first-run boot serves the GUI and liveness without consuming a browser session", async (t) => {
  const app = await startOnboarding(t);
  const health = await app.get("/health");
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);
  assert.equal(health.json.service, "arena-bridge");
  assert.equal(health.json.version, VERSION);
  assert.equal(health.json.launcherInstance, app.marker);
  assert.equal(health.json.ready, false);
  assert.equal(health.json.account, null);
  assert.deepEqual(health.json.accounts, []);
  assert.equal(health.json.browser.launched, false);
  const ready = await app.get("/ready");
  assert.equal(ready.status, 503);
  assert.equal(ready.json.ok, false);
  assert.equal(ready.json.ready, false);
  const gui = await app.get("/");
  assert.equal(gui.status, 200);
  assert.match(gui.headers["content-type"], /text\/html/);
  assert.equal((await app.get("/api/status")).json.apiKey, KEY);
  assert.equal(fs.existsSync(path.join(app.dataDir, "credentials.json")), false);
  assert.equal(app.events(), "");
  const secret = loadDotEnv(path.join(app.dataDir, ".env")).STORAGE_ENCRYPTION_KEY;
  assert.match(secret, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(health.text, new RegExp(`${KEY}|${secret}`));
});

test("first GUI login keeps the existing auth boundary, saves encrypted credentials, and makes the account ready", async (t) => {
  const app = await startOnboarding(t);
  const body = { email: ` ${EMAIL} `, password: PASSWORD };
  assert.equal((await app.login(body, {})).status, 401);
  assert.equal((await app.login(body, { Authorization: `Bearer ${KEY}`, Host: "attacker.example" })).status, 403);
  assert.equal((await app.login(body, { Authorization: `Bearer ${KEY}`, Origin: "https://attacker.example" })).status, 403);
  for (const invalid of ["{", [], { email: EMAIL, password: "" }, { email: "bad", password: PASSWORD }]) {
    const response = await app.login(invalid);
    assert.equal(response.status, 400, response.text);
    assert.doesNotMatch(response.text, /synthetic-password|synthetic-cookie/);
  }
  assert.equal(app.events(), "", "rejected requests must not drive the browser");
  const failed = await app.login({ email: "reject@test.local", password: PASSWORD });
  assert.equal(failed.status, 502, failed.text);
  assert.doesNotMatch(failed.text, /synthetic-password|synthetic-cookie/);
  assert.doesNotMatch(app.output(), /synthetic-password|synthetic-cookie/);
  assert.equal(fs.existsSync(path.join(app.dataDir, "credentials.json")), false);
  assert.equal((await app.get("/ready")).status, 503);
  const success = await app.login(body);
  assert.equal(success.status, 200, success.text);
  assert.equal(success.json.ok, true);
  assert.equal(success.json.account.email, EMAIL);
  assert.doesNotMatch(success.text, /synthetic-password|synthetic-cookie/);
  const filePath = path.join(app.dataDir, "credentials.json");
  assert.doesNotMatch(fs.readFileSync(filePath, "utf8"), /synthetic-password|synthetic-cookie/);
  const secret = loadDotEnv(path.join(app.dataDir, ".env")).STORAGE_ENCRYPTION_KEY;
  const stored = new CredentialStore({ filePath, secret }).load();
  assert.equal(stored.primary().cookieHeader, COOKIE);
  assert.equal(stored.loginSecretFor(stored.primary()).password, PASSWORD);
  assert.equal((await app.get("/health")).json.ready, true);
  const ready = await app.get("/ready");
  assert.equal(ready.status, 200);
  assert.equal(ready.json.ok, true);
});

test("an all-disabled account store still reaches the GUI and remains unready", async (t) => {
  const app = await startOnboarding(t, { stored: true, disabled: true });
  assert.equal((await app.get("/")).status, 200);
  assert.equal((await app.get("/health")).json.ok, true);
  assert.equal((await app.get("/ready")).status, 503);
  assert.equal(app.events(), "");
  const restored = new CredentialStore({ filePath: path.join(app.dataDir, "credentials.json"), secret: SECRET }).load();
  assert.equal(restored.accounts[0].disabled, true);
});

test("a saved account does not become ready until the existing usability verification succeeds", async (t) => {
  const app = await startOnboarding(t, { stored: true, pendingLogin: true });
  await waitFor(() => app.events().includes("login"));
  assert.equal((await app.get("/health")).json.ok, true);
  assert.equal((await app.get("/ready")).status, 503);
  app.child.send("finish-login");
  await waitFor(() => app.output().includes("usable account confirmed"));
  assert.equal((await app.get("/ready")).status, 200);
});

test("boot reads the default DATA_DIR .env from the same home that config uses", async (t) => {
  const app = await startOnboarding(t, { defaultHome: true });
  assert.equal((await app.get("/api/status")).json.activeSession, SESSION);
  assert.equal(loadDotEnv(path.join(app.dataDir, ".env")).STORAGE_ENCRYPTION_KEY, SECRET);
  assert.equal(app.events(), "");
});

test("GUI login refuses an existing corrupt credential store without browser use or changing its bytes", async (t) => {
  for (const original of ["{broken", "[]", '{"version":1,"accounts":{}}']) {
    const app = await startOnboarding(t, { invalidCredentials: original });
    const response = await app.login({ email: EMAIL, password: PASSWORD });
    assert.equal(response.status, 409, response.text);
    assert.match(response.json.error.message, /credentials.*read|credential.*read/i);
    assert.equal(fs.readFileSync(path.join(app.dataDir, "credentials.json"), "utf8"), original);
    assert.equal((await app.get("/health")).json.ok, true);
    assert.equal((await app.get("/ready")).status, 503);
    assert.equal(app.events(), "");
  }
});

for (const outcome of ["failure", "success"]) {
  test(`a delayed saved-account verification ${outcome} cannot overwrite a newer successful GUI login`, async (t) => {
    const app = await startOnboarding(t, { stored: true, delayedStoredOutcome: outcome });
    await waitFor(() => app.events().includes("old-login-pending"));
    assert.equal((await app.get("/ready")).status, 503);
    const login = await app.login({ email: EMAIL, password: NEW_PASSWORD });
    assert.equal(login.status, 200, login.text);
    assert.equal((await app.get("/ready")).status, 200);
    const filePath = path.join(app.dataDir, "credentials.json");
    const afterGuiLogin = fs.readFileSync(filePath, "utf8");
    app.child.send("finish-old-login");
    await waitFor(() => app.events().includes("old-login-settled"));
    assert.equal((await app.get("/ready")).status, 200);
    assert.equal(fs.readFileSync(filePath, "utf8"), afterGuiLogin, "outdated verification must leave the newer saved credentials byte-identical");
    const restored = new CredentialStore({ filePath, secret: SECRET }).load();
    assert.equal(restored.accounts[0].disabled, false);
    assert.equal(restored.primary().cookieHeader, NEW_COOKIE);
    assert.equal(restored.loginSecretFor(restored.primary()).password, NEW_PASSWORD);
  });
}
