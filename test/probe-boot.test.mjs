// Boots the assembled probe inside a stubbed browser and checks it comes up and
// exposes the API the project actually calls.
//
// This is the only check that exercises the whole module graph at once: a
// missing or mis-ordered module shows up here as a "module not found" throw or
// a missing API method. Everything else (byte comparison, lint) would pass even
// if the graph were broken.
//
// Timers are stubbed rather than scheduled — the probe arms an auto-backfill
// interval that would otherwise keep the test process alive.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { assembleProbe } from "../src/probe/assemble.mjs";

const noop = () => {};
const elem = () => ({
  id: "", style: {}, dataset: {}, children: [], textContent: "", innerHTML: "",
  appendChild: noop, removeChild: noop, remove: noop, setAttribute: noop, getAttribute: () => null,
  addEventListener: noop, removeEventListener: noop, querySelector: () => null, querySelectorAll: () => [],
  attachShadow: () => ({ innerHTML: "", appendChild: noop, querySelector: () => null, querySelectorAll: () => [] }),
  classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
});

function bootProbe() {
  const store = new Map();
  const sandbox = {
    console,
    performance: { now: () => Date.now() },
    setTimeout, clearTimeout,
    setInterval: () => 0, // see the note at the top of this file
    clearInterval: noop,
    queueMicrotask,
    URL, URLSearchParams, TextDecoder, TextEncoder, Blob, AbortController, Headers, Request, Response,
    crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000000", getRandomValues: (a) => a },
    XMLHttpRequest: class { open() {} send() {} setRequestHeader() {} abort() {} addEventListener() {} },
    WebSocket: class { constructor() { this.readyState = 0; } addEventListener() {} send() {} close() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    navigator: { userAgent: "Mozilla/5.0 (stub)", webdriver: false, language: "zh-CN", languages: ["zh-CN"] },
    location: { origin: "https://arena.ai", pathname: "/agent/01a0d398-a7ed-7b88-aea2-3f882f4b395c", href: "https://arena.ai/agent/x", hostname: "arena.ai" },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      clear: () => store.clear(),
    },
    document: {
      documentElement: elem(), head: elem(), body: elem(),
      createElement: () => elem(), getElementById: () => null,
      querySelector: () => null, querySelectorAll: () => [],
      addEventListener: noop, removeEventListener: noop, readyState: "complete",
    },
    fetch: async () => ({ ok: false, status: 0, json: async () => ({}), text: async () => "", headers: new Headers() }),
    addEventListener: noop, removeEventListener: noop, dispatchEvent: noop,
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(assembleProbe(), sandbox, { filename: "arena-model-probe.inject.js" });
  return sandbox;
}

test("拼装产物能在页面环境里启动，并暴露我们调用的接口", () => {
  const page = bootProbe();
  const api = page.window.__MODEL_PROBE__;
  assert.ok(api, "启动后 window.__MODEL_PROBE__ 不存在");

  for (const method of ["realModel", "pollRunModels", "runState", "desktopFacts", "reasoning", "usdQuotaSnapshot"]) {
    assert.equal(typeof api[method], "function", `接口 ${method} 缺失`);
  }

  // Calling them must not throw on an idle page.
  assert.doesNotThrow(() => api.runState());
  assert.doesNotThrow(() => api.desktopFacts());
  assert.doesNotThrow(() => api.usdQuotaSnapshot());
  assert.equal(api.usdQuotaSnapshot().status, "unavailable", "空闲页面上 USD 应报 unavailable");
});

test("启动过程不抛出 module not found", () => {
  assert.doesNotThrow(() => bootProbe());
});
