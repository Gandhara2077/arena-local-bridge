// assemble.mjs — build the injectable probe from src/probe/modules/.
//
// The probe is a browser script, so it has to reach the page as ONE
// self-contained string: page.addInitScript() takes a string, not a module
// graph. The modules stay separate files so each can be reviewed on its own;
// this file is the only place that knows how they fit back together.
//
// Line endings are kept as CRLF on purpose. The assembled output is then
// byte-for-byte reproducible against the single file that shipped before the
// split, which is what makes "this refactor changed nothing" checkable rather
// than merely asserted.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODULES_DIR = path.join(__dirname, "modules");

/**
 * Declaration order. __req() resolves lazily, so order does not affect
 * correctness — it is kept identical to the original single file so the output
 * is reproducible.
 */
export const MODULE_ORDER = [
  "reasoning",
  "usd-quota",
  "trace-summary",
  "agent-detail",
  "automatic-trace",
  "trace-parser",
  "native-capture",
  "registry",
  "classify",
  "interceptor",
  "idmap",
  "runmodel",
  "learned",
  "probe",
  "main",
];

const crlf = (text) => text.replace(/\r?\n/g, "\r\n");

const HEADER = crlf(`/* arena-model-probe v1.0.0 — 单文件注入版 (CDP / DevTools Snippet)
   本项目（arena-local-bridge）的一部分：由 src/probe/ 组装后经 addInitScript 注入到
   Playwright 页面，负责识别回答问题的真实模型名及其推理档位。它挂页面自身的网络钩子，
   直接读页面自己拉取的 trace，因此不需要 run token、不产生额外请求。 */
`);

// No leading newline: HEADER already ends with one, and the original file has
// the IIFE starting on the very next line.
const PROLOGUE = crlf(`(function () {
"use strict";
var __mods = {}, __cache = {};
function __req(id) {
  if (__cache[id]) return __cache[id].exp;
  var m = __mods[id]; if (!m) throw new Error("module not found: " + id);
  var exp = {}; __cache[id] = { exp: exp };
  m.fn(exp);
  return exp;
}
`);

const EPILOGUE = crlf(`
  try { __req("main"); }
  catch (e) { console.error("[amp] boot failed:", e); }
})();
`);

let cached = null;

/**
 * The probe as a single injectable script. Read once and cached: it never
 * changes during a process lifetime.
 */
export function assembleProbe() {
  if (cached !== null) return cached;
  const parts = MODULE_ORDER.map((id) => {
    const text = fs.readFileSync(path.join(MODULES_DIR, `${id}.js`), "utf8");
    if (!text.includes(`__mods["${id}"]`)) {
      throw new Error(`src/probe/modules/${id}.js 与它的模块名不符`);
    }
    return text;
  });
  cached = HEADER + PROLOGUE + parts.join("") + EPILOGUE;
  return cached;
}
