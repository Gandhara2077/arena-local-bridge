// credentials.mjs — encrypted credential store (AES-256-GCM JSON file),
// fully standalone. Optional one-time migration from an omni-route style
// sqlite vault is opt-in (ARENA_MIGRATE_FROM_OMNI=1 + ARENA_OMNI_DB + OMNI_ROOT).
import fs from "node:fs";
import { createRequire } from "node:module";
import { deriveKey, encrypt, decrypt } from "./crypto.mjs";
import { secondsToExpiry } from "./cookie.mjs";
import { log, maskEmail } from "./util.mjs";

const require = createRequire(import.meta.url);

export class CredentialStore {
  constructor({ filePath, secret, omniDbPath = "", omniRoot = "" }) {
    this.filePath = filePath;
    this.key = deriveKey(secret);
    this.omniDbPath = omniDbPath;
    this.omniRoot = omniRoot;
    this.accounts = []; // [{email, cookieHeader, loginSecret(enc), updatedAt, priority}]
    this.lastLoginError = null;
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      this.accounts = Array.isArray(parsed.accounts) ? parsed.accounts : [];
      log.info("credentials", `loaded ${this.accounts.length} account(s) from ${this.filePath}`);
    } catch (error) {
      if (error.code !== "ENOENT") log.warn("credentials", "credential file unreadable", { error: String(error.message) });
      this.accounts = [];
    }
    return this;
  }

  save() {
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, accounts: this.accounts }, null, 2), {
      mode: 0o600,
    });
    fs.renameSync(tmp, this.filePath);
    fs.chmodSync(this.filePath, 0o600);
  }

  /** Ensure credentials exist: migrate from omni (opt-in), otherwise a clear error. */
  ensure({ migrateFromOmni = false } = {}) {
    if (this.primary()) return this.primary();
    if (migrateFromOmni && this.omniDbPath) {
      const migrated = this.#migrateFromOmni();
      if (migrated) return migrated;
    }
    this.lastLoginError =
      "No Arena credentials found. Run: node bin/login.mjs --email <email> --password <password> (stored encrypted).";
    throw new Error(this.lastLoginError);
  }

  upsert({ email, cookieHeader, password, priority = 1 }) {
    const existing = this.accounts.find((a) => a.email.toLowerCase() === String(email).toLowerCase());
    const entry = {
      email: String(email),
      cookieHeader: this.#encryptCookie(String(cookieHeader)),
      loginSecret:
        typeof password === "string" && password
          ? encrypt(JSON.stringify({ email: String(email), password }), this.key)
          : existing?.loginSecret || "",
      updatedAt: new Date().toISOString(),
      priority: Number(priority) || 1,
    };
    if (existing) Object.assign(existing, entry);
    else this.accounts.push(entry);
    this.save();
    this.lastLoginError = null;
    return entry;
  }

  replaceCookie(email, cookieHeader) {
    const account = this.accounts.find((a) => a.email.toLowerCase() === String(email).toLowerCase());
    if (!account) return false;
    account.cookieHeader = this.#encryptCookie(String(cookieHeader));
    account.updatedAt = new Date().toISOString();
    this.save();
    return true;
  }

  /** Consumers get a shallow copy with the cookieHeader decrypted. */
  primary() {
    const account = [...this.accounts].sort((a, b) => Number(a.priority || 1) - Number(b.priority || 1))[0];
    if (!account) return null;
    return { ...account, cookieHeader: decrypt(account.cookieHeader, this.key) };
  }

  #encryptCookie(header) {
    if (!header || header.startsWith("enc:v1:")) return header; // avoid double encryption
    return encrypt(header, this.key);
  }

  loginSecretFor(account) {
    try {
      if (!account?.loginSecret) return null;
      const parsed = JSON.parse(decrypt(account.loginSecret, this.key));
      if (typeof parsed.email === "string" && typeof parsed.password === "string") return parsed;
    } catch {
      return null;
    }
    return null;
  }

  expirySummary(account) {
    const secs = secondsToExpiry(account?.cookieHeader);
    return secs === null ? "unknown" : `${Math.max(0, secs)}s`;
  }

  needsRefresh(account, marginSec = 1200) {
    const secs = secondsToExpiry(account?.cookieHeader);
    if (secs === null) return false; // unknown expiry -> assume fresh
    return secs < marginSec;
  }

  #migrateFromOmni() {
    if (!this.omniDbPath || !this.omniRoot) return null; // opt-in only
    let Database = null;
    try {
      Database = require(`${this.omniRoot}/node_modules/better-sqlite3`);
    } catch (e) {
      log.warn("credentials", "better-sqlite3 unavailable for migration", { error: String(e.message) });
      return null;
    }
    try {
      const db = new Database(this.omniDbPath, { readonly: true });
      try {
        const row = db
          .prepare(
            "SELECT api_key, provider_specific_data, email, priority FROM provider_connections WHERE provider='lmarena' AND is_active=1 ORDER BY priority LIMIT 1"
          )
          .get();
        if (!row?.api_key) {
          log.warn("credentials", "omni migration: no active lmarena row found");
          return null;
        }
        const cookieHeader = decrypt(row.api_key, this.key);
        let loginSecret = null;
        try {
          const psd = JSON.parse(row.provider_specific_data || "{}");
          if (psd?.loginSecret) {
            const parsed = JSON.parse(decrypt(psd.loginSecret, this.key) || "{}");
            loginSecret = typeof parsed?.password === "string" ? parsed : null;
          }
        } catch {
          loginSecret = null;
        }
        if (!loginSecret?.password) {
          log.warn("credentials", "omni migration: loginSecret missing; cookie migrated, auto-refresh disabled", {
            email: maskEmail(row.email),
          });
        }
        this.upsert({
          email: row.email,
          cookieHeader,
          password: loginSecret?.password ?? "",
          priority: Number(row.priority) || 1,
        });
        log.info("credentials", "migrated arena credentials from omni-route vault (opt-in)", {
          email: maskEmail(row.email),
          cookieExpiry: this.expirySummary(this.primary()),
        });
        return this.primary();
      } finally {
        db.close();
      }
    } catch (error) {
      log.warn("credentials", "omni migration failed", { error: String(error.message) });
      return null;
    }
  }
}
