import { stripAnsi } from "../antigravityModels.js";

export const PROVIDER_FAILURE_CATEGORIES = [
  "process_exited",
  "timeout",
  "empty_stdout",
  "malformed_response",
  "transport_failure",
  "blank_text",
  "provider_disabled",
  "provider_unavailable"
];

export function buildResponseMetadata(result = {}, error = null) {
  const stdout = result.stdout ?? error?.stdout ?? "";
  const stderr = result.stderr ?? error?.stderr ?? "";
  const plainStderr = stripAnsi(stderr).trim();
  return {
    exit_code: result.code ?? error?.code ?? null,
    stdout_bytes: stdout.length,
    stderr_bytes: stderr.length,
    stderr_preview: plainStderr.slice(0, 200) || null,
    stdout_preview: stripAnsi(stdout).trim().slice(0, 120) || null
  };
}

export function classifyProviderRunResult(result, error = null, { requireContent = true } = {}) {
  const metadata = buildResponseMetadata(result, error);

  if (error) {
    const text = `${error.message ?? ""} ${error.stderr ?? ""}`.toLowerCase();
    if (error.timeout || text.includes("timed out") || text.includes("timeout")) {
      return failure("timeout", "Provider timed out", metadata, error);
    }
    if (error.code === "ENOENT" || text.includes("econnrefused") || text.includes("spawn")) {
      return failure("transport_failure", error.message ?? "Transport failure", metadata, error);
    }
    if (typeof error.code === "number" && error.code !== 0) {
      return failure("process_exited", error.message ?? `Process exited ${error.code}`, metadata, error);
    }
    return failure("process_exited", error.message ?? "Provider process failed", metadata, error);
  }

  const stdout = stripAnsi(result?.stdout ?? "").trim();
  const stderr = stripAnsi(result?.stderr ?? "").trim();

  if (!stdout.length) {
    if (looksLikeAuthFailure(stderr)) {
      return failure(
        "provider_unavailable",
        "Antigravity returned no output — authentication may be required",
        metadata
      );
    }
    if (stderr.length) {
      return failure(
        "empty_stdout",
        `Provider exited 0 with empty stdout; stderr: ${stderr.slice(0, 180)}`,
        metadata
      );
    }
    return failure("empty_stdout", "Provider exited 0 with empty stdout", metadata);
  }

  if (requireContent && isBlankText(stdout)) {
    return failure("blank_text", "Provider returned whitespace-only content", metadata);
  }

  return {
    ok: true,
    failure_category: null,
    error_summary: null,
    metadata
  };
}

function failure(category, summary, metadata, error = null) {
  return {
    ok: false,
    failure_category: category,
    error_summary: summary,
    metadata,
    error
  };
}

function looksLikeAuthFailure(text) {
  const plain = String(text ?? "").toLowerCase();
  return (
    plain.includes("authentication required") ||
    plain.includes("not logged into antigravity") ||
    plain.includes("not signed in") ||
    plain.includes("paste the authorization code") ||
    plain.includes("please sign in")
  );
}

function isBlankText(text) {
  return !String(text ?? "").replace(/\s+/g, "").length;
}

export function providerResultError(provider, check) {
  const error = new Error(`${provider}: ${check.error_summary}`);
  error.provider = provider;
  error.providerFailureCategory = check.failure_category;
  error.stdout = check.metadata?.stdout_preview ?? "";
  error.stderr = check.metadata?.stderr_preview ?? "";
  error.code = check.metadata?.exit_code ?? 1;
  return error;
}
