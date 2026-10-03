import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

test("traffic refresh preserves history, replaces overlapping days and uses API period uniques", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "arena-traffic-"));
  try {
    await fs.mkdir(path.join(root, "assets"));
    await fs.mkdir(path.join(root, "bin"));
    for (const name of ["update-traffic.mjs", "generate-traffic-svg.mjs"]) {
      await fs.copyFile(fileURLToPath(new URL(`../bin/${name}`, import.meta.url)), path.join(root, "bin", name));
    }
    const historyPath = path.join(root, "assets", "traffic-history.json");
    const oldDay = { date: "2025-01-01", views: 5, unique_views: 2, clones: 4, unique_clones: 1 };
    await fs.writeFile(historyPath, JSON.stringify({ version: 1, days: [oldDay] }));
    const mockPath = path.join(root, "mock.mjs");
    await fs.writeFile(mockPath, `
      globalThis.fetch = async (url) => {
        if (process.env.FAIL_TRAFFIC) return new Response("unavailable", { status: 503 });
        const key = url.endsWith("/views") ? "views" : "clones";
        return Response.json({ count: 20, uniques: 7, [key]: [
          { timestamp: "2025-02-01T00:00:00Z", count: 10, uniques: 6 },
          { timestamp: "2025-02-02T00:00:00Z", count: 10, uniques: 6 }
        ] });
      };
    `);
    const run = (extra = {}) => spawnSync(process.execPath, ["--import", pathToFileURL(mockPath).href, "bin/update-traffic.mjs"], {
      cwd: root, encoding: "utf8",
      env: { ...process.env, TRAFFIC_TOKEN: "test-only", GITHUB_REPOSITORY: "test/repo", FAIL_TRAFFIC: "", ...extra },
    });
    for (let i = 0; i < 2; i++) {
      const result = run();
      assert.equal(result.status, 0, result.stderr);
    }
    const history = JSON.parse(await fs.readFile(historyPath, "utf8"));
    assert.equal(history.days.length, 3);
    assert.deepEqual(history.days[0], oldDay);
    assert.equal(history.days[1].clones, 10);
    assert.equal(history.latest_14_days.clones.uniques, 7);
    assert.equal(history.latest_14_days.views.uniques, 7);
    const svgPath = path.join(root, "assets", "traffic.svg");
    assert.match(await fs.readFile(svgPath, "utf8"), /class="card-value">7<\/text>/);
    const before = await fs.readFile(historyPath, "utf8");
    const beforeSvg = await fs.readFile(svgPath, "utf8");
    assert.notEqual(run({ FAIL_TRAFFIC: "1" }).status, 0);
    assert.equal(await fs.readFile(historyPath, "utf8"), before);
    assert.equal(await fs.readFile(svgPath, "utf8"), beforeSvg);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
