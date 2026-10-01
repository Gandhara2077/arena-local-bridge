/**
 * fingerprint/bank-store.mjs — keep collected probe replies, and build a bank
 *
 * A bank is only as good as the labels behind it, and labels are the hard part:
 * the whole reason we are here is that Arena will not tell us which model
 * answered. So this file keeps what we *can* observe — the probe reply and the
 * variant that asked for it — in a plain append-only store, and treats the
 * model name as something attached separately, by whoever knows it.
 *
 * A reply whose model is unknown is still worth keeping. It costs a probe to
 * obtain, and a later attribution can be run against it once a bank exists, or
 * the same session can be re-probed after the label is established.
 *
 * Storage format is a single JSON file with `{ version, records }`, written
 * atomically. Append-only in spirit: records are never rewritten in place, so
 * a corrupted line costs one record rather than the whole bank.
 */
import fs from "node:fs";
import path from "node:path";
import { fitBank } from "./numeric-bank.mjs";
import { parseNumbers, isUsable } from "./numeric-probe.mjs";

/** Bumped when the record shape changes; a mismatched file is ignored, not guessed at. */
const STORE_VERSION = 1;

export function probeStorePath(dataDir) {
  return path.join(dataDir, "fingerprint-bank.json");
}

/**
 * Read the store. A missing or unreadable file reads as empty rather than
 * throwing: the bank is derived data that can always be recollected, so it must
 * never be the reason startup fails.
 */
export function readStore(dataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(probeStorePath(dataDir), "utf8"));
    if (parsed?.version === STORE_VERSION && Array.isArray(parsed.records)) return parsed;
  } catch {
    /* absent or corrupt: start clean */
  }
  return { version: STORE_VERSION, records: [] };
}

/**
 * Append one collected reply.
 *
 * `model` may be empty. `variant` is the probe variant id; `condition` defaults
 * to it, because the variant IS the circumstance we varied on purpose. Callers
 * that vary something else (account, time of day) can pass their own.
 */
export function appendRecord(dataDir, { text, model = "", variant, condition = variant, requestedCount, at = new Date().toISOString() }) {
  const store = readStore(dataDir);
  const numbers = parseNumbers(text);
  const record = {
    text,
    model,
    variant: variant ?? null,
    condition: condition ?? null,
    requestedCount: requestedCount ?? null,
    landed: numbers.length,
    usable: isUsable(numbers, requestedCount),
    at,
  };
  store.records.push(record);
  writeStore(dataDir, store);
  return record;
}

function writeStore(dataDir, store) {
  const file = probeStorePath(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store), "utf8");
  fs.renameSync(tmp, file);
}

/**
 * A summary of what has been collected, without building a bank. Callers use
 * this to answer "do we have enough to attribute yet" — and to say precisely
 * what is missing when the answer is no.
 */
export function storeSummary(dataDir) {
  const { records } = readStore(dataDir);
  const byModel = {};
  const byVariant = {};
  for (const r of records) {
    const model = r.model || "(unlabelled)";
    byModel[model] = (byModel[model] ?? 0) + 1;
    byVariant[r.variant ?? "(none)"] = (byVariant[r.variant ?? "(none)"] ?? 0) + 1;
  }
  const usable = records.filter((r) => r.usable);
  const labelled = usable.filter((r) => r.model);
  return {
    total: records.length,
    usable: usable.length,
    labelled: labelled.length,
    unlabelled: usable.length - labelled.length,
    models: Object.keys(byModel).filter((m) => m !== "(unlabelled)").length,
    byModel,
    byVariant,
  };
}

/**
 * Build a bank from the stored records.
 *
 * Only labelled, usable records take part — an unlabelled reply cannot say
 * which centroid it belongs to. Returns `{ bank: null, reason }` rather than
 * throwing when there is not enough data, because "not enough probes yet" is
 * the normal state during collection, not an error.
 */
export function buildBank(dataDir, { expectedCount } = {}) {
  const { records } = readStore(dataDir);
  const usable = records.filter((r) => r.usable && r.model);
  if (!usable.length) {
    return { bank: null, reason: "no labelled usable replies collected yet", stats: storeSummary(dataDir) };
  }
  const models = new Set(usable.map((r) => r.model));
  if (models.size < 2) {
    return {
      bank: null,
      reason: `only one model represented (${[...models][0]}); attribution needs at least two`,
      stats: storeSummary(dataDir),
    };
  }
  const conditions = new Set(usable.map((r) => r.condition));
  if (conditions.size < 2) {
    return {
      bank: null,
      reason: "only one condition represented; the environment offset cannot be estimated",
      stats: storeSummary(dataDir),
    };
  }
  try {
    const bank = fitBank(
      usable.map((r) => ({
        text: r.text,
        model: r.model,
        condition: r.condition,
        requestedCount: r.requestedCount ?? expectedCount,
      }))
    );
    return { bank, reason: null, stats: storeSummary(dataDir) };
  } catch (error) {
    return { bank: null, reason: error instanceof Error ? error.message : String(error), stats: storeSummary(dataDir) };
  }
}
