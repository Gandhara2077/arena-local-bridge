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
const PACKAGE_NAME = `arena-bridge-portable-${VERSION}-${process.platform}-${process.arch}`;

// The archive's top level: the packager's whitelist plus the `runtime/` it adds
// itself. Written out rather than imported, because the point of a packaging
// test is that what ships cannot change without somebody editing this list.
const WHITELIST = [
  ".env.example",
  "ArenaLocalBridge.exe",
  "LICENSE",
  "NOTICE.md",
  "README.md",
  "README.zh-CN.md",
  "SECURITY.md",
  "SKILL.md",
  "bin",
  "install.sh",
  "launcher",
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

function pack({ script = SCRIPT, out, node = process.execPath, nodeLicense, launcher }) {
  const args = [script, "--out", out, "--node", node];
  if (nodeLicense !== undefined) args.push("--node-license", nodeLicense);
  if (launcher !== undefined) args.push("--launcher", launcher);
  return run(process.execPath, args);
}

const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;

function unpack(zip, destination) {
  fs.mkdirSync(destination, { recursive: true });
  return WIN
    ? run("powershell", [
        "-NoProfile", "-NonInteractive", "-Command",
        `Expand-Archive -LiteralPath ${psQuote(zip)} -DestinationPath ${psQuote(destination)} -Force`,
      ])
    : run("unzip", ["-q", zip, "-d", destination]);
}

// Use the real packager against a small synthetic app tree. The release exe is
// compiled separately on Windows; packaging CI must not need that compiler or
// an installed Node LICENSE. The runtime test still bundles and runs real Node.
function fixture(root) {
  for (const [from, to] of [
    [SCRIPT, "bin/package-portable.mjs"],
    [path.join(ROOT, "src", "version.mjs"), "src/version.mjs"],
    [path.join(ROOT, "src", "browser-detect.mjs"), "src/browser-detect.mjs"],
    [path.join(ROOT, "package.json"), "package.json"],
  ]) {
    fs.mkdirSync(path.dirname(path.join(root, to)), { recursive: true });
    fs.copyFileSync(from, path.join(root, to));
  }
  for (const entry of WHITELIST.filter((entry) => entry !== "runtime" && entry !== "ArenaLocalBridge.exe")) {
    const file = path.join(root, entry);
    if (fs.existsSync(file)) continue;
    if (entry === "node_modules" || entry === "launcher") {
      fs.mkdirSync(file);
      fs.writeFileSync(path.join(file, entry === "launcher" ? "ArenaLocalBridge.cs" : "fixture.txt"), "package fixture");
    } else fs.writeFileSync(file, "package fixture");
  }
  fs.writeFileSync(path.join(root, "src", "index.mjs"), "// app fixture\n");
  fs.writeFileSync(path.join(root, "bin", "gui-runtime.mjs"), "// launcher fixture\n");
  fs.writeFileSync(path.join(root, "bin", "build-launcher.ps1"), "# build fixture\n");
  const launcher = path.join(root, "dist", "ArenaLocalBridge.exe");
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.writeFileSync(launcher, "Windows launcher fixture");
  const nodeLicense = path.join(root, "Node license's text.txt");
  fs.writeFileSync(nodeLicense, "Node runtime license fixture\n");
  return { script: path.join(root, "bin", "package-portable.mjs"), launcher, nodeLicense };
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
  let app;
  let unpacked;
  let files;

  before(() => {
    root = tempDir("arena pkg-测试's-");
    app = fixture(root);
    // Personal state beside the app must not become part of the whitelist.
    fs.mkdirSync(path.join(root, ".arena-gui"));
    fs.writeFileSync(path.join(root, ".arena-gui", "accounts.json"), "private fixture");
    const out = path.join(root, "output's [portable]");
    const packed = pack({ ...app, out });
    assert.equal(packed.status, 0, `the packager failed:\n${packed.stderr || packed.stdout}`);

    const produced = archivesIn(out);
    assert.equal(produced.length, 1, `expected exactly one archive, got ${JSON.stringify(fs.readdirSync(out))}`);
    assert.equal(produced[0], `${PACKAGE_NAME}.zip`);

    const zip = path.join(out, produced[0]);
    unpacked = path.join(root, "unpacked");
    const un = unpack(zip, unpacked);
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

  test("the explicit Node license is bundled with the chosen runtime", () => {
    assert.equal(fs.readFileSync(path.join(unpacked, "runtime", "LICENSE"), "utf8"),
      fs.readFileSync(app.nodeLicense, "utf8"));
  });

  test("the files an unzip-and-run actually needs are inside it", () => {
    // The whitelist check above only proves the directory entries made it. An
    // archive with an empty src/ would still pass it, and would not start.
    for (const needed of ["ArenaLocalBridge.exe", "src/index.mjs", "bin/gui-runtime.mjs", "bin/package-portable.mjs", "package.json", "start-gui.bat"]) {
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
  let app;

  // A throwaway root. The packager resolves ROOT from where the script lives,
  // so copying it next to the two modules it imports — version.mjs, which reads
  // package.json for the version, and browser-detect.mjs, which imports nothing
  // but node builtins — gives the same code running against a tree we may plant
  // things in. Every SHIP entry exists, so refusal tests reach their intended
  // checks; their unused files and dependencies can be empty.
  before(() => {
    root = tempDir("arena-pkg-root-");
    app = fixture(root);
    script = app.script;
  });

  after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("a missing required entry is named before an existing staged tree is touched", () => {
    const license = path.join(root, "LICENSE");
    const saved = fs.readFileSync(license);
    const out = path.join(root, "out-missing");
    const stage = path.join(out, PACKAGE_NAME);
    fs.mkdirSync(stage, { recursive: true });
    const sentinel = path.join(stage, "previous-stage.txt");
    fs.writeFileSync(sentinel, "keep the existing stage");
    try {
      fs.rmSync(license);
      const r = pack({ ...app, out });
      assert.equal(r.status, 1, "a missing required entry has to stop the run");
      assert.match(r.stderr, /Missing required package entries: LICENSE/);
      assert.equal(fs.readFileSync(sentinel, "utf8"), "keep the existing stage", "preflight must precede staging");
      assert.deepEqual(archivesIn(out), []);
    } finally {
      fs.writeFileSync(license, saved);
    }
  });

  for (const [name, missingFile, nodeLicense, message] of [
    ["Node license", () => path.join(root, "missing-node-LICENSE"), () => path.join(root, "missing-node-LICENSE"), /No Node license/],
    ["Windows launcher", () => app.launcher, () => app.nodeLicense, /No Windows launcher/],
    ["GUI runtime", () => path.join(root, "bin", "gui-runtime.mjs"), () => app.nodeLicense, /bin[\\/]gui-runtime\.mjs/],
  ]) {
    test(`a missing ${name} is refused before previous outputs are replaced`, () => {
      const file = missingFile();
      const saved = fs.existsSync(file) ? fs.readFileSync(file) : null;
      const out = path.join(root, `out-missing-${name.replace(/ /g, "-")}`);
      const stage = path.join(out, PACKAGE_NAME);
      fs.mkdirSync(stage, { recursive: true });
      const sentinel = path.join(stage, "keep.txt");
      const previousZip = path.join(out, `${PACKAGE_NAME}.zip`);
      fs.writeFileSync(sentinel, "previous staged output");
      fs.writeFileSync(previousZip, "previous archive");
      try {
        fs.rmSync(file, { force: true });
        const r = pack({ ...app, out, nodeLicense: nodeLicense() });
        assert.equal(r.status, 1, `missing ${name} must stop packaging`);
        assert.match(r.stderr, message);
        assert.equal(fs.readFileSync(sentinel, "utf8"), "previous staged output");
        assert.equal(fs.readFileSync(previousZip, "utf8"), "previous archive");
      } finally {
        if (saved) fs.writeFileSync(file, saved);
      }
    });
  }

  test("an adjacent Node LICENSE is inferred when no override is supplied", { skip: missing.length ? "no archiver/unarchiver" : false }, () => {
    const nodeDir = path.join(root, "node source's directory");
    fs.mkdirSync(nodeDir);
    const node = path.join(nodeDir, WIN ? "node.exe" : "node");
    fs.writeFileSync(node, "runtime fixture");
    fs.writeFileSync(path.join(nodeDir, "LICENSE"), "adjacent runtime license\n");
    const out = path.join(root, "out-inferred-license");
    const r = pack({ ...app, out, node, nodeLicense: undefined });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const destination = path.join(root, "unpacked-inferred-license");
    const un = unpack(path.join(out, `${PACKAGE_NAME}.zip`), destination);
    assert.equal(un.status, 0, un.stderr || un.stdout);
    assert.equal(fs.readFileSync(path.join(destination, "runtime", "LICENSE"), "utf8"), "adjacent runtime license\n");
  });

  test("an invalid version cannot move recursive staging cleanup outside the output directory", () => {
    const manifest = path.join(root, "package.json");
    const saved = fs.readFileSync(manifest, "utf8");
    const out = path.join(root, "out-invalid-stage");
    const outside = path.join(root, `outside-${process.platform}-${process.arch}`);
    assert.equal(path.dirname(path.resolve(outside)), path.resolve(root));
    fs.mkdirSync(outside);
    const sentinel = path.join(outside, "keep.txt");
    fs.writeFileSync(sentinel, "outside the generated output");
    try {
      fs.writeFileSync(manifest, JSON.stringify({ ...JSON.parse(saved), version: "../../../outside" }));
      const r = pack({ ...app, out });
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
      const r = pack({ ...app, out });
      assert.equal(r.status, 1, "a staged browser has to stop the run");
      assert.match(r.stderr, /Refusing to ship a browser \(ADR 0005\)/);
      assert.match(r.stderr, /ms-playwright/, "and it has to say which path it found");
      assert.deepEqual(archivesIn(out), [], "a refused package must not produce an archive");
      assert.equal(fs.existsSync(path.join(out, PACKAGE_NAME)), false,
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
      const r = pack({ ...app, out });
      assert.equal(r.status, 1, "an oversized staged tree has to stop the run");
      assert.match(r.stderr, /Refusing to ship \d+ MB unpacked/);
      assert.match(r.stderr, /huge\.bin/, "\"400 MB of something\" is not actionable on its own");
      assert.deepEqual(archivesIn(out), [], "a refused package must not produce an archive");
      assert.equal(fs.existsSync(path.join(out, PACKAGE_NAME)), false,
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
    const r = run(process.execPath, [script, "--out", out, "--node", process.execPath, "--node-license", app.nodeLicense, "--launcher", app.launcher], {
      env: { ...process.env, PATH: "", Path: "" },
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /No archiver found/);
    const stage = path.join(out, PACKAGE_NAME);
    assert.ok(fs.existsSync(stage), "archive failure must leave the tree for recovery");
    assert.match(r.stderr, /The staged tree is still at/);
    assert.equal(fs.readFileSync(path.join(stage, "package.json"), "utf8"), fs.readFileSync(path.join(root, "package.json"), "utf8"));
    assert.deepEqual(archivesIn(out), []);
  });
});
