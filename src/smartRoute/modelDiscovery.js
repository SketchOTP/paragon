import { listModels, runProvider } from "../cli.js";
import { classifyProviderRunResult } from "./providerResult.js";
import { toCanonicalId } from "./modelSnapshotStore.js";

const CLI_PROVIDERS = new Set(["antigravity", "cursor", "codex", "claude"]);
const PROBE_PROMPT = "Reply with exactly: pong";

const KNOWN_ANTHROPIC_MODELS = [
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5"
];

export async function discoverModels(config, { probe = false } = {}) {
  const records = [];
  const providers = config?.providers ?? {};

  for (const [providerName, providerConfig] of Object.entries(providers)) {
    if (providerConfig.enabled === false) {
      continue;
    }

    if (providerConfig.type === "http" || providerName.includes("ollama") || providerName.includes("local")) {
      records.push(...(await discoverOpenAiCompatible(providerName, providerConfig, { probe })));
      continue;
    }

    if (providerName === "openai" || providerConfig.type === "openai") {
      records.push(...(await discoverOpenAi(providerName, providerConfig, { probe })));
      continue;
    }

    if (providerName === "openrouter" || providerConfig.openrouter === true) {
      records.push(...(await discoverOpenRouter(providerName, providerConfig)));
      continue;
    }

    if (providerName === "anthropic" || (providerConfig.type === "anthropic")) {
      records.push(...(await discoverAnthropic(providerName, providerConfig, { probe })));
      continue;
    }

    if (CLI_PROVIDERS.has(providerName)) {
      records.push(...(await discoverCliProvider(providerName, providerConfig, { probe })));
    }
  }

  return dedupeRecords(records);
}

async function discoverOpenAi(providerName, providerConfig, { probe }) {
  const baseUrl = (providerConfig.baseUrl ?? "https://api.openai.com").replace(/\/$/, "");
  try {
    const models = await fetchOpenAiModelList(baseUrl, providerConfig.apiKey ?? providerConfig.api_key);
    return models.map((id) =>
      baseRecord({
        provider: providerName,
        model: id,
        availability_source: "api_list",
        capabilities: defaultCapabilities(providerConfig)
      })
    );
  } catch {
    return configModelRecords(providerName, providerConfig, "config");
  }
}

async function discoverOpenAiCompatible(providerName, providerConfig, { probe }) {
  const baseUrl = (providerConfig.baseUrl ?? providerConfig.base_url ?? "").replace(/\/$/, "");
  if (baseUrl) {
    try {
      const models = await fetchOpenAiModelList(baseUrl, providerConfig.apiKey ?? providerConfig.api_key);
      return models.map((id) =>
        baseRecord({
          provider: providerName,
          model: id,
          availability_source: "api_list",
          local: providerConfig.local === true || providerName.includes("local"),
          capabilities: defaultCapabilities(providerConfig)
        })
      );
    } catch {
      // fall through to config list
    }
  }

  return configModelRecords(providerName, providerConfig, "config");
}

async function discoverOpenRouter(providerName, providerConfig) {
  const baseUrl = (providerConfig.baseUrl ?? "https://openrouter.ai/api").replace(/\/$/, "");
  const url = `${baseUrl}/v1/models`;
  const headers = { Accept: "application/json" };
  if (providerConfig.apiKey) {
    headers.Authorization = `Bearer ${providerConfig.apiKey}`;
  }
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    throw new Error(`OpenRouter models HTTP ${response.status}`);
  }
  const json = await response.json();
  const list = json.data ?? json.models ?? [];
  return list.map((row) => {
    const id = row.id ?? row.name;
    return baseRecord({
      provider: providerName,
      model: id,
      availability_source: "api_list",
      openrouter_metadata: {
        context_length: row.context_length,
        pricing: row.pricing,
        top_provider: row.top_provider
      },
      capabilities: {
        ...defaultCapabilities(providerConfig),
        context_tokens: row.context_length ?? 128000
      }
    });
  });
}

