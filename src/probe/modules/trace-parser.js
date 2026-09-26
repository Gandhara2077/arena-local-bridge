
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