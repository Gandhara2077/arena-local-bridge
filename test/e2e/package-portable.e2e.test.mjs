// The portable archive, end to end: run bin/package-portable.mjs, unpack what it
// produced, and read the result. Everything else that touches the packager tests
// its decisions — isBrowserArtifact, in test/browser-detect.test.mjs — so nothing
// else can catch the script staging the wrong tree. This is the layer that
// reaches the artifact a user downloads, and the artifact is the product.
//
// Nothing here writes into the checkout. The refusal cases need a tree to plant
// a fake browser in, and the packager derives its root from its own location,
// so they run against a throwaway copy of the script beside the two modules it
// imports: the same bytes, in a root the test may scribble on.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { VERSION } from "../../src/version.mjs";
import { isBrowserArtifact } from "../../src/browser-detect.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(ROOT, "bin", "package-portable.mjs");
const WIN = process.platform === "win32";
const NODE_DIR = path.dirname(process.execPath);

// The archive's top level: the packager's whitelist plus the `runtime/` it adds
// itself. Written out rather than imported, because the point of a packaging
// test is that what ships cannot change without somebody editing this list.
const WHITELIST = [
  ".env.example",
  "LICENSE",
  "NOTICE.md",
  "README.md",
  "README.zh-CN.md",
  "SECURITY.md",
  "SKILL.md",
  "bin",
  "install.sh",
  "node_modules",
  "package.json",
  "runtime",
  "src",
  "start-gui.bat",
  "stop-gui.bat",
];

const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// Not spawnSync's default stdio: a child spawned with a piped stdin hangs on
// Windows and comes back with status === null after a few milliseconds.
function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, encoding: "utf8", ...opts });
}

/** Does this program exist at all? The exit code is irrelevant, only ENOENT is. */
function have(cmd, args) {
  return !run(cmd, args).error;
}

function pack({ script = SCRIPT, out, node = NODE_DIR }) {
  return run(process.execPath, [script, "--out", out, "--node", node]);
}

/** Every file under dir, as forward-slash paths relative to it. */
function walk(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else out.push(path.relative(base, full).replace(/\\/g, "/"));
  }
  return out;
}

const archivesIn = (out) => (fs.existsSync(out) ? fs.readdirSync(out).filter((f) => f.endsWith(".zip")) : []);

const ARCHIVER = WIN ? "powershell" : "zip";
const UNARCHIVER = WIN ? "powershell" : "unzip";
const PROBE = WIN ? ["-NoProfile", "-NonInteractive", "-Command", "exit 0"] : ["-v"];
const missing = [ARCHIVER, UNARCHIVER].filter((cmd) => !have(cmd, PROBE));

