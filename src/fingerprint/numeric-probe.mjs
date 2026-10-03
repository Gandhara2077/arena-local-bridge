/**
 * fingerprint/numeric-probe.mjs — the numeric first-instinct probe
 *
 * The probe asks a model for a long run of "first instinct" integers in
 * [1, 355]. A model cannot help but bias those choices: it under-samples some
 * values, over-samples others, and its runs drift in a way that is stable per
 * model. That bias, not the numbers themselves, is the fingerprint.
 *
 * Everything here is about turning one reply into one feature vector, plus the
 * parsing rules that decide whether a reply is usable at all. No bank, no
 * attribution, no I/O.
 */

export const VALUE_MIN = 1;
export const VALUE_MAX = 355;
export const DIMENSION = VALUE_MAX - VALUE_MIN + 1;

/** ModelTrace's additive smoothing, kept identical so banks stay comparable. */
export const ALPHA = 0.5;

/**
 * Pull the longest digit run out of a reply.
 *
 * Models rarely return a bare list: they wrap it in sentences, and sometimes
 * interpolate counts or bullet numbers. Runs are split wherever a letter appears
 * between two numbers, so "1. 42 2. 17" does not read as 1, 42, 2, 17. The
 * longest surviving run is the answer.
 */
export function parseNumbers(text) {
  if (typeof text !== "string" || !text) return [];
  const runs = [];
  let current = [];
  let previousEnd = 0;
  const re = /\d+/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const separator = text.slice(previousEnd, m.index);
    const value = Number(m[0]);
    if (current.length && /[a-z]/i.test(separator)) {
      runs.push(current);
      current = [];
    }
    if (value >= VALUE_MIN && value <= VALUE_MAX) current.push(value);
    previousEnd = re.lastIndex;
  }
  if (current.length) runs.push(current);
  if (!runs.length) return [];
  return runs.reduce((best, r) => (r.length > best.length ? r : best));
}

/** Histogram over the closed interval [VALUE_MIN, VALUE_MAX]. */
export function countNumbers(numbers) {
  const counts = new Array(DIMENSION).fill(0);
  for (const n of numbers) {
    if (n >= VALUE_MIN && n <= VALUE_MAX) counts[n - VALUE_MIN]++;
  }
  return counts;
}

/** A reply counts only if it produced at least this share of the ask. */
export function minimumNumbers(expectedCount) {
  return expectedCount ? Math.max(80, Math.ceil(expectedCount * 0.55)) : 80;
}

/** Whether a parsed reply is long enough to fingerprint. */
export function isUsable(numbers, expectedCount) {
  return numbers.length >= minimumNumbers(expectedCount);
}

/**
 * Hellinger feature of the value histogram: sqrt of the smoothed probability
 * vector. The square root turns total-variation distance into an L2 distance,
 * which is what makes a plain dot product against centroids meaningful.
 */
export function hellingerFeature(counts) {
  const total = counts.reduce((a, b) => a + b, 0) + ALPHA * counts.length;
  return counts.map((c) => Math.sqrt((c + ALPHA) / total));
}

/**
 * Ordered-block feature: the run split into four consecutive quarters, each
 * histogrammed over 16 bins, plus the distribution of last digits. It captures
 * *how the sequence moved*, which the marginal histogram throws away — some
 * models front-load small numbers, some wander, and their last-digit habits
 * differ.
 *
 * Block layout matches the reference implementation: 4 quarters x 16 bins = 64,
 * plus 10 last-digit buckets = 74 dimensions.
 */
export function orderedBlockFeature(numbers) {
  const BINS = 16;
  const QUARTERS = 4;
  const out = [];
  const n = numbers.length;

  for (let q = 0; q < QUARTERS; q++) {
    const start = Math.floor((q * n) / QUARTERS);
    const end = Math.floor(((q + 1) * n) / QUARTERS);
    const chunk = numbers.slice(start, end);
    const bins = new Array(BINS).fill(0);
    for (const v of chunk) {
      // Values are clamped into [1, 355]; map to [0, BINS-1].
      let b = Math.floor(((v - VALUE_MIN) / DIMENSION) * BINS);
      if (b < 0) b = 0;
      if (b >= BINS) b = BINS - 1;
      bins[b]++;
    }
    out.push(...hellingerOf(bins));
  }

  const lastDigits = new Array(10).fill(0);
  for (const v of numbers) lastDigits[v % 10]++;
  out.push(...hellingerOf(lastDigits));

  return out;
}

/** sqrt of the smoothed share vector for an arbitrary histogram. */
function hellingerOf(bins) {
  const total = bins.reduce((a, b) => a + b, 0) + ALPHA * bins.length;
  return bins.map((c) => Math.sqrt((c + ALPHA) / total));
}

/**
 * Standardize a feature vector against a stored mean/scale, matching how the
 * bank was built. A missing artifact leaves the vector untouched, which is the
 * "bank predates this feature" case.
 */
export function standardizeAgainst(feature, mean, scale) {
  return feature.map((v, i) => (v - mean[i]) / (scale[i] || 1));
}
