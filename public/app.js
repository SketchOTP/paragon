/**
 * PARAGON dashboard (PARAGON-D-004E).
 *
 * Four product areas and nothing else on the primary page: Connection,
 * Providers, Automatic Routing, Recent Activity. Everything engineering-shaped
 * — the eligible registry, the catalog, attempt plans, utility decomposition,
 * circuit state, raw logs — lives behind the single Advanced Diagnostics
 * surface, reached from Settings.
 *
 * Two rules this file exists to hold:
 *
 *  1. **One general save.** Exactly one "Save Changes" button, in Settings.
 *     Everything else is an immediate action that reports its own success or
 *     failure (connect, reconnect, test, refresh, validate, avatar, clear).
 *  2. **Product language only.** No internal directive identifiers, no engine
 *     names, no transition-era mode terminology, no scoring-formula jargon, and
 *     no retired-compatibility surface. Technical vocabulary is allowed inside
 *     Diagnostics and nowhere else.
 */

const BUILTIN_ORDER = ["claude", "codex", "cursor", "antigravity"];
const API_KEY_STORAGE = "paragon-api-key";

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

const authUi = {
  claude: { label: "Sign in", short: "Browser" },
  codex: { label: "Device login", short: "Device" },
  cursor: { label: "Sign in", short: "Browser" }
  // antigravity intentionally omitted — no verified dashboard-triggerable
  // login flow. It relies on host-level auth set up outside PARAGON.
};

let authFlowsMeta = { ...authUi };
let avatarEditProvider = null;
let avatarDraftDataUrl = "";
let newProviderAvatarDataUrl = "";
let providerEditTarget = null;
let statusRefreshTimer = null;
/** Providers with an open sign-in panel — skip full card re-render so code inputs stay visible. */
const authInProgress = new Set();
/** Persisted auth panel content (URL, code draft) across status refreshes. */
const authPanelState = new Map();
let lastStatusFetchMs = 0;
const STATUS_MIN_INTERVAL_MS = 8000;
const AUTH_POLL_INTERVAL_MS = 8000;

let config = null;
let overview = null;
let settings = null;

const els = {
  onboarding: document.querySelector("#onboarding"),
  onboardingProviders: document.querySelector("#onboarding-providers"),
  onboardingBaseUrl: document.querySelector("#onboarding-base-url"),
  onboardingModel: document.querySelector("#onboarding-model"),
  onboardingApiKey: document.querySelector("#onboarding-api-key"),
  onboardingSnippet: document.querySelector("#onboarding-snippet"),
  onboardingTest: document.querySelector("#onboarding-test"),
  onboardingTestResult: document.querySelector("#onboarding-test-result"),
  onboardingFinish: document.querySelector("#onboarding-finish"),
  onboardingRecheck: document.querySelector("#onboarding-recheck"),
  onboardingAddProvider: document.querySelector("#onboarding-add-provider"),
  onboardingCopySnippet: document.querySelector("#onboarding-copy-snippet"),

  app: document.querySelector("#app"),
  baseUrl: document.querySelector("#base-url"),
  modelName: document.querySelector("#model-name"),
  apiKeyValue: document.querySelector("#api-key"),
  serviceHealth: document.querySelector("#service-health"),
  providers: document.querySelector("#providers"),
  refreshStatus: document.querySelector("#refresh-status"),
  routingState: document.querySelector("#routing-state"),
  routingFacts: document.querySelector("#routing-facts"),
  routingWarnings: document.querySelector("#routing-warnings"),
  editPriority: document.querySelector("#edit-priority"),
  activityList: document.querySelector("#activity-list"),
  refreshActivity: document.querySelector("#refresh-activity"),
  addProvider: document.querySelector("#add-provider"),
  openSettings: document.querySelector("#open-settings"),

  toggleRanking: document.querySelector("#toggle-ranking"),
  rankingBody: document.querySelector("#ranking-body"),
  rankingRows: document.querySelector("#ranking-body-rows"),
  rankingSummary: document.querySelector("#ranking-summary"),
  rankingNote: document.querySelector("#ranking-note"),
  rankingWorktype: document.querySelector("#ranking-worktype"),
  rankingComplexity: document.querySelector("#ranking-complexity"),
  rankingTokens: document.querySelector("#ranking-tokens"),
  rankingFilter: document.querySelector("#ranking-filter"),
  refreshRanking: document.querySelector("#refresh-ranking"),

  settingsDialog: document.querySelector("#settings-dialog"),
  settingExposedModel: document.querySelector("#setting-exposed-model"),
  settingApiKey: document.querySelector("#setting-api-key"),
  settingBaseUrl: document.querySelector("#setting-base-url"),
  settingTailscaleHost: document.querySelector("#setting-tailscale-host"),
  settingServePort: document.querySelector("#setting-serve-port"),
  settingFunnelPort: document.querySelector("#setting-funnel-port"),
  priorityPicker: document.querySelector("#priority-picker"),
  providerPreferencePoints: document.querySelector("#provider-preference-points"),
  settingArtificialAnalysisKey: document.querySelector("#setting-artificial-analysis-key"),
  settingOpenRouterKey: document.querySelector("#setting-openrouter-key"),
  removeOpenRouter: document.querySelector("#remove-openrouter"),
  artificialAnalysisStatus: document.querySelector("#artificial-analysis-status"),
  testArtificialAnalysis: document.querySelector("#test-artificial-analysis"),
  refreshArtificialAnalysis: document.querySelector("#refresh-artificial-analysis"),
  removeArtificialAnalysis: document.querySelector("#remove-artificial-analysis"),
  settingRetentionDays: document.querySelector("#setting-retention-days"),
  clearActivity: document.querySelector("#clear-activity"),
  clearActivityStatus: document.querySelector("#clear-activity-status"),
  settingsStatus: document.querySelector("#settings-status"),
  saveSettings: document.querySelector("#save-settings"),
  settingsClose: document.querySelector("#settings-close"),
  settingsCloseX: document.querySelector("#settings-close-x"),
  openDiagnostics: document.querySelector("#open-diagnostics"),

  diagnosticsDialog: document.querySelector("#diagnostics-dialog"),
  diagnosticsClose: document.querySelector("#diagnostics-close"),
  diagTabs: document.querySelector("#diag-tabs"),
  diagModelsBody: document.querySelector("#diag-models-body"),
  diagModelsNote: document.querySelector("#diag-models-note"),
  diagRefreshCatalog: document.querySelector("#diag-refresh-catalog"),
  diagValidateAll: document.querySelector("#diag-validate-all"),
  diagRoutingFacts: document.querySelector("#diag-routing-facts"),
  diagRoutingNote: document.querySelector("#diag-routing-note"),
  diagPlanList: document.querySelector("#diag-plan-list"),
  diagCandidatesBody: document.querySelector("#diag-candidates-body"),
  diagRunPreview: document.querySelector("#diag-run-preview"),
  diagPreviewPrompt: document.querySelector("#diag-preview-prompt"),
  diagRequestsBody: document.querySelector("#diag-requests-body"),
  diagUsageBody: document.querySelector("#diag-usage-body"),
  diagRequestsNote: document.querySelector("#diag-requests-note"),
  diagRefreshRequests: document.querySelector("#diag-refresh-requests"),
  diagLogs: document.querySelector("#diag-logs"),
  diagSystemFacts: document.querySelector("#diag-system-facts"),
  diagSystemNote: document.querySelector("#diag-system-note"),
  diagRefreshSystem: document.querySelector("#diag-refresh-system"),
  diagExport: document.querySelector("#diag-export"),

  providerEditDialog: document.querySelector("#provider-edit-dialog"),
  providerEditTitle: document.querySelector("#provider-edit-title"),
  providerEditCommand: document.querySelector("#provider-edit-command"),
  providerEditCommandField: document.querySelector("#provider-edit-command-field"),
  providerEditBaseUrl: document.querySelector("#provider-edit-base-url"),
  providerEditBaseUrlField: document.querySelector("#provider-edit-base-url-field"),
  providerEditApiKey: document.querySelector("#provider-edit-api-key"),
  providerEditApiKeyField: document.querySelector("#provider-edit-api-key-field"),
  providerEditStatus: document.querySelector("#provider-edit-status"),
  providerEditApply: document.querySelector("#provider-edit-apply"),
  providerEditCancel: document.querySelector("#provider-edit-cancel"),
  providerEditTest: document.querySelector("#provider-edit-test"),

  addProviderDialog: document.querySelector("#add-provider-dialog"),
  addProviderForm: document.querySelector("#add-provider-form"),
  addProviderCancel: document.querySelector("#add-provider-cancel"),
  newProviderType: document.querySelector("#new-provider-type"),
  newProviderAvatarImage: document.querySelector("#new-provider-avatar-image"),
  newProviderAvatarPlaceholder: document.querySelector("#new-provider-avatar-placeholder"),
  newProviderAvatarFile: document.querySelector("#new-provider-avatar-file"),

  avatarDialog: document.querySelector("#avatar-dialog"),
  avatarDialogImage: document.querySelector("#avatar-dialog-image"),
  avatarFile: document.querySelector("#avatar-file"),
  avatarStatus: document.querySelector("#avatar-status"),
  avatarApply: document.querySelector("#avatar-apply"),
  avatarReset: document.querySelector("#avatar-reset"),
  avatarCancel: document.querySelector("#avatar-cancel"),

  modelInspectDialog: document.querySelector("#model-inspect-dialog"),
  modelInspectTitle: document.querySelector("#model-inspect-title"),
  modelInspectFacts: document.querySelector("#model-inspect-facts"),
  modelInspectClose: document.querySelector("#model-inspect-close"),

  apiKeyDialog: document.querySelector("#api-key-dialog"),
  apiKeyForm: document.querySelector("#api-key-form"),
  apiKeyInput: document.querySelector("#api-key-input"),
  toast: document.querySelector("#toast")
};