describe("the portable archive", {
  skip: missing.length ? `no ${missing.join(" / ")} on this machine: cannot build and unpack it` : false,
}, () => {
  let root;
  let unpacked;
  let files;

  before(() => {
    root = tempDir("arena-pkg-");
    const out = path.join(root, "out");
    const packed = pack({ out });
    assert.equal(packed.status, 0, `the packager failed:\n${packed.stderr || packed.stdout}`);

    const produced = archivesIn(out);
    assert.equal(produced.length, 1, `expected exactly one archive, got ${JSON.stringify(fs.readdirSync(out))}`);
    assert.equal(produced[0], `arena-bridge-portable-${VERSION}-${process.platform}.zip`);

    const zip = path.join(out, produced[0]);
    unpacked = path.join(root, "unpacked");
    fs.mkdirSync(unpacked, { recursive: true });
    const un = WIN
      ? run("powershell", [
          "-NoProfile", "-NonInteractive", "-Command",
          `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${unpacked}' -Force`,
        ])
      : run("unzip", ["-q", zip, "-d", unpacked]);
    assert.equal(un.status, 0, `could not unpack the archive:\n${un.stderr || un.stdout}`);
    files = walk(unpacked);
  });

  // Called with no arguments, so it runs even when a test above it threw. The
  // archive and its unpacked copy are ~137 MB, which is reason enough not to
  // leave them in the OS temp directory.
  after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("the runtime is the Node the packager was pointed at, and it runs", () => {
    const runtime = path.join(unpacked, "runtime", WIN ? "node.exe" : "node");
    assert.ok(files.includes(`runtime/${WIN ? "node.exe" : "node"}`), `${runtime} is not in the archive`);
    assert.equal(fs.statSync(runtime).size, fs.statSync(process.execPath).size, "not the same runtime we passed");
    const version = run(runtime, ["--version"]);
    assert.equal(version.status, 0, "the bundled runtime did not start");
    assert.equal(version.stdout.trim(), process.version);
  });

  test("the top level is the whitelist and nothing else", () => {
    // Set equality rather than four separate absence checks: `test/`, `.git`,
    // the DATA_DIR state and the `.arena-*` files are all just "not on the
    // list", and a list cannot go stale the way a hand-picked set of names can.
    assert.deepEqual(fs.readdirSync(unpacked).sort(), [...WHITELIST].sort());
  });

  test("the files an unzip-and-run actually needs are inside it", () => {
    // The whitelist check above only proves the directory entries made it. An
    // archive with an empty src/ would still pass it, and would not start.
    for (const needed of ["src/index.mjs", "bin/package-portable.mjs", "package.json", "start-gui.bat"]) {
      assert.ok(files.includes(needed), `${needed} is missing from the archive`);
    }
  });

  test("no browser is bundled, whatever it might be called", () => {
    assert.deepEqual(files.filter((f) => isBrowserArtifact(f)), []);
  });
});

