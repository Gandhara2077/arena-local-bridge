#!/usr/bin/env node
// selftest.mjs — end-to-end check against the real Arena, over the REAL turn path.
//
// Two paths, because they fail for different reasons and only one of them is the
// one every real request takes:
//
//   create   : createAgentSession() -> POST /nextjs-api/stream/create-chat
//              The only path Arena gates on reCAPTCHA, so a 403 here is the
//              expected flake. Its failure has to say WHAT failed, not just that
//              something did.
//   converse : converse() -> /sessions/<id>/out + in/append + end-of-turn marker
//              What the bridge uses day to day. A smoke test that does not
//              exercise it cannot tell you whether the bridge works.
//
// Usage:
//   DATA_DIR=... node bin/selftest.mjs
//   SELFTEST_SESSION_ID=<arena-uuid>  converse on an existing Session instead of
//                                     creating one first
//   SELFTEST_SKIP_CREATE=1            skip the create path
//
// Exit codes: 0 = PASS, 2 = PARTIAL (turn plumbing works, the answer differs), 1 = FAIL.
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadDotEnv, loadConfig } from "../src/config.mjs";
import { CredentialStore } from "../src/credentials.mjs";
import { Bridge } from "../src/bridge.mjs";
import { log } from "../src/util.mjs";
import { requireSecret } from "../src/secret.mjs";

/** The answer the smoke asks for, so a reply can be judged rather than merely read. */
export const EXPECTED = "BRIDGE_OK";

/** Visible contenteditable count — what Arena's composer looks like from the page. */
const COMPOSER_PROBE = () =>
  Array.from(document.querySelectorAll('[contenteditable="true"]')).filter((el) => el.offsetParent !== null).length;

/**
 * What a failed compose actually looked like.
 *
 * A bare `403 recaptcha validation failed` cannot separate "reCAPTCHA scored the
 * automated browser low" from "the composer never rendered" or "the proxy was not
 * in effect" — and those call for different reactions from whoever runs the smoke.
 *
 * `kind` is a heuristic, not a verdict: reCAPTCHA is the one cause the message
 * names outright, and everything else lands in "compose". The remaining fields
 * are what a person reads to tell the two compose causes apart; this reports, it
 * does not decide. The page probe is best-effort — a dead page must not replace
 * the original error with one about the diagnostics themselves.
 */
export async function diagnoseComposeFailure(page, error, { proxy = "" } = {}) {
  let pageUrl = "";
  let composerEditors = null;
  try {
    pageUrl = String(page.url() || "");
  } catch {
    /* the page may already be gone */
  }
  try {
    composerEditors = await page.evaluate(COMPOSER_PROBE);
  } catch {
    /* ditto */
  }
  const message = String(error?.message || error || "");
  return {
    kind: /recaptcha/i.test(message) ? "recaptcha" : "compose",
    status: Number(error?.status || 0) || null,
    headed: process.env.ARENA_HEADED === "1",
    // The value the BROWSER was actually handed, not what the shell happens to
    // export: the ordinary way to configure the proxy is DATA_DIR/.env, which
    // loadConfig folds in but process.env never sees. Reading process.env here
    // would report "unset" for exactly the setups where the answer matters.
    // ARENA_HEADED above is different — arena-login.mjs reads it from
    // process.env itself, so process.env is the truth for that one.
    proxy: proxy ? "set" : "unset",
    pageUrl,
    composerEditors,
    message,
  };
}

/**
 * Judge one turn's outcome. Kept separate from the driving so the difference
 * between "Arena refused us", "the turn never landed" and "the answer differs"
 * is a decision the tests can pin down without a browser.
 */
export function classifyTurn({ error = null, text = "", expected = EXPECTED } = {}) {
  const message = String(error?.message || error || "");
  if (/recaptcha/i.test(message)) return "recaptcha";
  if (error) return "transport";
  const body = String(text || "").trim();
  if (!body) return "no-answer";
  return new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(body) ? "ok" : "mismatch";
}

/**
 * Create a Session AND consume its first turn before returning.
 *
 * `createAgentSession()` resolves as soon as the Session exists; the turn it
 * started is still running. Every production caller settles it before appending
 * anything — runAgent and recoverFromDuplicate both call readAgentOutput right
 * here — because the alternative is an append against a composer that is still
 * generating. That is a race no real request can produce, so a smoke that skips
 * it would be exercising a flow that does not exist. Hence one function: the
 * order IS the invariant, and this is where it is stated.
 */
