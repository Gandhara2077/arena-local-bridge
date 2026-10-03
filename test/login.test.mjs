import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function loginFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arena-login-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "bin"));
  fs.mkdirSync(path.join(root, "src"));
  fs.copyFileSync(new URL("../bin/login.mjs", import.meta.url), path.join(root, "bin/login.mjs"));
  const record = `import fs from "node:fs"; const event = (type, data) => fs.appendFileSync(process.env.FIXTURE_EVENTS, JSON.stringify({type, data}) + "\\n");\n`;
  fs.writeFileSync(path.join(root, "src/config.mjs"), record + `
    export function loadDotEnv(file) {
      event("dotenv", { file });
      return fs.existsSync(file) ? Object.fromEntries(fs.readFileSync(file, "utf8").trim().split("\\n").filter(Boolean).map(line => line.split("="))) : {};
    }
    export function loadConfig(env, options) {
      event("config", { options, secret: env.STORAGE_ENCRYPTION_KEY });
      return { credentialsFile: process.env.DATA_DIR + "/credentials.json", omniDbPath: "fixture-db", omniRoot: "fixture-root", chromePath: "fixture-chrome", proxy: "fixture-proxy" };
    }
  `);
  fs.writeFileSync(path.join(root, "src/credentials.mjs"), record + `
    export class CredentialStore {
      constructor(options) { event("store", options); }
      load() { event("load", {}); return this; }
      upsert(value) { event("upsert", value); }
      primary() { return "fixture-primary"; }
      expirySummary(value) { event("expiry", value); return "fixture-expiry"; }
    }
  `);
  fs.writeFileSync(path.join(root, "src/arena-login.mjs"), record + `
    export class ArenaBrowser {
      constructor(options) { event("browser", options); }
      async login(email, password) {
        event("login", { email, password });
        if (process.env.FIXTURE_FAIL) throw new Error("fixture login failure");
        return { email, password, cookieHeader: "fixture-cookie" };
      }
      async close() { event("close", {}); if (process.env.FIXTURE_CLOSE_FAIL) throw new Error("fixture close failure"); }
    }
  `);
  fs.writeFileSync(path.join(root, "src/util.mjs"), record + `export const log = Object.fromEntries(["info", "warn", "error"].map(level => [level, (name, msg, fields) => event("log", {level, name, msg, fields})]));`);
  const dataDir = path.join(root, "data");
  const eventsFile = path.join(root, "events.jsonl");
  return {
    dataDir,
    run(args, extra = {}, input) {
      const result = spawnSync(process.execPath, [path.join(root, "bin/login.mjs"), ...args], {
        cwd: root, encoding: "utf8", input, timeout: 10_000,
        env: { ...process.env, DATA_DIR: dataDir, ARENA_PASSWORD: "", STORAGE_ENCRYPTION_KEY: "environment-fixture", FIXTURE_EVENTS: eventsFile, FIXTURE_FAIL: "", FIXTURE_CLOSE_FAIL: "", ...extra },
      });
      assert.ifError(result.error);
      const events = fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, "utf8").trim().split("\n").map(JSON.parse) : [];
      return { ...result, events };
    },
  };
}

test("login CLI requires email before creating local state", (t) => {
  const fixture = loginFixture(t);
  const result = fixture.run([]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage: node bin\/login.mjs/);
  assert.equal(fs.existsSync(fixture.dataDir), false);
  assert.deepEqual(result.events, []);
});

test("login CLI generates a local key, stores the login result, and closes the browser", (t) => {
  const fixture = loginFixture(t);
  const result = fixture.run(["--email", "fixture@example.com", "-e", "ignored@example.com", "--password", "argument-fixture"], { ARENA_PASSWORD: "ignored-fixture" });
  assert.equal(result.status, 0);
  const login = result.events.find(({ type }) => type === "login").data;
  assert.deepEqual(login, { email: "fixture@example.com", password: "argument-fixture" });
  assert.deepEqual(result.events.find(({ type }) => type === "upsert").data, { ...login, cookieHeader: "fixture-cookie", priority: 1 });
  const secret = result.events.find(({ type }) => type === "store").data.secret;
  assert.match(secret, /^[a-f0-9]{64}$/);
  assert.equal(fs.readFileSync(path.join(fixture.dataDir, ".env"), "utf8"), `\nSTORAGE_ENCRYPTION_KEY=${secret}\n`);
  assert.deepEqual(result.events.find(({ type }) => type === "config").data.options, { requireBridgeKey: false });
  assert.equal(result.events.at(-1).type, "close");
});

test("login CLI preserves an existing key and accepts environment password", (t) => {
  const fixture = loginFixture(t);
  fs.mkdirSync(fixture.dataDir);
  const contents = "STORAGE_ENCRYPTION_KEY=file-fixture\n";
  fs.writeFileSync(path.join(fixture.dataDir, ".env"), contents);
  const result = fixture.run(["-e", "fixture@example.com"], { ARENA_PASSWORD: "environment-password-fixture", FIXTURE_CLOSE_FAIL: "1" });
  assert.equal(result.status, 0);
  assert.equal(result.events.find(({ type }) => type === "store").data.secret, "file-fixture");
  assert.equal(result.events.find(({ type }) => type === "config").data.secret, "environment-fixture");
  assert.equal(result.events.find(({ type }) => type === "login").data.password, "environment-password-fixture");
  assert.equal(fs.readFileSync(path.join(fixture.dataDir, ".env"), "utf8"), contents);
});

test("login CLI trims prompted passwords and closes after login failure", (t) => {
  const result = loginFixture(t).run(["--email", "fixture@example.com"], { FIXTURE_FAIL: "1" }, "  prompted-fixture  \n");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Password: /);
  assert.equal(result.events.find(({ type }) => type === "login").data.password, "prompted-fixture");
  assert.equal(result.events.some(({ type }) => type === "upsert"), false);
  assert.equal(result.events.at(-2).type, "close");
  assert.equal(result.events.at(-1).data.msg, "failed");
});
