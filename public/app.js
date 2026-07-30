const BUILTIN_ORDER = ["claude", "codex", "cursor", "antigravity"];
const taskOrder = ["code", "debug", "review", "plan", "explain", "docs", "quick"];
const API_KEY_STORAGE = "paragon-api-key";

const TASK_ICONS = {
  code: "{ }",
  debug: "⚙",
  review: "✓",
  plan: "◎",
  explain: "?",
  docs: "📄",
  quick: "⚡"
};

/**
 * Bundled avatars for the providers that ship with PARAGON. An operator can
 * override any of these (and supply one for a provider they add) via the
 * card's avatar control, which stores the uploaded path in
 * `providers.<id>.avatar`.
 */
const BUNDLED_PROVIDER_AVATARS = {
  claude: "/avatars/claude.webp",
  codex: "/avatars/codex.webp",
  cursor: "/avatars/cursor.webp",
  antigravity: "/avatars/antigravity.webp",
  lmstudio: "/avatars/lmstudio.webp"
};

/** Matches the server's ceiling in src/providerAvatars.js. */
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

let avatarEditProvider = null;
let avatarDraftDataUrl = "";
let newProviderAvatarDataUrl = "";

const authUi = {
  claude: { label: "Sign in", short: "Browser" },
  codex: { label: "Device login", short: "Device" },
  cursor: { label: "Sign in", short: "Browser" }
  // antigravity intentionally omitted — no verified dashboard-triggerable
  // login flow (see docs/evidence). It relies on host-level auth already
  // being set up outside of PARAGON.
};

let authFlowsMeta = { ...authUi };
let statusRefreshTimer = null;
/** Providers with an open sign-in panel — skip full card re-render so code inputs stay visible. */
const authInProgress = new Set();
/** Persisted auth panel content (URL, code draft) across status refreshes. */
const authPanelState = new Map();
/** While true, defer full provider-card rebuilds so open dropdowns stay open. */
let providerUiLock = false;
let pendingProviderRender = false;
let lastStatusFetchMs = 0;
const STATUS_MIN_INTERVAL_MS = 8000;
const AUTH_POLL_INTERVAL_MS = 8000;

let config;
let statuses = {};
let orchestrationPolicy = null;
let logsConnectionState = "connecting";
/** PARAGON-D-004D1: per-provider routing summaries from /api/routing/providers. */
let providerSummaries = {};
/** PARAGON-D-004D1: live-vs-shadow router status from /api/routing/status. */
let routingStatus = null;
let catalogSnapshot = null;

const els = {
  providers: document.querySelector("#providers"),
  routes: document.querySelector("#routes"),
  logs: document.querySelector("#logs"),
  save: document.querySelector("#save"),
  refreshStatus: document.querySelector("#refresh-status"),
  paragonBaseUrl: document.querySelector("#paragon-base-url"),
  modelName: document.querySelector("#model-name"),
  apiKey: document.querySelector("#api-key"),
  healthGauge: document.querySelector("#health-gauge"),
  addProvider: document.querySelector("#add-provider"),
  addProviderDialog: document.querySelector("#add-provider-dialog"),
  addProviderForm: document.querySelector("#add-provider-form"),
  addProviderCancel: document.querySelector("#add-provider-cancel"),
  newProviderType: document.querySelector("#new-provider-type"),
  newProviderHttpFields: document.querySelector("#new-provider-http-fields"),
  newProviderCliFields: document.querySelector("#new-provider-cli-fields"),
  newProviderAvatarFile: document.querySelector("#new-provider-avatar-file"),
  newProviderAvatarImage: document.querySelector("#new-provider-avatar-image"),
  newProviderAvatarPlaceholder: document.querySelector("#new-provider-avatar-placeholder"),
  apiKeyDialog: document.querySelector("#api-key-dialog"),
  apiKeyForm: document.querySelector("#api-key-form"),
  apiKeyInput: document.querySelector("#api-key-input"),
  settingTailscaleHost: document.querySelector("#setting-tailscale-host"),
  settingServePort: document.querySelector("#setting-serve-port"),
  settingFunnelPort: document.querySelector("#setting-funnel-port"),
  settingParagonBase: document.querySelector("#setting-paragon-base"),
  settingExposedModel: document.querySelector("#setting-exposed-model"),
  settingApiKey: document.querySelector("#setting-api-key"),
  settingOpenrouterApiKey: document.querySelector("#setting-openrouter-api-key"),
  settingsPanel: document.querySelector("#settings-panel"),
  toggleSettings: document.querySelector("#toggle-settings"),
  avatarDialog: document.querySelector("#avatar-dialog"),
  avatarDialogImage: document.querySelector("#avatar-dialog-image"),
  avatarFile: document.querySelector("#avatar-file"),
  avatarStatus: document.querySelector("#avatar-status"),
  avatarReset: document.querySelector("#avatar-reset"),
  avatarCancel: document.querySelector("#avatar-cancel"),
  avatarApply: document.querySelector("#avatar-apply"),
  catalogInspectDialog: document.querySelector("#catalog-inspect-dialog"),
  catalogInspectTitle: document.querySelector("#catalog-inspect-title"),
  catalogInspectBody: document.querySelector("#catalog-inspect-body"),
  catalogInspectClose: document.querySelector("#catalog-inspect-close"),
  refreshRoutingStatus: document.querySelector("#refresh-routing-status"),
  liveRouterFacts: document.querySelector("#live-router-facts"),
  shadowRouterFacts: document.querySelector("#shadow-router-facts"),
  routerAuthorityNote: document.querySelector("#router-authority-note"),
  fallbackMaxNote: document.querySelector("#fallback-max-note"),
  toggleAttemptPlans: document.querySelector("#toggle-attempt-plans"),
  attemptPlansBody: document.querySelector("#attempt-plans-body"),
  livePlanMeta: document.querySelector("#live-plan-meta"),
  livePlanList: document.querySelector("#live-plan-list"),
  shadowPlanMeta: document.querySelector("#shadow-plan-meta"),
  shadowPlanList: document.querySelector("#shadow-plan-list"),
  toggleLegacyPreferences: document.querySelector("#toggle-legacy-preferences"),
  legacyPreferencesBody: document.querySelector("#legacy-preferences-body"),
  legacyPreferencesNote: document.querySelector("#legacy-preferences-note"),
  toggleShadowSettings: document.querySelector("#toggle-shadow-settings"),
  shadowSettingsBody: document.querySelector("#shadow-settings-body"),
  saveShadowSettings: document.querySelector("#save-shadow-settings"),
  shadowSettingsStatus: document.querySelector("#shadow-settings-status"),
  shadowSettingMode: document.querySelector("#shadow-setting-mode"),
  shadowSettingQuotaScarcity: document.querySelector("#shadow-setting-quota-scarcity"),
  shadowSettingContextThreshold: document.querySelector("#shadow-setting-context-threshold"),
  shadowSettingMinSamples: document.querySelector("#shadow-setting-min-samples"),
  shadowSettingMaxAttempts: document.querySelector("#shadow-setting-max-attempts"),
  shadowSettingRetentionDays: document.querySelector("#shadow-setting-retention-days"),
  shadowMappingFacts: document.querySelector("#shadow-mapping-facts"),
  toggleDeprecatedConfig: document.querySelector("#toggle-deprecated-config"),
  deprecatedConfigBody: document.querySelector("#deprecated-config-body"),
  deprecatedConfigList: document.querySelector("#deprecated-config-list"),
  refreshOrchestration: document.querySelector("#refresh-orchestration"),
  orchOverview: document.querySelector("#orch-overview"),
  orchContext: document.querySelector("#orch-context"),
  orchSessions: document.querySelector("#orch-sessions"),
  orchAgents: document.querySelector("#orch-agents"),
  orchProviders: document.querySelector("#orch-providers"),
  orchGovernor: document.querySelector("#orch-governor"),
  orchGovernorHeading: document.querySelector("#orch-governor-heading"),
  modeBanner: document.querySelector("#mode-banner"),
  saveOrchSettings: document.querySelector("#save-orch-settings"),
  orchSettingsStatus: document.querySelector("#orch-settings-status"),
  orchSettingMode: document.querySelector("#orch-setting-mode"),
  orchSettingContextCeiling: document.querySelector("#orch-setting-context-ceiling"),
  orchSettingMaxConcurrent: document.querySelector("#orch-setting-max-concurrent"),
  orchSettingMaxFallback: document.querySelector("#orch-setting-max-fallback"),
  orchSettingCircuitThreshold: document.querySelector("#orch-setting-circuit-threshold"),
  orchSettingCircuitCooldown: document.querySelector("#orch-setting-circuit-cooldown"),
  orchSettingSessionHardLimit: document.querySelector("#orch-setting-session-hard-limit"),
  orchSettingRetentionDays: document.querySelector("#orch-setting-retention-days"),
  orchStorageUsage: document.querySelector("#orch-storage-usage"),
  refreshRegistry: document.querySelector("#refresh-registry"),
  registryTableBody: document.querySelector("#registry-table-body"),
  registryTable: document.querySelector("#registry-table"),
  toggleModelRouting: document.querySelector("#toggle-model-routing"),
  modelRoutingBody: document.querySelector("#model-routing-body"),
  toggleOrchestration: document.querySelector("#toggle-orchestration"),
  orchestrationBody: document.querySelector("#orchestration-body"),
  toggleOrchSettings: document.querySelector("#toggle-orch-settings"),
  orchSettingsBody: document.querySelector("#orch-settings-body"),
  refreshCatalog: document.querySelector("#refresh-catalog"),
  validateAllCatalog: document.querySelector("#validate-all-catalog"),
  catalogTableBody: document.querySelector("#catalog-table-body"),
  toggleModelCatalog: document.querySelector("#toggle-model-catalog"),
  modelCatalogBody: document.querySelector("#model-catalog-body"),
  catalogScheduleNote: document.querySelector("#catalog-schedule-note"),
  catalogUpdatedNote: document.querySelector("#catalog-updated-note"),
  toggleRoutingIntelligence: document.querySelector("#toggle-routing-intelligence"),
  routingIntelligenceBody: document.querySelector("#routing-intelligence-body"),
  runScenario: document.querySelector("#run-scenario"),
  scenarioContext: document.querySelector("#scenario-context"),
  scenarioCustomWrap: document.querySelector("#scenario-custom-wrap"),
  scenarioCustomTokens: document.querySelector("#scenario-custom-tokens"),
  scenarioReasoning: document.querySelector("#scenario-reasoning"),
  scenarioLatency: document.querySelector("#scenario-latency"),
  scenarioCost: document.querySelector("#scenario-cost"),
  scenarioPrompt: document.querySelector("#scenario-prompt"),
  scenarioStreaming: document.querySelector("#scenario-streaming"),
  scenarioTools: document.querySelector("#scenario-tools"),
  scenarioStructured: document.querySelector("#scenario-structured"),
  scenarioProfileNote: document.querySelector("#scenario-profile-note"),
  scenarioShadowSummary: document.querySelector("#scenario-shadow-summary"),
  scenarioTableBody: document.querySelector("#scenario-table-body"),
  scenarioPlanNote: document.querySelector("#scenario-plan-note"),
  registryTaskFilter: document.querySelector("#registry-task-filter"),
  registryProviderFilter: document.querySelector("#registry-provider-filter"),
  registryHealthFilter: document.querySelector("#registry-health-filter"),
  registryUpdatedNote: document.querySelector("#registry-updated-note"),
  registryBenchmarkNote: document.querySelector("#registry-benchmark-note"),
  registrySourcesBtn: document.querySelector("#registry-sources-btn"),
  registrySourcesDialog: document.querySelector("#registry-sources-dialog"),
  registrySourcesContent: document.querySelector("#registry-sources-content"),
  registrySourcesClose: document.querySelector("#registry-sources-close")
};

function getStoredApiKey() {
  return sessionStorage.getItem(API_KEY_STORAGE) ?? "";
}

function setStoredApiKey(key) {
  if (key) {
    sessionStorage.setItem(API_KEY_STORAGE, key);
  } else {
    sessionStorage.removeItem(API_KEY_STORAGE);
  }
}

async function apiFetch(url, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  const key = getStoredApiKey();
  if (key) {
    headers["X-API-Key"] = key;
  }
  const response = await fetch(url, { ...options, headers });
  if (response.status === 401) {
    await promptForApiKey();
    return apiFetch(url, options);
  }
  return response;
}

async function promptForApiKey() {
  return new Promise((resolve) => {
    els.apiKeyInput.value = getStoredApiKey();
    els.apiKeyDialog.showModal();
    els.apiKeyForm.onsubmit = (event) => {
      event.preventDefault();
      setStoredApiKey(els.apiKeyInput.value.trim());
      els.apiKeyDialog.close();
      resolve();
    };
  });
}

