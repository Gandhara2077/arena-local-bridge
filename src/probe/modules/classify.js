
__mods["classify"] = { fn: function (exp) {
  var MODEL_PATTERNS = __req("registry").MODEL_PATTERNS;
  var FAMILY_PROTOCOLS = __req("registry").FAMILY_PROTOCOLS;
  var HOST_VENDOR = __req("registry").HOST_VENDOR;
  var MODEL_KEY_RE = __req("registry").MODEL_KEY_RE;
  var USAGE_KEYS = __req("registry").USAGE_KEYS;
  var MODEL_HEADER_RE = __req("registry").MODEL_HEADER_RE;
  var isFrontier = __req("registry").isFrontier;
/**
 * classify.js — 证据融合与判定引擎
 *
 * 原理：模型身份不是"猜"出来的，是从多层证据里"收敛"出来的。
 * 每一条证据 = { source, weight, modelId?, family?, detail }
 * 判定 = 按 modelId 聚合 → 取最高权重链路 → 用来源权威性折算置信度。
 *
 * 关键设计：区分两类判定
 *   - RESOLVED  ：拿到权威 model 字符串（请求体/响应体/响应头）→ 高置信
 *   - INFERRED  ：只拿到协议/行为指纹 → 家族级判定 + 代际推断，不谎报具体版本
 */

/* ------------------------------------------------------------------ *
 * 证据来源权威性权重（上限，实际取 min(上限, 该来源具体权重)）
 * ------------------------------------------------------------------ */
const SOURCE_WEIGHTS = {
  // 真实模型名：来自 Trigger.dev run 的 streamText span 标签，由 worker 写入，
  // 不经任何网关改写 —— 这是当前能拿到的最权威来源，故置于最高权重。
  'run.trace.model':           1.00,
  'request.body.model':        1.00, // 我们发出去的请求体，同样可信
  'response.header.model':     0.95,
  'response.json.model':       0.93,
  'idmap.resolve':             0.92, // UUID → 官方模型名（来自排行榜 initialModels 映射）
  'sse.chunk.model':           0.90,
  'url.path.model':            0.85,
  'response.header.provider':  0.80,
  'url.host.vendor':           0.80,
  'protocol.framing':          0.72,
  'request.header':            0.60,
  'dom.text':                  0.45,
  'behavior.probe':            0.35,
  'self.report':               0.15,
};

/* ------------------------------------------------------------------ *
 * 工具：深度遍历 JSON，收集所有疑似模型标识
 * ------------------------------------------------------------------ */
function collectModelFields(node, path = '$', out = [], depth = 0, maxDepth = 12) {
  if (depth > maxDepth || node == null) return out;
  if (typeof node !== 'object') return out;

  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) collectModelFields(node[i], `${path}[${i}]`, out, depth + 1, maxDepth);
    return out;
  }

  for (const [k, v] of Object.entries(node)) {
    const p = `${path}.${k}`;
    if (MODEL_KEY_RE.test(k) && typeof v === 'string' && v.length >= 2 && v.length <= 120) {
      out.push({ path: p, key: k, value: v });
    } else if (k === 'model' && Array.isArray(v)) {
      v.forEach((m, i) => { if (typeof m === 'string') out.push({ path: `${p}[${i}]`, key: 'model', value: m }); });
    } else if (v && typeof v === 'object') {
      collectModelFields(v, p, out, depth + 1, maxDepth);
    }
  }
  return out;
}

/** 从原始文本里正则兜底抓 model 字符串（应对截断的 SSE / 非 JSON 响应） */
function scanTextForModel(text) {
  const found = [];
  if (typeof text !== 'string' || !text) return found;
  const re = /"(?:model|model_id|modelId|model_name|served_model|upstream_model|resolved_model)"\s*:\s*"([^"\\]{2,120})"/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (!found.includes(m[1])) found.push(m[1]);
  }
  return found;
}

/** 从 URL 主机名推断厂商 */
function vendorFromUrl(url) {
  if (!url) return null;
  let host = url;
  try { host = new URL(url, 'https://x.invalid').host || url; } catch { /* keep raw */ }
  for (const [re, vendor, weight] of HOST_VENDOR) {
    if (re.test(host) || re.test(url)) return { vendor, weight, host };
  }
  return { vendor: null, weight: 0, host };
}

/** 匹配所有已知模型正则，返回按权重排序的候选 */
function matchKnownModels(str, cap = 6) {
  const out = [];
  if (!str || typeof str !== 'string') return out;
  for (const p of MODEL_PATTERNS) {
    const m = str.match(p.re);
    if (m) out.push({
      family: p.family, gen: p.gen, label: p.label,
      matched: m[0], weight: p.weight, modelId: str,
      frontier: isFrontier(p.family, p.gen),
    });
  }
  return out.sort((a, b) => b.weight - a.weight).slice(0, cap);
}

