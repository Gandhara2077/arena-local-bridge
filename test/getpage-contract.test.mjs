// A cross-file contract guard for ArenaBrowser.getPage().
//
// The signature changed from (cookieHeader, updatedAt) to one credential object,
// and later gained a second parameter — the page purpose. `npm test` never
// executes the CLI scripts in bin/, so a call site left on the old signature
// stays green here and only fails at run time — as an anonymous,
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
// The old signature's two parameters. A credential is a whole object, so a
// member access to either of these is the tell that a call site is still on it.
const OLD_PARAM = /\.\s*(cookieHeader|updatedAt)\s*$/;
// A first argument that is a string is that same mistake spelled differently.
const STRING_LITERAL = /^["'`]/;
// The purpose is required, so a call is exactly two arguments: the credential and
// the purpose. One argument means whoever wrote it was expecting a default, which
// is the silent-wrong-page failure this indirection exists to prevent.
const ARGUMENT_COUNT = 2;
// What this cannot see: a wrapped expression such as String(c.cookieHeader).
// The runtime guard inside getPage() covers what a text scan misses.
function looksStale(args) {
  return (
    args.length !== ARGUMENT_COUNT ||
    STRING_LITERAL.test(args[0] || "") ||
    args.some((arg) => OLD_PARAM.test(arg))
  );
}

/**
 * Source with the brackets inside every string literal blanked to spaces. A
 * message that names a call (`"...getPage() takes ..."`) is text, not a call
 * site, and a scan that reads it reports a call with no arguments — which is
 * exactly what happened the first time this rule was tightened. Only the
 * brackets go: the rest of the literal stays readable, so an offender is still
 * reported with the argument it actually passes.
 */
export function maskStringBrackets(text) {
  let out = "";
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") {
        out += ch + (text[i + 1] ?? "");
        i++;
      } else if (ch === quote) {
        quote = "";
        out += ch;
      } else {
        out += ch === "(" || ch === ")" ? " " : ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    out += ch;
  }
  return out;
}

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

/** The arguments of one call, split on commas that are not inside brackets. */
export function splitArguments(args) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(args.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(args.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part !== "");
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
  assert.deepEqual(splitArguments(calls[0].args), ["credential", "extra"]);
});

test("callArguments: a nested call is one argument, not two", () => {
  const calls = callArguments("await browser.getPage(pick(a, b));", "getPage");
  assert.equal(calls.length, 1);
  assert.deepEqual(splitArguments(calls[0].args), ["pick(a, b)"]);
});

test("callArguments: an object literal is one argument", () => {
  const calls = callArguments("await browser.getPage({ ...A, updatedAt: now });", "getPage");
  assert.deepEqual(splitArguments(calls[0].args), ["{ ...A, updatedAt: now }"]);
});

test("callArguments: a call mentioned in a comment is not a call", () => {
  const calls = callArguments("// was getPage(cookieHeader, updatedAt)\nconst x = 1;", "getPage");
  assert.deepEqual(calls, []);
});

test("splitArguments: brackets reset the depth", () => {
  assert.deepEqual(splitArguments("a, b"), ["a", "b"]);
  assert.deepEqual(splitArguments("a"), ["a"]);
  assert.deepEqual(splitArguments("[a, b]"), ["[a, b]"]);
  assert.deepEqual(splitArguments("{ a: 1, b: 2 }"), ["{ a: 1, b: 2 }"]);
  assert.deepEqual(splitArguments(""), []);
});

test("splitArguments: the old call shape is seen as two arguments", () => {
  assert.deepEqual(splitArguments("credential.cookieHeader, credential.updatedAt"), [
    "credential.cookieHeader",
    "credential.updatedAt",
  ]);
});

test("looksStale: the shape that was actually missed is caught", () => {
  // The eight call sites in bin/ all looked like the first line. The one below
  // it is the same mistake with the cookie header spelled out as a variable.
  assert.equal(looksStale(["agent.cookieHeader", "agent.updatedAt"]), true);
  assert.equal(looksStale(["String(agent.cookieHeader)", '"converse"']), false, "文本扫描看不到包装过的表达式，由运行期守卫兜底");
  assert.equal(looksStale(['"arena-auth-prod-v1=abc"']), true);
  assert.equal(looksStale(["credential", '"recaptcha"']), false);
  assert.equal(looksStale(["credential", '"converse"', "extra"]), true);
  assert.equal(looksStale(["credential"]), true, "少了 purpose：调用方以为有默认值");
  assert.equal(looksStale([]), true, "一个参数都没有也是错的形状");
});

test("maskStringBrackets: a message that names a call is not a call site", () => {
  // The guard's own error text says "...getPage() takes ...", and reading that
  // as a real call reported an argument-less call site inside arena-login.mjs.
  const source = 'throw new Error("ArenaBrowser.getPage() takes a credential");\nconst page = await getPage(c, "converse");';
  const calls = callArguments(maskStringBrackets(source), "getPage");
  assert.equal(calls.length, 1);
  assert.deepEqual(splitArguments(calls[0].args), ["c", '"converse"']);
});

test("maskStringBrackets: a string argument is still recognisable afterwards", () => {
  const args = splitArguments(
    callArguments(maskStringBrackets('getPage("arena-auth-prod-v1=abc", x);'), "getPage")[0].args
  );
  assert.equal(args[0], '"arena-auth-prod-v1=abc"');
  assert.equal(args[1], "x");
});

// ── the real call sites ─────────────────────────────────────────────────────

test("every getPage() call site names a credential object and a purpose", () => {
  const offenders = [];
  for (const dir of SCANNED) {
    for (const file of sourceFiles(dir)) {
      const text = maskStringBrackets(fs.readFileSync(file, "utf8"));
      for (const call of callArguments(text, "getPage")) {
        const args = splitArguments(call.args);
        if (looksStale(args)) {
          offenders.push(`${path.relative(ROOT, file)}:${call.line}  (${args.join(" | ") || "no arguments"})`);
        }
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `getPage(credential, purpose) — fix: ${offenders.join(", ")}`
  );
});
