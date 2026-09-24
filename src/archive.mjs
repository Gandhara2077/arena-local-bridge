// archive.mjs — read/write the Arena模型助手 "模型归档" layout.
//
// Why this exists: the C# helper is the historical producer of sessions. This
// module lets the Node bridge PRODUCE the exact same layout, so a session
// harvested here is indistinguishable from one harvested by the helper and the
// rest of the pipeline (server.readArchiveSessions, /v1/models, the GUI) keeps
// working unchanged. Schema is mirrored field-for-field from 记录.json.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g;

/** Turn a model name into a Windows-safe folder name (helper uses `_` for `/`). */
export function modelFolderName(model) {
  const raw = String(model || "").trim();
  if (!raw) return "未识别（未捕获本轮 run 令牌，探针仍停留在上一轮）";
  return raw.replace(ILLEGAL, "_").slice(0, 120);
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function shortStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function readEntries(archiveDir) {
  if (!archiveDir) return [];
  const file = path.join(archiveDir, "记录.json");
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Atomic-ish write: write to a temp file in the same dir, then rename. */
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.记录.json.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1), "utf8");
  fs.renameSync(tmp, file);
}

/**
 * Append one harvested session to 记录.json and refresh the markdown indexes.
 * entry: { sessionId, model, url, email, prompt, provider }
 * Returns the stored record.
 */
export function appendEntry(archiveDir, entry) {
  const now = new Date();
  const model = String(entry.model || "").trim();
  const folder = modelFolderName(model);
  const title = `${model || "未识别"} · ${shortStamp(now)}`;
  const record = {
    Id: String(entry.sessionId || "").replace(/-/g, "").slice(0, 32) || crypto.randomBytes(16).toString("hex"),
    Title: title,
    Model: model || "未识别",
    Url: entry.url || "",
    Profile: entry.profile || "arena-bridge",
    Email: entry.email || "",
    Prompt: entry.prompt || "",
    CollectedAt: stamp(now),
    ModelFolder: folder,
    Shortcut: null,
    Renamed: false,
    RenameError: null,
    ExportedAt: null,
    ExportedFolder: null,
    Provider: entry.provider || null,
    Source: "arena-bridge",
  };

  const entries = readEntries(archiveDir);
  entries.push(record);
  writeJsonAtomic(path.join(archiveDir, "记录.json"), entries);

  writeModelIndex(archiveDir, folder, model);
  writeSummary(archiveDir, entries);
  return record;
}

/** Per-model 清单.md — same shape the helper emits. */
function writeModelIndex(archiveDir, folder, model) {
  const dir = path.join(archiveDir, folder);
  fs.mkdirSync(dir, { recursive: true });
  const mine = readEntries(archiveDir).filter((e) => e.ModelFolder === folder);
  const lines = [
    `# ${model || folder}`,
    "",
    `共 ${mine.length} 条会话。`,
    "",
    "| 会话标题 | 时间 | 会话链接 |",
    "| --- | --- | --- |",
    ...mine.map((e) => `| ${e.Title} | ${e.CollectedAt} | ${e.Url} |`),
    "",
  ];
  fs.writeFileSync(path.join(dir, "清单.md"), lines.join("\n"), "utf8");
}

/** Root 汇总.md — model | count | first | last. */
function writeSummary(archiveDir, entries) {
  const byModel = new Map();
  for (const e of entries) {
    const key = e.Model || "未识别";
    const cur = byModel.get(key) || { key, count: 0, first: null, last: null };
    cur.count += 1;
    if (!cur.first || (e.CollectedAt && e.CollectedAt < cur.first)) cur.first = e.CollectedAt;
    if (!cur.last || (e.CollectedAt && e.CollectedAt > cur.last)) cur.last = e.CollectedAt;
    byModel.set(key, cur);
  }
  const rows = [...byModel.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  const lines = [
    "# 模型归档汇总",
    "",
    `共 ${entries.length} 条会话，分布在 ${rows.length} 个模型目录下。`,
    "",
    "| 模型 | 会话数 | 首次 | 末次 |",
    "| --- | --- | --- | --- |",
    ...rows.map((r) => `| ${r.key} | ${r.count} | ${r.first || "-"} | ${r.last || "-"} |`),
    "",
  ];
  fs.writeFileSync(path.join(archiveDir, "汇总.md"), lines.join("\n"), "utf8");
}

/**
 * Aggregate stats for the GUI overview.
 * Returns { archiveDir, total, models, byModel:[{model,count,first,last}] }
 */
export function stats(archiveDir) {
  const entries = readEntries(archiveDir);
  const byModel = new Map();
  for (const e of entries) {
    const key = e.Model || "未识别";
    const cur = byModel.get(key) || { model: key, count: 0, first: null, last: null };
    cur.count += 1;
    const t = e.CollectedAt || "";
    if (t && (!cur.first || t < cur.first)) cur.first = t;
    if (t && (!cur.last || t > cur.last)) cur.last = t;
    byModel.set(key, cur);
  }
  const list = [...byModel.values()].sort((a, b) => b.count - a.count || a.model.localeCompare(b.model));
  return {
    archiveDir: archiveDir || "",
    total: entries.length,
    models: list.length,
    byModel: list,
  };
}
