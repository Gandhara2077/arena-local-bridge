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
//
// Two layouts per revision, because Playwright moved from shipping its own
// Chromium to Chrome for Testing. Read out of the playwright-core actually
// installed here (1.63.0) — its EXECUTABLE_PATHS is:
//
//   linux-x64    ["chrome-linux64", "chrome"]
//   linux-arm64  ["chrome-linux-arm64", "chrome"]
//   mac-x64      ["chrome-mac-x64", "Google Chrome for Testing.app",
//                 "Contents", "MacOS", "Google Chrome for Testing"]
//   mac-arm64    ["chrome-mac-arm64", …same…]
//   win-x64      ["chrome-win64", "chrome.exe"]
//
// The second entry of each pair is the older layout — `chrome-linux`,
// `chrome-mac/Chromium.app`, `chrome-win` — which is what the same revision
// directory holds when an earlier Playwright downloaded it. Both are listed and
// `exists` decides; only one of them is ever there. macOS gets both
// architectures for the same reason.
function playwrightCache({ platform, env, homeDir, readdir }) {
  const root =
    platform === "win32"
      ? path.join(String(env.LOCALAPPDATA || path.join(homeDir, "AppData", "Local")), "ms-playwright")
      : platform === "darwin"
        ? path.join(homeDir, "Library", "Caches", "ms-playwright")
        : path.join(homeDir, ".cache", "ms-playwright");
  const layouts =
    platform === "win32"
      ? [
          ["chrome-win64", "chrome.exe"],
          ["chrome-win", "chrome.exe"],
        ]
      : platform === "darwin"
        ? [
            ["chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
            ["chrome-mac-x64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
            ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"],
          ]
        : [
            ["chrome-linux64", "chrome"],
            ["chrome-linux-arm64", "chrome"],
            ["chrome-linux", "chrome"],
          ];
  try {
    return readdir(root)
      .filter((name) => /^chromium(-\d+)?$/.test(String(name)))
      .sort()
      .reverse()
      .flatMap((dir) => layouts.map((layout) => path.join(root, dir, ...layout)));
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

// ── and refusing to ship one ────────────────────────────────────────────────
//
// The other half of the same knowledge. `bin/package-portable.mjs` has to
// recognise a browser in a staged tree, and the first version of that check was
// `/chrome\.exe$|headless_shell\.exe$|ms-playwright/` — which reads as "Windows
// only": measured against the layouts below it missed four of the nine, every
// one of them a non-`.exe` name outside the Playwright cache, including
// `node_modules/playwright-core/.local-browsers/`, where a browser installed
// with PLAYWRIGHT_BROWSERS_PATH=0 lives. So the match is on path segments,
// either separator, over the same layouts the detection above knows about.
const BROWSER_BINARY = /^(chrome|chromium|msedge|chrome-headless-shell|headless_shell|google chrome for testing)(\.exe)?$/i;
// Directories a browser install creates — never a file name, and never a bare
// `chrome` / `chromium`: playwright-core has `lib/server/chromium/` of its own,
// which a segment-wide match on the binary names above turns into a false
// refusal. What decides a browser install is the revision-numbered directory
// Playwright writes, or the layout directory inside it — including the
// `chrome-linux64` / `chrome-win64` / `chrome-mac-<arch>` + "Google Chrome for
// Testing.app" names Playwright uses since it moved off its own Chromium, and
// the older `chrome-linux` / `chrome-win` / `chrome-mac` + `Chromium.app` ones
// it still leaves on disk for earlier revisions.
const BROWSER_DIRECTORY =
  /^(ms-playwright|\.local-browsers|chrome-(win|win64|linux|linux64|linux-arm64|mac|mac-x64|mac-arm64)|chrome-headless-shell-[a-z0-9-]+|chromium([-_]?headless[_-]shell)?-\d+|(chromium|google chrome|google chrome for testing)\.app)$/i;

/**
 * Is this path part of a browser install — something the portable archive must
 * not contain (ADR 0005)? Accepts any path, relative or absolute. The binary
 * names only count as the file name; the directory names count anywhere on the
 * path, since the whole install directory is what makes the archive big.
 */
export function isBrowserArtifact(file) {
  const parts = String(file).replace(/\\/g, "/").split("/").filter(Boolean);
  if (!parts.length) return false;
  return BROWSER_BINARY.test(parts[parts.length - 1]) || parts.some((part) => BROWSER_DIRECTORY.test(part));
}
