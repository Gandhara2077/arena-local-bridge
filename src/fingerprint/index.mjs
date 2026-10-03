/**
 * fingerprint/index.mjs — the project's entry point to model identification by
 * numeric fingerprint
 *
 * Three jobs, kept together because they share one idea (a probe reply is the
 * unit of evidence):
 *
 *   collect      run a probe turn on a Session and store the reply
 *   identify     run a probe turn and attribute it against the stored bank
 *   bankStatus   say whether the collected data can support an attribution
 *
 * The rule that shapes all of it: an attribution is a guess with a confidence,
 * not a fact. Callers get `{ model, confidence }` and a threshold decides
 * whether that is worth writing anywhere. Below the threshold this reports
 * "unresolved" and hands back what it did infer, so the caller can log a
 * near-miss instead of a wrong answer.
 */
import { attribute, calibrateBeta, ORDERED_WEIGHT } from "./numeric-bank.mjs";
import { dotProduct } from "./numeric.mjs";
import { buildBank, appendRecord, readStore, storeSummary } from "./bank-store.mjs";
import { probePrompt, probeTurn, variantIds, PROBE_COUNT } from "./probe-prompts.mjs";

/**
 * Default raw-score margin for a two-model bank, and cap for larger banks.
 *
 * Why margin and not the softmax confidence: on a small bank the standardised
 * scores saturate, so every reply — including one that matches nothing — comes
 * back at ~99% confidence. Measured on a two-model bank: a true match reaches a
 * margin of 2.00 (the ceiling for two unit vectors), while a reply belonging to
 * neither reaches 0.84 at the same 99.75% confidence. The margin is the only one
 * of the two that carries the distinction, so it is what the gate reads.
 */
export const MIN_MARGIN = 1.2;

/**
 * A larger bank can put even an ideal match less than 1.2 ahead of its nearest
 * rival. Cap the default at THIS candidate's own centroid margin, using the
 * same layer weights as attribution. An unrelated close pair must not weaken
 * its gate. Degenerate/tied centroids retain the conservative fixed gate.
 * ponytail: geometry is not open-set calibration; validate rejection rates on
 * held-out known and unknown models before treating this as an accuracy claim.
 */
function defaultMargin(bank, model) {
  if (bank.modelIds.length <= 2) return MIN_MARGIN;
  const m = bank.marginal.centroids;
  const o = bank.ordered.centroids;
  const score = (id) => (1 - ORDERED_WEIGHT) * dotProduct(m[model], m[id])
    + ORDERED_WEIGHT * dotProduct(o[model], o[id]);
  const own = score(model);
  const gap = own - Math.max(...bank.modelIds.filter((id) => id !== model).map(score));
  return Number.isFinite(gap) && gap > 1e-12 ? Math.min(MIN_MARGIN, gap) : MIN_MARGIN;
}

/**
 * Minimum confidence, applied on top of the margin.
 *
 * On a large bank (8–9 models, as measured against the reference data) the
 * confidence does discriminate, and requiring both is strictly safer than
 * either alone. On a small bank this is inert, which is fine: the margin is
 * already carrying the decision there.
 */
export const CONFIDENCE_THRESHOLD = 0.6;

export { variantIds, PROBE_COUNT, probePrompt, probeTurn };

/**
 * Run one probe turn on a Session and record the reply.
 *
 * The caller supplies `ask`, which performs the turn and returns the reply text
 * — the same shape `bridge.converse` already produces. Keeping the turn itself
 * out of this module is what lets the whole flow be tested without a browser.
 *
 * `model` is optional and normally absent: not knowing it is the reason this
 * module exists. An unlabelled record is still stored, because the probe cost a
 * turn and the reply can be attributed later.
 */
export async function collect({ dataDir, variant, ask, model = "", condition = null, requestedCount = PROBE_COUNT }) {
  const prompt = probeTurn(variant);
  const text = await ask(prompt);
  if (typeof text !== "string" || !text.trim()) {
    return { stored: false, reason: "the probe turn produced no text", prompt };
  }
  const record = appendRecord(dataDir, {
    text,
    model,
    variant: resolveVariant(variant),
    condition: condition ?? resolveVariant(variant),
    requestedCount,
  });
  return { stored: true, reason: null, prompt, record };
}

