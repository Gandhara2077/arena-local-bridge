
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