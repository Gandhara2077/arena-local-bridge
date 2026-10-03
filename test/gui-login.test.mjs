// Execute the shipped GUI script and submit its real form handler. DOM and HTTP
// are the browser boundary doubles; no credential or Arena traffic is involved.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const HTML = fs.readFileSync(new URL("../src/gui.html", import.meta.url), "utf8");

async function openGui({ fail = false } = {}) {
  const nodes = new Map();
  const element = () => {
    const listeners = new Map();
    return {
      value: "", textContent: "", innerHTML: "", disabled: false, hidden: false, dataset: {}, style: {},
      classList: { add() {}, remove() {}, toggle() {} }, querySelectorAll: () => [],
      addEventListener: (event, handler) => listeners.set(event, handler),
      async fire(event) { await listeners.get(event)?.({ preventDefault() {}, target: this }); },
    };
  };
  for (const match of HTML.split("<script>")[0].matchAll(/\bid="([^"]+)"/g)) nodes.set(match[1], element());
  const calls = [];
  let accounts = [];
  const context = vm.createContext({
    document: {
      querySelector: (selector) => nodes.get(selector.slice(1)) || null,
      querySelectorAll: () => [], createElement: element,
      body: { appendChild: (node) => nodes.set(node.id, node) },
    },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    fetch: async (route, opts = {}) => {
      const body = opts.body ? JSON.parse(opts.body) : null;
      calls.push({ route, body, headers: opts.headers || {} });
      let data;
      if (route === "/api/accounts/login") {
        if (fail) data = { ok: false, error: { message: "Check your account and browser." } };
        else { accounts = [{ email: body.email, priority: 1 }]; data = { ok: true, account: { email: body.email } }; }
      } else if (route === "/api/status") data = { apiKey: "gui-test-key", origin: "http://127.0.0.1:20140", accounts };
      else if (route === "/api/sessions") data = { sessions: [], groups: [] };
      else data = { installed: false, running: false, done: 0 };
      return { json: async () => data };
    },
  });
  vm.runInContext(HTML.match(/<script>([\s\S]*?)<\/script>/)[1], context, { filename: "gui.html" });
  await new Promise(setImmediate);
  calls.length = 0;
  return { get: (id) => nodes.get(id), calls };
}

test("the first-run form submits with the local bridge key and clears the password after login", async () => {
  const gui = await openGui();
  assert.ok(gui.get("accountLoginForm"), "the first-run login form must exist");
  gui.get("accountEmail").value = " first@test.local ";
  gui.get("accountPassword").value = " synthetic password ";
  await gui.get("accountLoginForm").fire("submit");
  const login = gui.calls.find((call) => call.route === "/api/accounts/login");
  assert.ok(login, "submitting the form must call the login route");
  assert.equal(login.headers.Authorization, "Bearer gui-test-key");
  assert.deepEqual(login.body, { email: "first@test.local", password: " synthetic password " });
  assert.equal(gui.get("accountPassword").value, "");
  assert.equal(gui.get("accountLogin").disabled, false);
  assert.match(gui.get("accounts").innerHTML, /first@test\.local/);
});

test("a failed first-run form submission shows the server recovery message and allows retry", async () => {
  const gui = await openGui({ fail: true });
  assert.ok(gui.get("accountLoginForm"), "the first-run login form must exist");
  gui.get("accountEmail").value = "first@test.local";
  gui.get("accountPassword").value = "synthetic password";
  await gui.get("accountLoginForm").fire("submit");
  assert.match(gui.get("accountLoginStatus").textContent, /Check your account and browser/);
  assert.equal(gui.get("accountPassword").value, "");
  assert.equal(gui.get("accountLogin").disabled, false);
});
