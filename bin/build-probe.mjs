// bin/build-probe.mjs — write the injectable probe artifact from src/probe/modules/.
//
// assets/arena-model-probe.inject.js is a build output, not a source file.
// Edit the modules, then run this. test/probe-assemble.test.mjs fails if the
// artifact drifts from what the modules produce.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assembleProbe } from "../src/probe/assemble.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "assets", "arena-model-probe.inject.js");
fs.writeFileSync(out, assembleProbe());
console.log(`已从 src/probe/modules/ 生成 ${path.relative(root, out)}`);
