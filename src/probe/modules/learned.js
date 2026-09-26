
__mods["learned"] = { fn: function (exp) {
  var fingerprintVector = __req("classify").fingerprintVector;
  var cosineSim = __req("classify").cosineSim;
  var FP_DIMS = __req("classify").FP_DIMS;
  var matchKnownModels = __req("classify").matchKnownModels;
  var protocolFingerprint = __req("classify").protocolFingerprint;
  var collectModelFields = __req("classify").collectModelFields;
  var REGISTRY_VERSION = __req("registry").REGISTRY_VERSION;
  var ANON_SLOT_RE = __req("registry").ANON_SLOT_RE;
/**
 * learned.js — 未知模型自动建档（"支持未来新模型"的核心机制）
 *
 * 问题：GPT-6 这类新模型出现时，任何写死的名单都会滞后。
 * 解法：三层兜底
 *   1) registry 正则命中 → 直接归类
 *   2) 正则为空但拿到 model 串 → 用协议指纹判家族，用串本身做代号解析，
 *      并以 UNSEEN 名义建档（下次即可精确命中）
 *   3) 连 model 串都没有 → 用指纹向量聚类，同源模型归到同一簇，
 *      一旦该簇某天暴露真名，整簇自动"溯名"
 *
 * 存储：localStorage（页面内持久），导出/导入 JSON 便于跨设备迁移。
 */


const STORE_KEY = 'amp.learned.v1';
const MAX_ENTRIES = 400;
const SIM_THRESHOLD = 0.92;   // 视为"同一模型"的相似度门槛
const NEW_THRESHOLD = 0.86;   // 视为"同一家族近亲"的门槛

/* ------------------------------------------------------------------ *
 * 代号解析：把 arena 的匿名槽位、内部代号尽量还原成可读信息
 * ------------------------------------------------------------------ */
function parseCodename(modelId) {
  if (!modelId) return null;
  const out = { raw: modelId, anonymous: false, hints: [] };

  if (ANON_SLOT_RE.test(modelId) || /^(?:model|assistant|side|slot)[-_ ]?[ab]$/i.test(modelId.trim())) {
    out.anonymous = true;
    out.hints.push('盲测匿名槽位');
  }
  const m1 = modelId.match(/\b(?:anon|hidden|secret|mystery|stealth|ninja|cloak|masked)[-_ ]?([a-z0-9]+)\b/i);
  if (m1) { out.anonymous = true; out.hints.push(`隐名代号 ${m1[1]}`); }
  const m3 = modelId.match(/(?:^|[-_.])(\d{4})[-_.]?(\d{2})[-_.]?(\d{2})(?:$|[-_.])/);
  if (m3) out.hints.push(`日期快照 ${m3[1]}-${m3[2]}-${m3[3]}`);  const m4 = modelId.match(/\b(?:preview|exp|experimental|beta|alpha|rc\d?|snapshot|nightly|dev)\b/i);
  if (m4) out.hints.push(`非稳定通道 ${m4[0]}`);
  // 档位/变体：前缀不再强求纯字母（gpt-6-turbo、deepseek-v4-thinking 都要能命中）
  const m6 = modelId.match(/(?:^|[-_.])(pro|max|ultra|plus|turbo|flash|lite|mini|nano|small|tiny|air|fast)(?:$|[-_.])/i);
  if (m6) out.hints.push(`档位 ${m6[1].toLowerCase()}`);
  const m5 = modelId.match(/(?:^|[-_.])(thinking|reasoner|reason|think|r1|reasoning)(?:$|[-_.])/i);
  if (m5) out.hints.push('推理/思维链变体');
  const m7 = modelId.match(/(?:^|[-_.])(\d{1,4})b(?:$|[-_.])/i);
  if (m7) out.hints.push(`参数量 ${m7[1]}B`);
  if (/\b(?:private|internal|customer|dedicated|ft|fine[-_]?tune)\b/i.test(modelId)) out.hints.push('私有/微调部署');

  // 家族线索：即使不匹配任何已知正则，也能从命名习惯猜个大概
  const famGuess = [
    [/\b(?:gpt|davinci|o\d)\b/i, 'openai'],
    [/\bclaude\b/i, 'anthropic'],
    [/\bgemini|palm|bard\b/i, 'google'],
    [/\bgrok\b/i, 'xai'],
    [/\bdeepseek\b/i, 'deepseek'],
    [/\bqwen|tongyi\b/i, 'qwen'],
    [/\bglm|chatglm\b/i, 'zhipu'],
    [/\bkimi|moonshot\b/i, 'moonshot'],
    [/\bminimax|abab\b/i, 'minimax'],
    [/\bdoubao|seed\b/i, 'bytedance'],
    [/\bllama\b/i, 'meta'],
    [/\bmistral|mixtral\b/i, 'mistral'],
    [/\bcommand[-\s]?[ar]\b/i, 'cohere'],
    [/\bnemotron\b/i, 'nvidia'],
    [/\bphi[-\s]?\d\b/i, 'microsoft'],
  ].find(([re]) => re.test(modelId));
  if (famGuess) out.family = famGuess[1];

  // 代际数字提取（gpt-6 → 6）
  const gen = modelId.match(/\b(?:gpt|claude|gemini|grok|llama|deepseek[-\s]?v?|glm|qwen|phi)[-\s]?(\d{1,2})(?:[.\-](\d{1,2}))?/i);
  if (gen) out.version = { major: +gen[1], minor: gen[2] ? +gen[2] : null };

  return out;
}

/* ------------------------------------------------------------------ *
 * 存储
 * ------------------------------------------------------------------ */
function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { version: REGISTRY_VERSION, entries: [], updated: Date.now() };
    const o = JSON.parse(raw);
    if (!o || !Array.isArray(o.entries)) return { version: REGISTRY_VERSION, entries: [], updated: Date.now() };
    return o;
  } catch { return { version: REGISTRY_VERSION, entries: [], updated: Date.now() }; }
}

