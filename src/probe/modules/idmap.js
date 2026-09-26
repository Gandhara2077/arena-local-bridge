
__mods["idmap"] = { fn: function (exp) {
  var BUS = __req("interceptor").BUS;
/**
 * idmap.js — UUID → 模型名 映射解析（揭示机制的核心组件）
 *
 * 背景（逆向得出的事实）：
 *   arena.ai 的消息对象携带的是 modelId（UUID），而不是模型名：
 *     message.participantPosition === 'a' && (modelAId = message.modelId)
 *     message.participantPosition === 'b' && (modelBId = message.modelId)
 *   模型名需要通过「UUID → publicName」映射表还原。
 *
 *   这份映射来自排行榜页面的 RSC 载荷（initialModels 数组），每条形如：
 *     {id:"01a07d42-...", organization:"openai", provider:"openaiResponses",
 *      publicName:"gpt-6-astra-medium", userSelectable:false, capabilities:{...}}
 *
 * 为什么放在探针里：
 *   1. 网络层/消息层拿到的往往是 UUID，必须还原才能给出人类可读的模型名
 *   2. 映射表随官方更新变化，所以运行时可重新拉取（refresh）
 *   3. 映射表也能反查：拿到模型名 → 找到它的所有 UUID（便于比对）
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let MAP = Object.create(null);      // uuid -> {name, org, provider}
let NAME_INDEX = Object.create(null); // name(lower) -> [uuid]
let META = { loaded: 0, builtAt: 0, source: null };
function isUuid(s) {
  return typeof s === 'string' && UUID_RE.test(s.trim());
}

/** 用已解析的模型数组装载映射表 */
function loadModelMap(models, source = 'inline') {
  if (!Array.isArray(models)) return 0;
  let n = 0;
  for (const m of models) {
    if (!m || !m.id) continue;
    const name = m.publicName || m.name || m.displayName;
    if (!name) continue;
    MAP[m.id] = { name, org: m.organization || null, provider: m.provider || null, selectable: m.userSelectable };
    const k = String(name).toLowerCase();
    (NAME_INDEX[k] = NAME_INDEX[k] || []).push(m.id);
    n++;
  }
  META = { loaded: n, builtAt: Date.now(), source };
  return n;
}

/** UUID → 模型名 */
function resolveModelId(id) {
  if (!id) return null;
  const k = String(id).trim();
  const hit = MAP[k];
  if (hit) return { id: k, name: hit.name, org: hit.org, provider: hit.provider, selectable: hit.selectable };
  return isUuid(k) ? { id: k, name: null, org: null, provider: null, unknown: true } : null;
}

/** 模型名 → 所有 UUID（反查，用于比对同一模型的不同快照） */
function uuidsForName(name) {
  if (!name) return [];
  return (NAME_INDEX[String(name).toLowerCase()] || []).slice();
}
function mapStats() {
  return { ...META, names: Object.keys(NAME_INDEX).length };
}

/**
 * 从排行榜页面在线拉取并装载映射表。
 *
 * 解析方式说明（关键）：
 *   排行榜的 RSC 载荷形如 self.__next_f.push([1,"<转义JSON>"])，
 *   其中引号是双重转义。直接正则切对象很脆弱（实测两次失败），
 *   因此这里改为「反转义后用括号配平 + JSON.parse 逐个尝试」，
 *   并且只在解析成功且含 publicName/provider 时才采纳。
 */
async function refreshModelMap() {
  const pages = ['/leaderboard/agent', '/leaderboard/text', '/leaderboard'];
  const all = [];
  for (const p of pages) {
    try {
      const r = await fetch(p, { credentials: 'include' });
      if (!r.ok) continue;
      const html = await r.text();
      all.push(...parseInitialModels(html));
    } catch { /* 忽略单页失败 */ }
  }
  const n = loadModelMap(all, 'leaderboard-rsc');
  return { loaded: n, pages: pages.length };
}

/** 从页面 HTML 里解析 initialModels 数组 */
function parseInitialModels(html) {
  if (typeof html !== 'string' || !html) return [];
  const out = [];
  // 1) 取出 RSC 载荷字符串并反转义
  let text = '';
  const pushRe = /self\.__next_f\.push\(\[1,\s*"((?:[^"\\]|\\.)*)"\s*\]\)/g;
  let m;
  while ((m = pushRe.exec(html)) !== null) {
    try { text += JSON.parse('"' + m[1] + '"'); } catch { text += m[1]; }
  }
  if (!text) text = html.replace(/\\"/g, '"');

  // 2) 对每个 {"id" 锚点做括号配平 + JSON.parse
  let i = 0;
  while (true) {
    const j = text.indexOf('{"id"', i);
    if (j < 0) break;
    i = j + 1;
    const end = balancedEnd(text, j);
    if (end < 0) continue;
    const frag = text.slice(j, end);
    if (!/"publicName"|"provider"|"organization"/.test(frag)) continue;
    try {
      const o = JSON.parse(frag);
      if (o && o.id && (o.publicName || o.provider || o.organization)) out.push(o);
    } catch { /* 片段不完整 */ }
  }
  return out;
}

/** 从 start（'{'）开始找配平的对象结尾，正确处理字符串与转义 */
function balancedEnd(s, start) {
  let depth = 0, inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === '"') inStr = false;
    } else {
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) return i + 1; }
    }
  }
  return -1;
}

/**
 * 扫描 BUS 里的证据，把所有 UUID 形态的 modelId 还原成模型名，
 * 并把还原结果作为高权重证据回灌（source: 'idmap.resolve'）。
 *
 * 这是「拿到具体版本号」的落地环节：只要上游给出了 UUID，
 * 这里就能把它变成 gpt-6-astra-high / claude-opus-5-max 这样的真名。
 */
function resolveEvidence(evidence) {
  const list = Array.isArray(evidence) ? evidence : [];
  let resolved = 0;
  const seen = new Set();
  for (const e of list) {
    if (!e || !e.modelId || !isUuid(e.modelId)) continue;
    const r = resolveModelId(e.modelId);
    if (!r || !r.name || seen.has(r.id)) continue;
    seen.add(r.id);
    resolved++;
    BUS.push({
      source: 'idmap.resolve',
      weight: 0.92,
      modelId: r.name,
      detail: `${r.id} → ${r.name}${r.org ? ' [' + r.org + ']' : ''}（UUID 还原）`,
      url: e.url,
      slot: e.slot,
      t: (typeof performance !== 'undefined' ? performance.now() : Date.now()),
    });
  }
  return resolved;
}
function exportMap() {
  return JSON.stringify({ meta: META, map: MAP }, null, 2);
}

  exp.isUuid = isUuid;
  exp.loadModelMap = loadModelMap;
  exp.resolveModelId = resolveModelId;
  exp.uuidsForName = uuidsForName;
  exp.mapStats = mapStats;
  exp.refreshModelMap = refreshModelMap;
  exp.parseInitialModels = parseInitialModels;
  exp.resolveEvidence = resolveEvidence;
  exp.exportMap = exportMap;
} };