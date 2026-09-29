// The Local MCP server over REAL HTTP: the six promised tools, the JSON-RPC
// envelope, the bearer gate, and — the point of the whole effort — the
// ticket-11 path guard on every path-handling tool. Fixtures are mkdtemp
// trees; no network beyond loopback, no browser.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLocalMcpServer, execPlan } from "../src/local-mcp.mjs";

const TOKEN = "mcp-e2e-token";

let root, ws, skills, dataDir;
let server, url, port;

function rpc(method, params, { token = TOKEN, id = 1 } = {}) {
  return fetch(`${url}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
}

async function call(name, args) {
  const res = await rpc("tools/call", { name, arguments: args });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.jsonrpc, "2.0");
  return body.result;
}

const text = (result) => result.content[0].text;

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "local-mcp-"));
  ws = path.join(root, "workspace");
  skills = path.join(root, "skills");
  dataDir = path.join(root, "data");
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  fs.mkdirSync(skills, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(ws, "README.md"), "# demo workspace\n");
  fs.writeFileSync(path.join(ws, "src", "app.js"), "const x = searchme;\nconst y = 2;\n");
  fs.writeFileSync(path.join(ws, "notes.txt"), "hello world\n");
  fs.writeFileSync(path.join(skills, "some-skill.md"), "# a skill\n");
  fs.writeFileSync(path.join(dataDir, "credentials.json"), '{"secret":true}');

  server = createLocalMcpServer({
    token: TOKEN,
    roots: {
      workspaceRoots: [ws],
      readOnlyRoots: [skills],
      privateRoots: [dataDir],
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
  url = `http://127.0.0.1:${port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

describe("protocol surface", () => {
  test("initialize answers the server identity", async () => {
    const res = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /application\/json/);
    const body = await res.json();
    assert.equal(body.result.serverInfo.name, "arena-local-bridge");
    assert.equal(body.result.protocolVersion, "2025-03-26");
  });

  test("tools/list names exactly the six promised tools", async () => {
    const res = await rpc("tools/list", {});
    const body = await res.json();
    assert.deepEqual(
      body.result.tools.map((t) => t.name),
      ["read_file", "list_dir", "search_text", "file_edit", "exec_command", "file_publish"],
    );
  });

  test("a notification gets 202 and no body", async () => {
    const res = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    assert.equal(res.status, 202);
    assert.equal(await res.text(), "");
  });

  test("an unknown method is -32601", async () => {
    const res = await rpc("resources/list", {});
    const body = await res.json();
    assert.equal(body.error.code, -32601);
  });

  test("unparseable JSON is -32700 with HTTP 400", async () => {
    const res = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: "{not json",
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, -32700);
  });

  test("a missing or wrong bearer is 401 before anything else", async () => {
    const missing = await rpc("tools/list", {}, { token: "" });
    assert.equal(missing.status, 401);
    const wrong = await rpc("tools/list", {}, { token: "nope" });
    assert.equal(wrong.status, 401);
  });

  test("an unknown tool is -32602", async () => {
    const res = await rpc("tools/call", { name: "rm_rf_everything", arguments: {} });
    const body = await res.json();
    assert.equal(body.error.code, -32602);
  });

  test("any request carrying an Origin is 403 before auth is even read", async () => {
    const res = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, Origin: "http://evil.example" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    assert.equal(res.status, 403);
  });
});

describe("read_file / list_dir", () => {
  test("reads a workspace file", async () => {
    const result = await call("read_file", { path: path.join(ws, "README.md") });
    assert.match(text(result), /# demo workspace/);
    assert.ok(!result.isError);
  });

  test("honours start_line / end_line", async () => {
    const result = await call("read_file", { path: path.join(ws, "src", "app.js"), start_line: 2, end_line: 2 });
    assert.equal(text(result), "const y = 2;");
  });

  test("denies a path outside the workspace", async () => {
    const result = await call("read_file", { path: path.join(root, "outside.txt") });
    assert.ok(result.isError);
    assert.match(text(result), /outside the workspace/);
  });

  test("rejects a relative path", async () => {
    const result = await call("read_file", { path: "README.md" });
    assert.ok(result.isError);
    assert.match(text(result), /absolute/);
  });

  test("denies the data directory even when it sits inside the workspace", async () => {
    const inner = path.join(ws, "hidden-data");
    fs.mkdirSync(inner, { recursive: true });
    fs.writeFileSync(path.join(inner, "x.json"), "{}");
    const server2 = createLocalMcpServer({
      token: TOKEN,
      roots: { workspaceRoots: [ws], readOnlyRoots: [], privateRoots: [inner] },
    });
    await new Promise((resolve) => server2.listen(0, "127.0.0.1", resolve));
    try {
      const res = await fetch(`http://127.0.0.1:${server2.address().port}/mcp`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "read_file", arguments: { path: path.join(inner, "x.json") } } }),
      });
      const body = await res.json();
      assert.ok(body.result.isError);
      assert.match(body.result.content[0].text, /data directory/);
    } finally {
      await new Promise((resolve) => server2.close(resolve));
    }
  });

  test("list_dir lists files and directories with a depth cap", async () => {
    const result = await call("list_dir", { path: ws, max_depth: 2 });
    const listed = text(result);
    assert.match(listed, /README\.md/);
    assert.match(listed, /src\//);
    assert.match(listed, /src\/app\.js/);
    assert.ok(!listed.includes("notes.txt/"), "files must not get the directory suffix");
  });
});

