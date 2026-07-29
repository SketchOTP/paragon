import { addLog } from "./logStore.js";
import { alignProviderModel } from "./modelList.js";

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl ?? "")
    .trim()
    .replace(/\/+$/, "");
}

/** OpenAI-compatible API root — accepts host-only URLs (appends /v1). */
export function openAiBaseUrl(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) {
    return "";
  }
  if (/\/v\d+$/.test(normalized)) {
    return normalized;
  }
  return `${normalized}/v1`;
}

export async function runHttpProvider(provider, providerConfig, prompt, onChunk) {
  const baseUrl = openAiBaseUrl(providerConfig.baseUrl);
  if (!baseUrl) {
    throw new Error(`${provider}: baseUrl is required for HTTP providers`);
  }

  const headers = { "Content-Type": "application/json" };
  if (providerConfig.apiKey) {
    headers.Authorization = `Bearer ${providerConfig.apiKey}`;
  }

  const body = {
    model: providerConfig.model || undefined,
    messages: [{ role: "user", content: prompt }],
    stream: Boolean(onChunk)
  };
  // Only set for bounded validation probes (see modelCatalogRefresh.js) —
  // never for a real completion, where the caller must get the full
  // response it asked for.
  if (providerConfig.maxTokens != null) {
    body.max_tokens = providerConfig.maxTokens;
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(providerConfig.timeoutMs ?? 300000)
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`HTTP ${response.status}: ${detail.slice(0, 500)}`);
  }

  if (onChunk && response.body) {
    return streamHttpResponse(provider, response, onChunk);
  }

  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content ?? "";
  addLog({
    type: "completion",
    provider,
    level: "info",
    message: `HTTP completion ${content.length} chars`
  });
  return { stdout: content, stderr: "", code: 0 };
}

async function streamHttpResponse(provider, response, onChunk) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let stdout = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) {
        continue;
      }
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") {
        continue;
      }
      try {
        const chunk = JSON.parse(data);
        const text = chunk.choices?.[0]?.delta?.content;
        if (text) {
          stdout += text;
          onChunk(text);
        }
      } catch {
        // ignore malformed SSE chunks
      }
    }
  }

  addLog({
    type: "completion",
    provider,
    level: "info",
    message: `HTTP stream ${stdout.length} chars`
  });
  return { stdout, stderr: "", code: 0 };
}

export async function listHttpModels(provider, providerConfig) {
  const baseUrl = openAiBaseUrl(providerConfig.baseUrl);
  if (!baseUrl) {
    return [];
  }

  const headers = {};
  if (providerConfig.apiKey) {
    headers.Authorization = `Bearer ${providerConfig.apiKey}`;
  }

  const response = await fetch(`${baseUrl}/models`, {
    headers,
    signal: AbortSignal.timeout(30000)
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} listing models at ${baseUrl}/models`);
  }

  const payload = await response.json();
  if (payload.error && !payload.data?.length) {
    throw new Error(
      `${payload.error} — set baseUrl to the OpenAI root (e.g. http://127.0.0.1:1234/v1)`
    );
  }

  const models = (payload.data ?? []).map((model) => ({
    id: model.id,
    name: model.id
  }));
  if (!models.length) {
    throw new Error(`No models returned from ${baseUrl}/models`);
  }
  addLog({
    type: "models",
    provider,
    level: "info",
    message: `Loaded ${models.length} models from HTTP endpoint`
  });
  return alignProviderModel(providerConfig, models);
}

export async function checkHttpStatus(provider, providerConfig, { quiet = false } = {}) {
  const baseUrl = openAiBaseUrl(providerConfig.baseUrl);
  if (!baseUrl) {
    throw new Error("baseUrl is not configured");
  }

  const headers = {};
  if (providerConfig.apiKey) {
    headers.Authorization = `Bearer ${providerConfig.apiKey}`;
  }

  const response = await fetch(`${baseUrl}/models`, {
    headers,
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} — check baseUrl and API key`);
  }

  const output = `Reachable at ${baseUrl}`;
  if (!quiet) {
    addLog({ type: "status", provider, level: "info", message: output });
  }
  return { stdout: output, stderr: "", code: 0 };
}
