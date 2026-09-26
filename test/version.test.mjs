import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { VERSION } from "../src/version.mjs";

// The version used to be hardcoded as "5.0.0" in three places while package.json
// said 0.1.0. These tests keep package.json the only place a version is written.
const ROOT = new URL("../", import.meta.url);
const REPORTERS = ["src/index.mjs", "src/bridge.mjs", "src/server.mjs"];

test("runtime version equals package.json", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("package.json", ROOT), "utf8"));
  assert.equal(VERSION, pkg.version);
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});

test("modules that report the version do not hardcode one", () => {
  for (const file of REPORTERS) {
    const src = fs.readFileSync(new URL(file, ROOT), "utf8");
    assert.ok(!/["']\d+\.\d+\.\d+["']/.test(src), `${file} hardcodes a version`);
    assert.ok(src.includes("./version.mjs"), `${file} should read VERSION`);
  }
});
