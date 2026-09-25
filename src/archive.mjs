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
// The "no Model identified" sentinel is a property of the archive format, so it
// is declared once (in pool.mjs) and shared, rather than retyped in three files.
import { UNRESOLVED } from "./pool.mjs";

const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g;
const UNRESOLVED_FOLDER = `${UNRESOLVED}（未捕获本轮 run 令牌，探针仍停留在上一轮）`;

/** Turn a model name into a Windows-safe folder name (helper uses `_` for `/`). */
export function modelFolderName(model) {
  const raw = String(model || "").trim();
  if (!raw) return UNRESOLVED_FOLDER;
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

/** The Arena session id inside an entry's Url (…/agent/<uuid>), or "". */
export function sessionIdFromUrl(url) {
  const m = String(url || "").match(/\/agent\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return m ? m[1].toLowerCase() : "";
}

/**
 * The Account email that created a Session, or "" when the archive does not say.
 *
 * Derived, never stored: the archive already carries Email per entry. 记录.json
 * is small enough (kilobytes) that reading it per lookup is cheaper than keeping
 * an index warm, so there is no cache here on purpose.
 */
export function sessionAccountEmail(archiveDir, sessionId) {
  const id = String(sessionId || "").trim().toLowerCase();
  if (!id) return "";
  const entry = readEntries(archiveDir).find((e) => sessionIdFromUrl(e.Url) === id);
  return entry ? String(entry.Email || "").trim() : "";
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
  const title = `${model || UNRESOLVED} · ${shortStamp(now)}`;
  const record = {
    Id: String(entry.sessionId || "").replace(/-/g, "").slice(0, 32) || crypto.randomBytes(16).toString("hex"),
    Title: title,
    Model: model || UNRESOLVED,
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

/**
 * 补标 — set the Model of an ALREADY archived session, then refresh the indexes.
 * Used when a session was archived as 未识别 and a later probe identifies it.
 * Returns the updated record, or null when no entry carries that session id.
 */
export function updateModel(archiveDir, sessionId, model) {
  const entries = readEntries(archiveDir);
  const needle = String(sessionId || "").toLowerCase();
  const idx = entries.findIndex((e) => String(e.Url || "").toLowerCase().includes(`/agent/${needle}`));
  if (idx < 0) return null;
  const next = String(model || "").trim();
  const prev = entries[idx];
  const folder = modelFolderName(next);
  const prevFolder = prev.ModelFolder;
  // Keep the original "MM-DD HH:mm" tail; only the Model prefix changes.
  const title = String(prev.Title || "");
  const tail = title.includes(" · ") ? title.split(" · ").slice(1).join(" · ") : title;
  entries[idx] = { ...prev, Model: next || UNRESOLVED, ModelFolder: folder, Title: `${next || UNRESOLVED} · ${tail}` };
  writeJsonAtomic(path.join(archiveDir, "记录.json"), entries);
  writeModelIndex(archiveDir, folder, next);
  if (prevFolder && prevFolder !== folder) writeModelIndex(archiveDir, prevFolder, prev.Model);
  writeSummary(archiveDir, entries);
  return entries[idx];
}

/**
 * Remove Sessions from 记录.json, then refresh the per-model 清单.md files that
 * lost a row and the root 汇总.md.
 *
 * This is the only irreversible operation in the archive, and 记录.json is the
 * only record of these Sessions — Arena's copy is not ours to touch. The caller
 * is responsible for confirming with the operator; nothing here is undoable.
 *
 * Model folders are left in place even when they empty out: the directory
 * layout is an interchange contract with the external helper, so a folder that
 * reads "共 0 条会话" is safer than one that vanished.
 */
export function removeEntries(archiveDir, sessionIds) {
  const wanted = new Set(
    (Array.isArray(sessionIds) ? sessionIds : [sessionIds])
      .map((s) => String(s || "").trim().toLowerCase())
      .filter(Boolean)
  );
  const entries = readEntries(archiveDir);
  if (!wanted.size) return [];

  const kept = [];
  const removed = [];
  for (const entry of entries) {
    const sessionId = sessionIdFromUrl(entry.Url);
    if (sessionId && wanted.has(sessionId)) removed.push(entry);
    else kept.push(entry);
  }
  if (!removed.length) return [];

  writeJsonAtomic(path.join(archiveDir, "记录.json"), kept);
  const folders = new Map();
  for (const entry of removed) {
    if (entry.ModelFolder) folders.set(entry.ModelFolder, entry.Model);
  }
  for (const [folder, model] of folders) writeModelIndex(archiveDir, folder, model);
  writeSummary(archiveDir, kept);
  return removed;
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
