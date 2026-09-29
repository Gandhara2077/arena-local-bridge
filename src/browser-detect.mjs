// browser-detect.mjs — find a Chromium-based browser that is already on this
// machine.
//
// The portable release ships no Chromium (ADR 0005): bundling Playwright's
// would take the download from ~80 MB to 350–700 MB, which is the difference
// between "unzip and double-click" and "no". So the browser is the user's own
// Chrome or Edge, and ARENA_AGENT_CHROME stays the manual entry for when we
// look in the wrong places.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Where Playwright keeps the browser it downloaded, if it ever did. The
// directory is revision-numbered, so it has to be listed rather than written
// down — newest first, since an old revision is the one most likely to be
// broken. Last in the order: a browser Playwright manages is the fallback, not
// the first choice.
function playwrightCache({ platform, env, homeDir, readdir }) {
  const root =
    platform === "win32"
      ? path.join(String(env.LOCALAPPDATA || path.join(homeDir, "AppData", "Local")), "ms-playwright")
      : platform === "darwin"
        ? path.join(homeDir, "Library", "Caches", "ms-playwright")
        : path.join(homeDir, ".cache", "ms-playwright");
  const exe =
    platform === "win32"
      ? ["chrome-win", "chrome.exe"]
      : platform === "darwin"
        ? ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"]
        : ["chrome-linux", "chrome"];
  try {
    return readdir(root)
      .filter((name) => /^chromium(-\d+)?$/.test(String(name)))
      .sort()
      .reverse()
      .map((dir) => path.join(root, dir, ...exe));
  } catch {
    return [];
  }
}

// Installed browsers, most-likely-to-be-the-user's-default first. Edge is
// listed at both program-file locations because on a 64-bit Windows it lands in
// "Program Files (x86)" — which is where this project found it.
function installed({ platform, env, homeDir }) {
  const join = (...parts) => path.join(...parts.filter(Boolean));
  if (platform === "win32") {
    const pf = env.ProgramFiles;
    const pf86 = env["ProgramFiles(x86)"];
    const local = env.LOCALAPPDATA;
    return [
      join(pf, "Google", "Chrome", "Application", "chrome.exe"),
      join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
      join(local, "Google", "Chrome", "Application", "chrome.exe"),
      join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
      join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
    ].filter(Boolean);
  }
  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      join(homeDir, "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
    ].filter(Boolean);
  }
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/microsoft-edge",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ];
}

/**
 * The first browser on this machine that really exists, or "" — plus every path
 * that was considered, so a failure can say what it looked for. `exists` and
 * `readdir` are injected, which is what makes the order and the fallback
 * testable without touching a disk.
 */
export function detectBrowser({
  platform = process.platform,
  env = process.env,
  homeDir = os.homedir(),
  exists = fs.existsSync,
  readdir = fs.readdirSync,
} = {}) {
  const tried = [...installed({ platform, env, homeDir }), ...playwrightCache({ platform, env, homeDir, readdir })];
  return { path: tried.find(exists) || "", tried };
}
