/**
 * fingerprint/numeric-bank.mjs — fit a bank, then attribute a reply to a model
 *
 * This is the top half of the numeric fingerprint: given a set of labelled
 * replies, build the artifacts (feature centring, the environment nuisance
 * basis, the per-model centroids), and given a new reply, score it against
 * every model and turn the scores into a probability.
 *
 * Two feature layers, fused:
 *   marginal (355)  — the histogram of chosen values, Hellinger-transformed
 *   ordered  (74)   — four quarters x 16 bins, plus last digits
 * The marginal layer dominates; the ordered layer is a 0.25 tie-breaker that
 * carries the *shape* of the run, which a histogram throws away.
 *
 * The environment nuisance basis matters in production, not in the lab: the
 * same model answers differently depending on the surrounding conversation, and
 * without the projection that drift would be read as model identity.
 */
import {
  meanVector,
  columnScale,
  normalize,
  projectOut,
  standardize,
  softmax,
  topRightSingularVectors,
} from "./numeric.mjs";
import {
  parseNumbers,
  countNumbers,
  hellingerFeature,
  orderedBlockFeature,
  standardizeAgainst,
  isUsable,
} from "./numeric-probe.mjs";

/** Weight of the ordered layer in the fused score. */
export const ORDERED_WEIGHT = 0.25;

/**
 * How many nuisance directions to project out. Two matches the reference
 * method; more would start eating model signal, which is what a cross-validated
 * ablation showed (dropping the projection costs accuracy, over-projecting
 * would cost more).
 */
const NUISANCE_DIRECTIONS = 2;

/**
 * Build a bank from labelled replies.
 *
 * Each record needs `{ text, model, condition }`: the reply, the model that
 * produced it, and whatever groups "same circumstances" — the Arena session, in
 * our case. Condition is what the nuisance projection learns from, so a bank
 * with a single condition simply gets no projection (and says so via
 * `nuisanceDirections: 0`) rather than pretending to have one.
 *
 * Records that parse as unusable are dropped here, not at scoring time, so the
 * centroids never see a half-empty run.
 */
export function fitBank(records) {
  const usable = records.filter((r) => isUsable(parseNumbers(r.text), r.requestedCount));
  const modelIds = [...new Set(usable.map((r) => r.model))].sort();
  if (!modelIds.length) throw new Error("fitBank: no usable records for any model");

  const conditions = [...new Set(usable.map((r) => r.condition ?? ""))];

  // ── marginal layer ───────────────────────────────────────────────────────
  const raw = usable.map((r) => hellingerFeature(countNumbers(parseNumbers(r.text))));
  const featureMean = meanVector(raw);
  const featureScale = columnScale(raw, featureMean);
  const standardized = raw.map((f) => standardizeAgainst(f, featureMean, featureScale));

  // Learn the environment offset direction: mean-centre each condition, then
  // take the principal directions of those condition offsets.
  const conditionMeans = conditions.map((c) =>
    meanVector(usable.map((r, i) => (r.condition === c ? standardized[i] : null)).filter(Boolean))
  );
  const offsetMean = meanVector(conditionMeans);
  const offsets = conditionMeans.map((m) => m.map((v, i) => v - offsetMean[i]));
  const basis = conditions.length >= 3 ? topRightSingularVectors(offsets, NUISANCE_DIRECTIONS) : [];
  const projected = standardized.map((f) => projectOut(f, basis));

  const centroids = {};
  for (const id of modelIds) {
    const vecs = projected.filter((_, i) => usable[i].model === id);
    centroids[id] = normalize(meanVector(vecs));
  }

  // ── ordered layer ────────────────────────────────────────────────────────
  // The ordered feature is centred but NOT projected: the environment offsets
  // were measured in the marginal space, and reusing that basis here would be
  // applying a rotation fitted for different axes.
  const oRaw = usable.map((r) => orderedBlockFeature(parseNumbers(r.text)));
  const orderedMean = meanVector(oRaw);
  const orderedScale = columnScale(oRaw, orderedMean);
  const oStd = oRaw.map((f) => standardizeAgainst(f, orderedMean, orderedScale));

  const orderedCentroids = {};
  for (const id of modelIds) {
    const vecs = oStd.filter((_, i) => usable[i].model === id);
    orderedCentroids[id] = normalize(meanVector(vecs));
  }

  return {
    modelIds,
    conditions,
    usableCount: usable.length,
    droppedCount: records.length - usable.length,
    nuisanceDirections: basis.length,
    marginal: { featureMean, featureScale, basis, centroids },
    ordered: { orderedMean, orderedScale, centroids: orderedCentroids },
  };
}

/**
 * Attribute one reply.
 *
 * `beta` sharpens the softmax. It is a fitted parameter, not a taste: with too
 * small a value everything looks like the same model, with too large a value
 * the top guess is noise. `calibrateBeta` below fits it on held-out data.
 *
 * Returns null when the reply is unscoreable, so a caller can distinguish
 * "could not fingerprint this" from "fingerprinted it as X".
 *
 * Two things are reported, and the difference matters:
 *
 *   rawScores — cosine similarity to each centroid, in [−1, 1] against unit
 *               vectors. This is a measure of absolute fit.
 *   margin    — best minus second-best raw score. This is what tells a match
 *               from a non-match, because it does not depend on how many models
 *               the bank happens to hold.
 *
 * `confidence` is a softmax over the *standardised* scores, which is the right
 * shape for choosing between candidates but a poor gate: with only two models
 * the standardisation maps any reply to ±1, so a reply belonging to neither
 * still reports near-certainty. Gates should use `margin`.
 */
