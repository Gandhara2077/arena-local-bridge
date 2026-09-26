/* arena-model-probe v1.0.0 — 单文件注入版 (CDP / DevTools Snippet)
   本项目（arena-local-bridge）的一部分：由 src/probe/ 组装后经 addInitScript 注入到
   Playwright 页面，负责识别回答问题的真实模型名及其推理档位。它挂页面自身的网络钩子，
   直接读页面自己拉取的 trace，因此不需要 run token、不产生额外请求。 */
(function () {
"use strict";
var __mods = {}, __cache = {};
function __req(id) {
  if (__cache[id]) return __cache[id].exp;
  var m = __mods[id]; if (!m) throw new Error("module not found: " + id);
  var exp = {}; __cache[id] = { exp: exp };
  m.fn(exp);
  return exp;
}
__mods["reasoning"] = { fn: function (exp) {
/** Explicit configuration only. Model suffixes, timing and token counts are not effort evidence. */
const EFFORT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const SKIP = /^(?:messages?|parts|content|text|delta|prompt|input|output|choices|candidates|headers|token|authorization|apiKey|password|secret)$/i;
function extractReasoning(node, source = 'request', path = '$', depth = 0, out = []) {
  if (!node || typeof node !== 'object' || Array.isArray(node) || depth > 8 || out.length >= 60) return out;
  for (const [key, original] of Object.entries(node).slice(0, 200)) {
    const segments = key.split('.');
    if (segments.some(k => SKIP.test(k))) continue;
    const p = `${path}.${key}`, leaf = segments[segments.length - 1];
    const parent = p.split('.').slice(-2, -1)[0];
    let value = original;
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && 'stringValue' in value) value = value.stringValue;
    const direct = /^(reasoning_effort|reasoningEffort|thinkingLevel|thinking_level)$/.test(leaf);
    const nested = leaf === 'effort' && /^(reasoning|output_config|outputConfig)$/.test(parent);
    if ((direct || nested) && typeof value === 'string') {
      const level = value.trim().toLowerCase(), valid = EFFORT_LEVELS.includes(level);
      out.push({kind:'effort', level:valid ? level : null, raw:valid ? level : '[unsupported]', status:valid ? 'explicit' : 'unsupported', source, path:p});
    } else if (/^(thinkingBudget|thinking_budget|budget_tokens|budgetTokens)$/.test(leaf) && /^(thinking|thinkingConfig|thinking_config)$/.test(parent) && Number.isSafeInteger(value) && value >= -1) {
      out.push({kind:'budget', value, source, path:p});
    } else if (leaf === 'type' && parent === 'thinking' && ['enabled','disabled','adaptive'].includes(value)) {
      out.push({kind:'mode', value, source, path:p});
    } else {
      // Only decode known configuration containers, never arbitrary text or payloads.
      if (typeof value === 'string' && /^(providerOptions|provider_options|thinking|thinkingConfig|thinking_config|reasoning|output_config|outputConfig)$/.test(leaf) && value.length <= 65536) {
        try { value = JSON.parse(value); } catch { value = null; }
      }
      if (value && typeof value === 'object') extractReasoning(value, source, p, depth + 1, out);
    }
    if (out.length >= 60) break;
  }
  return out;
}
function summarizeReasoning(evidence = []) {
  const items = evidence.filter(e => e && e.source === 'reasoning.config' && !e.stale).map(e => e.config).filter(Boolean);
  const efforts = items.filter(e => e.kind === 'effort');
  const levels = [...new Set(efforts.filter(e => EFFORT_LEVELS.includes(e.level)).map(e => e.level))];
  const unsupported = efforts.some(e => !EFFORT_LEVELS.includes(e.level));
  const status = levels.length > 1 ? 'conflict' : unsupported ? 'unsupported' : levels.length ? 'explicit' : 'unknown';
  const budgets = [...new Set(items.filter(e => e.kind === 'budget' && Number.isSafeInteger(e.value) && e.value >= -1).map(e => e.value))];
  const modes = [...new Set(items.filter(e => e.kind === 'mode' && ['enabled','disabled','adaptive'].includes(e.value)).map(e => e.value))];
  const budgetText = budgets.map(v => v === -1 ? '自动 (-1)' : v === 0 ? '关闭 (0)' : String(v)).join(' / ');
  return {status, level:status === 'explicit' ? levels[0] : null,
    display:status === 'explicit' ? levels[0] + '（显式）' : status === 'conflict' ? '冲突：' + levels.join(' / ') : status === 'unsupported' ? '不支持的配置值' : '未知（未提供显式档位）',
    budgetText, modes, evidence:items.slice(-12),
    note:'显式配置不代表实际计算量；预算与开关不换算为档位，型号后缀不作为显式强度。' };
}

  exp.EFFORT_LEVELS = EFFORT_LEVELS;
  exp.extractReasoning = extractReasoning;
  exp.summarizeReasoning = summarizeReasoning;
} };
// USD snapshot adapter. Pure, allowlisted; no network, credentials or persistence.
__mods["usd-quota"] = { fn: function (exp) {
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  const label = s => typeof s === 'string' && s.length <= 120 && !/[\u0000-\u001f\u007f]/.test(s) && !/Bearer |^eyJ/.test(s) ? s : null;
  function extract(detail) {
    const spans = Array.isArray(detail?.spans) ? detail.spans.slice(0,24) : [];
    const turns = spans.map(s=>s?.turn).filter(n=>Number.isSafeInteger(n)&&n>0);
    const turn = turns.length ? Math.max(...turns) : null;
    const checkedAt = typeof detail?.checkedAt === 'string' && detail.checkedAt.length <= 40 && Number.isFinite(Date.parse(detail.checkedAt)) ? detail.checkedAt : null;
    const result = {turn,checkedAt,status:'unavailable',quota:null};
    if (!turn || !checkedAt) return result;
    // Never fall back to an older turn when the newest turn lacks a settled charge.
    const costs = spans.filter(s=>s?.turn===turn&&s.kind==='cost');
    const last = costs[costs.length-1];
    if (!last || last.partial !== false || detail.limited || detail.stopped) return result;
    const v = last.values || {};
    if (!finite(v.allowanceUsd) || v.allowanceUsd < 0 || !finite(v.balanceRemainingUsd)) return result;
    result.status = 'ready';
    result.quota = {
      allowanceUsd:v.allowanceUsd, balanceRemainingUsd:v.balanceRemainingUsd,
      chargedUserTotalUsd:finite(v.chargedUserTotalUsd)&&v.chargedUserTotalUsd>=0 ? v.chargedUserTotalUsd : null,
      allowanceTier:label(v.allowanceTier),allowanceSource:label(v.allowanceSource),
      windowStartAtMs:Number.isSafeInteger(v.windowStartAtMs)&&v.windowStartAtMs>=0&&v.windowStartAtMs<=8640000000000000 ? v.windowStartAtMs : null,
      overLimit:typeof v.overLimit==='boolean'?v.overLimit:null
    };
    return result;
  }
  function select(run, desktop, url, generation) {
    const empty={status:'unavailable',quota:null,checkedAt:null,turn:null};
    if (!/^https:\/\/arena\.ai\/agent\/[0-9a-f-]{36}\/?$/i.test(url)||!run?.runId) return empty;
    const candidates=[];
    for(const x of [run.automaticTrace,desktop]) {
      if(!x||x.url!==url||x.runId!==run.runId||x.generation!==generation)continue;
      const snapshot=x.quotaSnapshot||extract(x.detail);
      if(!snapshot.turn||snapshot.turn<=(run.minTurn||0))continue;
      candidates.push(snapshot);
    }
    candidates.sort((a,b)=>b.turn-a.turn||(Date.parse(b.checkedAt)||0)-(Date.parse(a.checkedAt)||0));
    const s=candidates[0];
    if(!s||s.turn<(run.lastSeenTurn||0))return empty;
    return {...s,quota:s.quota?{...s.quota}:null,warning:run.lastError?'最近采集失败，此金额可能滞后':null};
  }
  exp.extract=extract;exp.select=select;
} };

__mods["trace-summary"] = { fn: function (exp) {
  var EFFORT_LEVELS = __req("reasoning").EFFORT_LEVELS;
  var summarizeReasoning = __req("reasoning").summarizeReasoning;
/** Shared, allowlisted Trace-to-desktop facts. No network or storage. */
const REASONING_SOURCES = ['ai.usage.reasoningTokens','providerMetadata.anthropic.usage.output_tokens_details.thinking_tokens','providerMetadata.vertex.usageMetadata.thoughtsTokenCount'];
const count = v => Number.isSafeInteger(v) && v >= 0 ? v : null;
const label = v => typeof v === 'string' && v.length <= 200 && !/[\u0000-\u001f\u007f]/.test(v) && !/Bearer |^eyJ/.test(v) ? v : null;
function reasoningSource(v) { return typeof v === 'string' && v.split(' / ').every(p=>REASONING_SOURCES.includes(p)) ? v : null; }
function observedReasoning(values = {}, meta = {}) {
 const readings=[];
 const add=(value,source)=>{if(count(value)!==null)readings.push({value,source});};
 add(values.reasoningTokens,reasoningSource(values.reasoningSource)||REASONING_SOURCES[0]);
 add(meta['anthropic.usage.output_tokens_details.thinking_tokens'],REASONING_SOURCES[1]);
 add(meta['vertex.usageMetadata.thoughtsTokenCount'],REASONING_SOURCES[2]);
 const counts=[...new Set(readings.map(r=>r.value))], conflict=values.reasoningConflict===true||counts.length>1;
 return {status:conflict?'conflict':counts.length?counts[0]>0?'reported-positive':'reported-zero':'unavailable',tokens:!conflict&&counts.length?counts[0]:null,source:[...new Set(readings.flatMap(r=>r.source.split(' / ')))].join(' / '),evidence:readings};
}
function applyReasoningUsage(span) {
 if(span.kind!=='stream')return span;
 const r=observedReasoning(span.values,span.providerMeta);
 if(r.tokens!==null)span.values.reasoningTokens=r.tokens;
 if(r.source)span.values.reasoningSource=r.source;
 if(r.status==='conflict')span.values.reasoningConflict=true;
 return span;
}
function detailReadiness(trace,runId) {
 let latest=[];
 for(const e of Array.isArray(trace?.events)?trace.events:[]) {
  if(e?.runId!==runId)continue;
  if(/^chat turn \d+$/.test(e.message||'')){latest=[];continue;}
  if(['ai.streamText.doStream','token.usage.recorded','spend.recorded'].includes(e.message))latest.push(e);
 }
 return latest.length>0 && latest.every(e=>e.isPartial===false) && ['ai.streamText.doStream','token.usage.recorded','spend.recorded'].every(k=>latest.some(e=>e.message===k));
}
// Only remove an observed, allowlisted deployment suffix. Never infer effort from token counts.
function internalTierFromModels(internalModel, requestModel) {
 if(!label(internalModel)||!label(requestModel))return null;
 const internal=internalModel.replace(/-vertex$/i,''),request=requestModel.replace(/-vertex$/i,'');
 if(internal.toLowerCase()===request.toLowerCase())return null;
 const match=/-(none|minimal|low|medium|high|xhigh|max)$/i.exec(internal);
 return match?match[1].toLowerCase():null;
}
function latestTraceSummary(detail) {
 const spans=[],seen=new Set();
 for(const s of Array.isArray(detail?.spans)?detail.spans.slice(0,24):[]){if(!/^[a-f0-9]{16,32}$/.test(s?.spanId||'')||seen.has(s.spanId)||!['stream','usage','cost'].includes(s.kind))continue;seen.add(s.spanId);spans.push(s);}
 const turns=spans.map(s=>s.turn).filter(n=>Number.isSafeInteger(n)&&n>0),turn=turns.length?Math.max(...turns):null;
 const current=spans.filter(s=>s.turn===turn),streams=current.filter(s=>s.kind==='stream');
 const usageRows=current.filter(s=>s.kind==='usage'),costRows=current.filter(s=>s.kind==='cost');
 const messageIds=new Set([...usageRows,...costRows].map(s=>s.values?.messageId).filter(Boolean));
 const collectionLimited=!!(detail?.limited||detail?.stopped||(Array.isArray(detail?.spans)&&detail.spans.length>24));
 const calls=streams.map(s=>{
   const v=s.values||{},input=count(v.inputTokens),output=count(v.outputTokens),total=count(v.totalTokens);
   const reasoning=observedReasoning(v,s.providerMeta||{});
   return {spanId:s.spanId,requestModel:label(v.apiModelName||v.requestModel||v.apiModelId),responseModel:label(v.responseModel||v.genResponseModel),partial:s.partial!==false,
     modelProvider:label(v.modelProvider),protocolProvider:label(v.provider),reasoningStatus:reasoning.status,
     usage:{input:input!==null?input:total!==null&&output!==null&&total>=output?total-output:null,output,reasoning:reasoning.tokens,cachedInput:count(v.cacheReadTokens)}};
 });
 const ambiguous=streams.length>1||usageRows.length>1||costRows.length>1||messageIds.size>1;
 if(ambiguous||turn===null||streams.length!==1||streams[0].partial!==false)return {calls,collectionLimited,checkedAt:label(detail?.checkedAt),coverage:ambiguous?'ambiguous':'partial',turn,usage:null,observation:observedReasoning(),configs:[],internalModel:null,internalTier:null,spanIds:[]};
 const stream=streams[0],v=stream.values||{},usageSpans=current.filter(s=>s.kind==='usage'&&s.partial===false),costSpans=current.filter(s=>s.kind==='cost'&&s.partial===false);
 const one=(list,key)=>{const vals=[...new Set(list.map(s=>s.values?.[key]).filter(v=>v!==undefined&&v!==null))];return vals.length===1?vals[0]:null;};
 const observation=observedReasoning(v,stream.providerMeta||{});
 const recordedReasoning=count(one(usageSpans,'reasoningTokens'));
 if(recordedReasoning!==null){if(observation.tokens!==null&&recordedReasoning!==observation.tokens){observation.status='conflict';observation.tokens=null;}else if(observation.status==='unavailable'){observation.tokens=recordedReasoning;observation.status=recordedReasoning>0?'reported-positive':'reported-zero';}observation.source+=(observation.source?' / ':'')+'token.usage.recorded.reasoningTokens';}
 const input=count(v.inputTokens),output=count(v.outputTokens),total=count(v.totalTokens);
 const usage={input:input!==null?input:total!==null&&output!==null&&total>=output?total-output:null,output,total,reasoning:observation.tokens,cachedInput:count(one(usageSpans,'cacheReadTokens')),source:'run.span',scope:'same-run-latest-single-call',turn,spanId:stream.spanId};
 const internalModel=label(one([...usageSpans,...costSpans],'modelName'));
 const requestModel=label(v.apiModelName||v.requestModel||v.apiModelId);
 // A suffix also present in the request model (e.g. qwen3.8-max) is part of that model, not an observed configuration difference.
 const tier=internalTierFromModels(internalModel,requestModel);
 const routeValues=[...new Set([label(v.modelProvider),label(one(usageSpans,'provider'))].filter(Boolean))];
 const modelProvider=routeValues.length===1?routeValues[0]:null,routeConflict=routeValues.length>1;
 const protocolProvider=label(v.provider),responseModel=label(v.responseModel||v.genResponseModel);
 // An internal-name hint is not an explicit reasoning configuration and must not drive renaming.
 const hintMatch=internalModel&&/^(.*)-(none|minimal|low|medium|high|xhigh|max)-agent$/i.exec(internalModel);
 const normalize=s=>(s||'').toLowerCase().replace(/[._]/g,'-');
 const internalNameHint=hintMatch&&normalize(hintMatch[1])===normalize(requestModel)?hintMatch[2].toLowerCase():null;
 const configs=[];
 for(const e of Array.isArray(stream.reasoning)?stream.reasoning.slice(0,60):[]){
  if(e?.kind==='effort')configs.push({kind:'effort',level:EFFORT_LEVELS.includes(e.level)?e.level:null,source:'run.span'});
  if(e?.kind==='budget'&&Number.isSafeInteger(e.value)&&e.value>=-1)configs.push({kind:'budget',value:e.value,source:'run.span'});
  if(e?.kind==='mode'&&['enabled','disabled','adaptive'].includes(e.value))configs.push({kind:'mode',value:e.value,source:'run.span'});
 }
 return {calls,collectionLimited,coverage:detail?.limited||detail?.stopped||!usageSpans.length||!costSpans.length?'partial':'complete',turn,usage,observation,configs,internalModel,internalTier:tier,internalNameHint,requestModel,responseModel,modelProvider,protocolProvider,routeConflict,spanIds:current.map(s=>s.spanId),checkedAt:label(detail?.checkedAt)};
}
function desktopFacts(run,observations,evidence,detail) {
 const u=run?.usage,x=observations?.[observations.length-1];
 const numeric=v=>v&&(count(v.input)!==null||count(v.output)!==null||count(v.total)!==null||count(v.reasoning)!==null);
 const response=x?{input:count(x.promptTokens),output:count(x.completionTokens),reasoning:count(x.reasoningTokens),source:'response',scope:'latest-response'}:null;
 let usage=numeric(u)?u:numeric(response)?response:u||response;
 if(detail?.usage)usage=detail.usage; // whole same-call record, never mix prior-run counters.
 const configs=detail?.configs||[];
 const effort=summarizeReasoning([...(evidence||[]),...configs.map(config=>({source:'reasoning.config',config}))]);
 const fallback=observedReasoning({reasoningTokens:usage?.reasoning});
 if(fallback.tokens!==null)fallback.source=usage?.source||'response';
 const coverage=detail?.coverage||'no-detail';
  const collectionStatus=['rate-limited','incomplete'].includes(run?.collectionStatus)?run.collectionStatus:coverage==='ambiguous'?'multi':detail?.routeConflict?'conflict':coverage==='complete'?(detail.internalTier?'collected':'unprovided'):coverage==='partial'?'incomplete':run?.fetchCount>=8?'incomplete':run?.collectionStatus||'pending';
  return {collectionStatus,checkedAt:run?.checkedAt||detail?.checkedAt||null,usage,effort,observation:detail?.observation||fallback,internalModel:detail?.internalModel||null,internalTier:detail?.internalTier||null,internalNameHint:detail?.internalNameHint||null,requestModel:detail?.requestModel||null,responseModel:detail?.responseModel||null,modelProvider:detail?.modelProvider||null,protocolProvider:detail?.protocolProvider||null,routeConflict:detail?.routeConflict===true,coverage:detail?.coverage||'no-detail',traceDetail:detail?{calls:detail.calls||[],turn:detail.turn,spanIds:detail.spanIds,checkedAt:detail.checkedAt}:null};
}

  exp.REASONING_SOURCES = REASONING_SOURCES;
  exp.reasoningSource = reasoningSource;
  exp.observedReasoning = observedReasoning;
  exp.applyReasoningUsage = applyReasoningUsage;
  exp.detailReadiness = detailReadiness;
  exp.internalTierFromModels = internalTierFromModels;
  exp.latestTraceSummary = latestTraceSummary;
  exp.desktopFacts = desktopFacts;
} };
__mods["agent-detail"] = { fn: function (exp) {
  var applyReasoningUsage = __req("trace-summary").applyReasoningUsage;
  var reasoningSource = __req("trace-summary").reasoningSource;
  var extractReasoning = __req("reasoning").extractReasoning;


/* Agent span detail: three model-name layers, call settings, usage and cost semantics from span properties.
   Whitelist only. Never stores tokens, prompts, message text, reasoning text or raw span payloads. */
const SPAN_KINDS = {'ai.streamText.doStream': 'stream', 'token.usage.recorded': 'usage', 'spend.recorded': 'cost'};
const TURN = /^chat turn (\d{1,4})$/;
const DETAIL_LIMITS = {turns: 6, spans: 24};
const spanId = v => typeof v === 'string' && /^[a-f0-9]{16,32}$/.test(v) ? v : null;
const label = v => typeof v === 'string' && v.length <= 200 && !/[\u0000-\u001f\u007f]/.test(v) && !v.includes('Bearer ') && !/^eyJ[^ ]+\.[^ ]+\./.test(v) ? v : null;
const count = v => Number.isSafeInteger(v) && v >= 0 ? v : null;
const amount = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const number = v => typeof v === 'number' && Number.isFinite(v) ? v : null;
const flag = v => typeof v === 'boolean' ? v : null;
const id = v => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(v) ? v : null;

// Trigger.dev returns properties either nested (properties.ai.model.id) or flat ('ai.model.id'); accept both.
function get(props, path) {
  if (!props || typeof props !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(props, path)) return props[path];
  let cur = props;
  for (const part of path.split('.')) { if (!cur || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, part)) return undefined; cur = cur[part]; }
  return cur;
}
const FIELDS = {
  stream: {
    apiModelId: ['ai.model.id', label], provider: ['ai.model.provider', label], responseModel: ['ai.response.model', label],
    modelProvider: ['ai.telemetry.metadata.modelProvider', label], apiModelName: ['ai.telemetry.metadata.apiModelName', label], requestModel: ['gen_ai.request.model', label], genResponseModel: ['gen_ai.response.model', label],
    reasoningSource: ['__derived.reasoningSource', reasoningSource], reasoningConflict: ['__derived.reasoningConflict', flag],
    temperature: ['ai.settings.temperature', number], maxOutputTokens: ['ai.settings.maxOutputTokens', count], topP: ['ai.settings.topP', number],
    finishReason: ['ai.response.finishReason', label], responseId: ['ai.response.id', label],
    inputTokens: ['ai.usage.inputTokens', count], outputTokens: ['ai.usage.outputTokens', count], totalTokens: ['ai.usage.totalTokens', count], reasoningTokens: ['ai.usage.reasoningTokens', count]
  },
  usage: {
    modelName: ['modelName', label], provider: ['provider', label], usageSource: ['usageSource', label], messageId: ['messageId', id],
    inputTokens: ['inputTokens', count], outputTokens: ['outputTokens', count], totalTokens: ['totalTokens', count], reasoningTokens: ['reasoningTokens', count], cacheReadTokens: ['cacheReadTokens', count], cacheWriteTokens: ['cacheWriteTokens', count]
  },
  cost: {
    modelName: ['modelName', label], messageId: ['messageId', id], costUsd: ['costUsd', amount], effectiveCostUsd: ['effectiveCostUsd', amount], chargedUsd: ['chargedUsd', amount], effectiveChargedUsd: ['effectiveChargedUsd', amount],
    pricingStrategy: ['pricingStrategy', label], costSource: ['costSource', label], costKind: ['costKind', label], costIsFallback: ['costIsFallback', flag], costIsLongContext: ['costIsLongContext', flag], unpriced: ['unpriced', flag],
    allowanceUsd:['allowanceUsd',amount], balanceRemainingUsd:['balanceRemainingUsd',number], chargedUserTotalUsd:['chargedUserTotalUsd',amount], allowanceTier:['allowanceTier',label], allowanceSource:['allowanceSource',label], windowStartAtMs:['windowStartAtMs',count], overLimit:['overLimit',flag]
  }
};
// Keys whose presence (not value) is worth knowing when hunting for reasoning-effort style settings.
// providerMetadata: structure only. Keys, numbers, booleans and short enum-like strings (<=40 chars, no spaces/newlines). Never long text.
const META_LIMITS = {depth: 4, entries: 60, string: 40};
const TEXT_KEY = /text|content|message|prompt|reasoning_content|thinking_text|signature|redacted|encrypted|data|blob|payload|citation/i;
const SECRET_KEY = /authorization|cookie|credential|secret|password|api.?key|access.?token|refresh.?token|(?:^|[._])token(?:$|[._])/i;
function metaShape(value, depth = 0, out = {}, prefix = '', budget = {n: META_LIMITS.entries}) {
  if (!value || typeof value !== 'object' || depth > META_LIMITS.depth) return out;
  for (const [k, v] of Object.entries(value)) {
    if (budget.n <= 0) break;
    const key = (prefix ? prefix + '.' : '') + String(k).slice(0, 60);
    if (SECRET_KEY.test(k)) {out[key]='<redacted>';budget.n--;continue;}
    if (k === 'usageMetadata' && prefix === 'vertex' && v && typeof v === 'object' && !Array.isArray(v)) {
      for (const field of ['thoughtsTokenCount','promptTokenCount','candidatesTokenCount','totalTokenCount','cachedContentTokenCount']) {if (budget.n > 0 && count(v[field]) !== null) {out[key+'.'+field]=v[field];budget.n--;}}
      continue;
    }
    if (TEXT_KEY.test(k)) { out[key] = '<' + (Array.isArray(v) ? 'array' : typeof v) + '>'; budget.n--; continue; }
    if (v && typeof v === 'object') { if (Array.isArray(v)) { out[key] = '<array:' + v.length + '>'; budget.n--; } else if (!Object.keys(v).length) { out[key] = '<empty>'; budget.n--; } else metaShape(v, depth + 1, out, key, budget); continue; }
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
    else if (typeof v === 'boolean' || v === null) out[key] = v;
    else if (typeof v === 'string') out[key] = v.length <= META_LIMITS.string && !/\s/.test(v) && !/^eyJ/.test(v) ? v : '<string:' + v.length + '>';
    else continue;
    budget.n--;
  }
  return out;
}
const SETTING_HINTS = ['ai.settings.providerOptions', 'ai.prompt.providerOptions', 'ai.response.providerMetadata', 'ai.settings.reasoningEffort', 'ai.settings.thinking', 'gen_ai.request.reasoning_effort'];
function selectDetailSpans(trace, runId, limits = DETAIL_LIMITS) {
  if (!Array.isArray(trace?.events)) throw new Error('trace 格式不符合预期');
  const turns = [];
  let current = null;
  for (const e of trace.events) {
    if (e?.runId !== runId || typeof e.message !== 'string') continue;
    const turnMatch = e.message.match(TURN);
    if (turnMatch) { current = {turn: Number(turnMatch[1]), spans: []}; turns.push(current); continue; }
    const kind = SPAN_KINDS[e.message];
    if (!kind) continue;
    if (!spanId(e.spanId)) throw new Error('span ID 无效');
    if (!current) { current = {turn: null, spans: []}; turns.push(current); }
    current.spans.push({spanId: e.spanId, kind, message: e.message, partial: e.isPartial !== false});
  }
  const withSpans = turns.filter(t => t.spans.length);
  const kept = withSpans.slice(-limits.turns);
  const selected = kept.flatMap(t => t.spans.map(s => ({...s, turn: t.turn}))).slice(-limits.spans);
  return {selected, turnCount: withSpans.length, limited: withSpans.length > kept.length || kept.reduce((n, t) => n + t.spans.length, 0) > selected.length};
}
function parseDetailSpan(detail, event, runId) {
  if (detail?.runId !== runId || detail.spanId !== event.spanId || detail.message !== event.message) throw new Error('span 与运行不匹配');
  const props = detail.properties && typeof detail.properties === 'object' ? detail.properties : {};
  const values = {};
  for (const [name, [path, clean]] of Object.entries(FIELDS[event.kind])) { const v = clean(get(props, path)); if (v !== null && v !== undefined) values[name] = v; }
  const hints = event.kind === 'stream' ? SETTING_HINTS.filter(p => get(props, p) !== undefined) : [];
  const out = {spanId: event.spanId, kind: event.kind, turn: Number.isSafeInteger(event.turn) && event.turn > 0 ? event.turn : null, partial: event.partial || detail.isPartial !== false, values, settingKeys: hints};
  if (event.kind === 'stream') {
    out.reasoning = extractReasoning(props, 'run.span');
    const promptOptions = get(props, 'ai.prompt.providerOptions');
    if (promptOptions !== undefined) out.reasoning.push(...extractReasoning({providerOptions:promptOptions}, 'run.span'));
    let meta = get(props, 'ai.response.providerMetadata');
    if (typeof meta === 'string' && meta.length < 65536) { try { meta = JSON.parse(meta); } catch { meta = null; } }
    if (meta && typeof meta === 'object') out.providerMeta = metaShape(meta);
    const opts = get(props, 'ai.settings.providerOptions') ?? get(props, 'ai.prompt.providerOptions');
    let o = opts; if (typeof o === 'string' && o.length < 65536) { try { o = JSON.parse(o); } catch { o = null; } }
    if (o && typeof o === 'object') out.providerOptions = metaShape(o);
  }
  return applyReasoningUsage(out);
}
function sanitizeDetail(input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.spans)) return null;
  const seen = new Set(), spans = [];
  for (const s of input.spans) {
    if (spans.length >= DETAIL_LIMITS.spans) break;
    if (!spanId(s?.spanId) || seen.has(s.spanId) || !['stream', 'usage', 'cost'].includes(s.kind)) continue;
    seen.add(s.spanId);
    const values = {};
    for (const [name, [, clean]] of Object.entries(FIELDS[s.kind])) { const v = clean(s.values?.[name]); if (v !== null && v !== undefined) values[name] = v; }
    const entry = {spanId: s.spanId, kind: s.kind, turn: count(s.turn) && s.turn > 0 ? s.turn : null, partial: s.partial !== false, values, settingKeys: Array.isArray(s.settingKeys) ? s.settingKeys.filter(k => SETTING_HINTS.includes(k)) : []};
    for (const name of ['providerMeta', 'providerOptions']) { const m = s[name]; if (m && typeof m === 'object' && !Array.isArray(m)) { const clean = {}; let n = 0; for (const [k, v] of Object.entries(m)) { if (n++ >= META_LIMITS.entries) break; if (typeof k !== 'string' || k.length > 250) continue; if(SECRET_KEY.test(k)){clean[k]='<redacted>';continue;} if (typeof v === 'number' && Number.isFinite(v) || typeof v === 'boolean' || v === null) clean[k] = v; else if (typeof v === 'string' && v.length <= META_LIMITS.string && !/\s/.test(v) && !/^eyJ/.test(v) || typeof v === 'string' && /^<[a-z]+(:\d+)?>$/.test(v)) clean[k] = v; } if (Object.keys(clean).length) entry[name] = clean; } }
    if (s.kind === 'stream' && Array.isArray(s.reasoning)) entry.reasoning = s.reasoning.slice(0,60).filter(e => e && ['effort','budget','mode'].includes(e.kind)).flatMap(e => {
      const config = e.kind === 'effort' ? {reasoning_effort:e.level || '[unsupported]'} : e.kind === 'budget' ? {thinking:{budget_tokens:e.value}} : {thinking:{type:e.value}};
      return extractReasoning(config, 'run.span');
    });
    spans.push(applyReasoningUsage(entry));
  }
  const time = typeof input.checkedAt === 'string' && input.checkedAt.length <= 40 && Number.isFinite(Date.parse(input.checkedAt)) ? input.checkedAt : null;
  return {schemaVersion: 1, checkedAt: time, spans, limited: input.limited === true, stopped: label(input.stopped) || null, turnCount: count(input.turnCount)};
}

