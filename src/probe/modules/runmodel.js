
__mods["runmodel"] = { fn: function (exp) {
  var automaticScope = __req("automatic-trace").automaticScope;
  var automaticDetail = __req("automatic-trace").automaticDetail;
  var parseTrace = __req("trace-parser").parseTrace;
  var BUS = __req("interceptor").BUS;

/**
 * runmodel.js — 从 Trigger.dev run trace 提取【真实模型名】
 *
 * 为什么需要这个模块：
 *   Agent Mode 的响应流里不含模型名（实测：请求体无 modelId、响应体穷举
 *   搜索 model/provider/harness 键名 0 个）。但服务端会下发一个
 *   public-access-token（JWT, pub:true），其 scope 明确包含
 *   read:runs:<runId> —— 即授予客户端读取该 run 的权限。
 *   读该 run 的 trace，里面 ai.streamText.doStream span 的标签
 *   就是 worker 自己写入的**真实模型名**，例如：
 *       qwen3.8-max-0902
 *       qwen-latest-series-invite-202608-m4
 *
 * 本模块把这些步骤全部自动化，让探针直接显示真实模型名，
 * 而不是只报"家族未知"。
 */


const TRIGGER_API = 'https://api.trigger.dev';

/* ------------------------------------------------------------------ *
 * 状态
 * ------------------------------------------------------------------ */
let activeController=null;
let rateLimitUntil=0;
const STATE = {
  finalReadStarted:false, lastSeenTurn:0, minTurn:0, unknownTurnBaseline:false, turnStartedAtMs:0,
  tokenUrl:null, collectionStatus:"pending", checkedAt:null,
  automaticTrace:null,
  detailRead:false,
  token: null,
  runId: null,
  tokenAt: 0,
  tokenExp: 0,
  lastFetchAt: 0,
  lastError: null,
  modelName: null,
  usage: null,
  modelHistory: [],       // [{name, at, runId, tokens}]
  fetching: false,
  fetchCount: 0,
};

/* ------------------------------------------------------------------ *
 * JWT 解码
 * ------------------------------------------------------------------ */
function b64urlDecode(s) {
  let t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  try {
    if (typeof atob === 'function') {
      const bin = atob(t);
      // atob 返回 latin1，需按 UTF-8 还原
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder('utf-8').decode(bytes);
    }
  } catch { /* noop */ }
  return null;
}
function decodeJwt(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  const head = b64urlDecode(parts[0]);
  const body = b64urlDecode(parts[1]);
  let h = null, p = null;
  try { h = head ? JSON.parse(head) : null; } catch { /* noop */ }
  try { p = body ? JSON.parse(body) : null; } catch { /* noop */ }
  return { header: h, payload: p };
}

/** 从 JWT 的 scopes 里提取 run id */
function runIdFromPayload(payload) {
  if (!payload) return null;
  const scopes = payload.scopes || [];
  for (const s of scopes) {
    const m = String(s).match(/(?:read|write):[a-zA-Z]+:(run_[A-Za-z0-9]+)/);
    if (m) return m[1];
  }
  const m2 = JSON.stringify(payload).match(/(run_[A-Za-z0-9]{10,})/);
  return m2 ? m2[1] : null;
}

/* ------------------------------------------------------------------ *
 * 接收 token（由 interceptor 的 stream-header 事件触发）
 * ------------------------------------------------------------------ */
function acceptToken(name, value) {
  if (!name || !value) return false;
  if (name.toLowerCase() !== 'public-access-token') return false;
  const reject=reason=>{BUS.monitor.tokenStatus=reason;BUS.mark('token-rejected',reason);return false;};
  BUS.mark('token-observed');
  if (!/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(value)) return reject('invalid-format');

  const dec = decodeJwt(value);
  const payload = dec && dec.payload;
  const scopes = Array.isArray(payload?.scopes) ? payload.scopes : [];
  const scope = scopes.find(s => /^read:runs:run_[A-Za-z0-9_-]+$/.test(s));
  if(!automaticScope(payload,location.origin+location.pathname))return reject('session-scope-or-expiry-mismatch');
  if (!payload || payload.pub !== true || !scope || payload.iss !== 'https://id.trigger.dev'
    || ![payload.aud].flat().includes(TRIGGER_API)) return reject('issuer-audience-or-run-scope-mismatch');
  const rid = scope.slice('read:runs:'.length);
  const exp = (dec && dec.payload && dec.payload.exp) || 0;

  // 同一 run 且 token 未过期 → 忽略
  if (STATE.token === value) {BUS.monitor.tokenStatus='duplicate';return false;}

  if (STATE.runId && STATE.runId !== rid) {
    reset();
    for (const e of BUS.evidence) if (e.source === 'run.trace.model' || e.config?.source === 'run.trace') e.stale = true;
  }
  BUS.monitor.tokenStatus='accepted';BUS.mark('token-accepted');
  STATE.tokenUrl=location.origin+location.pathname;
  STATE.token = value;
  STATE.runId = rid || STATE.runId;
  STATE.tokenAt = Date.now();
  STATE.tokenExp = exp * 1000;
  STATE.lastError = Date.now()<rateLimitUntil?"http-429":null;

  BUS.emit({
    kind: 'run-token',
    data: {
      runId: STATE.runId,
      pub: dec && dec.payload ? dec.payload.pub : null,
      expiresInSec: exp ? Math.round(exp - Date.now() / 1000) : null,
      scopes: (dec && dec.payload && dec.payload.scopes) || [],
    },
  });
  return true;
}

// A new submission is not a new account or necessarily a new run.
function beginRunTurn(requestUrl) {
  const token=STATE.token, url=location.origin+location.pathname;
  const reuse=!!requestUrl&&STATE.tokenUrl===url&&automaticScope(decodeJwt(token)?.payload,url);
  const baseline=STATE.lastSeenTurn;
  reset('new-turn');
  if(reuse){
    STATE.minTurn=baseline;STATE.lastSeenTurn=baseline;
    // An old conversation can provide a token before its trace was sampled.
    // MAX_SAFE_INTEGER used as the unknown baseline blocked every subsequent
    // turn in the same run, even after a new reply and settled spend.
    STATE.unknownTurnBaseline=baseline===0;
    STATE.turnStartedAtMs=Date.now();
    acceptToken('public-access-token',token);
  }
}
function newestTraceTurn(trace,runId) {
  let turn=0,active=0,events=[];
  for(const e of trace?.events||[]){
    if(e?.runId!==runId)continue;
    const m=/^chat turn (\d+)$/.exec(e.message||'');
    if(m){active=Number(m[1]);if(Number.isSafeInteger(active)&&active>=turn){turn=active;events=[];}}
    if(turn&&active===turn)events.push(e);
  }
  return {turn,events};
}
function traceTurnStartedAtMs(events) {
  // Prefer the observed turn/span's timestamp, never a read-time checkedAt.
  // Trace startTime may be an epoch ns/us/ms integer or an ISO timestamp.
  for(const e of events||[]){
    let raw=e?.startTime;
    if(typeof raw==='number'&&Number.isSafeInteger(raw))raw=String(raw);
    if(typeof raw!=='string')continue;
    let ms=null;
    if(/^\d{19}$/.test(raw))ms=Number(BigInt(raw)/1000000n);
    else if(/^\d{16}$/.test(raw))ms=Number(BigInt(raw)/1000n);
    else if(/^\d{13}$/.test(raw))ms=Number(raw);
    else if(/^\d{4}-\d{2}-\d{2}T/.test(raw))ms=Date.parse(raw);
    if(Number.isSafeInteger(ms)&&ms>946684800000&&ms<Date.now()+60000)return ms;
  }
  return null;
}
function state() {
  const { token, ...safe } = STATE;
  return { ...safe, tokenPresent: !!token, modelHistory: STATE.modelHistory.slice(-20) };
}

/* ------------------------------------------------------------------ *
 * 读取 run trace 并提取模型名
 * ------------------------------------------------------------------ */
/**
 * 从 trace 文本里抽取模型标签。
 * span 结构（实测）：
 *   "message":"ai.streamText.doStream","style":{"icon":"hero-sparkles",
 *     "accessory":{"style":"pills","items":[
 *        {"text":"qwen3.8-max-0902","icon":"tabler-cube"},   <- 模型
 *        {"text":"7.0k","icon":"tabler-hash"}]}}
 */
function extractModelLabels(traceText) {
  return parseTrace(traceText);
}

/** 用已存 token 拉取 trace */
async function fetchRunModels(opts = {}) {
  const timeoutMs = opts.timeoutMs || 20000;
  if (!STATE.token || !STATE.runId) {
    return { ok: false, reason: 'no-token' };
  }
  if (STATE.tokenExp && Date.now() > STATE.tokenExp) {
    STATE.collectionStatus='incomplete';STATE.lastError = 'token-expired';
    return { ok: false, reason: 'token-expired' };
  }
  if(Date.now()<rateLimitUntil){STATE.collectionStatus='rate-limited';return {ok:false,reason:'http-429'};}
  if(STATE.fetchCount>=(opts.final?10:8)||(!opts.final&&STATE.detailRead))return {ok:false,reason:'finished'};
  if (STATE.fetching) return { ok: false, reason: 'busy' };

  STATE.fetching = true;
  STATE.fetchCount++;
  const runId = STATE.runId, token = STATE.token, generation = BUS.generation, pageUrl=location.origin+location.pathname;
  const live=()=>STATE.runId===runId&&STATE.token===token&&generation===BUS.generation&&pageUrl===location.origin+location.pathname;
  const url = `${TRIGGER_API}/api/v1/runs/${runId}/events`;
  let timer;

  try {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;activeController=ctrl;
    timer = setTimeout(() => { if (ctrl) ctrl.abort(); }, timeoutMs);

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
      },
      credentials: 'omit',redirect:'error',cache:'no-store',
      signal: ctrl ? ctrl.signal : undefined,
    });
    if(!live())return {ok:false,reason:'superseded'};

    if (!res.ok) {
      STATE.lastError = `http-${res.status}`;
      STATE.collectionStatus=res.status===429?'rate-limited':'incomplete';
      if(res.status===429)rateLimitUntil=Date.now()+120000;
      return { ok: false, reason: `http-${res.status}` };
    }
    const text = await res.text();
    if(text.length>4*1024*1024)throw new Error('trace-too-large');
    if (STATE.runId !== runId || STATE.token !== token || generation !== BUS.generation) return { ok: false, reason: 'superseded' };
    const trace=JSON.parse(text),latest=newestTraceTurn(trace,runId);
    if(STATE.unknownTurnBaseline){
      const startedAt=traceTurnStartedAtMs(latest.events);
      // Without a sampled older turn, prove the latest numbered turn started
      // with this submission before allowing a settled USD record through.
      if(startedAt===null||startedAt<STATE.turnStartedAtMs-2000){
        STATE.collectionStatus='pending';return {ok:false,reason:'awaiting-current-turn'};
      }
      STATE.minTurn=latest.turn-1;
      STATE.unknownTurnBaseline=false;
    }
    if(latest.turn<=STATE.minTurn){STATE.collectionStatus='pending';return {ok:false,reason:'awaiting-current-turn'};}
    STATE.lastSeenTurn=Math.max(STATE.lastSeenTurn,latest.turn);
    const currentTrace={...trace,events:latest.events};
    const { models, tokens, reasoning, order, usage } = extractModelLabels(JSON.stringify(currentTrace));
    STATE.usage = usage;
    for (const config of reasoning) BUS.push({ source: 'reasoning.config', config, runId });

    STATE.lastFetchAt = Date.now();
    STATE.lastError = null;
    if(!STATE.detailRead||opts.final) {
      const automatic=await automaticDetail({trace:currentTrace,runId,token,url:pageUrl,generation,attempt:STATE.fetchCount,fetch,signal:ctrl?.signal,live});
      if(!live())return {ok:false,reason:'superseded'};
      if(automatic){
        STATE.automaticTrace=automatic;STATE.checkedAt=new Date().toISOString();
        const summary=automatic.summary;
        STATE.detailRead=summary.coverage==='complete';
        STATE.collectionStatus=summary.coverage==='ambiguous'?'multi':summary.coverage==='complete'?(summary.internalTier?'collected':'unprovided'):'incomplete';
        if(summary.routeConflict)STATE.collectionStatus='conflict';
        if(automatic.detail.stopped?.includes('429')){STATE.lastError='http-429';rateLimitUntil=Date.now()+120000;STATE.collectionStatus='rate-limited';}
      }else STATE.collectionStatus='pending';
    }

    if (models.length) {
      const uniq = [];
      for (const x of models) if (uniq.indexOf(x) < 0) uniq.push(x);
      const name = models[models.length - 1];   // 取最后一次调用的模型
      STATE.modelName = name;
      STATE.modelHistory.push({
        name,
        all: uniq,
        at: Date.now(),
        runId: STATE.runId,
        tokens: tokens.slice(-3),
      });
      if (STATE.modelHistory.length > 50) STATE.modelHistory.shift();
      return { ok: true, name, models: uniq, tokens: tokens.slice(-3), order };
    }
    return { ok: true, name: null, models: [], tokens };
  } catch (e) {
    if(!live())return {ok:false,reason:'superseded'};
    STATE.collectionStatus='incomplete';
    STATE.lastError = String((e && e.message) || e);
    return { ok: false, reason: STATE.lastError };
  } finally {
    clearTimeout(timer);
    if (STATE.runId === runId && generation === BUS.generation) STATE.fetching = false;
  }
}