/** Shared chevron collapse/expand wiring for the Model Routing / Orchestration / Live enforcement settings panels. */
function wireCollapsePanel(toggleEl, bodyEl) {
  if (!toggleEl || !bodyEl) {
    return;
  }
  toggleEl.addEventListener("click", () => {
    const expanded = toggleEl.getAttribute("aria-expanded") === "true";
    toggleEl.setAttribute("aria-expanded", String(!expanded));
    bodyEl.hidden = expanded;
  });
}

function providerOrder() {
  const keys = Object.keys(config.providers);
  const ordered = BUILTIN_ORDER.filter((key) => keys.includes(key));
  for (const key of keys) {
    if (!ordered.includes(key)) {
      ordered.push(key);
    }
  }
  return ordered;
}

function providerLabel(provider, providerConfig) {
  return providerConfig?.label || provider;
}

/**
 * Resolution order: an uploaded/configured avatar wins, then a bundled avatar
 * matched on the provider id. Returns "" when there is nothing to show, so the
 * card renders initials rather than a broken image.
 */
function providerAvatar(provider, providerConfig) {
  const configured = String(providerConfig?.avatar ?? "").trim();
  if (configured) {
    return configured;
  }
  const key = String(provider).toLowerCase();
  if (BUNDLED_PROVIDER_AVATARS[key]) {
    return BUNDLED_PROVIDER_AVATARS[key];
  }
  // A provider added as e.g. "lm-studio-local" should still get the bundled
  // LM Studio avatar rather than falling through to initials.
  const collapsed = key.replace(/[^a-z0-9]/g, "");
  for (const [name, path] of Object.entries(BUNDLED_PROVIDER_AVATARS)) {
    if (collapsed.includes(name)) {
      return path;
    }
  }
  return "";
}

function providerInitials(label) {
  const words = String(label ?? "")
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean);
  if (!words.length) {
    return "?";
  }
  return words
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join("");
}

function isCustomProvider(provider) {
  return !BUILTIN_ORDER.includes(provider);
}

function isHttpProvider(providerConfig) {
  return providerConfig?.type === "http";
}

function routeProviderOptions() {
  const all = providerOrder();
  const enabled = all.filter((p) => config.providers[p]?.enabled);
  const options = enabled.length ? enabled : all;
  const extras = new Set(options);
  for (const task of taskOrder) {
    const picked = config.routing.taskRoutes[task];
    if (picked && config.providers[picked] && !extras.has(picked)) {
      extras.add(picked);
    }
  }
  return [...options, ...[...extras].filter((p) => !options.includes(p))];
}

await loadConfig();
render();
connectLogs();
bindProviderInteractionLock();
refreshStatus();
refreshOrchestration();
loadOrchestrationPolicy();
refreshModelRegistry();
refreshModelCatalog();
refreshProviderSummaries();
refreshRoutingStatus();
setInterval(refreshOrchestration, 30000);
setInterval(refreshModelRegistry, 30000);
// Provider summaries and router status track live activity (last live model,
// last shadow recommendation, latest attempt plans), so they follow the same
// 30s cadence as the rest of the live panels — not the 24h catalog cadence.
setInterval(refreshProviderSummaries, 30000);
setInterval(refreshRoutingStatus, 30000);
// The catalog itself only changes on a refresh (default every 24h) or a
// manual/validate action — those already re-render the table immediately,
// so polling every 30s bought nothing but load. Matches the real cadence.
setInterval(refreshModelCatalog, 24 * 3_600_000);

els.save.addEventListener("click", () => saveConfig({ notify: true }));
els.refreshStatus.addEventListener("click", () => refreshStatus({ manual: true }));
els.refreshOrchestration?.addEventListener("click", () => refreshOrchestration({ manual: true }));
els.saveOrchSettings?.addEventListener("click", saveOrchestrationSettings);
els.refreshRegistry?.addEventListener("click", refreshModelRegistry);
els.refreshCatalog?.addEventListener("click", () => refreshAllCatalogProviders());
els.validateAllCatalog?.addEventListener("click", () => validateAllCatalogModels());
wireCollapsePanel(els.toggleModelRouting, els.modelRoutingBody);
wireCollapsePanel(els.toggleOrchestration, els.orchestrationBody);
wireCollapsePanel(els.toggleOrchSettings, els.orchSettingsBody);
wireCollapsePanel(els.toggleModelCatalog, els.modelCatalogBody);
wireCollapsePanel(els.toggleRoutingIntelligence, els.routingIntelligenceBody);
wireCollapsePanel(els.toggleAttemptPlans, els.attemptPlansBody);
wireCollapsePanel(els.toggleLegacyPreferences, els.legacyPreferencesBody);
wireCollapsePanel(els.toggleShadowSettings, els.shadowSettingsBody);
wireCollapsePanel(els.toggleDeprecatedConfig, els.deprecatedConfigBody);
els.refreshRoutingStatus?.addEventListener("click", () => {
  refreshRoutingStatus();
  refreshProviderSummaries();
});
els.saveShadowSettings?.addEventListener("click", saveShadowSettings);
els.catalogInspectClose?.addEventListener("click", () => els.catalogInspectDialog.close());
els.runScenario?.addEventListener("click", () => runRoutingScenario());
els.scenarioContext?.addEventListener("change", () => {
  if (els.scenarioCustomWrap) els.scenarioCustomWrap.hidden = els.scenarioContext.value !== "custom";
});
els.registryTaskFilter?.addEventListener("change", () => {
  renderRegistryTable();
});
els.registryProviderFilter?.addEventListener("change", renderRegistryTable);
els.registryHealthFilter?.addEventListener("change", renderRegistryTable);
els.registryTable?.addEventListener("click", (event) => {
  const th = event.target.closest("th[data-sort-key]");
  if (!th) {
    return;
  }
  const key = th.dataset.sortKey;
  if (registrySort.key === key) {
    registrySort.dir = registrySort.dir === "asc" ? "desc" : "asc";
  } else {
    registrySort = { key, dir: key === "tenScale" ? "asc" : "asc" };
  }
  renderRegistryTable();
});
els.registrySourcesBtn?.addEventListener("click", () => {
  renderSourcesDialog();
  els.registrySourcesDialog.showModal();
});
els.registrySourcesClose?.addEventListener("click", () => els.registrySourcesDialog.close());
els.addProvider.addEventListener("click", openAddProviderDialog);
els.addProviderCancel.addEventListener("click", () => els.addProviderDialog.close());
els.newProviderType.addEventListener("change", toggleNewProviderFields);
els.newProviderAvatarFile?.addEventListener("change", async () => {
  const dataUrl = await readAvatarFile(els.newProviderAvatarFile.files?.[0]);
  newProviderAvatarDataUrl = dataUrl.error ? "" : dataUrl.value;
  renderNewProviderAvatarPreview(dataUrl.error);
});
els.addProviderForm.addEventListener("submit", addProvider);
els.settingTailscaleHost.addEventListener("input", updateServerFromSettings);
els.settingServePort.addEventListener("input", updateServerFromSettings);
els.settingFunnelPort.addEventListener("input", updateServerFromSettings);
els.settingParagonBase.addEventListener("input", updateServerFromSettings);
els.settingExposedModel.addEventListener("input", updateServerFromSettings);
els.settingApiKey.addEventListener("input", updateServerFromSettings);
els.settingOpenrouterApiKey?.addEventListener("input", updateServerFromSettings);
els.toggleSettings.addEventListener("click", () => {
  els.settingsPanel.hidden = !els.settingsPanel.hidden;
});
els.avatarCancel.addEventListener("click", () => els.avatarDialog.close());
els.avatarApply.addEventListener("click", applyAvatar);
els.avatarReset.addEventListener("click", resetAvatarToBundled);
els.avatarFile?.addEventListener("change", async () => {
  const result = await readAvatarFile(els.avatarFile.files?.[0]);
  if (result.error) {
    avatarDraftDataUrl = "";
    els.avatarStatus.textContent = result.error;
    els.avatarStatus.className = "settings-save-note error";
    return;
  }
  avatarDraftDataUrl = result.value;
  els.avatarDialogImage.src = result.value;
  els.avatarStatus.textContent = "";
  els.avatarStatus.className = "settings-save-note";
});

function toggleNewProviderFields() {
  const isHttp = els.newProviderType.value === "http";
  els.newProviderHttpFields.hidden = !isHttp;
  els.newProviderCliFields.hidden = isHttp;
}

function openAddProviderDialog() {
  newProviderAvatarDataUrl = "";
  if (els.newProviderAvatarFile) {
    els.newProviderAvatarFile.value = "";
  }
  renderNewProviderAvatarPreview();
  els.addProviderDialog.showModal();
}

