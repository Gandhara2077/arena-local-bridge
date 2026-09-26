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