// ---------------------------------------------------------------- utilities

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll('"', "&quot;");
}

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

function flashNotice(message, { type = "success", ms = 2600 } = {}) {
  if (!els.toast) {
    return;
  }
  els.toast.textContent = message;
  els.toast.className = `toast ${type}`;
  els.toast.hidden = false;
  clearTimeout(flashNotice.timer);
  flashNotice.timer = setTimeout(() => {
    els.toast.hidden = true;
  }, ms);
}

async function copyText(text, button) {
  if (!text) {
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  if (button) {
    const previous = button.textContent;
    button.textContent = "Copied";
    setTimeout(() => {
      button.textContent = previous;
    }, 1200);
  }
}

/** "3 minutes ago" — the product never shows a raw ISO timestamp in the main UI. */
function relativeTime(iso) {
  if (!iso) {
    return "never";
  }
  const delta = Date.now() - Date.parse(iso);
  if (!Number.isFinite(delta)) {
    return "never";
  }
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function clockTime(iso) {
  if (!iso) {
    return "";
  }
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function duration(ms) {
  if (!Number.isFinite(ms)) {
    return "";
  }
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

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
  const words = String(label ?? "").trim().split(/[\s_-]+/).filter(Boolean);
  if (!words.length) {
    return "?";
  }
  return words.slice(0, 2).map((word) => word[0].toUpperCase()).join("");
}

function isCustomProvider(provider) {
  return !BUILTIN_ORDER.includes(provider);
}

function authFlow(provider) {
  return authFlowsMeta[provider] ?? {};
}

function authButtonLabel(provider) {
  return authFlow(provider).label ?? "Sign in";
}

// ---------------------------------------------------------------- data load

async function loadConfig() {
  const response = await apiFetch("/api/config");
  config = await response.json();
  return config;
}

async function loadOverview() {
  const response = await apiFetch("/api/overview");
  if (!response.ok) {
    return null;
  }
  overview = await response.json();
  return overview;
}

async function loadSettings() {
  const response = await apiFetch("/api/settings");
  if (!response.ok) {
    return null;
  }
  settings = await response.json();
  return settings;
}

// ---------------------------------------------------------------- 1. Connection

function renderConnection() {
  const connection = overview?.connection ?? {};
  els.baseUrl.textContent = connection.baseUrl ?? "";
  els.modelName.textContent = connection.exposedModel ?? "";
  els.apiKeyValue.textContent = connection.apiKeyConfigured ? connection.apiKey : "not set";

  const health = overview?.health ?? { state: "unknown", summary: "" };
  els.serviceHealth.className = `service-health ${health.state}`;
  const labels = {
    ready: "All good",
    degraded: "Partly available",
    needs_attention: "Needs attention",
    setup_required: "Setup required"
  };
  els.serviceHealth.textContent = `${labels[health.state] ?? health.state} — ${health.summary}`;
}

// ---------------------------------------------------------------- 2. Providers

const PROVIDER_STATUS_TEXT = {
  ready: "Ready",
  needs_attention: "Needs attention",
  usage_limited: "Usage limit reached",
  disabled: "Disabled"
};

/**
 * One card per provider. Deliberately has no model selector: the model is
 * chosen per request from the eligible catalog, so a dropdown here could only
 * ever misrepresent what happens. It reports the model that actually ran last
 * instead, and surfaces catalog counts only when the provider has a problem.
 */
function renderProviders() {
  const cards = overview?.providers ?? [];
  // Re-rendering would tear down an open sign-in panel mid-flow.
  if (authInProgress.size) {
    patchProviderStatuses(cards);
    return;
  }

  els.providers.innerHTML = cards
    .map((card) => {
      const avatar = providerAvatar(card.provider, config?.providers?.[card.provider]);
      // Full-height avatar column, clickable to change the image. Deliberately
      // not `loading="lazy"`: these are a handful of small above-the-fold
      // images, and deferring them only produces empty avatar columns on first
      // paint and in screenshots.
      const avatarHtml = `
        <button type="button" class="provider-avatar" data-avatar="${escapeAttr(card.provider)}" title="Change avatar for ${escapeAttr(card.label)}">
          ${
            avatar
              ? `<img class="provider-avatar-image" src="${escapeAttr(avatar)}" alt="${escapeAttr(card.label)}" />`
              : `<span class="provider-avatar-initials">${escapeHtml(providerInitials(card.label))}</span>`
          }
          <span class="provider-avatar-hint">Change</span>
        </button>`;

      const facts = [];
      if (card.enabled) {
        facts.push(
          `<div class="provider-fact"><span>${card.modelsAvailable} model${card.modelsAvailable === 1 ? "" : "s"} available</span></div>`
        );
        if (card.lastUsed?.model) {
          facts.push(
            `<div class="provider-fact"><span>Last used: ${escapeHtml(card.lastUsed.model)} · ${escapeHtml(relativeTime(card.lastUsed.at))}</span></div>`
          );
        } else {
          facts.push(`<div class="provider-fact muted"><span>Not used yet</span></div>`);
        }
      }
      if (card.attention) {
        facts.push(`<div class="provider-fact attention"><span>${escapeHtml(card.attention)}</span></div>`);
      }

      const actions = [];
      if (card.type !== "http") {
        actions.push(
          `<button type="button" class="btn ghost sm" data-auth="${escapeAttr(card.provider)}">${escapeHtml(authButtonLabel(card.provider))}</button>`
        );
      } else {
        actions.push(`<button type="button" class="btn ghost sm" data-test="${escapeAttr(card.provider)}">Test</button>`);
      }
      actions.push(`<button type="button" class="btn ghost sm" data-refresh="${escapeAttr(card.provider)}">Refresh</button>`);
      actions.push(`<button type="button" class="btn ghost sm" data-edit="${escapeAttr(card.provider)}">Edit provider</button>`);
      if (isCustomProvider(card.provider)) {
        actions.push(`<button type="button" class="btn ghost sm danger-text" data-remove="${escapeAttr(card.provider)}">Remove</button>`);
      }

      return `
        <article class="provider-card status-${escapeAttr(card.status)}" data-provider-card="${escapeAttr(card.provider)}">
          ${avatarHtml}
          <div class="provider-body">
            <div class="provider-top">
              <div class="provider-meta">
                <h3>${escapeHtml(card.label)}</h3>
                <span class="provider-state-text" data-status="${escapeAttr(card.provider)}">${escapeHtml(PROVIDER_STATUS_TEXT[card.status] ?? card.status)}</span>
              </div>
            </div>
            <div class="toggle-row">
              <span class="toggle-label">Enabled</span>
              <label class="toggle">
                <input type="checkbox" data-enabled="${escapeAttr(card.provider)}" ${card.enabled ? "checked" : ""} />
                <span class="toggle-slider"></span>
              </label>
            </div>
            <div class="provider-facts">${facts.join("")}</div>
            <div class="auth-panel" data-auth-panel="${escapeAttr(card.provider)}" hidden></div>
            <div class="provider-actions">${actions.join("")}</div>
          </div>
        </article>
      `;
    })
    .join("");

  bindProviderEvents();
  for (const provider of authInProgress) {
    paintAuthPanel(provider);
  }
}

/** Status-only refresh, used while a sign-in panel is open. */
function patchProviderStatuses(cards) {
  for (const card of cards) {
    const node = document.querySelector(`[data-status="${card.provider}"]`);
    if (node) {
      node.textContent = PROVIDER_STATUS_TEXT[card.status] ?? card.status;
    }
  }
}

function bindProviderEvents() {
  els.providers.querySelectorAll("[data-enabled]").forEach((input) => {
    input.addEventListener("change", () => toggleProvider(input.dataset.enabled, input.checked));
  });
  els.providers.querySelectorAll("[data-auth]").forEach((button) => {
    button.addEventListener("click", () => startAuth(button.dataset.auth, button));
  });
  els.providers.querySelectorAll("[data-test]").forEach((button) => {
    button.addEventListener("click", () => testProvider(button.dataset.test, button));
  });
  els.providers.querySelectorAll("[data-refresh]").forEach((button) => {
    button.addEventListener("click", () => refreshProviderCatalog(button.dataset.refresh, button));
  });
  els.providers.querySelectorAll("[data-edit]").forEach((button) => {
    button.addEventListener("click", () => openProviderEdit(button.dataset.edit));
  });
  els.providers.querySelectorAll("[data-avatar]").forEach((button) => {
    button.addEventListener("click", () => openAvatarPicker(button.dataset.avatar));
  });
  els.providers.querySelectorAll("[data-remove]").forEach((button) => {
    button.addEventListener("click", () => removeProvider(button.dataset.remove));
  });
}

/** Immediate action — enabling a provider persists at once and reports the result. */
async function toggleProvider(provider, enabled) {
  if (!config?.providers?.[provider]) {
    return;
  }
  config.providers[provider].enabled = enabled;
  const ok = await saveProviders();
  flashNotice(ok ? `${provider} ${enabled ? "enabled" : "disabled"}` : `Could not update ${provider}`, {
    type: ok ? "success" : "error"
  });
  await refreshOverview();
}

async function saveProviders() {
  try {
    const response = await apiFetch("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config)
    });
    if (!response.ok) {
      return false;
    }
    config = await response.json();
    return true;
  } catch {
    return false;
  }
}

async function testProvider(provider, button) {
  button.disabled = true;
  const previous = button.textContent;
  button.textContent = "Testing…";
  try {
    const response = await apiFetch("/api/status?force=1&quiet=0");
    const body = await response.json();
    const entry = (body.statuses ?? []).find((s) => s.provider === provider);
    flashNotice(entry?.ok ? `${provider} is reachable` : `${provider} is not reachable`, {
      type: entry?.ok ? "success" : "error",
      ms: 3500
    });
    await refreshOverview();
  } catch {
    flashNotice(`Could not test ${provider}`, { type: "error" });
  } finally {
    button.disabled = false;
    button.textContent = previous;
  }
}

async function refreshProviderCatalog(provider, button) {
  button.disabled = true;
  const previous = button.textContent;
  button.textContent = "Refreshing…";
  try {
    const response = await apiFetch(`/api/model-catalog/providers/${encodeURIComponent(provider)}/refresh`, { method: "POST" });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.error?.message ?? "Refresh failed");
    }
    flashNotice(`${provider} models refreshed`);
    await refreshOverview();
  } catch (error) {
    flashNotice(error.message || `Could not refresh ${provider}`, { type: "error", ms: 4000 });
  } finally {
    button.disabled = false;
    button.textContent = previous;
  }
}

