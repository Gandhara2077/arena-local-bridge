/**
 * The identification flow.
 *
 * The tests are built around the one property that matters and is easiest to
 * get wrong: the three outcomes must stay distinguishable. "We fingerprinted it
 * and it was X", "we fingerprinted it and it was not clear", and "we could not
 * fingerprint it" lead to different actions, and a flow that collapses any two
 * of them will eventually write a wrong model name into the archive.
 *
 * The probe turn itself is injected, so none of this needs a browser.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { identify, collect, bankStatus, CONFIDENCE_THRESHOLD, fitSharpness } from "../src/fingerprint/index.mjs";
import { appendRecord, readStore } from "../src/fingerprint/bank-store.mjs";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "arena-fpid-"));

/**
 * A reply whose values cluster around `base` with a deterministic jitter.
 *
 * The jitter must stay well inside the range: a fixture that sweeps the whole
 * of [1,355] gives every model the same flat histogram, and then the test is
 * asserting separability that the data does not have.
 */
function reply(base, salt = 0, count = 240) {
  return Array.from({ length: count }, (_, i) => {
    const jitter = ((i * 37 + salt * 53) % 60) - 30;
    return Math.min(355, Math.max(1, base + jitter));
  }).join(" ");
}

/** Populate a store with two separable models across two variants. */
function seedBank(dir) {
  for (const [model, base] of [["m1", 70], ["m2", 270]]) {
    for (const variant of ["v1-instant", "v2-gut"]) {
      for (let rep = 0; rep < 3; rep++) {
        appendRecord(dir, { text: reply(base, rep), model, variant, requestedCount: 240 });
      }
    }
  }
}

test("with no bank, identify fails without spending a turn", async () => {
  const dir = tmpDir();
  let asked = 0;
  const r = await identify({ dataDir: dir, variant: "v1-instant", ask: async () => (asked++, reply(70)) });
  assert.equal(r.status, "failed");
  assert.equal(asked, 0, "must not probe when there is nothing to attribute against");
  assert.match(r.reason, /no labelled usable/);
});

test("a reply matching a known model is attributed", async () => {
  const dir = tmpDir();
  seedBank(dir);
  const r = await identify({ dataDir: dir, variant: "v1-instant", ask: async () => reply(70, 99) });
  assert.equal(r.status, "attributed");
  assert.equal(r.model, "m1");
  assert.ok(r.confidence >= CONFIDENCE_THRESHOLD);
});

test("a reply that matches nothing is unresolved, not failed", async () => {
  const dir = tmpDir();
  seedBank(dir);
  // A flat reply across the whole range belongs to neither cluster, so it must
  // not resolve to a model however the probabilities are shaped.
  const r = await identify({
    dataDir: dir,
    variant: "v1-instant",
    ask: async () => Array.from({ length: 240 }, (_, i) => ((i % 355) + 1)).join(" "),
  });
  assert.equal(r.status, "unresolved");
  assert.equal(r.model, null, "an unresolved attribution must not name a model");
  assert.ok(r.nearMiss, "but it should say what it nearly concluded");
  assert.match(r.reason, /below the/);
});

test("the gate reads the margin, because confidence saturates on a small bank", async () => {
  const dir = tmpDir();
  seedBank(dir);

  // This is the measured reason MIN_MARGIN exists. On a two-model bank the
  // softmax reports the same near-certain confidence for a true match and for a
  // reply belonging to neither, because standardisation maps any score pair to
  // +-1. Only the raw margin separates them.
  const good = await identify({ dataDir: dir, variant: "v1-instant", ask: async () => reply(70, 99) });
  const bad = await identify({
    dataDir: dir,
    variant: "v1-instant",
    ask: async () => Array.from({ length: 240 }, (_, i) => ((i % 355) + 1)).join(" "),
  });

  assert.equal(good.status, "attributed");
  assert.equal(bad.status, "unresolved");
  assert.ok(
    Math.abs(good.confidence - bad.confidence) < 0.05,
    `confidence should be uninformative here (${good.confidence} vs ${bad.confidence})`
  );
  assert.ok(good.margin > bad.margin, `margin should differ: ${good.margin} vs ${bad.margin}`);
});

test("a raised margin gate turns an attribution into an unresolved", async () => {
  const dir = tmpDir();
  seedBank(dir);
  const strict = await identify({ dataDir: dir, variant: "v1-instant", ask: async () => reply(70, 99), minMargin: 99 });
  assert.equal(strict.status, "unresolved");
  assert.equal(strict.model, null);
});

