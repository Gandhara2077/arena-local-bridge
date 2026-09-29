#!/usr/bin/env node
// Build the portable archive ADR 0005 describes: this app, a Node runtime and
// the launcher — and no Chromium, which is the whole point. Bundling
// Playwright's browser takes the download from ~80 MB to 350–700 MB and puts it
// back on every machine that already has Chrome or Edge.
//
// Nothing is downloaded here either. The Node runtime to bundle has to be on
// this machine already: --node <dir-or-exe>, defaulting to the Node running
// this script. A maintainer who wants an official build drops the Node zip next
// to it and points --node at that.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { VERSION } from "../src/version.mjs";
import { isBrowserArtifact } from "../src/browser-detect.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const outDir = path.resolve(arg("--out", path.join(ROOT, "dist")));
const nodeGiven = arg("--node", path.dirname(process.execPath));
const nodeExe = fs.existsSync(nodeGiven) && fs.statSync(nodeGiven).isDirectory()
  ? path.join(nodeGiven, process.platform === "win32" ? "node.exe" : "node")
  : nodeGiven;
if (!fs.existsSync(nodeExe)) {
  console.error(`No Node runtime at ${nodeExe}. Pass --node <dir-or-exe> (nothing is downloaded).`);
  process.exit(1);
}

// What a user of the archive needs — source, the operational scripts, the
// dependencies and the launcher. Deliberately not: tests, .git, or any runtime
// state (DATA_DIR, archives, logs).
const SHIP = [
  "src",
  "bin",
  "node_modules",
  "package.json",
  "README.md",
  "README.zh-CN.md",
  "LICENSE",
  "NOTICE.md",
  "SECURITY.md",
  "SKILL.md",
  ".env.example",
  "start-gui.bat",
  "stop-gui.bat",
  "install.sh",
];

const name = `arena-bridge-portable-${VERSION}-${process.platform}`;
const stage = path.join(outDir, name);
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
for (const entry of SHIP) {
  const from = path.join(ROOT, entry);
  if (!fs.existsSync(from)) continue;
  fs.cpSync(from, path.join(stage, entry), {
    recursive: true,
    filter: (p) => !/\.(log|tmp)$/i.test(p),
  });
}
fs.mkdirSync(path.join(stage, "runtime"), { recursive: true });
fs.copyFileSync(nodeExe, path.join(stage, "runtime", path.basename(nodeExe)));

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const shipped = walk(stage);
// The first thing this script exists to guarantee. Matched relative to the
// staged tree, so the directory the user picked (--out, cwd) cannot make a
// legitimate file look like a browser or hide one (see isBrowserArtifact).
const banned = shipped.filter((f) => isBrowserArtifact(path.relative(stage, f)));
if (banned.length) {
  console.error(`Refusing to ship a browser (ADR 0005): ${banned.slice(0, 5).map((f) => path.relative(stage, f)).join(", ")}`);
  process.exit(1);
}

// The second one, under it. Matching names only catches the layouts somebody
// thought of, so the size is the net that catches the rest: an archive this
// small cannot hold a browser whatever it is called. Reported with the biggest
// files, because "400 MB of something" is not actionable on its own.
const LIMIT_MB = 250;
const sizes = shipped.map((f) => ({ f, mb: fs.statSync(f).size / 1024 / 1024 }));
const stagedMb = sizes.reduce((total, s) => total + s.mb, 0);
if (stagedMb > LIMIT_MB) {
  const biggest = sizes.sort((a, b) => b.mb - a.mb).slice(0, 5).map((s) => `${s.mb.toFixed(0)} MB  ${path.relative(stage, s.f)}`);
  console.error(`Refusing to ship ${stagedMb.toFixed(0)} MB unpacked (limit ${LIMIT_MB} MB, ADR 0005). Biggest files:\n  ${biggest.join("\n  ")}`);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
const zip = path.join(outDir, `${name}.zip`);
fs.rmSync(zip, { force: true });
const pack =
  process.platform === "win32"
    ? spawnSync(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command", `Compress-Archive -Path '${path.join(stage, "*")}' -DestinationPath '${zip}' -Force`],
        { stdio: "inherit" }
      )
    : spawnSync("zip", ["-q", "-r", zip, "."], { cwd: stage, stdio: "inherit" });
if (pack.error || pack.status !== 0) {
  console.error(
    pack.error?.code === "ENOENT"
      ? `No archiver found (${process.platform === "win32" ? "powershell" : "zip"}). Install one and re-run.`
      : "Archiving failed."
  );
  console.error(`The staged tree is still at ${stage} — zip it yourself if you prefer.`);
  process.exit(1);
}
fs.rmSync(stage, { recursive: true, force: true });

const mb = fs.statSync(zip).size / 1024 / 1024;
console.log(`\n${zip}`);
console.log(`${mb.toFixed(1)} MB zipped · ${stagedMb.toFixed(0)} MB unpacked · ${shipped.length} files · no browser bundled.`);
console.log(
  process.platform === "win32"
    ? "To use it: unzip, double-click start-gui.bat (it prefers the bundled runtime/node)."
    : "The launcher in this archive (start-gui.bat) is Windows-only, which is what this release targets; here, start it with runtime/node src/index.mjs."
);
