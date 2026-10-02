import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

test("fingerprint reprobe displays the server's failure reason", async () => {
  const html = fs.readFileSync(new URL("../src/gui.html", import.meta.url), "utf8");
  const source = html.slice(html.indexOf("async function reprobeSession("), html.indexOf("async function deleteSessions("));
  for (const error of ["no labelled usable replies collected yet", { message: "turn died" }]) {
    const messages = [];
    const context = vm.createContext({
      mcpApi: async (url) => url.endsWith("/fingerprint-reprobe") ? { ok: false, error } : { ok: false, unresolved: true },
      toast: (message) => messages.push(message),
      render: async () => {},
    });
    vm.runInContext(source, context);
    const button = { dataset: { sid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }, innerHTML: "补标", disabled: false };
    await context.reprobeSession(button);
    assert.equal(messages.at(-1), "补标失败：" + (typeof error === "string" ? error : error.message));
    assert.equal(button.disabled, false);
  }
});