/** Reads an image file into a data URL, enforcing the same ceiling the server does. */
function readAvatarFile(file) {
  return new Promise((resolve) => {
    if (!file) {
      resolve({ value: "" });
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      resolve({ error: `Image is ${Math.round(file.size / 1024)}KB; the limit is ${MAX_AVATAR_BYTES / 1024}KB.` });
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => resolve({ error: "Could not read that file." });
    reader.onload = () => resolve({ value: String(reader.result ?? "") });
    reader.readAsDataURL(file);
  });
}

function renderNewProviderAvatarPreview(error = "") {
  if (!els.newProviderAvatarImage) {
    return;
  }
  const has = Boolean(newProviderAvatarDataUrl);
  els.newProviderAvatarImage.hidden = !has;
  if (has) {
    els.newProviderAvatarImage.src = newProviderAvatarDataUrl;
  } else {
    els.newProviderAvatarImage.removeAttribute("src");
  }
  if (els.newProviderAvatarPlaceholder) {
    els.newProviderAvatarPlaceholder.hidden = has;
    els.newProviderAvatarPlaceholder.textContent = error || "No image";
  }
}

async function loadConfig() {
  const [configRes, flowsRes] = await Promise.all([
    apiFetch("/api/config"),
    apiFetch("/api/auth/flows").catch(() => null)
  ]);
  config = await configRes.json();
  if (flowsRes?.ok) {
    const body = await flowsRes.json();
    authFlowsMeta = body.flows ?? authFlowsMeta;
  }
}

function authFlow(provider) {
  return authFlowsMeta[provider] ?? { mode: "browser", signInLabel: "Sign in", reSignInLabel: "Re-sign in" };
}

function authButtonLabel(provider) {
  const flow = authFlow(provider);
  const ready = statuses[provider]?.ok;
  return ready ? flow.reSignInLabel ?? "Re-sign in" : flow.signInLabel ?? authUi[provider]?.label ?? "Sign in";
}

function scheduleStatusRefresh(delayMs = 400) {
  clearTimeout(statusRefreshTimer);
  statusRefreshTimer = setTimeout(() => {
    refreshStatus().catch(() => {});
  }, delayMs);
}

async function copyText(text, button) {
  if (!text) {
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    const prev = button.textContent;
    button.textContent = "Copied";
    setTimeout(() => {
      button.textContent = prev;
    }, 1500);
  } catch {
    window.prompt("Copy this:", text);
  }
}

function tailscaleFromConfig(server) {
  const host = (server.tailscaleHost || "").trim();
  if (!host) {
    return null;
  }
  const servePort = server.tailscaleServePort ?? 9420;
  const funnelPort = server.tailscaleFunnelPort ?? 10000;
  const base = `https://${host}`;
  return {
    paragonBase: (server.cursorBaseUrl || "").trim() || `${base}:${funnelPort}/v1`
  };
}

function renderConnectionBanner() {
  const localBase = `${location.protocol}//127.0.0.1:${config.server.port ?? 4117}/v1`;
  const ts = tailscaleFromConfig(config.server);
  const override = (config.server.cursorBaseUrl || "").trim();
  const paragonBase = override || ts?.paragonBase || localBase;

  els.paragonBaseUrl.textContent = paragonBase.replace(/^https?:\/\//, "").slice(0, 42);
  els.paragonBaseUrl.title = paragonBase;
  els.modelName.textContent = config.server.exposedModel || "paragon";
  els.apiKey.textContent = config.server.apiKey ? "••••••••" : "—";
}

function renderHealthGauge() {
  const providers = providerOrder();
  els.healthGauge.innerHTML = providers
    .map((provider) => {
      const cfg = config.providers[provider];
      const st = statuses[provider];
      let cls = "off";
      if (!cfg?.enabled) {
        cls = "off";
      } else if (st?.ok) {
        cls = "ok";
      } else if (st) {
        cls = "bad";
      }
      return `<span class="health-dot ${cls}" title="${escapeAttr(providerLabel(provider, cfg))}"></span>`;
    })
    .join("");
}

/**
 * PARAGON-D-004D1: there is no longer a default-provider selector or a
 * fallback-chain editor to render — live routing has no static default and no
 * saved attempt order. What remains is the legacy scoring-preference rows.
 */
function renderRouting() {
  renderRoutes();
}

function render() {
  els.settingTailscaleHost.value = config.server.tailscaleHost ?? "";
  els.settingServePort.value = config.server.tailscaleServePort ?? 9420;
  els.settingFunnelPort.value = config.server.tailscaleFunnelPort ?? 10000;
  els.settingParagonBase.value = config.server.cursorBaseUrl ?? "";
  els.settingExposedModel.value = config.server.exposedModel ?? "";
  els.settingApiKey.value = config.server.apiKey ?? "";
  if (els.settingOpenrouterApiKey) {
    els.settingOpenrouterApiKey.value = config.integrations?.openrouterApiKey ?? "";
  }

  renderConnectionBanner();
  renderHealthGauge();
  renderRouting();
  renderProviders();
}

function updateServerFromSettings() {
  config.server.tailscaleHost = els.settingTailscaleHost.value.trim();
  config.server.tailscaleServePort = Number(els.settingServePort.value);
  config.server.tailscaleFunnelPort = Number(els.settingFunnelPort.value);
  config.server.cursorBaseUrl = els.settingParagonBase.value.trim();
  config.server.exposedModel = els.settingExposedModel.value.trim();
  config.server.apiKey = els.settingApiKey.value;
  if (els.settingOpenrouterApiKey) {
    config.integrations = { ...config.integrations, openrouterApiKey: els.settingOpenrouterApiKey.value.trim() };
  }
  renderConnectionBanner();
}

function renderProviders(options = {}) {
  if (!options.force && providerUiLock) {
    pendingProviderRender = true;
    patchProviderStatuses();
    return;
  }
  pendingProviderRender = false;
  els.providers.innerHTML = "";
  for (const provider of providerOrder()) {
    const providerConfig = config.providers[provider];
    const status = statuses[provider];
    const label = providerLabel(provider, providerConfig);
    const http = isHttpProvider(providerConfig);
    const custom = isCustomProvider(provider);
    const auth = authUi[provider];
    const avatar = providerAvatar(provider, providerConfig);
    const statusLine = status?.output ? truncateStatus(status.output) : "";
    const signInLabel = authButtonLabel(provider);

    const card = document.createElement("article");
    card.className = "provider-card";
    card.dataset.providerCard = provider;
    card.innerHTML = `
      <button type="button" class="provider-avatar" data-avatar="${escapeAttr(provider)}" title="Change avatar for ${escapeAttr(label)}">
        ${
          avatar
            // Deliberately not `loading="lazy"`: these are a handful of small
            // above-the-fold images, and deferring them only produces empty
            // avatar columns in screenshots, print, and first paint.
            ? `<img class="provider-avatar-image" src="${escapeAttr(avatar)}" alt="${escapeAttr(label)}" />`
            : `<span class="provider-avatar-initials">${escapeHtml(providerInitials(label))}</span>`
        }
        <span class="provider-avatar-hint">Change</span>
      </button>
      <div class="provider-body">
        <div class="provider-top">
          <div class="provider-meta">
            <h3>${escapeHtml(label)}</h3>
            <span class="provider-id">${escapeHtml(provider)}</span>
            ${statusLine ? `<p class="provider-status-line ${status?.ok ? "ok" : "bad"}" title="${escapeAttr(statusLine)}">${escapeHtml(statusLine)}</p>` : ""}
          </div>
          <span class="provider-status ${status?.ok ? "ok" : status ? "bad" : ""}" title="${status?.ok ? "Ready" : "Needs setup"}"></span>
        </div>
        <div class="toggle-row">
          <span class="toggle-label">Enabled</span>
          <label class="toggle">
            <input type="checkbox" data-provider="${provider}" data-key="enabled" ${providerConfig.enabled ? "checked" : ""} />
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div class="provider-fields">
          ${
            http
              ? `
          <label class="field">
            <span class="field-label">Base URL</span>
            <input value="${escapeAttr(providerConfig.baseUrl ?? "")}" data-provider="${provider}" data-key="baseUrl" />
          </label>
          <label class="field">
            <span class="field-label">API key</span>
            <input type="password" value="${escapeAttr(providerConfig.apiKey ?? "")}" data-provider="${provider}" data-key="apiKey" autocomplete="off" />
          </label>`
              : `
          <label class="field">
            <span class="field-label">Command</span>
            <input value="${escapeAttr(providerConfig.command ?? "")}" data-provider="${provider}" data-key="command" />
          </label>
          ${
            providerConfig.type === "generic-cli"
              ? `<label class="field">
            <span class="field-label">Args</span>
            <input value="${escapeAttr((providerConfig.runArgs ?? []).join(", "))}" data-provider="${provider}" data-key="runArgs" />
          </label>`
              : ""
          }`
          }
        </div>
        <div class="provider-routing" data-provider-routing="${escapeAttr(provider)}">${providerRoutingSummaryHtml(provider)}</div>
        <div class="provider-actions">
          ${auth && !http ? `<button type="button" class="btn secondary sm" data-auth="${provider}">${escapeHtml(signInLabel)}</button>` : ""}
          <button type="button" class="btn ghost sm" data-inspect-catalog="${escapeAttr(provider)}">Validate / inspect catalog</button>
          ${custom ? `<button type="button" class="btn ghost sm danger-text" data-remove="${provider}">Remove</button>` : ""}
        </div>
        <div class="auth-panel" data-auth-panel="${provider}" hidden></div>
      </div>
    `;
    els.providers.append(card);
  }

  bindProviderEvents();
  for (const provider of authInProgress) {
    paintAuthPanel(provider);
  }
}

function openAvatarPicker(provider) {
  avatarEditProvider = provider;
  avatarDraftDataUrl = "";
  if (els.avatarFile) {
    els.avatarFile.value = "";
  }
  const current = providerAvatar(provider, config.providers[provider]);
  if (current) {
    els.avatarDialogImage.src = current;
    els.avatarDialogImage.hidden = false;
  } else {
    els.avatarDialogImage.removeAttribute("src");
    els.avatarDialogImage.hidden = true;
  }
  els.avatarStatus.textContent = "";
  els.avatarStatus.className = "settings-save-note";
  els.avatarDialog.showModal();
}

/**
 * Uploads the chosen image; the server writes the file and returns the served
 * path, which becomes `providers.<id>.avatar`. The config never carries base64
 * image data.
 */
async function applyAvatar() {
  if (!avatarEditProvider || !avatarDraftDataUrl) {
    els.avatarStatus.textContent = "Choose an image first.";
    els.avatarStatus.className = "settings-save-note error";
    return;
  }
  els.avatarApply.disabled = true;
  try {
    const response = await apiFetch(`/api/providers/${encodeURIComponent(avatarEditProvider)}/avatar`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataUrl: avatarDraftDataUrl })
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.error?.message ?? "Upload failed");
    }
    config.providers[avatarEditProvider].avatar = body.avatar;
    els.avatarDialog.close();
    renderProviders({ force: true });
    flashNotice("Avatar updated");
  } catch (error) {
    els.avatarStatus.textContent = error.message || "Upload failed";
    els.avatarStatus.className = "settings-save-note error";
  } finally {
    els.avatarApply.disabled = false;
  }
}

/** Clears the stored override so the bundled avatar (or initials) shows again. */
async function resetAvatarToBundled() {
  if (!avatarEditProvider) {
    return;
  }
  els.avatarReset.disabled = true;
  try {
    const response = await apiFetch(`/api/providers/${encodeURIComponent(avatarEditProvider)}/avatar`, { method: "DELETE" });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error?.message ?? "Reset failed");
    }
    config.providers[avatarEditProvider].avatar = "";
    els.avatarDialog.close();
    renderProviders({ force: true });
  } catch (error) {
    els.avatarStatus.textContent = error.message || "Reset failed";
    els.avatarStatus.className = "settings-save-note error";
  } finally {
    els.avatarReset.disabled = false;
  }
}

function bindProviderInteractionLock() {
  els.providers.addEventListener("mousedown", (event) => {
    if (event.target.matches("select")) {
      providerUiLock = true;
    }
  });
  els.providers.addEventListener("focusin", (event) => {
    if (event.target.matches("select, input, textarea, button")) {
      providerUiLock = true;
    }
  });
  els.providers.addEventListener("focusout", () => {
    setTimeout(() => {
      const active = document.activeElement;
      const stillInProviderField =
        active && els.providers.contains(active) && active.matches("select, input, textarea");
      if (!stillInProviderField) {
        providerUiLock = false;
        if (pendingProviderRender) {
          renderProviders({ force: true });
        }
      }
    }, 300);
  });
}

function bindProviderEvents() {
  els.providers.querySelectorAll("[data-avatar]").forEach((button) => {
    button.addEventListener("click", () => openAvatarPicker(button.dataset.avatar));
  });
  els.providers.querySelectorAll("[data-inspect-catalog]").forEach((button) => {
    button.addEventListener("click", () => openCatalogInspector(button.dataset.inspectCatalog));
  });
  els.providers.querySelectorAll("input[data-provider], select[data-provider]").forEach((input) => {
    input.addEventListener("input", updateProviderFromInput);
    input.addEventListener("change", updateProviderFromInput);
  });
  els.providers.querySelectorAll("[data-auth]").forEach((button) => {
    button.addEventListener("click", () => {
      const provider = button.dataset.auth;
      const force = Boolean(statuses[provider]?.ok);
      startAuth(provider, button, { force });
    });
  });
  els.providers.querySelectorAll("[data-remove]").forEach((button) => {
    button.addEventListener("click", () => removeProvider(button.dataset.remove));
  });
}

function relativeOrNever(iso) {
  return iso ? relativeTimeFrom(iso) : "never";
}

/**
 * PARAGON-D-004D1 (Phase 1): the read-only routing summary that replaced the
 * provider `Model` dropdown. Reports how many models the provider currently
 * contributes and which one was actually used last — never a stored selection.
 */
function providerRoutingSummaryHtml(provider) {
  const summary = providerSummaries[provider];
  if (!summary) {
    return `<p class="provider-routing-empty">Provider routing — loading…</p>`;
  }
  if (!summary.enabled) {
    return `
      <h4 class="provider-routing-head">Provider routing</h4>
      <p class="provider-routing-empty">Disabled — contributes no models to routing.</p>`;
  }

  const c = summary.counts;
  const live = summary.lastLiveModel;
  const shadow = summary.lastShadowModel;
  const rows = [
    ["Eligible models", summary.pendingAssessment ? "0 (pending assessment)" : String(c.eligible)],
    ["Validated / exposed", `${c.validated} / ${c.exposed}`],
    ["Rejected or unavailable", String(c.blocked)],
    ["Catalog refreshed", relativeOrNever(summary.lastSuccessfulRefreshAt)],
    // Kept terse: these render into a narrow two-column card, so a sentence
    // here wraps into an unreadable sliver.
    ["Last live model", live ? `${live.model} (${relativeOrNever(live.at)})` : "not observed yet"],
    ["Last shadow model", shadow ? `${shadow.model} (${relativeOrNever(shadow.at)})` : "not observed yet"],
    ["Provider default", summary.providerDefault.validated ? "validated" : summary.providerDefault.present ? `not eligible (${summary.providerDefault.state})` : "not offered"],
    ["Health", summary.health]
  ];

  return `
    <h4 class="provider-routing-head">Provider routing</h4>
    ${
      summary.pendingAssessment
        ? `<p class="provider-routing-warn">No completed catalog assessment yet — this provider contributes no routable models. Run a catalog refresh.</p>`
        : ""
    }
    <dl class="provider-routing-facts">
      ${rows
        .map(
          ([key, value]) =>
            `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(String(value))}</dd></div>`
        )
        .join("")}
    </dl>
    <p class="provider-routing-selection">Selection: automatic per request</p>`;
}

function patchProviderRoutingSummaries() {
  for (const provider of providerOrder()) {
    const host = els.providers.querySelector(`[data-provider-routing="${provider}"]`);
    if (host) {
      host.innerHTML = providerRoutingSummaryHtml(provider);
    }
  }
}

/**
 * PARAGON-D-004D1 (Phase 4): task-specific provider selections stay editable
 * because the live D-004C1 scorer still reads them — but only as an additive
 * score bonus. The wording here states the actual points and that it is not a
 * route, so the control can no longer read as a task-to-provider mapping.
 */
function renderRoutes() {
  els.routes.innerHTML = "";
  const providers = routeProviderOptions();
  const points = routingStatus?.liveRouter?.taskProviderPreferencePoints ?? null;
  const effect = points != null ? `+${points} live-routing preference` : "live-routing preference";

  if (els.legacyPreferencesNote) {
    els.legacyPreferencesNote.textContent =
      `These preferences affect the current PARAGON-D-004C1 live scorer only, as an additive ${effect} for a ` +
      "matching provider. They are not forced routes: catalog eligibility, health, circuit state, context fit, " +
      "cost ceiling and capability gates remain authoritative and can override them. They do not control the " +
      "PARAGON-D-004D shadow expected-utility scorer.";
  }

  for (const task of taskOrder) {
    const row = document.createElement("div");
    row.className = "route-row legacy";
    row.innerHTML = `
      <div class="route-task">
        <span class="route-task-icon">${TASK_ICONS[task] ?? "•"}</span>
        <span>${task}</span>
      </div>
      <div class="route-control">
        <span class="field-label">Preferred provider</span>
        <select data-task="${task}">
          ${providers
            .map(
              (p) =>
                `<option value="${escapeAttr(p)}" ${config.routing.taskRoutes[task] === p ? "selected" : ""}>${escapeHtml(providerLabel(p, config.providers[p]))}</option>`
            )
            .join("")}
        </select>
        <span class="route-effect">Effect: ${escapeHtml(effect)} · not a forced route</span>
      </div>
    `;
    els.routes.append(row);
  }
  els.routes.querySelectorAll("select").forEach((select) => {
    select.addEventListener("change", () => {
      config.routing.taskRoutes[select.dataset.task] = select.value;
    });
  });
}