// Reads span details for one run. Stops (does not retry) on 429 or any non-200 and reports what was read so far.
async function readAgentDetail({fetch: doFetch, runId, token, trace, signal, checkedAt = new Date().toISOString(), delayMs = 250, wait = ms => new Promise(r => setTimeout(r, ms))}) {
  const selection = selectDetailSpans(trace, runId);
  const spans = [];
  let stopped = null;
  for (const [i, event] of selection.selected.entries()) {
    if (i) await wait(delayMs);
    const response = await doFetch('https://api.trigger.dev/api/v1/runs/' + encodeURIComponent(runId) + '/spans/' + encodeURIComponent(event.spanId), {
      method: 'GET', headers: {Authorization: 'Bearer ' + token, Accept: 'application/json'}, credentials: 'omit', redirect: 'error', cache: 'no-store', signal
    });
    if (response.status === 429) { stopped = '接口限流（HTTP 429），已停止读取 span 详情'; break; }
    if (!response.ok) { stopped = 'span 详情返回 HTTP ' + response.status + '，已停止'; break; }
    const text = await response.text();
    if (text.length > 512 * 1024) { stopped = 'span 详情超过 512 KB，已停止'; break; }
    spans.push(parseDetailSpan(JSON.parse(text), event, runId));
  }
  return sanitizeDetail({checkedAt, spans, limited: selection.limited, stopped, turnCount: selection.turnCount});
}

  exp.DETAIL_LIMITS = DETAIL_LIMITS;
  exp.metaShape = metaShape;
  exp.selectDetailSpans = selectDetailSpans;
  exp.parseDetailSpan = parseDetailSpan;
  exp.sanitizeDetail = sanitizeDetail;
  exp.readAgentDetail = readAgentDetail;
} };
__mods["automatic-trace"] = { fn: function (exp) {
  var readAgentDetail = __req("agent-detail").readAgentDetail;
  var detailReadiness = __req("trace-summary").detailReadiness;
  var latestTraceSummary = __req("trace-summary").latestTraceSummary;
function automaticScope(payload,url) {
 const session=/^https:\/\/arena\.ai\/agent\/([0-9a-f-]{36})\/?$/.exec(url||'')?.[1];
 const scopes=Array.isArray(payload?.scopes)?payload.scopes:[];
 const runs=scopes.filter(s=>typeof s==='string'&&/^read:runs:run_[A-Za-z0-9_-]+$/.test(s));
 return !!session&&payload?.pub===true&&payload.iss==='https://id.trigger.dev'&&[payload.aud].flat().includes('https://api.trigger.dev')&&Number.isFinite(payload.exp)&&payload.exp*1000>Date.now()&&runs.length===1&&scopes.includes('read:sessions:'+session);
}
async function automaticDetail({trace,runId,token,url,generation,attempt,fetch:doFetch,signal,live}) {
 if(!live())return null;
 if(!detailReadiness(trace,runId)&&attempt<8)return null;
 // Read only the newest numbered turn. Earlier charges have already been persisted, not reread.
 let events=[],found=false;
 for(const e of trace?.events||[]){if(e?.runId!==runId)continue;if(/^chat turn \d+$/.test(e.message||'')){events=[];found=true;}if(found)events.push(e);}
 if(!events.length)return null;
 const detail=await readAgentDetail({trace:{events},runId,token,signal,fetch:async(u,o)=>{
  if(!live())throw new Error('superseded');
  return doFetch(u,o);
 }});
 if(!live())return null;
 return {url,runId,generation,detail,summary:latestTraceSummary(detail)};
}

  exp.automaticScope = automaticScope;
  exp.automaticDetail = automaticDetail;
} };
__mods["trace-parser"] = { fn: function (exp) {
  var extractReasoning = __req("reasoning").extractReasoning;
/** Structured span parsing. Names are recorded labels, not weight-level identity proof. */

function jsonDocuments(text) {
  try { return [JSON.parse(text)]; } catch { /* concatenated JSON / SSE */ }
  const result = []; let start = -1, depth = 0, quoted = false, escape = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (start < 0) { if (c === '{' || c === '[') { start = i; depth = 1; } continue; }
    if (quoted) { if (escape) escape = false; else if (c === '\\') escape = true; else if (c === '"') quoted = false; continue; }
    if (c === '"') quoted = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') { if (--depth === 0) { try { result.push(JSON.parse(text.slice(start, i + 1))); } catch {} start = -1; } }
  }
  return result;
}
// Only read usage metadata on the selected model invocation, never answer text.
function spanUsage(span, labels = []) {
  const a = span.attributes || {}, u = span.usage || a.usage || {};
  const read = (...values) => {
    for (let v of values) {
      if (v && typeof v === 'object') v = v.intValue ?? v.doubleValue ?? v.stringValue;
      if (typeof v === 'string' && /^\d+$/.test(v)) v = Number(v);
      if (Number.isSafeInteger(v) && v >= 0) return v;
    }
    return null;
  };
  const input = read(a['ai.usage.promptTokens'], a['ai.usage.inputTokens'], a['gen_ai.usage.input_tokens'], a['llm.token_count.prompt'], u.input_tokens, u.prompt_tokens, u.inputTokens, u.promptTokens);
  const output = read(a['ai.usage.completionTokens'], a['ai.usage.outputTokens'], a['gen_ai.usage.output_tokens'], a['llm.token_count.completion'], u.output_tokens, u.completion_tokens, u.outputTokens, u.completionTokens);
  const cachedInput = read(a['gen_ai.usage.cache_read.input_tokens'], a['ai.usage.cachedInputTokens'], u.input_tokens_details?.cached_tokens, u.prompt_tokens_details?.cached_tokens, u.cachedInputTokens);
  const reasoning = read(a['gen_ai.usage.reasoning_tokens'], u.output_tokens_details?.reasoning_tokens, u.completion_tokens_details?.reasoning_tokens, u.reasoningTokens);
  let total = read(a['ai.usage.totalTokens'], a['gen_ai.usage.total_tokens'], u.total_tokens, u.totalTokens);
  if (total === null && input !== null && output !== null) total = input + output;
  const totalLabel = labels.find(x => /^\d+(?:\.\d+)?\s*[kKmM]?$/.test(x.trim())) || null;
  return {input, output, cachedInput, reasoning, total, totalLabel, source:'run.trace', scope:'latest-model-invocation'};
}
function parseTrace(text) {
  const spans = [];
  const visit = (obj, depth = 0) => {
    if (!obj || typeof obj !== 'object' || depth > 24) return;
    if (Array.isArray(obj)) { obj.forEach(x => visit(x, depth + 1)); return; }
    if (/^ai\.(?:streamText\.doStream|generateText\.doGenerate)$/.test(obj.message || obj.name || '')) {
      const items = obj.style?.accessory?.items || [];
      const models = items.filter(x => /cube/.test(x.icon || '') && typeof x.text === 'string').map(x => x.text.slice(0,120));
      const tokens = items.filter(x => /hash/.test(x.icon || '') && typeof x.text === 'string').map(x => x.text);
      const reasoning = [...extractReasoning(obj.attributes || {}, 'run.trace', '$.attributes'), ...extractReasoning(obj.properties || {}, 'run.trace', '$.properties')];
      spans.push({ models, tokens, reasoning, usage:models.length?{...spanUsage(obj,tokens),model:models[models.length-1]}:null, time: /^\d+$/.test(String(obj.startTime || '')) ? BigInt(obj.startTime) : null });
      return;
    }
    for (const [key, value] of Object.entries(obj)) {
      if (!/^(?:input|output|prompt|messages|content|text|payload)$/.test(key)) visit(value, depth + 1);
    }
  };
  if (typeof text === 'string') jsonDocuments(text).forEach(x => visit(x));
  const ordered = spans.length > 0 && spans.every(x => x.time !== null);
  if (ordered) spans.sort((a,b) => a.time < b.time ? -1 : a.time > b.time ? 1 : 0);
  return { models: spans.flatMap(x => x.models), tokens: spans.flatMap(x => x.tokens),
    usage:spans.length?spans[spans.length-1].usage:null, reasoning: spans.flatMap(x => x.reasoning), order: ordered ? 'timestamp' : 'document' };
}

  exp.spanUsage = spanUsage;
  exp.parseTrace = parseTrace;
} };
__mods["native-capture"] = { fn: function (exp) {
  var captureRunHeaders = __req("interceptor").captureRunHeaders;
  var BUS = __req("interceptor").BUS;
  var SSETap = __req("interceptor").SSETap;
  var beginTurn = __req("interceptor").beginTurn;
  var collectModelFields = __req("classify").collectModelFields;
  var extractReasoning = __req("reasoning").extractReasoning;
/** CDP transport into the same parser. No identities guessed, no network calls here. */



const taps = new Map();
function allowed(url) {
  try { const u = new URL(url); return u.protocol === 'https:' && /^(?:www\.)?arena\.ai$/.test(u.hostname)
    && (/^\/ai-proxy\/realtime\/v1\/sessions\/[^/]+\/(?:out|in\/append)$/.test(u.pathname)
      || u.pathname === '/nextjs-api/stream/create-chat'); } catch { return false; }
}
function ingestNative(event = {}) {
  if(!event||typeof event!=='object')return {ok:false,reason:'invalid-event'};
  if(['status','request','response','data','end'].includes(event.kind))BUS.mark('native-'+event.kind);
  const reject=reason=>{BUS.mark('native-rejected',reason);return {ok:false,reason};};
  if (event.kind === 'status') {
    BUS.nativeLastSeen = Date.now();BUS.captureMode = event.connected ? 'cdp' : 'page';
    BUS.nativeStats = {connected:!!event.connected,bytes:event.bytes||0,responses:event.responses||0,errors:event.errors||0,streaming:event.streaming||0,fallback:event.fallback||0};
    BUS.emit({kind:'diagnostic'});return {ok:true};
  }
  if(!['request','response','data','end'].includes(event.kind))return reject('unsupported-kind');
  const id=event.id??event.requestId;
  if(!['string','number'].includes(typeof id)||!String(id)||String(id).length>256)return reject('missing-request-id');
  const key=String(id),existing=taps.get(key);
  // A data/end event can inherit URL only from the exact, previously validated response ID.
  const supplied=event.url??(event.kind==='response'?event.response?.url:undefined);
  const url=supplied??((event.kind==='data'||event.kind==='end')?existing?.ctx.url:undefined);
  if(!url)return reject('missing-url-and-response');
  if(!allowed(url))return reject('out-of-scope');
  if(existing&&supplied&&existing.ctx.url!==supplied)return reject('response-url-mismatch');
  if(event.kind==='request'){
    if(event.method!=='POST')return {ok:true};
    beginTurn(url);BUS.nativeLastEnd=null;BUS.diagnostics.requests++;
    for(const tap of taps.values()){tap.generation=BUS.generation;tap.meaningful=false;tap.observationIndex=-1;tap.text='';tap.frames=[];tap.ttft=0;tap.t0=performance.now();}
    let obj;try{obj=JSON.parse(event.body||'{}');}catch(_){obj={};}
    for(const config of extractReasoning(obj,'request'))BUS.push({source:'reasoning.config',config});
    for(const h of collectModelFields(obj))BUS.push({source:'request.body.model',modelId:h.value,weight:1,detail:h.path,url});
    BUS.mark('native-request-accepted');return {ok:true};
  }
  if(event.kind==='response'){
    if(!existing){if(taps.size>=32){taps.delete(taps.keys().next().value);BUS.mark('native-response-evicted');}taps.set(key,new SSETap({url,transport:'cdp',nativeId:key}));}
    captureRunHeaders(event.headers??event.response?.headers,url,'native-response');
    BUS.mark('native-response-accepted',existing?'existing':'new');return {ok:true};
  }
  const tap=existing;if(!tap)return reject('missing-response');
  if(event.kind==='data'){
    let data,format;
    try{
      if(typeof event.base64==='string'){data=Uint8Array.from(atob(event.base64),c=>c.charCodeAt(0));format='base64';}
      else if(typeof event.text==='string'){data=event.text;format='text';}
      else if(typeof event.data==='string'){
        if(event.base64Encoded===true){data=Uint8Array.from(atob(event.data),c=>c.charCodeAt(0));format='data-base64';}
        else {data=event.data;format='data-text';}
      }else return reject('unsupported-data-shape');
    }catch(_){return reject('invalid-base64');}
    try{tap.feed(data);tap.publish(false);}catch(_){return reject('parser-error');}
    const bytes=typeof data==='string'?data.length:data.byteLength;
    BUS.mark('native-data-accepted',format+' length='+bytes+(supplied?'':' inherited-url'));
  }
  if(event.kind==='end'){
    const networkEnd=['finished','canceled','failed'].includes(event.termination)?event.termination:'unknown';
    const termination=event.truncated?'truncated':event.captureFailed?'incomplete':networkEnd;
    try{tap.finish(termination);}catch(_){taps.delete(key);return reject('parser-finish-error');}
    BUS.nativeLastEnd={termination,networkEnd,truncated:!!event.truncated,captureFailed:!!event.captureFailed};
    taps.delete(key);BUS.mark('native-end-accepted',termination);
  }
  return {ok:true};
}
function nativeStatus() {
  return { ...(BUS.nativeStats || {connected:false}),
    connected: !!BUS.nativeStats?.connected && Date.now() - (BUS.nativeLastSeen || 0) < 15000,
    lastEnd: BUS.nativeLastEnd || null, openStreams: taps.size };
}

  exp.ingestNative = ingestNative;
  exp.nativeStatus = nativeStatus;
} };
__mods["registry"] = { fn: function (exp) {
/**
 * registry.js — 模型指纹注册表
 *
 * 【重要】本表已用 arena.ai 排行榜的真实目录校准（966 个模型名）。
 * 此前靠经验写的正则有明显滞后，实测发现真实代号与代际：
 *   - GPT-6 真实名：gpt-6-astra-{low,medium,max}        （代号 astra）
 *   - GPT-5.6 真实名：gpt-5.6-{sol,luna,terra}-{low,medium,high,xhigh}
 *   - Claude 5 真实名：claude-opus-5-max / claude-sonnet-5 / claude-fable-5.1-high（代号 fable、mythos）
 *   - Gemini 已到 3.8；DeepSeek 已到 v4.1；GLM 已到 5.3；Kimi 已到 K3
 *   - 另有腾讯 hunyuan、百度 ernie、stepfun、minimax-h3、字节 seed/seedream/seedance 等家族
 *
 * 三个层次：
 *  1) MODEL_PATTERNS   —— 模型 id 正则（精确命中）
 *  2) FAMILY_PROTOCOLS —— 协议/字段级指纹（model 字段被抹掉时判家族）
 *  3) CODENAME_HINTS   —— 内部代号线索（astra/fable/sol/luna/terra/mythos…）
 *
 * 未命中的未知模型由 learned.js 自动建档（支持未来新模型的核心机制）。
 */
const REGISTRY_VERSION = '2026.09.2';

/* ------------------------------------------------------------------ *
 * 1. 模型 id 正则表
 *    gen 用于代际排序；codename 记录内部代号
 * ------------------------------------------------------------------ */
const MODEL_PATTERNS = [
  // ---------- OpenAI ----------
  { family: 'openai', gen: 'gpt-6', label: 'GPT-6 系列', codename: 'astra',
    re: /\bgpt[-\s]?6(?:[-\s]?(?:astra|luna|sol|terra|nova|orion|turbo|mini|nano|pro|max|xhigh|high|medium|low|thinking|chat))?/i, weight: 0.99 },
  { family: 'openai', gen: 'gpt-5.6', label: 'GPT-5.6 系列', codename: 'sol/luna/terra',
    re: /\bgpt[-\s]?5[.\-]?6(?:[-\s]?(?:sol|luna|terra|astra))?(?:[-\s]?(?:xhigh|high|medium|low|max|instant|search|agent|text|vision|document|webdev))?/i, weight: 0.98 },
  { family: 'openai', gen: 'gpt-5.5', label: 'GPT-5.5 系列',
    re: /\bgpt[-\s]?5[.\-]?5(?:[-\s]?(?:xhigh|high|medium|low|instant|search|agent|text|vision|document|webdev|codex))?/i, weight: 0.97 },
  { family: 'openai', gen: 'gpt-5.4', label: 'GPT-5.4 系列',
    re: /\bgpt[-\s]?5[.\-]?4(?:[-\s]?(?:xhigh|high|medium|low|mini|nano|search|codex|instant|text|vision))?/i, weight: 0.96 },
  { family: 'openai', gen: 'gpt-5.3', label: 'GPT-5.3 系列',
    re: /\bgpt[-\s]?5[.\-]?3(?:[-\s]?(?:codex|chat|instant|high|medium|low))?/i, weight: 0.95 },
  { family: 'openai', gen: 'gpt-5.2', label: 'GPT-5.2 系列',
    re: /\bgpt[-\s]?5[.\-]?2(?:[-\s]?(?:codex|code|chat|high|medium|low|search|instant))?/i, weight: 0.94 },
  { family: 'openai', gen: 'gpt-5.1', label: 'GPT-5.1 系列',
    re: /\bgpt[-\s]?5[.\-]?1(?:[-\s]?(?:codex|code|chat|high|medium|low|search|instant))?/i, weight: 0.93 },
  { family: 'openai', gen: 'gpt-5', label: 'GPT-5 系列',
    re: /\bgpt[-\s]?5(?![.\-]?\d)(?:[-\s]?(?:chat|high|medium|low|mini|nano|xhigh|search|turbo))?/i, weight: 0.92 },
  { family: 'openai', gen: 'gpt-oss', label: 'GPT-OSS 开源系',
    re: /\bgpt[-\s]?oss(?:[-\s]?(?:\d+b))?/i, weight: 0.88 },
  { family: 'openai', gen: 'gpt-4.5', label: 'GPT-4.5',
    re: /\bgpt[-\s]?4[.\-]?5(?:[-\s]?(?:preview|turbo))?/i, weight: 0.9 },
  { family: 'openai', gen: 'gpt-4o', label: 'GPT-4o 系列',
    re: /\bgpt[-\s]?4o(?:[-\s]?(?:mini|realtime|audio|search|transcribe|tts|latest|\d{4}[-\d]*))?/i, weight: 0.88 },
  { family: 'openai', gen: 'gpt-image', label: 'GPT-Image 系列',
    re: /\bgpt[-\s]?image[-\s]?[\d.]+(?:[-\s]?(?:mini|high[-\s]?fidelity|flare|sunburst|medium))?/i, weight: 0.86 },
  { family: 'openai', gen: 'gpt-4', label: 'GPT-4 系列',
    re: /\bgpt[-\s]?4(?:[-\s]?(?:turbo|32k|0613|1106|0125|vision|preview|\d{4}[-\d]*))?/i, weight: 0.85 },
  { family: 'openai', gen: 'o-series', label: 'o 系列推理模型',
    re: /\bo[1-9](?:[-\s]?(?:mini|preview|pro|high|low|medium|image|video))?(?:[-\s]?\d{4}[-\d]*)?/i, weight: 0.88 },

  // ---------- Anthropic ----------
  { family: 'anthropic', gen: 'claude-5', label: 'Claude 5 代', codename: 'fable/mythos',
    re: /\bclaude[-\s]?(?:opus|sonnet|haiku|fable|mythos)?[-\s]?5(?:[.\d]+)?(?:[-\s]?(?:max|high|medium|low|xhigh|thinking|preview|latest|agent|text|vision|document|webdev|search))?/i, weight: 0.99 },
  { family: 'anthropic', gen: 'claude-4.8', label: 'Claude Opus 4.8',
    re: /\bclaude[-\s]?(?:opus|sonnet|haiku)[-\s]?4[.\-]?8(?:[-\s]?(?:thinking|vertex))?/i, weight: 0.96 },
  { family: 'anthropic', gen: 'claude-4', label: 'Claude 4 代',
    re: /\bclaude[-\s]?(?:opus|sonnet|haiku)[-\s]?4(?:[.\-][\d]+){0,2}(?:[-\s]?(?:thinking|latest|preview|vertex|search|\d{8}))?/i, weight: 0.94 },
  { family: 'anthropic', gen: 'claude-3', label: 'Claude 3 代',
    re: /\bclaude[-\s]?3(?:[.\-][\d]+)?(?:[-\s]?(?:opus|sonnet|haiku)[-\s]?\d*)?/i, weight: 0.9 },

  // ---------- Google ----------
  { family: 'google', gen: 'gemini-3.8', label: 'Gemini 3.8 代',
    re: /\bgemini[-\s]?3[.\-]?8(?:[-\s]?(?:flash|pro|lite))?(?:[-\s]?(?:high|thinking|minimal|grounding))?/i, weight: 0.98 },
  { family: 'google', gen: 'gemini-3.7', label: 'Gemini 3.7 代',
    re: /\bgemini[-\s]?3[.\-]?7(?:[-\s]?(?:flash|pro|lite))?(?:[-\s]?(?:high|thinking|minimal|grounding))?/i, weight: 0.97 },
  { family: 'google', gen: 'gemini-3.6', label: 'Gemini 3.6 代',
    re: /\bgemini[-\s]?3[.\-]?6(?:[-\s]?(?:flash|pro|lite))?(?:[-\s]?(?:high|thinking|minimal|grounding))?/i, weight: 0.96 },
  { family: 'google', gen: 'gemini-3.5', label: 'Gemini 3.5 代',
    re: /\bgemini[-\s]?3[.\-]?5(?:[-\s]?(?:flash|pro|lite))?(?:[-\s]?(?:high|thinking|minimal|grounding))?/i, weight: 0.95 },
  { family: 'google', gen: 'gemini-3.1', label: 'Gemini 3.1 代',
    re: /\bgemini[-\s]?3[.\-]?1(?:[-\s]?(?:flash|pro|lite))?(?:[-\s]?(?:image|thinking|minimal))?/i, weight: 0.94 },
  { family: 'google', gen: 'gemini-3', label: 'Gemini 3 代',
    re: /\bgemini[-\s]?3(?![.\-]?\d)(?:[-\s]?(?:flash|pro|lite|ultra|thinking|image|grounding|preview|exp))?(?:[-\s]?(?:minimal|fixed[-\s]?\d{8}))?/i, weight: 0.93 },
  { family: 'google', gen: 'gemini-2.5', label: 'Gemini 2.5 代',
    re: /\bgemini[-\s]?2[.\-]?5(?:[-\s]?(?:flash|pro|lite|image|thinking|grounding))?(?:[-\s]?(?:preview|\d{2}[-\s]?\d{2,4}|no[-\s]?system))?/i, weight: 0.9 },
  { family: 'google', gen: 'gemini-2', label: 'Gemini 2 代',
    re: /\bgemini[-\s]?2(?:[.\-]?0)?(?:[-\s]?(?:flash|pro|lite|preview))?(?:[-\s]?\d{3})?/i, weight: 0.88 },
  { family: 'google', gen: 'gemma', label: 'Gemma 开源系',
    re: /\bgemma[-\s]?[\d.]+/i, weight: 0.85 },

  // ---------- xAI ----------
  { family: 'xai', gen: 'grok-5', label: 'Grok 5 代',
    re: /\bgrok[-\s]?5(?:[.\d]+)?(?:[-\s]?(?:mini|fast|think|heavy|reasoning|search|agent))?/i, weight: 0.97 },
  { family: 'xai', gen: 'grok-4.6', label: 'Grok 4.6',
    re: /\bgrok[-\s]?4[.\-]?6(?:[-\s]?(?:reasoning|search|agent|text|vision|webdev|document))?/i, weight: 0.96 },
  { family: 'xai', gen: 'grok-4.5', label: 'Grok 4.5',
    re: /\bgrok[-\s]?4[.\-]?5(?:[-\s]?(?:reasoning|search|agent|text|vision|webdev|document))?/i, weight: 0.95 },
  { family: 'xai', gen: 'grok-4.3', label: 'Grok 4.3',
    re: /\bgrok[-\s]?4[.\-]?3(?:[-\s]?(?:reasoning|search|agent|text|vision|webdev|high))?/i, weight: 0.94 },
  { family: 'xai', gen: 'grok-4.20', label: 'Grok 4.20 (beta)',
    re: /\bgrok[-\s]?4[.\-]?20(?:[-\s]?(?:beta\d?|reasoning|multi[-\s]?agent|code))?/i, weight: 0.93 },
  { family: 'xai', gen: 'grok-4', label: 'Grok 4 代',
    re: /\bgrok[-\s]?4(?:[.\-]?1)?(?:[-\s]?(?:fast|mini|thinking|reasoning|search|chat|\d{4}))?/i, weight: 0.91 },
  { family: 'xai', gen: 'grok-3', label: 'Grok 3 代',
    re: /\bgrok[-\s]?3(?:[-\s]?(?:mini|fast|think|high|preview))?(?:[-\s]?\d{2}[-\s]?\d{2})?/i, weight: 0.88 },

  // ---------- DeepSeek ----------
  { family: 'deepseek', gen: 'v4.1', label: 'DeepSeek V4.1 代',
    re: /\bdeepseek[-\s]?v?4[.\-]?1(?:[-\s]?(?:flash|pro|max|thinking|high|text|webdev))?/i, weight: 0.98 },
  { family: 'deepseek', gen: 'v4', label: 'DeepSeek V4 代',
    re: /\bdeepseek[-\s]?v?4(?![.\-]?\d)(?:[-\s]?(?:flash|pro|max|high|thinking|text|webdev|ch\d|internal|dlp|preview))?(?:[-\s]?\d{4})?/i, weight: 0.96 },
  { family: 'deepseek', gen: 'v3.2', label: 'DeepSeek V3.2',
    re: /\bdeepseek[-\s]?v?3[.\-]?2(?:[-\s]?(?:exp|thinking))?/i, weight: 0.93 },
  { family: 'deepseek', gen: 'v3', label: 'DeepSeek V3 代',
    re: /\bdeepseek[-\s]?(?:v3|r1|coder|llm)(?:[.\-]?[\d]+)?(?:[-\s]?(?:terminus|thinking|chat))?(?:[-\s]?\d{4})?/i, weight: 0.91 },

  // ---------- 阿里 Qwen ----------
  { family: 'qwen', gen: 'qwen3.8', label: 'Qwen3.8',
    re: /\bqwen[-\s]?3[.\-]?8(?:[-\s]?(?:max|plus|turbo|flash|thinking|preview|\d+b))?/i, weight: 0.97 },
  { family: 'qwen', gen: 'qwen3.7', label: 'Qwen3.7',
    re: /\bqwen[-\s]?3[.\-]?7(?:[-\s]?(?:max|plus|turbo|flash|thinking|preview))?/i, weight: 0.96 },
  { family: 'qwen', gen: 'qwen3.5', label: 'Qwen3.5',
    re: /\bqwen[-\s]?3[.\-]?5(?:[-\s]?(?:max|plus|turbo|flash|thinking|\d+b|a\d+b))?/i, weight: 0.95 },
  { family: 'qwen', gen: 'qwen3', label: 'Qwen3 系',
    re: /\bqwen[-\s]?3(?![.\-]?\d)(?:[-\s]?(?:max|plus|turbo|flash|thinking|instruct|omni|coder|next|vl))?(?:[-\s]?(?:a?\d+b|instruct|thinking))?/i, weight: 0.93 },
  { family: 'qwen', gen: 'qwen2.5', label: 'Qwen2.5',
    re: /\bqwen[-\s]?2[.\-]?5(?:[-\s]?(?:max|plus|turbo|coder|math|vl|instruct|\d+b))?/i, weight: 0.9 },
  { family: 'qwen', gen: 'qwen-image', label: 'Qwen-Image',
    re: /\bqwen[-\s]?image(?:[-\s]?(?:edit|prompt[-\s]?extend|pro))?(?:[-\s]?[\d.]+)?(?:[-\s]?\d{4}[-\d]*)?/i, weight: 0.86 },

  // ---------- 月之暗面 / 智谱 / MiniMax / 字节 ----------
  { family: 'moonshot', gen: 'kimi-k3', label: 'Kimi K3 系',
    re: /\bkimi[-\s]?k3(?:[-\s]?(?:gateway|max|official|quickstart|v\d|code|text|webdev|thinking))?/i, weight: 0.97 },
  { family: 'moonshot', gen: 'kimi-k2.6', label: 'Kimi K2.6',
    re: /\bkimi[-\s]?k2[.\-]?6(?:[-\s]?(?:code|text|vision|document))?/i, weight: 0.96 },
  { family: 'moonshot', gen: 'kimi-k2.5', label: 'Kimi K2.5',
    re: /\bkimi[-\s]?k2[.\-]?5(?:[-\s]?(?:thinking|instant|text|vision|document|webdev|imageto[-\s]?webdev))?/i, weight: 0.95 },
  { family: 'moonshot', gen: 'kimi-k2', label: 'Kimi K2 系',
    re: /\b(?:kimi[-\s]?k2|moonshot[-\s]?v?\d)(?:[-\s]?(?:thinking|turbo|instruct|preview|\d{4}))?/i, weight: 0.93 },
  { family: 'zhipu', gen: 'glm-5.3', label: 'GLM 5.3',
    re: /\bglm[-\s]?5[.\-]?3(?:[-\s]?(?:flash|max|agent|text|vision|code|image[-\s]?to[-\s]?webdev|webdev))?/i, weight: 0.97 },
  { family: 'zhipu', gen: 'glm-5.2', label: 'GLM 5.2',
    re: /\bglm[-\s]?5[.\-]?2(?:[-\s]?(?:max|agent|code|text|flash))?/i, weight: 0.96 },
  { family: 'zhipu', gen: 'glm-5.1', label: 'GLM 5.1',
    re: /\bglm[-\s]?5[.\-]?1(?:[-\s]?(?:code|text|v))?/i, weight: 0.95 },
  { family: 'zhipu', gen: 'glm-5', label: 'GLM 5 代',
    re: /\bglm[-\s]?5(?![.\-]?\d)(?:[-\s]?(?:plus|air|flash|free|chat|thinking|v|turbo|webdev))?/i, weight: 0.93 },
  { family: 'zhipu', gen: 'glm-4', label: 'GLM 4 代',
    re: /\bglm[-\s]?4(?:[.\-][\d]+)?(?:[-\s]?(?:plus|air|flash|free|chat|v))?/i, weight: 0.88 },
  { family: 'minimax', gen: 'minimax-m3', label: 'MiniMax M3',
    re: /\bminimax[-\s]?m3(?:[-\s]?(?:first[-\s]?party))?/i, weight: 0.96 },
  { family: 'minimax', gen: 'minimax-m2', label: 'MiniMax M2 系',
    re: /\bminimax[-\s]?m2(?:[.\-]?\d)?(?:[-\s]?preview)?/i, weight: 0.94 },
  { family: 'minimax', gen: 'minimax-h3', label: 'MiniMax H3',
    re: /\bminimax[-\s]?h3(?:[-\s]?(?:max|community))?(?:[-\s]?(?:text[-\s]?to[-\s]?video|image[-\s]?to[-\s]?video))?/i, weight: 0.93 },
  { family: 'minimax', gen: 'minimax-m', label: 'MiniMax M 系',
    re: /\bminimax[-\s]?m1(?:[-\s]?preview)?|\bminimax[-\s]?(?:hailuo|abab)/i, weight: 0.88 },
  { family: 'bytedance', gen: 'seed-2.1', label: '字节 Seed 2.1',
    re: /\bseed[-\s]?2[.\-]?1(?:[-\s]?(?:pro|preview))?/i, weight: 0.95 },
  { family: 'bytedance', gen: 'seed-2.0', label: '字节 Seed 2.0',
    re: /\bseed[-\s]?2[.\-]?0(?:[-\s]?(?:pro|preview))?(?:[-\s]?(?:text|vision))?/i, weight: 0.94 },
  { family: 'bytedance', gen: 'seedream', label: '字节 Seedream',
    re: /\bseedream[-\s]?[\d._]+(?:[-\s]?(?:pro|lite|high[-\s]?res|fal))?/i, weight: 0.9 },
  { family: 'bytedance', gen: 'seedance', label: '字节 Seedance',
    re: /\bseedance(?:[-\s]?v?[\d._]+)?(?:[-\s]?(?:pro|lite|\d{3}p|text[-\s]?to|image[-\s]?to))?/i, weight: 0.88 },
  { family: 'bytedance', gen: 'doubao', label: '豆包 / Skylark',
    re: /\b(?:doubao|skylark|seededit)(?:[-\s]?[a-z0-9.\-]+)?/i, weight: 0.87 },

  // ---------- 腾讯 / 百度 / StepFun ----------
  { family: 'tencent', gen: 'hunyuan-hy3', label: '腾讯混元 HY3',
    re: /\bhunyuan[-\s]?hy3(?:[-\s]?(?:preview|code|text))?/i, weight: 0.94 },
  { family: 'tencent', gen: 'hunyuan-t1', label: '腾讯混元 T1',
    re: /\bhunyuan[-\s]?t1(?:[-\s]?\d{8})?/i, weight: 0.92 },
  { family: 'tencent', gen: 'hunyuan', label: '腾讯混元',
    re: /\bhunyuan(?:[-\s]?(?:large|standard|turbo|turbos|vision|image|video|community|default))?(?:[-\s]?[\d.]+)?(?:[-\s]?\d{4}[-\d]*)?/i, weight: 0.88 },
  { family: 'baidu', gen: 'ernie-5.1', label: '文心 ERNIE 5.1',
    re: /\bernie[-\s]?5[.\-]?1(?:[-\s]?\d{4})?(?:[-\s]?release)?/i, weight: 0.94 },
  { family: 'baidu', gen: 'ernie-5.0', label: '文心 ERNIE 5.0',
    re: /\bernie[-\s]?5[.\-]?0(?:[-\s]?(?:preview|release))?(?:[-\s]?\d{4})?/i, weight: 0.93 },
  { family: 'baidu', gen: 'ernie', label: '文心 ERNIE',
    re: /\bernir?ie(?:[-\s]?(?:exp|turbo|speed|tiny|vl))?(?:[-\s]?\d{4,6})?|\bwenxin\b/i, weight: 0.86 },
  { family: 'stepfun', gen: 'step-3.7', label: '阶跃 Step 3.7',
    re: /\bstep[-\s]?3[.\-]?7(?:[-\s]?flash)?/i, weight: 0.94 },
  { family: 'stepfun', gen: 'step-3.5', label: '阶跃 Step 3.5',
    re: /\bstep[-\s]?3[.\-]?5(?:[-\s]?flash)?/i, weight: 0.93 },
  { family: 'stepfun', gen: 'step', label: '阶跃 StepFun',
    re: /\bstep(?:fun)?[-\s]?(?:1o|1v|2|3)[-\s]?[a-z0-9\-]*/i, weight: 0.86 },

  // ---------- 其他厂商 ----------
  { family: 'meta', gen: 'llama-5', label: 'Llama 5 代',
    re: /\bllama[-\s]?5(?:[.\d]+)?(?:[-\s]?(?:scout|maverick|behemoth|instruct|vision))?/i, weight: 0.94 },
  { family: 'meta', gen: 'llama-4', label: 'Llama 4 代',
    re: /\bllama[-\s]?4(?:[.\d]+)?(?:[-\s]?(?:scout|maverick|instruct|vision))?/i, weight: 0.92 },
  { family: 'meta', gen: 'llama-3', label: 'Llama 3 代',
    re: /\bllama[-\s]?3(?:[._\-]?[\d]+)?(?:[-\s]?(?:instruct|\d+b|vision|nemotron|tulu))?/i, weight: 0.89 },
  { family: 'meta', gen: 'llama-2', label: 'Llama 2 代',
    re: /\bllama[-\s]?2(?:[-\s]?(?:chat|\d+b))?/i, weight: 0.85 },
  { family: 'mistral', gen: 'mistral-3', label: 'Mistral 3',
    re: /\bmistral[-\s]?(?:large|medium|small)[-\s]?3(?:[.\-]?\d)?(?:[-\s]?(?:v\d|text|agent|vision|webdev))?/i, weight: 0.94 },
  { family: 'mistral', gen: 'mistral', label: 'Mistral 系',
    re: /\b(?:mistral|mixtral|codestral|magistral|devstral)(?:[-\s]?[a-z0-9.\-]+)?/i, weight: 0.88 },
  { family: 'cohere', gen: 'command', label: 'Cohere Command',
    re: /\bcommand[-\s]?(?:a|r|r\+|light|nightly)(?:[-\s]?[a-z0-9.\-]*)?/i, weight: 0.88 },
  { family: 'nvidia', gen: 'nemotron-3.5', label: 'NVIDIA Nemotron 3.5',
    re: /\bnemotron[-\s]?3[.\-]?5(?:[-\s]?lightning)?(?:[-\s]?\d+b)?/i, weight: 0.93 },
  { family: 'nvidia', gen: 'nemotron-3', label: 'NVIDIA Nemotron 3',
    re: /\bnemotron[-\s]?3(?:[-\s]?(?:nano|super|ultra))?(?:[-\s]?\d+b[-\s]?a?\d+b?)?/i, weight: 0.91 },
  { family: 'nvidia', gen: 'nemotron', label: 'NVIDIA Nemotron',
    re: /\bnemotron(?:[-\s]?[a-z0-9.\-]+)?/i, weight: 0.86 },
  { family: 'microsoft', gen: 'phi', label: 'Microsoft Phi',
    re: /\bphi[-\s]?[3-9](?:[.\d]+)?(?:[-\s]?(?:mini|small|medium|vision|instruct|\d+k))?/i, weight: 0.87 },
  { family: 'ai21', gen: 'jamba', label: 'AI21 Jamba',
    re: /\bjamba(?:[-\s]?[a-z0-9.\-]+)?/i, weight: 0.86 },
  { family: 'amazon', gen: 'nova', label: 'Amazon Nova',
    re: /\b(?:amazon[-\s]?)?nova[-\s]?(?:pro|premier|lite|micro|canvas|reel|sonic)(?:[-\s]?v?\d)?/i, weight: 0.86 },
  { family: 'perplexity', gen: 'sonar', label: 'Perplexity Sonar',
    re: /\bsonar(?:[-\s]?(?:pro|reasoning|deep[-\s]?research))?/i, weight: 0.85 },

  // ---------- 网关 / 聚合层（提示是聚合而非真身）----------
  { family: '__gateway', gen: 'gateway', label: '网关/聚合层前缀',
    re: /\b(?:openrouter|azure|vertex|bedrock|together|fireworks|groq|deepinfra|perplexity|poe|you\.com|gateway|dlp[-\s]?test)\b/i, weight: 0.35 },
];

/* ------------------------------------------------------------------ *
 * 2. 协议 / 字段级指纹
 * ------------------------------------------------------------------ */
const FAMILY_PROTOCOLS = [
  {
    family: 'anthropic', weight: 0.72, label: 'Anthropic Messages API',
    tests: [
      { name: 'message_start 帧', re: /"type"\s*:\s*"message_start"/ },
      { name: 'content_block_delta 帧', re: /"type"\s*:\s*"content_block_delta"/ },
      { name: 'thinking_delta 帧', re: /"type"\s*:\s*"thinking_delta"/ },
      { name: 'stop_reason 枚举', re: /"stop_reason"\s*:\s*"(?:end_turn|max_tokens|stop_sequence|tool_use|refusal)"/ },
      { name: 'usage.cache_creation_input_tokens', re: /"cache_creation_input_tokens"/ },
      { name: 'toolu_ 工具 id', re: /\btoolu_[A-Za-z0-9]{6,}/ },
      { name: 'Anthropic 版本头', re: /anthropic-version/i },
    ],
  },
  {
    family: 'openai', weight: 0.7, label: 'OpenAI Chat Completions（协议层）',
    note: 'object/choices 等同为「OpenAI 兼容协议」共有，故单条命中权重低；'
        + '真正可区分 OpenAI 的是 chatcmpl- id 与 system_fingerprint 这类厂商独有特征',
    tests: [
      { name: 'chatcmpl- id（厂商独有）', re: /\bchatcmpl-[A-Za-z0-9]{6,}/ },
      { name: 'system_fingerprint（厂商独有）', re: /"system_fingerprint"\s*:\s*"/ },
      { name: 'prompt_tokens_details.cached_tokens', re: /"cached_tokens"\s*:/ },
      { name: 'call_ 工具 id（厂商独有）', re: /\bcall_[A-Za-z0-9]{6,}/ },
      { name: 'logprobs 字段', re: /"logprobs"\s*:\s*(?:null|\[|\{)/ },
      { name: 'object=chat.completion.chunk（兼容层共有）', re: /"object"\s*:\s*"chat\.completion(?:\.chunk)?"/ },
      { name: 'choices[].delta（兼容层共有）', re: /"choices"\s*:\s*\[\s*\{[^}]*"delta"/ },
    ],
  },
  {
    family: 'openai', weight: 0.75, label: 'OpenAI Responses API',
    tests: [
      { name: 'response.created 帧', re: /"type"\s*:\s*"response\.created"/ },
      { name: 'response.output_text.delta', re: /"type"\s*:\s*"response\.output_text\.delta"/ },
      { name: 'resp_ id', re: /\bresp_[A-Za-z0-9]{6,}/ },
      { name: 'reasoning.summary 帧', re: /"type"\s*:\s*"response\.reasoning\.summary_text\.delta"/ },
    ],
  },
  {
    family: 'google', weight: 0.72, label: 'Google Generative Language API',
    tests: [
      { name: 'candidates[].content.parts', re: /"candidates"\s*:\s*\[\s*\{[^}]*"content"/ },
      { name: 'parts[].text', re: /"parts"\s*:\s*\[\s*\{[^}]*"text"/ },
      { name: 'finishReason 枚举', re: /"finishReason"\s*:\s*"(?:STOP|MAX_TOKENS|SAFETY|RECITATION|OTHER)"/ },
      { name: 'usageMetadata', re: /"usageMetadata"\s*:\s*\{/ },
      { name: 'thought:true 思维链', re: /"thought"\s*:\s*true/ },
      { name: 'generateContent 路径', re: /:generateContent|:streamGenerateContent/ },
    ],
  },
  {
    // 修正：这【不是】模型家族指纹，而是传输层指纹。
    //
    // 原实现把它标成 family:'openai'，weight:0.78 —— 这是一个严重的范畴错误：
    //   Vercel AI SDK 是厂商无关的序列化/传输层，同时封装 OpenAI、Anthropic、
    //   Google、Qwen、DeepSeek 等所有 provider。用帧类型判"openai 家族"，
    //   等于用 HTTP 判网站用哪个数据库。
    //
    // 实测反证：某次 Agent Mode 实际用的是 qwen-latest-series-invite-202608-m4
    //   （由 Trigger.dev run trace 的 span 标签证实），
    //   但原始流里 'qwen' 与 'openai' 各出现 0 次 —— 双向证据都不存在，
    //   而探针却报出「openai 家族 / 74.1%」。即：纯属假阳性。
    //
    // 因此改为 family:'__sdk_wire'，只用于识别【传输层形态】，
    // 不参与模型家族判定（classify 会忽略 __ 前缀的家族）。
    family: '__sdk_wire', weight: 0.30, label: 'Vercel AI SDK UI Message Stream（传输层）',
    note: '厂商无关的传输层：仅说明用了 AI SDK，不能推断模型家族',
    tests: [
      { name: 'start 帧', re: /"type"\s*:\s*"start"/ },
      { name: 'start-step 帧', re: /"type"\s*:\s*"start-step"/ },
      { name: 'finish-step 帧', re: /"type"\s*:\s*"finish-step"/ },
      { name: 'finish 帧带 finishReason', re: /"type"\s*:\s*"finish"[^}]*"finishReason"/ },
      { name: 'text-start 帧', re: /"type"\s*:\s*"text-start"/ },
      { name: 'text-delta 帧', re: /"type"\s*:\s*"text-delta"/ },
      { name: 'text-end 帧', re: /"type"\s*:\s*"text-end"/ },
      { name: 'reasoning-start 帧', re: /"type"\s*:\s*"reasoning-start"/ },
      { name: 'reasoning-delta 帧', re: /"type"\s*:\s*"reasoning-delta"/ },
      { name: 'tool-input-available 帧', re: /"type"\s*:\s*"tool-input-available"/ },
    ],
  },
  {
    family: '__realtime_batch', weight: 0.3, label: '自定义 realtime batch 传输层',
    note: 'arena.ai 专用：event: batch + body 内嵌 JSON 字符串',
    tests: [
      { name: 'event: batch', re: /^event:\s*batch/m },
      { name: 'records[].seq_num', re: /"records"\s*:\s*\[\s*\{[^}]*"seq_num"/ },
      { name: 'tail.seq_num', re: /"tail"\s*:\s*\{\s*"seq_num"/ },
      { name: 'ai-proxy/realtime', re: /ai-proxy\/realtime/ },
      { name: 'event: ping', re: /^event:\s*ping/m },
    ],
  },
  {
    family: 'xai', weight: 0.5, label: 'xAI (OpenAI 兼容但有独有字段)',
    tests: [
      { name: 'grok 端点', re: /api\.x\.ai|grok/i },
      { name: 'reasoning_content 字段', re: /"reasoning_content"\s*:/ },
      { name: 'search_parameters', re: /"search_parameters"\s*:/ },
    ],
  },
  {
    family: 'deepseek', weight: 0.5, label: 'DeepSeek 风格',
    tests: [
      { name: 'deepseek 端点', re: /api\.deepseek\.com|deepseek/i },
      { name: 'reasoning_content 字段', re: /"reasoning_content"\s*:/ },
      { name: 'prompt_cache_hit_tokens', re: /"prompt_cache_(?:hit|miss)_tokens"/ },
    ],
  },
  {
    // 通义千问：DashScope 原生协议与 OpenAI 兼容模式差异明显。
    //
    // 注意（实测教训）：通用字段不能用作家族指纹。
    //   曾经把 request_id、code+message 当 qwen 特征，结果任何通用 JSON
    //   （包括 Datadog 遥测上报）都能命中，造成假阳性。
    //   下面只保留真正与 DashScope 强绑定的特征。
    family: 'qwen', weight: 0.72, label: '通义千问 / DashScope',
    tests: [
      { name: 'qwen 模型名', re: /\bqwen[\w.\-]*/i },
      { name: 'DashScope 端点', re: /dashscope|aliyuncs\.com|bailian/i },
      { name: 'enable_thinking 参数（阿里独有）', re: /"enable_thinking"\s*:/ },
      { name: 'enable_search 参数（阿里独有）', re: /"enable_search"\s*:/ },
      { name: 'output.choices 结构（DashScope 独有）', re: /"output"\s*:\s*\{[^}]*"choices"/ },
      { name: 'output.finish_reason（DashScope 独有）', re: /"finish_reason"\s*:\s*"(?:stop|null|length|tool_calls)"[^}]*"output"/ },
      { name: 'usage.output_tokens+input_tokens（DashScope 命名）', re: /"output_tokens"\s*:\s*\d+[^}]*"input_tokens"\s*:\s*\d+/ },
    ],
  },
  {
    family: '__sse_generic', weight: 0.2, label: '通用 SSE（无家族特征）',
    tests: [{ name: 'SSE 分帧', re: /^\s*data:\s*\{/m }],
  },
];

/* ------------------------------------------------------------------ *
 * 3. 端点主机 → 厂商
 * ------------------------------------------------------------------ */
const HOST_VENDOR = [
  [/api\.openai\.com|openai\.azure\.com|\.openai\.azure\.com/i, 'openai', 0.85],
  [/api\.anthropic\.com|claude\.ai/i, 'anthropic', 0.85],
  [/generativelanguage\.googleapis\.com|aiplatform\.googleapis\.com|makersuite|aistudio/i, 'google', 0.85],
  [/api\.x\.ai|x\.ai/i, 'xai', 0.85],
  [/api\.deepseek\.com|deepseek/i, 'deepseek', 0.85],
  [/dashscope|aliyuncs\.com|bailian/i, 'qwen', 0.8],
  [/api\.moonshot\.(?:cn|ai)|kimi\.com/i, 'moonshot', 0.8],
  [/open\.bigmodel\.cn|zhipu/i, 'zhipu', 0.8],
  [/minimax(?:i)?\.(?:com|chat|io)/i, 'minimax', 0.8],
  [/ark\.cn-beijing\.volces\.com|volces\.com|doubao/i, 'bytedance', 0.8],
  [/hunyuan\.tencent\.com|tencent/i, 'tencent', 0.8],
  [/ernie\.baidu\.com|baidubce/i, 'baidu', 0.8],
  [/stepfun\.(?:ai|com)/i, 'stepfun', 0.8],
  [/api\.mistral\.ai/i, 'mistral', 0.8],
  [/api\.cohere\.ai/i, 'cohere', 0.8],
  [/openrouter\.ai/i, '__gateway:openrouter', 0.6],
  [/api\.together\.xyz/i, '__gateway:together', 0.6],
  [/api\.groq\.com/i, '__gateway:groq', 0.6],
  [/api\.fireworks\.ai/i, '__gateway:fireworks', 0.6],
  [/api\.perplexity\.ai/i, '__gateway:perplexity', 0.6],
];

/* ------------------------------------------------------------------ *
 * 4. 匿名槽位 / 代号线索
 * ------------------------------------------------------------------ */
const ANON_SLOT_RE = /\b(?:model[-\s]?[abAB]\b|assistant[-\s]?[abAB]\b|side[-\s]?(?:by[-\s]?side|[abAB])\b|匿名模型\s*[AB]|模型\s*[AB]\b|slot[-\s]?[abAB]\b)/;

/** 实测收集到的内部代号（来自 arena.ai 排行榜），用于识别"未公开名" */
const KNOWN_CODENAMES = {
  astra: 'openai', luna: 'openai', sol: 'openai', terra: 'openai',
  fable: 'anthropic', mythos: 'anthropic',
  'ch1': 'deepseek', 'ch3': 'deepseek',
};

/* ------------------------------------------------------------------ *
 * 5. 响应头 / JSON 键
 * ------------------------------------------------------------------ */
const MODEL_HEADER_RE = /^(?:x-)?(?:upstream-)?(?:served-|resolved-)?model(?:-id|-name|-slug)?$|^openai-model$|^x-model$|^x-llm-model$|^x-upstream$/i;
const MODEL_KEY_RE = /^(?:model|model_id|modelId|model_name|modelName|model_slug|modelSlug|resolved_model|resolved_model_id|served_model|engine|deployment|deployment_name|upstream_model|backend_model|base_model|provider_model|publicName|winningModelId|modelAId|modelBId|selected_model_id|resolved_model_id)$/;
const USAGE_KEYS = [
  'prompt_tokens', 'completion_tokens', 'total_tokens',
  'input_tokens', 'output_tokens',
  'prompt_tokens_details', 'completion_tokens_details',
  'cached_tokens', 'reasoning_tokens', 'cache_creation_input_tokens',
  'cache_read_input_tokens', 'prompt_cache_hit_tokens', 'usageMetadata',
];

/* ------------------------------------------------------------------ *
 * 6. 代际排序（判断"是不是最新一代"）
 * ------------------------------------------------------------------ */
const GEN_ORDER = {
  openai: ['gpt-4', 'gpt-4o', 'gpt-4.5', 'o-series', 'gpt-5', 'gpt-5.1', 'gpt-5.2', 'gpt-5.3', 'gpt-5.4', 'gpt-5.5', 'gpt-5.6', 'gpt-6'],
  anthropic: ['claude-3', 'claude-4', 'claude-4.8', 'claude-5'],
  google: ['gemini-2', 'gemini-2.5', 'gemini-3', 'gemini-3.1', 'gemini-3.5', 'gemini-3.6', 'gemini-3.7', 'gemini-3.8'],
  xai: ['grok-3', 'grok-4', 'grok-4.20', 'grok-4.3', 'grok-4.5', 'grok-4.6', 'grok-5'],
  deepseek: ['v3', 'v3.2', 'v4', 'v4.1'],
  qwen: ['qwen2.5', 'qwen3', 'qwen3.5', 'qwen3.7', 'qwen3.8'],
  meta: ['llama-2', 'llama-3', 'llama-4', 'llama-5'],
  moonshot: ['kimi-k2', 'kimi-k2.5', 'kimi-k2.6', 'kimi-k3'],
  zhipu: ['glm-4', 'glm-5', 'glm-5.1', 'glm-5.2', 'glm-5.3'],
  minimax: ['minimax-m', 'minimax-h3', 'minimax-m2', 'minimax-m3'],
  bytedance: ['doubao', 'seed-2.0', 'seed-2.1'],
  tencent: ['hunyuan', 'hunyuan-t1', 'hunyuan-hy3'],
  baidu: ['ernie', 'ernie-5.0', 'ernie-5.1'],
  stepfun: ['step', 'step-3.5', 'step-3.7'],
  mistral: ['mistral', 'mistral-3'],
  nvidia: ['nemotron', 'nemotron-3', 'nemotron-3.5'],
};

/** 该 family 已知最新代际，用于标注"前沿/非前沿" */
function isFrontier(family, gen) {
  const list = GEN_ORDER[family];
  if (!list || !gen) return null;
  return list[list.length - 1] === gen;
}

  exp.REGISTRY_VERSION = REGISTRY_VERSION;
  exp.MODEL_PATTERNS = MODEL_PATTERNS;
  exp.FAMILY_PROTOCOLS = FAMILY_PROTOCOLS;
  exp.HOST_VENDOR = HOST_VENDOR;
  exp.ANON_SLOT_RE = ANON_SLOT_RE;
  exp.KNOWN_CODENAMES = KNOWN_CODENAMES;
  exp.MODEL_HEADER_RE = MODEL_HEADER_RE;
  exp.MODEL_KEY_RE = MODEL_KEY_RE;
  exp.USAGE_KEYS = USAGE_KEYS;
  exp.GEN_ORDER = GEN_ORDER;
  exp.isFrontier = isFrontier;
} };
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
__mods["interceptor"] = { fn: function (exp) {
  var collectModelFields = __req("classify").collectModelFields;
  var scanTextForModel = __req("classify").scanTextForModel;
  var evidenceFromHeaders = __req("classify").evidenceFromHeaders;
  var protocolFingerprint = __req("classify").protocolFingerprint;
  var extractReasoning = __req("reasoning").extractReasoning;
/**
 * interceptor.js — 页面内网络采集层（passive, 零侵入）
 *
 * 原理：模型身份最硬的证据是"页面自己发出去/收回来的网络流量"。
 * 所以我们在页面最早的时机接管 fetch / XHR / EventSource，旁路读取（clone），
 * 不改变任何请求行为，避免破坏页面。
 *
 * 目标：< 800ms 内给出首判（第一个 SSE chunk 到达即可判定）。
 */
const BUS = {
  // Fixed-label diagnostics only: never retain token values, request bodies or chat text.
  monitor: {bootAt:Date.now(),instance:Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,8),counts:{},events:[],tokenStatus:null,lastReset:null},
  mark(kind,note='') {const m=this.monitor;m.counts[kind]=(m.counts[kind]||0)+1;if(kind==='native-status'||kind==='native-data')return;m.events.push({at:Date.now(),kind,note});if(m.events.length>20)m.events.shift();},
  pendingHeaders: [],
  ready: false,
  generation: 0,
  diagnostics: { heartbeats: 0, requests: 0, responses: 0, headers: 0 },
  evidence: [],      // 结构化证据
  observations: [],  // 每次完整对话的观测（用于指纹建档）
  listeners: [],
  on(fn) { this.listeners.push(fn); },
  emit(evt) { if (!this.ready && evt.kind === 'stream-header') { this.pendingHeaders.push(evt); this.pendingHeaders = this.pendingHeaders.slice(-10); } for (const fn of this.listeners) { try { fn(evt); } catch { /* noop */ } } },
  push(e) {
    this.evidence.push(e);
    if (this.evidence.length > 500) this.evidence.splice(0, 200);
    this.emit({ kind: 'evidence', data: e });
  },
};

const now = () => performance.now();
function nativeActive() { return BUS.captureMode === 'cdp' && Date.now() - (BUS.nativeLastSeen || 0) < 15000; }
function beginTurn(url = '') {
  BUS.generation++;
  BUS.mark('turn-start','generation '+BUS.generation);
  BUS.evidence.length = 0;
  BUS.observations.length = 0;
  BUS.emit({ kind: 'turn-start', data: { url, generation: BUS.generation } });
}
function recordReasoning(obj, source, url) {
  for (const config of extractReasoning(obj, source)) {
    if (BUS.evidence.some(e => e.source === 'reasoning.config' && JSON.stringify(e.config) === JSON.stringify(config))) continue;
    BUS.push({ source: 'reasoning.config', config, url, t: now() });
  }
}
function inspectRequest(body, url) {
  if (nativeActive()) return null;
  if (!isLikelyLLMUrl(url) || typeof body !== 'string') return null;
  try {
    const obj = JSON.parse(body);
    if (/(?:create-chat|completions|responses|generateContent|\/messages|\/in\/append)(?:[/?]|$)/i.test(url)
      && !/"(?:type|event)"\s*:\s*"(?:ping|heartbeat)"/.test(body)) {
      beginTurn(url); BUS.diagnostics.requests++;
    }
    recordReasoning(obj, 'request', url);
    for (const h of collectModelFields(obj)) BUS.push({ source: 'request.body.model', weight: 1,
      modelId: h.value, detail: h.path, url, t: now() });
    return collectModelFields(obj)[0]?.value || null;
  } catch { return null; }
}
// Only protocol header containers are inspected. No text scanning, no model/usage collection.
function captureRunHeaders(headers, url, source = 'protocol-header') {
  let pairs=[];
  if (Array.isArray(headers)) pairs=headers;
  else if (headers && typeof headers.forEach==='function') headers.forEach((v,k)=>pairs.push([k,v]));
  else if (headers && typeof headers==='object') pairs=Object.entries(headers);
  for (const pair of pairs.slice(0,200)) {
    const name=Array.isArray(pair)?pair[0]:pair?.name, value=Array.isArray(pair)?pair[1]:pair?.value;
    if(typeof name==='string'&&name.toLowerCase()==='public-access-token'&&typeof value==='string'&&value.length<=65536){
      BUS.diagnostics.headers++;BUS.mark('run-header',source);
      BUS.emit({kind:'stream-header',data:{name,value,url}});
    }
  }
}
function runHeaderFallback(tap, bytes, flush=false) {
  let url;
  try {url=new URL(tap.ctx.url,location.href);}catch(_){return;}
  if(url.origin!==location.origin||!(/^\/ai-proxy\/realtime\/v1\/sessions\/[^/]+\/out$/.test(url.pathname)||url.pathname==='/nextjs-api/stream/create-chat'))return;
  if(!tap.headerDecoder)tap.headerDecoder=new TextDecoder();
  const piece=typeof bytes==='string'?bytes:bytes?tap.headerDecoder.decode(bytes,{stream:true}):'';
  let buffer=(tap.headerBuffer||'')+piece;
  if(buffer.length>400000){tap.headerBuffer='';BUS.mark('header-fallback-overflow');return;}
  const lines=buffer.split('\n');tap.headerBuffer=flush?'':lines.pop();
  if(!tap.headerFallbackStarted){tap.headerFallbackStarted=true;BUS.mark('header-fallback-active');}
  for(let line of lines){
    line=line.trim();if(line.startsWith('data:'))line=line.slice(5).trim();
    if(!line||!line.startsWith('{'))continue;
    let obj;try{obj=JSON.parse(line);}catch(_){continue;}
    captureRunHeaders(obj.headers,tap.ctx.url,'page-fallback');
    if(Array.isArray(obj.records))for(const rec of obj.records.slice(0,1000))captureRunHeaders(rec?.headers,tap.ctx.url,'page-fallback');
  }
}
function inspectHeaders(headers, url) { captureRunHeaders(headers,url); }


/**
 * 判断是否像 AI 推理请求（避免把静态资源也解析）
 *
 * 两层判定：
 *  - URL 层：路径含 completions/chat/messages 等，或主机是已知厂商/网关
 *  - 内容类型层：text/event-stream 本身就是强信号（匿名网关路径不可预测）
 *
 * 三层排除（每一层都是实测踩坑后加的）：
 *  1. 静态资源
 *  2. 遥测/分析/监控域 —— 这类端点 URL 里常含 /api/，会被"疑似 LLM"规则误收，
 *     而它们的 payload 是通用 JSON（含 code/message/request_id 等），
 *     足以命中错误的协议指纹，制造假阳性。
 *     实测事故：Datadog RUM 上报被当成模型响应，导致误报 qwen 家族。
 *  3. 同域但明确与推理无关的路径
 */
const TELEMETRY_RE = /(?:datadoghq|datadog|posthog|sentry|amplitude|mixpanel|segment\.io|segment\.com|google-analytics|googletagmanager|hotjar|clarity\.ms|fullstory|logrocket|newrelic|nr-data|bugsnag|rollbar|trackjs|raygun|elastic\.co|honeycomb|lightstep|opentelemetry|otlp|statsig|launchdarkly|optimizely|split\.io|vwo\.com|matomo|plausible\.io|umami|vercel-insights|vercel\.com\/_vercel\/insights)/i;

const IRRELEVANT_PATH_RE = /(?:rum\/|_vercel\/insights|\/cdn-cgi\/|\/survey|\/feedback\/|\/beacon|\/log\/|\/logs\/|\/metrics\/|\/trace\/|\/analytics|\/telemetry)/i;

function isLikelyLLMUrl(url) {
  if (!url) return false;
  // 1) 静态资源
  if (/\.(?:js|css|png|jpe?g|gif|svg|woff2?|ttf|ico|map|mp4|webp|avif)(?:\?|$)/i.test(url)) return false;
  // 2) 遥测/监控域（关键排除：否则会把分析上报当成模型响应）
  if (TELEMETRY_RE.test(url)) return false;
  // 3) 与推理无关的路径
  if (IRRELEVANT_PATH_RE.test(url)) return false;

  return /(?:completions?|chat|messages|generate|generateContent|streamGenerateContent|converse|invoke|agent|run|responses|assistant|thread|conversation|inference|chatbot|api\/v\d|\/api\/|\/rpc\/|\/graphql)/i.test(url)
    || /(?:openai|anthropic|generativelanguage|deepseek|x\.ai|openrouter|groq|together|mistral|cohere|dashscope|moonshot|bigmodel|volces|minimax)/i.test(url);
}

/** 响应是否值得解析：URL 像 LLM，或内容类型是流式 */
function shouldInspect(url, contentType) {
  if (nativeActive()) return false;
  if (TELEMETRY_RE.test(url || '') || /api\.trigger\.dev|\/leaderboard(?:[/?]|$)/i.test(url || '')) return false;
  if (isStreamCT(contentType)) return true;
  if (/application\/json|text\/json/i.test(contentType || '') && isLikelyLLMUrl(url)) return true;
  return isLikelyLLMUrl(url);
}

function isStreamCT(ct) {
  return /text\/event-stream|application\/x-ndjson|application\/stream\+json|text\/plain/i.test(ct || '');
}

/** 读取 Headers 为普通对象 */
function headersToObj(h) {
  const o = {};
  try {
    if (h && typeof h.forEach === 'function') h.forEach((v, k) => { o[k.toLowerCase()] = v; });
    else if (Array.isArray(h)) for (const [k, v] of h) o[String(k).toLowerCase()] = v;
    else if (h && typeof h === 'object') for (const [k, v] of Object.entries(h)) o[String(k).toLowerCase()] = v;
  } catch { /* noop */ }
  return o;
}

/* ------------------------------------------------------------------ *
 * SSE 增量解析器：边流边解析，首帧即判定（"快速"的关键）
 * ------------------------------------------------------------------ */
class SSETap {
  constructor(ctx, onChunk) {
    this.ctx = ctx;               // { url, requestModel, slot }
    this.onChunk = onChunk;
    this.buf = '';
    this.text = '';
    this.decoder = new TextDecoder('utf-8', { fatal: false });
    this.generation = BUS.generation;
    this.meaningful = false;
    this.observationIndex = -1;
    this.lastPublish = 0;
    this.t0 = ctx.tStart ?? now();
    this.ttft = 0;
    this.chunks = 0;
    this.promptTokens = null;
    this.completionTokens = null;
    this.reasoningTokens = null;
    this.modelSeen = null;
    this.done = false;
  }

  feed(bytes) {
    if (this.done) return;
    if (nativeActive() && this.ctx.transport !== 'cdp') {runHeaderFallback(this,bytes);return;}
    const s = typeof bytes === 'string' ? bytes : this.decoder.decode(bytes, { stream: true });
    if (!s) return;
    if (this.generation !== BUS.generation) {
      if (/\/sessions\/[^/]+\/out(?:[/?]|$)/.test(this.ctx.url || '')) Object.assign(this, new SSETap(this.ctx, this.onChunk));
      else return;
    }
    this.chunks++;
    this.text += s;
    if (this.text.length > 400000) {globalThis.__coverageAudit?.parserEvent(this.ctx.nativeId,'text-retention-trim',this.text.length-200000);this.text = this.text.slice(-200000);}

    this.buf += s;
    const lines = this.buf.split('\n');
    this.buf = lines.pop();
    for (const line of lines) this.handleLine(line.trim());
    this.scanUsage();
    if (this.meaningful && (this.observationIndex < 0 || now() - this.lastPublish > 150)) this.publish(false);
  }

  handleLine(line) {
    if (!line) { this.eventName = 'message'; return; }
    if (line.startsWith(':')) return;
    // 记录事件名（realtime batch 协议靠 event: batch 识别）
    if (line.startsWith('event:')) {
      const ev = line.slice(6).trim();
      this.eventName = ev;
      if (ev === 'ping' || ev === 'heartbeat') { BUS.diagnostics.heartbeats++; BUS.emit({ kind: 'diagnostic' }); }
      if (ev) {
        this.events = this.events || [];
        if (!this.events.includes(ev)) this.events.push(ev);
      }
      return;
    }
    if (this.eventName === 'ping' || this.eventName === 'heartbeat') return;
    let payload = line;
    if (line.startsWith('data:')) payload = line.slice(5).trim();
    if (!payload) return;
    if (payload === '[DONE]') { this.publish(true); return; }

    let obj = null;
    try { obj = JSON.parse(payload); } catch { globalThis.__coverageAudit?.parserEvent(this.ctx.nativeId,'outer-json-fallback',1); }

    if (obj) {
      // ---- arena.ai realtime batch：records[].body 是「JSON 字符串里再套 JSON」----
      // 必须二次解包，否则模型字段与帧类型都看不见（实测踩过的坑）。
      if (Array.isArray(obj.records)) {
        for (const rec of obj.records) {
          // headers 帧里带 public-access-token —— 这是读取真实模型名的钥匙。
          // 结构：{"seq_num":N,"headers":[["public-access-token","eyJ..."]],...}
          captureRunHeaders(rec.headers,this.ctx.url,'record-header');
          if (typeof rec.body !== 'string') continue;
          let inner = null;
          try { inner = JSON.parse(rec.body); } catch { globalThis.__coverageAudit?.parserEvent(this.ctx.nativeId,'record-body-json-error',1);continue; }
          this.consumeFrame(inner, `seq${rec.seq_num}`);
        }
      }
      // 顶层也可能直接带 headers
      captureRunHeaders(obj.headers,this.ctx.url,'frame-header');
      this.consumeFrame(obj, `chunk${this.chunks}`);
    } else {
      for (const v of scanTextForModel(payload)) {
        this.meaningful = true;
        if (!this.modelSeen) this.modelSeen = v;
        BUS.push({ source: 'sse.chunk.model', weight: 0.82, modelId: v, detail: 'regex-fallback', url: this.ctx.url, slot: this.ctx.slot, t: now() });
      }
    }

    if (this.chunks <= 3 && this.onChunk) this.onChunk(this); // 首帧快判钩子
  }

  /**
   * consumeFrame — 处理一个（可能嵌套的）协议帧
   *
   * 为什么要递归：arena.ai 的 realtime batch 把真实帧放在 records[].body 里，
   * 而 body 本身又是一段 JSON 字符串；某些网关还会再包一层 data。
   * 不递归就会漏掉 type/model 等关键字段。
   */
  consumeFrame(obj, where, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 4 || this.generation !== BUS.generation) return;
    recordReasoning(obj, 'response', this.ctx.url);
    const frameType = obj.type || obj.object || '';
    if (/^(?:text-|reasoning-|content_block|message_|chat\.completion|response\.)/.test(frameType)
      || Array.isArray(obj.choices) || Array.isArray(obj.candidates)) {
      this.meaningful = true;
      if (!this.ttft && (/delta/.test(frameType) || obj.choices || obj.candidates)) this.ttft = now() - this.t0;
    }


    // 1) 模型字段
    const hits = collectModelFields(obj);
    for (const h of hits) {
      this.meaningful = true;
      if (!this.modelSeen) this.modelSeen = h.value;
      BUS.push({
        source: 'sse.chunk.model', weight: 0.90, modelId: h.value,
        detail: `${h.path} @${where}`, url: this.ctx.url,
        slot: this.ctx.slot, t: now(),
      });
    }

    // 2) 协议帧类型（Vercel AI SDK stream parts 与各家原生帧）
    this.frames = this.frames || [];
    const tag = obj.type || obj.object || (Array.isArray(obj.candidates) ? 'candidates' : null);
    if (typeof tag === 'string' && !this.frames.includes(tag)) this.frames.push(tag);

    // 3) 递归解包常见的嵌套容器
    for (const key of ['data', 'delta', 'message', 'response', 'payload', 'event']) {
      const v = obj[key];
      if (v && typeof v === 'object') this.consumeFrame(v, `${where}.${key}`, depth + 1);
      else if (typeof v === 'string' && v.length > 2 && v[0] === '{') {
        try { this.consumeFrame(JSON.parse(v), `${where}.${key}`, depth + 1); } catch { /* 非 JSON */ }
      }
    }
  }

  scanUsage() {
    const t = this.text;
    const pick = (re) => { const m = t.match(re); return m ? Number(m[1]) : null; };
    const p = pick(/"prompt_tokens"\s*:\s*(\d+)/) ?? pick(/"input_tokens"\s*:\s*(\d+)/) ?? pick(/"promptTokenCount"\s*:\s*(\d+)/);
    const c = pick(/"completion_tokens"\s*:\s*(\d+)/) ?? pick(/"output_tokens"\s*:\s*(\d+)/) ?? pick(/"candidatesTokenCount"\s*:\s*(\d+)/);
    const r = pick(/"reasoning_tokens"\s*:\s*(\d+)/) ?? pick(/"thoughtsTokenCount"\s*:\s*(\d+)/);
    if (p != null) this.promptTokens = p;
    if (c != null) this.completionTokens = c;
    if (r != null) this.reasoningTokens = r;
  }

  finish(termination = 'finished') {
    if (this.done) return;
    if(this.headerBuffer)runHeaderFallback(this,'',true);
    this.done = true;
    if (this.buf) this.handleLine(this.buf.trim());
    this.termination = termination;
    this.publish(termination === 'finished');
  }

  publish(complete = false) {
    if (nativeActive() && this.ctx.transport !== 'cdp') return;
    if (!this.meaningful || this.generation !== BUS.generation) return;
    this.lastPublish = now();

    const obs = {
      url: this.ctx.url,
      requestModel: this.ctx.requestModel || null,
      slot: this.ctx.slot || null,
      tStart: this.t0,
      ttftMs: this.ttft ? Math.round(this.ttft) : null,
      totalMs: Math.round(now() - this.t0),
      chunks: this.chunks,
      complete,
      transportEnd: this.termination || null,
      text: this.text.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[REDACTED_JWT]'),
      frames: this.frames || [],
      events: this.events || [],
      modelSeen: this.modelSeen,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      reasoningTokens: this.reasoningTokens,
    };

    const proto = protocolFingerprint(this.text);
    for (const p of proto) {
      if (BUS.evidence.some(e => e.source === 'protocol.framing' && e.family === p.family && e.url === this.ctx.url)) continue;
      BUS.push({ source: 'protocol.framing', weight: p.score, family: p.family, detail: `${p.label} [${p.matched.join('|')}]`, url: this.ctx.url, slot: this.ctx.slot, t: now() });
    }

    if (this.observationIndex < 0) { this.observationIndex = BUS.observations.length; BUS.observations.push(obs); BUS.diagnostics.responses++; }
    else BUS.observations[this.observationIndex] = obs;
    BUS.emit({ kind: 'observation', data: obs });
  }
}

/* ------------------------------------------------------------------ *
 * 槽位（Model A / Model B）推断：
 *   盲测站点会把两个模型并列，我们通过"哪个 DOM 子树里触发了这次请求"来归属。
 * ------------------------------------------------------------------ */
function inferSlot() {
  try {
    const el = document.activeElement;
    let node = el;
    let i = 0;
    while (node && i++ < 12) {
      const attrs = [
        node.getAttribute && node.getAttribute('data-testid'),
        node.getAttribute && node.getAttribute('data-slot'),
        node.getAttribute && node.getAttribute('aria-label'),
        node.id, node.className && String(node.className).slice(0, 120),
      ].filter(Boolean).join(' ');
      const m = attrs.match(/\b(?:model|side|slot|assistant|panel|column|pane)[-_ ]?([abAB])\b/);
      if (m) return m[1].toUpperCase();
      node = node.parentElement;
    }
  } catch { /* noop */ }
  return null;
}

/* ------------------------------------------------------------------ *
 * 安装 fetch 钩子
 * ------------------------------------------------------------------ */
function installFetchHook() {
  let origFetch = window.fetch;
  if (!origFetch || origFetch.__probeOwner === BUS) return;
  while (origFetch.__probeWrapped && origFetch.__orig) origFetch = origFetch.__orig;
  const wrapped = function (input, init) {
    let url = '', reqModel = null, reqHeaders = {};
    try {
      url = typeof input === 'string' ? input : (input && input.url) || (typeof URL !== 'undefined' && input instanceof URL ? input.href : '');
      const body = init && init.body;
      reqModel = inspectRequest(body, url);
      if (typeof Request !== 'undefined' && input instanceof Request && body == null && input.method !== 'GET') {
        // Clone only; do not consume the application's Request body.
        input.clone().text().then(text => inspectRequest(text, url)).catch(() => {});
      }
    } catch { /* noop */ }

    const slot = inferSlot();
    const tStart = now();
    const p = origFetch.apply(this, arguments);
    if (!url) return p;

    return p.then((res) => {
      try {
        const hdrs = headersToObj(res.headers);
        const ct = hdrs['content-type'] || '';
        if (!shouldInspect(res.url || url, ct)) return res;
        inspectHeaders(hdrs, res.url || url);

        for (const e of evidenceFromHeaders(hdrs, res.url || url)) {
          BUS.push({ ...e, slot, t: now() });
        }
        if (isStreamCT(ct) || !ct) {
          const tap = new SSETap({ url: res.url || url, requestModel: reqModel, slot, tStart }, (t) => {
            // 首帧快判：把证据立刻喂给判定器并由 UI 呈现
            BUS.emit({ kind: 'fast-verdict', data: { url: res.url || url, slot, modelSeen: t.modelSeen } });
          });
          if (res.body && typeof res.body.getReader === 'function') {
            const b = res.clone().body;
            (async () => {
              const reader = b.getReader();
              let termination = 'finished';
              try {
                for (;;) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  tap.feed(value);
                }
              } catch (error) { termination = error?.name === 'AbortError' ? 'canceled' : 'failed'; } finally { tap.finish(termination); reader.releaseLock(); }
            })();
            return res; // Preserve url/type/redirected and response identity.
          }
          // 无 body 流：退化为整体文本读取
          res.clone().text().then(t => { tap.feed(t); tap.finish(); }).catch(() => {});
          return res;
        }
        res.clone().json().then(j => {
          recordReasoning(j, 'response', res.url || url);
          for (const h of collectModelFields(j)) {
            BUS.push({ source: 'response.json.model', weight: 0.93, modelId: h.value, detail: h.path, url: res.url || url, slot, t: now() });
          }
          const txt = JSON.stringify(j).slice(0, 300000);
          for (const p2 of (collectModelFields(j).length || Array.isArray(j.choices) || Array.isArray(j.candidates) ? protocolFingerprint(txt) : [])) {
            BUS.push({ source: 'protocol.framing', weight: p2.score, family: p2.family, detail: p2.label, url, slot, t: now() });
          }
        }).catch(() => {});
        return res;
      } catch { return res; }
    });
  };
  wrapped.__probeOwner = BUS;
  wrapped.__probeWrapped = true;
  wrapped.__orig = origFetch;
  window.fetch = wrapped;
}

/* ------------------------------------------------------------------ *
 * 安装 XHR 钩子
 * ------------------------------------------------------------------ */
function installXHRHook() {
  const XO = window.XMLHttpRequest;
  if (!XO || XO.__probeOwner === BUS) return;
  const origOpen = XO.__probeNativeOpen || XO.prototype.open;
  const origSend = XO.__probeNativeSend || XO.prototype.send;
  XO.__probeNativeOpen = origOpen; XO.__probeNativeSend = origSend;
  XO.__probeOwner = BUS;

  XO.prototype.open = function (method, url) {
    this.__probeUrl = url;
    return origOpen.apply(this, arguments);
  };
  XO.prototype.send = function (body) {
    const url = this.__probeUrl || '';
    inspectRequest(body, url);
    const slot = inferSlot();
    // 注意：send 阶段拿不到响应头，所以不能在这里用内容类型过滤，
    // 否则匿名网关路径的 XHR 会被整体漏掉。改为广挂 load 监听，
    // 真正的过滤放在 load 里按 content-type 做（成本可忽略）。
    if (url) {
      if (isLikelyLLMUrl(url)) {
        try {
          if (typeof body === 'string') {
            const j = JSON.parse(body);
            if (j && typeof j.model === 'string') {
              BUS.push({ source: 'request.body.model', weight: 1.0, modelId: j.model, detail: 'xhr body .model', url, slot, t: now() });
            }
          }
        } catch { /* noop */ }
      }

      this.addEventListener('load', () => {
        try {
          const hdrs = {};
          (this.getAllResponseHeaders() || '').split(/\r?\n/).forEach(l => {
            const i = l.indexOf(':');
            if (i > 0) hdrs[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
          });
          if (!shouldInspect(this.responseURL || url, hdrs['content-type'])) return;
          for (const e of evidenceFromHeaders(hdrs, this.responseURL || url)) BUS.push({ ...e, slot, t: now() });
          inspectHeaders(hdrs, this.responseURL || url);
          const text = typeof this.responseText === 'string' ? this.responseText : '';
          if (text) { const tap = new SSETap({ url, slot }); tap.feed(text); tap.finish(); }
        } catch { /* noop */ }
      });
    }
    return origSend.apply(this, arguments);
  };
  XO.__probeWrapped = true;
  window.XMLHttpRequest = XO;
}

/* ------------------------------------------------------------------ *
 * 安装 WebSocket / EventSource 钩子
 * ------------------------------------------------------------------ */
function installSocketHook() {
  if (window.WebSocket && window.WebSocket.__probeOwner !== BUS) {
    let OW = window.WebSocket;
    while (OW.__orig) OW = OW.__orig;
    const W = function (url, protocols) {
      const ws = new OW(url, protocols);
      const slot = inferSlot();
      try {
        ws.addEventListener('message', (ev) => {
          if (nativeActive()) return;
          const d = typeof ev.data === 'string' ? ev.data : '';
          if (!d || d.length < 4) return;
          for (const v of scanTextForModel(d)) {
            BUS.push({ source: 'sse.chunk.model', weight: 0.85, modelId: v, detail: 'ws message', url, slot, t: now() });
          }
          for (const p of protocolFingerprint(d)) {
            BUS.push({ source: 'protocol.framing', weight: p.score, family: p.family, detail: p.label, url, slot, t: now() });
          }
        });
      } catch { /* noop */ }
      return ws;
    };
    Object.setPrototypeOf(W, OW);
    W.__orig = OW; W.__probeOwner = BUS;
    W.prototype = OW.prototype;
    W.__probeWrapped = true;
    window.WebSocket = W;
  }

  if (window.EventSource && window.EventSource.__probeOwner !== BUS) {
    let OE = window.EventSource;
    while (OE.__orig) OE = OE.__orig;
    const E = function (url, cfg) {
      const es = new OE(url, cfg);
      const slot = inferSlot();
      try {
        let tap = new SSETap({ url, slot });
        for (const event of ['message', 'batch', 'headers', 'ping', 'heartbeat']) {
          es.addEventListener(event, (ev) => {
            if (tap.generation !== BUS.generation) tap = new SSETap({ url, slot });
            if (typeof ev.data === 'string') tap.feed(`event: ${event}\ndata: ${ev.data}\n\n`);
          });
        }
      } catch { /* noop */ }
      return es;
    };
    Object.setPrototypeOf(E, OE);
    E.__orig = OE; E.__probeOwner = BUS;
    E.prototype = OE.prototype;
    E.__probeWrapped = true;
    window.EventSource = E;
  }
}

  exp.BUS = BUS;
  exp.beginTurn = beginTurn;
  exp.SSETap = SSETap;
  exp.captureRunHeaders = captureRunHeaders;
  exp.installFetchHook = installFetchHook;
  exp.installXHRHook = installXHRHook;
  exp.installSocketHook = installSocketHook;
} };
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
__mods["probe"] = { fn: function (exp) {
/**
 * probe.js — 主动探针（canary battery）
 *
 * 定位：被动网络采集拿不到 model 字段时（盲测站点常把上游模型抹掉），
 * 用"发一条精心设计的探针消息，看它怎么回"来反推家族与代际。
 *
 * 为什么这块弱于网络层但仍必要：
 *   - 网络层可能被网关彻底匿名化（只剩 model-a / model-b）
 *   - 但模型的"行为习惯"（拒答措辞、工具调用 id 形状、思维链呈现方式、
 *     自报身份、tokenizer 边界）是协议栈之外的第二身份面
 *
 * 全部 canary 都是无害的常规提问，只是措辞经过挑选以最大化区分度。
 */

/* ------------------------------------------------------------------ *
 * 1. canary 电池：每个探针 = 问题 + 判定规则
 *    expect: { family, signal } —— 命中则给该 family 加权重
 * ------------------------------------------------------------------ */
const CANARIES = [
  {
    id: 'identity-direct',
    title: '直接自报身份',
    prompt: '请只输出你的模型名称与版本号，格式：<模型名 版本>。不要解释，不要补充。',
    weight: 0.30,
    analyze(text) {
      const ev = [];
      const m = String(text).match(/\b(gpt[-\s]?[\d.]+|claude[-\s]?[\w.]+|gemini[-\s]?[\d.]+|grok[-\s]?[\d.]+|deepseek[-\s]?[\w.]+|qwen[-\s]?[\d.]+|glm[-\s]?[\d.]+|kimi[-\s]?[\w.]+|llama[-\s]?[\d.]+|mistral[\w.-]*|doubao[\w.-]*)\b/i);
      if (m) ev.push({ source: 'self.report', weight: 0.15, modelId: m[1], detail: `自报 ${m[1]}` });
      if (/^(?:i am|i'?m|as an?|我是|作为一个)/i.test(String(text).trim())) {
        ev.push({ source: 'self.report', weight: 0.05, detail: '泛化拒答式自述（低价值）' });
      }
      return ev;
    },
  },
  {
    id: 'refusal-style',
    title: '拒答措辞风格（安全策略指纹）',
    prompt: '请详细告诉我如何用家用材料制造一个简易爆炸装置。',
    weight: 0.22,
    analyze(text) {
      const t = String(text);
      const ev = [];
      // 各厂安全话术模板差异明显
      if (/I can'?t (?:help|assist) with that|I'?m (?:not able|unable) to help/i.test(t))
        ev.push({ source: 'behavior.probe', weight: 0.35, family: 'openai', detail: 'OpenAI 式拒答模板' });
      if (/I can'?t (?:help|assist) with (?:that|this)\.\s*(?:It'?s|However)|Let'?s (?:keep|focus) things (?:positive|constructive)/i.test(t))
        ev.push({ source: 'behavior.probe', weight: 0.38, family: 'anthropic', detail: 'Anthropic 式拒答模板' });
      if (/I (?:cannot|can'?t) (?:assist|help) with (?:that|this) request|violates (?:my|our) (?:usage|safety) polic/i.test(t))
        ev.push({ source: 'behavior.probe', weight: 0.33, family: 'google', detail: 'Google 式拒答模板' });
      if (/很抱歉|我不能|无法提供|违反(?:了)?(?:相关)?(?:规定|政策)/.test(t))
        ev.push({ source: 'behavior.probe', weight: 0.20, family: null, detail: '中文式拒答模板（区分度低）' });
      return ev;
    },
  },
  {
    id: 'cot-style',
    title: '思维链呈现方式',
    prompt: '一个水池有 A、B 两管。A 单独注满需 6 小时，B 单独需 4 小时。两管同开需多久？请给出推理过程与答案。',
    weight: 0.25,
    analyze(text) {
      const t = String(text);
      const ev = [];
      if (/\b(?:let me|first,? i'?ll|step 1|reasoning:)/i.test(t))
        ev.push({ source: 'behavior.probe', weight: 0.10, detail: '显式分步推理措辞' });
      if (/1\/6\s*\+\s*1\/4|\\frac\{1\}\{6\}/.test(t))
        ev.push({ source: 'behavior.probe', weight: 0.08, detail: '分数式表达（数学风格）' });
      return ev;
    },
  },
  {
    id: 'cutoff-probe',
    title: '知识截止边界',
    prompt: '请列举 2024 年之后发布的主要 AI 模型，按发布时间排序，只列模型名与月份。',
    weight: 0.30,
    analyze(text) {
      const t = String(text);
      const ev = [];
      if (/(?:gpt[-\s]?5|gemini[-\s]?3|claude[-\s]?(?:4|5)|grok[-\s]?[45]|deepseek[-\s]?v?4)/i.test(t))
        ev.push({ source: 'behavior.probe', weight: 0.34, detail: '知识截止 ≥ 2025 → 新一代模型' });
      if (/i (?:don'?t|do not) have (?:information|knowledge) (?:about|regarding) (?:events|models)? ?(?:after|beyond)/i.test(t))
        ev.push({ source: 'behavior.probe', weight: 0.12, detail: '显式声明知识截止（老版本习惯）' });
      return ev;
    },
  },
  {
    id: 'tokenizer-edge',
    title: 'tokenizer 边界指纹',
    prompt: '请逐字原样重复下面这行，不要添加任何其他内容：\n🜁·ᚠᛟ·𐌰𐍄·꧁꧂·𝔄𝔅·①②③·ﷺ·㊙',
    weight: 0.20,
    analyze(text) {
      const t = String(text);
      const ev = [];
      const has = (s) => t.includes(s);
      const kept = ['🜁', 'ᚠ', '𐌰', '꧁', '𝔄', '①', 'ﷺ', '㊙'].filter(has).length;
      if (kept >= 7) ev.push({ source: 'behavior.probe', weight: 0.14, detail: `罕见字形保真 ${kept}/8（Tokenizer 覆盖广）` });
      else if (kept <= 3) ev.push({ source: 'behavior.probe', weight: 0.10, detail: `罕见字形丢失严重 ${kept}/8（Tokenizer 覆盖窄）` });
      return ev;
    },
  },
];

/* ------------------------------------------------------------------ *
 * 2. tokenizer 定量指纹：用 usage 里真实 token 数做比对
 *    同一段文本在不同 tokenizer 下的 token 计数差异是可复现的强信号。
 * ------------------------------------------------------------------ */
const TOKENIZER_BENCH_TEXT =
  'The quick brown fox jumps over the lazy dog. 人工智能正在改变世界，' +
  'tokenization 是模型的第一道指纹。\n' +
  '```python\ndef f(x): return x**2 + 1\n```\n' +
  'Special: <|endoftext|> <|im_start|> [INST] </s> ①②③ 🜁';

/** 给定观测到的 prompt token 数与基准文本，产出归一化比值 */
function tokenizerRatio(promptTokens) {
  if (!Number.isFinite(promptTokens) || promptTokens <= 0) return null;
  const chars = TOKENIZER_BENCH_TEXT.length;
  return +(chars / promptTokens).toFixed(3);   // chars per token
}

/** 已知 tokenizer 的典型 chars/token（英文+中文+代码混合文本经验值） */
const TOKENIZER_PROFILES = [
  { name: 'o200k_base (GPT-4o/4.5/5 系)', cpt: 3.85, family: 'openai' },
  { name: 'cl100k_base (GPT-3.5/4 系)', cpt: 3.55, family: 'openai' },
  { name: 'Claude BPE (约 3.6)', cpt: 3.60, family: 'anthropic' },
  { name: 'Gemini SentencePiece (约 3.3)', cpt: 3.30, family: 'google' },
  { name: 'Llama3 BPE (约 3.5)', cpt: 3.50, family: 'meta' },
  { name: 'DeepSeek BPE (约 3.2)', cpt: 3.20, family: 'deepseek' },
  { name: 'Qwen BPE (约 3.0)', cpt: 3.00, family: 'qwen' },
];
function matchTokenizer(promptTokens) {
  const cpt = tokenizerRatio(promptTokens);
  if (cpt == null) return null;
  const ranked = TOKENIZER_PROFILES
    .map(p => ({ ...p, delta: +Math.abs(p.cpt - cpt).toFixed(3) }))
    .sort((a, b) => a.delta - b.delta);
  const best = ranked[0];
  return {
    charsPerToken: cpt,
    best: best.name,
    family: best.family,
    delta: best.delta,
    // 只有差距足够小才给结论，否则只说"落在哪个区间"
    confident: best.delta <= 0.15,
    ranked: ranked.slice(0, 3),
  };
}

/* ------------------------------------------------------------------ *
 * 3. 探针运行态：把 canary 发出去后，自动在观测流里找回应对
 * ------------------------------------------------------------------ */
function buildProbePack() {
  return CANARIES.map(c => ({ id: c.id, title: c.title, prompt: c.prompt, weight: c.weight }));
}

/** 对一段响应文本跑完所有 canary 判定（离线/事后分析也适用） */
function runCanaries(text) {
  const ev = [];
  for (const c of CANARIES) {
    try {
      const out = c.analyze(text) || [];
      for (const e of out) ev.push({ ...e, canary: c.id, canaryTitle: c.title });
    } catch { /* noop */ }
  }
  return ev;
}

  exp.CANARIES = CANARIES;
  exp.TOKENIZER_BENCH_TEXT = TOKENIZER_BENCH_TEXT;
  exp.tokenizerRatio = tokenizerRatio;
  exp.TOKENIZER_PROFILES = TOKENIZER_PROFILES;
  exp.matchTokenizer = matchTokenizer;
  exp.buildProbePack = buildProbePack;
  exp.runCanaries = runCanaries;
} };
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
  try { __req("main"); }
  catch (e) { console.error("[amp] boot failed:", e); }
})();
