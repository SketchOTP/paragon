/** Normalize provider model lists — no synthetic entries. */

function codexVisibilityHidden(visibility) {
  const value = String(visibility ?? "").toLowerCase();
  return value === "hidden" || value === "hide";
}

export function normalizeCodexModelEntries(entries) {
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries
    .filter((entry) => entry && !codexVisibilityHidden(entry.visibility))
    .map((entry) => {
      const id = entry.slug ?? entry.id ?? entry.model;
      if (!id) {
        return null;
      }
      const name = entry.display_name ?? entry.displayName ?? entry.name ?? id;
      return { id: String(id), name: String(name) };
    })
    .filter(Boolean);
}

export function alignProviderModel(providerConfig, models) {
  const list = Array.isArray(models) ? models.filter((model) => model?.id) : [];
  if (!list.length) {
    return [];
  }
  const ids = new Set(list.map((model) => model.id));
  if (providerConfig.model && !ids.has(providerConfig.model)) {
    providerConfig.model = "";
  }
  return list;
}

export function parseCodexModelsCatalog(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) {
    return [];
  }
  const payload = JSON.parse(text);
  const entries = Array.isArray(payload)
    ? payload
    : (payload.models ?? payload.data ?? payload.catalog ?? []);
  return normalizeCodexModelEntries(entries);
}