function updateProviderFromInput(event) {
  const input = event.currentTarget;
  const providerConfig = config.providers[input.dataset.provider];
  const key = input.dataset.key;
  if (input.type === "checkbox") {
    providerConfig[key] = input.checked;
    renderRouting();
    renderHealthGauge();
    return;
  }
  if (input.type === "number") {
    providerConfig[key] = Number(input.value);
  } else if (key === "runArgs") {
    providerConfig[key] = input.value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
  } else {
    providerConfig[key] = input.value;
  }
}

async function saveConfig({ notify = false } = {}) {
  updateServerFromSettings();
  els.save.disabled = true;
  try {
    const response = await apiFetch("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config)
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.error?.message ?? body.error ?? "Save failed");
    }
    // PARAGON-D-004D1 (Phase 8): `config` is the full document loaded from
    // GET /api/config and re-sent verbatim apart from the fields the UI edits,
    // so removing the default-provider and fallback-chain controls cannot
    // reset them — the hidden deprecated values round-trip untouched. Nothing
    // here invents a value for a field the dashboard no longer renders.
    config = body;
    if (config.server.apiKey) {
      setStoredApiKey(config.server.apiKey);
    }
    render();
    if (notify) {
      flashNotice("Saved successfully");
    }
  } catch (error) {
    if (notify) {
      flashNotice(error.message || "Save failed", { type: "error", ms: 4000 });
    }
  } finally {
    els.save.disabled = false;
  }
}

function flashNotice(message, { type = "success", ms = 2600 } = {}) {
  let toast = document.querySelector("#app-notice");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "app-notice";
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.className = `app-notice ${type} visible`;
  clearTimeout(flashNotice._timer);
  flashNotice._timer = setTimeout(() => {
    toast.classList.remove("visible");
  }, ms);
}

async function addProvider(event) {
  event.preventDefault();
  const id = document.querySelector("#new-provider-id").value.trim();
  const label = document.querySelector("#new-provider-label").value.trim();
  const type = els.newProviderType.value;

  if (!/^[a-z0-9-]+$/.test(id)) {
    alert("ID: lowercase letters, numbers, hyphens only.");
    return;
  }
  if (config.providers[id]) {
    alert("Provider already exists.");
    return;
  }

  if (type === "http") {
    config.providers[id] = {
      type: "http",
      label,
      avatar: "",
      enabled: true,
      baseUrl: document.querySelector("#new-provider-base-url").value.trim(),
      apiKey: document.querySelector("#new-provider-api-key").value,
      // Deprecated for automatic routing (PARAGON-D-004D1) — created empty so
      // a new provider never starts life with a configured-model preference.
      // Its models are discovered by the catalog refresh the server kicks off
      // as soon as this provider is saved.
      model: "",
      models: [],
      timeoutMs: 300000
    };
  } else {
    const runArgsRaw = document.querySelector("#new-provider-run-args").value.trim();
    config.providers[id] = {
      type: "generic-cli",
      label,
      avatar: "",
      enabled: true,
      command: document.querySelector("#new-provider-command").value.trim(),
      runArgs: runArgsRaw ? runArgsRaw.split(",").map((p) => p.trim()) : ["-"],
      model: "",
      models: [],
      timeoutMs: 300000,
      stdinMode: "prompt"
    };
  }

  // The provider must exist server-side before its avatar can be attached to
  // it, so save first and upload second.
  els.addProviderDialog.close();
  render();
  await saveConfig();

  if (newProviderAvatarDataUrl) {
    try {
      const response = await apiFetch(`/api/providers/${encodeURIComponent(id)}/avatar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dataUrl: newProviderAvatarDataUrl })
      });
      const body = await response.json();
      if (response.ok) {
        config.providers[id].avatar = body.avatar;
        renderProviders({ force: true });
      } else {
        flashNotice(body.error?.message ?? "Avatar upload failed", { type: "error", ms: 4000 });
      }
    } catch {
      flashNotice("Avatar upload failed", { type: "error", ms: 4000 });
    }
  }

  newProviderAvatarDataUrl = "";
  els.addProviderForm.reset();
  toggleNewProviderFields();
  renderNewProviderAvatarPreview();
  refreshProviderSummaries();
}

function removeProvider(provider) {
  if (!confirm(`Remove "${provider}"?`)) {
    return;
  }
  delete config.providers[provider];
  // taskRoutes is still an active scoring preference, so a removed provider
  // must not be left referenced there. The deprecated defaultProvider /
  // fallbackChain values are also cleaned of the dead id — that keeps the
  // retained compatibility fields internally consistent without reintroducing
  // any routing use of them.
  const replacement = providerOrder().find((name) => config.providers[name]?.enabled) ?? providerOrder()[0];
  for (const task of taskOrder) {
    if (config.routing.taskRoutes[task] === provider && replacement) {
      config.routing.taskRoutes[task] = replacement;
    }
  }
  if (Array.isArray(config.routing.fallbackChain)) {
    config.routing.fallbackChain = config.routing.fallbackChain.filter((name) => name !== provider);
  }
  if (config.routing.defaultProvider === provider && replacement) {
    config.routing.defaultProvider = replacement;
  }
  render();
  saveConfig();
  refreshProviderSummaries();
}

function truncateStatus(text) {
  const oneLine = String(text).replace(/\s+/g, " ").trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 117)}…` : oneLine;
}

function patchProviderStatuses() {
  for (const provider of providerOrder()) {
    const card = els.providers.querySelector(`[data-provider-card="${provider}"]`);
    if (!card) {
      continue;
    }
    const status = statuses[provider];
    const dot = card.querySelector(".provider-status");
    if (dot) {
      dot.className = `provider-status ${status?.ok ? "ok" : status ? "bad" : ""}`;
      dot.title = status?.ok ? "Ready" : "Needs setup";
    }
    let line = card.querySelector(".provider-status-line");
    const statusLine = status?.output ? truncateStatus(status.output) : "";
    if (statusLine) {
      if (!line) {
        line = document.createElement("p");
        line.className = "provider-status-line";
        card.querySelector(".provider-meta")?.append(line);
      }
      line.textContent = statusLine;
      line.title = statusLine;
      line.className = `provider-status-line ${status?.ok ? "ok" : "bad"}`;
      line.hidden = false;
    } else if (line) {
      line.hidden = true;
    }
    const authBtn = card.querySelector("[data-auth]");
    if (authBtn) {
      authBtn.textContent = authButtonLabel(provider);
    }
  }
  renderHealthGauge();
}

function clearAuthPanel(provider) {
  authPanelState.delete(provider);
  authInProgress.delete(provider);
  const panel = document.querySelector(`[data-auth-panel="${provider}"]`);
  if (panel) {
    panel.hidden = true;
    panel.innerHTML = "";
  }
}

function showAuthPanel(provider, session = {}) {
  const prev = authPanelState.get(provider) ?? { session: {}, codeDraft: "" };
  authPanelState.set(provider, {
    session: { ...prev.session, ...session },
    codeDraft: prev.codeDraft
  });
  authInProgress.add(provider);
  paintAuthPanel(provider);
}

function paintAuthPanel(provider) {
  const panel = document.querySelector(`[data-auth-panel="${provider}"]`);
  const state = authPanelState.get(provider);
  if (!panel || !state) {
    return;
  }
  const session = state.session;
  panel.hidden = false;
  const flow = authFlow(provider);
  const parts = [];

  if (session.alreadyAuthenticated) {
    parts.push(`<p class="auth-status-msg ok">${escapeHtml(session.message || "Already signed in.")}</p>`);
    panel.innerHTML = parts.join("");
    return;
  }

  if (flow.hint) {
    parts.push(`<p class="auth-hint">${escapeHtml(flow.hint)}</p>`);
  }

  if (session.url) {
    parts.push(`
      <div class="auth-link-row">
        <a class="auth-open-link" href="${escapeAttr(session.url)}" target="_blank" rel="noopener noreferrer">Open sign-in page</a>
        <button type="button" class="btn ghost sm auth-copy" data-copy="${escapeAttr(session.url)}">Copy link</button>
      </div>
    `);
  }

  if (session.deviceCode) {
    parts.push(`
      <p class="auth-device-code">
        Device code: <strong>${escapeHtml(session.deviceCode)}</strong>
        <button type="button" class="btn ghost sm auth-copy" data-copy="${escapeAttr(session.deviceCode)}">Copy code</button>
      </p>
    `);
  }

  const needsCode = session.mode === "oauth-code" || flow.mode === "oauth-code";
  if (needsCode) {
    parts.push(`
      <div class="auth-code-row">
        <input type="text" placeholder="Paste authorization code" data-auth-code="${escapeAttr(provider)}" autocomplete="off" />
        <button type="button" class="btn secondary sm" data-auth-code-submit="${escapeAttr(provider)}">Submit code</button>
      </div>
      <p class="auth-hint auth-code-note">After the browser step, copy the code shown there and paste it here. This field stays open until you submit.</p>
    `);
  }

  if (!parts.length) {
    parts.push(`<p class="auth-hint">Waiting for sign-in details… check Recent Activity below.</p>`);
  }

  panel.innerHTML = parts.join("");
  bindAuthPanelEvents(provider, panel, state);
}

function bindAuthPanelEvents(provider, panel, state) {
  panel.querySelectorAll(".auth-copy").forEach((button) => {
    button.addEventListener("click", () => copyText(button.dataset.copy, button));
  });
  const input = panel.querySelector(`[data-auth-code="${provider}"]`);
  const submit = panel.querySelector(`[data-auth-code-submit="${provider}"]`);
  if (input) {
    input.value = state?.codeDraft ?? "";
    input.addEventListener("input", () => {
      const entry = authPanelState.get(provider);
      if (entry) {
        entry.codeDraft = input.value;
      }
    });
  }
  if (input && submit) {
    submit.addEventListener("click", () => submitAuthCode(provider, input, submit));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submitAuthCode(provider, input, submit);
      }
    });
  }
}

function openAuthUrl(url) {
  if (!url) {
    return null;
  }
  const win = window.open(url, "_blank", "noopener,noreferrer");
  if (!win) {
    return null;
  }
  return win;
}

async function pollAuthSession(provider, authWindow) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const response = await apiFetch(`/api/auth/${provider}/session`);
    if (!response.ok) {
      continue;
    }
    const session = await response.json();
    if (!session.url && !session.deviceCode) {
      continue;
    }
    if (session.url) {
      if (authWindow && !authWindow.closed) {
        try {
          authWindow.location.href = session.url;
        } catch {
          openAuthUrl(session.url);
        }
      } else {
        openAuthUrl(session.url);
      }
    }
    showAuthPanel(provider, session);
    return session;
  }
  if (authWindow && !authWindow.closed) {
    authWindow.close();
  }
  return null;
}

async function pollAuthCompletion(provider, maxMs = 120000) {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    await new Promise((resolve) => setTimeout(resolve, AUTH_POLL_INTERVAL_MS));
    await refreshStatus();
    if (statuses[provider]?.ok) {
      clearAuthPanel(provider);
      return true;
    }
    const stateRes = await apiFetch(`/api/auth/${provider}/state`);
    if (stateRes.ok) {
      const state = await stateRes.json();
      if (!state.inProgress && !statuses[provider]?.ok) {
        return false;
      }
    }
  }
  return false;
}

async function watchAuthAfterCodeSubmit(provider) {
  const ok = await pollAuthCompletion(provider);
  if (!ok && authInProgress.has(provider)) {
    showAuthPanel(provider, { mode: "oauth-code" });
    prependLog({
      at: new Date().toISOString(),
      provider,
      type: "auth",
      level: "warn",
      message: "Sign-in still pending — paste the authorization code and click Submit code."
    });
  }
}

