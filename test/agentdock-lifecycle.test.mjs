// A real lifecycle test for the spawn pattern agentdock uses: a detached child
// whose stdio is piped, plus a parent that stops doing work and lets its event
// loop drain naturally — no process.exit().
//
// The Node docs say a child's piped stdio is referenced by the parent's event
// loop and `child.unref()` alone does not lift that; the pipe handles must be
// unref'd too. If someone removes the pipe unrefs from agentdock and this
// platform honors the docs, the intermediate below hangs instead of exiting
// and this test goes red — that is the regression it guards. On platforms
// where pipes do not hold the parent either way, the test still pins the
// contract: exit must work WITH the unrefs in place.
//
// The intermediate also proves the pipes still deliver data after unref
// (masking / URL discovery keep working): it only writes its result file after
// the child's line has flowed through a plain `data` listener, the same way
// openMaskedLog.pump() consumes the tunnel's stdout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// The child stays alive well past the observation windows (detached), then
// drains its own loop — no orphan left behind either way. The negative test
// kills its bridge, so this lifetime is what keeps the pipes open while the
// "held" verdict is being reached.
const CHILD = `
  console.log("tunnel-url https://demo-subdomain.trycloudflare.com");
  setTimeout(() => {}, 30000);
`;

// The intermediate replicates agentdock start(): spawn detached with piped
// stdio, attach data listeners, then (UNREF=1) unref the pipes and the child.
// When the child's line has been seen it stops the interval and simply ends —
// the event loop has to drain on its own for the process to exit.
const INTERMEDIATE = `
  const { spawn } = require("node:child_process");
  const fs = require("node:fs");
  const unref = process.env.UNREF === "1";
  const out = process.env.OUT;
  const child = spawn(process.execPath, ["-e", ${JSON.stringify(CHILD)}], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let saw = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { saw += chunk; });
  child.stderr.on("data", () => {});
  child.on("error", () => { fs.writeFileSync(out, "child-error"); process.exit(1); });
  if (unref) {
    child.stdout.unref();
    child.stderr.unref();
    child.unref();
  }
  const timer = setInterval(() => {
    if (saw.includes("trycloudflare.com")) {
      clearInterval(timer);
      fs.writeFileSync(out, "ok:" + saw.trim());
    }
  }, 50);
`;

async function runBridge(unref, windowMs) {
  const dir = await mkdtemp(path.join(tmpdir(), "bridge-lifecycle-"));
  const out = path.join(dir, "result.txt");
  const child = spawn(process.execPath, ["-e", INTERMEDIATE], {
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, UNREF: unref ? "1" : "0", OUT: out },
  });
  const result = await Promise.race([
    new Promise((resolve) => child.once("exit", (code) => resolve({ exited: true, code }))),
    new Promise((resolve) =>
      setTimeout(() => resolve({ exited: false }), windowMs).unref?.(),
    ),
  ]);
  let file = "";
  try {
    file = await readFile(out, "utf8");
  } catch {
    /* never written: the intermediate never saw the child's line */
  }
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  if (!result.exited) child.kill();
  return { ...result, file };
}

test("a detached piped child does not hold a bridge that stops working (the agentdock spawn pattern)", async () => {
  const { exited, code, file } = await runBridge(true, 10_000);
  assert.equal(exited, true, "intermediate never exited: something in the spawn pattern still holds its event loop");
  assert.equal(code, 0, "intermediate exited non-zero");
  assert.ok(
    file.startsWith("ok:"),
    `the child's stdout never flowed through the parent's data listener (got: ${JSON.stringify(file)})`,
  );
});

// The reason the pipe unrefs exist. On Windows/Node 22.22.2 this was measured
// directly: with only `child.unref()` the intermediate is still alive at 6s
// and has to be killed; with the unrefs it exits in ~300ms. The Node docs
// describe the same semantics everywhere, so this holds on CI's Linux too —
// the 3s window and the 30s child lifetime leave a wide margin against a
// slow runner. If this ever goes red, the negative no longer holds and the
// first test alone would not be catching the regression it was written for.
test("without the pipe unrefs, the same pattern DOES hold the bridge open", async () => {
  const { exited } = await runBridge(false, 3_000);
  assert.equal(exited, false, "piped stdio no longer holds the parent — the unrefs in agentdock may have become dead weight, or the platform changed");
});
