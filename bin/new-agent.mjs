#!/usr/bin/env node
// new-agent.mjs — create a BRAND-NEW arena.ai agent chat seeded with a prompt.
// Usage:
//   node bin/new-agent.mjs <prompt-file> [--label "name"]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadDotEnv, loadConfig } from "../src/config.mjs";
import { CredentialStore } from "../src/credentials.mjs";
import { Bridge } from "../src/bridge.mjs";
import { parseAgentOutput } from "../src/parser.mjs";
import { log } from "../src/util.mjs";
import { requireSecret } from "../src/secret.mjs";

const promptFile = process.argv[2];
const labelIdx = process.argv.indexOf("--label");
const label = labelIdx >= 0 ? process.argv[labelIdx + 1] || "" : "";
if (!promptFile) {
  console.error("usage: node bin/new-agent.mjs <prompt-file> [--label name]");
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

  console.log(
    JSON.stringify({ event: "create-start", account: credential.email, label, promptChars: prompt.length })
  );

  // Create a brand-new Agent session whose first message is the team-leader prompt.
  const state = await bridge.createAgentSession(page, prompt);
  console.log(JSON.stringify({ event: "created", sessionId: state.id, url: `https://arena.ai/agent/${state.id}` }));

  // Read the initial reply (the agent acknowledges and waits for commands).
  try {
    const raw = await bridge.readAgentOutput(page, state);
    fs.writeFileSync("/tmp/new-agent-reply-sse.txt", raw, { mode: 0o600 });
    const parsed = parseAgentOutput(raw);
    console.log(
      JSON.stringify({
        event: "initial-reply",
        sessionId: state.id,
        text: (parsed.text || "").slice(0, 3000),
        nativeTools: [...new Set(parsed.nativeCalls.map((c) => c.name))].join(",") || null,
      })
    );
  } catch (error) {
    console.log(JSON.stringify({ event: "reply-timeout", sessionId: state.id, note: "agent still working; chat is live", error: error.message.slice(0, 200) }));
  }
} catch (error) {
  console.log(JSON.stringify({ event: "error", message: error.message, stack: (error.stack || "").split("\n").slice(0, 5) }));
  process.exitCode = 1;
} finally {
  await bridge.browser.close().catch(() => undefined);
}