export async function createSessionAndSettle(bridge, page, prompt) {
  const state = await bridge.createAgentSession(page, prompt);
  await bridge.readAgentOutput(page, state);
  return state;
}

/**
 * One turn over the path every real request takes, returning the reply text.
 *
 * The MCP preamble is deliberately out of scope here: this smoke is about the
 * turn plumbing, and whether that preamble's own wording survives the agent's
 * scrutiny is a separate concern with its own ticket. Leaving it in would make
 * the smoke fail for a reason that has nothing to do with plumbing.
 */
export async function converseOnce(bridge, sessionId, prompt) {
  const reply = await bridge.converse(
    sessionId,
    { model: sessionId, messages: [{ role: "user", content: prompt }] },
    { injectMcp: false }
  );
  return String(reply?.choices?.[0]?.message?.content || "");
}

async function main() {
  const dataDir = process.env.DATA_DIR || path.join(os.homedir(), ".arena-bridge");
  const dotEnv = loadDotEnv(path.join(dataDir, ".env"));
  const config = loadConfig({ ...dotEnv, ...process.env }, { requireBridgeKey: false });
  const secret = requireSecret(dotEnv);
  const credentials = new CredentialStore({
    filePath: config.credentialsFile,
    secret,
    omniDbPath: config.omniDbPath,
    omniRoot: config.omniRoot,
  }).load();

  const account = credentials.primary();
  if (!account) {
    console.log("SELFTEST FAIL: no credentials. Run: node bin/login.mjs --email <e> --password <p>");
    process.exit(1);
  }
  console.log(
    `SELFTEST account=${account.email} cookieExpiry=${credentials.expirySummary(account)} ` +
      `headed=${process.env.ARENA_HEADED === "1"}`
  );

  const bridge = new Bridge({ config, credentials, recaptcha: null });
  await bridge.start();
  try {
    let sessionId = String(process.env.SELFTEST_SESSION_ID || "").trim();

    if (!sessionId && process.env.SELFTEST_SKIP_CREATE !== "1") {
      const page = await bridge.browser.getPage(account, "converse");
      try {
        const state = await createSessionAndSettle(bridge, page, `Reply with exactly: ${EXPECTED}`);
        sessionId = state.id;
        console.log(`SELFTEST create ok session=${state.id}`);
      } catch (error) {
        console.log(
          `SELFTEST create failed ${JSON.stringify(await diagnoseComposeFailure(page, error, { proxy: config.proxy }))}`
        );
        throw error;
      }
    }

    if (!sessionId) {
      console.log("SELFTEST FAIL: nothing to converse on — set SELFTEST_SESSION_ID");
      process.exit(1);
    }

    let text = "";
    let error = null;
    try {
      text = await converseOnce(bridge, sessionId, `Reply with exactly: ${EXPECTED}`);
    } catch (thrown) {
      error = thrown;
    }
    const kind = classifyTurn({ error, text });
    console.log(`SELFTEST converse session=${sessionId} kind=${kind} reply=${JSON.stringify(text.slice(0, 120))}`);
    if (error) {
      // `kind` collapses every transport failure into one word, which is the
      // state this ticket set out to fix. Print what the throw actually said:
      // 403 and 401 and "session not interactive" want different follow-ups.
      console.log(
        `SELFTEST converse error ${JSON.stringify({
          status: Number(error?.status || 0) || null,
          code: error?.code || null,
          message: String(error?.message || error),
        })}`
      );
    }
    if (kind === "ok") {
      console.log("SELFTEST PASS");
      process.exit(0);
    }
    if (kind === "mismatch") {
      console.log("SELFTEST PARTIAL (turn plumbing works, the answer differs)");
      process.exit(2);
    }
    console.log("SELFTEST FAIL");
    process.exit(1);
  } finally {
    await bridge.browser.close().catch(() => undefined);
  }
}

// Only when actually run. The helpers above are imported by test/selftest.test.mjs,
// and importing a script must not start a browser.
const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    log.error("selftest", "failed", { message: error.message });
    console.log("SELFTEST FAIL");
    process.exit(1);
  });
}
