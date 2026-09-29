// A cross-file contract guard for ArenaBrowser.getPage().
//
// The signature changed from (cookieHeader, updatedAt) to one credential object.
// `npm test` never executes the CLI scripts in bin/, so a call site left on the
// old signature stays green here and only fails at run time — as an anonymous,
// unauthenticated context rather than an error. That is exactly what happened
// when the change landed: eight call sites in bin/ were missed.
//
// getPage() rejects a credential-less argument now, but that fires only when the
// script runs. This is the part CI can see.
//
// The scan reads source text, so it is deliberately built on a balanced-paren
// walk rather than a regex: a call whose arguments wrap onto the next line is a
// real call, and `getPage(f(a, b))` is not a two-argument call. Both would fool
// a line-based pattern.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const SCANNED = ["src", "bin"];

/** Argument text of every `name(...)` call in `text`, with parens balanced. */
export function callArguments(text, name) {
  const needle = `${name}(`;
  const calls = [];
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
    // A comment that mentions the call is not a call. Checked on the line the
    // call starts on, so a URL containing "//" cannot swallow real code.
    const prefix = text.slice(text.lastIndexOf("\n", at) + 1, at).trim();
    if (prefix.startsWith("//") || prefix.startsWith("*")) continue;

    let depth = 0;
    let end = -1;
    for (let i = at + needle.length - 1; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")" && --depth === 0) {
        end = i;
        break;
      }
    }
    if (end === -1) continue; // unbalanced source; not ours to diagnose
    calls.push({ args: text.slice(at + needle.length, end), line: text.slice(0, at).split("\n").length });
  }
  return calls;
}

/** Is there a comma that is not inside brackets? i.e. a second argument. */
export function hasTopLevelComma(args) {
  let depth = 0;
  for (const ch of args) {
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) return true;
  }
  return false;
}

function sourceFiles(dir) {
  const found = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".mjs")) found.push(full);
    }
  };
  walk(path.join(ROOT, dir));
  return found;
}

// ── the scanner itself, so a broken one cannot pass silently ─────────────────

test("callArguments: finds a call whose arguments wrap onto the next line", () => {
  const calls = callArguments("await browser.getPage(\n  credential,\n  extra\n);", "getPage");
  assert.equal(calls.length, 1);
  assert.equal(hasTopLevelComma(calls[0].args), true);
});

test("callArguments: a nested call is one argument, not two", () => {
  const calls = callArguments("await browser.getPage(pick(a, b));", "getPage");
  assert.equal(calls.length, 1);
  assert.equal(hasTopLevelComma(calls[0].args), false);
});

test("callArguments: an object literal is one argument", () => {
  const calls = callArguments("await browser.getPage({ ...A, updatedAt: now });", "getPage");
  assert.equal(hasTopLevelComma(calls[0].args), false);
});

test("callArguments: a call mentioned in a comment is not a call", () => {
  const calls = callArguments("// was getPage(cookieHeader, updatedAt)\nconst x = 1;", "getPage");
  assert.deepEqual(calls, []);
});

test("hasTopLevelComma: brackets reset the depth", () => {
  assert.equal(hasTopLevelComma("a, b"), true);
  assert.equal(hasTopLevelComma("a"), false);
  assert.equal(hasTopLevelComma("[a, b]"), false);
  assert.equal(hasTopLevelComma("{ a: 1, b: 2 }"), false);
});

// ── the real call sites ─────────────────────────────────────────────────────

test("every getPage() call site passes ONE credential object", () => {
  const offenders = [];
  for (const dir of SCANNED) {
    for (const file of sourceFiles(dir)) {
      const text = fs.readFileSync(file, "utf8");
      for (const call of callArguments(text, "getPage")) {
        if (hasTopLevelComma(call.args)) {
          offenders.push(`${path.relative(ROOT, file)}:${call.line}`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], `getPage() takes one credential object — fix: ${offenders.join(", ")}`);
});
