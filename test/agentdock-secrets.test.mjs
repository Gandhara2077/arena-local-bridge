// Ticket 11's relocation half: the two credential-bearing files live ONLY in
// the data directory. The install dir is a third-party tree — nothing of ours
// lands there any more, and legacy copies left by older versions are ignored,
// never read as a fallback.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AgentDockManager,
  readEndpointFile,
  readOrCreateToken,
  tokenFilePath,
  writeSecretFile,
} from "../src/agentdock.mjs";

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentdock-secrets-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("the two credential files derive their location from the data directory", (t) => {
  test("the token file lives in the data directory, never the install dir", (t) => {
    const install = tmp(t);
    const data = tmp(t);
    assert.equal(tokenFilePath(data), path.join(data, "auth-token.txt"));
    assert.ok(tokenFilePath(data).startsWith(data));
    assert.ok(!tokenFilePath(data).startsWith(install));
  });

  test("an empty data directory yields NO file path — no third-party fallback", (t) => {
    assert.equal(tokenFilePath(""), "");
    assert.equal(tokenFilePath(undefined), "");
  });

  test("a manager's endpoint and token locations both avoid the install dir", (t) => {
    const install = tmp(t);
    const data = tmp(t);
    const manager = new AgentDockManager({
      dir: install,
      dataDir: data,
      endpointFile: path.join(data, "mcp-endpoint.json"),
    });
    assert.equal(manager.endpointFile, path.join(data, "mcp-endpoint.json"));
    assert.equal(tokenFilePath(manager.dataDir), path.join(data, "auth-token.txt"));
    // The install dir must not appear in either derived location.
    assert.ok(!manager.endpointFile.startsWith(install));
    assert.ok(!tokenFilePath(manager.dataDir).startsWith(install));
  });
});

describe("token persistence", (t) => {
  test("generates once, then stays stable across calls", (t) => {
    const data = tmp(t);
    const file = tokenFilePath(data);
    const first = readOrCreateToken(file);
    assert.ok(first.length >= 32);
    assert.equal(fs.existsSync(file), true);
    assert.equal(fs.readFileSync(file, "utf8").trim(), first);
    assert.equal(readOrCreateToken(file), first, "a second call must reuse the stored token");
  });

  test("with no file path, a token is generated in memory only", (t) => {
    const token = readOrCreateToken("");
    assert.ok(token.length >= 32);
    // Nothing to assert on disk — that is the point.
  });
});

describe("endpoint file: one location, one truth, no fallback", (t) => {
  test("write then read round-trips through the data-directory file", (t) => {
    const data = tmp(t);
    const file = path.join(data, "mcp-endpoint.json");
    writeSecretFile(file, JSON.stringify({ url: "https://x.trycloudflare.com/mcp", token: "t" }));
    const endpoint = readEndpointFile(file);
    assert.equal(endpoint.url, "https://x.trycloudflare.com/mcp");
    assert.equal(endpoint.token, "t");
  });

  test("a missing or empty file reads as null — there is no second location to fall back to", (t) => {
    const data = tmp(t);
    assert.equal(readEndpointFile(path.join(data, "absent.json")), null);
    assert.equal(readEndpointFile(""), null);
  });
});

describe("legacy files in the install dir are ignored, not adopted", (t) => {
  test("a fresh run in the same install dir does not read or rewrite them", (t) => {
    const install = tmp(t);
    const data = tmp(t);
    // What an older version left behind.
    const legacyToken = path.join(install, "auth-token.txt");
    const legacyEndpoint = path.join(install, "mcp-endpoint.json");
    fs.writeFileSync(legacyToken, "legacy-token");
    fs.writeFileSync(legacyEndpoint, JSON.stringify({ url: "https://legacy.example/mcp", token: "legacy" }));

    const manager = new AgentDockManager({
      dir: install,
      dataDir: data,
      endpointFile: path.join(data, "mcp-endpoint.json"),
    });
    // The new token and endpoint writes go to the data directory…
    const token = readOrCreateToken(tokenFilePath(manager.dataDir));
    assert.notEqual(token, "legacy-token", "a legacy install-dir token must not be adopted");
    assert.equal(fs.existsSync(path.join(data, "auth-token.txt")), true);
    assert.equal(readEndpointFile(manager.endpointFile), null, "a legacy install-dir endpoint must not leak into the data-dir read");
    // …and the install dir holds exactly what it held before: legacy residue,
    // untouched (ignored, not migrated, not cleaned).
    assert.deepEqual(
      fs.readdirSync(install).sort(),
      ["auth-token.txt", "mcp-endpoint.json"],
    );
    assert.equal(fs.readFileSync(legacyToken, "utf8"), "legacy-token");
  });
});