async function startAuth(provider, button, { force = false } = {}) {
  button.disabled = true;
  clearAuthPanel(provider);
  const flow = authFlow(provider);
  let authWindow = null;

  try {
    await saveConfig();
    const response = await apiFetch(`/api/auth/${provider}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force })
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.error?.message ?? "Auth failed");
    }

    if (body.alreadyAuthenticated) {
      showAuthPanel(provider, {
        alreadyAuthenticated: true,
        message: body.output
      });
      await refreshStatus();
      authInProgress.delete(provider);
      return;
    }

    authInProgress.add(provider);
    showAuthPanel(provider, { mode: body.mode ?? flow.mode });

    if (flow.mode === "oauth-code" || body.mode === "oauth-code") {
      await pollAuthSession(provider, null);
      return;
    }

    authWindow = window.open("about:blank", "_blank");
    const session = await pollAuthSession(provider, authWindow);
    if (!session?.url && authWindow && !authWindow.closed) {
      authWindow.close();
      authWindow = null;
    }
    await pollAuthCompletion(provider);
  } catch (error) {
    if (authWindow && !authWindow.closed) {
      authWindow.close();
    }
    showAuthPanel(provider, { mode: flow.mode });
    prependLog({ at: new Date().toISOString(), provider, type: "auth", level: "error", message: error.message });
  } finally {
    setTimeout(() => {
      button.disabled = false;
    }, 1500);
  }
}

async function submitAuthCode(provider, input, button) {
  const code = input.value.trim();
  if (!code) {
    return;
  }
  button.disabled = true;
  try {
    const response = await apiFetch(`/api/auth/${provider}/code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code })
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.error?.message ?? "Failed");
    }
    input.value = "";
    const entry = authPanelState.get(provider);
    if (entry) {
      entry.codeDraft = "";
    }
    await watchAuthAfterCodeSubmit(provider);
  } catch (error) {
    prependLog({ at: new Date().toISOString(), provider, type: "auth", level: "error", message: error.message });
  } finally {
    button.disabled = false;
  }
}

async function refreshStatus({ manual = false } = {}) {
  const now = Date.now();
  if (!manual && now - lastStatusFetchMs < STATUS_MIN_INTERVAL_MS) {
    return;
  }
  lastStatusFetchMs = now;

  els.refreshStatus.disabled = true;
  try {
    const query = manual ? "?force=1&quiet=0" : "?quiet=1";
    const response = await apiFetch(`/api/status${query}`);
    const body = await response.json();
    statuses = Object.fromEntries(body.statuses.map((s) => [s.provider, s]));
    patchProviderStatuses();
  } finally {
    els.refreshStatus.disabled = false;
  }
}

function renderLogsEmptyState() {
  if (els.logs.children.length > 0) {
    return;
  }
  const messages = {
    connecting: "Connecting…",
    connected: "No activity yet.",
    error: "Connection lost — retrying…"
  };
  els.logs.innerHTML = `<p class="orch-empty">${escapeHtml(messages[logsConnectionState] ?? "No activity yet.")}</p>`;
}

function connectLogs() {
  renderLogsEmptyState();
  const key = getStoredApiKey();
  const url = key ? `/api/logs/stream?key=${encodeURIComponent(key)}` : "/api/logs/stream";
  const events = new EventSource(url);
  events.onopen = () => {
    logsConnectionState = "connected";
    renderLogsEmptyState();
  };
  events.onmessage = (event) => prependLog(JSON.parse(event.data));
  events.onerror = async () => {
    logsConnectionState = "error";
    renderLogsEmptyState();
    events.close();
    if (!getStoredApiKey()) {
      await promptForApiKey();
    }
    connectLogs();
  };
}

function prependLog(entry) {
  const placeholder = els.logs.querySelector(".orch-empty");
  placeholder?.remove();
  const item = document.createElement("div");
  item.className = `log ${entry.level ?? ""}`;
  const time = new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  item.textContent = `${time} · ${entry.provider ?? "—"} · ${entry.type}: ${entry.message}`;
  els.logs.prepend(item);
  while (els.logs.children.length > 80) {
    els.logs.lastElementChild.remove();
  }

  if (
    entry.type === "auth-complete" ||
    (entry.type === "auth" && /signed in|logged in|sign-in completed|authorization code submitted/i.test(entry.message))
  ) {
    scheduleStatusRefresh();
  }

  if (entry.type === "auth" && /https:\/\/\S+/i.test(entry.message)) {
    const provider = entry.provider;
    if (provider && authInProgress.has(provider)) {
      const urlMatch = entry.message.match(/https:\/\/\S+/i);
      if (urlMatch) {
        showAuthPanel(provider, {
          url: urlMatch[0].replace(/[)\]}>"']+$/, ""),
          mode: authFlow(provider).mode
        });
      }
    }
  }
}

function orchStat(label, value) {
  return `<div class="orch-stat"><span class="orch-stat-label">${escapeHtml(label)}</span><span class="orch-stat-value">${escapeHtml(String(value))}</span></div>`;
}

function orchRow(label, value) {
  return `<div class="orch-row"><span>${escapeHtml(label)}</span><span>${escapeHtml(String(value))}</span></div>`;
}

function renderCountMap(container, map, emptyText) {
  const entries = Object.entries(map ?? {});
  container.innerHTML = entries.length
    ? entries.map(([key, count]) => orchRow(key, count)).join("")
    : `<p class="orch-empty">${escapeHtml(emptyText)}</p>`;
}

async function refreshOrchestration({ manual = false } = {}) {
  if (els.refreshOrchestration) {
    els.refreshOrchestration.disabled = true;
  }
  try {
    const [statusRes, usageRes, decisionsRes] = await Promise.all([
      apiFetch("/api/orchestration/status"),
      apiFetch("/api/orchestration/usage"),
      apiFetch("/api/orchestration/decisions?limit=10")
    ]);
    if (!statusRes.ok || !usageRes.ok || !decisionsRes.ok) {
      return;
    }
    const status = await statusRes.json();
    const usage = await usageRes.json();
    const decisions = await decisionsRes.json();

    const isLive = status.enforcementMode === "live";
    const live = status.liveEnforcement;

    els.orchOverview.innerHTML = [
      orchStat("Active jobs", status.activeJobs),
      orchStat("Active sessions", status.activeSessions),
      orchStat("Active runs", status.activeRuns),
      orchStat("Root vs child", `${usage.byRootVsChild?.root ?? 0} / ${usage.byRootVsChild?.child ?? 0}`),
      orchStat("Max observed context", `${status.maxObservedContextTokens ?? 0} tok`),
      orchStat("Longest active session", `${status.longestActiveSessionMinutes ?? 0}m`),
      orchStat("Enforcement mode", status.enforcementMode ?? "off"),
      ...(live
        ? [
            orchStat("Concurrent executions", `${live.activeConcurrentExecutions} / ${live.maxConcurrent}`),
            orchStat(
              "Circuit breakers",
              Object.keys(live.circuitBreakers ?? {}).length
                ? Object.entries(live.circuitBreakers)
                    .map(([p, s]) => `${p}:${s}`)
                    .join(", ")
                : "all closed"
            )
          ]
        : [])
    ].join("");

    if (els.modeBanner) {
      els.modeBanner.className = `mode-banner ${isLive ? "live" : "off"}`;
      els.modeBanner.textContent = isLive
        ? "LIVE ORCHESTRATION ACTIVE — PARAGON is directly enforcing context, concurrency, timeout, fallback, and circuit-breaker limits."
        : "Orchestration is off — no telemetry-driven enforcement is active.";
    }
    if (els.orchGovernorHeading) {
      els.orchGovernorHeading.textContent = isLive ? "Governor — recent enforcement actions" : "Governor — recent actions";
    }
    if (els.orchStorageUsage && typeof status.telemetryStorageBytes === "number") {
      const kb = (status.telemetryStorageBytes / 1024).toFixed(1);
      els.orchStorageUsage.textContent = `Telemetry storage: ${kb} KB (retained ${status.retentionDays} days, compacted automatically)`;
    }

    renderCountMap(els.orchContext, usage.byContextBand, "No requests observed yet.");
    renderCountMap(els.orchSessions, usage.bySessionDurationBand, "No sessions observed yet.");
    renderCountMap(els.orchAgents, usage.byAgentRole, "No runs observed yet.");
    renderCountMap(els.orchProviders, usage.byProvider, "No provider executions observed yet.");

    els.orchGovernor.innerHTML = decisions.items?.length
      ? decisions.items
          .map((d) => {
            const enforced = d.explanation?.startsWith("ENFORCED");
            return `<div class="orch-decision${enforced ? " enforced" : ""}"><span class="orch-decision-rule">${escapeHtml(d.policyRule)}</span> — ${escapeHtml(d.explanation)}</div>`;
          })
          .join("")
      : `<p class="orch-empty">No governor actions recorded yet — ${isLive ? "nothing has tripped a policy yet" : "orchestration is off"}.</p>`;
  } catch {
    // Best-effort dashboard panel; a failed fetch here must not disturb the rest of the UI.
  } finally {
    if (els.refreshOrchestration) {
      els.refreshOrchestration.disabled = false;
    }
  }
}

function renderOrchestrationSettings() {
  if (!orchestrationPolicy || !els.orchSettingMode) {
    return;
  }
  els.orchSettingMode.value = orchestrationPolicy.mode ?? "live";
  els.orchSettingContextCeiling.value = orchestrationPolicy.context?.absoluteCeilingTokens ?? "";
  els.orchSettingMaxConcurrent.value = orchestrationPolicy.concurrency?.maxConcurrent ?? "";
  els.orchSettingMaxFallback.value = orchestrationPolicy.fallback?.maxAttempts ?? "";
  els.orchSettingCircuitThreshold.value = orchestrationPolicy.circuitBreaker?.failureThreshold ?? "";
  els.orchSettingCircuitCooldown.value = orchestrationPolicy.circuitBreaker?.cooldownMs ?? "";
  els.orchSettingSessionHardLimit.value = orchestrationPolicy.session?.hardLimitMinutes ?? "";
  els.orchSettingRetentionDays.value = orchestrationPolicy.retentionDays ?? "";
}

async function loadOrchestrationPolicy() {
  try {
    const res = await apiFetch("/api/orchestration/policy");
    if (!res.ok) {
      return;
    }
    orchestrationPolicy = await res.json();
    renderOrchestrationSettings();
  } catch {
    // Settings panel stays blank on failure; the rest of the dashboard is unaffected.
  }
}

function contextWindowLabel(tokens) {
  if (tokens == null) {
    return "unknown";
  }
  return `${Math.round(tokens / 1000)}k`;
}

let registryData = null;
let registrySort = { key: "tenScale", dir: "asc" };

function rankPillClass(tenScale) {
  if (tenScale <= 3) return "rank-best";
  if (tenScale <= 7) return "rank-mid";
  return "rank-worst";
}

/** codingIndex is the more relevant Artificial Analysis metric for coding-flavored task types; intelligenceIndex is the general fallback. */
function benchmarkIndexForTask(entry, taskType) {
  const b = entry.externalBenchmark;
  if (!b) {
    return null;
  }
  const codingTasks = new Set(["code", "debug", "review"]);
  const value = codingTasks.has(taskType) ? (b.codingIndex ?? b.intelligenceIndex) : (b.intelligenceIndex ?? b.codingIndex);
  return value ?? null;
}