/** 协议指纹：判断一段流/JSON 属于哪个家族 */
function protocolFingerprint(text) {
  if (!text || typeof text !== 'string') return [];

  // 关键：arena.ai 的 realtime batch 把真实帧作为「JSON 字符串」嵌在 body 里，
  // 于是文本中的引号是转义形态 \"type\":\"start\"。
  // 只按未转义文本匹配会全部漏判（实测踩过：完整解出了 start/text-delta 等帧，
  // 但家族判定仍是「通用 SSE」）。因此这里同时匹配原始文本与反转义文本。
  const unescaped = text.includes('\\"') ? text.replace(/\\"/g, '"') : null;

  const hits = [];
  for (const proto of FAMILY_PROTOCOLS) {
    const matched = proto.tests
      .filter(t => t.re.test(text) || (unescaped && t.re.test(unescaped)))
      .map(t => t.name);
    if (!matched.length) continue;
    // 命中测试越多越可信；单条命中按 60% 折算，避免"reasoning_content"这类共用字段误判
    const ratio = matched.length / proto.tests.length;
    const conf = proto.weight * (matched.length >= 2 ? (0.75 + 0.25 * ratio) : 0.6);
    hits.push({ family: proto.family, label: proto.label, matched, score: +conf.toFixed(4) });
  }
  return hits.sort((a, b) => b.score - a.score);
}

/** 响应头 → 证据 */
function evidenceFromHeaders(headerObj, url = '') {
  const ev = [];
  if (!headerObj) return ev;
  const entries = headerObj instanceof Map ? [...headerObj.entries()]
    : Array.isArray(headerObj) ? headerObj
    : Object.entries(headerObj);

  for (const [k, v] of entries) {
    if (v == null) continue;
    const key = String(k).toLowerCase();
    if (MODEL_HEADER_RE.test(key) && typeof v === 'string') {
      ev.push({ source: 'response.header.model', weight: SOURCE_WEIGHTS['response.header.model'], modelId: v, detail: `${key}: ${v}` });
    }
    if (key === 'server' || key === 'x-served-by' || key === 'via') {
      const vd = vendorFromUrl(String(v));
      if (vd.vendor) ev.push({ source: 'response.header.provider', weight: 0.5, family: vd.vendor, detail: `${key}: ${v}` });
    }
  }
  const vd = vendorFromUrl(url);
  if (vd.vendor) ev.push({ source: 'url.host.vendor', weight: vd.weight, family: vd.vendor, detail: `host ${vd.host}` });
  return ev;
}

/* ------------------------------------------------------------------ *
 * 证据 → 判定
 * ------------------------------------------------------------------ */
function classify(evidence = []) {
  const byModel = new Map();   // modelId -> {score, sources[], family, gen}
  const familyAgg = new Map(); // family -> score

  const list = Array.isArray(evidence) ? evidence : [];
  const wireAgg = new Map();   // 传输层标记（__ 前缀），不参与模型家族判定
  for (const e of list) {
    if (!e || typeof e !== 'object' || e.weight == null) continue;

    // 家族级累积。
    //
    // 关键修正：以 __ 开头的条目表示【传输层/网关形态】（如 __sdk_wire、
    // __realtime_batch、__sse_generic），它们与"是哪个模型"无关——
    // Vercel AI SDK 同时封装 OpenAI/Anthropic/Google/Qwen 等所有 provider。
    // 若把它们并入家族判定，就会用"传输协议"冒充"模型家族"，产生假阳性
    // （实测踩过：真身是 qwen，却报出 openai 家族 74.1%）。
    if (e.family && String(e.family).startsWith('__')) {
      const w = wireAgg.get(e.family) || { family: e.family, score: 0, sources: [] };
      w.score = Math.max(w.score, e.weight);
      w.sources.push(e.source);
      wireAgg.set(e.family, w);
      continue;
    }

    if (e.family) {
      const f = familyAgg.get(e.family) || { family: e.family, score: 0, sources: [] };
      f.score = Math.max(f.score, e.weight);
      f.sources.push(e.source);
      familyAgg.set(e.family, f);
    }

    // 模型串级累积（只对"名字像模型"的串做正则归类）
    if (e.modelId) {
      const known = matchKnownModels(e.modelId);
      const key = e.modelId.trim();
      if (!key || key.length > 120) continue;
      const rec = byModel.get(key) || { modelId: key, score: 0, sources: [], matches: known };
      rec.score = Math.max(rec.score, Math.min(e.weight, SOURCE_WEIGHTS[e.source] ?? e.weight));
      rec.sources.push({ source: e.source, detail: e.detail || '' });
      if (!rec.matches.length && known.length) rec.matches = known;
      byModel.set(key, rec);
    }
  }

  const candidates = [...byModel.values()].sort((a, b) => b.score - a.score);
  const top = candidates[0] || null;

  // ---- 判定 1：拿到权威模型串 ----
  if (top && top.score >= 0.55) {
    const best = top.matches[0] || null;
    const agree = candidates.filter(c => c.matches[0]
      && best && c.matches[0].family === best.family && c.matches[0].gen === best.gen).length;
    const agreeBoost = Math.min(0.05, Math.max(0, agree - 1) * 0.02);

    return {
      mode: 'RESOLVED',
      modelId: top.modelId,
      family: best ? best.family : null,
      gen: best ? best.gen : null,
      label: best ? best.label : null,
      frontier: best ? best.frontier : null,
      confidence: +Math.min(0.99, top.score + agreeBoost).toFixed(3),
      evidence: top.sources,
      protocol: null,
      alternatives: candidates.slice(1, 5).map(c => ({
        modelId: c.modelId, confidence: +c.score.toFixed(3),
        family: c.matches[0] ? c.matches[0].family : null,
        gen: c.matches[0] ? c.matches[0].gen : null,
      })),
    };
  }

  // ---- 判定 2：只有家族级证据 ----
  const famTop = [...familyAgg.values()].sort((a, b) => b.score - a.score)[0];
  const wireTop = [...wireAgg.values()].sort((a, b) => b.score - a.score)[0];
  const protoEv = evidence.filter(e => e && e.source === 'protocol.framing');
  if (famTop && famTop.score >= 0.4) {
    return {
      mode: 'INFERRED',
      modelId: null,
      family: famTop.family,
      gen: null,
      label: `${famTop.family} 家族（具体版本未暴露）`,
      frontier: null,
      confidence: +Math.min(0.85, famTop.score).toFixed(3),
      evidence: protoEv.length ? protoEv : [{ source: 'family.aggregate', detail: famTop.sources.join(',') }],
      protocol: wireTop ? wireTop.family : null,
      wire: wireTop ? wireTop.family : null,
      alternatives: [],
      note: '上游 model 字段被网关抹除。可读取 Trigger.dev run trace 的 span 标签获得真实模型名。',
    };
  }

  // ---- 判定 2b：只有传输层证据 → 必须明说「模型家族未知」----
  //
  // 这是修正后的诚实行为。之前会把传输层当成 openai 家族报出去，
  // 属于用协议冒充模型身份。现在改为：说明用了什么传输层，
  // 但明确 modelFamily 未知，不给出任何家族猜测。
  if (wireTop) {
    const WIRE_LABEL = {
      '__sdk_wire': 'Vercel AI SDK UI Message Stream',
      '__realtime_batch': '自定义 realtime batch 传输',
      '__sse_generic': '通用 SSE',
    };
    return {
      mode: 'UNKNOWN',
      modelId: null,
      family: null,
      gen: null,
      label: '模型家族未知（仅识别出传输层）',
      frontier: null,
      confidence: 0,
      evidence: protoEv,
      protocol: wireTop.family,
      wire: wireTop.family,
      wireLabel: WIRE_LABEL[wireTop.family] || wireTop.family,
      alternatives: [],
      note: '传输层与模型家族无关（同一协议可封装任意厂商模型），'
          + '因此不据此推断家族。'
          + '如需真实模型名，读取 Trigger.dev run trace 的 span 标签。',
    };
  }

  return {
    mode: 'UNKNOWN', modelId: null, family: null, gen: null, label: '未识别',
    frontier: null, confidence: 0, evidence, protocol: null, alternatives: [],
    note: '尚未捕获到可判定的网络证据。请在页面发一条消息后重试。',
  };
}

/* ------------------------------------------------------------------ *
 * 指纹向量：用于未知模型自动建档与相似度比对
 *   —— 这是"支持未来新模型"的核心机制：
 *      不靠写死 GPT-6 的正则，而是把每次观测变成向量，落到本地 learned.json。
 *      下次遇到同源模型即命中；遇到新模型则新建档并标记 NEW。
 * ------------------------------------------------------------------ */
const FP_DIMS = [
  'ttft_ms', 'tok_per_sec', 'out_in_ratio', 'len_chars',
  'p_openai_chat', 'p_openai_resp', 'p_anthropic', 'p_google',
  'has_reasoning_field', 'has_cached_tokens', 'has_cache_creation',
  'has_system_fingerprint', 'has_toolu', 'has_call', 'has_fc',
  'prompt_tokens', 'completion_tokens', 'reasoning_ratio',
];
function fingerprintVector(obs = {}) {
  const t = obs.text || '';
  const n = (v, d) => (Number.isFinite(v) ? v : d);
  const promptTok = n(obs.promptTokens, 0);
  const compTok = n(obs.completionTokens, 0);
  const reasonTok = n(obs.reasoningTokens, 0);

  // 关键：时序维度必须饱和归一化到 0~1。
  // 否则 tok_per_sec 可以到 6+，在余弦相似度里单维压过其余 17 维，
  // 一点网络抖动就把同一模型判成"没见过的新模型"。
  const sat = (x, scale) => 1 - Math.exp(-Math.max(0, x) / scale);
  const decodeMs = n(obs.totalMs, 0) - n(obs.ttftMs, 0);
  const tps = decodeMs > 0 ? compTok / (decodeMs / 1000) : 0;

  return {
    ttft_ms: sat(n(obs.ttftMs, 0), 1500),
    tok_per_sec: sat(tps, 80),
    out_in_ratio: Math.min(1, compTok / Math.max(1, promptTok) / 4),
    len_chars: sat(t.length, 20000),
    p_openai_chat: /"object"\s*:\s*"chat\.completion|chatcmpl-/.test(t) ? 1 : 0,
    p_openai_resp: /response\.(created|output_text\.delta)|resp_/.test(t) ? 1 : 0,
    p_anthropic: /message_start|content_block_delta|toolu_/.test(t) ? 1 : 0,
    p_google: /"candidates"|usageMetadata|finishReason/.test(t) ? 1 : 0,
    has_reasoning_field: /"reasoning_content"|"reasoning"\s*:|thinking_delta/.test(t) ? 1 : 0,
    has_cached_tokens: /"cached_tokens"\s*:/.test(t) ? 1 : 0,
    has_cache_creation: /cache_creation_input_tokens/.test(t) ? 1 : 0,
    has_system_fingerprint: /"system_fingerprint"\s*:\s*"/.test(t) ? 1 : 0,
    has_toolu: /toolu_/.test(t) ? 1 : 0,
    has_call: /call_[A-Za-z0-9]{6,}/.test(t) ? 1 : 0,
    has_fc: /"fc_[A-Za-z0-9]{4,}"|functionCall/.test(t) ? 1 : 0,
    prompt_tokens: sat(promptTok, 4000),
    completion_tokens: sat(compTok, 4000),
    reasoning_ratio: Math.min(1, reasonTok / Math.max(1, compTok)),
  };
}

/**
 * 加权余弦相似度：结构性维度（协议/字段）权重高于时序维度。
 * 原因：结构是"型号"级别的稳定特征，时序只是"负载"级别的噪声特征。
 */
const FP_WEIGHTS = {
  ttft_ms: 0.4, tok_per_sec: 0.4, out_in_ratio: 0.6, len_chars: 0.4,
  p_openai_chat: 2.0, p_openai_resp: 2.0, p_anthropic: 2.0, p_google: 2.0,
  has_reasoning_field: 1.5, has_cached_tokens: 1.2, has_cache_creation: 1.5,
  has_system_fingerprint: 1.5, has_toolu: 1.5, has_call: 1.2, has_fc: 1.2,
  prompt_tokens: 0.4, completion_tokens: 0.5, reasoning_ratio: 1.0,
};
function cosineSim(a, b, dims = FP_DIMS) {
  let dot = 0, na = 0, nb = 0;
  for (const d of dims) {
    const w = FP_WEIGHTS[d] || 1;
    const x = (a[d] || 0) * w, y = (b[d] || 0) * w;
    dot += x * y; na += x * x; nb += y * y;
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

  exp.USAGE_KEYS = USAGE_KEYS;
  exp.isFrontier = isFrontier;
  exp.SOURCE_WEIGHTS = SOURCE_WEIGHTS;
  exp.collectModelFields = collectModelFields;
  exp.scanTextForModel = scanTextForModel;
  exp.vendorFromUrl = vendorFromUrl;
  exp.matchKnownModels = matchKnownModels;
  exp.protocolFingerprint = protocolFingerprint;
  exp.evidenceFromHeaders = evidenceFromHeaders;
  exp.classify = classify;
  exp.FP_DIMS = FP_DIMS;
  exp.fingerprintVector = fingerprintVector;
  exp.cosineSim = cosineSim;
} };