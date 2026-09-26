
__mods["main"] = { fn: function (exp) {
  var ingestNative = __req("native-capture").ingestNative;
  var nativeStatus = __req("native-capture").nativeStatus;
  var latestTraceSummary = __req("trace-summary").latestTraceSummary;
  var desktopFacts = __req("trace-summary").desktopFacts;
  var summarizeReasoning = __req("reasoning").summarizeReasoning;
  var BUS = __req("interceptor").BUS;
  var beginTurn = __req("interceptor").beginTurn;
  var installFetchHook = __req("interceptor").installFetchHook;
  var installXHRHook = __req("interceptor").installXHRHook;
  var installSocketHook = __req("interceptor").installSocketHook;
  var classify = __req("classify").classify;
  var learnFromObservation = __req("learned").learnFromObservation;
  var listLearned = __req("learned").listLearned;
  var exportLearned = __req("learned").exportLearned;
  var backfillNames = __req("learned").backfillNames;
  var recordRealModel = __req("learned").recordRealModel;
  var listRealModels = __req("learned").listRealModels;
  var matchTokenizer = __req("probe").matchTokenizer;
  var runCanaries = __req("probe").runCanaries;
  var buildProbePack = __req("probe").buildProbePack;
  var refreshModelMap = __req("idmap").refreshModelMap;
  var resolveEvidence = __req("idmap").resolveEvidence;
  var mapStats = __req("idmap").mapStats;
  var isUuid = __req("idmap").isUuid;
  var resolveModelId = __req("idmap").resolveModelId;
  var startAutoResolve = __req("runmodel").startAutoResolve;
  var acceptToken = __req("runmodel").acceptToken;
  var fetchRunModels = __req("runmodel").fetchRunModels;
  var pollRunModels = __req("runmodel").pollRunModels;
  var pushModelEvidence = __req("runmodel").pushModelEvidence;
  var beginRunTurn = __req("runmodel").beginRunTurn;
  var runState = __req("runmodel").state;
  var runReset = __req("runmodel").reset;
  var extractModelLabels = __req("runmodel").extractModelLabels;
  var REGISTRY_VERSION = __req("registry").REGISTRY_VERSION;
/**
 * main.js — 编排入口
 *
 * 目标：装钩子 → 收证据 → 首帧快判 → 每次完整响应精判 → 自动建档。
 * 预算：从页面发消息到 HUD 出首判，目标 < 800ms（首帧即判）。
 */
const VERSION = '1.0.0';
function boot(opts = {}) {
  const cfg = {
    learn: true,
    autoBackfillMs: 30000,
    ...opts,
  };

  // 1) 先装钩子（越早越好，抢在页面自己的 fetch 之前）
  installFetchHook();
  installXHRHook();
  installSocketHook();

  const state = { hud: null, lastVerdict: null, lastObservation: null, slots: {}, t0: performance.now() };

/* ---------------- 装载 UUID → 模型名 映射（揭示机制） ---------------- */
  // 为什么要异步拉取：映射表来自排行榜 RSC 载荷，会随官方更新而变化。
  // 有了它，消息层/网络层拿到的 UUID 才能还原成 gpt-6-astra-high 这样的真名。
  (async () => {
    try {
      const r = await refreshModelMap();
      if (state.hud) state.hud?.log(`模型映射表已装载 ${r.loaded} 条`);
    } catch (e) {
      if (state.hud) state.hud?.log(`映射表装载失败: ${e && e.message}`);
    }
  })();

  /* ---------------- 自动解析真实模型名（核心能力） ---------------- */
  // 流程：流里出现 public-access-token → 解出 run id → 轮询 run trace
  //       → 提取 ai.streamText.doStream span 的模型标签 → 回灌为最高权重证据。
  // 这样探针就能直接显示 qwen3.8-max-0902 这类真实模型名，而不只是"家族未知"。
  // Short prompts resolve in a few seconds: start reading the trace early and back off adaptively.
  startAutoResolve({ initialDelayMs: 2500, maxMs: 180000, intervalMs: 6000, firstIntervalMs: 1500 });

  BUS.on((evt) => {
    // ---- 第一环：接收流里下发的 token ----
    //
    // 实测踩过的坑：interceptor 会发出 'stream-header' 事件，但这里
    // 没有监听者，导致 token 流到 BUS 就断了，acceptToken 从未被调用，
    // 于是永远读不到 run trace，HUD 只能显示"模型家族未知"。
    if (evt.kind === 'turn-start') { beginRunTurn(evt.data?.url); state.lastObservation = null; state.lastVerdict = null; state.slots = {}; recompute('turn-start'); return; }
    if (evt.kind === 'diagnostic') { recompute('diagnostic'); return; }
    if (evt.kind === 'stream-header') {
      const d = evt.data || {};
      try {
        if (acceptToken(d.name, d.value) && state.hud) {
          state.hud?.log(`流头发现访问令牌: ${d.name}`);
        }
      } catch (e) {
        if (state.hud) state.hud?.log(`令牌解析失败: ${e && e.message}`);
      }
      return;
    }

    // Native desktop summary does not require a page HUD.

    if (evt.kind === 'run-token') {
      const d = evt.data || {};
      recompute('run-token');
      state.hud?.log(`取得 run 令牌（runId=${d.runId || '?'}, 有效期 ${d.expiresInSec || '?'}s）`);
    }

    if (evt.kind === 'run-model') {
      const name = evt.data && evt.data.name;
      state.hud?.log(`★ 真实模型名: ${name}`);
      // 把已验证的真名单独存档：这类名字（如 qwen-latest-series-invite-202608-m4）
      // 常不在公开目录里，指纹无法归类，但真名是确定的，必须原样记住。
      try {
        const r = recordRealModel(name, { runId: evt.data && evt.data.runId });
        if (r && r.kind === 'VERIFIED_NEW') {
          state.hud?.log(`已存档真实模型名: ${name}`);
        }
      } catch { /* noop */ }
      // 关键：真实模型名到达时必须立刻重算并刷新 HUD。
      // 否则界面会停留在旧的「模型家族未知」上（实测踩过的坑）。
      recompute('run-model');
    }

    if (evt.kind === 'run-model-failed') {
      state.hud?.log(`run trace 读取未得到模型名（${evt.data && evt.data.reason}）`);
    }
  });

  /* ---------------- 首帧快判（快速） ---------------- */
  BUS.on((evt) => {
    if (evt.kind === 'fast-verdict') {
      const d = evt.data;
      const v = quickVerdict(d);
      if (state.hud && (v.modelId || v.family)) {
        state.hud?.log(`首帧命中: ${v.modelId || v.family}`);
        recompute('fast');
      }
    }
    if (evt.kind === 'evidence' && evt.data?.source === 'reasoning.config') recompute('reasoning');
    if (evt.kind === 'evidence' && state.hud) {
      const e = evt.data;
      if (e.modelId && e.source !== 'sse.chunk.model') {
        state.hud?.log(`证据 ${e.source}: ${e.modelId}`);
      }
    }
    if (evt.kind === 'observation') {
      state.lastObservation = evt.data;
      recompute('observation');
    }
  });

  /* ---------------- 完整判定 + 建档 ---------------- */
  function recompute(trigger) {
    // 先把 UUID 形态的 modelId 还原成真实模型名（揭示机制），
    // 再把还原结果纳入证据链 —— 这一步决定了能否给出「具体版本号」。
    try {
      const n = resolveEvidence(BUS.evidence);
      if (n && state.hud) state.hud?.log(`UUID 还原 ${n} 个模型名`);
    } catch { /* noop */ }

    const evidence = BUS.evidence.filter(e => !e.stale);
    let verdict = classify(evidence);

    // ---- 真实模型名优先：只要 run trace 给了名字，就直接作为结论 ----
    //
    // 为什么需要这层兜底：classify 依赖证据链融合，若新名字不在注册表里
    // （如 qwen-latest-series-invite-202608-m4），融合结果会给出
    // RESOLVED 但 family/label 为空，HUD 仍显示"未知"。
    // 真实模型名由 worker 直接写入 run，权威性最高，应当无条件展示。
    const rs = runState();
    if (rs.modelName) {
      const matched = classify([{ source: 'run.trace.model', weight: 1.0, modelId: rs.modelName }]);
      verdict = {
        ...matched,
        mode: 'RESOLVED',
        modelId: rs.modelName,
        label: matched.label || rs.modelName,     // 未归类时直接显示名字
        confidence: Math.max(verdict.confidence || 0, 0.96),
        note: matched.family
          ? `真实模型名来自 Trigger.dev run trace（worker 写入）`
          : `真实模型名来自 Trigger.dev run trace；该名称未收录于本地注册表，已按原样显示`,
        source: 'run.trace.model',
        realName: true,
        evidence: [
          { source: 'run.trace.model', detail: `run ${rs.runId || '?'} 的 streamText span 标签` },
          ...(verdict.evidence || []).slice(0, 5),
        ],
      };
    }

    state.lastVerdict = verdict;
    state.slots = splitBySlot(evidence);

    let learnedSummary = null;
    if (cfg.learn && state.lastObservation && state.lastObservation.complete && trigger === 'observation') {
      const obsEv = evidence.filter(e => {
        if (!state.lastObservation.url) return true;
        return e.url === state.lastObservation.url;
      });
      try {
        const lv = learnFromObservation(state.lastObservation, obsEv);
        if (state.hud && lv && lv.kind === 'NEW_MODEL') {
          state.hud?.log(`⚠ 发现未建档模型: ${lv.entry.resolved}（已写入指纹库）`);
        }
      } catch { /* noop */ }
      learnedSummary = summarizeLearned();
    }

    let tokenizer = null;
    if (state.lastObservation && state.lastObservation.promptTokens) {
      tokenizer = matchTokenizer(state.lastObservation.promptTokens);
    }

    // 主动探针：对响应文本跑 canary 判定，作为家族级旁证
    if (trigger === 'observation' && state.lastObservation?.complete && state.lastObservation.text) {
      const cand = runCanaries(state.lastObservation.text);
      for (const c of cand) {
        if (c.family || c.weight >= 0.3) {
          BUS.evidence.push({ ...c, source: c.source, url: state.lastObservation.url, t: performance.now() });
        }
      }
    }

    if (state.hud) {
      const lastH = rs.modelHistory[rs.modelHistory.length - 1] || {};
      state.hud.render(verdict, {
        reasoning: summarizeReasoning(BUS.evidence),
        diagnostics: BUS.diagnostics,
        native: nativeStatus(),
        observation: state.lastObservation,
        learnedSummary,
        tokenizer,
        slots: state.slots,
        realModel: rs.modelName
          ? { name: rs.modelName, runId: rs.runId, tokens: lastH.tokens, all: lastH.all }
          : null,
        runInfo: rs.runId ? { runId: rs.runId, reason: rs.lastError } : null,
      });
    }
    return verdict;
  }

  function quickVerdict(d) {
    const evidence = BUS.evidence.filter(e => e.url === d.url || e.modelId);
    return classify(evidence);
  }

  /* ---------------- 定时回填匿名簇命名 ---------------- */
  if (cfg.autoBackfillMs > 0) {
    setInterval(() => {
      const n = backfillNames();
      if (n && state.hud) state.hud?.log(`回填 ${n} 条匿名簇命名`);
    }, cfg.autoBackfillMs);
  }

  let desktopDetail = null;
  const detailLive = () => {
    const run=runState(),url=location.origin+location.pathname;
    const candidates=[run.automaticTrace,desktopDetail].filter(x=>x&&x.url===url&&x.generation===BUS.generation&&x.runId===run.runId&&x.summary);
    const timestamp=x=>{const n=Date.parse(x.summary.checkedAt||'');return Number.isFinite(n)?n:0;};
    candidates.sort((a,b)=>(b.summary.turn||0)-(a.summary.turn||0)||timestamp(b)-timestamp(a));
    return candidates[0]?.summary||null;
  };

  // 暴露 API 给控制台/自动化
  const api = {
    version: VERSION,
    nativeCapture: (event) => ingestNative(event),
    nativeStatus: () => nativeStatus(),
    bus: BUS,
    hud: state.hud,
    state,
    classify: () => recompute('api'),
    reasoning: () => desktopFacts(runState(),BUS.observations,BUS.evidence,detailLive()).effort,
    desktopFacts: () => desktopFacts(runState(),BUS.observations,BUS.evidence,detailLive()),
    // USD fields only; no token, raw trace, or other account context is exposed.
    usdQuotaSnapshot: () => __req('usd-quota').select(runState(),desktopDetail,location.origin+location.pathname,BUS.generation),
    // Read-only panel context: accept only the same page, generation and run.
    monitorSnapshot: () => {
      const run=runState(),url=location.origin+location.pathname;
      const detail=detailLive();
      return {url,generation:BUS.generation,runId:run.runId,detail,diagnostics:{...BUS.monitor,counts:{...BUS.monitor.counts},events:BUS.monitor.events.map(e=>({...e}))}};
    },
    acceptTraceDetail: (context, detail) => {
      const why=!context?'missing-context':!/^https:\/\/arena\.ai\/agent\/[0-9a-f-]{36}$/.test(context.url||'')?'invalid-url':context.url!==location.origin+location.pathname?'page-mismatch':context.runId!==runState().runId?'run-mismatch':context.generation!==BUS.generation?'generation-mismatch':null;
      if(why){BUS.mark('detail-rejected',why);return false;}
      const summary=latestTraceSummary(detail),previous=detailLive();
      const olderTurn=previous?.turn&&(!summary.turn||summary.turn<previous.turn);
      const olderTime=previous?.turn===summary.turn&&Date.parse(summary.checkedAt)<Date.parse(previous.checkedAt);
      if(olderTurn||olderTime){BUS.mark('detail-rejected','older-trace-snapshot');return false;}
      desktopDetail={url:context.url,runId:context.runId,generation:context.generation,summary,quotaSnapshot:__req('usd-quota').extract(detail)};BUS.mark('detail-accepted');return true;
    },
    observations: () => BUS.observations,
    learned: () => listLearned(),
    export: () => exportLearned(),
    probePack: () => buildProbePack(),
    canaries: (text) => runCanaries(text),
    // beginTurn emits turn-start; its listener already calls beginRunTurn/reset once.
    reset: () => { beginTurn(); state.lastObservation = null; recompute('reset'); },

    // ---- UUID → 模型名（揭示机制）----
    /** 重新拉取映射表（官方更新模型后调用） */
    refreshMap: () => refreshModelMap(),
    /** 直接查一个 UUID */
    resolve: (id) => resolveModelId(id),
    /** 映射表统计 */
    mapStats: () => mapStats(),
    /** 手动把证据里的 UUID 全量还原 */
    resolveEvidence: () => resolveEvidence(BUS.evidence),
    /** 判断是否 UUID */
    isUuid,

    // ---- 真实模型名（Trigger.dev run trace）----
    /** 当前 run 状态（token / runId / 已解析出的模型名 / 历史） */
    runState: () => runState(),
    /** 手动触发一次 trace 读取 */
    fetchRunModels: (opts) => fetchRunModels(opts),
    /** 轮询直到拿到模型名 */
    pollRunModels: (opts) => pollRunModels(opts),
    /** 从 trace 文本提取模型标签（离线可用） */
    extractFromTrace: (text) => extractModelLabels(text),
    /** 当前真实模型名（最常需要的接口） */
    realModel: () => runState().modelName,
    /** 手动喂入 token（调试用） */
    acceptToken: (name, value) => acceptToken(name, value),
    /** 已存档的真实模型名列表 */
    realModels: () => listRealModels(),
    /** 手动记录一个真实模型名 */
    recordRealModel: (name, meta) => recordRealModel(name, meta),
  };
  BUS.ready = true;
  for (const evt of BUS.pendingHeaders.splice(0)) BUS.emit(evt);
  recompute('boot');
  try { window.__MODEL_PROBE__ = api; } catch { /* noop */ }
  return api;
}

function splitBySlot(evidence) {
  const out = {};
  for (const e of evidence) {
    if (!e.slot) continue;
    const s = e.slot;
    out[s] = out[s] || { evidence: [] };
    out[s].evidence.push(e);
  }
  for (const s of Object.keys(out)) {
    const v = classify(out[s].evidence);
    out[s] = { modelId: v.modelId, label: v.label, family: v.family, gen: v.gen, confidence: v.confidence, mode: v.mode };
  }
  return out;
}

function summarizeLearned() {
  const all = listLearned();
  return {
    total: all.length,
    unseen: all.filter(e => e.status === 'UNSEEN').length,
    anon: all.filter(e => e.status === 'ANON_CLUSTER').length,
  };
}

function buildDump(state) {
  return {
    probe: 'arena-model-probe',
    version: VERSION,
    at: new Date().toISOString(),
    href: location.href,
    verdict: state.lastVerdict,
    slots: state.slots,
    observation: state.lastObservation
      ? { ...state.lastObservation, text: '[omitted: raw network data]' }
      : null,
    evidence: BUS.evidence.slice(-120).map(e => ({
      source: e.source, weight: e.weight, modelId: e.modelId,
      family: e.family, detail: e.detail, url: e.url, slot: e.slot,
    })),
  };
}

function copy(text) {
  try { navigator.clipboard.writeText(text); } catch { /* noop */ }
}

// 自动启动。
//
// 版本感知：若页面里已存在【不同版本】的探针实例，说明代码已更新，
// 此时不要因为 BOOTED 标记就跳过——否则改了探针但页面仍跑旧版
// （实测踩过：新增的协议指纹一直不生效，因为跑的是旧注入）。
if (typeof window !== 'undefined') {
  // Network hooks must run before page scripts retain native fetch / create streams.
  installFetchHook();
  installXHRHook();
  installSocketHook();

  const start = () => boot();
  // Streaming HTML can keep readyState=loading long after the editor is usable.
  // Mount as soon as the root exists instead of waiting for the entire HTML stream.
  if (document.documentElement) start();
  else if (typeof MutationObserver === 'function') {
    const observer = new MutationObserver(() => {
      if (document.documentElement) { observer.disconnect(); start(); }
    });
    observer.observe(document, { childList: true, subtree: true });
  } else document.addEventListener('DOMContentLoaded', start, { once: true });
}

  exp.VERSION = VERSION;
  exp.boot = boot;
} };