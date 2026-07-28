const BUILTIN_ORDER = ["claude", "codex", "cursor", "gemini"];
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

const DEFAULT_PROVIDER_ICON = {
  claude: "🧠",
  codex: "⚡",
  cursor: "🖱️",
  gemini: "✨",
  http: "🌐",
  cli: "🔧",
  default: "🤖"
};

const EMOJI_PICKS = [
  "🤖", "🧠", "⚡", "✨", "🖱️", "🌐", "🔧", "🦙",
  "💬", "📝", "🔍", "📦", "🎯", "🚀", "💡", "🔮",
  "🟠", "🟢", "🔵", "🟣", "⚙️", "📡", "🛡️", "🎨",
  "🐙", "🦾", "☁️", "🏠", "🔥", "❄️", "🎭", "📊"
];

let emojiEditProvider = null;
let emojiPickDraft = "";
let newProviderIconLocked = false;

const authUi = {
  claude: { label: "Sign in", short: "Browser" },
  codex: { label: "Device login", short: "Device" },
  cursor: { label: "Sign in", short: "Browser" },
  gemini: { label: "Google sign-in", short: "OAuth" }
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
let fallbackDraft = [];

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
  fallbackViz: document.querySelector("#fallback-viz"),
  defaultProvider: document.querySelector("#default-provider"),
  addProvider: document.querySelector("#add-provider"),
  addProviderDialog: document.querySelector("#add-provider-dialog"),
  addProviderForm: document.querySelector("#add-provider-form"),
  addProviderCancel: document.querySelector("#add-provider-cancel"),
  newProviderType: document.querySelector("#new-provider-type"),
  newProviderHttpFields: document.querySelector("#new-provider-http-fields"),
  newProviderCliFields: document.querySelector("#new-provider-cli-fields"),
  newProviderIconDisplay: document.querySelector("#new-provider-icon-display"),
  newProviderIconInput: document.querySelector("#new-provider-icon-input"),
  newProviderEmojiGrid: document.querySelector("#new-provider-emoji-grid"),
  apiKeyDialog: document.querySelector("#api-key-dialog"),
  apiKeyForm: document.querySelector("#api-key-form"),
  apiKeyInput: document.querySelector("#api-key-input"),
  settingTailscaleHost: document.querySelector("#setting-tailscale-host"),
  settingServePort: document.querySelector("#setting-serve-port"),
  settingFunnelPort: document.querySelector("#setting-funnel-port"),
  settingParagonBase: document.querySelector("#setting-paragon-base"),
  settingExposedModel: document.querySelector("#setting-exposed-model"),
  settingApiKey: document.querySelector("#setting-api-key"),
  settingsPanel: document.querySelector("#settings-panel"),
  toggleSettings: document.querySelector("#toggle-settings"),
  editFallback: document.querySelector("#edit-fallback"),
  fallbackDialog: document.querySelector("#fallback-dialog"),
  fallbackOrder: document.querySelector("#fallback-order"),
  fallbackAddSelect: document.querySelector("#fallback-add-select"),
  fallbackAddBtn: document.querySelector("#fallback-add-btn"),
  fallbackCancel: document.querySelector("#fallback-cancel"),
  fallbackSave: document.querySelector("#fallback-save"),
  emojiDialog: document.querySelector("#emoji-dialog"),
  emojiGrid: document.querySelector("#emoji-grid"),
  emojiPreview: document.querySelector("#emoji-preview"),
  emojiCustom: document.querySelector("#emoji-custom"),
  emojiCancel: document.querySelector("#emoji-cancel"),
  emojiApply: document.querySelector("#emoji-apply"),
  refreshOrchestration: document.querySelector("#refresh-orchestration"),
  orchOverview: document.querySelector("#orch-overview"),
  orchContext: document.querySelector("#orch-context"),
  orchSessions: document.querySelector("#orch-sessions"),
  orchAgents: document.querySelector("#orch-agents"),
  orchProviders: document.querySelector("#orch-providers"),
  orchGovernor: document.querySelector("#orch-governor")
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

function defaultIconForProvider(provider, providerConfig) {
  if (DEFAULT_PROVIDER_ICON[provider]) {
    return DEFAULT_PROVIDER_ICON[provider];
  }
  if (providerConfig?.type === "http") {
    return DEFAULT_PROVIDER_ICON.http;
  }
  if (providerConfig?.type === "generic-cli") {
    return DEFAULT_PROVIDER_ICON.cli;
  }
  return DEFAULT_PROVIDER_ICON.default;
}

function providerIcon(provider, providerConfig) {
  const icon = (providerConfig?.icon || "").trim();
  return icon || defaultIconForProvider(provider, providerConfig);
}

function firstEmoji(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) {
    return "";
  }
  if (typeof Intl.Segmenter !== "undefined") {
    const segments = [...new Intl.Segmenter().segment(trimmed)].map((s) => s.segment);
    return segments[0] ?? trimmed.charAt(0);
  }
  return [...trimmed][0] ?? trimmed.charAt(0);
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

function ensureFallbackChain() {
  if (!Array.isArray(config.routing.fallbackChain)) {
    config.routing.fallbackChain = ["codex", "cursor"];
  }
}

await loadConfig();
render();
connectLogs();
bindProviderInteractionLock();
refreshStatus();
refreshOrchestration();
setInterval(refreshOrchestration, 30000);

els.save.addEventListener("click", () => saveConfig({ notify: true }));
els.refreshStatus.addEventListener("click", () => refreshStatus({ manual: true }));
els.refreshOrchestration?.addEventListener("click", () => refreshOrchestration({ manual: true }));
els.addProvider.addEventListener("click", openAddProviderDialog);
els.addProviderCancel.addEventListener("click", () => els.addProviderDialog.close());
els.newProviderType.addEventListener("change", () => {
  toggleNewProviderFields();
  if (!newProviderIconLocked) {
    setNewProviderIcon(
      els.newProviderType.value === "http" ? DEFAULT_PROVIDER_ICON.http : DEFAULT_PROVIDER_ICON.cli
    );
  }
});
els.newProviderIconInput.addEventListener("input", () => {
  const emoji = firstEmoji(els.newProviderIconInput.value);
  if (emoji) {
    newProviderIconLocked = true;
    setNewProviderIcon(emoji, { lock: true });
  }
});
els.addProviderForm.addEventListener("submit", addProvider);
els.settingTailscaleHost.addEventListener("input", updateServerFromSettings);
els.settingServePort.addEventListener("input", updateServerFromSettings);
els.settingFunnelPort.addEventListener("input", updateServerFromSettings);
els.settingParagonBase.addEventListener("input", updateServerFromSettings);
els.settingExposedModel.addEventListener("input", updateServerFromSettings);
els.settingApiKey.addEventListener("input", updateServerFromSettings);
els.toggleSettings.addEventListener("click", () => {
  els.settingsPanel.hidden = !els.settingsPanel.hidden;
});
els.editFallback.addEventListener("click", openFallbackDialog);
els.fallbackCancel.addEventListener("click", () => els.fallbackDialog.close());
els.fallbackSave.addEventListener("click", saveFallbackDialog);
els.fallbackAddBtn.addEventListener("click", addToFallbackDraft);
els.defaultProvider.addEventListener("change", () => {
  config.routing.defaultProvider = els.defaultProvider.value;
});
els.emojiCancel.addEventListener("click", () => els.emojiDialog.close());
els.emojiApply.addEventListener("click", applyEmojiPick);
els.emojiCustom.addEventListener("input", () => {
  const emoji = firstEmoji(els.emojiCustom.value);
  if (emoji) {
    setEmojiDraft(emoji);
  }
});

initEmojiGrid(els.emojiGrid, (emoji) => setEmojiDraft(emoji));
initEmojiGrid(els.newProviderEmojiGrid, (emoji) => {
  newProviderIconLocked = true;
  setNewProviderIcon(emoji, { lock: true });
});

function toggleNewProviderFields() {
  const isHttp = els.newProviderType.value === "http";
  els.newProviderHttpFields.hidden = !isHttp;
  els.newProviderCliFields.hidden = isHttp;
}

function openAddProviderDialog() {
  newProviderIconLocked = false;
  setNewProviderIcon(DEFAULT_PROVIDER_ICON.http);
  els.addProviderDialog.showModal();
}

function setNewProviderIcon(emoji, { lock = false } = {}) {
  const value = emoji || DEFAULT_PROVIDER_ICON.default;
  els.newProviderIconDisplay.textContent = value;
  els.newProviderIconInput.value = value;
  if (lock) {
    newProviderIconLocked = true;
  }
  highlightEmojiGrid(els.newProviderEmojiGrid, value);
}

function newProviderIconValue() {
  return firstEmoji(els.newProviderIconInput.value || els.newProviderIconDisplay.textContent);
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
  ensureFallbackChain();
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
      return `<span class="health-dot ${cls}" title="${escapeAttr(`${providerIcon(provider, cfg)} ${providerLabel(provider, cfg)}`)}"></span>`;
    })
    .join("");
}

