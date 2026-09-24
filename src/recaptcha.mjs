// recaptcha.mjs — cached reCAPTCHA v3 token broker. Tokens live ~120s, so we
// cache for a safe TTL and refresh lazily (or on demand via /recaptcha).
import { log } from "./util.mjs";

export class RecaptchaBroker {
  constructor({ browser, siteKey, ttlMs = 110_000 }) {
    this.browser = browser;
    this.siteKey = siteKey;
    this.ttlMs = ttlMs;
    this.token = null;
    this.tokenAt = 0;
    this.errors = 0;
    this.lastError = null;
    this.generations = 0;
  }

  isFresh() {
    return typeof this.token === "string" && Date.now() - this.tokenAt < this.ttlMs;
  }

  async get(cookieHeader, force = false) {
    if (!force && this.isFresh()) return this.token;
    try {
      this.token = await this.browser.freshRecaptchaToken(cookieHeader, this.siteKey);
      this.tokenAt = Date.now();
      this.generations += 1;
      this.lastError = null;
      log.info("recaptcha", "token generated", { length: this.token.length });
      return this.token;
    } catch (error) {
      this.errors += 1;
      this.lastError = error.message;
      if (this.isFresh()) return this.token; // degraded: reuse last valid token
      throw error;
    }
  }

  status() {
    return {
      cached: this.isFresh(),
      ageMs: this.token ? Date.now() - this.tokenAt : null,
      ttlMs: this.ttlMs,
      generations: this.generations,
      errors: this.errors,
      lastError: this.lastError,
    };
  }
}