/**
 * 轮询直到拿到模型名。
 *
 * 为什么需要轮询：run 的 trace 是渐进写入的 —— 提问后 worker 开始执行，
 * 模型调用完成后才会写入 ai.streamText.doStream span 及其标签。
 * 实测首次读取往往只有 17KB（尚无标签），稍后变成 24KB（含 qwen3.8-max-0902）。
 */
async function pollRunModels(opts = {}) {
  const maxMs = opts.maxMs || 180000;
  const intervalMs = opts.intervalMs || 6000;
  const t0 = Date.now();
  const runId = STATE.runId, generation = BUS.generation;
  let last = null;

  let wait = opts.firstIntervalMs || 1500;
  while (Date.now() - t0 < maxMs) {
    if (STATE.runId !== runId || BUS.generation !== generation) return { ok: false, reason: 'superseded' };
    last = await fetchRunModels(opts);
    if (last.ok && last.name) return last;
    if (['finished','token-expired','no-token','superseded','http-401','http-403','http-404','http-429'].includes(last.reason)) return last;
    // Short answers finish within seconds: start fast, back off gently to the configured interval.
    await new Promise(r => setTimeout(r, wait));
    wait = Math.min(intervalMs, Math.round(wait * 1.6));
  }
  return last || { ok: false, reason: 'timeout' };
}