// ---------------------------------------------------------------- 3. Automatic Routing

/**
 * Compact status card. Says that routing is active, what preference is in
 * effect, and what actually happened — not how the router works internally.
 */
function renderRouting() {
  const routing = overview?.routing ?? {};
  els.routingState.className = `routing-state ${routing.active ? "active" : "inactive"}`;
  els.routingState.textContent = routing.active ? "Active" : "Unavailable";

  const rows = [];
  rows.push(["Routing priority", escapeHtml(routing.priorityLabel ?? "Balanced")]);

  if (routing.latestRoute) {
    rows.push([
      "Latest successful route",
      `${escapeHtml(routing.latestRoute.provider ?? "")} · ${escapeHtml(routing.latestRoute.model ?? "")} <span class="muted">(${escapeHtml(duration(routing.latestRoute.durationMs))}, ${escapeHtml(relativeTime(routing.latestRoute.at))})</span>`
    ]);
  } else {
    rows.push(["Latest successful route", '<span class="muted">No requests yet</span>']);
  }

  if (routing.latestRecovery) {
    rows.push([
      "Latest fallback recovery",
      `${escapeHtml(routing.latestRecovery.provider ?? "")} · ${escapeHtml(routing.latestRecovery.model ?? "")} <span class="muted">after ${escapeHtml(routing.latestRecovery.reason ?? "a failure")}</span>`
    ]);
  }

  rows.push([
    "Available providers",
    routing.availableProviders?.length
      ? routing.availableProviders.map((p) => escapeHtml(p.label)).join(", ")
      : '<span class="muted">None ready</span>'
  ]);

  els.routingFacts.innerHTML = rows.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${value}</dd>`).join("");

  els.routingWarnings.innerHTML = (routing.warnings ?? [])
    .map((warning) => `<p class="routing-warning">${escapeHtml(warning)}</p>`)
    .join("");
}

// ---------------------------------------------------------------- 4. Recent Activity

/**
 * Understandable request events. The raw process log is Diagnostics-only —
 * this list answers "did my requests work, and what served them".
 */
function renderActivity(events = overview?.activity ?? []) {
  if (!events.length) {
    els.activityList.innerHTML = '<li class="activity-empty">No requests yet. Point your client at the base URL above.</li>';
    return;
  }
  els.activityList.innerHTML = events
    .map((event) => {
      const time = clockTime(event.at);
      if (!event.success) {
        return `
          <li class="activity-item failed">
            <span class="activity-time">${escapeHtml(time)}</span>
            <span class="activity-body">
              <strong>Request failed</strong>
              <span class="activity-detail">${escapeHtml(event.failureReason ?? "No provider could complete it")}</span>
            </span>
          </li>`;
      }
      const recovery = event.fallback && event.recoveredFromReason
        ? `<span class="activity-detail">Recovered after ${escapeHtml(event.recoveredFromReason)}</span>`
        : "";
      return `
        <li class="activity-item succeeded">
          <span class="activity-time">${escapeHtml(time)}</span>
          <span class="activity-body">
            <strong>${escapeHtml(event.provider ?? "")} / ${escapeHtml(event.model ?? "")}</strong>
            <span class="activity-detail">Succeeded in ${escapeHtml(duration(event.durationMs))}</span>
            ${recovery}
          </span>
        </li>`;
    })
    .join("");
}

async function refreshActivity() {
  const response = await apiFetch("/api/activity?limit=20");
  if (!response.ok) {
    return;
  }
  const body = await response.json();
  renderActivity(body.activity ?? []);
}

// ---------------------------------------------------------------- Model Ranking

/**
 * Every model PARAGON can reach, its validation status, and the live ranking
 * with the factors behind it — one table rather than the separate catalog and
 * routing panels it replaces.
 *
 * The ranking is real: the server computes it with the same call the request
 * path uses. A rank is only meaningful relative to a kind of work, which is why
 * the controls state what it was ranked for rather than implying a single
 * absolute ordering.
 */
let rankingLoaded = false;

const STATE_LABELS = {
  validated: "Validated",
  exposed: "Offered",
  stale: "Needs re-check",
  rejected: "Rejected",
  unavailable: "Unavailable",
  retired: "Retired",
  unknown: "Unvalidated",
  quota_blocked: "Usage limit",
  authentication_blocked: "Sign-in needed",
  entitlement_blocked: "Plan upgrade needed",
  configuration_blocked: "Misconfigured",
  provider_offline: "Provider offline",
  pending_assessment: "Not discovered yet"
};

const THINKING_LABELS = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Very high",
  max: "Maximum",
  unknown: "Not stated"
};

/** "Aug 12" / "14:30" — a usage limit is only actionable with its reset. */
function formatResetInstant(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "soon";
  }
  return date.getTime() - Date.now() < 24 * 3600000
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** Compact evidence label — measured beats assumed, and the difference matters. */
function evidenceLabel(row) {
  const share = row.measuredEvidenceShare;
  if (share == null) return '<span class="muted">—</span>';
  const pct = Math.round(share * 100);
  const cls = pct >= 60 ? "ok" : pct >= 30 ? "warn" : "muted";
  const samples = row.telemetry?.sampleCount ?? 0;
  return `<span class="${cls}">${pct}% measured</span><span class="cell-sub">${samples} sample${samples === 1 ? "" : "s"}</span>`;
}

function costCell(row) {
  const cost = row.cost;
  if (!cost) return '<span class="muted">—</span>';
  const parts = [];
  if (cost.monetary != null) {
    const value = cost.monetary < 0.01 ? cost.monetary.toFixed(5) : cost.monetary.toFixed(3);
    parts.push(cost.billingUnit?.startsWith("USD") ? `$${value}` : `${value} ${cost.billingUnit ?? "published units"}`);
  } else if (cost.unpricedMetered) {
    parts.push("not eligible: no published price");
  }
  const sub = cost.pricingAvailable
    ? `${cost.monetaryConfidence} confidence${cost.pricingAsOf ? ` · as of ${cost.pricingAsOf}` : ""}`
    : "excluded until a dated published price is available";
  return `<strong>${escapeHtml(parts[0] ?? "—")}</strong><span class="cell-sub">${escapeHtml(sub)}</span>`;
}

function reasoningCell(row) {
  const cost = row.cost;
  if (!cost || cost.expectedReasoningTokens == null) {
    return '<span class="muted">not reported</span>';
  }
  const range = cost.reasoningTokenRange;
  const source =
    cost.reasoningEstimateSource === "provider_reported_usage"
      ? "measured"
      : cost.reasoningEstimateSource === "measured_history"
        ? "from history"
        : cost.reasoningAssumedConservative
          ? "effort not stated — assumed"
          : "estimated";
  return `${cost.expectedReasoningTokens.toLocaleString()} tok<span class="cell-sub">${escapeHtml(source)}${
    range ? ` · ${range.min.toLocaleString()}–${range.max.toLocaleString()}` : ""
  }</span>`;
}

function qualityCell(row) {
  if (!row.quality) return '<span class="muted">—</span>';
  const pct = Math.round(row.quality.value * 100);
  const sourceLabels = {
    measured_outcomes: "from real outcomes",
    benchmark_exact: "benchmarked",
    benchmark_canonical_base: "benchmarked (base model)",
    task_profile_prior: "estimated"
  };
  return `<strong>${pct}</strong><span class="cell-sub">${escapeHtml(sourceLabels[row.quality.source] ?? row.quality.source)}</span>`;
}

function speedCell(row) {
  if (!row.latency) return '<span class="muted">—</span>';
  if (row.latency.measuredP95Ms != null) {
    return `${(row.latency.measuredP95Ms / 1000).toFixed(1)}s<span class="cell-sub">measured p95</span>`;
  }
  const mode = row.speedMode && row.speedMode !== "standard" && row.speedMode !== "unknown" ? row.speedMode : "estimated";
  return `<span class="muted">—</span><span class="cell-sub">${escapeHtml(mode)}</span>`;
}

function renderRanking(data) {
  const filter = els.rankingFilter.value;
  const rows = data.rows.filter((r) => (filter === "all" ? true : filter === "excluded" ? !r.routable : r.routable));

  els.rankingSummary.textContent = `${data.totals.routable} available · ${data.totals.models} known`;
  els.rankingNote.textContent =
    `Ranked for ${data.rankedFor.workType} work of ${data.rankedFor.complexity} complexity at ` +
    `${data.rankedFor.estimatedInputTokens.toLocaleString()} tokens, with priority ${data.priority.label}. ` +
    `Order and scores change with the kind of work — this is the same calculation the router runs for a real request.`;

  if (!rows.length) {
    els.rankingRows.innerHTML = '<tr><td colspan="12" class="ranking-empty">Nothing to show for this filter.</td></tr>';
    return;
  }

  els.rankingRows.innerHTML = rows
    .map((row) => {
      const stateClass = row.validated ? "ok" : row.routable ? "warn" : "muted";
      const stateLabel = STATE_LABELS[row.state] ?? row.state;

      if (!row.routable) {
        // A usage limit is temporary, so say when the model comes back rather
        // than only that it is gone. It re-enters the ranking on its own once
        // that instant passes — no restart, no manual step.
        const reason = row.availableAgainAt
          ? `${row.excludedDetail ?? "usage limit reached"} — available again ${escapeHtml(formatResetInstant(row.availableAgainAt))}`
          : (row.excludedDetail ?? row.excludedBecause ?? "not available");
        return `<tr class="excluded">
          <td class="muted">—</td>
          <td>${escapeHtml(row.providerLabel)}</td>
          <td><code>${escapeHtml(row.model ?? "—")}</code></td>
          <td><span class="${stateClass}">${escapeHtml(stateLabel)}</span></td>
          <td colspan="7" class="ranking-reason">${escapeHtml(reason)}</td>
          <td class="muted">—</td>
        </tr>`;
      }

      const planned = row.attemptOrder ? `<span class="ranking-planned" title="In the current attempt plan">plan ${row.attemptOrder}</span>` : "";
      return `<tr>
        <td class="ranking-rank">${row.rank}${planned}</td>
        <td>${escapeHtml(row.providerLabel)}</td>
        <td><code>${escapeHtml(row.model)}</code>${
          row.canonicalModel && row.canonicalModel !== row.model
            ? `<span class="cell-sub">base: ${escapeHtml(row.canonicalModel)}</span>`
            : ""
        }</td>
        <td><span class="${stateClass}">${escapeHtml(stateLabel)}</span></td>
        <td>${escapeHtml(THINKING_LABELS[row.reasoningEffort] ?? row.reasoningEffort ?? "—")}</td>
        <td>${row.contextWindow ? `${Math.round(row.contextWindow / 1000)}k` : '<span class="muted">unknown</span>'}</td>
        <td>${qualityCell(row)}</td>
        <td>${costCell(row)}</td>
        <td>${reasoningCell(row)}</td>
        <td>${speedCell(row)}</td>
        <td>${evidenceLabel(row)}</td>
        <td class="ranking-score"><strong>${row.expectedUtility.toFixed(1)}</strong></td>
      </tr>`;
    })
    .join("");
}

async function loadRanking() {
  els.rankingNote.textContent = "Calculating…";
  const params = new URLSearchParams({
    workType: els.rankingWorktype.value,
    complexity: els.rankingComplexity.value,
    tokens: els.rankingTokens.value
  });
  try {
    const response = await apiFetch(`/api/models/ranking?${params}`);
    if (!response.ok) {
      throw new Error("Could not load the model ranking");
    }
    renderRanking(await response.json());
    rankingLoaded = true;
  } catch (error) {
    els.rankingNote.textContent = error.message;
  }
}

function toggleRanking() {
  const expanded = els.toggleRanking.getAttribute("aria-expanded") === "true";
  els.toggleRanking.setAttribute("aria-expanded", String(!expanded));
  els.rankingBody.hidden = expanded;
  // Loaded on first expand: ranking every catalog model is real work, and the
  // everyday page should not pay for it when the panel is closed.
  if (!expanded && !rankingLoaded) {
    loadRanking();
  }
}

// ---------------------------------------------------------------- Settings

function renderSettings() {
  if (!settings) {
    return;
  }
  els.settingExposedModel.value = settings.server.exposedModel ?? "";
  els.settingApiKey.value = "";
  els.settingApiKey.placeholder = settings.server.apiKeyConfigured ? "unchanged" : "not set";
  els.settingBaseUrl.value = settings.server.cursorBaseUrl ?? "";
  els.settingTailscaleHost.value = settings.server.tailscaleHost ?? "";
  els.settingServePort.value = settings.server.tailscaleServePort ?? "";
  els.settingFunnelPort.value = settings.server.tailscaleFunnelPort ?? "";
  els.settingRetentionDays.value = settings.data.activityRetentionDays ?? 30;

  els.priorityPicker.querySelectorAll(".priority-option").forEach((node) => node.remove());
  for (const option of settings.routing.options ?? []) {
    const wrapper = document.createElement("label");
    wrapper.className = "priority-option";
    wrapper.innerHTML = `
      <input type="radio" name="routing-priority" value="${escapeAttr(option.value)}" ${option.value === settings.routing.priority ? "checked" : ""} />
      <span class="priority-body">
        <strong>${escapeHtml(option.label)}</strong>
        <span class="priority-summary">${escapeHtml(option.summary)}</span>
      </span>`;
    els.priorityPicker.appendChild(wrapper);
  }

  els.providerPreferencePoints.querySelectorAll(".provider-preference-row").forEach((node) => node.remove());
  for (const [provider, points] of Object.entries(settings.routing.providerPreferencePoints ?? {})) {
    const row = document.createElement("label");
    row.className = "field provider-preference-row";
    row.innerHTML = `
      <span class="field-label">${escapeHtml(provider)}</span>
      <input type="number" min="-100" max="100" step="0.1" data-provider-preference="${escapeAttr(provider)}" value="${escapeAttr(points)}" />`;
    els.providerPreferencePoints.appendChild(row);
  }
  els.settingArtificialAnalysisKey.value = "";
  els.settingArtificialAnalysisKey.placeholder = settings.integrations?.artificialAnalysisApiKeyConfigured ? "unchanged" : "not set";
  els.settingOpenRouterKey.value = "";
  els.settingOpenRouterKey.placeholder = settings.integrations?.openrouterApiKeyConfigured ? "unchanged" : "not set";
  const aa = settings.integrations?.artificialAnalysis ?? {};
  els.artificialAnalysisStatus.textContent = `Status: ${aa.connected ? "Connected" : aa.configured ? "Not connected" : "not configured"}${aa.tier ? ` · Tier: ${aa.tier}` : ""}${aa.modelsLoaded != null ? ` · Models imported: ${aa.modelsLoaded}` : ""}`;
}

function openSettings() {
  els.settingsStatus.textContent = "";
  els.settingsStatus.className = "settings-save-note";
  renderSettings();
  els.settingsDialog.showModal();
}

/** The one general save in the product. */
async function saveSettings() {
  els.saveSettings.disabled = true;
  els.settingsStatus.textContent = "Saving…";
  els.settingsStatus.className = "settings-save-note";

  const payload = {
    server: {
      exposedModel: els.settingExposedModel.value.trim(),
      cursorBaseUrl: els.settingBaseUrl.value.trim(),
      tailscaleHost: els.settingTailscaleHost.value.trim(),
      tailscaleServePort: Number(els.settingServePort.value),
      tailscaleFunnelPort: Number(els.settingFunnelPort.value)
    },
    routing: {
      priority: els.priorityPicker.querySelector('input[name="routing-priority"]:checked')?.value ?? settings.routing.priority,
      providerPreferencePoints: Object.fromEntries(
        [...els.providerPreferencePoints.querySelectorAll("[data-provider-preference]")].map((input) => [input.dataset.providerPreference, Number(input.value)])
      )
    },
    data: { activityRetentionDays: Number(els.settingRetentionDays.value) }
  };
  // Only send the API key when the operator actually typed a new one, so
  // saving other categories can never blank an existing credential.
  const apiKey = els.settingApiKey.value.trim();
  if (apiKey) {
    payload.server.apiKey = apiKey;
  }
  const artificialAnalysisApiKey = els.settingArtificialAnalysisKey.value.trim();
  const openRouterApiKey = els.settingOpenRouterKey.value.trim();
  if (artificialAnalysisApiKey || openRouterApiKey) payload.integrations = { ...(openRouterApiKey ? { openrouterApiKey: openRouterApiKey } : {}), ...(artificialAnalysisApiKey ? { artificialAnalysisApiKey } : {}) };

  try {
    const response = await apiFetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.error?.details?.join("; ") || body.error?.message || "Could not save settings");
    }
    settings = body.settings;
    if (apiKey) {
      setStoredApiKey(apiKey);
    }
    els.settingsStatus.textContent = "Saved.";
    els.settingsStatus.className = "settings-save-note ok";
    flashNotice("Settings saved");
    await loadConfig();
    await refreshOverview();
    renderSettings();
  } catch (error) {
    els.settingsStatus.textContent = error.message;
    els.settingsStatus.className = "settings-save-note error";
  } finally {
    els.saveSettings.disabled = false;
  }
}

async function clearActivityHistory() {
  els.clearActivity.disabled = true;
  try {
    const response = await apiFetch("/api/activity/clear", { method: "POST" });
    if (!response.ok) {
      throw new Error("Could not clear activity");
    }
    els.clearActivityStatus.textContent = "Activity history cleared.";
    await refreshOverview();
  } catch (error) {
    els.clearActivityStatus.textContent = error.message;
  } finally {
    els.clearActivity.disabled = false;
  }
}

async function artificialAnalysisAction(action) {
  const response = await apiFetch(`/api/integrations/artificial-analysis/${action}`, { method: "POST" });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message || body.error || "Artificial Analysis request failed");
  settings.integrations = { ...(settings.integrations ?? {}), artificialAnalysis: body };
  renderSettings();
}

// ---------------------------------------------------------------- Diagnostics

function switchDiagTab(tab) {
  els.diagTabs.querySelectorAll(".diag-tab").forEach((node) => {
    node.classList.toggle("is-active", node.dataset.tab === tab);
  });
  els.diagnosticsDialog.querySelectorAll(".diag-panel").forEach((node) => {
    node.classList.toggle("is-active", node.dataset.panel === tab);
  });
  if (tab === "models") loadDiagModels();
  if (tab === "routing") loadDiagRouting();
  if (tab === "requests") loadDiagRequests();
  if (tab === "system") loadDiagSystem();
}

function openDiagnostics() {
  els.settingsDialog.close();
  els.diagnosticsDialog.showModal();
  switchDiagTab("models");
}

function factRows(container, rows) {
  container.innerHTML = rows.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${value}</dd>`).join("");
}

