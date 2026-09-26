// bridge.mjs — orchestration core. Runs real Arena Agent sessions via the
// logged-in browser, with a serialized queue, staleness detection, native-tool
// interception, duplicate guards and recovery. API-compatible with v4.1.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ArenaBrowser } from "./arena-login.mjs";
import { SessionStore } from "./sessions.mjs";
import { formatMessages, sessionKey, latestTurn, contentText } from "./format.mjs";
import {
  parseAgentOutput,
  parsePublicToken,
  parseToolCalls,
  parseNativeToolCalls,
  repeatedToolGuard,
} from "./parser.mjs";
import { log, retry } from "./util.mjs";
import { mcpPreamble } from "./mcp-preamble.mjs";
import { resolveWorkspace } from "./codex-workspace.mjs";
import { readSnapshot } from "./probe/index.mjs";
import { VERSION } from "./version.mjs";

const encoder = new TextEncoder();

export class Bridge {
  constructor({ config, credentials, recaptcha, startedAt = Date.now() }) {
    this.config = config;
    this.credentials = credentials;
    this.recaptcha = recaptcha;
    this.startedAt = startedAt;
    this.browser = new ArenaBrowser({
      omniRoot: config.omniRoot,
      chromePath: config.chromePath,
      proxy: config.proxy,
    });
    this.sessions = new SessionStore({ filePath: config.sessionFile, ttlMs: config.sessionTtlMs });
    this.runtime = {
      queueDepth: 0,
      activeRequests: 0,
      requests: 0,
      completed: 0,
      errors: 0,
      textResponses: 0,
      toolResponses: 0,
      nativeIntercepts: 0,
      duplicateBlocks: 0,
      recoveryAttempts: 0,
      recoverySuccesses: 0,
      staleReplays: 0,
      totalLatencyMs: 0,
      lastLatencyMs: 0,
      lastSuccessAt: null,
      lastErrorAt: null,
      lastErrorType: null,
    };
    this.operationQueue = Promise.resolve();
    this.lastDumps = {};
    // §4.25 — auto-inject the local AgentDock MCP endpoint into a session the
    // first time we talk to it (and again whenever the endpoint changes).
    this.mcpInjected = this.#loadMcpInjected();
    // §4.28 — key -> promise, so identical concurrent calls (client retries after
    // a timeout) join one run instead of double-sending the prompt to Arena.
    this.inflight = new Map();
    // §4.33 — TRUE incremental streaming. The page context pushes each text delta
    // back to Node while it is being read, so the SSE response carries content in
    // seconds instead of only at the end of the whole turn (which made clients hit
    // their stream-idle timeout and retry — §4.32).
    this._deltaSink = null;
    this._deltaSinkPage = null;
    // §4.33 — short-lived idempotency cache: a client retry that arrives AFTER the
    // first run finished must not re-send the prompt to Arena.
    this.resultCache = new Map();
  }

