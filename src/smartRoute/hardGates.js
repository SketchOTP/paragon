import {
  cheapestCapable,
  cheapestLocalCapable,
  cheapestModelWithContext
} from "./registry.js";

export function applyHardGates(normalized, registry, settings) {
  if (normalized.userSelectedModel) {
    const match = findByProviderModel(registry, normalized.requestedModel);
    if (match) {
      return hardRoute(match, "user_selected_model");
    }
  }

  if (normalized.hasImage) {
    const entry = cheapestCapable(registry, "vision");
    if (entry) {
      return hardRoute(entry, "vision_required");
    }
  }

  if (normalized.requiresTools) {
    const entry = cheapestCapable(registry, "tool_calling");
    if (entry) {
      return hardRoute(entry, "tools_required");
    }
  }

  const threshold = settings?.largeContextThreshold ?? 100_000;
  if (normalized.estimatedTokens > threshold) {
    const entry = cheapestModelWithContext(registry, normalized.estimatedTokens);
    if (entry) {
      return hardRoute(entry, "long_context");
    }
  }

  if (settings?.localPrivateFirst && normalized.containsSensitiveData) {
    const entry = cheapestLocalCapable(registry);
    if (entry) {
      return hardRoute(entry, "sensitive_local");
    }
  }

  return null;
}

function hardRoute(entry, reason) {
  return {
    selected: entry,
    source: "hard_gate",
    gateReason: reason,
    classifier: null,
    candidates: [entry]
  };
}

function findByProviderModel(registry, modelId) {
  const direct = registry.find((entry) => entry.id === modelId);
  if (direct) {
    return direct;
  }
  const byModel = registry.find((entry) => entry.model === modelId);
  if (byModel) {
    return byModel;
  }
  const byProvider = registry.find((entry) => entry.provider === modelId);
  return byProvider ?? null;
}
