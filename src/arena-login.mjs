// arena-login.mjs — real email/password login against arena.ai using
// Playwright, plus reCAPTCHA v3 token generation. Fully standalone.
import { createRequire } from "node:module";
import { retry, log, sleep } from "./util.mjs";
import { cookieHeaderToObjects } from "./cookie.mjs";
import { installProbe } from "./probe/index.mjs";

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

/**
 * What should happen to an Account's context on the way into getPage()?
 *
 *   create      — this Account has no context yet
 *   reuse       — nothing about its credential changed
 *   rebuild     — the credential changed and nobody is using the context
 *   reuse-stale — the credential changed but the context is busy
 *
 * `reuse-stale` is the one that matters. Rebuilding closes every page in the
 * context, including the turn running right now, which is exactly what the old
 * "close the browser when a credential refreshes" did — and why a refresh used
 * to cut off work that started before it. Living briefly with stale cookies
 * beats that. The dirty mark survives, so the next idle call rebuilds.
 */
export function contextAction({ hasContext = false, dirty = false, leases = 0 } = {}) {
  if (!hasContext) return "create";
  if (!dirty) return "reuse";
  return leases === 0 ? "rebuild" : "reuse-stale";
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
    // One context per Account, keyed by email. A single shared context meant a
    // refresh for one Account rebuilt the world for all of them, and that the
    // batch/reprobe/quota flows all queued behind the same pages.
    //   { context, page, recaptchaPage, signature, dirty, leases, warned }
    this.contexts = new Map();
    // Pages already carrying the model probe. addInitScript is per-page, and
    // re-adding it on every call would make each navigation parse the bundle
    // again — the probe itself no-ops on a same-version repeat, but the parse
    // is not free.
    this.probedPages = new WeakSet();
    // False once we know assets/arena-model-probe.inject.js is missing.
    this.probeAvailable = true;
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

  #entry(account) {
    let entry = this.contexts.get(account);
    if (!entry) {
      entry = {
        context: null,
        page: null,
        recaptchaPage: null,
        signature: "",
        staleSince: 0,
        warned: false,
        leases: 0,
      };
      this.contexts.set(account, entry);
    }
    return entry;
  }

  /** How many operations currently hold this Account's context. */
  leaseCount(account = "") {
    return this.#entry(String(account || "")).leases;
  }

  /**
   * Hold `credential`'s context for the duration of `fn`.
   *
   * While it is held, a credential refresh marks that Account's context stale but
   * does not rebuild it — see contextAction(). Leases belong to OPERATIONS, not
   * to getPage calls: a single turn asks for its page several times, so counting
   * there would never return to zero. Everything that keeps a page for more than
   * a moment goes through here, which is also what keeps acquire and release
   * paired in one place instead of at every call site.
   */
  async withAccount(credential, fn) {
    const account = String(credential?.email || "");
    this.#entry(account).leases += 1;
    try {
      return await fn();
    } finally {
      this.release(account);
    }
  }

  /** The operation is done with this Account's context. */
  release(account = "") {
    const entry = this.contexts.get(String(account || ""));
    if (entry && entry.leases > 0) entry.leases -= 1;
  }

  /**
   * A page for `credential`'s Account. No lease is taken here — see withAccount().
   */
  async getPage(credential = null) {
    // A bare cookie header is the shape of a call site left on the old
    // (cookieHeader, updatedAt) signature — and every field this method reads
    // would come back undefined, so it would quietly drive an ANONYMOUS,
    // unauthenticated context instead of failing. Say so instead. `null` stays
    // allowed: that is the deliberate "no Account yet" path, not a mistake.
    // The Account is the identity of a context, so a credential without an
    // `email` cannot address one — `{}` or an array would land on the same
    // anonymous context as a bare string, just less obviously.
    if (credential !== null && (typeof credential !== "object" || !String(credential.email || "").trim())) {
      throw new TypeError(
        "ArenaBrowser.getPage() takes one credential object with an email " +
          "({ email, cookieHeader, updatedAt }); a bare cookie header belongs to the previous signature."
      );
    }
    const account = String(credential?.email || "");
    const cookieHeader = String(credential?.cookieHeader || "");
    const signature = String(credential?.updatedAt || "");
    const entry = this.#entry(account);

    // A credential that changed means this Account's cookies are stale — but
    // only this Account's, and only until it goes idle. See contextAction().
    // `staleSince` is also what the status endpoint reports, so a context that
    // stays stale (because its Account never goes idle) is visible rather than
    // silently wrong.
    if (entry.context && entry.signature !== signature && !entry.staleSince) entry.staleSince = Date.now();

    const action = contextAction({
      hasContext: Boolean(entry.context),
      dirty: Boolean(entry.staleSince),
      leases: entry.leases,
    });
    if (action === "reuse-stale" && !entry.warned) {
      entry.warned = true;
      log.warn("browser", "credential refreshed while this Account is busy; rebuilding when it is idle", {
        account,
        staleMs: Date.now() - entry.staleSince,
      });
    }
    if (action === "create" || action === "rebuild") {
      await entry.context?.close().catch(() => undefined);
      entry.recaptchaPage = null;
      const contextOpts = {
        viewport: { width: 1440, height: 900 },
        locale: process.env.ARENA_LOCALE || "zh-CN",
      };
      if (this.userAgent) contextOpts.userAgent = this.userAgent;
      entry.context = await (await this.launch()).newContext(contextOpts);
      // Hide Playwright automation signals so reCAPTCHA v3 scores the session as
      // a genuine browser (same reason the Arena模型助手 WebView2 build passes:
      // a real browser engine reports navigator.webdriver === false). Mirrors the
      // --disable-blink-features=AutomationControlled launch flag above.
      await entry.context.addInitScript(() => {
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
      if (cookieHeader) await entry.context.addCookies(cookieHeaderToObjects(cookieHeader));
      entry.page = await entry.context.newPage();
      entry.signature = signature;
      entry.staleSince = 0;
      entry.warned = false;
      if (action === "rebuild") log.info("browser", "context rebuilt for a refreshed credential", { account });
    }
    if (!entry.page || entry.page.isClosed()) entry.page = await entry.context.newPage();
    // Every page this bridge drives carries the probe. A conversation run on it
    // then leaves a trace behind, and the trace's cost spans are where the USD
    // quota reading comes from — so the probe has to be registered BEFORE the
    // navigation that carries the turn, which is why it happens here rather
    // than at each call site.
    if (!this.probedPages.has(entry.page)) {
      this.probedPages.add(entry.page);
      const installed = await installProbe(entry.page);
      this.probeAvailable = installed.ok;
      if (!installed.ok) {
        this.probedPages.delete(entry.page); // let a later call retry
        log.warn("browser", "probe not installed", { error: installed.error });
      }
    }
    return entry.page;
  }

  /**
   * Status only: which Accounts have a context, and whether any is waiting for a
   * rebuild. Handles are deliberately not handed out here — a caller that needs
   * a specific Account's page asks getPage() for it.
   *
   * `staleSince` is the visible half of the lease fallback: a context can wait
   * for idle indefinitely if its Account never goes idle, and that shows up here
   * (and in the health payload) instead of quietly serving a stale session.
   */
  snapshot() {
    const accounts = [];
    for (const [account, entry] of this.contexts) {
      if (!entry.context) continue;
      accounts.push({
        account,
        pageReady: Boolean(entry.page && !entry.page.isClosed()),
        leases: entry.leases,
        staleSince: entry.staleSince || null,
      });
    }
    return { launched: Boolean(this.browser), accounts };
  }

  /** Shutdown, or recovery after the browser died: close every Account's context. */
  async close() {
    for (const entry of this.contexts.values()) {
      await entry.context?.close().catch(() => undefined);
      entry.context = null;
      entry.page = null;
      entry.recaptchaPage = null;
      entry.leases = 0;
    }
    this.contexts.clear();
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
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
   *
   * Takes the whole credential, not a bare cookie header: the Account is what
   * selects the context now. The old signature-less call also compared an empty
   * signature against a stored one, so it rebuilt the context on every token.
   */
  async freshRecaptchaToken(credential, siteKey) {
    const account = String(credential?.email || "");
    // Minting a token means navigating and then waiting up to 30s for Google's
    // script, so it holds the context like any other operation. Releasing without
    // this acquire would have decremented some other operation's lease and let a
    // refresh rebuild the context underneath it.
    return this.withAccount(credential, async () => {
      await this.getPage(credential);
      const entry = this.#entry(account);
      let target = entry.recaptchaPage;
      if (!target || target.isClosed()) target = await entry.context.newPage();
      entry.recaptchaPage = target;
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
    });
  }
}
