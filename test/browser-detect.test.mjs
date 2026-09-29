// ADR 0005 — the portable release ships no Chromium, so finding the browser the
// user already has decides whether the thing starts at all. The order and the
// "nothing there" fallback are what matter, and both are asserted with the disk
// swapped out.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { detectBrowser } from "../src/browser-detect.mjs";

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
  assert.equal(cache.length, 2, "non-chromium entries are ignored");
  assert.ok(cache[0].includes("chromium-1200"));
  assert.ok(cache[0].endsWith(path.join("chrome-win", "chrome.exe")));
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
