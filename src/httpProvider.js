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
  return withHttpBaseUrlFallback(providerConfig, async (baseUrl) => {
    const apiRoot = openAiBaseUrl(baseUrl);
    const headers = { "Content-Type": "application/json" };
    if (providerConfig.apiKey) {
      headers.Authorization = `Bearer ${providerConfig.apiKey}`;
    }

    const body = {
      model: providerConfig.model || undefined,
      messages: [{ role: "user", content: prompt }],
      stream: Boolean(onChunk)
    };

    const response = await fetch(`${apiRoot}/chat/completions`, {
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
  });
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

function httpModelsUrl(baseUrl) {
  return `${openAiBaseUrl(baseUrl)}/models`;
}

function isHttpNetworkError(error) {
  const message = unwrapFetchError(error);
  return /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|No route to host|network/i.test(
    message
  );
}

function unwrapFetchError(error) {
  const parts = [];
  let current = error;
  while (current) {
    if (current.code) {
      parts.push(String(current.code));
    }
    if (current.message) {
      parts.push(String(current.message));
    }
    current = current.cause;
  }
  return parts.join(" — ");
}

export function baseUrlCandidates(providerConfig) {
  const primary = normalizeBaseUrl(providerConfig?.baseUrl);
  const fallbacks = (providerConfig?.baseUrlFallbacks ?? [])
    .map((entry) => normalizeBaseUrl(entry))
    .filter(Boolean);
  return [...new Set([primary, ...fallbacks].filter(Boolean))];
}

async function withHttpBaseUrlFallback(providerConfig, run) {
  const candidates = baseUrlCandidates(providerConfig);
  if (!candidates.length) {
    throw new Error("baseUrl is required for HTTP providers");
  }

  let lastError = null;
  for (const candidate of candidates) {
    try {
      return await run(candidate);
    } catch (error) {
      lastError = error;
      const canRetry =
        candidates.length > 1 && candidate !== candidates[candidates.length - 1] && isHttpNetworkError(error);
      if (!canRetry) {
        throw enrichHttpModelFetchError(providerConfig.baseUrl, error, candidates);
      }
    }
  }

  throw enrichHttpModelFetchError(providerConfig.baseUrl, lastError, candidates);
}

function parseHttpModelPayload(payload) {
  if (payload.error && !payload.data?.length) {
    const message =
      typeof payload.error === "string"
        ? payload.error
        : (payload.error.message ?? JSON.stringify(payload.error));
    throw new Error(
      `${message} — set baseUrl to the OpenAI root (e.g. http://127.0.0.1:1234 or http://host:1234/v1)`
    );
  }

  const rows = payload.data ?? payload.models ?? [];
  return rows
    .map((model) => {
      const id = model.id ?? model.name;
      if (!id) {
        return null;
      }
      return {
        id: String(id),
        name: String(model.name ?? model.id ?? id)
      };
    })
    .filter(Boolean);
}

async function fetchHttpModelList(baseUrl, apiKey) {
  const url = httpModelsUrl(baseUrl);
  const attempts = [];
  if (apiKey) {
    attempts.push({ Authorization: `Bearer ${apiKey}` });
  }
  attempts.push({});

  let lastError = null;
  for (const authHeaders of attempts) {
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json", ...authHeaders },
        signal: AbortSignal.timeout(30_000)
      });
      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status} listing models at ${url}`);
        if (response.status === 401 && Object.keys(authHeaders).length) {
          continue;
        }
        throw lastError;
      }
      return parseHttpModelPayload(await response.json());
    } catch (error) {
      lastError = error;
      if (Object.keys(authHeaders).length) {
        continue;
      }
      throw enrichHttpModelFetchError(baseUrl, error);
    }
  }

  throw enrichHttpModelFetchError(baseUrl, lastError ?? new Error("HTTP model list failed"));
}

function enrichHttpModelFetchError(baseUrl, error, candidates = []) {
  const detail = unwrapFetchError(error);
  if (!isHttpNetworkError(error)) {
    return error instanceof Error ? error : new Error(detail);
  }

  const tried = candidates.length ? candidates.map((entry) => httpModelsUrl(entry)).join(", ") : httpModelsUrl(baseUrl);
  let hint = "Check that LM Studio (or the OpenAI-compatible server) is running and listening on that host.";
  if (/^https?:\/\/169\.254\./i.test(String(baseUrl ?? ""))) {
    hint =
      "169.254.x.x is link-local and is often only reachable on the same machine or cable — use the host LAN or Tailscale URL instead (for example http://sketch:1234).";
  }

  return new Error(`Could not reach ${tried}. ${hint} (${detail})`);
}

export async function listHttpModels(provider, providerConfig) {
  const models = await withHttpBaseUrlFallback(providerConfig, (baseUrl) =>
    fetchHttpModelList(baseUrl, providerConfig.apiKey)
  );
  if (!models.length) {
    throw new Error(`No models returned from ${httpModelsUrl(providerConfig.baseUrl)}`);
  }
  addLog({
    type: "models",
    provider,
    level: "info",
    message: `Loaded ${models.length} models from HTTP endpoint`
  });
  return alignProviderModel(providerConfig, models);
}

/** Test helper: parse OpenAI-compatible /v1/models JSON */
export function parseHttpModelListResponse(payload) {
  const rows = payload?.data ?? payload?.models ?? [];
  return rows
    .map((model) => {
      const id = model.id ?? model.name;
      if (!id) {
        return null;
      }
      return {
        id: String(id),
        name: String(model.name ?? model.id ?? id)
      };
    })
    .filter(Boolean);
}

export async function checkHttpStatus(provider, providerConfig, { quiet = false } = {}) {
  return withHttpBaseUrlFallback(providerConfig, async (baseUrl) => {
    const apiRoot = openAiBaseUrl(baseUrl);
    const headers = { Accept: "application/json" };
    if (providerConfig.apiKey) {
      headers.Authorization = `Bearer ${providerConfig.apiKey}`;
    }

    const response = await fetch(`${apiRoot}/models`, {
      headers,
      signal: AbortSignal.timeout(15_000)
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} — check baseUrl and API key`);
    }

    const output = `Reachable at ${apiRoot}`;
    if (!quiet) {
      addLog({ type: "status", provider, level: "info", message: output });
    }
    return { stdout: output, stderr: "", code: 0 };
  });
}
