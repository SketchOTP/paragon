import { saveSourceSnapshot } from "./sourceSnapshotStore.js";

/**
 * Fetch a source URL and persist a raw snapshot. Never invent content on failure.
 */
export async function fetchSource(source, { provider, config } = {}) {
  const started = Date.now();
  const url = source.url;
  if (!url) {
    return {
      ok: false,
      error: "missing_url",
      source,
      provider,
      fetch_duration_ms: 0
    };
  }

  const headers = { Accept: source.type === "api" ? "application/json" : "text/html,application/xhtml+xml" };
  const authEnv = source.auth_env;
  if (authEnv) {
    const key =
      process.env[authEnv] ??
      config?.providers?.[provider]?.apiKey ??
      config?.providers?.[provider]?.api_key;
    if (key) {
      headers.Authorization = `Bearer ${key}`;
    }
  }

  try {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(source.timeout_ms ?? 45_000),
      redirect: "follow"
    });
    const contentType = response.headers.get("content-type") ?? "";
    const text = await response.text();
    const fetchDurationMs = Date.now() - started;

    if (!response.ok) {
      return {
        ok: false,
        error: `http_${response.status}`,
        status: response.status,
        source,
        provider,
        url,
        fetch_duration_ms: fetchDurationMs
      };
    }

    if (!text || !text.trim()) {
      return {
        ok: false,
        error: "empty_body",
        status: response.status,
        source,
        provider,
        url,
        fetch_duration_ms: fetchDurationMs
      };
    }

    const snapshot = await saveSourceSnapshot({
      provider,
      sourceId: source.id ?? source.authority ?? "source",
      content: text,
      contentType: contentType.includes("json") ? "application/json" : contentType.includes("html") ? "text/html" : "text/plain",
      status: response.status,
      url,
      fetchDurationMs
    });

    let json = null;
    if (contentType.includes("json") || source.type === "api") {
      try {
        json = JSON.parse(text);
      } catch {
        // leave json null; HTML extractors may still use text
      }
    }

    return {
      ok: true,
      source,
      provider,
      url,
      status: response.status,
      content_type: contentType,
      text,
      json,
      snapshot,
      fetch_duration_ms: fetchDurationMs
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message,
      source,
      provider,
      url,
      fetch_duration_ms: Date.now() - started
    };
  }
}
