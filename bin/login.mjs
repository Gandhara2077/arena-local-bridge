#!/usr/bin/env node
// login.mjs — perform a real email/password login against arena.ai and store
// the session in the bridge's encrypted credential store.
//   node bin/login.mjs --email you@example.com --password 'secret'
//   node bin/login.mjs --email you@example.com   (prompts for password)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createInterface } from "node:readline/promises";
import { loadDotEnv, loadConfig } from "../src/config.mjs";
import { CredentialStore } from "../src/credentials.mjs";
import { ArenaBrowser } from "../src/arena-login.mjs";
import { log } from "../src/util.mjs";

async function promptPassword() {
  const input = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await input.question("Password: ")).trim();
  } finally {
    input.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const values = new Map();
  for (const [index, flag] of args.entries()) {
    if (!values.has(flag)) values.set(flag, args[index + 1]);
  }
  const email = values.get("--email") || values.get("-e");
  if (!email) {
    console.error("usage: node bin/login.mjs --email <email> [--password <password>]");
    process.exit(2);
  }
  const password = values.get("--password") || values.get("-p") || process.env.ARENA_PASSWORD || await promptPassword();

  const dataDir = process.env.DATA_DIR || path.join(os.homedir(), ".arena-bridge");
  const envPath = path.join(dataDir, ".env");
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const dotEnv = loadDotEnv(envPath);
  const config = loadConfig({ ...dotEnv, ...process.env }, { requireBridgeKey: false });

  // Provision a local encryption key if missing (persist to DATA_DIR/.env)
  let secret = dotEnv.STORAGE_ENCRYPTION_KEY;
  if (!secret) {
    secret = crypto.randomBytes(32).toString("hex");
    fs.appendFileSync(envPath, `\nSTORAGE_ENCRYPTION_KEY=${secret}\n`, { mode: 0o600 });
    log.info("login", "generated STORAGE_ENCRYPTION_KEY", { file: envPath });
  }

  const credentials = new CredentialStore({
    filePath: config.credentialsFile,
    secret,
    omniDbPath: config.omniDbPath,
    omniRoot: config.omniRoot,
  }).load();

  const browser = new ArenaBrowser({
    omniRoot: config.omniRoot,
    chromePath: config.chromePath,
    proxy: config.proxy,
  });
  try {
    log.info("login", "attempting arena.ai login", { email });
    const result = await browser.login(email, password);
    credentials.upsert({
      email: result.email,
      cookieHeader: result.cookieHeader,
      password: result.password,
      priority: 1,
    });
    log.info("login", "login OK, credentials stored encrypted", {
      email: result.email,
      file: config.credentialsFile,
      cookieExpiry: credentials.expirySummary(credentials.primary()),
    });
  } finally {
    await browser.close().catch(() => undefined);
  }
}

main().catch((error) => {
  log.error("login", "failed", { message: error.message });
  process.exit(1);
});
