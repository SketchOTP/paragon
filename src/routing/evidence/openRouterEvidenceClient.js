const BASE_URL = "https://openrouter.ai/api/v1";
export function createOpenRouterEvidenceClient({ apiKey, fetchImpl = globalThis.fetch } = {}) {
  return { async fetchModels() { const res = await fetchImpl(`${BASE_URL}/models`, { headers: { Authorization: `Bearer ${apiKey}` } }); if (!res.ok) throw new Error(`OpenRouter models request failed: ${res.status}`); return res.json(); } };
}
