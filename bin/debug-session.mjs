#!/usr/bin/env node
// debug-session.mjs — inspect what an arena.ai session page shows for the
// logged-in account (helps diagnose "editor not found").
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadDotEnv, loadConfig } from "../src/config.mjs";
import { CredentialStore } from "../src/credentials.mjs";
import { ArenaBrowser } from "../src/arena-login.mjs";
import { sessionAccountEmail } from "../src/archive.mjs";
import { requireSecret } from "../src/secret.mjs";

const targetId = process.argv[2];
if (!targetId) {
  console.error("usage: node bin/debug-session.mjs <arena-session-id>");
  process.exit(2);
}

const dataDir = process.env.DATA_DIR || path.join(process.env.HOME || os.homedir(), ".arena-bridge");
const dotEnv = loadDotEnv(path.join(dataDir, ".env"));
const config = loadConfig({ ...dotEnv, ...process.env }, { requireBridgeKey: false });
const secret = requireSecret(dotEnv);
const credentials = new CredentialStore({ filePath: config.credentialsFile, secret, omniDbPath: config.omniDbPath }).load();

// Drive the Session with the Account that created it — see credentials.forSession.
// Diagnosing "editor not found" under the wrong account would send us chasing a
// page state that was never the one being asked about.
let credential;
try {
  credential = credentials.forSession(sessionAccountEmail(config.archiveDir, targetId));
} catch (error) {
  console.log(JSON.stringify({ event: "error", targetId, message: error.message, code: error.code || null }));
  process.exit(1);
}

const browser = new ArenaBrowser({
  omniRoot: config.omniRoot,
  chromePath: config.chromePath,
  proxy: config.proxy,
});
try {
  const page = await browser.getPage(credential.cookieHeader, credential.updatedAt);
  await page.goto(`https://arena.ai/agent/${targetId}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(4_000);
  console.log(JSON.stringify({
    event: "page",
    title: await page.title(),
    url: page.url(),
    hasEditor: (await page.locator('[contenteditable="true"]').count()) > 0,
    bodySnippet: (await page.evaluate(() => document.body ? document.body.innerText.slice(0, 700) : "")),
  }));
} catch (error) {
  console.log(JSON.stringify({ event: "error", message: error.message, stack: (error.stack || "").split("\n").slice(0, 4) }));
  process.exitCode = 1;
} finally {
  await browser.close().catch(() => undefined);
}