function renderFallbackViz() {
  ensureFallbackChain();
  const chain = config.routing.fallbackChain.filter((p) => config.providers[p]);
  if (!chain.length) {
    els.fallbackViz.innerHTML = `<span class="fallback-empty">Configure fallback chain</span>`;
    return;
  }
  els.fallbackViz.innerHTML = chain
    .map((provider, i) => {
      const chip = `<span class="fallback-chip">${escapeHtml(providerIcon(provider, config.providers[provider]))} ${escapeHtml(providerLabel(provider, config.providers[provider]))}</span>`;
      return i === 0 ? chip : `<span class="fallback-arrow">→</span>${chip}`;
    })
    .join("");
}

function renderDefaultProviderSelect() {
  const providers = routeProviderOptions();
  const current = config.routing.defaultProvider;
  els.defaultProvider.innerHTML = providers
    .map(
      (p) =>
        `<option value="${escapeAttr(p)}" ${p === current ? "selected" : ""}>${escapeHtml(providerLabel(p, config.providers[p]))}</option>`
    )
    .join("");
  if (!providers.includes(current) && providers[0]) {
    config.routing.defaultProvider = providers[0];
    els.defaultProvider.value = providers[0];
  }
}

function renderRouting() {
  renderFallbackViz();
  renderDefaultProviderSelect();
  renderRoutes();
}