export function attribute(text, bank, { expectedCount, beta = 3 } = {}) {
  const raw = rawScoresFor(text, bank, expectedCount);
  if (!raw) return null;
  const probabilities = softmax(standardize(raw).map((s) => beta * s));
  let best = 0;
  for (let i = 1; i < probabilities.length; i++) if (probabilities[i] > probabilities[best]) best = i;
  return {
    model: bank.modelIds[best],
    confidence: probabilities[best],
    rawScores: raw,
    margin: marginOf(raw),
    probabilities,
  };
}

/**
 * Cosine similarity of a reply to every centroid, unstandardised.
 *
 * The two feature layers are fused here exactly as in the bank (0.75 marginal /
 * 0.25 ordered), and the result is left as a plain cosine so it can be compared
 * across banks of different sizes.
 */
export function rawScoresFor(text, bank, expectedCount) {
  const numbers = parseNumbers(text);
  if (!isUsable(numbers, expectedCount)) return null;

  const { featureMean, featureScale, basis, centroids } = bank.marginal;
  const mf = projectOut(standardizeAgainst(hellingerFeature(countNumbers(numbers)), featureMean, featureScale), basis);
  const marginal = unitAgainst(mf, centroids, bank.modelIds);

  const o = bank.ordered;
  const of = standardizeAgainst(orderedBlockFeature(numbers), o.orderedMean, o.orderedScale);
  const ordered = unitAgainst(of, o.centroids, bank.modelIds);

  return marginal.map((m, i) => (1 - ORDERED_WEIGHT) * m + ORDERED_WEIGHT * ordered[i]);
}

/** Best raw score minus second-best; 0 when there is nothing to choose between. */
export function marginOf(scores) {
  if (scores.length < 2) return 0;
  const sorted = [...scores].sort((a, b) => b - a);
  return sorted[0] - sorted[1];
}

/**
 * The standardised fused scores, which is what the softmax wants as input.
 * Kept as a separate function because `rawScoresFor` is the honest measure and
 * this is the presentational one.
 */
export function scoresFor(text, bank, expectedCount) {
  const raw = rawScoresFor(text, bank, expectedCount);
  return raw ? standardize(raw) : null;
}

function unitAgainst(feature, centroids, modelIds) {
  const norm = Math.max(Math.hypot(...feature), 1e-12);
  return modelIds.map((id) => {
    const c = centroids[id];
    let s = 0;
    for (let i = 0; i < feature.length; i++) s += (feature[i] / norm) * c[i];
    return s;
  });
}

/**
 * Fit `beta` by leave-one-condition-out with a log-loss grid search.
 *
 * We deliberately fit on held-out conditions: fitting beta on the same replies
 * the centroids were built from would reward an arbitrarily sharp beta, since
 * those replies sit at distance ~0 from their own centroid. Returns the beta
 * that minimises held-out log loss, plus the accuracy at that beta.
 */
export function calibrateBeta(records, { grid = null, expectedCount } = {}) {
  const usable = records.filter((r) => isUsable(parseNumbers(r.text), r.requestedCount ?? expectedCount));
  const conditions = [...new Set(usable.map((r) => r.condition ?? ""))];
  if (conditions.length < 2) return { beta: 3, accuracy: null, heldOut: 0, reason: "need >= 2 conditions" };

  const candidates = grid ?? Array.from({ length: 240 }, (_, i) => 0.05 + (i * 12) / 239);

  // Precompute every held-out score vector once; the grid search then only
  // rescales, which keeps the sweep cheap.
  const held = [];
  for (const c of conditions) {
    const bank = fitBank(usable.filter((r) => r.condition !== c));
    for (const r of usable.filter((r) => r.condition === c)) {
      const s = scoresFor(r.text, bank, r.requestedCount ?? expectedCount);
      if (!s) continue;
      const truth = bank.modelIds.indexOf(r.model);
      if (truth < 0) continue;
      held.push({ scores: s, truth });
    }
  }
  if (!held.length) return { beta: 3, accuracy: null, heldOut: 0, reason: "no held-out reply was scoreable" };

  let bestBeta = candidates[0];
  let bestLoss = Infinity;
  for (const beta of candidates) {
    let loss = 0;
    for (const { scores, truth } of held) {
      const p = softmax(scores.map((s) => beta * s))[truth];
      loss -= Math.log(Math.max(p, 1e-12));
    }
    loss /= held.length;
    if (loss < bestLoss) {
      bestLoss = loss;
      bestBeta = beta;
    }
  }

  let correct = 0;
  for (const { scores, truth } of held) {
    const p = softmax(scores.map((s) => bestBeta * s));
    let best = 0;
    for (let i = 1; i < p.length; i++) if (p[i] > p[best]) best = i;
    if (best === truth) correct++;
  }
  return { beta: bestBeta, logLoss: bestLoss, accuracy: correct / held.length, heldOut: held.length };
}
