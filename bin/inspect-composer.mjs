#!/usr/bin/env node
// inspect-composer.mjs — list all editable elements / buttons / modals on the
// target session page so we can find the right composer selector.
import os from "node:os";
import path from "node:path";
import { loadDotEnv, loadConfig } from "../src/config.mjs";
import { CredentialStore } from "../src/credentials.mjs";
import { ArenaBrowser } from "../src/arena-login.mjs";
import { requireSecret } from "../src/secret.mjs";

const targetId = process.argv[2] || "019fbd7d-a049-72d3-b938-22f200757509";
const dataDir = process.env.DATA_DIR || path.join(process.env.HOME || os.homedir(), ".arena-bridge");
const dotEnv = loadDotEnv(path.join(dataDir, ".env"));
const config = loadConfig({ ...dotEnv, ...process.env }, { requireBridgeKey: false });
const secret = requireSecret(dotEnv);
const credentials = new CredentialStore({ filePath: config.credentialsFile, secret, omniDbPath: config.omniDbPath }).load();
const credential = credentials.primary();

const browser = new ArenaBrowser({ omniRoot: config.omniRoot, chromePath: config.chromePath, proxy: config.proxy });
try {
  const page = await browser.getPage(credential.cookieHeader, credential.updatedAt);
  await page.goto(`https://arena.ai/agent/${targetId}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(5_000);
  // dismiss cookies if present
  const accept = page.getByRole("button", { name: "Accept Cookies" });
  if (await accept.count()) await accept.click().catch(() => undefined);

  const info = await page.evaluate(() => {
    const editable = [...document.querySelectorAll('[contenteditable="true"], textarea')].map((el, i) => ({
      i,
      tag: el.tagName,
      editable: el.getAttribute("contenteditable"),
      placeholder: el.getAttribute("placeholder") || el.getAttribute("data-placeholder") || "",
      cls: (el.className || "").toString().slice(0, 80),
      visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
    }));
    const buttons = [...document.querySelectorAll("button")].map((b) => (b.innerText || b.getAttribute("aria-label") || "").trim().slice(0, 40)).filter(Boolean).slice(0, 40);
    const modals = [...document.querySelectorAll('[role="dialog"], [class*="modal" i]')].map((m) => (m.innerText || "").slice(0, 120));
    const bodyText = (document.body?.innerText || "").slice(-800);
    return { editable, buttons, modals, bodyText };
  });
  console.log(JSON.stringify({ event: "inspect", targetId, ...info }, null, 1));
} catch (error) {
  console.log(JSON.stringify({ event: "error", message: error.message, stack: (error.stack || "").split("\n").slice(0, 4) }));
  process.exitCode = 1;
} finally {
  await browser.close().catch(() => undefined);
}