  #mcpInjectedPath() {
    return path.join(this.config.dataDir, "mcp-injected.json");
  }

  #loadMcpInjected() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.#mcpInjectedPath(), "utf8"));
      return new Map(Object.entries(raw || {}));
    } catch {
      return new Map();
    }
  }

  #saveMcpInjected() {
    try {
      fs.writeFileSync(
        this.#mcpInjectedPath(),
        JSON.stringify(Object.fromEntries(this.mcpInjected), null, 2)
      );
    } catch {
      /* best effort */
    }
  }

  /**
   * Returns the one-line MCP connection hint to prepend to the prompt, or "".
   * The endpoint file is written by start-arena-mcp.ps1 and deleted by
   * stop-arena-mcp.ps1, so injection only happens while the tunnel is up.
   */
  #mcpEndpointLine(sessionId, headers = null) {
    if (!this.config.mcpEndpointFile) return "";
    let endpoint;
    try {
      endpoint = JSON.parse(fs.readFileSync(this.config.mcpEndpointFile, "utf8"));
    } catch {
      return ""; // no tunnel running
    }
    const url = String(endpoint?.url || "").trim();
    const token = String(endpoint?.token || "").trim();
    if (!url || !token) return "";
    const fingerprint = `${url}|${token.slice(0, 8)}`;
    if (this.mcpInjected.get(sessionId) === fingerprint) return ""; // already told
    this.mcpInjected.set(sessionId, fingerprint);
    this.#saveMcpInjected();
    const { workspace, source } = resolveWorkspace({
      headers,
      sessionsRoot: this.config.codexSessionsDir,
      windowMs: this.config.codexRecentWindowMs,
      fallback: this.config.mcpWorkspace,
    });
    log.info("bridge", "converse: injecting local MCP endpoint into session", {
      sessionId,
      url,
      workspace: workspace || null,
      workspaceFrom: source,
    });
    return mcpPreamble({ url, token, workspace });
  }

  async start() {
    // Warm up the browser and validate the credential early (fail fast).
    const credential = this.credentials.primary();
    if (!credential) throw new Error("arena-bridge: no credentials — run bin/login.mjs first");
    await this.browser.getPage(credential.cookieHeader, credential.updatedAt);
    log.info("bridge", "browser ready", {
      account: credential.email,
      cookieExpiry: this.credentials.expirySummary(credential),
    });
  }

  #serialized(fn) {
    if (this.runtime.queueDepth >= this.config.maxQueue) {
      return Promise.reject(
        Object.assign(new Error("Arena bridge queue is full; retry shortly"), {
          status: 503,
          retryAfter: 10,
          code: "bridge_queue_full",
        })
      );
    }
    this.runtime.queueDepth += 1;
    const execute = async () => {
      this.runtime.activeRequests += 1;
      try {
        return await fn();
      } finally {
        this.runtime.activeRequests -= 1;
      }
    };
    const run = this.operationQueue.then(execute, execute);
    this.operationQueue = run.catch(() => undefined);
    return run.finally(() => {
      this.runtime.queueDepth = Math.max(0, this.runtime.queueDepth - 1);
    });
  }

  /**
   * The Account that must drive a turn. An explicit owner is honoured and never
   * substituted — see CredentialStore.forSession for why. No owner means the
   * caller has no information, so the pool's default pick applies.
   */
  #credential(accountEmail = "") {
    return this.credentials.forSession(accountEmail);
  }

  /**
   * §4.33 — install the page -> Node delta channel exactly once per page.
   * Playwright re-installs bindings after navigations, so one registration is
   * enough; re-registering the same name throws, hence the page guard.
   */
  async #ensureDeltaSink(page) {
    if (this._deltaSinkPage === page) return;
    try {
      await page.exposeFunction("__arenaBridgeDelta", (payload) => {
        try {
          this.#emitDelta(payload);
        } catch {
          /* never let a bad chunk break the read */
        }
      });
      this._deltaSinkPage = page;
      log.info("bridge", "delta channel installed (true streaming enabled)");
    } catch (error) {
      this._deltaSinkPage = null;
      log.warn("bridge", "delta channel install failed; falling back to end-of-turn delivery", {
        message: String(error?.message || error).slice(0, 160),
      });
    }
  }

  /**
   * Forward one incremental text delta downstream, exactly once per node.
   * A re-read may deliver the same node's text again (replay / recovery), so we
   * compare against what we already emitted for that node and only send the
   * suffix we have not sent yet.
   */
  #emitDelta(payload) {
    const sink = this._deltaSink;
    if (!sink) return;
    const node = String(payload?.node ?? "");
    const total = String(payload?.total ?? "");
    if (!node || !total) return;
    const emitted = this._emittedByNode instanceof Map ? this._emittedByNode : new Map();
    this._emittedByNode = emitted;
    const prev = emitted.get(node) || "";
    if (total.length <= prev.length) return; // nothing new for this node
    const next = total.startsWith(prev) ? total.slice(prev.length) : total;
    emitted.set(node, total);
    if (next) sink(next);
  }

  /**
   * The browser page for a turn, driven by `account` when the caller resolved
   * one (converse does, from the Session's owner); otherwise by the pool's
   * default pick, which is what the session-creating flows want.
   */
  async #page(account = null) {
    const credential = account || this.#credential();
    return this.browser.getPage(credential.cookieHeader, credential.updatedAt);
  }

  async createAgentSession(page, prompt) {
    await page.goto("https://arena.ai/agent", { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
    await page.waitForTimeout(2_000);
    const acceptCookies = page.getByRole("button", { name: "Accept Cookies" });
    if (await acceptCookies.count()) await acceptCookies.click().catch(() => undefined);
    const editor = page.locator('[contenteditable="true"]').last();
    await editor.waitFor({ state: "visible", timeout: 60_000 });
    await editor.fill(prompt);
    const createResponse = page.waitForResponse(
      (response) => response.url().includes("/nextjs-api/stream/create-chat"),
      { timeout: 60_000 }
    );
    await page.locator('button[aria-label="Send message"]').click({ force: true });
    const response = await createResponse;
    const createText = await response.text().catch(() => "");
    if (response.status() !== 200) {
      throw Object.assign(
        new Error(`Arena Agent composer failed: ${response.status()} ${createText.slice(0, 300)}`),
        { status: response.status() }
      );
    }
    const id = JSON.parse(createText).id;
    if (!id) throw new Error("Arena Agent composer returned no session id");
    let token = "";
    for (let attempt = 0; attempt < 8 && !token; attempt++) {
      const html = await page.evaluate(async (id) => (await fetch(`/agent/${id}`)).text(), id);
      token = parsePublicToken(html);
      if (!token) await new Promise((r) => setTimeout(r, 350));
    }
    if (!token) throw new Error("Arena Agent public token not found");
    return { id, token, lastNodeId: null, requiresReview: false, toolsInitialized: false, updatedAt: Date.now() };
  }

  async appendAgentMessage(page, state, prompt) {
    // §4.29 — page reuse. Navigating to /agent/<id> costs 18–48s per call
    // (SPA hydration) and adds Cloudflare exposure (see §4.24). When the target
    // session is ALREADY the page we are on, skip the navigation entirely and
    // only re-check that the composer is actually there.
    const targetUrl = `https://arena.ai/agent/${state.id}`;
    const currentUrl = (() => {
      try {
        return page.url() || "";
      } catch {
        return "";
      }
    })();
    const reusePage = currentUrl.startsWith(targetUrl);
    if (reusePage) {
      log.info("bridge", "appendAgentMessage: reusing open session page (no navigation)", {
        sessionId: state.id,
      });
    } else {
      await page.goto(targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
    }
    // The arena SPA can take well over 20s to become interactive (slow /
    // CF-gated loads). The original 2.5s fixed sleep ran the cookie and
    // "keep working" handling against an unrendered DOM, so the composer was
    // never found. Wait for an actual render signal first.
    // Wait for the SPA to render — but stop early and RELOAD if Arena bails to
    // its "This is taking longer than expected. Reload the page" fallback (which
    // has no composer and no review panel). Seen under load / rate-limiting even
    // in HEADED mode.
    // A reused page skips this: it is already hydrated, and re-waiting would
    // only add latency. We still fall through to the fallback-page check below.
    for (let i = 0; i < 3; i++) {
      if (!reusePage || i > 0) {
        await page
          .waitForFunction(
            () => {
              const t = document.body.innerText || "";
              return t.includes("Workspace") || /taking longer than expected|Reload the page/i.test(t);
            },
            { timeout: reusePage ? 15_000 : 75_000 }
          )
          .catch(() => undefined);
      }
      const t = await page.evaluate(() => document.body.innerText || "").catch(() => "");
      if (!/taking longer than expected|Reload the page/i.test(t)) break;
      log.warn("bridge", "Arena SPA fallback page; reloading", { sessionId: state.id, try: i + 1 });
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => undefined);
      await page.waitForTimeout(5_000);
    }
    await page
      .waitForSelector('[contenteditable="true"]', { state: "visible", timeout: reusePage ? 10_000 : 30_000 })
      .catch(() => undefined);
    // Reused pages are already interactive; the old fixed 2s sleep was only there
    // to let a fresh navigation settle.
    await page.waitForTimeout(reusePage ? 400 : 2_000);
    const acceptCookies = page.getByRole("button", { name: "Accept Cookies" });
    if (await acceptCookies.count()) await acceptCookies.click().catch(() => undefined);
    // Dismiss the "was this task successful?" / continue modal before editing.
    // Arena's UI labels these in the account language (e.g. "ادامه کار").
    const keepSelectors = [
      'button:has-text("Keep working")',
      'button:has-text("ادامه کار")',
      'button:has-text("ادامه")',
      'button[role="button"]:has-text("Keep working")',
      'button[role="button"]:has-text("ادامه کار")',
      '[role="dialog"] button:has-text("ادامه")',
      'button:has-text("继续工作")',
      'button[role="button"]:has-text("继续工作")',
      '[role="dialog"] button:has-text("继续工作")',
    ];
    // The page renders several [contenteditable] nodes and some are hidden, so
    // ".last()" alone can resolve to an invisible one. Always target a visible.
    const editor = page.locator('[contenteditable="true"]').filter({ visible: true }).last();
    let composerReady = false;
    try {
      composerReady = (await editor.count()) > 0;
    } catch {
      composerReady = false;
    }
    // (1) Recover from Arena's SPA fallback page — "This is taking longer than
    // expected. Reload the page". It appears under load / rate-limiting even in
    // HEADED mode, and on that page there is NO composer and NO review panel, so
    // the old code simply waited 60s then failed. Reload and re-render instead.
    for (let i = 0; i < 3; i++) {
      const bodyText = await page.evaluate(() => document.body.innerText || "").catch(() => "");
      if (!/taking longer than expected|Reload the page/i.test(bodyText)) break;
      log.warn("bridge", "Arena page on 'taking longer than expected'; reloading", { sessionId: state.id, try: i + 1 });
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => undefined);
      await page.waitForTimeout(5_000);
      await page
        .waitForFunction(() => (document.body.innerText || "").includes("Workspace"), { timeout: 90_000 })
        .catch(() => undefined);
      await page.waitForTimeout(2_000);
    }
    // (2) Dismiss the "was this task successful?" / continue modal. Do this EVERY
    // time (not only when the composer *looks* missing): the panel can appear
    // after a short delay, and a stale panel keeps the composer hidden — which is
    // why the user had to click "继续工作" by hand every turn.
    for (let i = 0; i < 3; i++) {
      let clicked = false;
      for (const sel of keepSelectors) {
        const btn = page.locator(sel).first();
        if ((await btn.count().catch(() => 0)) && (await btn.isVisible().catch(() => false))) {
          await btn.click({ force: true, timeout: 5_000 }).catch(() => undefined);
          await page.waitForTimeout(2_500);
          clicked = true;
        }
      }
      if (!clicked) await page.waitForTimeout(2_500);
      if (((await editor.count().catch(() => 0))) > 0) break;
    }
    // ── DIAGNOSTIC: dump composer + buttons at the decision point ──────────
    try {
      const diag = await page.evaluate(() => {
        const vis = (el) => {
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
        };
        const clickables = Array.from(document.querySelectorAll("button, [role='button'], a, [role='menuitem']"))
          .filter(vis)
          .map((b) => ({
            t: (b.innerText || "").trim().replace(/\s+/g, " ").slice(0, 40),
            a: (b.getAttribute("aria-label") || "").slice(0, 40),
          }))
          .filter((x) => x.t || x.a)
          .slice(0, 60);
        return {
          composerEditors: Array.from(document.querySelectorAll('[contenteditable="true"]')).filter(vis).length,
          dialogs: Array.from(document.querySelectorAll('[role="dialog"]')).filter(vis).length,
          bodyHead: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 300),
          clickables,
        };
      });
      log.info("bridge", "appendAgentMessage diag", { sessionId: state.id, composerReady, diag });
    } catch (e) {
      log.warn("bridge", "appendAgentMessage diag failed", { message: String((e && e.message) || e) });
    }
    try {
      await editor.waitFor({ state: "visible", timeout: 60_000 });
    } catch {
      // The composer never became visible. On this UI that means the session is
      // NOT in an interactive state: it is showing the "was this task
      // successful?" review panel, or the run has completed and the composer is
      // hidden. Surface a clear, actionable error instead of the raw Playwright
      // timeout (which the HTTP layer would otherwise report as an opaque 502
      // after a long wait — see VERIFICATION-RESULT.md §4.13.4).
      throw Object.assign(
        new Error(
          `Arena session is not interactive: the message composer never became visible for ${state.id}. ` +
            `Likely causes: the session is showing the "was this task successful?" review panel or its run has completed, ` +
            `or the bridge's Arena login/cookie has expired. ` +
            `Fix: open the session in Arena模型助手 (or the Arena UI under the bridge's account) and click ` +
            `"继续工作 / Keep working" to restore the composer; if the bridge login expired, restart it (start-gui.bat) and retry.`
        ),
        { status: 409, code: "session_not_interactive" }
      );
    }
    // Fill the composer the way the Arena模型助手 app does: focus the visible
    // contenteditable and use execCommand('insertText'), which React's
    // contenteditable actually captures (Playwright's .fill() sets textContent
    // and is often ignored by the SPA).
    await page
      .evaluate((prompt) => {
        const editors = Array.from(document.querySelectorAll('[contenteditable="true"]')).filter(
          (e) => e.offsetParent !== null
        );
        const target = editors[editors.length - 1];
        if (!target) return;
        target.focus();
        document.execCommand("insertText", false, prompt);
        target.dispatchEvent(new Event("input", { bubbles: true }));
      }, prompt)
      .catch(() => undefined);
    const appendResponse = page.waitForResponse(
      (response) => response.url().includes(`/sessions/${state.id}/in/append`),
      { timeout: 60_000 }
    );
    let observedToken = "";
    const tokenListener = (request) => {
      if (request.url().includes(`/sessions/${state.id}/out`)) {
        const auth = request.headers().authorization || "";
        if (/^Bearer /i.test(auth)) observedToken = auth.replace(/^Bearer /i, "");
      }
    };
    page.on("request", tokenListener);
    const freshOutputRequest = page
      .waitForRequest((request) => request.url().includes(`/sessions/${state.id}/out`), { timeout: 12_000 })
      .catch(() => null);
    // Submit by clicking the real "Send message" / "发送消息" button (matched by
    // text label, exactly like the Arena模型助手 PageBridge/PelicanSend). This lets
    // arena's own frontend attach the reCAPTCHA v3 token and POST the message —
    // verified working on the live /agent page. Fall back to Enter only if the
    // button can't be located in this particular UI state.
    const clickedSend = await page
      .evaluate(() => {
        const btn = Array.from(document.querySelectorAll("button")).find((b) =>
          /^(Send message|发送消息)$/i.test((b.innerText || b.getAttribute("aria-label") || "").trim())
        );
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      })
      .catch(() => false);
    if (!clickedSend) await editor.press("Enter").catch(() => undefined);
    const response = await appendResponse;
    const outputRequest = await freshOutputRequest;
    if (outputRequest) {
      const auth = outputRequest.headers().authorization || "";
      if (/^Bearer /i.test(auth)) observedToken = auth.replace(/^Bearer /i, "");
    }
    page.off("request", tokenListener);
    const text = await response.text().catch(() => "");
    if (response.status() !== 200) {
      throw Object.assign(
        new Error(`Arena Agent append failed: ${response.status()} ${text.slice(0, 300)}`),
        { status: response.status() }
      );
    }
    const headerToken = response.headers()["public-access-token"] || "";
    if (headerToken) observedToken = headerToken;
    if (observedToken) state.token = observedToken;
  }

  async refreshAgentToken(page, id) {
    const html = await page.evaluate(async (sessionId) => (await fetch(`/agent/${sessionId}`)).text(), id);
    return parsePublicToken(html);
  }

  async readAgentOutput(page, state) {
    const result = await page.evaluate(
      async ({ id, token, lastEventId, readBudgetMs }) => {
        const controller = new AbortController();
        let timer = null;
        // §4.37 — 0 / unset budget means "wait forever"; only arm the abort timer
        // when an explicit positive budget is configured.
        if (readBudgetMs && Number(readBudgetMs) > 0) {
          timer = setTimeout(() => controller.abort(), Number(readBudgetMs) + 30_000);
        }
        let reader;
        try {
          const headers = { Accept: "text/event-stream", Authorization: `Bearer ${token}` };
          if (lastEventId) headers["Last-Event-ID"] = lastEventId;
          const response = await fetch(`/ai-proxy/realtime/v1/sessions/${id}/out`, {
            headers,
            signal: controller.signal,
          });
          reader = response.body.getReader();
          const decoder = new TextDecoder();
          let raw = "";
          while (raw.length < 4_000_000) {
            const { done, value } = await reader.read();
            if (done) break;
            raw += decoder.decode(value, { stream: true });
            const lfEnd = raw.lastIndexOf("\n\n");
            const crlfEnd = raw.lastIndexOf("\r\n\r\n");
            const completeEnd = Math.max(lfEnd < 0 ? -1 : lfEnd + 2, crlfEnd < 0 ? -1 : crlfEnd + 4);
            const complete = completeEnd > 0 ? raw.slice(0, completeEnd) : "";
            const hasCompleteTool = /tool-input-(?:available|error)/.test(complete);
            const hasFinish = complete.includes('\\"type\\":\\"finish\\"');
            const hasTurnComplete = complete.includes("turn-complete");
            if (hasCompleteTool || (hasFinish && hasTurnComplete)) break;
          }
          await reader.cancel().catch(() => undefined);
          return { status: response.status, raw };
        } finally {
          clearTimeout(timer);
          await reader?.cancel().catch(() => undefined);
        }
      },
      { id: state.id, token: state.token, lastEventId: state.lastEventId || "", readBudgetMs: state.readBudgetMs || 0, readAbortMs: state.readBudgetMs && state.readBudgetMs > 0 ? state.readBudgetMs + 30_000 : 0, marker: state.marker || "" }
    );
    if (result.status !== 200)
      throw Object.assign(new Error(`Arena Agent output failed: ${result.status}`), { status: result.status });
    return result.raw;
  }

  /**
   * Read the realtime /out stream and return ONLY the most-recent turn's text.
   *
   * Why this exists: the /out SSE replays the ENTIRE session history whenever it
   * is opened (with or without Last-Event-ID), emitting a `finish` per prior
   * turn. A naive read that concatenates all text-deltas and breaks on the
   * first `finish` returns a STALE (old) turn — exactly the one-turn lag seen
   * when wrapping Arena as a chat model. So we accumulate text per `nodeId`
   * and return the last node's content once a `finish` has been seen and the
   * stream goes idle. Token / lastEventId / native tool calls are also surfaced.
   */
  async readLatestTurn(page, state, onDelta) {
    // §4.33 — while this read runs, the page context pushes every text delta of
    // OUR turn back through __arenaBridgeDelta so the HTTP layer can stream it.
    const sinkActive = typeof onDelta === "function";
    if (sinkActive) {
      await this.#ensureDeltaSink(page);
      this._deltaSink = onDelta;
    }
    try {
      return await page.evaluate(
      async ({ id, token, lastEventId, readBudgetMs, readAbortMs, marker }) => {
        const controller = new AbortController();
        // §4.37 — Never abort the stream on a timer unless an explicit positive
        // budget is configured. With readAbortMs <= 0 we wait for Arena forever.
        let timer = null;
        if (readAbortMs && Number(readAbortMs) > 0) {
          timer = setTimeout(() => controller.abort(), Number(readAbortMs));
        }
        let reader;
        try {
          const headers = { Accept: "text/event-stream", Authorization: `Bearer ${token}` };
          if (lastEventId) headers["Last-Event-ID"] = lastEventId;
          const response = await fetch(`/ai-proxy/realtime/v1/sessions/${id}/out`, {
            headers,
            signal: controller.signal,
          });
          reader = response.body.getReader();
          const decoder = new TextDecoder();
          let raw = "";
          let consumed = 0; // index into `norm` up to which blocks were already parsed
          let lastData = Date.now();
          const t0 = Date.now();
          // §4.28 — settle on CONTENT, not on raw bytes. Last time we saw a
          // meaningful event (text-delta / error / finish). The old code used
          // "any byte arrived" which meant periodic stream activity (tool
          // progress, keep-alives) kept resetting the idle timer and we sat
          // until the 110s cap even though the answer was already complete.
          let lastTextAt = Date.now();
          let msToFirstText = 0;
          let msToFinish = 0;
          let breakReason = "";
          // §4.28/§4.31 — tell the REPLAYED history apart from OUR turn.
          // A fixed time window is wrong: Arena can answer a short prompt inside
          // 5s, and that answer was then discarded as "replay" (observed: Q2 was
          // present in the stream's nodes yet the reply came back empty).
          // The reliable signal is the REPLAY BURST ending: the whole history is
          // pushed in one instantaneous burst on connect, then the stream goes
          // quiet while the agent generates. Everything after that gap is ours.
          let replayEndAt = 0; // 0 = still inside the replay burst
          let finishesAtReplay = 0;
          let historyNodes = new Set();
          let ourLastNode = null; // node that streamed OUR answer
          let sawEvents = false;
          let lastEventAt = Date.now();
          const REPLAY_GAP_MS = 1_200;
          const COLD_START_MS = 2_000;
          // §4.34 — a tool call inside the answer ends a STEP, not the turn: Arena
          // emits its own `finish` for that step and then keeps running (tool
          // executes, more text follows). Treating that as the end returned a
          // half answer and dropped everything after the tool. A tool turn needs
          // TWO finishes (tool step + final step) before we may settle.
          let toolAfterReplay = false;
          let ourTurnFinishes = 0; // finishes counted for OUR turn (see §4.34)
          let ourSteps = 0; // `data-agent-dispatch` runs started in OUR turn
          let ourText = ""; // everything OUR turn produced in this read
          // Follow-up reads (allow tool policy) only need the post-tool answer,
          // so they get a much tighter budget than a first read.
          const budgetMs = Number(readBudgetMs || 0); // 0 = wait forever (no budget; §4.37)
          const turns = new Map();
          const dbg = [];
          let curNode = null;
          let lastDeltaNode = null; // node key of the most-recent text-delta
          let hasFinish = false;
          // The stream replays recent history IMMEDIATELY on connect, then streams
          // OUR new turn LATER (after the agent generates). Only deltas arriving
          // after this window count as the reply, so a replayed old turn can never
          // be mistaken for the answer. See §4.20.
          const REPLAY_WINDOW_MS = 5_000;
          let finishCount = 0; // total `finish` events seen
          let errText = "";
          const nativeById = new Map();
          const native = [];
          let tokenOut = "";
          let lastEventIdOut = "";
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value || !value.length) continue;
            raw += decoder.decode(value, { stream: true });
            const nowMs = Date.now();
            // §4.31 — detect the END of the replay burst BEFORE parsing this chunk,
            // so the chunk that follows the gap is already attributed to OUR turn.
            // - after some events: a >=1.2s silence means the burst ended;
            // - cold start (no events yet): a >=2s silence before the very first
            //   event means there was no replay at all;
            // - fallback: freeze at REPLAY_WINDOW_MS if the stream never goes quiet.
            if (replayEndAt === 0) {
              const gap = sawEvents ? nowMs - lastEventAt : nowMs - t0;
              if ((sawEvents && gap > REPLAY_GAP_MS) || (!sawEvents && gap > COLD_START_MS) || nowMs - t0 > REPLAY_WINDOW_MS) {
                replayEndAt = nowMs;
                finishesAtReplay = finishCount;
                historyNodes = new Set(turns.keys());
              }
            }
            lastEventAt = nowMs;
            sawEvents = true;
            lastData = nowMs;
            const norm = raw.replace(/\r\n/g, "\n");
            const boundary = norm.lastIndexOf("\n\n");
            // Parse ONLY the newly-arrived complete blocks. The previous version
            // re-parsed the ENTIRE cumulative buffer on every chunk, so each
            // earlier `text-delta` was counted once per subsequent chunk — that
            // is why replies came back duplicated ("2" -> "22222222").
            // See VERIFICATION-RESULT.md §4.18.
            let fresh = "";
            if (boundary >= 0 && boundary > consumed) {
              fresh = norm.slice(consumed, boundary);
              consumed = boundary + 2;
            }
            for (const block of fresh.split(/\n\n+/)) {
              const idLine = block.match(/^id:\s*(.+)$/m);
              if (idLine) lastEventIdOut = idLine[1].trim();
              const dataLine = block.match(/^data:\s*(.+)$/m);
              if (!dataLine) continue;
              let event;
              try {
                event = JSON.parse(dataLine[1]);
              } catch {
                continue;
              }
              for (const rec of Array.isArray(event.records) ? event.records : []) {
                if (Array.isArray(rec.headers)) {
                  for (const [n, v] of rec.headers) {
                    if (String(n).toLowerCase() === "public-access-token") tokenOut = String(v);
                  }
                }
                if (!rec.body) continue;
                let body;
                try {
                  body = JSON.parse(rec.body);
                } catch {
                  continue;
                }
                const data = body.data || {};
                const node = data.messageMetadata?.nodeId || data.nodeId || curNode;
                const key = String(node);
                if (dbg.length < 80 && data.type) {
                  dbg.push({
                    t: data.type,
                    n: String(node),
                    d: typeof data.delta === "string" ? data.delta.slice(0, 20) : data.toolName ? "tool:" + data.toolName : undefined,
                  });
                }
                if ((data.type === "text-delta" || data.type === "reasoning-delta") && typeof data.delta === "string") {
                  turns.set(key, (turns.get(key) || "") + data.delta);
                  curNode = node;
                  lastTextAt = Date.now();
                  lastEventAt = Date.now();
                  if (replayEndAt !== 0 && data.type === "text-delta") ourText += data.delta;
                  if (replayEndAt !== 0) {
                    ourLastNode = key; // text produced after the replay burst = ours
                    if (!msToFirstText) msToFirstText = Date.now() - t0;
                    // §4.33 — push this increment out immediately (true streaming).
                    if (data.type === "text-delta") {
                      try {
                        if (typeof window.__arenaBridgeDelta === "function") {
                          window.__arenaBridgeDelta({ node: String(key), total: turns.get(key) || "" });
                        }
                      } catch {
                        /* binding missing (e.g. tiny budget) — final payload still carries the text */
                      }
                    }
                  }
                  // Legacy fallback for streams that never go quiet (§4.20).
                  if (Date.now() - t0 > REPLAY_WINDOW_MS) lastDeltaNode = key;
                }
                if (data.type === "error" && !errText) {
                  errText = String(data.errorText || data.message || data.error || JSON.stringify(data)).slice(0, 300);
                  lastTextAt = Date.now();
                }
                if (data.type === "tool-input-start" && data.toolCallId) {
                  if (replayEndAt !== 0) toolAfterReplay = true;
                  nativeById.set(String(data.toolCallId), { id: String(data.toolCallId), name: String(data.toolName || ""), rawInput: "" });
                }
                if (data.type === "tool-input-delta" && data.toolCallId) {
                  if (replayEndAt !== 0) toolAfterReplay = true;
                  const cur = nativeById.get(String(data.toolCallId)) || { id: String(data.toolCallId), name: "", rawInput: "" };
                  cur.rawInput += String(data.inputTextDelta || "");
                  nativeById.set(String(data.toolCallId), cur);
                }
                if ((data.type === "tool-input-available" || data.type === "tool-input-error") && data.toolCallId) {
                  if (replayEndAt !== 0) toolAfterReplay = true;
                  const cur = nativeById.get(String(data.toolCallId)) || { id: String(data.toolCallId), name: "", rawInput: "" };
                  cur.name = String(data.toolName || cur.name || "");
                  cur.input = data.input;
                  if (!native.some((c) => c.id === cur.id)) native.push(cur);
                }
                if (data.type === "finish") {
                  curNode = data.messageMetadata?.nodeId || curNode;
                  hasFinish = true;
                  finishCount += 1;
                  // §4.35 — count only finishes of OUR turn (after the replay).
                  if (replayEndAt !== 0) ourTurnFinishes += 1;
                  lastTextAt = Date.now();
                  lastEventAt = Date.now();
                  if (replayEndAt !== 0 && !msToFinish) msToFinish = Date.now() - t0;
                }
                // §4.35 — a turn can contain SEVERAL agent runs (dispatches): with
                // tools, or as plain extra steps. Each one ends with its own
                // `finish`, so we must not settle while any started run is still
                // open — that is exactly "Codex stopped while Arena was still
                // working".
                if ((data.type === "data-agent-dispatch" || data.type === "start") && replayEndAt !== 0) {
                  ourSteps += 1;
                  lastEventAt = Date.now();
                }
              }
            }
            const textIdle = Date.now() - lastTextAt;
            const streamIdle = Date.now() - lastData;
            const elapsed = Date.now() - t0;
            // §4.36 — the agent echoed OUR per-request marker: the turn is over,
            // full stop. No inference needed (works for multi-step/tool turns too).
            if (marker && ourText.includes(marker)) {
              breakReason = "turn+marker";
              break;
            }
            // Freeze the replay's finish count once the replay window has passed:
            // every `finish` up to here belonged to the replayed history.
            // §4.35 — settle only when EVERY agent run that started in our turn has
            // finished. A run may be a tool step or a plain extra step; either way
            // its `finish` must have arrived, otherwise the turn is still running
            // (this is what made Codex stop while Arena was still working).
            const needed = Math.max(1, ourSteps);
            const ourTurnDone = replayEndAt !== 0 && ourTurnFinishes >= needed;
            if (ourTurnDone && textIdle > 2_500) {
              breakReason = toolAfterReplay ? "turn+final-idle(tool)" : "turn+final-idle";
              break;
            }
            // Safety net: every step has closed but the stream keeps trickling
            // (keep-alives, trailing progress) and never goes content-quiet.
            if (ourTurnDone && streamIdle > 15_000) {
              breakReason = "turn+final-quiet";
              break;
            }
            // §4.37 — with budgetMs <= 0 the read has NO time limit; it ends
            // only when Arena's stream closes or the turn settles (marker/finish).
            if (budgetMs > 0 && elapsed > budgetMs) {
              breakReason = "budget";
              break;
            }
          }
          const lastNode = curNode || [...turns.keys()].pop();
          // The reply is the LAST text-delta that arrived AFTER the replay window.
          // If none did, our turn produced no text (it errored) — return EMPTY
          // rather than a stale replayed turn. See §4.18 / §4.20.
          return {
            // ourText is everything OUR turn produced in this read (pre + post tool).
            text: ourText || (lastDeltaNode ? turns.get(lastDeltaNode) : "") || "",
            toolAfterReplay,
            token: tokenOut,
            lastEventId: lastEventIdOut,
            nativeCalls: native,
            errorText: errText,
            // Full per-node text, used by the `allow` tool policy (§4.23) so a
            // follow-up read can pick out text from a node it has NOT seen yet
            // (immunity to replay duplication — §4.18/§4.20).
            turns: [...turns.entries()].map(([k, v]) => ({ k: String(k), text: v })),
            timing: {
              totalMs: Date.now() - t0,
              msToFirstText,
              msToFinish,
              replayEndMs: replayEndAt ? replayEndAt - t0 : -1,
              historyNodeCount: historyNodes.size,
              toolAfterReplay,
              ourTurnFinishes,
              ourSteps,
              breakReason: breakReason || "stream-ended",
            },
            debug: {
              lastNode: String(lastNode),
              nodeKeys: [...turns.keys()].map(String),
              nodeTexts: [...turns.entries()].map(([k, v]) => ({ k: String(k), len: v.length, head: v.slice(0, 60) })),
              events: dbg,
            },
          };
        } finally {
          clearTimeout(timer);
          await reader?.cancel().catch(() => undefined);
        }
      },
      { id: state.id, token: state.token, lastEventId: state.lastEventId || "", readBudgetMs: state.readBudgetMs || 0, readAbortMs: state.readBudgetMs && state.readBudgetMs > 0 ? state.readBudgetMs + 30_000 : 0, marker: state.marker || "" }
      );
    } finally {
      if (sinkActive) this._deltaSink = null;
    }
  }

  async stopArenaRun(page) {
    for (const selector of [
      'button[aria-label="Stop generating"]',
      'button[aria-label="Stop"]',
      'button:has-text("Stop generating")',
    ]) {
      const button = page.locator(selector).last();
      if (await button.count()) {
        await button.click({ force: true, timeout: 2_000 }).catch(() => undefined);
        break;
      }
    }
    await page.goto("about:blank", { waitUntil: "commit", timeout: 5_000 }).catch(() => undefined);
  }

  makeCompletion(model, content, toolCalls, reasoning) {
    const message = { role: "assistant", content: toolCalls ? content || null : content };
    if (toolCalls) message.tool_calls = toolCalls;
    if (reasoning) message.reasoning_content = reasoning;
    return {
      id: `chatcmpl-arena-agent-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message, finish_reason: toolCalls ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }

  completionStream(payload) {
    const choice = payload.choices[0];
    const message = choice.message;
    const emit = (delta, finish) =>
      `data: ${JSON.stringify({
        id: payload.id,
        object: "chat.completion.chunk",
        created: payload.created,
        model: payload.model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
    return new ReadableStream({
      start: (controller) => {
        controller.enqueue(encoder.encode(emit({ role: "assistant", content: "" }, null)));
        if (message.reasoning_content)
          controller.enqueue(encoder.encode(emit({ reasoning_content: message.reasoning_content }, null)));
        if (message.tool_calls) {
          const streamedCalls = message.tool_calls.map((call, index) => ({ index, ...call }));
          controller.enqueue(encoder.encode(emit({ content: message.content, tool_calls: streamedCalls }, null)));
        } else if (message.content) {
          controller.enqueue(encoder.encode(emit({ content: message.content }, null)));
        }
        controller.enqueue(encoder.encode(emit({}, choice.finish_reason)));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
  }

  async recoverFromDuplicate(page, body, basePrompt, guardedResult) {
    this.runtime.recoveryAttempts += 1;
    const recoveryPrompt = [
      basePrompt,
      "DUPLICATE-CALL RECOVERY:",
      guardedResult,
      "Your immediately preceding proposed tool call duplicated a successful operation and was blocked.",
      "Do not emit that same call again. Continue with the next different required tool, or provide the final answer if the task is complete.",
    ].join("\n\n");
    try {
      const recoveryState = await this.createAgentSession(page, recoveryPrompt);
      const raw = await this.readAgentOutput(page, recoveryState);
      this.#dump("last-recovery-sse", raw);
      const parsed = parseAgentOutput(raw);
      const textResult = parseToolCalls(parsed.text, body.tools, this.config.maxToolCalls);
      const nativeCalls = textResult.toolCalls ? null : parseNativeToolCalls(parsed.nativeCalls, body.tools, this.config.maxToolCalls);
      const effectiveCalls = textResult.toolCalls || nativeCalls;
      if (nativeCalls) await this.stopArenaRun(page);
      const repeatedAgain = repeatedToolGuard(body, effectiveCalls);
      if (repeatedAgain) return this.makeCompletion(body.model || "agent", guardedResult, null, parsed.reasoning);
      this.runtime.recoverySuccesses += 1;
      const content = textResult.content || (effectiveCalls ? "" : parsed.text || guardedResult);
      return this.makeCompletion(body.model || "agent", content, effectiveCalls, parsed.reasoning);
    } catch (error) {
      log.warn("bridge", "duplicate recovery failed", { error: error?.message });
      return this.makeCompletion(body.model || "agent", guardedResult, null, "");
    }
  }

  #dump(name, value) {
    try {
      fs.writeFileSync(`/tmp/arena-agent-${name}.txt`, String(value), { mode: 0o600 });
      this.lastDumps[name] = String(value).slice(0, 400);
    } catch {
      /* non-fatal */
    }
  }

  async runAgent(body, headers) {
    return this.#serialized(async () => {
      this.#dump("last-request", JSON.stringify(body));
      const page = await this.#page();
      const key = sessionKey(body, headers);
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
      const stateless = hasTools;
      let state = stateless ? null : this.sessions.get(key);
      const priorNodeId =
        state && Date.now() - Number(state.updatedAt || 0) <= this.config.sessionTtlMs ? state.lastNodeId || null : null;
      const messages = stateless ? body.messages || [] : state ? latestTurn(body.messages) : body.messages || [];
      const includeTools = hasTools && (stateless || state?.toolsInitialized !== true);
      const prompt = formatMessages(messages, includeTools, body.tools, this.config.profile);
      this.#dump("last-prompt", prompt);
      if (!prompt.trim()) throw Object.assign(new Error("Arena Agent prompt is empty"), { status: 400 });

      if (!state || Date.now() - Number(state.updatedAt || 0) > this.config.sessionTtlMs) {
        state = await this.createAgentSession(page, prompt);
      } else {
        if (!page.url().startsWith("https://arena.ai/")) {
          await page.goto(`https://arena.ai/agent/${state.id}`, {
            waitUntil: "domcontentloaded",
            timeout: 60_000,
          });
        }
        try {
          await this.appendAgentMessage(page, state, prompt);
        } catch (error) {
          if (Number(error.status || 0) === 401 || Number(error.status || 0) === 404) {
            state = await this.createAgentSession(
              page,
              formatMessages(body.messages || [], hasTools, body.tools, this.config.profile)
            );
          } else {
            throw error;
          }
        }
      }

      let raw = await this.readAgentOutput(page, state);
      let parsed = parseAgentOutput(raw);
      if (priorNodeId && parsed.lastNodeId === priorNodeId && parsed.nativeCalls.length === 0) {
        if (parsed.token) state.token = parsed.token;
        if (parsed.lastEventId) state.lastEventId = parsed.lastEventId;
        const refreshedToken = await retry(() => this.refreshAgentToken(page, state.id), {
          attempts: 2,
          baseMs: 400,
          maxMs: 1500,
          label: "token-refresh",
        }).catch(() => "");
        if (refreshedToken) state.token = refreshedToken;
        await new Promise((r) => setTimeout(r, 400));
        raw = await this.readAgentOutput(page, state);
        parsed = parseAgentOutput(raw);
        this.runtime.staleReplays += 1;
        log.info("bridge", "skipped stale Arena Agent turn replay");
      }
      this.#dump("last-sse", raw);
      if (parsed.token) state.token = parsed.token;
      if (parsed.lastEventId) state.lastEventId = parsed.lastEventId;

      const textToolResult = parseToolCalls(parsed.text, body.tools, this.config.maxToolCalls);
      const nativeToolCalls = textToolResult.toolCalls
        ? null
        : parseNativeToolCalls(parsed.nativeCalls, body.tools, this.config.maxToolCalls);
      const effectiveToolCalls = textToolResult.toolCalls || nativeToolCalls;
      if (!effectiveToolCalls && parsed.nativeCalls.length > 0) {
        // Arena invoked its own sandbox tool but no external tool matched.
        // Stop the remote run and report clearly instead of "empty response".
        const names = [...new Set(parsed.nativeCalls.map((c) => c.name || "?"))].join(", ");
        await this.stopArenaRun(page).catch(() => undefined);
        this.runtime.nativeIntercepts += parsed.nativeCalls.length;
        const message =
          `(Arena agent attempted sandbox tool(s): ${names} — ` +
          `no external tool was registered for this request, so it was not executed. ` +
          `Re-send with tools defined, or ask the question directly without tool usage.)`;
        log.info("bridge", "unmapped arena native tool call reported", { names });
        return this.makeCompletion(body.model || "agent", message, null, parsed.reasoning);
      }
      const guardedResult = repeatedToolGuard(body, effectiveToolCalls);

      if (nativeToolCalls) {
        this.sessions.delete(key);
        await this.stopArenaRun(page);
        this.runtime.nativeIntercepts += nativeToolCalls.length;
        log.info("bridge", `intercepted ${nativeToolCalls.length} Arena native tool call(s)`, {
          names: nativeToolCalls.map((c) => c.function.name).join(","),
        });
        if (guardedResult) {
          this.runtime.duplicateBlocks += 1;
          return this.recoverFromDuplicate(page, body, prompt, guardedResult);
        }
        return this.makeCompletion(body.model || "agent", "", nativeToolCalls, parsed.reasoning);
      }

      state.lastNodeId = parsed.lastNodeId;
      state.requiresReview = parsed.requiresReview;
      state.toolsInitialized = state.toolsInitialized === true || hasTools;
      state.updatedAt = Date.now();
      if (stateless) this.sessions.delete(key);
      else this.sessions.set(key, state);

      if (guardedResult) {
        this.runtime.duplicateBlocks += 1;
        return this.recoverFromDuplicate(page, body, prompt, guardedResult);
      }
      const content = textToolResult.content || (textToolResult.toolCalls ? "" : parsed.text || "(empty Agent response)");
      return this.makeCompletion(body.model || "agent", content, textToolResult.toolCalls, parsed.reasoning);
    });
  }

  /**
   * Converse-only driver (the arena-local-bridge contract):
   * append ONE user message to an ALREADY-EXISTING, interactive Arena session
   * and return the agent's reply as an OpenAI chat.completion.
   *
   * This deliberately NEVER calls createAgentSession — session creation (and
   * model selection) is owned by the Arena模型助手 real browser, per the
   * architecture split. The caller identifies the target session via `model`
   * (the arena session id). Only the latest user message is sent; the session
   * itself retains full conversation history, so no cross-call state is needed.
   */
  async converse(sessionId, body, options = {}) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId || "")) {
      throw Object.assign(new Error(`Invalid Arena session id: ${sessionId}`), {
        status: 400,
        code: "invalid_session_id",
      });
    }
    const lastUser = [...(body.messages || [])].reverse().find((m) => m.role === "user");
    let prompt = lastUser ? contentText(lastUser.content) : "";
    if (!prompt || !prompt.trim()) {
      throw Object.assign(new Error("No user message to send"), { status: 400, code: "empty_prompt" });
    }
    // The owning Account is normally resolved by the caller BEFORE it opens a
    // response — a known-but-unusable owner must surface as a clean 409, not as
    // a mid-stream disconnect. Resolve here only for callers that did not, so
    // the rule still holds for every entry point.
    const account = options.account || this.#credential(options.accountEmail);
    log.info("bridge", "converse: account resolved", {
      sessionId,
      account: account.email,
      from: String(options.accountEmail || "").trim() ? "session-owner" : "pool-default",
    });
    // §4.25 — if the local AgentDock MCP endpoint is up, tell the session about
    // it once (kept deliberately short: long messages trip Arena's reCAPTCHA).
    // Internal probes (体检) must not consume the once-per-session MCP preamble:
    // injection is one-shot, so a health check would spend it and the real
    // conversation would never be told about the workspace.
    const mcpLine = options.injectMcp === false ? "" : this.#mcpEndpointLine(sessionId, options.headers || null);
    if (mcpLine) prompt = `${mcpLine}\n${prompt}`;

    // §4.36 — explicit end-of-turn marker (random per request). When the agent
    // echoes it we KNOW the turn is over, instead of inferring it from finish
    // events or quiet gaps. A fresh nonce can never appear in replayed history,
    // so it also tells us which turn is ours.
    const marker = this.config.turnMarkerEnabled
      ? `DONE-${crypto.randomBytes(4).toString("hex").toUpperCase()}`
      : "";
    if (marker) {
      prompt = `${prompt}\n\n（本轮任务完成后，请在最后单独一行原样输出这串标记，不要解释它：${marker}）`;
      log.info("bridge", "converse: end-of-turn marker attached", { sessionId, marker });
    }

    // §4.28 — a client-side TIMEOUT makes Codex RETRY the same request, which used
    // to send a DUPLICATE question into the Arena session and queue a second 90s+
    // run behind the first. Join identical in-flight calls onto one run instead.
    const inflightKey = `${sessionId}|${crypto.createHash("sha1").update(prompt).digest("hex")}`;
    const existing = this.inflight.get(inflightKey);
    if (existing) {
      log.info("bridge", "converse: joining identical in-flight request (client retry)", { sessionId });
      return existing;
    }
    // §4.33 — a retry that arrives AFTER the first run already finished must not
    // re-send the prompt into the Arena session.
    const cached = this.resultCache.get(inflightKey);
    if (cached && cached.expiresAt > Date.now()) {
      log.info("bridge", "converse: served from idempotency cache (client retry)", { sessionId });
      return cached.payload;
    }

    const work = this.#serialized(async () => {
      // Fresh per-request dedupe ledger for the streaming channel (§4.33).
      this._emittedByNode = new Map();
      // Count what actually went out, so we can tell "no delta came from Arena"
      // apart from "the channel is broken". The marker (§4.36) is held back from
      // the stream: we keep a tail the length of the marker, so it can never be
      // half-emitted before we strip it.
      let streamedDeltas = 0;
      let streamedChars = 0;
      const rawSink = typeof options.onDelta === "function" ? options.onDelta : null;
      const holdBack = marker ? marker.length + 4 : 0;
      let sinkTail = "";
      const stripMarker = (s) => (marker ? String(s).split(marker).join("") : String(s));
      const upstreamSink = rawSink
        ? (text) => {
            sinkTail += String(text || "");
            const cut = sinkTail.length - holdBack;
            if (cut <= 0) return;
            const out = stripMarker(sinkTail.slice(0, cut));
            sinkTail = sinkTail.slice(cut);
            if (out) {
              streamedDeltas += 1;
              streamedChars += out.length;
              rawSink(out);
            }
          }
        : null;
      const flushSink = () => {
        if (!rawSink || !sinkTail) return;
        const out = stripMarker(sinkTail);
        sinkTail = "";
        if (out) {
          streamedDeltas += 1;
          streamedChars += out.length;
          rawSink(out);
        }
      };
      // Hoisted so the `allow` tool policy (§4.23) can re-read /out with the same
      // session state (token + Last-Event-ID) after the agent runs a tool.
      let sessionState = null;
      // One full attempt: navigate to the session, dismiss the "继续工作" review
      // modal if present, fill the composer the Arena模型助手 way, click the real
      // Send button (§4.11), then read ONLY the most-recent turn (§4.12.3).
      const runOnce = async () => {
        const page = await this.#page(account);
        // Acquire the session public-access-token up front (re-used below).
        let token = "";
        try {
          const html = await page.evaluate(async (id) => (await fetch(`/agent/${id}`)).text(), sessionId);
          token = parsePublicToken(html);
        } catch {
          /* appendAgentMessage re-acquires it from the response header if missing */
        }
        const state = {
          id: sessionId,
          token,
          lastNodeId: null,
          requiresReview: false,
          toolsInitialized: false,
          updatedAt: Date.now(),
          readBudgetMs: this.config.readBudgetMs,
          marker,
        };
        sessionState = state;
        await this.appendAgentMessage(page, state, prompt);
        return this.readLatestTurn(page, state, upstreamSink);
      };
      let parsed;
      try {
        parsed = await runOnce();
      } catch (error) {
        // The headed browser page/context can be torn down mid-run (window
        // closed, context recycled on credential refresh, transient crash).
        // Recreate whatever died and retry ONCE — the Arena session itself is
        // server-side and remains intact. IMPORTANT: only discard the WHOLE
        // browser when it is actually disconnected; closing a healthy shared
        // browser would tear down any other operation that is mid-flight
        // (this caused a "page closed" cascade under cpa-gui's health probes).
        const msg = String(error?.message || "");
        if (
          /Target page, context or browser has been closed|Execution context was destroyed|Target closed|has been closed|ERR_ABORTED|frame was detached/i.test(
            msg
          )
        ) {
          log.warn("bridge", "converse: browser/page closed mid-run; recreating and retrying once", {
            sessionId,
            message: msg,
          });
          let browserAlive = false;
          try {
            browserAlive = Boolean(this.browser.browser && this.browser.browser.isConnected());
          } catch {
            browserAlive = false;
          }
          if (!browserAlive) await this.browser.close().catch(() => undefined);
          parsed = await runOnce();
        } else {
          throw error;
        }
      }
      if (parsed.debug) {
        log.info("bridge", "converse debug (readLatestTurn)", {
          sessionId,
          textLen: (parsed.text || "").length,
          textHead: (parsed.text || "").slice(0, 80),
          errorText: (parsed.errorText || "").slice(0, 160),
          lastNode: parsed.debug.lastNode,
          nodeKeys: parsed.debug.nodeKeys.slice(0, 12),
          nodeTexts: parsed.debug.nodeTexts,
          events: parsed.debug.events.slice(0, 45),
          timing: parsed.timing,
          streamedDeltas,
          streamedChars,
        });
      }
      // Node keys seen so far; a re-read only trusts text from a NEW node, which
      // is what makes receiving immune to /out replaying history (§4.18/§4.20).
      const seenNodes = new Set((parsed.turns || []).map((t) => t.k));

      if (parsed.nativeCalls.length > 0) {
        const names = [...new Set(parsed.nativeCalls.map((c) => c.name || "?"))].join(", ");
        if (this.config.toolPolicy === "allow") {
          // §4.23 — Arena's agent is allowed to run its own (sandbox) tools. Do
          // NOT stop the run; keep re-reading /out until the agent posts its
          // final answer after the tool completes. A follow-up read only accepts
          // text from a node that earlier reads have never seen, so replayed
          // history can never be mistaken for the new answer (§4.18/§4.20).
          log.info("bridge", "converse: allowing arena native tools; reading until final answer", {
            sessionId,
            names,
          });
          // §4.33b — `ask_user` means the remote agent is waiting for a HUMAN.
          // Nothing we can send will satisfy it, so waiting for the budget only
          // guarantees a client-side timeout (and a retry). Return immediately.
          const interactive = parsed.nativeCalls.find((c) => /ask_user|askuser|confirm|input/i.test(String(c.name || "")));
          if (interactive) {
            log.info("bridge", "converse: interactive tool requested; answering immediately instead of hanging", {
              sessionId,
              tool: interactive.name,
            });
            return this.makeCompletion(
              body.model || "agent",
              `(Arena agent is waiting for user input via the "${interactive.name}" tool. ` +
                `That cannot be answered from inside Codex — re-ask without triggering it, or drive the session in Arena.)`,
              null,
              ""
            );
          }
          // §4.37 — toolAllowBudgetMs <= 0 means NO deadline: keep following the
          // tool turn until it settles (no timer to trip Codex into a retry).
          const hasToolDeadline = this.config.toolAllowBudgetMs > 0;
          const deadline = hasToolDeadline ? Date.now() + this.config.toolAllowBudgetMs : 0;
          // §4.34 — keep reading while the turn is STILL RUNNING (a tool step just
          // ended), even though we already hold the pre-tool text. The old loop
          // required empty text, so it never ran and the half answer was returned.
          if (sessionState) sessionState.readBudgetMs = this.config.readBudgetMs > 0 ? 180_000 : 0;
          // §4.34b — only chase the turn further when the read did NOT settle
          // cleanly (no text at all, or it hit the budget). A clean
          // "tool-turn+quiet" already carries the complete answer, and another
          // read would just cost another minute for nothing.
          const unsettled =
            parsed.timing?.breakReason !== "turn+marker" &&
            (!(parsed.text || "").trim() || parsed.timing?.breakReason === "budget");
          for (
            let i = 0;
            i < this.config.toolAllowMaxReads && (!hasToolDeadline || Date.now() < deadline) && parsed.toolAfterReplay && unsettled;
            i++
          ) {
            await new Promise((r) => setTimeout(r, 1_500));
            if (!sessionState) break;
            if (parsed.lastEventId) sessionState.lastEventId = parsed.lastEventId;
            const next = await this.readLatestTurn(await this.#page(account), sessionState);
            if (next.token) sessionState.token = next.token;
            if (next.lastEventId) parsed.lastEventId = next.lastEventId;
            for (const call of next.nativeCalls || []) {
              if (!parsed.nativeCalls.some((c) => c.id === call.id)) parsed.nativeCalls.push(call);
            }
            if (next.errorText && !parsed.errorText) parsed.errorText = next.errorText;
            for (const t of next.turns || []) seenNodes.add(t.k);
            const added = (next.text || "").trim();
            if (added) parsed.text = (parsed.text || "") + next.text;
            parsed.toolAfterReplay = Boolean(next.toolAfterReplay);
            log.info("bridge", "converse: tool-turn follow-up read", {
              sessionId,
              round: i + 1,
              addedChars: added.length,
              totalChars: (parsed.text || "").length,
              stillToolPending: parsed.toolAfterReplay,
              readReason: next.timing?.breakReason,
            });
            if (!parsed.toolAfterReplay) break; // final step reached
          }
          if (!(parsed.text || "").trim()) {
            log.warn("bridge", "converse: tool ran but no final text captured", {
              sessionId,
              names,
              budgetMs: this.config.toolAllowBudgetMs,
            });
          }
        } else {
          // Legacy behaviour: conversation-only mode does not execute tools, so
          // stop the remote run and report clearly.
          await this.stopArenaRun(await this.#page(account)).catch(() => undefined);
          const message =
            `(Arena agent attempted sandbox tool(s): ${names}. ` +
            `Conversation-only mode does not execute tools — run without tools, or drive the session directly in Arena.)`;
          log.info("bridge", "converse: unmapped arena native tool call reported", { names });
          return this.makeCompletion(body.model || "agent", message, null, "");
        }
      }
      // §4.30 — /out can end (or deliver only replayed history) before our answer
      // lands. A bounded re-read usually recovers it, because by then the answer
      // is already stored in the session. Never invents text: only content from a
      // NEW node, or a read whose own post-window selection found content, counts.
      for (
        let attempt = 0;
        attempt < this.config.readRetryMax && !(parsed.text || "").trim() && !parsed.errorText;
        attempt++
      ) {
        await new Promise((r) => setTimeout(r, this.config.readRetryDelayMs));
        if (!sessionState) break;
        if (parsed.lastEventId) sessionState.lastEventId = parsed.lastEventId;
        sessionState.readBudgetMs = this.config.readBudgetMs > 0 ? 45_000 : 0;
        let again;
        try {
          again = await this.readLatestTurn(await this.#page(account), sessionState);
        } catch (error) {
          log.warn("bridge", "converse: re-read failed", {
            sessionId,
            attempt: attempt + 1,
            message: String(error?.message || error).slice(0, 160),
          });
          continue;
        }
        if (again.token) sessionState.token = again.token;
        if (again.lastEventId) parsed.lastEventId = again.lastEventId;
        if (again.errorText && !parsed.errorText) parsed.errorText = again.errorText;
        for (const call of again.nativeCalls || []) {
          if (!parsed.nativeCalls.some((c) => c.id === call.id)) parsed.nativeCalls.push(call);
        }
        const fresh = (again.turns || []).filter((t) => !seenNodes.has(t.k) && t.text && t.text.trim());
        for (const t of again.turns || []) seenNodes.add(t.k);
        const recovered = (again.text || "").trim() || (fresh.length ? fresh[fresh.length - 1].text : "");
        if (recovered) {
          parsed.text = recovered;
          log.info("bridge", "converse: recovered answer on re-read", {
            sessionId,
            attempt: attempt + 1,
            length: recovered.length,
            readReason: again.timing?.breakReason,
          });
          break;
        }
      }

      // §4.36 — release the held-back tail (marker already stripped inside) and
      // make sure the marker never reaches the client or the final payload.
      flushSink();
      if (marker && parsed.text) parsed.text = stripMarker(parsed.text).trim();

      const content =
        parsed.text || (parsed.errorText ? `(Arena stream error: ${parsed.errorText})` : "(empty Agent response)");
      return this.makeCompletion(body.model || "agent", content, null, "");
    });

    this.inflight.set(inflightKey, work);
    const cleanup = () => this.inflight.delete(inflightKey);
    work.then((payload) => {
      // §4.33 — remember the result briefly so a later retry is idempotent.
      if (this.config.resultCacheTtlMs > 0 && payload) {
        this.resultCache.set(inflightKey, { payload, expiresAt: Date.now() + this.config.resultCacheTtlMs });
        while (this.resultCache.size > 50) {
          const oldest = this.resultCache.keys().next().value;
          if (oldest === undefined) break;
          this.resultCache.delete(oldest);
        }
      }
      cleanup();
    }, cleanup);
    return work;
  }

  /**
   * The active account's remaining quota, read through the project's single
   * page-reading entry point (src/probe/). Two independent readings, because
   * they come from different places:
   *
   *   percent — a plain same-origin GET to Arena. Always available.
   *   usd     — the probe's snapshot of the trace's cost spans. Only present
   *             once a run on this page has settled, so it is often absent.
   *
   * Never touches another account: switching credential tears the shared
   * browser context down, which would kill whatever turn is in flight.
   */
  async quotaSnapshot() {
    const account = this.#credential();
    const page = await this.#page(account);
    const snap = await readSnapshot(page, { waitForModel: false });
    return {
      email: account.email,
      percent: snap.percent,
      percentSource: snap.percentSource,
      usd: snap.usd,
      usdStatus: snap.usdStatus,
      error: snap.error,
      checkedAt: new Date().toISOString(),
    };
  }

  healthPayload() {
    const credential = this.credentials.primary();
    const averageLatencyMs = this.runtime.completed
      ? Math.round(this.runtime.totalLatencyMs / this.runtime.completed)
      : 0;
    return {
      ok: true,
      service: "arena-bridge",
      version: VERSION,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      mode: "stateless-claude-tools",
      sessions: this.sessions.size,
      activeArenaAccounts: this.credentials.accounts.length,
      account: credential ? { email: credential.email, cookieExpiry: this.credentials.expirySummary(credential) } : null,
      // Per-account health. An account that Arena refuses to serve is disabled
      // here rather than silently driving a dead session — this is what makes a
      // restricted account visible instead of showing ok forever.
      accounts: this.credentials.list(),
      refresh: { lastLoginError: this.credentials.lastLoginError },
      recaptcha: this.recaptcha.status(),
      queue: { active: this.runtime.activeRequests, depth: this.runtime.queueDepth, maxDepth: this.config.maxQueue },
      browser: {
        launched: Boolean(this.browser.browser),
        contextReady: Boolean(this.browser.context),
        pageReady: Boolean(this.browser.page && !this.browser.page.isClosed()),
      },
      stats: { ...this.runtime, averageLatencyMs },
    };
  }

  prometheusMetrics() {
    const values = {
      arena_bridge_up: 1,
      arena_bridge_uptime_seconds: Math.floor((Date.now() - this.startedAt) / 1000),
      arena_bridge_queue_depth: this.runtime.queueDepth,
      arena_bridge_active_requests: this.runtime.activeRequests,
      arena_bridge_requests_total: this.runtime.requests,
      arena_bridge_completed_total: this.runtime.completed,
      arena_bridge_errors_total: this.runtime.errors,
      arena_bridge_tool_responses_total: this.runtime.toolResponses,
      arena_bridge_text_responses_total: this.runtime.textResponses,
      arena_bridge_native_intercepts_total: this.runtime.nativeIntercepts,
      arena_bridge_duplicate_blocks_total: this.runtime.duplicateBlocks,
      arena_bridge_recovery_attempts_total: this.runtime.recoveryAttempts,
      arena_bridge_recovery_successes_total: this.runtime.recoverySuccesses,
      arena_bridge_stale_replays_total: this.runtime.staleReplays,
      arena_bridge_last_latency_ms: this.runtime.lastLatencyMs,
    };
    return `${Object.entries(values).map(([name, value]) => `${name} ${Number(value) || 0}`).join("\n")}\n`;
  }
}