function render() {
  els.settingTailscaleHost.value = config.server.tailscaleHost ?? "";
  els.settingServePort.value = config.server.tailscaleServePort ?? 9420;
  els.settingFunnelPort.value = config.server.tailscaleFunnelPort ?? 10000;
  els.settingParagonBase.value = config.server.cursorBaseUrl ?? "";
  els.settingExposedModel.value = config.server.exposedModel ?? "";
  els.settingApiKey.value = config.server.apiKey ?? "";

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
    const icon = providerIcon(provider, providerConfig);
    const statusLine = status?.output ? truncateStatus(status.output) : "";
    const signInLabel = authButtonLabel(provider);

    const card = document.createElement("article");
    card.className = "provider-card";
    card.dataset.providerCard = provider;
    card.innerHTML = `
      <div class="provider-top">
        <button type="button" class="provider-emoji" data-emoji="${provider}" title="Change icon">${icon}</button>
        <div class="provider-meta">
          <h3>${escapeHtml(label)}</h3>
          <span class="provider-id">${escapeHtml(provider)}</span>
          ${statusLine ? `<p class="provider-status-line ${status?.ok ? "ok" : "bad"}">${escapeHtml(statusLine)}</p>` : ""}
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
        <div class="field model-row">
          <label class="field" style="flex:1">
            <span class="field-label">Model</span>
            <select data-provider="${provider}" data-key="model">${modelOptions(providerConfig)}</select>
          </label>
          <button type="button" class="icon-button" title="Refresh models" data-refresh-models="${provider}">↻</button>
        </div>
      </div>
      <div class="provider-actions">
        ${auth && !http ? `<button type="button" class="btn secondary sm" data-auth="${provider}">${escapeHtml(signInLabel)}</button>` : ""}
        ${custom ? `<button type="button" class="btn ghost sm danger-text" data-remove="${provider}">Remove</button>` : ""}
      </div>
      <div class="auth-panel" data-auth-panel="${provider}" hidden></div>
    `;
    els.providers.append(card);
  }

  bindProviderEvents();
  for (const provider of authInProgress) {
    paintAuthPanel(provider);
  }
}

