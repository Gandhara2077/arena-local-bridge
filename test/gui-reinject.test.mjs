// Run the shipped GUI script and its registered handlers. Only browser DOM and
// HTTP surfaces are doubled; no source-presence assertions or Arena traffic.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const HTML = fs.readFileSync(new URL("../src/gui.html", import.meta.url), "utf8");
const SESSION = "11111111-2222-4333-8444-555555555555";
const OTHER_SESSION = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const REFUSAL = { sessionId: SESSION, injected: false, pending: false, reason: "no workspace recognized", hint: "original recovery hint" };

async function openGui({ outcome = REFUSAL, candidates = [] } = {}) {
  const nodes = new Map();
  function element(attrs = "") {
    const listeners = new Map();
    const children = new Map();
    return {
      hidden: /\bhidden\b/.test(attrs), disabled: /\bdisabled\b/.test(attrs),
      value: "", textContent: "", innerHTML: "", dataset: {}, style: {}, options: [],
      classList: { add() {}, remove() {}, toggle() {} },
      querySelectorAll: () => [],
      querySelector(selector) {
        if (!children.has(selector)) children.set(selector, element());
        return children.get(selector);
      },
      addEventListener(event, handler) { listeners.set(event, handler); },
      replaceChildren(...options) { this.options = options; this.value = options[0]?.value || ""; },
      focus() {},
      async fire(event) {
        if (event === "click" && this.disabled) return;
        await listeners.get(event)?.({ type: event, target: this });
      },
    };
  }
  for (const match of HTML.split("<script>")[0].matchAll(/<\w+\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    nodes.set(match[2], element(match[1]));
  }
  const calls = [];
  let activeSession = SESSION;
  const context = vm.createContext({
    document: {
      querySelector: (selector) => nodes.get(selector.slice(1)) || null,
      querySelectorAll: () => [],
      getElementById: (id) => nodes.get(id) || null,
      createElement: () => element(),
      body: { appendChild: (node) => nodes.set(node.id, node) },
    },
    Option: class { constructor(text, value) { this.textContent = text; this.value = value; } },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    fetch: async (route, opts = {}) => {
      const body = opts.body ? JSON.parse(opts.body) : null;
      calls.push({ route, body, headers: opts.headers || {} });
      let data;
      if (route === "/api/mcp/reinject") {
        data = body?.workspace
          ? { sessionId: body.sessionId || activeSession, pending: true, injected: false, workspace: body.workspace }
          : outcome;
      } else if (route === "/api/mcp/workspaces") data = candidates;
      else if (route === "/api/mcp/status") data = { runtime: "local", installed: true, running: true, bridgeInjecting: true, url: "https://gui-test.trycloudflare.com/mcp", token: "gui-test-token" };
      else if (route === "/api/status") data = { apiKey: "gui-test-key", activeSession, origin: "http://127.0.0.1:20140", accounts: [] };
      else if (route === "/api/sessions") data = { sessions: [], groups: [] };
      else if (route === "/api/pool/bindings") data = { bindings: [] };
      else data = { installed: false, running: false, done: 0 };
      return { json: async () => data };
    },
  });
  vm.runInContext(HTML.match(/<script>([\s\S]*?)<\/script>/)[1], context, { filename: "gui.html" });
  await new Promise(setImmediate); // finish the GUI's initial read-only render
  calls.length = 0;
  return {
    get: (id) => nodes.get(id), calls,
    posts: () => calls.filter((c) => c.route === "/api/mcp/reinject"),
    setActive: (id) => { activeSession = id; },
    toast: () => nodes.get("toast")?.querySelector(".msg").textContent,
  };
}

test("a missing workspace offers candidates but retries only the explicitly selected workspace and original Session", async () => {
  const literalPath = "/projects/<img src=x onerror=alert(1)>";
  const gui = await openGui({ candidates: [
    { workspace: "/projects/A", lastWriteAt: "2026-09-30T00:00:02.000Z" },
    { workspace: literalPath, lastWriteAt: "2026-09-30T00:00:01.000Z" },
  ] });
  await gui.get("mcpReinject").fire("click");
  assert.equal(gui.get("mcpWorkspacePicker")?.hidden, false);
  const select = gui.get("mcpWorkspace");
  const confirm = gui.get("mcpWorkspaceConfirm");
  assert.equal(select.value, "", "the newest candidate is not selected automatically");
  assert.equal(confirm.disabled, true);
  assert.equal(select.options[2].textContent, literalPath, "a path is rendered as literal option text");
  assert.deepEqual(gui.posts().map((c) => c.body), [{}]);
  const listing = gui.calls.find((c) => c.route === "/api/mcp/workspaces");
  assert.equal(listing.headers.Authorization, "Bearer gui-test-key");

  await confirm.fire("click");
  assert.equal(gui.posts().length, 1);
  select.value = literalPath;
  await select.fire("change");
  assert.equal(confirm.disabled, false);
  assert.equal(gui.posts().length, 1, "selecting alone cannot arm the next turn");
  gui.setActive(OTHER_SESSION);
  await confirm.fire("click");
  assert.deepEqual(gui.posts().map((c) => c.body), [{}, { sessionId: SESSION, workspace: literalPath }]);
  assert.equal(gui.get("mcpWorkspacePicker").hidden, true);
});

test("cancel closes the workspace picker without retrying", async () => {
  const gui = await openGui({ candidates: [{ workspace: "/projects/A", lastWriteAt: "2026-09-30T00:00:00.000Z" }] });
  await gui.get("mcpReinject").fire("click");
  assert.equal(gui.get("mcpWorkspacePicker")?.hidden, false);
  gui.get("mcpWorkspace").value = "/projects/A";
  await gui.get("mcpWorkspace").fire("change");
  await gui.get("mcpWorkspaceCancel").fire("click");
  assert.equal(gui.get("mcpWorkspacePicker").hidden, true);
  assert.equal(gui.posts().length, 1);
});

test("no candidates keeps the existing refusal hint", async () => {
  const gui = await openGui();
  await gui.get("mcpReinject").fire("click");
  assert.equal(gui.get("mcpWorkspacePicker")?.hidden, true);
  assert.match(gui.toast(), /original recovery hint/);
  assert.equal(gui.posts().length, 1);
});

test("a pending injection, missing endpoint, or API error never offers workspace candidates", async () => {
  for (const outcome of [
    { pending: true, workspace: "/projects/A" },
    { pending: false, injected: false, reason: "no local endpoint is up", hint: "start MCP first" },
    { error: { message: "Invalid bridge key" } },
  ]) {
    const gui = await openGui({ outcome, candidates: [{ workspace: "/projects/A" }] });
    await gui.get("mcpReinject").fire("click");
    assert.notEqual(gui.get("mcpWorkspacePicker")?.hidden, false);
    assert.equal(gui.calls.filter((c) => c.route === "/api/mcp/workspaces").length, 0);
    assert.equal(gui.posts().length, 1);
  }
});