function benchmarkPromptPrice(entry) {
  const raw = entry.externalBenchmark?.pricing?.prompt;
  const value = raw == null ? NaN : Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** "Good enough vs cost": among eligible, benchmarked candidates within 15% of the best index for this task, the cheapest one is the value pick — not simply the highest-scoring model. */
function computeValuePickKey(rows, taskType) {
  const candidates = rows
    .filter((r) => !r.rankInfo?.excluded && benchmarkIndexForTask(r, taskType) != null && benchmarkPromptPrice(r) != null)
    .map((r) => ({ key: `${r.provider}::${r.model}`, index: benchmarkIndexForTask(r, taskType), price: benchmarkPromptPrice(r) }));
  if (!candidates.length) {
    return null;
  }
  const maxIndex = Math.max(...candidates.map((c) => c.index));
  const goodEnough = candidates.filter((c) => c.index >= maxIndex * 0.85);
  goodEnough.sort((a, b) => a.price - b.price);
  return goodEnough[0]?.key ?? null;
}

function buildRegistryRows() {
  if (!registryData) {
    return [];
  }
  const taskType = els.registryTaskFilter.value || registryData.taskTypes[0];
  const ranking = registryData.taskRanking[taskType] ?? [];
  const rankByKey = new Map(ranking.map((r) => [`${r.provider}::${r.model}`, r]));

  let rows = registryData.registry.map((entry) => ({
    ...entry,
    rankInfo: rankByKey.get(`${entry.provider}::${entry.model}`) ?? null
  }));

  const providerFilter = els.registryProviderFilter.value;
  const healthFilter = els.registryHealthFilter.value;
  if (providerFilter) {
    rows = rows.filter((r) => r.provider === providerFilter);
  }
  if (healthFilter) {
    rows = rows.filter((r) => r.health === healthFilter);
  }

  const valuePickKey = computeValuePickKey(rows, taskType);
  rows = rows.map((r) => ({ ...r, isValuePick: valuePickKey === `${r.provider}::${r.model}` }));

  const { key, dir } = registrySort;
  const mult = dir === "asc" ? 1 : -1;
  rows.sort((a, b) => {
    let av;
    let bv;
    if (key === "tenScale") {
      av = a.rankInfo?.excluded === false ? a.rankInfo.tenScale : 999;
      bv = b.rankInfo?.excluded === false ? b.rankInfo.tenScale : 999;
    } else if (key === "automaticEligibility") {
      av = a.automaticEligibility ? 0 : 1;
      bv = b.automaticEligibility ? 0 : 1;
    } else if (key === "contextWindow") {
      av = a.contextWindow ?? -1;
      bv = b.contextWindow ?? -1;
    } else if (key === "benchmarkIndex") {
      av = benchmarkIndexForTask(a, taskType) ?? -1;
      bv = benchmarkIndexForTask(b, taskType) ?? -1;
    } else {
      av = String(a[key] ?? "");
      bv = String(b[key] ?? "");
    }
    if (av < bv) return -1 * mult;
    if (av > bv) return 1 * mult;
    return 0;
  });

  return rows;
}

function benchmarkCell(entry, taskType) {
  const b = entry.externalBenchmark;
  if (!b) {
    return `<span class="orch-empty" title="No matched external benchmark for this model">—</span>`;
  }
  const index = benchmarkIndexForTask(entry, taskType);
  const sourceShort = b.source === "artificial-analysis" ? "AA" : b.source === "design-arena" ? "DA" : escapeHtml(b.source);
  const price = benchmarkPromptPrice(entry);
  const priceLabel = price != null ? `$${(price * 1e6).toFixed(2)}/M` : "";
  const valueBadge = entry.isValuePick ? ` <span class="registry-badge eligible" title="Good enough (within 15% of the best index for this task) at the lowest price among matched candidates">best value</span>` : "";
  // PARAGON-D-004C1 (P0-6): attribution is shown, not just the score — a
  // number with no traceable match method is how the Opus 4 / Opus 4.7
  // misattribution went unnoticed.
  const method = b.matchMethod ? ` <span class="registry-badge health-unknown" title="Match method: ${escapeAttr(b.matchMethod)} (confidence ${escapeAttr(b.matchConfidence ?? "unknown")})">${escapeHtml(b.matchMethod)}</span>` : "";
  return `<span title="Matched ${escapeAttr(b.matchedLocalModel ?? entry.model)} → ${escapeAttr(b.matchedBenchmarkModel ?? b.matchedAs)} (${escapeAttr(b.source)}), fetched ${escapeAttr(b.benchmarkFetchedAt ?? "unknown")}">${sourceShort} ${index ?? "—"} ${priceLabel}</span>${method}${valueBadge}`;
}

function renderRegistryTable() {
  const rows = buildRegistryRows();
  const taskType = els.registryTaskFilter.value || registryData?.taskTypes?.[0];
  els.registryTableBody.innerHTML = rows.length
    ? rows
        .map((entry) => {
          const rankInfo = entry.rankInfo;
          const rankCell =
            rankInfo && !rankInfo.excluded
              ? `<span class="registry-rank-pill ${rankPillClass(rankInfo.tenScale)}" title="Rank ${rankInfo.rank} of ${rankInfo.of} eligible models for this task; score ${rankInfo.score}">${rankInfo.tenScale}/10</span>`
              : `<span class="registry-badge ineligible" title="${escapeAttr(rankInfo?.reasonCode ?? "not ranked")}">excluded</span>`;
          // PARAGON-D-004C1 (P0-4): a provider with no completed catalog
          // assessment has no model to show — say why it is dark rather
          // than rendering an empty model cell.
          const modelCell = entry.pendingAssessment
            ? `<span class="registry-badge ineligible" title="No completed model-catalog assessment yet — this provider contributes no routable models. Run a catalog refresh.">pending assessment</span>`
            : `<code>${escapeHtml(entry.providerDefault ? "(provider default)" : entry.model)}</code>`;
          return `
        <tr class="${rankInfo?.excluded ? "rank-excluded" : ""}">
          <td>${escapeHtml(providerLabel(entry.provider, config?.providers?.[entry.provider]))}</td>
          <td>${modelCell}</td>
          <td>${rankCell}</td>
          <td>${benchmarkCell(entry, taskType)}</td>
          <td><span class="registry-badge health-${escapeAttr(entry.health)}">${escapeHtml(entry.health)}</span></td>
          <td><span class="registry-badge cost-${escapeAttr(entry.costClass)}">${escapeHtml(entry.costClass)}</span></td>
          <td>${escapeHtml(entry.latencyClass)}</td>
          <td>${escapeHtml(contextWindowLabel(entry.contextWindow))}</td>
          <td><span class="registry-badge ${entry.automaticEligibility ? "eligible" : "ineligible"}">${entry.automaticEligibility ? "yes" : "force only"}</span></td>
        </tr>`;
        })
        .join("")
    : `<tr><td colspan="9" class="orch-empty">No models discovered yet — click "Load models" on a provider card above, or Refresh.</td></tr>`;

  els.registryTable.querySelectorAll("th[data-sort-key]").forEach((th) => {
    const key = th.dataset.sortKey;
    th.classList.toggle("sort-active", key === registrySort.key);
    const arrow = registrySort.key === key ? (registrySort.dir === "asc" ? "▲" : "▼") : "↕";
    th.innerHTML = `${th.textContent.replace(/[▲▼↕]$/, "").trim()} <span class="sort-arrow">${arrow}</span>`;
  });
}

function populateRegistryFilters() {
  if (!registryData) {
    return;
  }
  const currentTask = els.registryTaskFilter.value;
  els.registryTaskFilter.innerHTML = registryData.taskTypes
    .map((t) => `<option value="${escapeAttr(t)}">${escapeHtml(t)}</option>`)
    .join("");
  if (registryData.taskTypes.includes(currentTask)) {
    els.registryTaskFilter.value = currentTask;
  }

  const currentProvider = els.registryProviderFilter.value;
  const providers = [...new Set(registryData.registry.map((e) => e.provider))].sort();
  els.registryProviderFilter.innerHTML =
    `<option value="">All</option>` +
    providers.map((p) => `<option value="${escapeAttr(p)}">${escapeHtml(providerLabel(p, config?.providers?.[p]))}</option>`).join("");
  if (providers.includes(currentProvider)) {
    els.registryProviderFilter.value = currentProvider;
  }
}

function renderSourcesDialog() {
  if (!registryData) {
    return;
  }
  const m = registryData.methodology;
  const bm = registryData.benchmarks;
  const taskType = els.registryTaskFilter.value || registryData.taskTypes[0];
  const ranked = (registryData.taskRanking[taskType] ?? []).filter((r) => !r.excluded).slice(0, 8);

  const weightsRows = Object.entries(m.weights)
    .map(([key, value]) => `<tr><td>${escapeHtml(key)}</td><td>${value >= 0 ? "+" : ""}${value}</td></tr>`)
    .join("");

  const resultsList = ranked
    .map(
      (r) =>
        `<li><strong>${escapeHtml(r.provider)} / ${escapeHtml(r.model)}</strong> — score ${r.score}, rank ${r.rank} of ${r.of} (${r.tenScale}/10). ${escapeHtml((r.reasons ?? []).join("; ") || "no scoring factors applied")}</li>`
    )
    .join("");

  let benchmarkSection;
  if (!bm?.enabled) {
    benchmarkSection = `<p class="methodology-note"><strong>External benchmarks:</strong> not configured. Add an OpenRouter API key in Server settings above to pull real, source-disclosed benchmark data (Artificial Analysis intelligence/coding indices and Design Arena Elo/win-rate, aggregated by <a href="https://openrouter.ai/docs/api/api-reference/benchmarks/list-benchmarks" target="_blank" rel="noopener noreferrer">OpenRouter's benchmarks API</a>). Without it, the "External benchmark" column stays empty rather than guessing.</p>`;
  } else if (bm.error) {
    benchmarkSection = `<p class="methodology-note"><strong>External benchmarks:</strong> configured, but the last fetch failed: ${escapeHtml(bm.error)}. Check the key in Server settings.</p>`;
  } else {
    benchmarkSection = `<p class="methodology-note"><strong>External benchmarks:</strong> ${bm.matchedCount} of ${registryData.registry.length} local models matched to a benchmark row (fetched ${bm.cachedAt ? new Date(bm.cachedAt).toLocaleString() : "just now"} from OpenRouter's benchmarks API, source data: Artificial Analysis / Design Arena${bm.sourceMeta?.as_of ? `, as of ${escapeHtml(bm.sourceMeta.as_of)}` : ""}). Matching is best-effort name normalization — a model with no exact benchmark entry (common for provider-internal composite reasoning-effort variants) shows "—" rather than a guessed score. "Best value" marks the cheapest matched candidate within 15% of the highest benchmark index for this task — not simply the highest-scoring (and often most expensive) model.</p>`;
  }

  els.registrySourcesContent.innerHTML = `
    <p class="methodology-note"><strong>Kind:</strong> ${escapeHtml(m.kind)}</p>
    <p class="methodology-note">${escapeHtml(m.description)}</p>
    ${benchmarkSection}
    <p class="methodology-note"><strong>Live weight table</strong> (points applied per factor):</p>
    <table class="methodology-weights"><thead><tr><th>Factor</th><th>Points</th></tr></thead><tbody>${weightsRows}</tbody></table>
    <p class="methodology-note"><strong>Live results for "${escapeHtml(taskType)}"</strong> (top ${ranked.length}, computed just now):</p>
    <ul class="methodology-breakdown">${resultsList || "<li>No eligible candidates for this task type right now.</li>"}</ul>
  `;
}

async function refreshModelRegistry() {
  if (!els.registryTableBody) {
    return;
  }
  if (els.refreshRegistry) {
    els.refreshRegistry.disabled = true;
  }
  try {
    const res = await apiFetch("/api/routing/registry");
    if (!res.ok) {
      return;
    }
    registryData = await res.json();
    populateRegistryFilters();
    renderRegistryTable();
    if (els.registryUpdatedNote) {
      els.registryUpdatedNote.textContent = `Updated ${new Date(registryData.builtAt).toLocaleTimeString()} — refreshes automatically every 30s.`;
    }
    if (els.registryBenchmarkNote) {
      const bm = registryData.benchmarks;
      if (!bm?.enabled) {
        els.registryBenchmarkNote.textContent = "External benchmarks: not configured";
      } else if (bm.stale) {
        // PARAGON-D-004C1 (P0-7): data past the maximum usable age is kept
        // visible for diagnostics but is not applied to scoring, so say so
        // rather than implying it is still influencing rankings.
        const ageHours = bm.dataAgeMs != null ? (bm.dataAgeMs / 3_600_000).toFixed(1) : "unknown";
        const why = bm.error ? ` last error: ${bm.error.slice(0, 50)}` : "";
        els.registryBenchmarkNote.textContent = `External benchmarks: DISABLED — data ${ageHours}h old exceeds max usable age; scoring is internal-only.${why}`;
      } else if (bm.error) {
        els.registryBenchmarkNote.textContent = `External benchmarks: last fetch failed (${bm.error.slice(0, 50)}), still using data from ${bm.lastSuccessfulFetchAt ?? "unknown"}`;
      } else {
        els.registryBenchmarkNote.textContent = `External benchmarks: ${bm.matchedCount} models matched (exact/alias only)`;
      }
    }
  } catch {
    // Best-effort panel; a failed fetch here must not disturb the rest of the dashboard.
  } finally {
    if (els.refreshRegistry) {
      els.refreshRegistry.disabled = false;
    }
  }
}

const STATE_LABEL = {
  exposed: "Exposed",
  validated: "Validated",
  stale: "Stale",
  rejected: "Rejected",
  unavailable: "Unavailable",
  authentication_blocked: "Auth blocked",
  quota_blocked: "Quota blocked",
  entitlement_blocked: "Entitlement required",
  configuration_blocked: "Config error",
  provider_offline: "Provider offline",
  unknown: "Candidate only",
  retired: "Retired"
};

function relativeTimeFrom(iso) {
  if (!iso) {
    return "never";
  }
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) {
    return "never";
  }
  const hours = ms / 3_600_000;
  if (hours < 1) {
    return `${Math.max(1, Math.round(ms / 60000))}m ago`;
  }
  if (hours < 48) {
    return `${Math.round(hours)}h ago`;
  }
  return `${Math.round(hours / 24)}d ago`;
}

