import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const success = (endpoint) => ({ ok: true, status: 200, body: {
  id: "registration-fixture", account: { id: "account-fixture" }, config: {
    client_id: "client-fixture", interface: { addresses: { v4: "192.0.2.2", v6: "2001:db8::2" } },
    peers: [{ public_key: "peer-fixture", endpoint: endpoint ? { host: endpoint } : {} }],
  },
} });

function setupFixture(t, responses, args = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arena-warp-setup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "bin"));
  fs.mkdirSync(path.join(root, "src"));
  fs.copyFileSync(new URL("../bin/warp-setup.mjs", import.meta.url), path.join(root, "bin/warp-setup.mjs"));
  fs.copyFileSync(new URL("../src/util.mjs", import.meta.url), path.join(root, "src/util.mjs"));
  const responseFile = path.join(root, "responses.json");
  const eventFile = path.join(root, "events.jsonl");
  fs.writeFileSync(responseFile, JSON.stringify(responses));
  const preload = path.join(root, "preload.mjs");
  fs.writeFileSync(preload, `
    import fs from "node:fs";
    import os from "node:os";
    os.homedir = () => process.env.FIXTURE_ROOT;
    const responses = JSON.parse(fs.readFileSync(process.env.FIXTURE_RESPONSES, "utf8"));
    const event = (value) => fs.appendFileSync(process.env.FIXTURE_EVENTS, JSON.stringify(value) + "\\n");
    globalThis.fetch = async (url, options) => {
      event({ type: "request", url, options });
      const response = responses.shift();
      if (!response || response.networkError) throw new Error("fixture network failure");
      return { ok: response.ok, status: response.status, json: async () => {
        if (response.nonJson) throw new Error("fixture non-JSON");
        return response.body;
      } };
    };
    globalThis.setTimeout = (callback, delay) => { event({ type: "delay", delay }); queueMicrotask(callback); };
  `);
  const result = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, path.join(root, "bin/warp-setup.mjs"), ...args.map((arg) => arg.replaceAll("{ROOT}", root))], {
    cwd: root, encoding: "utf8", timeout: 10_000,
    env: { ...process.env, FIXTURE_ROOT: root, FIXTURE_RESPONSES: responseFile, FIXTURE_EVENTS: eventFile },
  });
  assert.ifError(result.error);
  assert.ok(fs.existsSync(eventFile), result.stderr);
  const events = fs.readFileSync(eventFile, "utf8").trim().split("\n").map(JSON.parse);
  return { root, ...result, events };
}

test("WARP setup writes the exact SOCKS configuration and registers its X25519 public key", (t) => {
  const result = setupFixture(t, [success("peer.example:2408")], ["--out", "{ROOT}/nested/wireproxy.conf", "--port", "4567", "--endpoint", "override.example:1234"]);
  assert.equal(result.status, 0);
  const file = path.join(result.root, "nested/wireproxy.conf");
  const config = fs.readFileSync(file, "utf8");
  const privateKey = config.match(/^PrivateKey = (.+)$/m)[1];
  assert.equal(config, [
    "[Interface]", "Address = 192.0.2.2/32", `PrivateKey = ${privateKey}`, "DNS = 1.1.1.1", "MTU = 1280", "",
    "[Peer]", "PublicKey = peer-fixture", "Endpoint = override.example:1234", "AllowedIPs = 0.0.0.0/0", "",
    "[Socks5]", "BindAddress = 127.0.0.1:4567", "",
  ].join("\n"));
  const request = result.events[0];
  assert.equal(request.url, "https://api.cloudflareclient.com/v0a2159/reg");
  assert.equal(request.options.method, "POST");
  assert.deepEqual(request.options.headers, { "User-Agent": "okhttp/3.12.1", "Content-Type": "application/json" });
  const rawPrivate = Buffer.from(privateKey, "base64");
  assert.equal(rawPrivate.length, 32);
  const key = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), rawPrivate]), type: "pkcs8", format: "der" });
  const publicKey = crypto.createPublicKey(key).export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
  assert.deepEqual(JSON.parse(request.options.body), { key: publicKey, install_id: "", fcm_token: "", referrer: "", warp_enabled: true, tos: "2020-06-12T00:00:00.000Z" });
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("WARP setup retries rate limits twice and preserves defaults and endpoint fallback", (t) => {
  const result = setupFixture(t, [
    { ok: false, status: 429, nonJson: true },
    { ok: false, status: 500, body: { errors: [{ message: "ratelimit fixture" }] } },
    success(),
  ]);
  assert.equal(result.status, 0);
  assert.deepEqual(result.events.filter(({ type }) => type === "delay").map(({ delay }) => delay), [3000, 6000]);
  const bodies = result.events.filter(({ type }) => type === "request").map(({ options }) => options.body);
  assert.equal(bodies.length, 3);
  assert.equal(new Set(bodies).size, 1);
  const config = fs.readFileSync(path.join(result.root, ".warp/wireproxy.conf"), "utf8");
  assert.match(config, /Endpoint = engage\.cloudflareclient\.com:2408\n/);
  assert.match(config, /BindAddress = 127\.0\.0\.1:40000\n$/);
});

test("WARP setup stops at three rate-limit attempts without writing a config", (t) => {
  const failure = { ok: false, status: 429, body: { errors: [{ message: "too many requests" }] } };
  const result = setupFixture(t, [failure, failure, failure]);
  assert.equal(result.status, 1);
  assert.equal(result.events.filter(({ type }) => type === "request").length, 3);
  assert.match(result.stderr, /WARP registration failed: too many requests/);
  assert.equal(fs.existsSync(path.join(result.root, ".warp/wireproxy.conf")), false);
});

test("WARP setup does not retry non-JSON or network failures", (t) => {
  for (const failure of [{ ok: false, status: 503, nonJson: true }, { networkError: true }]) {
    const result = setupFixture(t, [failure]);
    assert.equal(result.status, 1);
    assert.equal(result.events.length, 1);
    assert.equal(fs.existsSync(path.join(result.root, ".warp/wireproxy.conf")), false);
  }
});
