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
    // The mint in flight, shared with whoever asks while it runs.
    this.pendingMint = null;
    this.errors = 0;
    this.lastError = null;
    this.generations = 0;
  }

  isFresh() {
    if (typeof this.token !== "string") return false;
    return Date.now() - this.tokenAt < this.ttlMs;
  }

  /** `credential` is the whole credential, not just its cookie header: the
   *  Account is what selects the browser context now. */
  async get(credential, force = false) {
    if (!force && this.isFresh()) return this.token;
    // One mint at a time. A token is minted on a page of its own, and two
    // concurrent requests would both navigate that one page — each finding the
    // other's document. They want the same token anyway, so the second waits.
    if (!this.pendingMint) {
      const mint = (async () => {
        try {
          this.token = await this.browser.freshRecaptchaToken(credential, this.siteKey);
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
      })();
      this.pendingMint = mint.finally(() => {
        this.pendingMint = null;
      });
    }
    return this.pendingMint;
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
