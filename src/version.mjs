// version.mjs — the package version is the single source of truth. Runtime code
// reads it from here instead of hardcoding a number that drifts.
import fs from "node:fs";

export const VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
