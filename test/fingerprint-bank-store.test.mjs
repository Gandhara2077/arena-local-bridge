/**
 * The probe prompts and the bank store.
 *
 * The prompts are tested on the property that actually matters: the shared rule
 * block is identical across variants while the clause is not. If the rules
 * drifted per variant, the bank would be able to tell variants apart by
 * something other than the condition it is meant to learn, and that shows up
 * later as unexplainable confidence.
 *
 * The store is tested on the two ways it can silently lie: losing a record, and
 * claiming a bank it cannot support.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PROBE_COUNT,
  probePrompt,
  probeTurn,
  variantIds,
  variantOfPrompt,
  probeNonce,
} from "../src/fingerprint/probe-prompts.mjs";
import {
  readStore,
  appendRecord,
  storeSummary,
  buildBank,
  probeStorePath,
} from "../src/fingerprint/bank-store.mjs";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "arena-fp-"));

// ── prompts ──────────────────────────────────────────────────────────────

test("every variant asks for the same count and range", () => {
  for (const id of variantIds()) {
    const p = probePrompt(id);
    assert.ok(p.includes(String(PROBE_COUNT)), `${id} does not state the count`);
    assert.match(p, /between 1 and 355/);
  }
});

test("the rules block is byte-identical across variants", () => {
  const tails = variantIds().map((id) => probePrompt(id).split("\n\n").slice(1).join("\n\n"));
  assert.equal(new Set(tails).size, 1);
});

test("variant clauses are all distinct", () => {
  const clauses = variantIds().map((id) => probePrompt(id).split("\n\n")[0]);
  assert.equal(new Set(clauses).size, variantIds().length);
});

test("a prompt round-trips back to the variant that produced it", () => {
  for (const id of variantIds()) assert.equal(variantOfPrompt(probePrompt(id)), id);
  assert.equal(variantOfPrompt("some other prompt"), null);
  assert.equal(variantOfPrompt(""), null);
});

test("an unknown variant throws instead of probing with the wrong wording", () => {
  assert.throws(() => probePrompt("nope"), /unknown probe variant/);
  assert.throws(() => probePrompt(999), /unknown probe variant/);
});

test("variants can be addressed by index as well as id", () => {
  assert.equal(probePrompt(0), probePrompt(variantIds()[0]));
});

test("the nonce differs between turns so a repeat is a new turn", () => {
  assert.notEqual(probeNonce(() => 0.1), probeNonce(() => 0.9));
  assert.notEqual(probeTurn("v1-instant", () => 0.1), probeTurn("v1-instant", () => 0.9));
  // ...and is stable for a fixed source, so a test can pin it.
  assert.equal(probeNonce(() => 0.5), probeNonce(() => 0.5));
});

// ── store ────────────────────────────────────────────────────────────────

test("a missing store reads as empty rather than throwing", () => {
  const dir = tmpDir();
  assert.deepEqual(readStore(dir).records, []);
});

test("an unreadable store is ignored, not guessed at", () => {
  const dir = tmpDir();
  fs.writeFileSync(probeStorePath(dir), "{ not json", "utf8");
  assert.deepEqual(readStore(dir).records, []);
  // A store from a different version is also discarded: the shape may have moved.
  fs.writeFileSync(probeStorePath(dir), JSON.stringify({ version: 99, records: [{ text: "1" }] }), "utf8");
  assert.deepEqual(readStore(dir).records, []);
});

test("appending a record keeps every earlier one", () => {
  const dir = tmpDir();
  const numbers = Array.from({ length: 200 }, (_, i) => (i % 300) + 1).join(" ");
  appendRecord(dir, { text: numbers, model: "m1", variant: "v1-instant", requestedCount: 200 });
  appendRecord(dir, { text: numbers, model: "m2", variant: "v2-gut", requestedCount: 200 });
  const store = readStore(dir);
  assert.equal(store.records.length, 2);
  assert.equal(store.records[0].variant, "v1-instant");
  assert.equal(store.records[1].variant, "v2-gut");
});

test("a record notes how many numbers actually landed, and whether that was enough", () => {
  const dir = tmpDir();
  const long = Array.from({ length: 200 }, (_, i) => (i % 300) + 1).join(" ");
  const short = "1 2 3 4 5";
  const a = appendRecord(dir, { text: long, model: "m", variant: "v1-instant", requestedCount: 200 });
  const b = appendRecord(dir, { text: short, model: "m", variant: "v1-instant", requestedCount: 200 });
  assert.equal(a.landed, 200);
  assert.equal(a.usable, true);
  assert.equal(b.usable, false);
});

test("the condition defaults to the probe variant", () => {
  const dir = tmpDir();
  const r = appendRecord(dir, { text: "1 2 3", variant: "v3-freeflow", requestedCount: 200 });
  assert.equal(r.condition, "v3-freeflow");
});

test("the summary separates usable, labelled and unlabelled", () => {
  const dir = tmpDir();
  const long = Array.from({ length: 200 }, (_, i) => (i % 300) + 1).join(" ");
  appendRecord(dir, { text: long, model: "m1", variant: "v1-instant", requestedCount: 200 });
  appendRecord(dir, { text: long, model: "", variant: "v1-instant", requestedCount: 200 });
  appendRecord(dir, { text: "1 2 3", model: "m1", variant: "v2-gut", requestedCount: 200 });
  const s = storeSummary(dir);
  assert.equal(s.total, 3);
  assert.equal(s.usable, 2);
  assert.equal(s.labelled, 1);
  assert.equal(s.unlabelled, 1);
  assert.equal(s.models, 1);
});

test("building a bank refuses, with a reason, when there is nothing to build from", () => {
  const dir = tmpDir();
  const empty = buildBank(dir);
  assert.equal(empty.bank, null);
  assert.match(empty.reason, /no labelled usable/);

  const long = Array.from({ length: 200 }, (_, i) => (i % 300) + 1).join(" ");
  appendRecord(dir, { text: long, model: "only", variant: "v1", requestedCount: 200 });
  const oneModel = buildBank(dir);
  assert.equal(oneModel.bank, null);
  assert.match(oneModel.reason, /at least two/);
});

test("building a bank refuses when only one condition was ever probed", () => {
  const dir = tmpDir();
  const long = Array.from({ length: 200 }, (_, i) => (i % 300) + 1).join(" ");
  appendRecord(dir, { text: long, model: "m1", variant: "v1", requestedCount: 200 });
  appendRecord(dir, { text: long, model: "m2", variant: "v1", requestedCount: 200 });
  const r = buildBank(dir);
  assert.equal(r.bank, null);
  assert.match(r.reason, /one condition/);
});

test("a bank is built once there are two models over two conditions", () => {
  const dir = tmpDir();
  // Two models with separable value mixes, two variants each.
  for (const [model, base] of [["m1", 80], ["m2", 260]]) {
    for (const variant of ["v1", "v2"]) {
      for (let rep = 0; rep < 3; rep++) {
        const text = Array.from({ length: 200 }, (_, i) => ((base + i * 7 + rep * 13) % 300) + 1).join(" ");
        appendRecord(dir, { text, model, variant, requestedCount: 200 });
      }
    }
  }
  const { bank, reason } = buildBank(dir);
  assert.equal(reason, null);
  assert.deepEqual(bank.modelIds, ["m1", "m2"]);
  assert.equal(bank.conditions.length, 2);
  assert.equal(bank.droppedCount, 0);
});

test("the store never claims more than it has", () => {
  const dir = tmpDir();
  const long = Array.from({ length: 200 }, (_, i) => (i % 300) + 1).join(" ");
  // Unusable and unlabelled records must not silently count toward a bank.
  appendRecord(dir, { text: "1 2 3", model: "m1", variant: "v1", requestedCount: 200 });
  appendRecord(dir, { text: long, model: "", variant: "v1", requestedCount: 200 });
  const { bank } = buildBank(dir);
  assert.equal(bank, null);
});
