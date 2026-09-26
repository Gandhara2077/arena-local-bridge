

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