// arena-login.mjs — real email/password login against arena.ai using
// Playwright, plus reCAPTCHA v3 token generation. Fully standalone.
import { createRequire } from "node:module";
import { retry, log, sleep } from "./util.mjs";
import { cookieHeaderToObjects } from "./cookie.mjs";

const require = createRequire(import.meta.url);

export function resolvePlaywright(omniRoot) {
  const candidates = [];
  if (omniRoot) candidates.push(`${omniRoot}/node_modules/playwright`, `${omniRoot}/node_modules/playwright-core`);
  candidates.push("playwright", "playwright-core");
  for (const candidate of candidates) {
    try {
      const mod = require(candidate);
      if (mod?.chromium) return mod;
    } catch {
      /* try next */
    }
  }
  throw new Error(
    `Playwright not resolvable (tried: ${candidates.join(", ")}). Run: npm install playwright && npx playwright install chromium`
  );
}

export class ArenaBrowser {
  constructor({ omniRoot = "", chromePath = "", proxy = "", userAgent } = {}) {
    this.pw = resolvePlaywright(omniRoot);
    this.chromePath = chromePath;
    this.proxy = proxy;
    // Leave userAgent undefined so Playwright sends its REAL engine UA. A
    // hardcoded UA that doesn't match the actual Chromium build is a strong
    // bot tell (reCAPTCHA cross-checks UA vs engine), and was causing
    // "recaptcha validation failed". Let the genuine engine speak for itself.
    this.userAgent = userAgent || "";
    this.browser = null;
    this.context = null;
    this.page = null;
    this.recaptchaPage = null;
    this.credentialSignature = "";
  }

  async launch() {
    if (this.browser) {
      try {
        return this.browser;
      } catch {
        this.browser = null;
      }
    }
    return retry(
      async () => {
        const args = ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"];
        if (this.proxy) args.push(`--proxy-server=${this.proxy}`);
        const launchOpts = { headless: process.env.ARENA_HEADED !== "1", args };
        if (this.chromePath) launchOpts.executablePath = this.chromePath;
        this.browser = await this.pw.chromium.launch(launchOpts);
        return this.browser;
      },
      { attempts: 3, baseMs: 1000, maxMs: 8000, label: "chromium-launch" }
    );
  }

