#!/usr/bin/env node
// verify-session.mjs — full health check of a target arena session:
// 1) cookie validity  2) session page loads under the account
// 3) latest chat state  4) optional live probe (send a message + read reply)
// Usage:
//   node bin/verify-session.mjs <session-id> [--probe "message"]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadDotEnv, loadConfig } from "../src/config.mjs";
import { CredentialStore } from "../src/credentials.mjs";
import { ArenaBrowser } from "../src/arena-login.mjs";
import { Bridge } from "../src/bridge.mjs";
import { parseAgentOutput } from "../src/parser.mjs";
import { secondsToExpiry } from "../src/cookie.mjs";
import { sessionAccountEmail } from "../src/archive.mjs";
import { requireSecret } from "../src/secret.mjs";

const targetId = process.argv[2];
const probeIdx = process.argv.indexOf("--probe");
const probe = probeIdx >= 0 ? process.argv.slice(probeIdx + 1).join(" ") : "";
if (!targetId) {
  console.error("usage: node bin/verify-session.mjs <session-id> [--probe message]");
  process.exit(2);
}

const dataDir = process.env.DATA_DIR || path.join(process.env.HOME || os.homedir(), ".arena-bridge");
const dotEnv = loadDotEnv(path.join(dataDir, ".env"));
const config = loadConfig({ ...dotEnv, ...process.env }, { requireBridgeKey: false });
const secret = requireSecret(dotEnv);
const credentials = new CredentialStore({ filePath: config.credentialsFile, secret, omniDbPath: config.omniDbPath }).load();

// Drive the Session with the Account that created it — see credentials.forSession.
// A known-but-unusable owner is a hard stop: there is no correct account to use,
// and reporting health from the wrong one would be worse than not reporting.
let credential;
try {
  credential = credentials.forSession(sessionAccountEmail(config.archiveDir, targetId));
} catch (error) {
  console.log(JSON.stringify({ sessionId: targetId, error: { message: error.message, code: error.code || null } }, null, 1));
  process.exit(1);
}

const out = { sessionId: targetId, account: credential.email, checkedAt: new Date().toISOString() };

const browser = new ArenaBrowser({ omniRoot: config.omniRoot, chromePath: config.chromePath, proxy: config.proxy });
try {
  // 1) cookie validity
  const secs = secondsToExpiry(credential.cookieHeader);
  out.cookie = { expirySeconds: secs, valid: secs === null || secs > 0 };

  // 2) open the session page under the account
  const page = await browser.getPage(credential.cookieHeader, credential.updatedAt);
  await page.goto(`https://arena.ai/agent/${targetId}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(4_000);
  out.page = {
    url: page.url(),
    title: await page.title(),
    // if Arena shows "not found/unauthorized" it usually redirects or shows an error
    loaded: (await page.url()).includes(targetId),
  };
  // grab a tail of the transcript text to confirm content
  const bodyTail = await page.evaluate(() => (document.body?.innerText || "").slice(-1600));
  out.transcriptTail = bodyTail;

  // 3) optional live probe: send a message and read the reply
  if (probe) {
    const bridge = new Bridge({ config, credentials, recaptcha: null });
    await bridge.start();
    const bpage = await bridge.browser.getPage(credential.cookieHeader, credential.updatedAt);
    const state = { id: targetId, token: "", lastNodeId: null, requiresReview: false, toolsInitialized: false, updatedAt: Date.now() };
    await bpage.goto(`https://arena.ai/agent/${targetId}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await bridge.appendAgentMessage(bpage, state, probe);
    if (!state.token) {
      const t = await bridge.refreshAgentToken(bpage, targetId).catch(() => "");
      if (t) state.token = t;
    }
    const raw = await bridge.readAgentOutput(bpage, state);
    const parsed = parseAgentOutput(raw);
    out.probe = {
      sent: probe,
      text: (parsed.text || "").slice(0, 4000),
      nativeTools: [...new Set(parsed.nativeCalls.map((c) => c.name))].join(",") || null,
      lastNodeId: parsed.lastNodeId,
    };
    await bridge.browser.close().catch(() => undefined);
  }
} catch (error) {
  out.error = { message: error.message, stack: (error.stack || "").split("\n").slice(0, 4) };
  process.exitCode = 1;
} finally {
  await browser.close().catch(() => undefined);
}

console.log(JSON.stringify(out, null, 1));
