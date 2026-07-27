/** Explicit task override — skips LLM/regex classification when set. */

export function extractParagonTask(body, headers) {
  const meta = body?.metadata;
  const fromMeta =
    meta?.paragon_task ??
    meta?.paragon?.task ??
    meta?.routerbot_task ??
    meta?.routerbot?.task ??
    (typeof meta?.task === "string" ? meta.task : null);
  if (typeof fromMeta === "string" && fromMeta.trim()) {
    return fromMeta.trim().toLowerCase();
  }

  const header = headers?.["x-paragon-task"] ?? headers?.["x-routerbot-task"];
  if (typeof header === "string" && header.trim()) {
    return header.trim().toLowerCase();
  }

  return null;
}

export function resolveExplicitTask(explicitTask, config) {
  if (!explicitTask) {
    return null;
  }
  if (config.routing?.taskRoutes?.[explicitTask]) {
    return explicitTask;
  }
  return null;
}