function renderCatalogTable(catalog) {
  if (!els.catalogTableBody) {
    return;
  }
  const rows = [];
  for (const [provider, bucket] of Object.entries(catalog?.providers ?? {})) {
    for (const model of Object.values(bucket.models ?? {})) {
      rows.push({ provider, ...model });
    }
  }
  rows.sort((a, b) => a.provider.localeCompare(b.provider) || a.modelId.localeCompare(b.modelId));

  els.catalogTableBody.innerHTML = rows.length
    ? rows
        .map(
          (r) => `
      <tr>
        <td>${escapeHtml(providerLabel(r.provider, config?.providers?.[r.provider]))}</td>
        <td>${escapeHtml(r.displayName || r.modelId)}${r.isAlias ? ' <span class="registry-badge health-unknown">alias</span>' : ""}</td>
        <td>${escapeHtml(STATE_LABEL[r.state] || r.state)}</td>
        <td>${r.automaticEligibility ? '<span class="registry-badge health-healthy">yes</span>' : '<span class="registry-badge health-unhealthy">no</span>'}</td>
        <td>${escapeHtml(r.discoverySource || "")}</td>
        <td>${escapeHtml(relativeTimeFrom(r.validatedAt))}</td>
        <td>${r.lastFailureClassification ? escapeHtml(`${r.lastFailureClassification} (${relativeTimeFrom(r.lastFailureAt)})`) : "—"}</td>
        <td><button type="button" class="btn ghost sm" data-validate-provider="${escapeAttr(r.provider)}" data-validate-model="${escapeAttr(r.modelId)}">Validate now</button></td>
      </tr>`
        )
        .join("")
    : `<tr><td colspan="8">No providers have been assessed by the model catalog yet — the first automatic refresh runs on startup.</td></tr>`;

  els.catalogTableBody.querySelectorAll("[data-validate-provider]").forEach((btn) => {
    btn.addEventListener("click", () => validateCatalogModel(btn.dataset.validateProvider, btn.dataset.validateModel));
  });
}

/**
 * PARAGON-D-004D1 (Phase 1, "model testing"): the advanced administrative
 * action that replaced the model dropdown's implicit "pick a model" gesture.
 * Validating from here probes the model and updates its catalog state only —
 * it deliberately does not write `providers.<id>.model`.
 */
function openCatalogInspector(provider) {
  els.catalogInspectTitle.textContent = `Catalog — ${providerLabel(provider, config.providers[provider])}`;
  els.catalogInspectDialog.dataset.provider = provider;
  renderCatalogInspector(provider);
  els.catalogInspectDialog.showModal();
}

function renderCatalogInspector(provider) {
  const bucket = catalogSnapshot?.providers?.[provider];
  const models = Object.values(bucket?.models ?? {})
    .filter((model) => model.state !== "retired")
    .sort((a, b) => a.modelId.localeCompare(b.modelId));

  els.catalogInspectBody.innerHTML = models.length
    ? models
        .map(
          (model) => `
      <tr>
        <td><code>${escapeHtml(model.displayName || model.modelId)}</code></td>
        <td>${escapeHtml(STATE_LABEL[model.state] || model.state)}</td>
        <td>${model.automaticEligibility ? '<span class="registry-badge health-healthy">yes</span>' : '<span class="registry-badge health-unhealthy">no</span>'}</td>
        <td>${escapeHtml(relativeTimeFrom(model.validatedAt))}</td>
        <td><button type="button" class="btn ghost sm" data-inspect-validate="${escapeAttr(model.modelId)}">Validate model</button></td>
      </tr>`
        )
        .join("")
    : `<tr><td colspan="5" class="orch-empty">No catalog assessment for this provider yet — run "Refresh all providers" in the Model Catalog panel.</td></tr>`;

  els.catalogInspectBody.querySelectorAll("[data-inspect-validate]").forEach((button) => {
    button.addEventListener("click", async () => {
      button.disabled = true;
      button.textContent = "Validating…";
      await validateCatalogModel(provider, button.dataset.inspectValidate);
      renderCatalogInspector(provider);
      refreshProviderSummaries();
    });
  });
}

async function refreshProviderSummaries() {
  try {
    const res = await apiFetch("/api/routing/providers");
    if (!res.ok) {
      return;
    }
    const body = await res.json();
    providerSummaries = Object.fromEntries((body.providers ?? []).map((entry) => [entry.provider, entry]));
    patchProviderRoutingSummaries();
  } catch {
    // Best-effort panel; a failed fetch must not disturb the rest of the UI.
  }
}

