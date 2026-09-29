// ADR 0005 — the portable release ships no Chromium, so finding the browser the
// user already has decides whether the thing starts at all. The order and the
// "nothing there" fallback are what matter, and both are asserted with the disk
// swapped out.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { detectBrowser, isBrowserArtifact } from "../src/browser-detect.mjs";

const WIN_ENV = {
  ProgramFiles: "C:/PF",
  "ProgramFiles(x86)": "C:/PF86",
  LOCALAPPDATA: "C:/LOCAL",
};
const CHROME = path.join(WIN_ENV.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe");
const CHROME_86 = path.join(WIN_ENV["ProgramFiles(x86)"], "Google", "Chrome", "Application", "chrome.exe");
const CHROME_LOCAL = path.join(WIN_ENV.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe");
const EDGE_86 = path.join(WIN_ENV["ProgramFiles(x86)"], "Microsoft", "Edge", "Application", "msedge.exe");
const EDGE = path.join(WIN_ENV.ProgramFiles, "Microsoft", "Edge", "Application", "msedge.exe");

const onWindows = { platform: "win32", env: WIN_ENV, homeDir: "/home/me" };
const nothing = () => false;

test("the order is: installed Chrome, then Edge (x86 first — that is where Windows puts it)", () => {
  const { tried } = detectBrowser({ ...onWindows, exists: nothing, readdir: () => [] });
  assert.deepEqual(tried.slice(0, 5), [CHROME, CHROME_86, CHROME_LOCAL, EDGE_86, EDGE]);
});

test("a machine with only Edge gets Edge — measured: this project's own box has no Chrome", () => {
  const { path: found } = detectBrowser({ ...onWindows, exists: (p) => p === EDGE_86, readdir: () => [] });
  assert.equal(found, EDGE_86);
});

test("Chrome wins when both are installed", () => {
  const both = new Set([CHROME, EDGE_86]);
  const { path: found } = detectBrowser({ ...onWindows, exists: (p) => both.has(p), readdir: () => [] });
  assert.equal(found, CHROME);
});

test("nothing installed anywhere → nothing found, but the list says where we looked", () => {
  const { path: found, tried } = detectBrowser({ ...onWindows, exists: nothing, readdir: () => [] });
  assert.equal(found, "");
  assert.equal(tried.length, 5, "the caller needs the list to tell the user what was tried");
});

// Playwright's own download is the LAST resort: a browser it manages is not the
// first choice, but a developer who ran `npx playwright install chromium` must
// not be told there is no browser.
test("Playwright's cache is considered last, newest revision first", () => {
  const readdir = () => ["chromium-1148", "firefox-1", "chromium-1200"];
  const { tried } = detectBrowser({ ...onWindows, exists: nothing, readdir });
  const cache = tried.slice(5);
  assert.equal(cache.length, 4, "two chromium revisions, and both layouts of each");
  assert.ok(cache[0].includes("chromium-1200"), "the newest revision comes first");
  assert.ok(cache[0].endsWith(path.join("chrome-win64", "chrome.exe")), "in the layout a current Playwright writes");
  assert.ok(cache[1].endsWith(path.join("chrome-win", "chrome.exe")), "then the one an earlier one left");
  assert.ok(cache[2].includes("chromium-1148"));
});

// Playwright 1.63 no longer ships its own Chromium. Its EXECUTABLE_PATHS are
// `chrome-linux64/chrome` and `chrome-mac-<arch>/Google Chrome for Testing.app/
// Contents/MacOS/Google Chrome for Testing`, so looking only for
// `chrome-linux/chrome` — what this did at first — misses a browser that came
// from a current Playwright and reports "nothing installed" instead.
test("Playwright's cache is looked at in the layouts a current version writes", () => {
  const cacheOf = (platform, homeDir, ...layout) =>
    path.join(homeDir, platform === "darwin" ? "Library/Caches" : ".cache", "ms-playwright", "chromium-1200", ...layout);

  const modernLinux = cacheOf("linux", "/home/me", "chrome-linux64", "chrome");
  assert.equal(
    detectBrowser({ platform: "linux", env: {}, homeDir: "/home/me", readdir: () => ["chromium-1200"], exists: (p) => p === modernLinux }).path,
    modernLinux
  );

  const modernMac = cacheOf("darwin", "/home/me", "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");
  assert.equal(
    detectBrowser({ platform: "darwin", env: {}, homeDir: "/home/me", readdir: () => ["chromium-1200"], exists: (p) => p === modernMac }).path,
    modernMac
  );

  // The older layout of the same revision is still looked at, so a browser an
  // earlier Playwright downloaded is not declared missing either.
  const legacyLinux = cacheOf("linux", "/home/me", "chrome-linux", "chrome");
  assert.equal(
    detectBrowser({ platform: "linux", env: {}, homeDir: "/home/me", readdir: () => ["chromium-1200"], exists: (p) => p === legacyLinux }).path,
    legacyLinux
  );
});

test("a Playwright browser is used when no installed one exists", () => {
  const readdir = () => ["chromium-1200"];
  const cached = path.join(WIN_ENV.LOCALAPPDATA, "ms-playwright", "chromium-1200", "chrome-win", "chrome.exe");
  const { path: found } = detectBrowser({ ...onWindows, exists: (p) => p === cached, readdir });
  assert.equal(found, cached);
});

test("macOS and Linux look in their own places", () => {
  const mac = detectBrowser({ platform: "darwin", env: {}, homeDir: "/home/me", exists: nothing, readdir: () => [] });
  assert.equal(mac.tried[0], "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  assert.equal(mac.path, "");

  const linux = detectBrowser({ platform: "linux", env: {}, homeDir: "/home/me", exists: nothing, readdir: () => [] });
  assert.equal(linux.tried[0], "/usr/bin/google-chrome");
});

// The real machine: Windows without Edge is not a Windows most people run.
test("on this Windows box, detection finds the browser that is actually installed", {
  skip: process.platform !== "win32" && "only meaningful where Edge ships with the OS",
}, () => {
  const { path: found, tried } = detectBrowser();
  assert.ok(tried.length > 0);
  assert.ok(found.endsWith(".exe"), `expected a browser, got ${JSON.stringify({ found, tried })}`);
});

// ── refusing to ship one (ADR 0005) ─────────────────────────────────────────
//
// Where a browser is actually found. The check this test covers used to be
// `chrome.exe` / `headless_shell.exe` / `ms-playwright`, and measured against
// this list it missed four of the nine — every one of them a non-`.exe` name
// outside the Playwright cache, including
// `node_modules/playwright-core/.local-browsers/…`, where a browser installed
// with PLAYWRIGHT_BROWSERS_PATH=0 lives. Refusing to ship a browser is that
// check's only job, so "no browser here" must never be its answer to one.
test("isBrowserArtifact: a browser is recognised in every layout it is found in", () => {
  const artifacts = [
    // the Playwright cache, in the layouts it has written over time
    "/base/ms-playwright/chromium-1200/chrome-win/chrome.exe",
    "/home/me/.cache/ms-playwright/chromium-1200/chrome-linux/chrome",
    "/home/me/Library/Caches/ms-playwright/chromium-1200/chrome-mac/Chromium.app/Contents/MacOS/Chromium",
    "/base/ms-playwright/chromium-1200/chrome-win64/chrome.exe",
    "/home/me/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome",
    "/home/me/Library/Caches/ms-playwright/chromium-1200/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "/home/me/.cache/ms-playwright/chromium_headless_shell-1200/chrome-headless-shell-linux64/chrome-headless-shell",
    // PLAYWRIGHT_BROWSERS_PATH=0 — the same browser, with no `ms-playwright`
    "node_modules/playwright-core/.local-browsers/chromium-1200/chrome-linux/chrome",
    // The cases that only the current rule catches: the modern names, with no
    // revision directory above them. Every path above carries `chromium-1200`
    // (or `ms-playwright`), which is what gave those away to the old
    // `chrome.exe` / `headless_shell.exe` / `ms-playwright` rule — these do not.
    "vendor/chrome-linux64/icudtl.dat",
    "vendor/chrome-win64/icudtl.dat",
    "vendor/chrome-headless-shell-linux64/icudtl.dat",
    "vendor/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "vendor/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "vendor/Chromium.app/Contents/MacOS/Chromium",
    "vendor/chrome-linux/chrome",
    "vendor/headless_shell",
    // and the separators a Windows path arrives with
    "chromium-1200\\chrome-win\\chrome.exe",
  ];
  for (const p of artifacts) assert.equal(isBrowserArtifact(p), true, `should refuse: ${p}`);
});

test("isBrowserArtifact: everything else in a staged tree is not a browser", () => {
  const fine = [
    "package.json",
    "README.md",
    "src/browser-detect.mjs",
    "node_modules/playwright-core/package.json",
    "bin/package-portable.mjs",
    // playwright-core has a directory called `chromium` of its own. A match on
    // the bare name refused to package the real node_modules — witnessed by
    // running the script, not by reading the regex.
    "node_modules/playwright-core/lib/server/chromium/appIcon.png",
    "vendor/chromium/notes.md",
    // "chrome" as part of a longer name is not the browser
    "node_modules/chrome-devtools/notes.md",
    "docs/chromium-notes.md",
  ];
  for (const p of fine) assert.equal(isBrowserArtifact(p), false, `should ship: ${p}`);
});
