// Only the native launcher writes this child's stdin. Wait until it has placed
// us in its Windows Job before importing code that may spawn browser children.
import readline from "node:readline";

let started = false;
function stop() {
  if (process.listenerCount("SIGTERM")) process.emit("SIGTERM");
  else process.exit(0);
}

const commands = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
commands.on("line", (line) => {
  if (line === "STOP") return stop();
  if (line !== "START" || started) return;
  started = true;
  if (Number(process.versions.node.split(".")[0]) < 20) {
    console.error("Arena Local Bridge requires Node 20 or newer. Use the bundled runtime/node.exe.");
    process.exit(1);
  }
  import("../src/index.mjs").catch((error) => {
    console.error(error?.stack || String(error));
    process.exit(1);
  });
});
commands.on("close", stop);
