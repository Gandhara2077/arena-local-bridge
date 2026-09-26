
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