async function loadDiagModels() {
  els.diagModelsNote.textContent = "Loading…";
  const response = await apiFetch("/api/diagnostics/models");
  if (!response.ok) {
    els.diagModelsNote.textContent = "Could not load model diagnostics.";
    return;
  }
  const body = await response.json();
  const registry = body.registry ?? [];
  els.diagModelsNote.textContent = `${registry.length} registry entries · benchmarks ${
    body.benchmarks.enabled
      ? body.benchmarks.applied
        ? "applied"
        : `withheld (${body.benchmarks.stale ? "stale" : "unavailable"})`
      : "not configured"
  }`;
  els.diagModelsBody.innerHTML = registry
    .map(
      (entry) => `
      <tr>
        <td>${escapeHtml(entry.provider)}</td>
        <td><code>${escapeHtml(entry.model ?? "")}</code></td>
        <td>${escapeHtml(entry.modelState ?? "unknown")}</td>
        <td>${entry.automaticEligibility ? "yes" : "no"}</td>
        <td>${entry.contextWindow ? entry.contextWindow.toLocaleString() : "unknown"}</td>
        <td>${escapeHtml(entry.externalBenchmark?.matchMethod ?? "none")}</td>
        <td>${escapeHtml(entry.capabilities?.chatCompletions === false ? "no chat" : "chat")}</td>
        <td><button type="button" class="btn ghost sm" data-inspect="${escapeAttr(entry.provider)}::${escapeAttr(entry.model ?? "")}">Inspect</button></td>
      </tr>`
    )
    .join("");
  els.diagModelsBody.querySelectorAll("[data-inspect]").forEach((button) => {
    button.addEventListener("click", () => {
      const [provider, model] = button.dataset.inspect.split("::");
      const entry = registry.find((e) => e.provider === provider && (e.model ?? "") === model);
      if (!entry) {
        return;
      }
      els.modelInspectTitle.textContent = `${provider} / ${model}`;
      factRows(
        els.modelInspectFacts,
        Object.entries(entry).map(([key, value]) => [key, `<code>${escapeHtml(JSON.stringify(value))}</code>`])
      );
      els.modelInspectDialog.showModal();
    });
  });
}