describe("the read-only root (skills)", () => {
  test("reads are allowed and flagged read-only by the guard", async () => {
    const result = await call("read_file", { path: path.join(skills, "some-skill.md") });
    assert.match(text(result), /# a skill/);
  });

  test("writes are denied", async () => {
    const result = await call("file_edit", { action: "add", path: path.join(skills, "evil.md"), content: "no" });
    assert.ok(result.isError);
    assert.match(text(result), /read-only root/);
  });
});

describe("search_text (Node self-implementation)", () => {
  test("finds plain text across the workspace", async () => {
    const result = await call("search_text", { query: "searchme" });
    assert.match(text(result), /app\.js:1:/);
  });

  test("regex and case-insensitivity work", async () => {
    const regex = await call("search_text", { query: "x = search", regex: true });
    assert.match(text(regex), /app\.js/);
    const ci = await call("search_text", { query: "HELLO WORLD" });
    assert.match(text(ci), /notes\.txt:1:/);
  });

  test("the start path itself is guarded", async () => {
    const result = await call("search_text", { query: "secret", path: path.join(root, "elsewhere") });
    assert.ok(result.isError);
  });
});

describe("file_edit (add / replace)", () => {
  test("add creates a new file; add onto an existing path needs overwrite", async () => {
    const created = await call("file_edit", { action: "add", path: path.join(ws, "generated.md"), content: "content" });
    assert.match(text(created), /wrote/);
    assert.equal(fs.readFileSync(path.join(ws, "generated.md"), "utf8"), "content");

    const clash = await call("file_edit", { action: "add", path: path.join(ws, "generated.md"), content: "again" });
    assert.ok(clash.isError);
    assert.match(text(clash), /already exists/);

    await call("file_edit", { action: "add", path: path.join(ws, "generated.md"), content: "again", overwrite: true });
    assert.equal(fs.readFileSync(path.join(ws, "generated.md"), "utf8"), "again");

    // The write goes through a unique, exclusively-created temp file + rename:
    // no leftovers in the tree.
    const stray = fs.readdirSync(ws).filter((name) => name.includes(".mcp-tmp"));
    assert.deepEqual(stray, []);
  });

  test("file_edit never touches a user file that looks like our old temp name", async () => {
    // The old fixed `.mcp-tmp` suffix would clobber exactly this file.
    const lookalike = path.join(ws, "keepme.txt.mcp-tmp");
    fs.writeFileSync(lookalike, "user data", "utf8");
    await call("file_edit", { action: "add", path: path.join(ws, "keepme.txt"), content: "new" });
    assert.equal(fs.readFileSync(lookalike, "utf8"), "user data");
    assert.equal(fs.readFileSync(path.join(ws, "keepme.txt"), "utf8"), "new");
  });

  test("replace swaps exact text and enforces expected_matches", async () => {
    await call("file_edit", {
      action: "add", path: path.join(ws, "replace-me.txt"), content: "alpha beta alpha", overwrite: true,
    });
    const one = await call("file_edit", {
      action: "replace", path: path.join(ws, "replace-me.txt"), old: "beta", new: "gamma",
    });
    assert.match(text(one), /replaced 1/);
    assert.equal(fs.readFileSync(path.join(ws, "replace-me.txt"), "utf8"), "alpha gamma alpha");

    const mismatch = await call("file_edit", {
      action: "replace", path: path.join(ws, "replace-me.txt"), old: "alpha", new: "x", expected_matches: 1,
    });
    assert.ok(mismatch.isError);
    assert.match(text(mismatch), /found 2/);

    await call("file_edit", {
      action: "replace", path: path.join(ws, "replace-me.txt"), old: "alpha", new: "x", replace_all: true, expected_matches: 2,
    });
    assert.equal(fs.readFileSync(path.join(ws, "replace-me.txt"), "utf8"), "x gamma x");
  });

  test("replace treats `new` as literal text, not replacement patterns", async () => {
    // $& / $` / $' / $1 / $$ are String.replace expansion syntax; a code agent
    // putting dollars into a file must get exactly those bytes back out.
    const target = path.join(ws, "dollar.txt");
    await call("file_edit", { action: "add", path: target, content: "foo bar", overwrite: true });
    const replacement = "$&$`$'$1$$";
    await call("file_edit", { action: "replace", path: target, old: "foo", new: replacement });
    assert.equal(fs.readFileSync(target, "utf8"), `${replacement} bar`);

    await call("file_edit", { action: "replace", path: target, old: replacement, new: "foo", replace_all: true });
    assert.equal(fs.readFileSync(target, "utf8"), "foo bar");
  });
});

describe("exec_command (workspace cwd, free execution per ADR 0003)", () => {
  test("execPlan: defaults to the workspace root, clamps the caps", () => {
    const plan = execPlan({ timeout_ms: 9_999_999, max_output_bytes: 9_999_999 }, { workspaceRoots: [ws] });
    assert.equal(plan.cwd, ws);
    assert.equal(plan.timeoutMs, 600_000);
    assert.equal(plan.maxOutputBytes, 4_194_304);
  });

  test("execPlan: an explicit workdir wins; no workspace is an error", () => {
    assert.equal(execPlan({ workdir: "  " }, { workspaceRoots: [ws] }).cwd, ws);
    assert.throws(() => execPlan({}, { workspaceRoots: [] }), /no workspace configured/);
  });

  test("execPlan: negative caps fall back to the defaults instead of going negative", () => {
    const plan = execPlan({ timeout_ms: -1, max_output_bytes: -5 }, { workspaceRoots: [ws] });
    assert.equal(plan.timeoutMs, 120_000);
    assert.equal(plan.maxOutputBytes, 262_144);
  });

  test("exec_command's schema discloses its local-shell scope (ADR 0011)", async () => {
    const res = await rpc("tools/list", {});
    const body = await res.json();
    const exec = body.result.tools.find((t) => t.name === "exec_command");
    assert.match(exec.description, /FULL local-user permissions/);
    assert.match(exec.description, /does NOT restrict/);
  });

  test("ADR 0011 fixated: exec reaches what the file boundary denies", async () => {
    // The P1 the ticket-12 review found, settled as semantics rather than
    // "fixed": read_file may NOT read the data directory, exec_command can —
    // it is a local shell whose cwd is merely pinned to the workspace. This
    // test exists so the semantics cannot drift silently in either direction.
    // The path travels base64-encoded: Windows paths would need nested quotes
    // inside the shell argument, which cmd.exe does not allow.
    const probe = path.join(dataDir, "exec-probe.txt");
    fs.writeFileSync(probe, "outside the file boundary");
    const encoded = Buffer.from(probe).toString("base64");
    const result = await call("exec_command", {
      cmd: `"${process.execPath}" -p "require('fs').readFileSync(Buffer.from('${encoded}', 'base64').toString(), 'utf8')"`,
    });
    assert.ok(!result.isError, text(result));
    assert.match(text(result), /outside the file boundary/);
  });

  test("runs with the workspace as cwd", async () => {
    const result = await call("exec_command", {
      // Quoted expression: unquoted parens are syntax errors under /bin/sh.
      cmd: `"${process.execPath}" -p "process.cwd()"`,
      workdir: ws,
    });
    assert.ok(!result.isError);
    assert.ok(text(result).includes(path.resolve(ws)), text(result));
  });

  test("defaults the cwd to the workspace root when workdir is omitted", async () => {
    const result = await call("exec_command", { cmd: `"${process.execPath}" -p "process.cwd()"` });
    assert.ok(text(result).includes(path.resolve(ws)), text(result));
  });

  test("a workdir outside the workspace is denied", async () => {
    const result = await call("exec_command", { cmd: "echo hi", workdir: root });
    assert.ok(result.isError);
    assert.match(text(result), /outside the workspace/);
  });

  test("timeout kills the command and says so", async () => {
    const result = await call("exec_command", {
      cmd: `"${process.execPath}" -e "setTimeout(()=>{}, 30000)"`,
      timeout_ms: 500,
    });
    assert.match(text(result), /timed out/);
  }, 15_000);
});

describe("file_publish", () => {
  test("copies a workspace file into the data directory's published folder", async () => {
    const result = await call("file_publish", { path: path.join(ws, "generated.md") });
    const published = text(result).replace("published to ", "").trim();
    assert.ok(published.startsWith(path.join(dataDir, "published")), text(result));
    assert.equal(fs.readFileSync(published, "utf8"), "again");
  });

  test("the source must still be inside the workspace", async () => {
    const result = await call("file_publish", { path: path.join(dataDir, "credentials.json") });
    assert.ok(result.isError);
  });
});
