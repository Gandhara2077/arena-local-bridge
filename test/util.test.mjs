import { test } from "node:test";
import assert from "node:assert/strict";
import { compactSchema, compactText, log, looseJson, maskEmail, record, retry } from "../src/util.mjs";

test("record accepts only non-array objects and preserves object identity", () => {
  const value = { answer: 42 };
  assert.equal(record(value), value);
  for (const input of [null, undefined, "text", 3, [], true]) assert.deepEqual(record(input), {});
});

test("maskEmail hides the local part and handles non-address input", () => {
  assert.equal(maskEmail("person@example.com"), "p***@example.com");
  assert.equal(maskEmail("abcd"), "ab***");
  assert.equal(maskEmail(""), "-");
});

test("compactText preserves short input and keeps both ends of long input", () => {
  assert.equal(compactText("short", 5), "short");
  assert.equal(compactText("abcdefghijklmnopqrst", 10), "abcdefg\n...[compacted 10 chars]...\nrst");
});

test("compactSchema keeps its allowlist and caps recursive lists and depth", () => {
  let nested = { type: "string" };
  for (let depth = 0; depth < 5; depth++) nested = { items: nested };
  const result = compactSchema({
    type: "object",
    description: "discarded",
    enum: Array.from({ length: 45 }, (_, index) => index),
    required: ["choice"],
    additionalProperties: false,
    properties: { choice: { type: "string", description: "discarded" } },
    items: nested,
    anyOf: Array.from({ length: 10 }, () => ({ type: "string" })),
  });
  assert.equal(result.type, "object");
  assert.equal("description" in result, false);
  assert.equal(result.enum.length, 40);
  assert.deepEqual(result.required, ["choice"]);
  assert.equal(result.additionalProperties, false);
  assert.deepEqual(result.properties.choice, { type: "string" });
  assert.equal(result.anyOf.length, 8);
  assert.deepEqual(result.items, { items: { items: { items: { items: {} } } } });
});

test("looseJson parses fenced loose JSON and returns null for invalid input", () => {
  assert.deepEqual(looseJson("```json\n{model: 'gpt', enabled: True, missing: None,}\n```"), {
    model: "gpt", enabled: true, missing: null,
  });
  assert.deepEqual(looseJson("[1, 2,]"), [1, 2]);
  assert.equal(looseJson("not json"), null);
});

test("log writes structured entries and expands Error fields", (t) => {
  const entries = [];
  t.mock.method(console, "log", (line) => entries.push(["log", line]));
  t.mock.method(console, "warn", (line) => entries.push(["warn", line]));
  t.mock.method(console, "error", (line) => entries.push(["error", line]));
  log.info("test", "ready", { count: 1 });
  log.warn("test", "careful", { count: 2 });
  log.error("test", "failed", { err: new Error("broken"), count: 3 });

  const rows = entries.map(([method, line]) => [method, JSON.parse(line)]);
  assert.deepEqual(rows.map(([method, row]) => [method, row.level]), [
    ["log", "info"], ["warn", "warn"], ["error", "error"],
  ]);
  assert.ok(rows.every(([, row]) => !Number.isNaN(Date.parse(row.ts))));
  assert.deepEqual(rows.map(([, row]) => row.count), [1, 2, 3]);
  assert.deepEqual(rows.map(([, row]) => [row.event, row.msg]), [
    ["test", "ready"], ["test", "careful"], ["test", "failed"],
  ]);
  assert.equal(rows[2][1].errorName, "Error");
  assert.equal(rows[2][1].errorMessage, "broken");
  assert.equal(typeof rows[2][1].errorStack, "string");
  assert.equal("err" in rows[2][1], false);
});

test("retry passes attempt numbers, retries allowed errors, and preserves non-retryable errors", async (t) => {
  t.mock.method(console, "warn", () => {});
  const attempts = [];
  const result = await retry(async (attempt) => {
    attempts.push(attempt);
    if (attempt < 3) throw new Error("try again");
    return "done";
  }, { attempts: 3, baseMs: 0, maxMs: 0, label: "test" });
  assert.equal(result, "done");
  assert.deepEqual(attempts, [1, 2, 3]);

  const failure = new Error("stop");
  let calls = 0;
  await assert.rejects(retry(() => {
    calls++;
    throw failure;
  }, { attempts: 4, baseMs: 0, maxMs: 0, shouldRetry: () => false }), (error) => error === failure);
  assert.equal(calls, 1);

  const exhausted = new Error("exhausted");
  calls = 0;
  await assert.rejects(retry(() => {
    calls++;
    throw exhausted;
  }, { attempts: 2, baseMs: 0, maxMs: 0 }), (error) => error === exhausted);
  assert.equal(calls, 2);
});

test("retry caps backoff before jitter and never asks to retry the final failure", async (t) => {
  const delays = [];
  const rows = [];
  t.mock.method(globalThis, "setTimeout", (callback, delay) => { delays.push(delay); callback(); });
  t.mock.method(Math, "random", () => 1);
  t.mock.method(console, "warn", (line) => rows.push(JSON.parse(line)));
  const failure = new TypeError("private detail");
  let decisions = 0;
  await assert.rejects(retry(() => { throw failure; }, {
    attempts: 4, baseMs: 10, maxMs: 15, label: "fixture",
    shouldRetry: (error) => { assert.equal(error, failure); decisions++; return true; },
  }), (error) => error === failure);
  assert.deepEqual(delays, [13, 19, 19]);
  assert.equal(decisions, 3);
  assert.deepEqual(rows.map(({ attempt, errorType }) => [attempt, errorType]), [[1, "TypeError"], [2, "TypeError"], [3, "TypeError"]]);
  assert.ok(rows.every((row) => !JSON.stringify(row).includes("private detail")));
});

test("logger preserves field overrides and bounds expanded error stacks", (t) => {
  const rows = [];
  t.mock.method(console, "log", (line) => rows.push(JSON.parse(line)));
  t.mock.method(console, "error", (line) => rows.push(JSON.parse(line)));
  log.info("event", "message", { ts: "custom", level: "custom", event: "override", msg: "override" });
  assert.deepEqual(rows[0], { ts: "custom", level: "custom", event: "override", msg: "override" });
  const err = new Error("fixture");
  err.stack = Array.from({ length: 8 }, (_, index) => `line ${index}`).join("\n");
  log.error("event", "message", { err });
  assert.equal(rows[1].errorStack, "line 0 | line 1 | line 2 | line 3 | line 4 | line 5");
  log.error("event", "message", { err: "value" });
  assert.equal(rows[2].err, "value");
});