async function loadDiagRouting() {
  els.diagRoutingNote.textContent = "Loading…";
  const response = await apiFetch("/api/diagnostics/routing");
  if (!response.ok) {
    els.diagRoutingNote.textContent = "Could not load routing diagnostics.";
    return;
  }
  const body = await response.json();
  els.diagRoutingNote.textContent = `${body.telemetryEntryCount} telemetry buckets`;
  factRows(els.diagRoutingFacts, [
    ["Selection method", escapeHtml(body.engine.selectionMethod)],
    ["Routing computations per request", String(body.engine.enginesRunningPerRequest)],
    ["Routing priority", `${escapeHtml(body.priority.label)} — ${escapeHtml(body.priority.summary)}`],
    ["Resolved weights (read-only)", `<code>${escapeHtml(JSON.stringify(body.priority.resolvedWeights))}</code>`],
    ["Maximum attempts", String(body.bounds.maximumAttempts)],
    ["Usage-limited providers", `<code>${escapeHtml(JSON.stringify(body.quotaState))}</code>`]
  ]);

  const plan = body.latestPlan;
  els.diagPlanList.innerHTML = plan
    ? plan.plan
        .map(
          (entry) =>
            `<li>${entry.order}. <strong>${escapeHtml(entry.provider)}</strong> / <code>${escapeHtml(entry.model ?? "")}</code>${
              entry.alternateForProvider ? " <em>(same-provider alternate)</em>" : ""
            }</li>`
        )
        .join("")
    : "<li>No request observed since startup.</li>";
}