function save(db) {
  try {
    db.updated = Date.now();
    db.version = REGISTRY_VERSION;
    db.entries = db.entries.slice(-MAX_ENTRIES);
    localStorage.setItem(STORE_KEY, JSON.stringify(db));
  } catch { /* 配额满时静默 */ }
}

/* ------------------------------------------------------------------ *
 * 指纹签名：把证据集归约成可比较的键
 * ------------------------------------------------------------------ */
function signatureOf({ evidence = [], observation = null }) {
  const modelIds = evidence.filter(e => e.modelId).map(e => e.modelId.trim().toLowerCase()).sort();
  const families = evidence.filter(e => e.family).map(e => e.family).sort();
  const url = observation && observation.url ? observation.url.replace(/https?:\/\/[^/]+/, '').replace(/\d{6,}/g, '#') : '';
  return JSON.stringify({ modelIds: [...new Set(modelIds)], families: [...new Set(families)], url });
}

/* ------------------------------------------------------------------ *
 * 主入口：观测 → 建档 / 命中
 * ------------------------------------------------------------------ */
function learnFromObservation(observation, evidenceForIt = []) {
  const db = load();
  const vec = fingerprintVector(observation);
  const modelIds = [...new Set(evidenceForIt.filter(e => e.modelId).map(e => e.modelId.trim()))];
  const declared = modelIds.find(m => matchKnownModels(m).length) || modelIds[0] || null;

  const proto = protocolFingerprint(observation.text || '');
  const protoFamily = proto.length ? proto[0].family : null;

  // --- 1. 先找已建档条目 ---
  let best = null, bestSim = 0;
  for (const en of db.entries) {
    // Explicit equal labels outrank timing noise; different explicit labels must not be merged.
    if (declared && en.modelIds?.includes(declared)) { best = en; bestSim = 1; break; }
    if (!en.vec || (declared && en.resolved && en.resolved !== declared)) continue;
    const sim = cosineSim(vec, en.vec, FP_DIMS);
    if (sim > bestSim) { bestSim = sim; best = en; }
  }

  const nowTs = Date.now();
  let verdict;

  if (best && bestSim >= SIM_THRESHOLD) {
    best.count++;
    best.lastSeen = nowTs;
    best.vec = best.vec ? blend(best.vec, vec, 0.25) : vec;
    if (declared && !best.modelIds.includes(declared)) best.modelIds.push(declared);
    if (declared && !best.resolved) { best.resolved = declared; best.resolvedAt = nowTs; }
    verdict = { kind: 'MATCH', entry: best, similarity: +bestSim.toFixed(4) };
  } else if (declared) {
    // --- 2. 有模型串但从未见过 → 未知模型自动建档 ---
    const parsed = parseCodename(declared);
    const entry = {
      id: `u_${hash(declared + nowTs)}`,
      modelIds: [declared],
      resolved: declared,
      parsed,
      family: parsed && parsed.family ? parsed.family : protoFamily,
      firstSeen: nowTs,
      lastSeen: nowTs,
      count: 1,
      vec,
      known: matchKnownModels(declared).length > 0,
      status: matchKnownModels(declared).length ? 'KNOWN' : 'UNSEEN',
      nearest: best ? { ids: best.modelIds, similarity: +bestSim.toFixed(4) } : null,
    };
    db.entries.push(entry);
    verdict = {
      kind: entry.status === 'UNSEEN' ? 'NEW_MODEL' : 'NEW_FOR_SESSION',
      entry, similarity: +bestSim.toFixed(4), parsed,
    };
  } else if (best && bestSim >= NEW_THRESHOLD) {
    // --- 3. 无模型串，但与已知簇近似 → 归簇 ---
    best.count++;
    best.lastSeen = nowTs;
    best.vec = blend(best.vec, vec, 0.15);
    verdict = { kind: 'CLUSTER', entry: best, similarity: +bestSim.toFixed(4) };
  } else {
    // --- 4. 全新匿名簇建档（等待未来溯名） ---
    const entry = {
      id: `c_${hash(observation.url + nowTs)}`,
      modelIds: [],
      resolved: null,
      family: protoFamily,
      firstSeen: nowTs,
      lastSeen: nowTs,
      count: 1,
      vec,
      known: false,
      status: 'ANON_CLUSTER',
    };
    db.entries.push(entry);
    verdict = { kind: 'NEW_CLUSTER', entry, similarity: +bestSim.toFixed(4) };
  }

  save(db);
  return verdict;
}

