// cloudflared prints the public URL into its own log file, and that URL is a
// credential: the random subdomain is what keeps the tunnel unguessable. Our
// own log lines stopped carrying it in #04; this covers the files the CHILDREN
// would write. Their output pipes are the last point where those bytes are
// still ours, so both logs are written by us from a filtered stream.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openMaskedLog } from "../src/agentdock.mjs";

const URL = "https://bold-river-quiet-mountain.trycloudflare.com";
const MASKED = "https://***.trycloudflare.com/";

function cloudflaredBox(url = URL) {
  return [
    "2026-09-29T10:00:01Z INF Requesting new quick Tunnel on trycloudflare.com...",
    "2026-09-29T10:00:03Z INF Your quick Tunnel has been created! Visit it at:",
    `2026-09-29T10:00:03Z INF |  ${url}  |`,
    "2026-09-29T10:00:04Z INF Registered tunnel connection connIndex=0",
    "",
  ].join("\n");
}

// A stand-in for a child's stdio, so the wiring can be driven without spawning
// anything: this is the boundary, and it is the only thing replaced.
function fakeSource() {
  const bus = new EventEmitter();
  bus.setEncoding = () => {};
  return bus;
}

function tempFile(name = "tunnel.log") {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "arena-log-")), name);
}

test("openMaskedLog: the URL is masked, everything else survives", async () => {
  const file = tempFile();
  const sink = openMaskedLog(file);
  const source = fakeSource();
  sink.pump(source);
  source.emit("data", cloudflaredBox());
  await sink.close();

  const written = fs.readFileSync(file, "utf8");
  assert.doesNotMatch(written, /bold-river|quiet|mountain/, "随机子域名不能留下任何片段");
  assert.match(written, /https:\/\/\*\*\*\.trycloudflare\.com/, "脱敏后的地址留着，才能看出是哪条隧道");
  assert.match(written, /Your quick Tunnel has been created!/, "排障信息要留着");
  assert.match(written, /2026-09-29T10:00:04Z INF Registered tunnel connection connIndex=0/, "非 URL 行逐字保留");
});

test("openMaskedLog: whole lines reach the caller, tail included on close()", async () => {
  // This is the hook the URL discovery reads, so what it receives is the thing
  // that decides whether a tunnel that came up is seen as a timeout.
  const seen = [];
  const sink = openMaskedLog(tempFile(), (line) => seen.push(line));
  const source = fakeSource();
  sink.pump(source);
  source.emit("data", "one\ntwo\nstill going");
  assert.deepEqual(seen, ["one\n", "two\n"], "没有换行就还不知道这行是什么");
  await sink.close();
  assert.deepEqual(seen, ["one\n", "two\n", "still going"], "close() 要把没有换行的尾行也交出去");
});

test("openMaskedLog: a line split across reads is still one line, and is still masked", async () => {
  // A read boundary can land anywhere, including inside the URL.
  const file = tempFile();
  const seen = [];
  const sink = openMaskedLog(file, (line) => seen.push(line));
  const source = fakeSource();
  sink.pump(source);
  const box = cloudflaredBox();
  const cut = box.indexOf("quiet-mountain");
  source.emit("data", box.slice(0, cut));
  source.emit("data", box.slice(cut));
  await sink.close();

  assert.equal(seen.length, 4, "两半必须合成一整行再交出去，而不是各算一行");
  assert.ok(seen.some((line) => line.includes(URL)), "发现 URL 的那一步要看到完整地址");
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), /bold-river|quiet|mountain/);
});

test("openMaskedLog: every URL on a line is masked, not just the first", async () => {
  const file = tempFile();
  const sink = openMaskedLog(file);
  const source = fakeSource();
  sink.pump(source);
  const other = "https://second-quick-tunnel.trycloudflare.com";
  source.emit("data", `retry: ${URL} then ${other}\n`);
  await sink.close();
  assert.equal(fs.readFileSync(file, "utf8"), `retry: ${MASKED} then ${MASKED}\n`);
});

test("openMaskedLog: stdout and stderr do not glue half lines together", async () => {
  // Each source is buffered on its own. A shared buffer would join half of one
  // line to half of the other and write a line neither process ever produced.
  const file = tempFile();
  const sink = openMaskedLog(file);
  const out = fakeSource();
  const err = fakeSource();
  sink.pump(out);
  sink.pump(err);
  out.emit("data", "half a line from stdout");
  err.emit("data", "a whole line from stderr\n");
  out.emit("data", " rest of stdout\n");
  await sink.close();
  assert.equal(
    fs.readFileSync(file, "utf8"),
    "a whole line from stderr\nhalf a line from stdout rest of stdout\n"
  );
});

test("openMaskedLog: a failure reason lands on disk so the tunnel can be diagnosed", async () => {
  const file = tempFile();
  const sink = openMaskedLog(file);
  const source = fakeSource();
  sink.pump(source);
  source.emit("data", "2026-09-29T10:00:01Z ERR Failed to request quick Tunnel: context deadline exceeded\n");
  await sink.close();
  assert.equal(
    fs.readFileSync(file, "utf8"),
    "2026-09-29T10:00:01Z ERR Failed to request quick Tunnel: context deadline exceeded\n"
  );
});

test("openMaskedLog: close() still resolves when the log could not be opened", async () => {
  // A stream that already failed never emits `close` again, so waiting on that
  // event would hang stop() for good. The path below has no parent directory.
  const sink = openMaskedLog(path.join(tempFile("no-such"), "missing", "tunnel.log"));
  const source = fakeSource();
  sink.pump(source);
  source.emit("data", "line\n");
  // Let the failed open land first: that is the order in which a stream is
  // already closed by the time anything waits for it.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const outcome = await Promise.race([
    sink.close().then(() => "closed"),
    new Promise((resolve) => setTimeout(() => resolve("hung"), 1000)),
  ]);
  assert.equal(outcome, "closed");
});
