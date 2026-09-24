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

function b64(buf) {
  return Buffer.from(buf).toString("base64");
}

/** Generate an X25519 keypair and return WireGuard-style base64 keys. */
function generateWgKeys() {
  const { generateKeyPairSync } = crypto;
  const kp = generateKeyPairSync("x25519");
  // Raw 32-byte scalars live at the end of the DER encodings.
  const pubRaw = kp.publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  const privRaw = kp.privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32);
  return { privateKey: b64(privRaw), publicKey: b64(pubRaw) };
}

async function register(publicKey, attempt = 1) {
  const body = {
    key: publicKey,
    install_id: "",
    fcm_token: "",
    referrer: "",
    warp_enabled: true,
    tos: "2020-06-12T00:00:00.000Z",
  };
  const res = await fetch(REG_URL, {
    method: "POST",
    headers: { "User-Agent": "okhttp/3.12.1", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data;
  try {
    data = await res.json();
  } catch {
    data = { config: null, errors: [{ message: "non-JSON response" }] };
  }
  const cfg = data?.config;
  if (!res.ok || !cfg?.interface?.addresses?.v4) {
    const errMsg = data?.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}`;
    if (attempt < 3 && (res.status === 429 || /ratelimit|too many/i.test(errMsg))) {
      await new Promise((r) => setTimeout(r, 3000 * attempt));
      return register(publicKey, attempt + 1);
    }
    throw new Error(`WARP registration failed: ${errMsg}`);
  }
  return {
    accountId: data.account?.id || data.id,
    clientId: cfg.client_id,
    addressV4: cfg.interface.addresses.v4,
    addressV6: cfg.interface.addresses.v6,
    peerPublicKey: cfg.peers?.[0]?.public_key,
    peerEndpoint: cfg.peers?.[0]?.endpoint?.host || "engage.cloudflareclient.com:2408",
  };
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
