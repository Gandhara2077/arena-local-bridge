#!/usr/bin/env node
// read-session.mjs — read the latest assistant reply from an arena session
// (after it has started running) and capture a screenshot. Usage:
//   node bin/read-session.mjs <arena-session-id> <screenshot-path>
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadDotEnv, loadConfig } from "../src/config.mjs";
import { CredentialStore } from "../src/credentials.mjs";
import { sessionAccountEmail } from "../src/archive.mjs";
import { Bridge } from "../src/bridge.mjs";
import { parseAgentOutput } from "../src/parser.mjs";
import { requireSecret } from "../src/secret.mjs";

const targetId = process.argv[2];
const shotPath = process.argv[3] || "/tmp/attach-proof.png";
if (!targetId) {
  console.error("usage: node bin/read-session.mjs <arena-session-id> [screenshot.png]");
  process.exit(2);
}
const dataDir = process.env.DATA_DIR || path.join(process.env.HOME || os.homedir(), ".arena-bridge");
const dotEnv = loadDotEnv(path.join(dataDir, ".env"));
const config = loadConfig({ ...dotEnv, ...process.env }, { requireBridgeKey: false });
const secret = requireSecret(dotEnv);
const credentials = new CredentialStore({ filePath: config.credentialsFile, secret, omniDbPath: config.omniDbPath }).load();

const bridge = new Bridge({ config, credentials, recaptcha: null });
try {
  await bridge.start();
  // Drive the Session with the Account that created it — see credentials.forSession.
  const credential = credentials.forSession(sessionAccountEmail(config.archiveDir, targetId));
  const page = await bridge.browser.getPage(credential.cookieHeader, credential.updatedAt);
  // go to the session page and refresh the public token
  await page.goto(`https://arena.ai/agent/${targetId}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(3_000);
  let token = await bridge.refreshAgentToken(page, targetId).catch(() => "");
  const state = { id: targetId, token, lastNodeId: null, requiresReview: false, toolsInitialized: false, updatedAt: Date.now() };

  // read output (fresh token)
  const raw = await bridge.readAgentOutput(page, state);
  fs.writeFileSync("/tmp/read-last-sse.txt", raw, { mode: 0o600 });
  const parsed = parseAgentOutput(raw);
  if (parsed.token) token = parsed.token;
  const nativeNames = [...new Set(parsed.nativeCalls.map((c) => c.name))].join(", ");

  // screenshot the page (current state)
  await page.screenshot({ path: shotPath, fullPage: false }).catch(() => undefined);

  console.log(
    JSON.stringify({
      event: "read",
      session: targetId,
      text: (parsed.text || "").slice(0, 5000),
      reasoning: (parsed.reasoning || "").slice(0, 400),
      nativeToolCalls: nativeNames || null,
      lastNodeId: parsed.lastNodeId,
      screenshot: shotPath,
    })
  );
} catch (error) {
  console.log(JSON.stringify({ event: "error", message: error.message, stack: (error.stack || "").split("\n").slice(0, 4) }));
  process.exitCode = 1;
} finally {
  await bridge.browser.close().catch(() => undefined);
}
