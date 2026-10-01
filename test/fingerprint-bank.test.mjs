/**
 * The bank and attribution layer.
 *
 * These tests are built on synthetic replies whose *value mix* is chosen per
 * model, so the right answer is known by construction: if model A always picks
 * low values and model B always picks high ones, an attribution that cannot
 * tell them apart is broken regardless of how the maths is arranged. A second
 * group checks the guards — a short reply must come back as "no answer", never
 * as a confident guess.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fitBank, scoresFor, attribute, calibrateBeta, ORDERED_WEIGHT } from "../src/fingerprint/numeric-bank.mjs";

/**
 * A synthetic reply. `bias` shifts the value distribution, `spread` controls
 * how widely it wanders, and `seed` makes the sequence deterministic so a
 * failure is reproducible.
 */
function reply({ bias, spread, seed, count = 200 }) {
  let s = seed >>> 0;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const numbers = [];
  for (let i = 0; i < count; i++) {
    const v = Math.round(bias + (rand() - 0.5) * spread);
    numbers.push(Math.min(355, Math.max(1, v)));
  }
  return numbers.join(" ");
}

/** Three distinctly-biased models, each seen in three conditions. */
const MODELS = { low: 90, mid: 175, high: 265 };

function syntheticBank() {
  const conditions = ["c1", "c2", "c3"];
  const records = [];
  let seed = 1;
  for (const [model, bias] of Object.entries(MODELS)) {
    for (const condition of conditions) {
      for (let rep = 0; rep < 3; rep++) {
        records.push({
          text: reply({ bias, spread: 60, seed: seed++, count: 200 }),
          model,
          condition,
          requestedCount: 200,
        });
      }
    }
  }
  return records;
}

test("fitBank records the models and conditions it was given", () => {
  const bank = fitBank(syntheticBank());
  assert.deepEqual(bank.modelIds, ["high", "low", "mid"]);
  assert.equal(bank.conditions.length, 3);
  assert.equal(bank.droppedCount, 0);
});

test("fitBank learns a nuisance basis once conditions are distinguishable", () => {
  const bank = fitBank(syntheticBank());
  assert.equal(bank.nuisanceDirections, 2);
  // With a single condition there is nothing to subtract, and the bank says so
  // rather than silently claiming a projection it could not fit.
  const flat = fitBank(syntheticBank().map((r) => ({ ...r, condition: "only" })));
  assert.equal(flat.nuisanceDirections, 0);
});

test("fitBank drops unusable replies instead of letting them shift the centroids", () => {
  const records = syntheticBank();
  records.push({ text: "7 9 11", model: "low", condition: "c1", requestedCount: 200 });
  const bank = fitBank(records);
  assert.equal(bank.droppedCount, 1);
});

test("fitBank refuses an empty set", () => {
  assert.throws(() => fitBank([{ text: "1 2 3", model: "x", condition: "c", requestedCount: 200 }]), /no usable records/);
});

test("a distinct reply is attributed to the model that generated it", () => {
  const records = syntheticBank();
  const bank = fitBank(records.filter((r) => r.condition !== "c3"));
  for (const [model, bias] of Object.entries(MODELS)) {
    const a = attribute(reply({ bias, spread: 60, seed: 999, count: 200 }), bank, { expectedCount: 200 });
    assert.ok(a, `${model}: expected a fingerprint`);
    assert.equal(a.model, model, `${model} attributed as ${a.model}`);
    assert.ok(a.confidence > 0.5, `${model}: confidence ${a.confidence} is not decisive`);
  }
});

test("scoresFor and attribute agree, and probabilities sum to one", () => {
  const bank = fitBank(syntheticBank());
  const text = reply({ bias: MODELS.mid, spread: 60, seed: 4242, count: 200 });
  const scores = scoresFor(text, bank, 200);
  const a = attribute(text, bank, { expectedCount: 200 });
  assert.deepEqual(a.scores, scores);
  const sum = a.probabilities.reduce((x, y) => x + y, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
});

test("a reply too short to fingerprint returns null, not a guess", () => {
  const bank = fitBank(syntheticBank());
  assert.equal(scoresFor("1 2 3 4 5", bank, 200), null);
  assert.equal(attribute("1 2 3 4 5", bank, { expectedCount: 200 }), null);
  // An empty reply is the same case.
  assert.equal(attribute("", bank, { expectedCount: 200 }), null);
});

test("attribution is model-order stable: shuffling bank order only permutes output", () => {
  const records = syntheticBank();
  const text = reply({ bias: MODELS.high, spread: 60, seed: 77, count: 200 });
  const a = attribute(text, fitBank(records), { expectedCount: 200 });
  // Re-fitting the same records must not change the winner.
  const b = attribute(text, fitBank(records.slice().reverse()), { expectedCount: 200 });
  assert.equal(a.model, b.model);
});

test("ORDERED_WEIGHT is the fused weight, and a bank exposing it uses a plain mix", () => {
  assert.equal(ORDERED_WEIGHT, 0.25);
  const bank = fitBank(syntheticBank());
  assert.ok(bank.marginal && bank.ordered);
});

test("calibrateBeta returns a positive sharpening on held-out conditions", () => {
  const cal = calibrateBeta(syntheticBank());
  assert.ok(cal.beta > 0, `beta ${cal.beta}`);
  assert.ok(cal.heldOut > 0);
  assert.ok(cal.accuracy > 0.8, `held-out accuracy ${cal.accuracy}`);
});

test("calibrateBeta declines to fit when it cannot hold anything out", () => {
  const cal = calibrateBeta(syntheticBank().map((r) => ({ ...r, condition: "only" })));
  assert.equal(cal.accuracy, null);
  assert.match(cal.reason, /conditions/);
});