/* ------------------------------------------------------------------ *
 * 与探针联动：把真实模型名作为最高权重证据回灌
 * ------------------------------------------------------------------ */
function pushModelEvidence(name, runId, detail) {
  if (!name) return false;
  BUS.push({
    source: 'run.trace.model',
    weight: 0.96,
    modelId: name,
    detail: detail || `Trigger.dev run ${runId || '?'} 的 streamText span 标签（worker 写入）`,
    t: (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  });
  return true;
}

/* ------------------------------------------------------------------ *
 * 自动编排：收到 token → 轮询 trace → 回灌模型名
 * ------------------------------------------------------------------ */
let autoStarted = false;
function startAutoResolve(opts = {}) {
  if (autoStarted) return;
  autoStarted = true;

  BUS.on(async (evt) => {
    if(evt.kind==='observation'&&evt.data?.complete&&!STATE.finalReadStarted&&STATE.token){
      STATE.finalReadStarted=true;
      const runId=STATE.runId,generation=BUS.generation;
      for(let i=0;i<3;i++){
        await new Promise(r=>setTimeout(r,i===0?500:i===1?2000:5000));
        if(runId!==STATE.runId||generation!==BUS.generation||Date.now()<rateLimitUntil)return;
        const result=await fetchRunModels({final:true});
        if(result.ok&&result.name){pushModelEvidence(result.name,runId);BUS.emit({kind:'run-model',data:{name:result.name,runId}});}
        if(['http-401','http-403','http-404','http-429','token-expired','superseded'].includes(result.reason))return;
      }
      return;
    }
    if (evt.kind !== 'run-token') return;
    const { runId } = evt.data || {};
    if (!runId) return;
    const generation = BUS.generation;

    // 延迟一点再开始，给 worker 时间执行模型调用
    await new Promise(r => setTimeout(r, Math.max(opts.initialDelayMs ?? 8000,rateLimitUntil-Date.now())));

    if (STATE.runId !== runId || BUS.generation !== generation) return;
    const r = await pollRunModels({
      maxMs: opts.maxMs || 180000,
      intervalMs: opts.intervalMs || 6000,
      firstIntervalMs: opts.firstIntervalMs || 1500,
    });
    if (STATE.runId !== runId || BUS.generation !== generation) return;
    if (r && r.ok && r.name) {
      pushModelEvidence(r.name, runId);
      BUS.emit({ kind: 'run-model', data: { name: r.name, runId, all: r.models } });
      // The name often arrives before usage. Continue bounded authorized reads.
      let lastName=r.name;
      for(let i=0;i<7;i++) {
        if(STATE.detailRead||STATE.fetchCount>=8)return;
        await new Promise(resolve=>setTimeout(resolve,i<2?2000:(opts.intervalMs||6000)));
        if(STATE.runId!==runId||BUS.generation!==generation)return;
        const next=await fetchRunModels();
        if(STATE.runId!==runId||BUS.generation!==generation)return;
        if(['finished','token-expired','no-token','superseded','http-401','http-403','http-404','http-429'].includes(next.reason))return;
        if(next.ok&&next.name){lastName=next.name;pushModelEvidence(next.name,runId);BUS.emit({kind:'run-model',data:{name:next.name,runId,all:next.models}});}
      }
    } else {
      BUS.emit({ kind: 'run-model-failed', data: { runId, reason: (r && r.reason) || 'unknown' } });
    }
  });
}
function reset(reason='reset') {
  BUS.monitor.lastReset=reason;BUS.mark('state-reset',reason);
  if(activeController)activeController.abort();activeController=null;
  STATE.finalReadStarted=false;STATE.lastSeenTurn=0;STATE.minTurn=0;STATE.unknownTurnBaseline=false;STATE.turnStartedAtMs=0;
  STATE.tokenUrl=null;STATE.collectionStatus=Date.now()<rateLimitUntil?"rate-limited":"pending";STATE.checkedAt=null;
  STATE.automaticTrace=null;STATE.detailRead=false;
  STATE.token = null;
  STATE.tokenExp = 0;
  STATE.fetching = false;
  STATE.fetchCount = 0;
  STATE.runId = null;
  STATE.modelName = null;
  STATE.usage = null;
  STATE.lastError = null;
  STATE.modelHistory.length = 0;
}

  exp.decodeJwt = decodeJwt;
  exp.runIdFromPayload = runIdFromPayload;
  exp.acceptToken = acceptToken;
  exp.beginRunTurn = beginRunTurn;
  exp.newestTraceTurn = newestTraceTurn;
  exp.state = state;
  exp.extractModelLabels = extractModelLabels;
  exp.fetchRunModels = fetchRunModels;
  exp.pollRunModels = pollRunModels;
  exp.pushModelEvidence = pushModelEvidence;
  exp.startAutoResolve = startAutoResolve;
  exp.reset = reset;
} };