async function discoverAnthropic(providerName, providerConfig, { probe }) {
  const configured = (providerConfig.models ?? []).map((m) => (typeof m === "string" ? m : m.id)).filter(Boolean);
  const candidates = configured.length ? configured : KNOWN_ANTHROPIC_MODELS;
  const records = [];

  for (const modelId of candidates) {
    const record = baseRecord({
      provider: providerName,
      model: modelId,
      availability_source: probe ? "probe" : "config",
      capabilities: defaultCapabilities(providerConfig)
    });
    if (probe && providerConfig.enabled !== false) {
      record.available = await probeCliModel(providerName, { ...providerConfig, model: modelId });
      if (!record.available) {
        record.degraded = true;
      }
    }
    records.push(record);
  }
  return records;
}

async function discoverCliProvider(providerName, providerConfig, { probe }) {
  let modelIds = [];
  try {
    const liveModels = await listModels(providerName, providerConfig);
    modelIds = liveModels.map((model) => model.id).filter(Boolean);
  } catch {
    modelIds = providerConfig.models?.length
      ? providerConfig.models.map((m) => (typeof m === "string" ? m : m.id))
      : [providerConfig.model || "default"].filter(Boolean);
  }

  const records = [];
  for (const modelId of modelIds) {
    const record = baseRecord({
      provider: providerName,
      model: modelId || "default",
      availability_source: probe ? "probe" : "config",
      capabilities: defaultCapabilities(providerConfig),
      tier: providerName === "antigravity" ? "cheap" : undefined
    });
    if (probe) {
      const ok = await probeCliModel(providerName, { ...providerConfig, model: modelId });
      record.available = ok;
      if (!ok) {
        record.degraded = true;
      }
    }
    records.push(record);
  }
  return records;
}

async function fetchOpenAiModelList(baseUrl, apiKey) {
  const url = `${baseUrl.replace(/\/v1$/, "")}/v1/models`;
  const headers = { Accept: "application/json" };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) {
    throw new Error(`OpenAI-compatible models HTTP ${response.status}`);
  }
  const json = await response.json();
  return (json.data ?? []).map((row) => row.id).filter(Boolean);
}

function configModelRecords(providerName, providerConfig, source) {
  const models = providerConfig.models?.length
    ? providerConfig.models.map((m) => (typeof m === "string" ? m : m.id))
    : [providerConfig.model || "default"].filter(Boolean);

  return models.map((modelId) =>
    baseRecord({
      provider: providerName,
      model: modelId || "default",
      availability_source: source,
      local: providerConfig.local === true,
      capabilities: defaultCapabilities(providerConfig)
    })
  );
}

async function probeCliModel(providerName, providerConfig) {
  try {
    const result = await runProvider(
      providerName,
      { ...providerConfig, timeoutMs: Math.min(providerConfig.timeoutMs ?? 60_000, 60_000) },
      PROBE_PROMPT
    );
    const check = classifyProviderRunResult(result, null, { requireContent: true });
    return check.ok;
  } catch {
    return false;
  }
}

function baseRecord({ provider, model, availability_source, capabilities, tier, local, openrouter_metadata }) {
  const now = new Date().toISOString();
  return {
    canonical_id: toCanonicalId(provider, model),
    provider,
    model: model || "default",
    source_model_id: model || "default",
    available: true,
    availability_source,
    last_seen_at: now,
    first_seen_at: now,
    removed_at: null,
    tier: tier ?? null,
    local: local === true,
    capabilities: capabilities ?? defaultCapabilities(),
    openrouter_metadata: openrouter_metadata ?? null
  };
}

function defaultCapabilities(providerConfig = {}) {
  return {
    chat: true,
    reasoning: "medium",
    coding: "medium",
    vision: false,
    tool_calling: providerConfig.tool_calling !== false,
    json_mode: true,
    structured_output: true,
    context_tokens: providerConfig.context_tokens ?? 128000
  };
}

function dedupeRecords(records) {
  const map = new Map();
  for (const row of records) {
    map.set(row.canonical_id, row);
  }
  return [...map.values()];
}

/** Test helper: parse OpenAI /v1/models JSON */
export function parseOpenAiModelListResponse(json) {
  return (json?.data ?? []).map((row) => row.id).filter(Boolean);
}

/** Test helper: parse OpenRouter /v1/models JSON */
export function parseOpenRouterModelListResponse(json) {
  return (json?.data ?? json?.models ?? []).map((row) => ({
    id: row.id ?? row.name,
    context_length: row.context_length,
    pricing: row.pricing
  }));
}
