#!/usr/bin/env node
// warp-setup.mjs — register a FREE Cloudflare WARP account (pure Node) and
// write a wireproxy config that exposes a SOCKS5 proxy on 127.0.0.1:40000.
// The proxy is used by the arena-bridge to avoid Cloudflare challenges when
// automating arena.ai (same technique the official 1.1.1.1 clients use).
//
//   node bin/warp-setup.mjs [--out wireproxy.conf] [--port 40000] [--endpoint 162.159.192.3:2408]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { log } from "../src/util.mjs";

const REG_URL = "https://api.cloudflareclient.com/v0a2159/reg";

function getArg(flag, def = "") {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] || def : def;
}

/** Generate an X25519 keypair and return WireGuard-style base64 keys. */
function generateWgKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
  // Raw 32-byte scalars live at the end of the DER encodings.
  return {
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32).toString("base64"),
    publicKey: publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64"),
  };
}

async function register(publicKey) {
  const body = JSON.stringify({
    key: publicKey,
    install_id: "",
    fcm_token: "",
    referrer: "",
    warp_enabled: true,
    tos: "2020-06-12T00:00:00.000Z",
  });
  for (let attempt = 1; attempt <= 3; attempt++) {
    const response = await fetch(REG_URL, {
      method: "POST",
      headers: { "User-Agent": "okhttp/3.12.1", "Content-Type": "application/json" },
      body,
    });
    let data;
    try {
      data = await response.json();
    } catch {
      data = { config: null, errors: [{ message: "non-JSON response" }] };
    }
    const config = data?.config;
    if (response.ok && config?.interface?.addresses?.v4) {
      return {
        accountId: data.account?.id || data.id,
        clientId: config.client_id,
        addressV4: config.interface.addresses.v4,
        addressV6: config.interface.addresses.v6,
        peerPublicKey: config.peers?.[0]?.public_key,
        peerEndpoint: config.peers?.[0]?.endpoint?.host || "engage.cloudflareclient.com:2408",
      };
    }

    const errMsg = data?.errors?.map((error) => error.message).join("; ") || `HTTP ${response.status}`;
    const limited = response.status === 429 || /ratelimit|too many/i.test(errMsg);
    if (limited && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 3000 * attempt));
      continue;
    }
    throw new Error(`WARP registration failed: ${errMsg}`);
  }
}

async function main() {
  const outPath = getArg("--out", path.join(os.homedir(), ".warp", "wireproxy.conf"));
  const socksPort = getArg("--port", "40000");
  const endpointOverride = getArg("--endpoint", "");

  fs.mkdirSync(path.dirname(outPath), { recursive: true, mode: 0o700 });
  log.info("warp", "registering free Cloudflare WARP account (pure Node)");

  const keys = generateWgKeys();
  const reg = await register(keys.publicKey);

  const endpoint = endpointOverride || reg.peerEndpoint;
  const conf = [
    "[Interface]",
    `Address = ${reg.addressV4}/32`,
    `PrivateKey = ${keys.privateKey}`,
    "DNS = 1.1.1.1",
    "MTU = 1280",
    "",
    "[Peer]",
    `PublicKey = ${reg.peerPublicKey}`,
    `Endpoint = ${endpoint}`,
    "AllowedIPs = 0.0.0.0/0",
    "",
    "[Socks5]",
    `BindAddress = 127.0.0.1:${socksPort}`,
    "",
  ].join("\n");

  fs.writeFileSync(outPath, conf, { mode: 0o600 });
  log.info("warp", "registration OK + config written", {
    out: outPath,
    socks5: `127.0.0.1:${socksPort}`,
    accountId: reg.accountId,
    clientId: reg.clientId,
    addressV4: reg.addressV4,
    peerEndpoint: endpoint,
  });
}

main().catch((error) => {
  log.error("warp", error.message);
  process.exit(1);
});
