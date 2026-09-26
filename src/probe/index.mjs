// src/probe/index.mjs — the project's single entry point to the page probe.
//
// Two functions, and nothing else touches the probe:
//
//   installProbe(page)   inject the assembled bundle (called once per page, by
//                        ArenaBrowser.getPage — before the navigation that will
//                        carry a conversation, so the hooks see it).
//   readSnapshot(page)   ONE round trip into the page that returns everything
//                        we know: the model, its reasoning tier, the run id,
//                        the USD quota the probe observed, and the account
//                        percentage from Arena's own endpoint.
//
// The percentage is read here too, even though it does not come from the probe.
// It is a same-origin GET that has to happen inside the page, and keeping it in
// this one function is what makes "there is exactly one path that reads the
// page" true rather than aspirational.
import { assembleProbe } from "./assemble.mjs";

const INIT_SNIPPET = "window.__MODEL_PROBE_OPTIONS__={};";

/**
 * Install the probe so it runs on every navigation of this page.
 * Must be called BEFORE the first goto, hence addInitScript.
 */
export async function installProbe(page) {
  let src;
  try {
    src = assembleProbe();
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  await page.addInitScript(`${INIT_SNIPPET}\n${src}`);
  return { ok: true };
}

/**
 * Runs inside the page. `wantPercent` is false while polling: the quota
 * endpoint is a real request to Arena, and polling it every intervalMs for up
 * to timeoutMs would be 30 requests for one answer.
 */
async function readInPage(opts) {
  const out = {
    probePresent: false,
    model: null,
    effort: null,
    runId: null,
    usd: null,
    usdStatus: null,
    percent: null,
    percentSource: null,
    error: null,
  };
  const api = window.__MODEL_PROBE__;
  out.probePresent = !!api;

  const readModel = () => {
    try {
      return api && api.realModel ? api.realModel() : null;
    } catch {
      return null;
    }
  };

  let model = readModel();
  if (opts.poll && !model && api && typeof api.pollRunModels === "function") {
    try {
      // The option is maxMs, not timeout — passing "timeout" silently falls back
      // to the 180 s default, which would blow past this function's own budget.
      await api.pollRunModels({ maxMs: 8_000, firstIntervalMs: 1_500 });
    } catch {
      /* keep polling */
    }
    model = readModel();
  }
  out.model = model || null;

  try {
    const state = api && api.runState ? api.runState() : null;
    out.runId = (state && state.runId) || null;
  } catch {
    /* leave null */
  }

  // realModel() hands back a bare name, so the reasoning tier has to come from
  // desktopFacts(). internalTier is the tier the backend actually ran — the
  // probe recovers it by comparing its own model name with the one that was
  // requested (asked gpt-5.6-sol, ran gpt-5.6-sol-low). effort.level would be
  // an explicitly configured value, which Arena does not send.
  try {
    const facts = api && api.desktopFacts ? api.desktopFacts() : api && api.reasoning ? api.reasoning() : null;
    out.effort = (facts && (facts.internalTier || (facts.effort && facts.effort.level))) || null;
  } catch {
    out.effort = null;
  }

  try {
    const snap = api && api.usdQuotaSnapshot ? api.usdQuotaSnapshot() : null;
    out.usdStatus = (snap && snap.status) || "probe-unavailable";
    out.usd = (snap && snap.quota) || null;
  } catch {
    out.usdStatus = "error";
  }

  if (opts.wantPercent) {    const getJson = async (path) => {
      const r = await fetch(path, { headers: { Accept: "application/json" } });
      return r.ok ? r.json() : null;
    };
    try {
      const d = await getJson("/api/me/pulse");
      if (Number.isInteger(d && d.pulse) && d.pulse >= 0 && d.pulse <= 100) {
        out.percent = d.pulse;
        out.percentSource = "pulse";
      }
    } catch (e) {
      out.error = String((e && e.message) || e);
    }
    // The credits endpoint is a fallback reading, not a USD conversion. A 403
    // there is transient, so it must not disable anything.
    if (out.percent === null) {
      try {
        const d = await getJson("/api/billing/balance");
        const ok =
          Number.isSafeInteger(d && d.creditsRemaining) &&
          Number.isSafeInteger(d && d.dailyFreeCredits) &&
          d.dailyFreeCredits > 0;
        if (ok) {
          out.percent = Math.round((d.creditsRemaining / d.dailyFreeCredits) * 100);
          out.percentSource = "billing";
        }
      } catch (e) {
        out.error = out.error || String((e && e.message) || e);
      }
    }
  }

  return out;
}

const EMPTY = {
  probePresent: false,
  model: null,
  effort: null,
  runId: null,
  usd: null,
  usdStatus: null,
  percent: null,
  percentSource: null,
  error: null,
};

/**
 * One round trip into the page for everything we read from it.
 *
 * waitForModel=true  — poll until the model resolves (or timeout), then take a
 *                      final reading that also fetches the percentage.
 * waitForModel=false — read once. Used for the on-demand quota refresh.
 */
export async function readSnapshot(page, { timeoutMs = 45_000, intervalMs = 1500, waitForModel = true } = {}) {
  // A freshly created context sits on about:blank, where the relative quota
  // endpoints would not resolve. Land on the origin first.
  const onArena = await page
    .evaluate(() => location.origin === "https://arena.ai")
    .catch(() => false);
  if (!onArena) {
    await page.goto("https://arena.ai/agent", { waitUntil: "domcontentloaded", timeout: 60_000 });
  }

  const read = (opts) => page.evaluate(readInPage, opts).catch(() => null);

  if (!waitForModel) {
    return (await read({ wantPercent: true, poll: false })) || { ...EMPTY };
  }

  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const snap = await read({ wantPercent: false, poll: true });
    if (snap) last = snap;
    if (last && last.model) break;
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  // Final reading, this time with the percentage. The trace detail can also
  // land after the model name does, so this is the reading we return.
  const final = await read({ wantPercent: true, poll: false });
  return final || last || { ...EMPTY };
}