/**
 * Probe a Session, then attribute the reply against the stored bank.
 *
 * Returns one of three distinguishable outcomes, and never conflates them:
 *   attributed — the reply matched a model above the threshold
 *   unresolved — a fingerprint was obtained but did not clear the threshold
 *   failed     — no usable fingerprint (short reply, no bank, a failed turn)
 *
 * `unresolved` carries the top guess and its confidence so the caller can show
 * a near-miss. Treating it as "failed" would throw away information; treating
 * it as "attributed" would be a lie.
 */
export async function identify({ dataDir, variant, ask, expectedCount = PROBE_COUNT, threshold = CONFIDENCE_THRESHOLD, minMargin, store = true }) {
  const { bank, reason } = buildBank(dataDir, { expectedCount });
  if (!bank) {
    // Still run nothing: without a bank the probe would cost a turn and prove
    // nothing. Report the gap instead.
    return { status: "failed", model: null, confidence: null, reason, stats: storeSummary(dataDir) };
  }

  const prompt = probeTurn(variant);
  const text = await ask(prompt);
  if (typeof text !== "string" || !text.trim()) {
    return { status: "failed", model: null, confidence: null, reason: "the probe turn produced no text" };
  }

  const variantId = resolveVariant(variant);
  if (store) {
    appendRecord(dataDir, { text, variant: variantId, condition: variantId, requestedCount: expectedCount });
  }

  const result = attribute(text, bank, { expectedCount, beta: bank.beta });
  if (!result) {
    return { status: "failed", model: null, confidence: null, reason: "the reply was too short to fingerprint" };
  }
  // Both gates, so a large bank's confidence still counts and a small bank's
  // saturated confidence cannot carry a decision on its own.
  const requiredMargin = minMargin === undefined ? defaultMargin(bank, result.model) : minMargin;
  // Allow only floating-point roundoff at an exact centroid match.
  if (result.margin + 1e-12 < requiredMargin || result.confidence < threshold) {
    return {
      status: "unresolved",
      model: null,
      confidence: result.confidence,
      margin: result.margin,
      nearMiss: result.model,
      reason:
        `top guess ${result.model} at ${(result.confidence * 100).toFixed(1)}% confidence / ` +
        `${result.margin.toFixed(2)} margin; below the required ${requiredMargin.toFixed(2)} margin ` +
        `or ${(threshold * 100).toFixed(1)}% confidence gate`,
      rawScores: result.rawScores,
    };
  }
  return {
    status: "attributed",
    model: result.model,
    confidence: result.confidence,
    margin: result.margin,
    rawScores: result.rawScores,
    reason: null,
  };
}

/**
 * What the collected data currently supports.
 *
 * `ready` is deliberately strict: it asks for at least two models and at least
 * two conditions, because a bank missing either cannot attribute anything — and
 * saying "ready" while returning a bank that `buildBank` refuses would be the
 * same class of lie as a fabricated model name.
 */
export function bankStatus(dataDir, { expectedCount } = {}) {
  const stats = storeSummary(dataDir);
  const { bank, reason } = buildBank(dataDir, { expectedCount });
  return {
    ready: Boolean(bank),
    reason,
    stats,
    modelIds: bank ? bank.modelIds : [],
    conditions: bank ? bank.conditions : [],
    nuisanceDirections: bank ? bank.nuisanceDirections : 0,
  };
}

/**
 * Fit the attribution sharpness from the collected data.
 *
 * Kept separate from `buildBank`, which is called on every attribution: fitting
 * beta re-runs the whole leave-one-condition-out sweep, which is the expensive
 * part. A bank therefore carries whatever beta the caller passes to
 * `attribute`; this function is how a good one is obtained.
 */
export function fitSharpness(dataDir, { expectedCount } = {}) {
  const { bank } = buildBank(dataDir, { expectedCount });
  if (!bank) return { beta: null, reason: "no bank to calibrate" };
  const { records } = readStore(dataDir);
  return calibrateBeta(
    records.filter((r) => r.usable && r.model).map((r) => ({
      text: r.text,
      model: r.model,
      condition: r.condition,
      requestedCount: r.requestedCount ?? expectedCount,
    }))
  );
}

/** A variant given by id or index, as the id the store records. */
function resolveVariant(variant) {
  if (typeof variant === "string") return variant;
  return variantIds()[variant] ?? null;
}