function initEmojiGrid(container, onPick) {
  if (!container) {
    return;
  }
  container.innerHTML = EMOJI_PICKS.map(
    (emoji) => `<button type="button" class="emoji-pick" data-emoji="${escapeAttr(emoji)}">${emoji}</button>`
  ).join("");
  container.querySelectorAll(".emoji-pick").forEach((btn) => {
    btn.addEventListener("click", () => onPick(btn.dataset.emoji));
  });
}

function highlightEmojiGrid(container, emoji) {
  container?.querySelectorAll(".emoji-pick").forEach((btn) => {
    btn.classList.toggle("selected", btn.dataset.emoji === emoji);
  });
}

function setEmojiDraft(emoji) {
  emojiPickDraft = emoji;
  els.emojiPreview.textContent = emoji;
  els.emojiCustom.value = emoji;
  highlightEmojiGrid(els.emojiGrid, emoji);
}

function openEmojiPicker(provider) {
  emojiEditProvider = provider;
  const current = providerIcon(provider, config.providers[provider]);
  setEmojiDraft(current);
  els.emojiDialog.showModal();
}

async function applyEmojiPick() {
  if (!emojiEditProvider) {
    return;
  }
  const emoji = firstEmoji(emojiPickDraft || els.emojiCustom.value);
  if (!emoji) {
    return;
  }
  config.providers[emojiEditProvider].icon = emoji;
  els.emojiDialog.close();
  renderProviders();
  renderRouting();
  await saveConfig();
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
  els.providers.querySelectorAll("[data-emoji]").forEach((button) => {
    button.addEventListener("click", () => openEmojiPicker(button.dataset.emoji));
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
  els.providers.querySelectorAll("[data-refresh-models]").forEach((button) => {
    button.addEventListener("click", () => refreshProviderModels(button.dataset.refreshModels, button));
  });
  els.providers.querySelectorAll("[data-remove]").forEach((button) => {
    button.addEventListener("click", () => removeProvider(button.dataset.remove));
  });
}

function modelOptions(providerConfig) {
  const models = providerConfig.models ?? [];
  if (!models.length) {
    return `<option value="" selected>Load models (↻)</option>`;
  }

  return models
    .map((model) => {
      const label = model.name && model.name !== model.id ? model.name : model.id;
      return `<option value="${escapeAttr(model.id)}" ${providerConfig.model === model.id ? "selected" : ""}>${escapeHtml(label)}</option>`;
    })
    .join("");
}

function renderRoutes() {
  els.routes.innerHTML = "";
  const providers = routeProviderOptions();
  for (const task of taskOrder) {
    const row = document.createElement("div");
    row.className = "route-row";
    row.innerHTML = `
      <div class="route-task">
        <span class="route-task-icon">${TASK_ICONS[task] ?? "•"}</span>
        <span>${task}</span>
      </div>
      <select data-task="${task}">
        ${providers
          .map(
            (p) =>
              `<option value="${escapeAttr(p)}" ${config.routing.taskRoutes[task] === p ? "selected" : ""}>${escapeHtml(`${providerIcon(p, config.providers[p])} ${providerLabel(p, config.providers[p])}`)}</option>`
          )
          .join("")}
      </select>
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

function openFallbackDialog() {
  ensureFallbackChain();
  fallbackDraft = [...config.routing.fallbackChain];
  renderFallbackDialog();
  els.fallbackDialog.showModal();
}

function enabledProvidersForFallback() {
  return providerOrder().filter((p) => config.providers[p]?.enabled);
}

function renderFallbackDialog() {
  els.fallbackOrder.innerHTML = "";
  fallbackDraft.forEach((provider, index) => {
    const li = document.createElement("li");
    li.className = "fallback-item";
    li.innerHTML = `
      <span class="fallback-item-name">${escapeHtml(providerLabel(provider, config.providers[provider]))}</span>
      <div class="fallback-item-actions">
        <button type="button" class="btn icon-btn sm" data-fb-up="${index}" title="Move up">↑</button>
        <button type="button" class="btn icon-btn sm" data-fb-down="${index}" title="Move down">↓</button>
        <button type="button" class="btn ghost sm danger-text" data-fb-remove="${index}">Remove</button>
      </div>
    `;
    els.fallbackOrder.append(li);
  });

  els.fallbackOrder.querySelectorAll("[data-fb-up]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const i = Number(btn.dataset.fbUp);
      if (i > 0) {
        [fallbackDraft[i - 1], fallbackDraft[i]] = [fallbackDraft[i], fallbackDraft[i - 1]];
        renderFallbackDialog();
      }
    });
  });
  els.fallbackOrder.querySelectorAll("[data-fb-down]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const i = Number(btn.dataset.fbDown);
      if (i < fallbackDraft.length - 1) {
        [fallbackDraft[i], fallbackDraft[i + 1]] = [fallbackDraft[i + 1], fallbackDraft[i]];
        renderFallbackDialog();
      }
    });
  });
  els.fallbackOrder.querySelectorAll("[data-fb-remove]").forEach((btn) => {
    btn.addEventListener("click", () => {
      fallbackDraft.splice(Number(btn.dataset.fbRemove), 1);
      renderFallbackDialog();
    });
  });

  const available = enabledProvidersForFallback().filter((p) => !fallbackDraft.includes(p));
  els.fallbackAddSelect.innerHTML = available.length
    ? available.map((p) => `<option value="${escapeAttr(p)}">${escapeHtml(providerLabel(p, config.providers[p]))}</option>`).join("")
    : `<option value="">—</option>`;
  els.fallbackAddBtn.disabled = !available.length;
}

function addToFallbackDraft() {
  const provider = els.fallbackAddSelect.value;
  if (provider && !fallbackDraft.includes(provider)) {
    fallbackDraft.push(provider);
    renderFallbackDialog();
  }
}

function saveFallbackDialog() {
  config.routing.fallbackChain = fallbackDraft.filter((p) => config.providers[p]);
  els.fallbackDialog.close();
  renderRouting();
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
    config = body;
    ensureFallbackChain();
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

  const icon = newProviderIconValue() || (type === "http" ? DEFAULT_PROVIDER_ICON.http : DEFAULT_PROVIDER_ICON.cli);

  if (type === "http") {
    config.providers[id] = {
      type: "http",
      label,
      icon,
      enabled: true,
      baseUrl: document.querySelector("#new-provider-base-url").value.trim(),
      apiKey: document.querySelector("#new-provider-api-key").value,
      model: document.querySelector("#new-provider-model").value.trim(),
      models: [],
      timeoutMs: 300000
    };
  } else {
    const runArgsRaw = document.querySelector("#new-provider-run-args").value.trim();
    config.providers[id] = {
      type: "generic-cli",
      label,
      icon,
      enabled: true,
      command: document.querySelector("#new-provider-command").value.trim(),
      runArgs: runArgsRaw ? runArgsRaw.split(",").map((p) => p.trim()) : ["-"],
      model: document.querySelector("#new-provider-cli-model").value.trim(),
      models: [],
      timeoutMs: 300000,
      stdinMode: "prompt"
    };
  }

  ensureFallbackChain();
  if (!config.routing.fallbackChain.includes(id)) {
    config.routing.fallbackChain.push(id);
  }

  els.addProviderDialog.close();
  els.addProviderForm.reset();
  toggleNewProviderFields();
  render();
  await saveConfig();
}

function removeProvider(provider) {
  if (!confirm(`Remove "${provider}"?`)) {
    return;
  }
  delete config.providers[provider];
  for (const task of taskOrder) {
    if (config.routing.taskRoutes[task] === provider) {
      config.routing.taskRoutes[task] = config.routing.defaultProvider;
    }
  }
  config.routing.fallbackChain = (config.routing.fallbackChain ?? []).filter((name) => name !== provider);
  if (config.routing.defaultProvider === provider) {
    const next = providerOrder()[0];
    if (next) {
      config.routing.defaultProvider = next;
    }
  }
  render();
  saveConfig();
}

function truncateStatus(text) {
  const oneLine = String(text).replace(/\s+/g, " ").trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 117)}…` : oneLine;
}

function patchProviderModelSelect(provider) {
  const card = els.providers.querySelector(`[data-provider-card="${provider}"]`);
  const select = card?.querySelector(`select[data-provider="${provider}"][data-key="model"]`);
  if (!select) {
    return;
  }
  const providerConfig = config.providers[provider];
  const selected = providerConfig.model ?? "";
  select.innerHTML = modelOptions(providerConfig);
  select.value = selected;
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

  const needsCode = session.mode === "oauth-code" || flow.mode === "oauth-code" || provider === "gemini";
  if (needsCode) {
    parts.push(`
      <div class="auth-code-row">
        <input type="text" placeholder="Paste authorization code from Google" data-auth-code="${escapeAttr(provider)}" autocomplete="off" />
        <button type="button" class="btn secondary sm" data-auth-code-submit="${escapeAttr(provider)}">Submit code</button>
      </div>
      <p class="auth-hint auth-code-note">After Google redirects you, copy the code and paste it here. This field stays open until you submit.</p>
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
    const response = await apiFetch("/api/auth/gemini/code", {
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

async function refreshProviderModels(provider, button) {
  button.disabled = true;
  try {
    await saveConfig();
    const response = await apiFetch(`/api/providers/${provider}/models`, { method: "POST" });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.error?.message ?? "Failed");
    }
    config.providers[provider].models = body.models;
    if (providerUiLock) {
      patchProviderModelSelect(provider);
      patchProviderStatuses();
    } else {
      renderProviders();
    }
  } catch (error) {
    prependLog({ at: new Date().toISOString(), provider, type: "models", level: "error", message: error.message });
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

function connectLogs() {
  const key = getStoredApiKey();
  const url = key ? `/api/logs/stream?key=${encodeURIComponent(key)}` : "/api/logs/stream";
  const events = new EventSource(url);
  events.onmessage = (event) => prependLog(JSON.parse(event.data));
  events.onerror = async () => {
    events.close();
    if (!getStoredApiKey()) {
      await promptForApiKey();
    }
    connectLogs();
  };
}

function prependLog(entry) {
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

    els.orchOverview.innerHTML = [
      orchStat("Active jobs", status.activeJobs),
      orchStat("Active sessions", status.activeSessions),
      orchStat("Active runs", status.activeRuns),
      orchStat("Root vs child", `${usage.byRootVsChild?.root ?? 0} / ${usage.byRootVsChild?.child ?? 0}`),
      orchStat("Max observed context", `${status.maxObservedContextTokens ?? 0} tok`),
      orchStat("Longest active session", `${status.longestActiveSessionMinutes ?? 0}m`),
      orchStat("Enforcement mode", status.enforcementMode ?? "shadow")
    ].join("");

    renderCountMap(els.orchContext, usage.byContextBand, "No requests observed yet.");
    renderCountMap(els.orchSessions, usage.bySessionDurationBand, "No sessions observed yet.");
    renderCountMap(els.orchAgents, usage.byAgentRole, "No runs observed yet.");
    renderCountMap(els.orchProviders, usage.byProvider, "No provider executions observed yet.");

    els.orchGovernor.innerHTML = decisions.items?.length
      ? decisions.items
          .map(
            (d) =>
              `<div class="orch-decision"><span class="orch-decision-rule">${escapeHtml(d.policyRule)}</span> — ${escapeHtml(d.explanation)}</div>`
          )
          .join("")
      : '<p class="orch-empty">No governor decisions recorded yet — shadow mode has nothing to propose.</p>';
  } catch {
    // Best-effort dashboard panel; a failed fetch here must not disturb the rest of the UI.
  } finally {
    if (els.refreshOrchestration) {
      els.refreshOrchestration.disabled = false;
    }
  }
}

function escapeAttr(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

toggleNewProviderFields();