for (const modelCount of [7, 8, 9]) {
  test(`a ${modelCount}-model bank accepts exact matches but rejects unknown and ambiguous replies`, async () => {
    const dir = tmpDir();
    const samples = Array.from({ length: modelCount }, (_, i) => ({
      model: `m${i + 1}`,
      text: Array(240).fill((i + 1) * 35).join(" "),
    }));
    for (const sample of samples) {
      for (const variant of ["v1-instant", "v2-gut"]) {
        appendRecord(dir, { ...sample, variant, requestedCount: 240 });
      }
    }
    const probe = (text, options = {}) => identify({
      dataDir: dir, variant: "v1-instant", ask: async () => text, store: false, ...options,
    });
    for (const sample of samples) {
      const result = await probe(sample.text);
      assert.equal(result.status, "attributed", `${sample.model}: ${result.reason}`);
      assert.equal(result.model, sample.model);
    }
    for (const text of [
      Array(240).fill(355).join(" "),
      Array.from({ length: 240 }, (_, i) => (i % 2 ? 35 : 70)).join(" "),
    ]) {
      const result = await probe(text);
      assert.equal(result.status, "unresolved");
      assert.equal(result.model, null);
    }
    const strict = await probe(samples[0].text, { minMargin: 1.9 });
    assert.equal(strict.status, "unresolved", "explicit raw-margin overrides must be honoured");
  });
}

test("a reply too short to fingerprint fails, and never becomes a guess", async () => {
  const dir = tmpDir();
  seedBank(dir);
  const r = await identify({ dataDir: dir, variant: "v1-instant", ask: async () => "3 14 159" });
  assert.equal(r.status, "failed");
  assert.equal(r.model, null);
  assert.equal(r.confidence, null);
  assert.match(r.reason, /too short/);
});

test("an empty probe turn fails rather than storing an empty record", async () => {
  const dir = tmpDir();
  seedBank(dir);
  const before = readStore(dir).records.length;
  const r = await identify({ dataDir: dir, variant: "v1-instant", ask: async () => "   " });
  assert.equal(r.status, "failed");
  assert.equal(readStore(dir).records.length, before);
});

test("identify stores the probe reply so the next bank includes it", async () => {
  const dir = tmpDir();
  seedBank(dir);
  const before = readStore(dir).records.length;
  await identify({ dataDir: dir, variant: "v3-freeflow", ask: async () => reply(70, 5) });
  assert.equal(readStore(dir).records.length, before + 1);
});

test("identify can be told not to store, for a dry run", async () => {
  const dir = tmpDir();
  seedBank(dir);
  const before = readStore(dir).records.length;
  await identify({ dataDir: dir, variant: "v3-freeflow", ask: async () => reply(70, 5), store: false });
  assert.equal(readStore(dir).records.length, before);
});

test("a raised threshold turns an attribution into an unresolved", async () => {
  const dir = tmpDir();
  seedBank(dir);
  const text = reply(70, 99);
  const strict = await identify({ dataDir: dir, variant: "v1-instant", ask: async () => text, threshold: 1.01 });
  assert.equal(strict.status, "unresolved");
  assert.equal(strict.model, null);
});

test("collect stores an unlabelled reply, because the probe already cost a turn", async () => {
  const dir = tmpDir();
  const r = await collect({ dataDir: dir, variant: "v2-gut", ask: async () => reply(120) });
  assert.equal(r.stored, true);
  const store = readStore(dir);
  assert.equal(store.records.length, 1);
  assert.equal(store.records[0].model, "");
  assert.equal(store.records[0].condition, "v2-gut");
});

test("collect reports a failed probe instead of storing nothing silently", async () => {
  const dir = tmpDir();
  const r = await collect({ dataDir: dir, variant: "v1-instant", ask: async () => "" });
  assert.equal(r.stored, false);
  assert.match(r.reason, /no text/);
  assert.equal(readStore(dir).records.length, 0);
});

test("bankStatus is not ready until both models and conditions exist", () => {
  const dir = tmpDir();
  assert.equal(bankStatus(dir).ready, false);
  appendRecord(dir, { text: reply(70), model: "m1", variant: "v1-instant", requestedCount: 240 });
  const partial = bankStatus(dir);
  assert.equal(partial.ready, false);
  assert.match(partial.reason, /at least two/);
  seedBank(dir);
  const ready = bankStatus(dir);
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.modelIds, ["m1", "m2"]);
});

test("bankStatus reports no nuisance directions when only one condition exists", () => {
  const dir = tmpDir();
  for (const [model, base] of [["m1", 70], ["m2", 270]]) {
    appendRecord(dir, { text: reply(base), model, variant: "v1-instant", requestedCount: 240 });
  }
  const s = bankStatus(dir);
  assert.equal(s.ready, false);
  assert.equal(s.nuisanceDirections, 0);
});

test("fitSharpness returns a usable beta once the bank supports it", () => {
  const dir = tmpDir();
  seedBank(dir);
  const r = fitSharpness(dir);
  assert.ok(r.beta > 0, `beta ${r.beta}`);
  assert.ok(r.accuracy === null || r.accuracy >= 0);
});

test("fitSharpness declines when there is no bank", () => {
  const dir = tmpDir();
  const r = fitSharpness(dir);
  assert.equal(r.beta, null);
  assert.match(r.reason, /no bank/);
});
