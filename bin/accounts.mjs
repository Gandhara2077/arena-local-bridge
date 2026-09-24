#!/usr/bin/env node
// accounts.mjs — inspect and manage the Arena account pool.
//
//   node bin/accounts.mjs list
//   node bin/accounts.mjs add --email <e> --password <p> [--priority N]
//   node bin/accounts.mjs disable <email> [reason]
//   node bin/accounts.mjs enable <email>
//   node bin/accounts.mjs priority <email> <n>
//
// An account is disabled automatically when Arena signs it in but refuses to
// serve it (a restricted account). Re-enable it here after fixing whatever is
// wrong, otherwise it stays out of rotation.
import os from "node:os";
import path from "node:path";
import { loadDotEnv, loadConfig } from "../src/config.mjs";
import { CredentialStore } from "../src/credentials.mjs";
import { ArenaBrowser } from "../src/arena-login.mjs";
import { requireSecret } from "../src/secret.mjs";

const [, , command, ...rest] = process.argv;

function flag(name) {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : "";
}

const dataDir = process.env.DATA_DIR || path.join(process.env.HOME || os.homedir(), ".arena-bridge");
const dotEnv = loadDotEnv(path.join(dataDir, ".env"));
const config = loadConfig({ ...dotEnv, ...process.env }, { requireBridgeKey: false });
const store = new CredentialStore({
  filePath: config.credentialsFile,
  secret: requireSecret(dotEnv),
  omniDbPath: config.omniDbPath,
}).load();

switch (command) {
  case "list":
  case undefined: {
    if (!store.accounts.length) {
      console.log("no accounts stored in " + config.credentialsFile);
      break;
    }
    console.log(`primary: ${store.primary()?.email || "(none — every account is disabled)"}`);
    for (const a of store.list()) {
      const expiry = a.cookieExpirySeconds === null ? "?" : `${a.cookieExpirySeconds}s`;
      console.log(
        [
          a.disabled ? "DISABLED" : "  ok    ",
          `priority=${a.priority}`,
          a.email,
          `cookie=${expiry}`,
          a.hasPassword ? "password=yes" : "password=NO",
          a.disabled && a.lastError ? `reason=${a.lastError}` : "",
        ]
          .filter(Boolean)
          .join("  ")
      );
    }
    break;
  }

  case "add": {
    const email = flag("email");
    const password = flag("password");
    const priority = flag("priority");
    if (!email || !password) {
      console.error("usage: node bin/accounts.mjs add --email <e> --password <p> [--priority N]");
      process.exit(2);
    }
    const browser = new ArenaBrowser({ omniRoot: config.omniRoot, chromePath: config.chromePath, proxy: config.proxy });
    try {
      const result = await browser.login(email, password);
      store.upsert({
        email: result.email,
        cookieHeader: result.cookieHeader,
        password: result.password,
        priority: priority === "" ? 1 : Number(priority),
      });
      console.log(`added ${result.email} (verified usable)`);
    } catch (error) {
      console.error(`not added: ${error.message}`);
      process.exitCode = 1;
    } finally {
      await browser.close().catch(() => undefined);
    }
    break;
  }

  case "disable": {
    const email = rest[0];
    if (!email) {
      console.error("usage: node bin/accounts.mjs disable <email> [reason]");
      process.exit(2);
    }
    const ok = store.disable(email, rest.slice(1).join(" ") || "manually disabled");
    console.log(ok ? `disabled ${email}` : `no such account: ${email}`);
    process.exitCode = ok ? 0 : 1;
    break;
  }

  case "enable": {
    const email = rest[0];
    if (!email) {
      console.error("usage: node bin/accounts.mjs enable <email>");
      process.exit(2);
    }
    const ok = store.enable(email);
    console.log(ok ? `enabled ${email}` : `no such account: ${email}`);
    process.exitCode = ok ? 0 : 1;
    break;
  }

  case "priority": {
    const [email, value] = rest;
    if (!email || value === undefined) {
      console.error("usage: node bin/accounts.mjs priority <email> <n>");
      process.exit(2);
    }
    const ok = store.setPriority(email, Number(value));
    console.log(ok ? `${email} priority = ${Number(value)}` : `no such account: ${email}`);
    process.exitCode = ok ? 0 : 1;
    break;
  }

  default:
    console.error(`unknown command: ${command} (try: list, add, disable, enable, priority)`);
    process.exit(2);
}