function factsHtml(rows) {
  return rows
    .map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(String(value))}</dd></div>`)
    .join("");
}

/**
 * PARAGON-D-004D1 (Phases 2, 5): states which engine actually decides
 * execution and which is advisory, using each engine's own reported fields
 * rather than restating them in prose that can drift.
 */
function renderRoutingStatus() {
  if (!routingStatus) {
    return;
  }
  const live = routingStatus.liveRouter;
  const shadow = routingStatus.shadowRouter;

  els.liveRouterFacts.innerHTML = factsHtml([
    ["Engine", "PARAGON-D-004C1"],
    ["Mode", live.mode],
    ["Selection method", "deterministic score, per request"],
    ["Candidate set", "eligible catalog models only"],
    ["Task-provider preference active", live.taskProviderPreferenceActive ? `yes (+${live.taskProviderPreferencePoints})` : "no"],
    ["Catalog eligibility enforced", live.catalogEligibilityEnforced ? "yes" : "no"],
    ["Static default fallback", live.staticDefaultFallback ? "enabled" : "disabled"],
    ["Empty eligible set", `${live.emptyEligibleSetBehavior.status} ${live.emptyEligibleSetBehavior.code}`]
  ]);

  const s = shadow.summary ?? {};
  const latest = shadow.latest;
  els.shadowRouterFacts.innerHTML = factsHtml([
    ["Engine", "PARAGON-D-004D"],
    ["Mode", shadow.mode],
    ["Selection method", "expected utility"],
    ["Affects provider execution", shadow.affectsProviderExecution ? "yes" : "no"],
    ["Additional provider calls", shadow.additionalProviderCalls ? "yes" : "no"],
    [
      "Agreement",
      s.total
        ? `${s.agrees ?? 0} agree / ${s.disagrees ?? 0} disagree of ${s.total}${s.agreementRate != null ? ` (${(s.agreementRate * 100).toFixed(0)}%)` : ""}`
        : "no decisions recorded yet"
    ],
    ["Latest live winner", latest?.live?.model ? `${latest.live.provider}/${latest.live.model}` : "not observed yet"],
    ["Latest shadow winner", latest?.shadow?.providerModelId ? `${latest.shadow.provider}/${latest.shadow.providerModelId}` : "not observed yet"],
    ["Latest shadow confidence", latest?.confidence?.level ?? "—"],
    ["Telemetry buckets", String(shadow.telemetryEntryCount ?? 0)]
  ]);

  els.routerAuthorityNote.textContent =
    "PARAGON-D-004C1 currently determines real execution. PARAGON-D-004D is advisory only: it does not alter " +
    "provider usage, model choice, fallback order, or any response, and it issues no provider calls of its own.";

  const liveMax = live.maxAttempts != null ? `${live.maxAttempts}` : "set by live-enforcement policy";
  els.fallbackMaxNote.textContent =
    `Maximum live attempts per request: ${liveMax}. The shadow engine plans up to ${shadow.maximumAttempts} ` +
    "attempts independently, and executes none of them.";

  renderAttemptPlans();
  renderDeprecatedFields();
  // The +3 wording on the legacy preference rows is read from the live
  // engine's reported weight, so re-render once it is known.
  renderRoutes();
}

function renderPlanList(listEl, metaEl, planRecord, emptyText) {
  if (!listEl || !metaEl) {
    return;
  }
  if (!planRecord?.plan?.length) {
    metaEl.textContent = emptyText;
    listEl.innerHTML = "";
    return;
  }
  const profile = planRecord.taskProfile;
  const context = profile
    ? ` · work: ${profile.workType}, complexity: ${profile.complexity}, context band: ${profile.contextBand}, output: ${profile.outputContract}`
    : planRecord.taskType
      ? ` · task type: ${planRecord.taskType}`
      : "";
  metaEl.textContent = `Recorded ${relativeTimeFrom(planRecord.at)} (${new Date(planRecord.at).toLocaleTimeString()})${context}`;
  listEl.innerHTML = planRecord.plan
    .map(
      (entry) =>
        `<li><span class="plan-provider">${escapeHtml(providerLabel(entry.provider, config?.providers?.[entry.provider]))}</span> <code>${escapeHtml(entry.model ?? "—")}</code>${entry.alternateForProvider ? ' <span class="registry-badge health-unknown">same-provider alternate</span>' : ""}</li>`
    )
    .join("");
}

function renderAttemptPlans() {
  renderPlanList(els.livePlanList, els.livePlanMeta, routingStatus?.liveRouter?.latestAttemptPlan, "No live request observed since startup.");
  renderPlanList(
    els.shadowPlanList,
    els.shadowPlanMeta,
    routingStatus?.shadowRouter?.latestAttemptPlan,
    "No shadow decision observed since startup."
  );
}

function renderDeprecatedFields() {
  if (!els.deprecatedConfigList) {
    return;
  }
  const fields = routingStatus?.deprecatedConfigFields ?? [];
  const stored = {
    "routing.defaultProvider": config?.routing?.defaultProvider ?? "(unset)",
    "routing.fallbackChain": Array.isArray(config?.routing?.fallbackChain) ? config.routing.fallbackChain.join(" → ") || "(empty)" : "(unset)",
    "providers.*.model": Object.entries(config?.providers ?? {})
      .filter(([, cfg]) => cfg?.model)
      .map(([name, cfg]) => `${name}: ${cfg.model}`)
      .join(", ") || "(all empty)"
  };

  els.deprecatedConfigList.innerHTML = fields
    .map(
      (field) => `
      <div class="deprecated-field">
        <h3><code>${escapeHtml(field.path)}</code> <span class="registry-badge ineligible">deprecated</span></h3>
        <p class="methodology-note">${escapeHtml(field.reason)}</p>
        <dl class="router-facts">
          ${factsHtml([
            ["Stored value", stored[field.path] ?? "—"],
            ["Retained for backward compatibility", field.retainedForBackwardCompatibility ? "yes" : "no"],
            ["Authoritative for live routing", field.authoritativeForLiveRouting ? "yes" : "no"],
            ["Hidden from primary dashboard", field.hiddenFromPrimaryDashboard ? "yes" : "no"],
            ["Superseded by", field.supersededBy],
            ["Deprecated since", field.since],
            ["Scheduled removal", field.scheduledRemoval]
          ])}
        </dl>
      </div>`
    )
    .join("");
}

function renderShadowSettings() {
  const settings = routingStatus?.shadowRouter;
  if (!settings || !els.shadowSettingMode) {
    return;
  }
  const ri = config?.routingIntelligence ?? {};
  els.shadowSettingMode.value = settings.mode ?? "shadow";
  els.shadowSettingQuotaScarcity.value = ri.quotaScarcity ?? 0;
  els.shadowSettingContextThreshold.value = ri.unknownLargeContextThresholdTokens ?? 50000;
  els.shadowSettingMinSamples.value = ri.minimumSamplesForMeasuredEstimate ?? 10;
  els.shadowSettingMaxAttempts.value = ri.maximumAttempts ?? 4;
  els.shadowSettingRetentionDays.value = ri.telemetryRetentionDays ?? 30;

  els.shadowMappingFacts.innerHTML = factsHtml([
    ["Canonical alias mappings", `${(ri.canonicalAliasMappings ?? []).length} record(s)`],
    ["Reasoning profile mappings", `${Object.keys(ri.reasoningProfileMappings ?? {}).length} override(s)`],
    ["Capability mappings", `${Object.keys(ri.capabilityMappings ?? {}).length} override(s)`],
    ["Context overrides", `${Object.keys(ri.contextOverrides ?? {}).length} override(s)`],
    ["Shadow record limit", String(ri.shadowRecordLimit ?? 200)]
  ]);
}

async function saveShadowSettings() {
  els.saveShadowSettings.disabled = true;
  els.shadowSettingsStatus.textContent = "";
  els.shadowSettingsStatus.className = "settings-save-note";
  try {
    const response = await apiFetch("/api/routing-intelligence/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quotaScarcity: Number(els.shadowSettingQuotaScarcity.value),
        unknownLargeContextThresholdTokens: Number(els.shadowSettingContextThreshold.value),
        minimumSamplesForMeasuredEstimate: Number(els.shadowSettingMinSamples.value),
        maximumAttempts: Number(els.shadowSettingMaxAttempts.value),
        telemetryRetentionDays: Number(els.shadowSettingRetentionDays.value)
      })
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.error?.details?.join("; ") ?? body.error?.message ?? "Save failed");
    }
    config.routingIntelligence = body;
    els.shadowSettingsStatus.textContent = "Saved — applies to the next shadow computation. Live routing is unchanged.";
    els.shadowSettingsStatus.className = "settings-save-note success";
    renderShadowSettings();
  } catch (error) {
    els.shadowSettingsStatus.textContent = error.message || "Save failed";
    els.shadowSettingsStatus.className = "settings-save-note error";
  } finally {
    els.saveShadowSettings.disabled = false;
  }
}

async function refreshRoutingStatus() {
  if (!els.liveRouterFacts) {
    return;
  }
  if (els.refreshRoutingStatus) {
    els.refreshRoutingStatus.disabled = true;
  }
  try {
    const res = await apiFetch("/api/routing/status");
    if (!res.ok) {
      return;
    }
    routingStatus = await res.json();
    renderRoutingStatus();
    renderShadowSettings();
  } catch {
    // Best-effort panel; a failed fetch must not disturb the rest of the UI.
  } finally {
    if (els.refreshRoutingStatus) {
      els.refreshRoutingStatus.disabled = false;
    }
  }
}

async function refreshModelCatalog() {
  if (!els.catalogTableBody) {
    return;
  }
  try {
    const res = await apiFetch("/api/model-catalog");
    if (!res.ok) {
      return;
    }
    const catalog = await res.json();
    catalogSnapshot = catalog;
    renderCatalogTable(catalog);
    if (els.catalogScheduleNote) {
      const s = catalog.schedule ?? {};
      els.catalogScheduleNote.textContent = s.refreshing
        ? "Refresh in progress…"
        : `Next automatic refresh: ${s.nextRefreshAt ? new Date(s.nextRefreshAt).toLocaleString() : "not yet scheduled"}`;
    }
    if (els.catalogUpdatedNote) {
      els.catalogUpdatedNote.textContent = `Updated ${new Date().toLocaleTimeString()} — refreshes automatically every 24h.`;
    }
  } catch {
    // Best-effort panel; a failed fetch here must not disturb the rest of the dashboard.
  }
}

async function refreshAllCatalogProviders() {
  if (els.refreshCatalog) {
    els.refreshCatalog.disabled = true;
  }
  try {
    const res = await apiFetch("/api/model-catalog/refresh", { method: "POST" });
    if (res.ok) {
      const body = await res.json();
      renderCatalogTable(body.catalog);
    }
  } catch {
    // Best-effort; the periodic poll will pick up the eventual result either way.
  } finally {
    if (els.refreshCatalog) {
      els.refreshCatalog.disabled = false;
    }
    refreshModelCatalog();
    refreshProviderSummaries();
  }
}

async function validateAllCatalogModels() {
  if (els.validateAllCatalog) {
    els.validateAllCatalog.disabled = true;
  }
  if (els.refreshCatalog) {
    els.refreshCatalog.disabled = true;
  }
  if (els.catalogUpdatedNote) {
    els.catalogUpdatedNote.textContent = "Validating every model — each one is probed individually with a minimal request; a model that can't be validated is skipped, not blocking, and stays unvalidated. This can take a while for large catalogs.";
  }
  try {
    const res = await apiFetch("/api/model-catalog/validate-all", { method: "POST" });
    if (res.ok) {
      const body = await res.json();
      renderCatalogTable(body.catalog);
      if (els.catalogUpdatedNote) {
        els.catalogUpdatedNote.textContent = `Validate all: ${body.validated} validated, ${body.stillUnvalidated} still unvalidated (of ${body.total}).`;
      }
    } else if (res.status === 409) {
      if (els.catalogUpdatedNote) {
        els.catalogUpdatedNote.textContent = "A validate-all run is already in progress.";
      }
    }
  } catch {
    if (els.catalogUpdatedNote) {
      els.catalogUpdatedNote.textContent = "Validate all failed to complete — check the logs.";
    }
  } finally {
    if (els.validateAllCatalog) {
      els.validateAllCatalog.disabled = false;
    }
    if (els.refreshCatalog) {
      els.refreshCatalog.disabled = false;
    }
    refreshModelCatalog();
    refreshProviderSummaries();
  }
}

async function validateCatalogModel(provider, modelId) {
  try {
    const res = await apiFetch(`/api/model-catalog/providers/${encodeURIComponent(provider)}/models/${encodeURIComponent(modelId)}/validate`, {
      method: "POST"
    });
    if (res.ok) {
      await refreshModelCatalog();
      refreshProviderSummaries();
    }
  } catch {
    // Best-effort — the table simply won't update this click.
  }
}

/**
 * PARAGON-D-004D (Phase 11): scenario evaluation. Calls the same
 * computeShadowRoute() the live shadow pass uses, so for an identical task
 * profile this table IS the shadow ranking — not a separate approximation.
 */
async function runRoutingScenario() {
  if (!els.scenarioTableBody) return;
  if (els.runScenario) els.runScenario.disabled = true;
  try {
    const contextChoice = els.scenarioContext?.value ?? "1000";
    const estimatedInputTokens =
      contextChoice === "custom" ? Number(els.scenarioCustomTokens?.value) || 0 : Number(contextChoice) || 0;

    const scenario = {
      prompt: els.scenarioPrompt?.value ?? "",
      estimatedInputTokens,
      streaming: Boolean(els.scenarioStreaming?.checked),
      toolCalls: Boolean(els.scenarioTools?.checked),
      structuredOutput: Boolean(els.scenarioStructured?.checked)
    };
    if (els.scenarioReasoning?.value) scenario.reasoningDemand = els.scenarioReasoning.value;
    if (els.scenarioLatency?.value) scenario.latencyPreference = els.scenarioLatency.value;
    if (els.scenarioCost?.value) scenario.costSensitivity = els.scenarioCost.value;

    const res = await apiFetch("/api/routing-intelligence/scenario", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(scenario)
    });
    if (!res.ok) {
      els.scenarioProfileNote.textContent = "Scenario evaluation failed.";
      return;
    }
    const body = await res.json();
    renderScenario(body);

    const meta = await apiFetch("/api/routing-intelligence");
    if (meta.ok) {
      const info = await meta.json();
      const s = info.shadowSummary ?? {};
      els.scenarioShadowSummary.textContent =
        `Live selector: ${info.liveRouteSelector} (unchanged). Shadow mode: ${info.settings.mode}. ` +
        `Recorded shadow decisions: ${s.total ?? 0} (agree ${s.agrees ?? 0}, disagree ${s.disagrees ?? 0}` +
        `${s.agreementRate != null ? `, agreement ${(s.agreementRate * 100).toFixed(0)}%` : ""}). ` +
        `Telemetry buckets: ${info.telemetryEntryCount ?? 0}.`;
    }
  } catch {
    // Best-effort panel — a failure here must never disturb the dashboard.
  } finally {
    if (els.runScenario) els.runScenario.disabled = false;
  }
}

function fmtNum(value, digits = 2) {
  return value == null || Number.isNaN(Number(value)) ? "—" : Number(value).toFixed(digits);
}

function fmtTokens(value) {
  if (value == null) return "—";
  return Number(value) >= 1000 ? `${(Number(value) / 1000).toFixed(1)}k` : String(Math.round(Number(value)));
}

function renderScenario(body) {
  const p = body.taskProfile ?? {};
  els.scenarioProfileNote.textContent =
    `Task profile — work: ${p.workType}, complexity: ${p.complexity}, risk: ${p.risk}, ` +
    `reasoning demand: ${p.reasoningDemand}, context band: ${p.contextBand}, output: ${p.outputContract}, ` +
    `latency: ${p.latencyPreference}, quality: ${p.qualityPreference}, cost sensitivity: ${p.costSensitivity}. ` +
    `Requires: ${(p.requiredCapabilities ?? []).join(", ")}. ` +
    `Confidence: ${body.confidence?.level ?? "—"}` +
    `${body.confidence?.margin != null ? ` (margin ${fmtNum(body.confidence.margin)})` : ""}.`;

  const rows = body.ranked ?? [];
  els.scenarioTableBody.innerHTML = rows.length
    ? rows
        .map((c) => {
          if (c.excluded) {
            return `<tr class="rank-excluded">
              <td>${escapeHtml(c.provider)}</td>
              <td><code>${escapeHtml(c.providerModelId ?? "—")}</code></td>
              <td colspan="14"><span class="registry-badge ineligible" title="${escapeAttr(c.detail ?? "")}">${escapeHtml(c.reasonCode ?? "excluded")}</span></td>
              <td><span class="registry-badge ineligible">excluded</span></td>
            </tr>`;
          }
          const cost = c.cost ?? {};
          const comp = c.components ?? {};
          const range = cost.expectedReasoningTokenRange;
          return `<tr>
            <td>${escapeHtml(c.provider)}</td>
            <td><code>${escapeHtml(c.providerModelId)}</code></td>
            <td><code>${escapeHtml(c.canonicalModelId)}</code></td>
            <td><span class="registry-badge cost-standard">${escapeHtml(c.reasoningEffort)}</span></td>
            <td>${escapeHtml(c.speedMode)}</td>
            <td title="${escapeAttr(`source: ${c.contextModel?.contextEvidenceSource ?? "unknown"}, confidence: ${c.contextModel?.contextConfidence ?? "none"}`)}">${fmtTokens(c.contextModel?.effectiveUsableContextWindow)}</td>
            <td title="${escapeAttr(range ? `reasoning range ${range.min}-${range.max} (${cost.reasoningEstimateSource})` : String(cost.reasoningEstimateSource ?? ""))}">${fmtTokens(cost.expectedInputTokens)} / ${fmtTokens(cost.expectedVisibleOutputTokens)} / ${fmtTokens(cost.expectedReasoningTokens)}</td>
            <td>${cost.estimatedMonetaryCost != null ? `$${Number(cost.estimatedMonetaryCost).toFixed(5)}` : "—"}</td>
            <td title="${escapeAttr(`source: ${cost.quotaBurnSource ?? "n/a"}`)}">${cost.isSubscriptionProvider ? fmtNum(cost.estimatedQuotaBurn) : "—"}</td>
            <td title="${escapeAttr(`source: ${comp.latencySource ?? ""}`)}">${comp.measuredLatencyP95Ms != null ? `${Math.round(comp.measuredLatencyP95Ms)}ms` : fmtNum(comp.expectedLatencyPenalty)}</td>
            <td title="${escapeAttr(`source: ${comp.successSource ?? ""}`)}">${fmtNum(comp.probabilityOfSuccessfulCompletion)}</td>
            <td title="${escapeAttr(`source: ${comp.qualitySource ?? ""}`)}">${fmtNum(comp.expectedTaskQuality)}</td>
            <td title="${escapeAttr((comp.uncertaintyReasons ?? []).join("; "))}">${fmtNum(comp.uncertaintyPenalty)}</td>
            <td><strong>${fmtNum(c.expectedUtility)}</strong></td>
            <td title="${escapeAttr(c.benchmark?.matchedBenchmarkModel ?? "no benchmark")}">${escapeHtml(c.benchmark?.matchMethod ?? "none")}</td>
            <td>${c.telemetry?.sampleCount ?? 0}</td>
            <td><span class="registry-badge eligible">rank ${c.rank ?? "—"}/${c.of ?? "—"}</span></td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="17" class="orch-empty">No candidates — every provider is pending assessment or excluded.</td></tr>`;

  const plan = body.attemptPlan ?? [];
  els.scenarioPlanNote.textContent = plan.length
    ? `Shadow attempt plan (not executed): ${plan
        .map((a) => `${a.order}. ${a.provider}/${a.providerModelId}${a.alternateForProvider ? " (same-provider alternate)" : ""}`)
        .join("  →  ")}`
    : "Shadow attempt plan: empty.";
}

async function saveOrchestrationSettings() {
  if (!orchestrationPolicy) {
    return;
  }
  els.saveOrchSettings.disabled = true;
  els.orchSettingsStatus.textContent = "";
  els.orchSettingsStatus.className = "settings-save-note";
  try {
    const candidate = {
      ...orchestrationPolicy,
      mode: els.orchSettingMode.value,
      context: { ...orchestrationPolicy.context, absoluteCeilingTokens: Number(els.orchSettingContextCeiling.value) },
      concurrency: { ...orchestrationPolicy.concurrency, maxConcurrent: Number(els.orchSettingMaxConcurrent.value) },
      fallback: { ...orchestrationPolicy.fallback, maxAttempts: Number(els.orchSettingMaxFallback.value) },
      circuitBreaker: {
        ...orchestrationPolicy.circuitBreaker,
        failureThreshold: Number(els.orchSettingCircuitThreshold.value),
        cooldownMs: Number(els.orchSettingCircuitCooldown.value)
      },
      session: { ...orchestrationPolicy.session, hardLimitMinutes: Number(els.orchSettingSessionHardLimit.value) },
      retentionDays: Number(els.orchSettingRetentionDays.value)
    };
    const response = await apiFetch("/api/orchestration/policy", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(candidate)
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.error?.details?.join("; ") ?? body.error?.message ?? "Save failed");
    }
    orchestrationPolicy = body;
    renderOrchestrationSettings();
    els.orchSettingsStatus.textContent = "Saved — took effect immediately, no restart required.";
    els.orchSettingsStatus.className = "settings-save-note success";
    refreshOrchestration();
  } catch (error) {
    els.orchSettingsStatus.textContent = error.message || "Save failed";
    els.orchSettingsStatus.className = "settings-save-note error";
  } finally {
    els.saveOrchSettings.disabled = false;
  }
}

function escapeAttr(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

toggleNewProviderFields();
