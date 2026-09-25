// probe.mjs — identify WHICH model answered a freshly created Arena session,
// and at which reasoning tier.
//
// The work itself is done by assets/arena-model-probe.inject.js, a
// self-contained bundle that ships with this project. It is injected into the
// Playwright page and hooks the page's own network, so it reads the same trace
// the page fetches: no run token needed, no extra request, and no dependence on
// the token happening to carry read:runs scope.
//
// This module is only the adapter — read the bundle, inject it, ask it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROBE_PATH = path.join(__dirname, "..", "assets", "arena-model-probe.inject.js");

let cachedSource = null;
function probeSource() {
  if (cachedSource === null) {
    try {
      cachedSource = fs.readFileSync(PROBE_PATH, "utf8");
    } catch {
      cachedSource = "";
    }
  }
  return cachedSource;
}

// The host shell (that's us) hides the probe HUD; we render results ourselves.
const INIT_SNIPPET = "window.__MODEL_PROBE_OPTIONS__={showHUD:false};";

/**
 * Install the probe so it runs on every navigation of this page.
 * Must be called BEFORE the first goto, hence addInitScript.
 */
export async function installProbe(page) {
  const src = probeSource();
  if (!src) return { ok: false, error: "未找到 assets/arena-model-probe.inject.js" };
  await page.addInitScript(`${INIT_SNIPPET}\n${src}`);
  return { ok: true };
}

/**
 * Ask the in-page probe for the real model name, polling until it resolves.
 * Returns { model, effort, runId, via } or { model: null, ... }.
 */
export async function readModelFromPage(page, { timeoutMs = 45_000, intervalMs = 1500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = { model: null, effort: null, runId: null, error: null };
  while (Date.now() < deadline) {
    const snap = await page
      .evaluate(async () => {
        const api = window.__MODEL_PROBE__;
        if (!api) return { ready: false };
        const read = () => {
          try {
            return api.realModel ? api.realModel() : null;
          } catch {
            return null;
          }
        };
        let model = read();
        if (!model && typeof api.pollRunModels === "function") {
          try {
            await api.pollRunModels({ timeout: 8000 });
          } catch {
            /* keep polling */
          }
          model = read();
        }
        let state = null;
        try {
          state = api.runState ? api.runState() : null;
        } catch {
          state = null;
        }
        // realModel() hands back a bare name, so the reasoning tier has to come
        // from desktopFacts(). internalTier is the tier the backend actually
        // ran — the probe recovers it by comparing its own model name with the
        // one that was requested (asked gpt-5.6-sol, ran gpt-5.6-sol-low).
        // effort.level would be an explicitly configured value, which Arena
        // does not send; it stays only as a fallback for the day it does.
        let effort = null;
        try {
          const facts = api.desktopFacts ? api.desktopFacts() : api.reasoning ? api.reasoning() : null;
          effort = facts?.internalTier || facts?.effort?.level || null;
        } catch {
          effort = null;
        }
        return {
          ready: true,
          model: model || null,
          effort,
          runId: state?.runId || null,
          error: state?.lastError || null,
        };
      })
      .catch(() => ({ ready: false }));
    // The trace detail can land after the model name does, so remember the
    // first tier we ever see rather than only the poll that found the model.
    if (snap?.ready) {
      last = {
        model: snap.model || last.model,
        effort: snap.effort || last.effort,
        runId: snap.runId || last.runId,
        error: snap.error || null,
      };
    }
    if (last.model) return { ...last, via: "page-probe" };
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { ...last, via: "page-probe" };
}
