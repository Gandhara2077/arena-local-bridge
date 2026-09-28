// The quick-tunnel URL is a credential: anyone holding it (plus the token) can
// read and write this machine's workspace. It must never land in a log verbatim
// — logs accumulate all day and get pasted into bug reports.
import { test } from "node:test";
import assert from "node:assert/strict";
import { maskTunnelUrl } from "../src/util.mjs";

const FULL = "https://a1b2c3d4e5f6.trycloudflare.com/mcp";

test("maskTunnelUrl: hides the random subdomain, keeps the service domain", () => {
  const masked = maskTunnelUrl(FULL);
  assert.ok(!masked.includes("a1b2c3d4e5f6"), `still leaked the subdomain: ${masked}`);
  assert.ok(masked.includes("trycloudflare.com"), "排障时仍要能看出是哪条隧道");
});

test("maskTunnelUrl: keeps the scheme and path so the log stays useful", () => {
  const masked = maskTunnelUrl(FULL);
  assert.ok(masked.startsWith("https://"));
  assert.ok(masked.endsWith("/mcp"));
});

test("maskTunnelUrl: a non-secret URL is left alone", () => {
  assert.equal(maskTunnelUrl("http://127.0.0.1:20140/mcp"), "http://127.0.0.1:20140/mcp");
  assert.equal(maskTunnelUrl("http://[::1]:20140/mcp"), "http://[::1]:20140/mcp");
  assert.equal(maskTunnelUrl("http://localhost:8765/mcp"), "http://localhost:8765/mcp");
});

test("maskTunnelUrl: empty or malformed input does not throw", () => {
  assert.doesNotThrow(() => maskTunnelUrl(""));
  assert.doesNotThrow(() => maskTunnelUrl("not a url"));
  assert.doesNotThrow(() => maskTunnelUrl(undefined));
});
