
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