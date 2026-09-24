#!/usr/bin/env node
// selftest.mjs — end-to-end check: credentials present, browser launches,
// a real Arena Agent session can be created and answered.
// Usage: DATA_DIR=... ARENA_AGENT_BRIDGE_KEY=... node bin/selftest.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadDotEnv, loadConfig } from "../src/config.mjs";
import { CredentialStore } from "../src/credentials.mjs";
import { Bridge } from "../src/bridge.mjs";
import { parseAgentOutput } from "../src/parser.mjs";
import { log } from "../src/util.mjs";
import { requireSecret } from "../src/secret.mjs";

async function main() {
  const dataDir = process.env.DATA_DIR || path.join(os.homedir(), ".arena-bridge");
  const dotEnv = loadDotEnv(path.join(dataDir, ".env"));
  const config = loadConfig({ ...dotEnv, ...process.env }, { requireBridgeKey: false });
  const secret = requireSecret(dotEnv);
  const credentials = new CredentialStore({
    filePath: config.credentialsFile,
    secret,
    omniDbPath: config.omniDbPath,
    omniRoot: config.omniRoot,
  }).load();

  const account = credentials.primary();
  if (!account) {
    console.log("SELFTEST FAIL: no credentials. Run: node bin/login.mjs --email <e> --password <p>");
    process.exit(1);
  }
  console.log(`SELFTEST account=${account.email} cookieExpiry=${credentials.expirySummary(account)}`);

  const bridge = new Bridge({ config, credentials, recaptcha: null });
  await bridge.start();
  try {
    const page = await bridge.browser.getPage(account.cookieHeader, account.updatedAt);
    // tiny probe session
    const state = await bridge.createAgentSession(
      page,
      "Reply with exactly: BRIDGE_OK"
    );
    console.log(`SELFTEST created session ${state.id}`);
    const raw = await bridge.readAgentOutput(page, state);
    const parsed = parseAgentOutput(raw);
    const ok = /bridge_ok/i.test(parsed.text || "");
    console.log(`SELFTEST reply=${JSON.stringify((parsed.text || "").slice(0, 120))}`);
    console.log(ok ? "SELFTEST PASS" : "SELFTEST PARTIAL (session works, reply text differs)");
    process.exit(ok ? 0 : 2);
  } finally {
    await bridge.browser.close().catch(() => undefined);
  }
}

main().catch((error) => {
  log.error("selftest", "failed", { message: error.message });
  console.log("SELFTEST FAIL");
  process.exit(1);
});
