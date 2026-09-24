#!/usr/bin/env node
// attach-session.mjs — append a prompt to an EXISTING arena.ai agent session
// using the logged-in bridge browser. Usage:
//   node bin/attach-session.mjs <arena-session-id> <prompt-file>
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadDotEnv, loadConfig } from "../src/config.mjs";
import { CredentialStore } from "../src/credentials.mjs";
import { Bridge } from "../src/bridge.mjs";
import { parseAgentOutput } from "../src/parser.mjs";
import { log } from "../src/util.mjs";
import { requireSecret } from "../src/secret.mjs";

const targetId = process.argv[2];
const promptFile = process.argv[3];
if (!targetId || !promptFile) {
  console.error("usage: node bin/attach-session.mjs <arena-session-id> <prompt-file>");
  process.exit(2);
}
const prompt = fs.readFileSync(promptFile, "utf8");
if (!prompt.trim()) {
  console.error("prompt file is empty");
  process.exit(2);
}

const dataDir = process.env.DATA_DIR || path.join(process.env.HOME || os.homedir(), ".arena-bridge");
const dotEnv = loadDotEnv(path.join(dataDir, ".env"));
const config = loadConfig({ ...dotEnv, ...process.env }, { requireBridgeKey: false });
const secret = requireSecret(dotEnv);
const credentials = new CredentialStore({
  filePath: config.credentialsFile,
  secret,
  omniDbPath: config.omniDbPath,
}).load();

const bridge = new Bridge({ config, credentials, recaptcha: null });
try {
  await bridge.start();
  const credential = credentials.primary();
  const page = await bridge.browser.getPage(credential.cookieHeader, credential.updatedAt);
  const state = {
    id: targetId,
    token: "",
    lastNodeId: null,
    requiresReview: false,
    toolsInitialized: false,
    updatedAt: Date.now(),
  };
  console.log(
    JSON.stringify({ event: "attach-start", session: targetId, account: credential.email, promptChars: prompt.length })
  );

  // 1) append the prompt as a new user message in the target session
  await bridge.appendAgentMessage(page, state, prompt);
  console.log(JSON.stringify({ event: "appended", tokenCaptured: Boolean(state.token) }));

  // 2) fallback: if no token captured, refresh it from the session page
  if (!state.token) {
    const refreshed = await bridge.refreshAgentToken(page, targetId).catch(() => "");
    if (refreshed) state.token = refreshed;
    console.log(JSON.stringify({ event: "token-refresh", tokenSet: Boolean(state.token) }));
  }

  // 3) read the assistant's reply SSE
  const raw = await bridge.readAgentOutput(page, state);
  fs.writeFileSync("/tmp/attach-reply-sse.txt", raw, { mode: 0o600 });
  const parsed = parseAgentOutput(raw);
  console.log(
    JSON.stringify({
      event: "reply",
      text: (parsed.text || "").slice(0, 4000),
      reasoning: (parsed.reasoning || "").slice(0, 600),
      lastNodeId: parsed.lastNodeId,
    })
  );
} catch (error) {
  console.log(JSON.stringify({ event: "error", message: error.message, stack: (error.stack || "").split("\n").slice(0, 4) }));
  process.exitCode = 1;
} finally {
  await bridge.browser.close().catch(() => undefined);
}