async function runRoutingPreview() {
  els.diagRunPreview.disabled = true;
  els.diagRoutingNote.textContent = "Computing…";
  try {
    const response = await apiFetch("/api/diagnostics/routing/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: els.diagPreviewPrompt.value })
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.error?.message ?? "Preview failed");
    }
    els.diagRoutingNote.textContent = `${body.eligibleCount} eligible of ${body.candidateCount} candidates · confidence ${body.confidence?.level ?? "?"}`;
    els.diagCandidatesBody.innerHTML = (body.ranked ?? [])
      .map((candidate, index) => {
        if (candidate.excluded) {
          return `<tr class="excluded">
            <td></td><td>${escapeHtml(candidate.provider)}</td><td><code>${escapeHtml(candidate.providerModelId ?? "")}</code></td>
            <td>${escapeHtml(candidate.reasoningEffort ?? "")}</td><td colspan="6"></td>
            <td>${escapeHtml(candidate.reasonCode)}${candidate.detail ? ` — ${escapeHtml(candidate.detail)}` : ""}</td>
          </tr>`;
        }
        const c = candidate.components ?? {};
        return `<tr>
          <td>${candidate.rank ?? index + 1}</td>
          <td>${escapeHtml(candidate.provider)}</td>
          <td><code>${escapeHtml(candidate.providerModelId ?? "")}</code></td>
          <td>${escapeHtml(candidate.reasoningEffort ?? "")}</td>
          <td><strong>${Number(candidate.expectedUtility ?? 0).toFixed(2)}</strong></td>
          <td>${Number(c.qualityTerm ?? 0).toFixed(2)} <span class="muted">(${escapeHtml(c.qualitySource ?? "")})</span></td>
          <td>${Number(c.costTerm ?? 0).toFixed(2)}</td>
          <td>${Number(c.latencyTerm ?? 0).toFixed(2)}</td>
          <td>${Number(c.uncertaintyTerm ?? 0).toFixed(2)}</td>
          <td>${Math.round((candidate.measuredEvidenceShare ?? 0) * 100)}% measured</td>
          <td></td>
        </tr>`;
      })
      .join("");
  } catch (error) {
    els.diagRoutingNote.textContent = error.message;
  } finally {
    els.diagRunPreview.disabled = false;
  }
}

async function loadDiagRequests() {
  els.diagRequestsNote.textContent = "Loading…";
  const response = await apiFetch("/api/diagnostics/requests");
  if (!response.ok) {
    els.diagRequestsNote.textContent = "Could not load request diagnostics.";
    return;
  }
  const body = await response.json();
  els.diagRequestsNote.textContent = `${(body.activity ?? []).length} recorded requests`;
  els.diagRequestsBody.innerHTML = (body.activity ?? [])
    .map(
      (event) => `<tr>
        <td>${escapeHtml(new Date(event.at).toLocaleString())}</td>
        <td>${event.success ? "success" : "failed"}</td>
        <td>${escapeHtml(event.provider ?? "")}</td>
        <td><code>${escapeHtml(event.model ?? "")}</code></td>
        <td>${escapeHtml(duration(event.durationMs))}</td>
        <td>${event.fallback ? escapeHtml(event.recoveredFrom ?? "yes") : "no"}</td>
        <td>${escapeHtml(event.failureReason ?? event.recoveredFromReason ?? "")}</td>
      </tr>`
    )
    .join("");

  const entries = Object.entries(body.telemetry?.entries ?? {});
  els.diagUsageBody.innerHTML = entries
    .map(
      ([key, entry]) => `<tr>
        <td><code>${escapeHtml(key)}</code></td>
        <td>${entry.sampleCount ?? 0}</td>
        <td>${entry.requestCount ? Math.round((entry.successCount / entry.requestCount) * 100) : 0}%</td>
        <td>${fmtTokens(entry.observedInputTokens)}</td>
        <td>${fmtTokens(entry.observedVisibleOutputTokens)}</td>
        <td>${fmtTokens(entry.observedReasoningTokens)}</td>
        <td>${entry.observedMonetaryCost != null ? `$${Number(entry.observedMonetaryCost).toFixed(4)}` : '<span class="muted">not reported</span>'}</td>
        <td>${escapeHtml(entry.usageSource ?? "unknown")}${entry.usageUnknownCount ? ` <span class="muted">(${entry.usageUnknownCount} unreported)</span>` : ""}</td>
      </tr>`
    )
    .join("");

  els.diagLogs.innerHTML = (body.logs ?? [])
    .slice(0, 100)
    .map(
      (entry) =>
        `<div class="log ${escapeAttr(entry.level ?? "info")}"><span class="log-time">${escapeHtml(clockTime(entry.at))}</span><span class="log-provider">${escapeHtml(entry.provider ?? "")}</span><span class="log-message">${escapeHtml(entry.message ?? "")}</span></div>`
    )
    .join("");
}

/** "not reported" rather than 0 — an absent measurement is not a zero measurement. */
function fmtTokens(value) {
  return value == null ? '<span class="muted">not reported</span>' : Math.round(value).toLocaleString();
}

async function loadDiagSystem() {
  els.diagSystemNote.textContent = "Loading…";
  const response = await apiFetch("/api/diagnostics/system");
  if (!response.ok) {
    els.diagSystemNote.textContent = "Could not load system diagnostics.";
    return;
  }
  const body = await response.json();
  els.diagSystemNote.textContent = "";
  factRows(els.diagSystemFacts, [
    ["Config schema version", String(body.configVersion)],
    ["Uptime", `${body.uptimeSeconds}s`],
    ["Node", escapeHtml(body.node)],
    ["Circuit states", `<code>${escapeHtml(JSON.stringify(body.circuitStates))}</code>`],
    ["Usage-limited providers", `<code>${escapeHtml(JSON.stringify(body.quotaState))}</code>`],
    ["Catalog schedule", `<code>${escapeHtml(JSON.stringify(body.catalogSchedule))}</code>`],
    ["Orchestration", `${body.orchestration.enabled ? "enabled" : "disabled"} (${escapeHtml(body.orchestration.mode)})`],
    ["Data directory", `<code>${escapeHtml(body.dataDir)}</code>`],
    ["Memory (RSS)", `${Math.round((body.memory?.rss ?? 0) / 1048576)} MB`]
  ]);
}

