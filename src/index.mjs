#!/usr/bin/env node
// arena-bridge — standalone entry point:
//  1) provisions DATA_DIR + .env (auto-generates an encryption key),
//  2) loads/creates credentials (login with email/password via bin/login.mjs),
//  3) boots the OpenAI-compatible HTTP bridge,
//  4) auto-refreshes the arena.ai session before the cookie expires,
//  5) graceful shutdown.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { loadDotEnv, loadConfig } from "./config.mjs";
import { CredentialStore } from "./credentials.mjs";
import { Bridge } from "./bridge.mjs";
import { RecaptchaBroker } from "./recaptcha.mjs";
import { createServer } from "./server.mjs";
import { log } from "./util.mjs";
import { requireSecret } from "./secret.mjs";

const STARTED_AT = Date.now();

async function main() {
  // 1. Environment (DATA_DIR/.env overrides process env only when unset)
  const dataDir = process.env.DATA_DIR || path.join(process.env.HOME || "/root", ".arena-bridge");
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const dotEnv = loadDotEnv(path.join(dataDir, ".env"));
  const mergedEnv = { ...dotEnv, ...process.env };
  const config = loadConfig(mergedEnv);
  log.info("boot", "arena-bridge starting", {
    version: "5.0.0",
    host: config.host,
    port: config.port,
    dataDir: config.dataDir,
  });

  // 2. Provision a local encryption key (so credentials are encrypted at rest)
  if (!dotEnv.STORAGE_ENCRYPTION_KEY) {
    const key = crypto.randomBytes(32).toString("hex");
    fs.appendFileSync(config.envPath, `\nSTORAGE_ENCRYPTION_KEY=${key}\n`, { mode: 0o600 });
    dotEnv.STORAGE_ENCRYPTION_KEY = key;
    log.info("boot", "generated STORAGE_ENCRYPTION_KEY and wrote to " + config.envPath);
  }

  // 3. Self-checks (fail fast with precise messages)
  const checks = [];
  if (config.chromePath && !fs.existsSync(config.chromePath)) {
    checks.push(`chromium binary not found at ${config.chromePath} (set ARENA_AGENT_CHROME)`);
  }
  if (!fs.existsSync(config.dataDir)) {
    checks.push(`DATA_DIR does not exist: ${config.dataDir}`);
  }
  if (checks.length) {
    for (const c of checks) log.error("boot", c);
    process.exit(1);
  }

  // 4. Credentials
  const secret = requireSecret(dotEnv);
  const credentials = new CredentialStore({
    filePath: config.credentialsFile,
    secret,
    omniDbPath: config.omniDbPath,
  }).load();
  let credential;
  try {
    credential = credentials.ensure({ migrateFromOmni: config.migrateFromOmni });
  } catch (error) {
    log.error(
      "boot",
      error.message +
        " Run: node bin/login.mjs --email <your-arena-email> --password <your-password> (password is stored encrypted)."
    );
    process.exit(1);
  }
  log.info("boot", "credential ready", {
    account: credential.email,
    cookieExpiry: credentials.expirySummary(credential),
    autoRefresh: Boolean(credentials.loginSecretFor(credential)),
  });

  // 5. Browser + bridge + recaptcha
  const bridge = new Bridge({ config, credentials, recaptcha: null, startedAt: STARTED_AT });
  const recaptcha = new RecaptchaBroker({
    browser: bridge.browser,
    siteKey: config.recaptchaSiteKey,
    ttlMs: config.recaptchaTtlMs,
  });
  bridge.recaptcha = recaptcha;

  await bridge.start();

  // 6. HTTP server
  const server = createServer({ bridge, config });
  server.listen(config.port, config.host, () => {
    log.info("boot", `listening on http://${config.host}:${config.port}`, { mode: "stateless-claude-tools" });
  });

  /**
   * Walk the accounts in priority order until one both signs in AND is actually
   * usable. Arena signs in and hands out a valid-looking cookie for a restricted
   * account, then serves every session as a visitor — so "login returned 200" is
   * not enough. An account that fails here is disabled and the next one is tried,
   * instead of the bridge reporting healthy while every session fails.
   */
  async function ensureUsableAccount() {
    const tried = [];
    for (;;) {
      const account = credentials.selectNext(tried);
      if (!account) return null;
      const loginSecret = credentials.loginSecretFor(account);
      if (!loginSecret?.password) {
        log.warn("refresh", "no stored password; cannot verify account", { account: account.email });
        credentials.disable(account.email, "no stored password for verification");
        tried.push(account.email);
        continue;
      }
      try {
        const result = await bridge.browser.login(loginSecret.email, loginSecret.password);
        credentials.replaceCookie(result.email, result.cookieHeader);
        await bridge.browser.close(); // force a fresh context with the new cookie
        log.info("refresh", "account verified and refreshed", { account: result.email });
        return result.email;
      } catch (error) {
        credentials.disable(account.email, error.message);
        tried.push(account.email);
        log.error("refresh", "account unusable; trying next", { account: account.email, error: error.message });
      }
    }
  }

  // 7. Verify the account now that the port is up (a slow login must not make
  // start-gui.bat's 6-second port probe report a failed start).
  ensureUsableAccount()
    .then((email) => {
      if (email) log.info("boot", "usable account confirmed", { account: email });
      else log.error("boot", "no usable Arena account", { error: credentials.lastLoginError });
    })
    .catch((error) => log.error("boot", "account verification crashed", { error: error.message }));

  // 8. Auto-refresh loop: re-login when the auth cookie approaches expiry
  const refreshInterval = Math.max(60_000, config.refreshMarginSec * 1000);
  const refreshTimer = setInterval(async () => {
    const account = credentials.primary();
    if (!account) {
      log.error("refresh", "no usable account; attempting to recover", { error: credentials.lastLoginError });
      await ensureUsableAccount().catch(() => undefined);
      return;
    }
    if (!credentials.needsRefresh(account, config.refreshMarginSec)) return;
    log.info("refresh", "cookie near expiry; re-logging in", {
      account: account.email,
      expiry: credentials.expirySummary(account),
    });
    await ensureUsableAccount().catch(() => undefined);
  }, refreshInterval);
  refreshTimer.unref?.();

  // 8. Graceful shutdown
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("boot", "shutting down");
    clearInterval(refreshTimer);
    server.close();
    await bridge.browser.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.on("unhandledRejection", (reason) => {
    log.error("boot", "unhandledRejection", { error: String(reason) });
  });
}

main().catch((error) => {
  log.error("boot", "fatal", { message: error.message, stack: error.stack });
  process.exit(1);
});