/**
 * recordRealModel — 记录一个【已验证的真实模型名】
 *
 * 与 learnFromObservation 的区别：那个靠指纹相似度归簇（推测），
 * 这个直接来自 Trigger.dev run trace 的 worker 写入（事实）。
 * 因此单独建档并标记 verified，是最高可信度的记录。
 *
 * 为什么需要：像 qwen-latest-series-invite-202608-m4 这类名字
 * 不在公开目录里，靠指纹无法归类；但它的真名是确定的，
 * 必须原样记住，等同一名字再次出现时直接命中。
 */
function recordRealModel(name, meta = {}) {
  if (!name || typeof name !== 'string') return null;
  const db = load();
  const key = name.trim();
  let en = db.entries.find(e => e.resolved === key && e.verified);

  if (en) {
    en.count++;
    en.lastSeen = Date.now();
    if (meta.runId && en.runIds && !en.runIds.includes(meta.runId)) en.runIds.push(meta.runId);
    save(db);
    return { kind: 'VERIFIED_MATCH', entry: en };
  }

  const parsed = parseCodename(key);
  const matched = matchKnownModels(key);
  en = {
    id: `v_${hash(key)}`,
    modelIds: [key],
    resolved: key,
    parsed,
    family: (parsed && parsed.family) || (matched[0] && matched[0].family) || null,
    gen: matched[0] ? matched[0].gen : null,
    firstSeen: Date.now(),
    lastSeen: Date.now(),
    count: 1,
    verified: true,          // 标记：来自 run trace，非推测
    status: matched.length ? 'KNOWN' : 'VERIFIED_UNLISTED',
    runIds: meta.runId ? [meta.runId] : [],
  };
  db.entries.push(en);
  save(db);
  return { kind: 'VERIFIED_NEW', entry: en };
}

/** 列出所有已验证的真实模型名 */
function listRealModels() {
  return load().entries.filter(e => e.verified).map(e => ({
    name: e.resolved, family: e.family, gen: e.gen,
    count: e.count, firstSeen: e.firstSeen, lastSeen: e.lastSeen,
    runIds: e.runIds || [], status: e.status,
  }));
}

function blend(a, b, w) {
  const o = {};
  for (const d of FP_DIMS) o[d] = (a[d] || 0) * (1 - w) + (b[d] || 0) * w;
  return o;
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

/* ------------------------------------------------------------------ *
 * 溯名：某匿名簇后来暴露了真名 → 整簇回填
 * ------------------------------------------------------------------ */
function backfillNames() {
  const db = load();
  let changed = 0;
  for (const en of db.entries) {
    if ((en.status === 'ANON_CLUSTER' || !en.resolved) && en.modelIds.length) {
      const real = en.modelIds.find(m => matchKnownModels(m).length);
      if (real && !en.resolved) { en.resolved = real; en.status = 'KNOWN'; changed++; }
    }
  }
  if (changed) save(db);
  return changed;
}
function exportLearned() { return JSON.stringify(load(), null, 2); }
function importLearned(json) {
  try {
    const o = typeof json === 'string' ? JSON.parse(json) : json;
    if (!o || !Array.isArray(o.entries)) return false;
    const cur = load();
    const ids = new Set(cur.entries.map(e => e.id));
    for (const e of o.entries) if (!ids.has(e.id)) cur.entries.push(e);
    save(cur);
    return true;
  } catch { return false; }
}
function listLearned() { return load().entries; }
function clearLearned() { try { localStorage.removeItem(STORE_KEY); } catch { /* noop */ } }

  exp.collectModelFields = collectModelFields;
  exp.parseCodename = parseCodename;
  exp.signatureOf = signatureOf;
  exp.learnFromObservation = learnFromObservation;
  exp.recordRealModel = recordRealModel;
  exp.listRealModels = listRealModels;
  exp.backfillNames = backfillNames;
  exp.exportLearned = exportLearned;
  exp.importLearned = importLearned;
  exp.listLearned = listLearned;
  exp.clearLearned = clearLearned;
} };