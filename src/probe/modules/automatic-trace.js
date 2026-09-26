
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