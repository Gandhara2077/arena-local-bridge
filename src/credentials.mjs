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
    const primary = this.primary();
    if (primary) return primary;
    if (this.accounts.length) {
      // Accounts exist but all were rejected — say WHY, not "no credentials".
      this.lastLoginError =
        `All ${this.accounts.length} Arena account(s) are unusable: ` +
        this.accounts.map((a) => `${a.email} (${a.lastError || "unknown"})`).join("; ");
      throw new Error(this.lastLoginError);
    }
    if (migrateFromOmni && this.omniDbPath) {
      const migrated = this.#migrateFromOmni();
      if (migrated) return migrated;
    }
    this.lastLoginError =
      "No Arena credentials found. Run: node bin/login.mjs --email <email> --password <password> (stored encrypted).";
    throw new Error(this.lastLoginError);
  }

  /** Case-insensitive account lookup — the store's one identity rule. */
  #find(email) {
    const needle = String(email).toLowerCase();
    return this.accounts.find((a) => a.email.toLowerCase() === needle) || null;
  }

  upsert({ email, cookieHeader, password, priority = 1 }) {
    const existing = this.#find(email);
    const entry = {
      email: String(email),
      cookieHeader: this.#encryptCookie(String(cookieHeader)),
      loginSecret:
        typeof password === "string" && password
          ? encrypt(JSON.stringify({ email: String(email), password }), this.key)
          : existing?.loginSecret || "",
      updatedAt: new Date().toISOString(),
      // NOT `Number(priority) || 1`: that made priority 0 unusable (0 is falsy),
      // so nothing could ever outrank the first account.
      priority: Number.isFinite(Number(priority)) ? Number(priority) : 1,
      // A fresh upsert means a login just worked, so clear any prior rejection.
      disabled: false,
      lastError: null,
    };
    if (existing) Object.assign(existing, entry);
    else this.accounts.push(entry);
    this.save();
    this.lastLoginError = null;
    return entry;
  }

  replaceCookie(email, cookieHeader) {
    const account = this.#find(email);
    if (!account) return false;
    account.cookieHeader = this.#encryptCookie(String(cookieHeader));
    account.updatedAt = new Date().toISOString();
    // A cookie that just refreshed proves the account works again.
    account.disabled = false;
    account.lastError = null;
    this.save();
    return true;
  }

  /** Order accounts by priority (then file order). Disabled ones sort last. */
  #ordered() {
    return [...this.accounts].sort((a, b) => {
      const da = a.disabled ? 1 : 0;
      const db = b.disabled ? 1 : 0;
      if (da !== db) return da - db;
      return Number(a.priority ?? 1) - Number(b.priority ?? 1);
    });
  }

  /**
   * The account to use: highest priority that has not been rejected. Returns
   * null when every account is disabled — callers should surface lastLoginError
   * rather than silently driving a dead session.
   */
  primary() {
    // Same selection as selectNext() with nothing excluded — one code path.
    return this.selectNext([]);
  }

  /**
   * Next usable account other than the ones already tried, or null. Used to
   * fail over when the current account turns out to be restricted.
   */
  selectNext(exclude = []) {
    const skip = new Set(exclude.map((e) => String(e).toLowerCase()));
    const next = this.#ordered().find((a) => !a.disabled && !skip.has(a.email.toLowerCase()));
    if (!next) return null;
    return { ...next, cookieHeader: decrypt(next.cookieHeader, this.key) };
  }

  /** Reject an account (login failed, or the session is not actually usable). */
  disable(email, reason = "") {
    const account = this.#find(email);
    if (!account) return false;
    account.disabled = true;
    account.lastError = String(reason || "disabled");
    account.disabledAt = new Date().toISOString();
    this.lastLoginError = `${account.email}: ${account.lastError}`;
    this.save();
    log.warn("credentials", "account disabled", { account: maskEmail(account.email), reason: account.lastError });
    return true;
  }

  enable(email) {
    const account = this.#find(email);
    if (!account) return false;
    account.disabled = false;
    account.lastError = null;
    this.save();
    return true;
  }

  setPriority(email, priority) {
    const account = this.#find(email);
    if (!account) return false;
    account.priority = Number.isFinite(Number(priority)) ? Number(priority) : 1;
    this.save();
    return true;
  }

  /** Safe summary for /health and operator tools. Never includes cookie values. */
  list() {
    return this.#ordered().map((a) => ({
      email: a.email,
      priority: Number(a.priority ?? 1),
      updatedAt: a.updatedAt || null,
      hasPassword: Boolean(a.loginSecret),
      disabled: Boolean(a.disabled),
      lastError: a.lastError || null,
      // One unreadable cookie must not take /health down with it.
      cookieExpirySeconds: this.#expiryOf(a),
    }));
  }

  #expiryOf(account) {
    try {
      return secondsToExpiry(decrypt(account.cookieHeader, this.key));
    } catch {
      return null;
    }
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
