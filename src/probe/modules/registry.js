
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