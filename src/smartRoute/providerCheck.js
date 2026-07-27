import { runProvider } from "../cli.js";
import { formatProviderError } from "../providerFallback.js";
import { classifyProviderRunResult } from "./providerResult.js";

const DEFAULT_PROVIDERS = ["antigravity", "cursor", "codex", "claude"];
const CHECK_PROMPT = "Reply with exactly: provider-check-ok";
const CHECK_TIMEOUT_MS = 120_000;

export async function checkProviderHealth(config, providerNames = DEFAULT_PROVIDERS) {
  const results = [];

  for (const name of providerNames) {
    const providerConfig = config.providers?.[name];
    if (!providerConfig?.enabled) {
      results.push({
        provider: name,
        reachable: false,
        response_ok: false,
        latency_ms: null,
        error: "provider_disabled",
        failure_category: "provider_disabled",
        response_metadata: null
      });
      continue;
    }

    const started = Date.now();
    try {
      const timeoutMs = Math.min(providerConfig.timeoutMs ?? CHECK_TIMEOUT_MS, CHECK_TIMEOUT_MS);
      const result = await runProvider(name, { ...providerConfig, timeoutMs }, CHECK_PROMPT);
      const latencyMs = Date.now() - started;
      const check = classifyProviderRunResult(result, null, { requireContent: true });
      results.push({
        provider: name,
        reachable: true,
        response_ok: check.ok,
        latency_ms: latencyMs,
        error: check.ok ? null : check.error_summary,
        failure_category: check.ok ? null : check.failure_category,
        response_metadata: check.metadata
      });
    } catch (error) {
      const check = classifyProviderRunResult({}, error, { requireContent: true });
      results.push({
        provider: name,
        reachable: false,
        response_ok: false,
        latency_ms: Date.now() - started,
        error: check.error_summary ?? formatProviderError(error).slice(0, 300),
        failure_category: check.failure_category ?? "process_exited",
        response_metadata: check.metadata
      });
    }
  }

  return {
    checked_at: new Date().toISOString(),
    providers: results
  };
}
