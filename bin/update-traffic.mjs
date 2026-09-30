#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = process.cwd();
const HISTORY_PATH = path.join(ROOT, "assets", "traffic-history.json");
const token = process.env.GITHUB_TOKEN;
const repository = process.env.GITHUB_REPOSITORY;

if (!token || !repository) {
  throw new Error("GITHUB_TOKEN and GITHUB_REPOSITORY are required");
}

async function getJson(endpoint) {
  const response = await fetch(`https://api.github.com/repos/${repository}/traffic/${endpoint}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "arena-local-bridge-traffic",
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${endpoint}: GitHub API ${response.status}: ${body}`);
  }
  return response.json();
}

const [views, clones] = await Promise.all([
  getJson("views"),
  getJson("clones"),
]);

const existing = JSON.parse(await fs.readFile(HISTORY_PATH, "utf8"));
const byDate = new Map((existing.days ?? []).map((day) => [day.date, day]));

for (const item of views.views ?? []) {
  const date = new Date(item.timestamp).toISOString().slice(0, 10);
  const day = byDate.get(date) ?? { date, views: 0, unique_views: 0, clones: 0, unique_clones: 0 };
  day.views = item.count ?? 0;
  day.unique_views = item.uniques ?? 0;
  byDate.set(date, day);
}

for (const item of clones.clones ?? []) {
  const date = new Date(item.timestamp).toISOString().slice(0, 10);
  const day = byDate.get(date) ?? { date, views: 0, unique_views: 0, clones: 0, unique_clones: 0 };
  day.clones = item.count ?? 0;
  day.unique_clones = item.uniques ?? 0;
  byDate.set(date, day);
}

const days = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));

const history = {
  version: 1,
  updated_at: new Date().toISOString(),
  days,
  latest_14_days: {
    captured_at: new Date().toISOString(),
    views: {
      count: views.count ?? 0,
      uniques: views.uniques ?? 0,
    },
    clones: {
      count: clones.count ?? 0,
      uniques: clones.uniques ?? 0,
    },
  },
};

await fs.writeFile(HISTORY_PATH, `${JSON.stringify(history, null, 2)}\n`);

execFileSync(process.execPath, ["bin/generate-traffic-svg.mjs"], { stdio: "inherit" });