describe("the refusal paths", () => {
  let root;
  let script;

  // A throwaway root. The packager resolves ROOT from where the script lives,
  // so copying it next to the two modules it imports — version.mjs, which reads
  // package.json for the version, and browser-detect.mjs, which imports nothing
  // but node builtins — gives the same code running against a tree we may plant
  // things in. Every SHIP entry exists, so refusal tests reach their intended
  // checks; their unused files and dependencies can be empty.
  before(() => {
    root = tempDir("arena-pkg-root-");
    script = path.join(root, "bin", "package-portable.mjs");
    for (const [from, to] of [
      [SCRIPT, "bin/package-portable.mjs"],
      [path.join(ROOT, "src", "version.mjs"), "src/version.mjs"],
      [path.join(ROOT, "src", "browser-detect.mjs"), "src/browser-detect.mjs"],
      [path.join(ROOT, "package.json"), "package.json"],
    ]) {
      fs.mkdirSync(path.dirname(path.join(root, to)), { recursive: true });
      fs.copyFileSync(from, path.join(root, to));
    }
    for (const entry of WHITELIST.filter((entry) => entry !== "runtime")) {
      const file = path.join(root, entry);
      if (fs.existsSync(file)) continue;
      if (entry === "node_modules") fs.mkdirSync(file);
      else fs.writeFileSync(file, "");
    }
  });

  after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("a missing required entry is named before an existing staged tree is touched", () => {
    const license = path.join(root, "LICENSE");
    const saved = fs.readFileSync(license);
    const out = path.join(root, "out-missing");
    const stage = path.join(out, `arena-bridge-portable-${VERSION}-${process.platform}`);
    fs.mkdirSync(stage, { recursive: true });
    const sentinel = path.join(stage, "previous-stage.txt");
    fs.writeFileSync(sentinel, "keep the existing stage");
    try {
      fs.rmSync(license);
      const r = pack({ script, out });
      assert.equal(r.status, 1, "a missing required entry has to stop the run");
      assert.match(r.stderr, /Missing required package entries: LICENSE/);
      assert.equal(fs.readFileSync(sentinel, "utf8"), "keep the existing stage", "preflight must precede staging");
      assert.deepEqual(archivesIn(out), []);
    } finally {
      fs.writeFileSync(license, saved);
    }
  });

  test("an invalid version cannot move recursive staging cleanup outside the output directory", () => {
    const manifest = path.join(root, "package.json");
    const saved = fs.readFileSync(manifest, "utf8");
    const out = path.join(root, "out-invalid-stage");
    const outside = path.join(root, `outside-${process.platform}`);
    assert.equal(path.dirname(path.resolve(outside)), path.resolve(root));
    fs.mkdirSync(outside);
    const sentinel = path.join(outside, "keep.txt");
    fs.writeFileSync(sentinel, "outside the generated output");
    try {
      fs.writeFileSync(manifest, JSON.stringify({ ...JSON.parse(saved), version: "../../../outside" }));
      const r = pack({ script, out });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /Invalid staging path/);
      assert.equal(fs.readFileSync(sentinel, "utf8"), "outside the generated output");
      assert.deepEqual(archivesIn(out), []);
    } finally {
      fs.writeFileSync(manifest, saved);
    }
  });

  test("a browser anywhere in the staged tree is refused, and named", () => {
    const planted = path.join(root, "src", "ms-playwright");
    fs.mkdirSync(planted, { recursive: true });
    fs.writeFileSync(path.join(planted, "chrome.exe"), "");
    try {
      const out = path.join(root, "out-browser");
      const r = pack({ script, out });
      assert.equal(r.status, 1, "a staged browser has to stop the run");
      assert.match(r.stderr, /Refusing to ship a browser \(ADR 0005\)/);
      assert.match(r.stderr, /ms-playwright/, "and it has to say which path it found");
      assert.deepEqual(archivesIn(out), [], "a refused package must not produce an archive");
      assert.equal(fs.existsSync(path.join(out, `arena-bridge-portable-${VERSION}-${process.platform}`)), false,
        "a browser refusal must remove the generated staging tree");
      assert.match(r.stderr, /Staged tree removed/);
    } finally {
      assert.equal(path.dirname(path.dirname(path.resolve(planted))), path.resolve(root));
      fs.rmSync(planted, { recursive: true, force: true });
    }
  });

  test("a staged tree over the size limit is refused, and the biggest files named", () => {
    // A sparse file, so 260 MB of "something big" costs no 260 MB of writes. The
    // name matches nothing a browser check knows about, which is the case the
    // size net exists for: names only catch the layouts somebody thought of.
    const big = path.join(root, "src", "huge.bin");
    const fd = fs.openSync(big, "w");
    fs.ftruncateSync(fd, 260 * 1024 * 1024);
    fs.closeSync(fd);
    try {
      const out = path.join(root, "out-size");
      const r = pack({ script, out });
      assert.equal(r.status, 1, "an oversized staged tree has to stop the run");
      assert.match(r.stderr, /Refusing to ship \d+ MB unpacked/);
      assert.match(r.stderr, /huge\.bin/, "\"400 MB of something\" is not actionable on its own");
      assert.deepEqual(archivesIn(out), [], "a refused package must not produce an archive");
      assert.equal(fs.existsSync(path.join(out, `arena-bridge-portable-${VERSION}-${process.platform}`)), false,
        "a size refusal must remove the generated staging tree");
      assert.match(r.stderr, /Staged tree removed/);
    } finally {
      fs.rmSync(big, { force: true });
    }
  });

  test("an archive failure still preserves the staged tree for manual recovery", () => {
    const out = path.join(root, "out-archive-failure");
    // The script still runs with the real Node; only its external archiver is
    // unavailable. Empty both spellings because Windows env keys ignore case.
    const r = run(process.execPath, [script, "--out", out, "--node", process.execPath], {
      env: { ...process.env, PATH: "", Path: "" },
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /No archiver found/);
    const stage = path.join(out, `arena-bridge-portable-${VERSION}-${process.platform}`);
    assert.ok(fs.existsSync(stage), "archive failure must leave the tree for recovery");
    assert.match(r.stderr, /The staged tree is still at/);
    assert.equal(fs.readFileSync(path.join(stage, "package.json"), "utf8"), fs.readFileSync(path.join(root, "package.json"), "utf8"));
    assert.deepEqual(archivesIn(out), []);
  });
});
