import { defaultConfig } from "./defaultConfig.js";

/** Migrate legacy gemini provider slots to antigravity and drop gemini from config. */
export function migrateGeminiToAntigravity(config) {
  const next = {
    ...config,
    providers: { ...config.providers },
    routing: {
      ...config.routing,
      taskRoutes: { ...config.routing?.taskRoutes },
      fallbackChain: [...(config.routing?.fallbackChain ?? defaultConfig.routing.fallbackChain)]
    }
  };

  if (!next.providers.antigravity) {
    next.providers.antigravity = { ...defaultConfig.providers.antigravity };
  }

  const gemini = next.providers.gemini;
  if (gemini) {
    next.providers.antigravity = {
      ...next.providers.antigravity,
      enabled: gemini.enabled || next.providers.antigravity.enabled,
      model: gemini.model || next.providers.antigravity.model,
      models: gemini.models?.length ? gemini.models : next.providers.antigravity.models
    };
    delete next.providers.gemini;
  }

  next.routing.fallbackChain = next.routing.fallbackChain.map((name) =>
    name === "gemini" ? "antigravity" : name
  );

  for (const [task, provider] of Object.entries(next.routing.taskRoutes ?? {})) {
    if (provider === "gemini") {
      next.routing.taskRoutes[task] = "antigravity";
    }
  }

  return next;
}