async function exportDiagnosticBundle() {
  const [models, routing, requests, system] = await Promise.all([
    apiFetch("/api/diagnostics/models").then((r) => r.json()).catch(() => null),
    apiFetch("/api/diagnostics/routing").then((r) => r.json()).catch(() => null),
    apiFetch("/api/diagnostics/requests").then((r) => r.json()).catch(() => null),
    apiFetch("/api/diagnostics/system").then((r) => r.json()).catch(() => null)
  ]);
  const bundle = { exportedAt: new Date().toISOString(), models, routing, requests, system };
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `paragon-diagnostics-${Date.now()}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}

// ---------------------------------------------------------------- Provider edit / add / remove

function openProviderEdit(provider) {
  providerEditTarget = provider;
  const providerConfig = config?.providers?.[provider] ?? {};
  const http = providerConfig.type === "http";
  els.providerEditTitle.textContent = `Edit ${providerConfig.label || provider}`;
  els.providerEditCommandField.hidden = http;
  els.providerEditBaseUrlField.hidden = !http;
  els.providerEditApiKeyField.hidden = !http;
  els.providerEditTest.hidden = !http;
  els.providerEditCommand.value = providerConfig.command ?? "";
  els.providerEditBaseUrl.value = providerConfig.baseUrl ?? "";
  els.providerEditApiKey.value = "";
  els.providerEditApiKey.placeholder = providerConfig.apiKey ? "unchanged" : "not set";
  els.providerEditStatus.textContent = "";
  els.providerEditStatus.className = "settings-save-note";
  els.providerEditDialog.showModal();
}

async function applyProviderEdit() {
  if (!providerEditTarget) {
    return;
  }
  const providerConfig = config.providers[providerEditTarget];
  if (providerConfig.type === "http") {
    providerConfig.baseUrl = els.providerEditBaseUrl.value.trim();
    const key = els.providerEditApiKey.value.trim();
    if (key) {
      providerConfig.apiKey = key;
    }
  } else {
    providerConfig.command = els.providerEditCommand.value.trim();
  }
  els.providerEditApply.disabled = true;
  const ok = await saveProviders();
  els.providerEditApply.disabled = false;
  if (ok) {
    els.providerEditDialog.close();
    flashNotice("Provider updated");
    await refreshOverview();
  } else {
    els.providerEditStatus.textContent = "Could not update the provider.";
    els.providerEditStatus.className = "settings-save-note error";
  }
}

function toggleNewProviderFields() {
  const http = els.newProviderType.value === "http";
  document.querySelector("#new-provider-http-fields").hidden = !http;
  document.querySelector("#new-provider-cli-fields").hidden = http;
}

function openAddProviderDialog() {
  els.addProviderForm.reset();
  newProviderAvatarDataUrl = "";
  renderNewProviderAvatarPreview();
  toggleNewProviderFields();
  els.addProviderDialog.showModal();
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

  // No `model` field: a provider never starts life with a configured-model
  // preference, and the schema no longer has one. Its models are discovered by
  // the catalog refresh the server kicks off as soon as this provider is saved.
  if (type === "http") {
    config.providers[id] = {
      type: "http",
      label,
      avatar: "",
      enabled: true,
      baseUrl: document.querySelector("#new-provider-base-url").value.trim(),
      apiKey: document.querySelector("#new-provider-api-key").value,
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
      models: [],
      timeoutMs: 300000,
      stdinMode: "prompt"
    };
  }

  // The provider must exist server-side before its avatar can be attached to
  // it, so save first and upload second.
  els.addProviderDialog.close();
  const ok = await saveProviders();
  if (!ok) {
    flashNotice("Could not add the provider", { type: "error" });
    return;
  }

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
  flashNotice(`${label || id} added`);
  await refreshOverview();
}

async function removeProvider(provider) {
  if (!confirm(`Remove "${provider}"?`)) {
    return;
  }
  delete config.providers[provider];
  // Nothing else references a provider id any more. The legacy routing
  // preference fields were removed from the schema in the v3 migration, so no
  // stale reference to this provider can survive its removal.
  const ok = await saveProviders();
  flashNotice(ok ? `${provider} removed` : `Could not remove ${provider}`, { type: ok ? "success" : "error" });
  await refreshOverview();
}

// ---------------------------------------------------------------- Avatars

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

function openAvatarPicker(provider) {
  avatarEditProvider = provider;
  avatarDraftDataUrl = "";
  if (els.avatarFile) {
    els.avatarFile.value = "";
  }
  const current = providerAvatar(provider, config?.providers?.[provider]);
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
    flashNotice("Avatar updated");
    await refreshOverview();
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
    await refreshOverview();
  } catch (error) {
    els.avatarStatus.textContent = error.message || "Reset failed";
    els.avatarStatus.className = "settings-save-note error";
  } finally {
    els.avatarReset.disabled = false;
  }
}

// ---------------------------------------------------------------- Auth flows

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
  authPanelState.set(provider, { session: { ...prev.session, ...session }, codeDraft: prev.codeDraft });
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
    panel.innerHTML = `<p class="auth-status-msg ok">${escapeHtml(session.message || "Already signed in.")}</p>`;
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
      </div>`);
  }
  if (session.deviceCode) {
    parts.push(`
      <p class="auth-device-code">
        Device code: <strong>${escapeHtml(session.deviceCode)}</strong>
        <button type="button" class="btn ghost sm auth-copy" data-copy="${escapeAttr(session.deviceCode)}">Copy code</button>
      </p>`);
  }

  const needsCode = session.mode === "oauth-code" || flow.mode === "oauth-code";
  if (needsCode) {
    parts.push(`
      <div class="auth-code-row">
        <input type="text" placeholder="Paste authorization code" data-auth-code="${escapeAttr(provider)}" autocomplete="off" />
        <button type="button" class="btn secondary sm" data-auth-code-submit="${escapeAttr(provider)}">Submit code</button>
      </div>
      <p class="auth-hint auth-code-note">After the browser step, copy the code shown there and paste it here. This field stays open until you submit.</p>`);
  }

  if (!parts.length) {
    parts.push(`<p class="auth-hint">Waiting for sign-in details…</p>`);
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
  return win && !win.closed ? win : null;
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
    if (session.url && authWindow && !authWindow.closed) {
      try {
        authWindow.location.href = session.url;
      } catch {
        openAuthUrl(session.url);
      }
    } else if (session.url) {
      openAuthUrl(session.url);
    }
    showAuthPanel(provider, session);
    return session;
  }
  return null;
}

async function pollAuthCompletion(provider, maxMs = 120000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, AUTH_POLL_INTERVAL_MS));
    const response = await apiFetch("/api/status?force=1");
    if (!response.ok) {
      continue;
    }
    const body = await response.json();
    const entry = (body.statuses ?? []).find((s) => s.provider === provider);
    if (entry?.ok) {
      clearAuthPanel(provider);
      flashNotice(`${provider} signed in`);
      await refreshOverview();
      return true;
    }
  }
  return false;
}

async function startAuth(provider, button) {
  button.disabled = true;
  const previous = button.textContent;
  button.textContent = "Starting…";
  const authWindow = openAuthUrl("about:blank");
  try {
    const response = await apiFetch(`/api/auth/${provider}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.error?.message ?? "Sign-in could not start");
    }
    if (body.alreadyAuthenticated) {
      authWindow?.close();
      showAuthPanel(provider, { alreadyAuthenticated: true, message: "Already signed in." });
      await refreshOverview();
      return;
    }
    showAuthPanel(provider, { mode: body.mode });
    await pollAuthSession(provider, authWindow);
    pollAuthCompletion(provider);
  } catch (error) {
    authWindow?.close();
    flashNotice(error.message || "Sign-in failed", { type: "error", ms: 4000 });
  } finally {
    button.disabled = false;
    button.textContent = previous;
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
      throw new Error(body.error?.message ?? "Code rejected");
    }
    input.value = "";
    const state = authPanelState.get(provider);
    if (state) {
      state.codeDraft = "";
    }
    flashNotice("Code submitted — finishing sign-in");
    pollAuthCompletion(provider);
  } catch (error) {
    flashNotice(error.message || "Code rejected", { type: "error", ms: 4000 });
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
  if (manual) {
    els.refreshStatus.disabled = true;
    els.refreshStatus.textContent = "Refreshing…";
  }
  try {
    // Warms the server's status cache; the resulting health lands on the
    // provider cards through the overview payload rather than being kept as a
    // second copy of provider state in the client.
    await apiFetch(`/api/status${manual ? "?force=1&quiet=0" : ""}`);
    await refreshOverview();
  } finally {
    if (manual) {
      els.refreshStatus.disabled = false;
      els.refreshStatus.textContent = "Refresh";
    }
  }
}

// ---------------------------------------------------------------- Onboarding

function clientSnippet(connection) {
  return [
    "Cursor → Settings → Models → Add custom OpenAI-compatible model",
    "",
    `Base URL:  ${connection.baseUrl ?? ""}`,
    `Model:     ${connection.exposedModel ?? ""}`,
    `API key:   ${connection.apiKey || "(set one in Settings)"}`
  ].join("\n");
}

function renderOnboarding() {
  const connection = overview?.connection ?? {};
  els.onboardingBaseUrl.textContent = connection.baseUrl ?? "";
  els.onboardingModel.textContent = connection.exposedModel ?? "";
  els.onboardingApiKey.textContent = connection.apiKeyConfigured ? connection.apiKey : "not set";
  els.onboardingSnippet.textContent = clientSnippet(connection);

  const cards = overview?.providers ?? [];
  els.onboardingProviders.innerHTML = cards
    .map((card) => {
      const ready = card.status === "ready";
      const actions =
        card.type === "http"
          ? `<button type="button" class="btn ghost sm" data-onboard-test="${escapeAttr(card.provider)}">Test</button>`
          : `<button type="button" class="btn secondary sm" data-onboard-auth="${escapeAttr(card.provider)}">${escapeHtml(authButtonLabel(card.provider))}</button>`;
      return `
        <div class="onboarding-provider ${ready ? "ready" : "pending"}">
          <span class="onboarding-provider-name">${escapeHtml(card.label)}</span>
          <span class="onboarding-provider-state">${ready ? "Ready" : escapeHtml(card.attention ?? PROVIDER_STATUS_TEXT[card.status] ?? "")}</span>
          <span class="onboarding-provider-actions">${ready ? "" : actions}</span>
        </div>`;
    })
    .join("");

  els.onboardingProviders.querySelectorAll("[data-onboard-auth]").forEach((button) => {
    button.addEventListener("click", () => startAuth(button.dataset.onboardAuth, button));
  });
  els.onboardingProviders.querySelectorAll("[data-onboard-test]").forEach((button) => {
    button.addEventListener("click", () => testProvider(button.dataset.onboardTest, button));
  });

  els.onboardingTest.disabled = !cards.some((c) => c.status === "ready");
}

/**
 * Real end-to-end proof: a genuine request through PARAGON's own public
 * OpenAI-compatible surface, using the same base URL and key the user just
 * copied. Nothing about it is simulated.
 */
async function runOnboardingTest() {
  els.onboardingTest.disabled = true;
  els.onboardingTestResult.textContent = "Sending a test request…";
  els.onboardingTestResult.className = "onboarding-test-result";
  try {
    const response = await fetch("/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${overview?.connection?.apiKey ?? getStoredApiKey()}`
      },
      body: JSON.stringify({
        model: overview?.connection?.exposedModel ?? "paragon",
        messages: [{ role: "user", content: "Reply with the single word OK." }]
      })
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.error?.message ?? `Request failed (${response.status})`);
    }
    const via = body.paragon?.provider ?? "a provider";
    els.onboardingTestResult.textContent = `Success — answered by ${via} in ${duration(body.paragon?.durationMs)}.`;
    els.onboardingTestResult.className = "onboarding-test-result ok";
    await refreshOverview();
  } catch (error) {
    els.onboardingTestResult.textContent = error.message;
    els.onboardingTestResult.className = "onboarding-test-result error";
  } finally {
    els.onboardingTest.disabled = false;
  }
}

