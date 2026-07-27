export const ROUTING_MODES = [
  "maximum_quality",
  "balanced",
  "cost_saver",
  "local_private_first",
  "manual",
  "shadow_test",
  "canary"
];

export const TASK_TYPES = [
  "chat",
  "rewrite",
  "summarize",
  "extract",
  "extract_json",
  "code",
  "code_debug",
  "architecture",
  "research",
  "math",
  "vision",
  "tool_use",
  "high_stakes",
  "unknown"
];

export const TIERS = ["local", "cheap", "mid", "premium"];

export const REASONING_SCORE = { low: 1, medium: 2, high: 3 };

export const SCORE_WEIGHTS = {
  maximum_quality: {
    quality_fit: 0.55,
    capability_fit: 0.25,
    reliability_fit: 0.1,
    latency_fit: 0.05,
    cost_fit: 0.05
  },
  balanced: {
    quality_fit: 0.45,
    capability_fit: 0.25,
    latency_fit: 0.1,
    reliability_fit: 0.1,
    cost_fit: 0.1
  },
  cost_saver: {
    cost_fit: 0.4,
    capability_fit: 0.25,
    quality_fit: 0.2,
    latency_fit: 0.1,
    reliability_fit: 0.05
  },
  local_private_first: {
    cost_fit: 0.35,
    capability_fit: 0.3,
    quality_fit: 0.15,
    latency_fit: 0.1,
    reliability_fit: 0.1
  }
};

export const TIER_RANK = { local: 0, cheap: 1, mid: 2, premium: 3 };

export const CLASSIFIER_PROMPT = `You are RouterBot's routing classifier.

Classify the user's request for model routing.
Do not answer the user's request.
Return strict JSON only.

Fields:
- task_type: one of [chat, rewrite, summarize, extract, code, code_debug, architecture, research, math, vision, tool_use, high_stakes, unknown]
- complexity: integer 1-5
- risk: integer 1-5
- needs_tools: boolean
- needs_vision: boolean
- needs_long_context: boolean
- needs_strict_json: boolean
- privacy_level: one of [normal, sensitive, local_only]
- recommended_tier: one of [local, cheap, mid, premium]
- confidence: number 0-1
- reason: short string

Rules:
- Prefer cheap/local for simple rewrites, summaries, extraction, formatting, and casual chat.
- Prefer mid/premium for architecture, difficult code, ambiguous debugging, long context, planning, or high-stakes requests.
- If unsure, set confidence below 0.70.
- Never choose a specific provider or model.

Request:
"{{prompt}}"`;