  async getPage(cookieHeader = "", signature = "") {
    const browser = await this.launch();
    if (!this.context || this.credentialSignature !== signature) {
      await this.context?.close().catch(() => undefined);
      this.recaptchaPage = null;
      const contextOpts = {
        viewport: { width: 1440, height: 900 },
        locale: process.env.ARENA_LOCALE || "zh-CN",
      };
      if (this.userAgent) contextOpts.userAgent = this.userAgent;
      this.context = await browser.newContext(contextOpts);
      // Hide Playwright automation signals so reCAPTCHA v3 scores the session as
      // a genuine browser (same reason the Arena模型助手 WebView2 build passes:
      // a real browser engine reports navigator.webdriver === false). Mirrors the
      // --disable-blink-features=AutomationControlled launch flag above.
      await this.context.addInitScript(() => {
        try {
          Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false, configurable: true });
        } catch {}
        try {
          Object.defineProperty(navigator, "webdriver", { get: () => false, configurable: true });
        } catch {}
        try {
          // Drop common CDP/Playwright artifacts that bot detectors fingerprint.
          delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array;
          delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise;
          delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol;
        } catch {}
        // Spoof the rest of the navigator fingerprint so it reads like a normal
        // desktop Edge/Chrome (mirrors the Arena模型助手 FingerprintEnvironment.js,
        // which fakes these same props — reCAPTCHA cross-checks them).
        const spoof = {
          platform: "Win32",
          vendor: "Google Inc.",
          hardwareConcurrency: 8,
          deviceMemory: 8,
          maxTouchPoints: 0,
          language: "zh-CN",
          languages: ["zh-CN", "zh"],
        };
        for (const [k, v] of Object.entries(spoof)) {
          try {
            Object.defineProperty(Navigator.prototype, k, { get: () => v, configurable: true });
          } catch {}
        }
      });
      if (cookieHeader) await this.context.addCookies(cookieHeaderToObjects(cookieHeader));
      this.page = await this.context.newPage();
      this.credentialSignature = signature;
    }
    if (!this.page || this.page.isClosed()) this.page = await this.context.newPage();
    return this.page;
  }

  async close() {
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.context = null;
    this.browser = null;
    this.page = null;
    this.recaptchaPage = null;
  }

  /**
   * Perform an email/password login on arena.ai.
   * Returns { email, cookieHeader, password } on success.
   */
  async login(email, password) {
    const browser = await this.launch();
    const context = await browser.newContext({ userAgent: this.userAgent });
    const page = await context.newPage();
    try {
      let result = null;
      await page.goto("https://arena.ai/", { waitUntil: "domcontentloaded", timeout: 60_000 });
      for (let attempt = 0; attempt < 3; attempt++) {
        result = await page.evaluate(
          async ({ email, password }) => {
            const response = await fetch("/nextjs-api/sign-in/email", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ email, password }),
            });
            return { status: response.status, text: await response.text() };
          },
          { email, password }
        );
        if (result.status === 200) break;
        if (result.status !== 429 && !/just a moment/i.test(result.text)) break;
        log.warn("arena-login", `login rate-limited/blocked (${result.status}); retrying`, { attempt: attempt + 1 });
        await page.goto("https://arena.ai/", { waitUntil: "networkidle", timeout: 60_000 }).catch(() => undefined);
        await sleep(8_000);
      }
      if (result?.status !== 200) {
        const hint = String(result?.text || "").slice(0, 240);
        throw new Error(`Arena login failed (${result?.status}): ${hint}`);
      }
      await page.waitForTimeout(1_500);
      const cookies = await context.cookies("https://arena.ai");
      const auth = cookies.filter((c) => c.name.startsWith("arena-auth-prod-v1"));
      if (auth.length === 0) throw new Error("Arena login returned no auth cookie");
      // A 200 + an auth cookie is NOT proof the session works. Arena returns
      // both for a restricted account and then serves it as logged out, which
      // used to make this method report success for an account that could not
      // drive a single session — and the auto-refresh loop kept "fixing" it.
      if (!(await this.sessionIsUsable(page, email))) {
        throw Object.assign(
          new Error(
            `Arena signed in as ${email} but the session is not usable ` +
              "(/agent does not render as this account — most likely the account is restricted)"
          ),
          { code: "session_not_usable" }
        );
      }
      const cookieHeader = cookies
        .filter((c) => c.domain.endsWith("arena.ai"))
        .map((c) => `${c.name}=${c.value}`)
        .join("; ");
      return { email, cookieHeader, password };
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  /**
   * Is the signed-in session actually usable? When Arena accepts the account it
   * renders /agent with that account's own email in the server payload; when it
   * has quietly restricted the account, the same request renders as a visitor
   * and the email never appears. Verified against a known-restricted account
   * and a known-good one — the signal flips between them.
   */
  async sessionIsUsable(page, email) {
    try {
      const html = await page.evaluate(async () =>
        (await fetch("/agent", { headers: { Accept: "text/html" } })).text()
      );
      return String(html).toLowerCase().includes(String(email).toLowerCase());
    } catch {
      return false;
    }
  }

  /**
   * Generate a fresh reCAPTCHA v3 token (action chat_submit).
   */
  async freshRecaptchaToken(cookieHeader, siteKey) {
    const page = await this.getPage(cookieHeader);
    let target = this.recaptchaPage;
    if (!target || target.isClosed()) target = await this.context.newPage();
    this.recaptchaPage = target;
    if (!target.url().startsWith("https://arena.ai/")) {
      await target.goto("https://arena.ai/", { waitUntil: "domcontentloaded", timeout: 45_000 });
    }
    if (!(await target.evaluate(() => typeof globalThis.grecaptcha?.enterprise?.execute === "function"))) {
      await target.addScriptTag({ url: `https://www.google.com/recaptcha/enterprise.js?render=${siteKey}` });
    }
    await target.waitForFunction(
      () => typeof globalThis.grecaptcha?.enterprise?.execute === "function",
      { timeout: 30_000 }
    );
    const token = await target.evaluate(
      async ({ key }) => globalThis.grecaptcha.enterprise.execute(key, { action: "chat_submit" }),
      { key: siteKey }
    );
    if (typeof token !== "string" || token.length < 80) {
      throw new Error("Fresh Arena reCAPTCHA token was empty or too short");
    }
    return token;
  }
}