let onboardingDismissed = false;

function renderShell() {
  const needsOnboarding = Boolean(overview?.onboarding?.required) && !onboardingDismissed;
  els.onboarding.hidden = !needsOnboarding;
  els.app.hidden = needsOnboarding;
  if (needsOnboarding) {
    renderOnboarding();
    return;
  }
  renderConnection();
  renderProviders();
  renderRouting();
  renderActivity();
}

async function refreshOverview() {
  await loadOverview();
  renderShell();
}

// ---------------------------------------------------------------- Wiring

function wire() {
  document.querySelectorAll(".copy-btn").forEach((button) => {
    button.addEventListener("click", () => {
      const target = document.getElementById(button.dataset.copy);
      copyText(target?.textContent ?? "", button);
    });
  });

  els.refreshStatus.addEventListener("click", () => refreshStatus({ manual: true }));
  els.refreshActivity.addEventListener("click", () => refreshActivity());

  els.toggleRanking.addEventListener("click", toggleRanking);
  els.refreshRanking.addEventListener("click", loadRanking);
  for (const control of [els.rankingWorktype, els.rankingComplexity, els.rankingTokens]) {
    control.addEventListener("change", loadRanking);
  }
  // Filtering is client-side; no need to recompute the ranking for it.
  els.rankingFilter.addEventListener("change", () => rankingLoaded && loadRanking());
  els.addProvider.addEventListener("click", openAddProviderDialog);
  els.openSettings.addEventListener("click", openSettings);
  els.editPriority.addEventListener("click", openSettings);

  els.saveSettings.addEventListener("click", saveSettings);
  els.settingsClose.addEventListener("click", () => els.settingsDialog.close());
  els.settingsCloseX.addEventListener("click", () => els.settingsDialog.close());
  els.clearActivity.addEventListener("click", clearActivityHistory);
  els.testArtificialAnalysis.addEventListener("click", () => artificialAnalysisAction("test").catch((e) => { els.artificialAnalysisStatus.textContent = `Status: ${e.message}`; }));
  els.refreshArtificialAnalysis.addEventListener("click", () => artificialAnalysisAction("refresh").catch((e) => { els.artificialAnalysisStatus.textContent = `Status: ${e.message}`; }));
  els.removeArtificialAnalysis.addEventListener("click", () => artificialAnalysisAction("remove").catch((e) => { els.artificialAnalysisStatus.textContent = `Status: ${e.message}`; }));
  els.removeOpenRouter.addEventListener("click", async () => {
    try {
      const response = await apiFetch("/api/integrations/openrouter/remove", { method: "POST" });
      if (!response.ok) throw new Error("Could not remove OpenRouter key");
      await loadSettings();
      renderSettings();
    } catch (error) {
      els.settingsStatus.textContent = error.message;
    }
  });
  els.openDiagnostics.addEventListener("click", openDiagnostics);

  els.diagnosticsClose.addEventListener("click", () => els.diagnosticsDialog.close());
  els.diagTabs.addEventListener("click", (event) => {
    const tab = event.target.closest(".diag-tab");
    if (tab) {
      switchDiagTab(tab.dataset.tab);
    }
  });
  els.diagRunPreview.addEventListener("click", runRoutingPreview);
  els.diagRefreshRequests.addEventListener("click", loadDiagRequests);
  els.diagRefreshSystem.addEventListener("click", loadDiagSystem);
  els.diagExport.addEventListener("click", exportDiagnosticBundle);
  els.diagRefreshCatalog.addEventListener("click", async () => {
    els.diagRefreshCatalog.disabled = true;
    els.diagModelsNote.textContent = "Refreshing every provider…";
    try {
      const response = await apiFetch("/api/model-catalog/refresh", { method: "POST" });
      const body = await response.json();
      els.diagModelsNote.textContent = response.ok ? "Refresh complete." : body.error?.message ?? "Refresh failed";
      if (response.ok) {
        await loadDiagModels();
        await refreshOverview();
      }
    } finally {
      els.diagRefreshCatalog.disabled = false;
    }
  });
  els.diagValidateAll.addEventListener("click", async () => {
    els.diagValidateAll.disabled = true;
    els.diagModelsNote.textContent = "Validating every model…";
    try {
      const response = await apiFetch("/api/model-catalog/validate-all", { method: "POST" });
      const body = await response.json();
      els.diagModelsNote.textContent = response.ok
        ? `Validated ${body.validated} of ${body.total}; ${body.stillUnvalidated} still unvalidated.`
        : body.error?.message ?? "Validation failed";
      if (response.ok) {
        await loadDiagModels();
        await refreshOverview();
      }
    } finally {
      els.diagValidateAll.disabled = false;
    }
  });
  els.modelInspectClose.addEventListener("click", () => els.modelInspectDialog.close());

  els.providerEditApply.addEventListener("click", applyProviderEdit);
  els.providerEditCancel.addEventListener("click", () => els.providerEditDialog.close());
  els.providerEditTest.addEventListener("click", () => {
    if (providerEditTarget) {
      testProvider(providerEditTarget, els.providerEditTest);
    }
  });

  els.addProviderForm.addEventListener("submit", addProvider);
  els.addProviderCancel.addEventListener("click", () => els.addProviderDialog.close());
  els.newProviderType.addEventListener("change", toggleNewProviderFields);
  els.newProviderAvatarFile.addEventListener("change", async (event) => {
    const result = await readAvatarFile(event.target.files?.[0]);
    newProviderAvatarDataUrl = result.error ? "" : result.value;
    renderNewProviderAvatarPreview(result.error ?? "");
  });

  els.avatarFile.addEventListener("change", async (event) => {
    const result = await readAvatarFile(event.target.files?.[0]);
    if (result.error) {
      avatarDraftDataUrl = "";
      els.avatarStatus.textContent = result.error;
      els.avatarStatus.className = "settings-save-note error";
      return;
    }
    avatarDraftDataUrl = result.value;
    els.avatarDialogImage.src = avatarDraftDataUrl;
    els.avatarDialogImage.hidden = false;
    els.avatarStatus.textContent = "";
    els.avatarStatus.className = "settings-save-note";
  });
  els.avatarApply.addEventListener("click", applyAvatar);
  els.avatarReset.addEventListener("click", resetAvatarToBundled);
  els.avatarCancel.addEventListener("click", () => els.avatarDialog.close());

  els.onboardingAddProvider.addEventListener("click", openAddProviderDialog);
  els.onboardingRecheck.addEventListener("click", () => refreshStatus({ manual: true }));
  els.onboardingTest.addEventListener("click", runOnboardingTest);
  els.onboardingCopySnippet.addEventListener("click", (event) =>
    copyText(els.onboardingSnippet.textContent, event.currentTarget)
  );
  els.onboardingFinish.addEventListener("click", () => {
    onboardingDismissed = true;
    renderShell();
  });
}

async function loadAuthFlows() {
  try {
    const response = await apiFetch("/api/auth/flows");
    if (!response.ok) {
      return;
    }
    const body = await response.json();
    for (const [provider, flow] of Object.entries(body.flows ?? {})) {
      authFlowsMeta[provider] = { ...authUi[provider], ...flow };
    }
  } catch {
    // Defaults in authUi are sufficient.
  }
}

async function init() {
  await loadConfig();
  await loadSettings();
  await loadAuthFlows();
  await loadOverview();
  wire();
  renderShell();
  await refreshStatus({ manual: false });
  statusRefreshTimer = setInterval(() => refreshStatus(), 30000);
  window.addEventListener("beforeunload", () => clearInterval(statusRefreshTimer));
}

init().catch((error) => {
  console.error(error);
  flashNotice(`Dashboard failed to load: ${error.message}`, { type: "error", ms: 6000 });
});
