// Ticket 25: the smoke has to exercise the path real requests take, and when the
// create path is refused it has to say WHAT was refused — a bare
// `403 recaptcha validation failed` cannot separate "reCAPTCHA scored the
// automated browser low" from "the composer never rendered" or "the proxy was not
// in effect". These tests drive the exported helpers with a fake page and a fake
// bridge: no browser, no network, no credentials.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classifyTurn, converseOnce, createSessionAndSettle, diagnoseComposeFailure, EXPECTED } from "../bin/selftest.mjs";

/** A page that answers only the two questions the diagnostic asks. */
function fakePage({ url = "https://arena.ai/agent", composerEditors = 1, dead = false } = {}) {
  return {
    url: () => {
      if (dead) throw new Error("page has been closed");
      return url;
    },
    evaluate: async () => {
      if (dead) throw new Error("page has been closed");
      return composerEditors;
    },
  };
}

function recaptcha403() {
  return Object.assign(new Error('Arena Agent composer failed: 403 {"error":"recaptcha validation failed"}'), {
    status: 403,
  });
}

function composeFailure() {
  return Object.assign(new Error("Arena Agent composer failed: 500 upstream exploded"), { status: 500 });
}

/** Run `fn` with the named env vars set (or removed, when the value is undefined). */
async function withEnv(vars, fn) {
  const saved = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

describe("diagnoseComposeFailure (ticket 25)", () => {
  test("a 403 naming reCAPTCHA is reported as kind=recaptcha, with the status", async () => {
    const diag = await diagnoseComposeFailure(fakePage(), recaptcha403());
    assert.equal(diag.kind, "recaptcha");
    assert.equal(diag.status, 403);
    assert.match(diag.message, /recaptcha validation failed/);
  });

  test("any other compose failure is kind=compose, so 'try again' is not implied", async () => {
    const diag = await diagnoseComposeFailure(fakePage(), composeFailure());
    assert.equal(diag.kind, "compose");
    assert.equal(diag.status, 500);
  });

  test("it reports what the page actually looked like", async () => {
    const diag = await diagnoseComposeFailure(
      fakePage({ url: "https://arena.ai/agent/abc", composerEditors: 0 }),
      recaptcha403()
    );
    assert.equal(diag.pageUrl, "https://arena.ai/agent/abc");
    assert.equal(diag.composerEditors, 0, "a composer that never rendered is the whole point of probing");
  });

  test("a dead page does not replace the original error with one about the diagnostics", async () => {
    const diag = await diagnoseComposeFailure(fakePage({ dead: true }), recaptcha403());
    assert.equal(diag.kind, "recaptcha", "the original error must survive");
    assert.equal(diag.pageUrl, "");
    assert.equal(diag.composerEditors, null);
  });

  test("the proxy reported is the one the BROWSER got, not whatever the shell exports", async () => {
    // The ordinary setup keeps the proxy in DATA_DIR/.env, which loadConfig folds
    // in while process.env never sees it. Reporting process.env would say "unset"
    // for exactly the setups where the answer matters.
    await withEnv({ ARENA_HEADED: undefined, ARENA_AGENT_PROXY: undefined }, async () => {
      const off = await diagnoseComposeFailure(fakePage(), recaptcha403());
      assert.equal(off.headed, false);
      assert.equal(off.proxy, "unset");
    });
    await withEnv({ ARENA_HEADED: "1" }, async () => {
      const on = await diagnoseComposeFailure(fakePage(), recaptcha403(), { proxy: "http://127.0.0.1:7897" });
      assert.equal(on.headed, true);
      assert.equal(on.proxy, "set");
    });
    // …and the environment alone must NOT flip it: that was the bug.
    await withEnv({ ARENA_AGENT_PROXY: "http://127.0.0.1:7897" }, async () => {
      const envOnly = await diagnoseComposeFailure(fakePage(), recaptcha403());
      assert.equal(envOnly.proxy, "unset", "process.env is not what the browser was handed");
    });
  });
});

describe("classifyTurn (ticket 25)", () => {
  test("a reCAPTCHA refusal is told apart from a transport failure", () => {
    assert.equal(classifyTurn({ error: recaptcha403() }), "recaptcha");
    assert.equal(classifyTurn({ error: new Error("net::ERR_CONNECTION_RESET") }), "transport");
  });

  test("a turn that produced no answer is not judged as a wrong answer", () => {
    // An unusable Session id lands here: nothing threw, but nothing came back.
    assert.equal(classifyTurn({ text: "" }), "no-answer");
    assert.equal(classifyTurn({ text: "   \n " }), "no-answer");
  });

  test("a real answer is judged on its content", () => {
    assert.equal(classifyTurn({ text: EXPECTED }), "ok");
    assert.equal(classifyTurn({ text: `sure\n\n${EXPECTED}\n` }), "ok");
    assert.equal(classifyTurn({ text: "I cannot do that." }), "mismatch");
  });

  test("the expected token is matched literally, not as a pattern", () => {
    assert.equal(classifyTurn({ text: "BRIDGE_OKX", expected: "BRIDGE_OK" }), "ok");
    assert.equal(classifyTurn({ text: "BRIDGE-OK", expected: "BRIDGE_OK" }), "mismatch");
  });
});

describe("createSessionAndSettle (PR #20 review)", () => {
  test("it consumes the first turn before returning, so the converse round cannot race it", async () => {
    // createAgentSession() resolves as soon as the Session exists — the turn it
    // started is still running. Appending the next message then would drive a
    // composer that is still generating, which no real request ever does: both
    // production callers (runAgent, recoverFromDuplicate) settle first. This
    // asserts the order, because the order IS the fix.
    const order = [];
    const bridge = {
      createAgentSession: async () => {
        order.push("create");
        return { id: "s-1" };
      },
      readAgentOutput: async (page, state) => {
        order.push(`read:${state.id}`);
        return "the first turn's text";
      },
    };
    const state = await createSessionAndSettle(bridge, {}, "hello");
    assert.deepEqual(order, ["create", "read:s-1"], "settling the first turn is the whole point");
    assert.equal(state.id, "s-1");
  });

  test("a failure while settling propagates, so the caller can diagnose that step", async () => {
    const bridge = {
      createAgentSession: async () => ({ id: "s-1" }),
      readAgentOutput: async () => {
        throw Object.assign(new Error("Arena Agent output failed: 403"), { status: 403 });
      },
    };
    await assert.rejects(() => createSessionAndSettle(bridge, {}, "hello"), /403/);
  });
});

describe("converseOnce (ticket 25)", () => {
  test("it drives the real turn path and returns the reply text", async () => {
    const calls = [];
    const bridge = {
      converse: async (sessionId, body, options) => {
        calls.push({ sessionId, body, options });
        return { choices: [{ index: 0, message: { role: "assistant", content: EXPECTED } }] };
      },
    };
    const text = await converseOnce(bridge, "11111111-2222-4333-8444-555555555555", `Reply with exactly: ${EXPECTED}`);
    assert.equal(text, EXPECTED);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.model, calls[0].sessionId, "the Session id is the model, as converse expects");
    assert.equal(calls[0].body.messages.at(-1).content, `Reply with exactly: ${EXPECTED}`);
    assert.equal(calls[0].options.injectMcp, false, "the smoke must not depend on the MCP preamble's wording");
  });

  test("a completion with no choices yields an empty string rather than throwing", async () => {
    const text = await converseOnce({ converse: async () => ({}) }, "session", "prompt");
    assert.equal(text, "");
  });
});
