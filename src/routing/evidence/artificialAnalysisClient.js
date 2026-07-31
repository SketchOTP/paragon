const BASE_URL = "https://artificialanalysis.ai/api/v2";

export function createArtificialAnalysisClient({ apiKey, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  const headers = () => ({ "x-api-key": apiKey, accept: "application/json" });
  async function request(pathname, options = {}) {
    if (!apiKey) throw new Error("Artificial Analysis API key is not configured");
    const response = await fetchImpl(`${BASE_URL}${pathname}`, { ...options, headers: { ...headers(), ...(options.headers ?? {}) } });
    if (!response.ok) { const error = new Error(`Artificial Analysis request failed: ${response.status}`); error.status = response.status; error.kind = response.status === 401 ? "invalid_credentials" : response.status === 403 ? "forbidden" : response.status === 429 ? "rate_limited" : "request_failed"; error.retryAfter = response.headers.get("retry-after"); throw error; }
    return { body: await response.json(), headers: response.headers };
  }
  async function fetchModels({ tier = "free", promptType = "medium", limit = 100 } = {}) {
    const path = tier === "free" ? `/language/models/free?limit=${limit}` : `/language/models?prompt_type=${encodeURIComponent(promptType)}&limit=${limit}`;
    const rows = []; let cursor; let reportedTier = null; let rateLimitRemaining = null; let rateLimitReset = null;
    do {
      const suffix = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
      const result = await request(`${path}${suffix}`);
      const data = result.body?.data ?? result.body?.models ?? (Array.isArray(result.body) ? result.body : []);
      rows.push(...data);
      reportedTier = result.body?.tier ?? result.body?.subscription_tier ?? reportedTier;
      rateLimitRemaining = result.headers.get("x-ratelimit-remaining") ?? result.headers.get("x-rate-limit-remaining") ?? rateLimitRemaining;
      rateLimitReset = result.headers.get("x-ratelimit-reset") ?? result.headers.get("x-rate-limit-reset") ?? rateLimitReset;
      cursor = result.body?.next_cursor ?? result.body?.nextCursor ?? null;
      if (!result.body?.has_more && !cursor) break;
    } while (rows.length < 10000);
    return { rows, tier: reportedTier, rateLimitRemaining, rateLimitReset };
  }
  return { request, fetchModels, now };
}

export const ARTIFICIAL_ANALYSIS_ATTRIBUTION = "Data provided by Artificial Analysis (artificialanalysis.ai).";
