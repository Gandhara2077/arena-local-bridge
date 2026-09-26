// The probe is assembled from src/probe/modules/ at runtime for injection, and
// bin/build-probe.mjs writes the same bytes to assets/ as a build artifact.
// These two must never drift, and every module the entry point declares must
// exist — a missing one would only surface as a "module not found" throw inside
// the page, which is exactly the kind of failure that is invisible until a real
// run happens.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assembleProbe, MODULE_ORDER } from "../src/probe/assemble.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACT = path.join(root, "assets", "arena-model-probe.inject.js");
const MODULES_DIR = path.join(root, "src", "probe", "modules");

test("每个声明的模块都有对应文件，且文件内容与模块名相符", () => {
  for (const id of MODULE_ORDER) {
    const file = path.join(MODULES_DIR, `${id}.js`);
    assert.ok(fs.existsSync(file), `缺少 src/probe/modules/${id}.js`);
    assert.match(fs.readFileSync(file, "utf8"), new RegExp(`__mods\\["${id}"\\]`), `${id}.js 内容与模块名不符`);
  }
});

test("拼装产物的每个 __req 目标都已定义", () => {
  const built = assembleProbe();
  const defined = new Set([...built.matchAll(/__mods\["([a-z-]+)"\]/g)].map((m) => m[1]));
  const used = new Set([...built.matchAll(/__req\(["']([a-z-]+)["']\)/g)].map((m) => m[1]));
  const missing = [...used].filter((id) => !defined.has(id));
  assert.deepEqual(missing, [], `引用了但未定义: ${missing.join(", ")}`);
  assert.equal(defined.size, MODULE_ORDER.length);
});

test("assets/ 里的构建产物与模块拼装结果一致", () => {
  const artifact = fs.readFileSync(ARTIFACT, "utf8");
  assert.equal(artifact, assembleProbe(), "产物已漂移——运行 node bin/build-probe.mjs 重新生成");
});

test("拼装产物不含未定义的模块系统残留", () => {
  const built = assembleProbe();
  // The bundle is self-contained: it must not reference a bundler's require.
  assert.doesNotMatch(built, /__webpack_require__|__esModule/);
  assert.match(built, /^\/\* arena-model-probe/);
  assert.match(built, /__req\("main"\)/);
});
