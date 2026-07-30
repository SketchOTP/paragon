/**
 * PARAGON-D-004E — everyday product dashboard.
 *
 * Two kinds of check live here:
 *
 *  1. Surface contracts on the shipped dashboard assets. These assert the
 *     *absence* of the transition-era engineering surfaces (shadow routing,
 *     directive identifiers, deprecated compatibility fields, a provider model
 *     dropdown, the stacked engineering accordions) and the *presence* of the
 *     four product areas that replaced them. Written against structural
 *     markers — element ids, `data-` hooks, endpoint paths — so ordinary copy
 *     edits do not fail them while a reintroduced control does.
 *
 *  2. Unit tests for the pure modules that feed those surfaces.
 *
 * The primary page and the Diagnostics surface are asserted **separately**:
 * technical vocabulary is allowed inside Diagnostics and forbidden outside it,
 * so a test that grepped the whole file would be meaningless.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { defaultCatalog, replaceProviderModels } from "../src/modelCatalog.js";
import { buildProviderRoutingSummaries } from "../src/routing/providerSummary.js";
import { decodeAvatarDataUrl, isValidProviderId, MAX_AVATAR_BYTES } from "../src/providerAvatars.js";
import { PROVIDER_DEFAULT_MODEL_ID } from "../src/modelCapability.js";
import { createQuotaStateStore } from "../src/routing/quotaState.js";
import { createRouteActivityStore } from "../src/routing/routeActivity.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const html = fs.readFileSync(path.join(repoRoot, "public/index.html"), "utf8");
const appJs = fs.readFileSync(path.join(repoRoot, "public/app.js"), "utf8");
const css = fs.readFileSync(path.join(repoRoot, "public/styles.css"), "utf8");

/** Markup of the primary page only — `<main class="app">…</main>`. */
function primaryPage() {
  const start = html.indexOf('<main class="app"');
  const end = html.indexOf("</main>", start);
  assert.ok(start > -1 && end > start, "the primary page must be a single <main class=\"app\"> region");
  return html.slice(start, end);
}

/** Markup of one `<dialog id="…">` region. */
function dialogMarkup(id) {
  const start = html.indexOf(`<dialog id="${id}"`);
  assert.ok(start > -1, `expected a dialog with id ${id}`);
  const end = html.indexOf("</dialog>", start);
  return html.slice(start, end);
}

/** Visible text of a markup region, with tags, attributes and comments removed. */
function visibleText(markup) {
  return markup
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ");
}

// ---------------------------------------------------- 23 / 26. primary page

test("23. the primary dashboard contains exactly the four product areas", () => {
  const page = primaryPage();
  for (const label of ["Connection", "Providers", "Automatic Routing", "Recent Activity"]) {
    assert.match(page, new RegExp(`aria-label="${label}"`), `the primary page must present a ${label} area`);
  }
  // Exactly four labelled regions — no fifth area smuggled onto the page.
  const regions = [...page.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(regions.sort(), ["Automatic Routing", "Connection", "Providers", "Recent Activity"]);
});

test("26. every engineering panel is absent from the primary page, not merely collapsed", () => {
  const page = primaryPage();
  const forbidden = [
    "attempt-plans-panel",
    "legacy-preferences-panel",
    "shadow-settings-panel",
    "deprecated-config-panel",
    "model-routing-panel",
    "model-catalog-panel",
    "routing-intelligence-panel",
    "orchestration-panel",
    "orch-settings-panel"
  ];
  for (const id of forbidden) {
    assert.ok(!html.includes(`id="${id}"`), `${id} must be gone from the dashboard entirely`);
    assert.ok(!page.includes(id), `${id} must not appear on the primary page`);
  }
  // The collapse mechanism those panels used is gone too, so nothing can be
  // "hidden but present" on the primary page.
  assert.ok(!html.includes("panel-collapse-toggle"), "the accordion toggle mechanism must be gone");
  assert.ok(!appJs.includes("wireCollapsePanel"), "the accordion wiring must be gone");
});

test("23b. the primary page shows connection facts, provider cards, routing status and an activity list", () => {
  const page = primaryPage();
  for (const id of ["base-url", "model-name", "api-key", "service-health", "providers", "routing-facts", "activity-list"]) {
    assert.match(page, new RegExp(`id="${id}"`), `the primary page must render #${id}`);
  }
});

// ---------------------------------------------------- 19 / 20 / 21. language

test("19. no normal UI contains the word shadow", () => {
  const page = visibleText(primaryPage());
  assert.ok(!/shadow/i.test(page), "the primary page must not mention shadow");
  for (const id of ["settings-dialog", "add-provider-dialog", "provider-edit-dialog", "avatar-dialog"]) {
    assert.ok(!/shadow/i.test(visibleText(dialogMarkup(id))), `${id} must not mention shadow`);
  }
  // And nothing the app renders at runtime can reintroduce it. `box-shadow`
  // and friends are CSS properties, not UI text, so only the scripted markup
  // and the HTML are checked.
  assert.ok(!/shadow/i.test(appJs.replace(/box-shadow|--shadow|text-shadow|drop-shadow/g, "")), "app.js must not render shadow copy");
  assert.ok(!html.includes("X-Paragon-Shadow"), "no shadow header may be referenced");
});

test("20. no normal UI contains an internal directive identifier or experimental terminology", () => {
  const surfaces = [primaryPage(), dialogMarkup("settings-dialog"), dialogMarkup("add-provider-dialog")].map(visibleText);
  const forbidden = [
    /PARAGON-D-\d/i,
    /D-004[A-Z]?\d?/i,
    /\bexpected utility\b/i,
    /\badvisory\b/i,
    /\blegacy live\b/i,
    /\btelemetry bucket/i,
    /\bdeprecated\b/i,
    /\borchestration\b/i,
    /\benforcement policy\b/i
  ];
  for (const surface of surfaces) {
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(surface), `normal UI must not contain ${pattern}`);
    }
  }
});

test("20b. the product uses product language for its core concepts", () => {
  const page = visibleText(primaryPage());
  for (const phrase of ["Automatic Routing", "Recent Activity", "Providers"]) {
    assert.ok(page.includes(phrase), `expected product language: ${phrase}`);
  }
  // Diagnostics is where technical vocabulary is allowed, and it is reached
  // from Settings rather than from the primary page.
  assert.match(visibleText(dialogMarkup("settings-dialog")), /Advanced Diagnostics/);
});

test("21. no deprecated-compatibility surface exists anywhere in the dashboard", () => {
  assert.ok(!html.includes("deprecated-config-list"));
  assert.ok(!appJs.includes("deprecatedConfigFields"));
  assert.ok(!appJs.includes("deprecatedConfiguredModel"));
  // The removed fields must not be referenced by the client at all.
  for (const field of ["taskRoutes", "defaultProvider", "fallbackChain"]) {
    assert.ok(!appJs.includes(field), `app.js must not reference the removed ${field}`);
    assert.ok(!html.includes(field), `index.html must not reference the removed ${field}`);
  }
});

// ---------------------------------------------------- 22. no model dropdown

test("22. no provider model dropdown returns", () => {
  // The old control was `<select data-provider=… data-key="model">`, populated
  // from the provider's discovered model list.
  assert.ok(!/data-key="model"/.test(appJs), "a provider model selector must not exist");
  assert.ok(!/data-key="model"/.test(html));
  // Provider cards report the model that actually ran instead of offering one.
  assert.match(appJs, /Last used:/, "the card must report the observed model");
  assert.match(appJs, /modelsAvailable/, "the card must report an available-model count, not a choice");
});

// ---------------------------------------------------- 24 / 25. one save

test("24. exactly one general Save Changes action exists", () => {
  const matches = [...html.matchAll(/>Save Changes</g)];
  assert.equal(matches.length, 1, "there must be exactly one general save action");
  // And it lives in Settings.
  assert.match(dialogMarkup("settings-dialog"), /id="save-settings"[^>]*>|>Save Changes</);
});

test("25. no additional general Save buttons exist", () => {
  // Any button whose entire label is "Save" (or "Save …") other than the one
  // general action is a second general save.
  const labels = [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1].trim());
  const saves = labels.filter((label) => /^save\b/i.test(label));
  assert.deepEqual(saves, ["Save Changes"], `unexpected save buttons: ${saves.join(", ")}`);
  // The retired per-panel save handlers are gone.
  for (const id of ["save-shadow-settings", "save-orch-settings", "save"]) {
    assert.ok(!html.includes(`id="${id}"`), `${id} must be gone`);
  }
});

test("25b. immediate actions report their own outcome instead of deferring to a save", () => {
  // Each immediate action must surface a result: a toast, or an inline status.
  for (const fn of ["testProvider", "refreshProviderCatalog", "applyAvatar", "clearActivityHistory", "toggleProvider"]) {
    assert.ok(appJs.includes(`function ${fn}`) || appJs.includes(`async function ${fn}`), `expected an immediate action ${fn}`);
  }
  assert.match(appJs, /function flashNotice/, "immediate actions need a result channel");
});

// ---------------------------------------------------- 27. diagnostics

test("27. Diagnostics exposes the required model and routing evidence", () => {
  const diag = dialogMarkup("diagnostics-dialog");
  for (const tab of ["models", "routing", "requests", "system"]) {
    assert.match(diag, new RegExp(`data-tab="${tab}"`), `Diagnostics must have a ${tab} section`);
    assert.match(diag, new RegExp(`data-panel="${tab}"`));
  }
  // Models: registry + catalog state + benchmark attribution.
  assert.match(diag, /Catalog state/);
  assert.match(diag, /Benchmark/);
  // Routing: ranked candidates, utility decomposition, exclusion reasons.
  assert.match(diag, /Ranked candidates/);
  assert.match(diag, /Utility/);
  assert.match(diag, /Excluded because/);
  assert.match(diag, /Latest attempt plan/);
  // Requests: usage evidence + raw log.
  assert.match(diag, /Usage evidence/);
  assert.match(diag, /Raw log/);
  // And it is organised as tabs rather than stacked accordions.
  assert.ok(!diag.includes("panel-collapse-toggle"));
});

test("28. Diagnostics carries no general-purpose save button", () => {
  const diag = dialogMarkup("diagnostics-dialog");
  const labels = [...diag.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1].trim());
  assert.ok(!labels.some((label) => /^save/i.test(label)), `Diagnostics must be read-only except for maintenance actions: ${labels.join(", ")}`);
  // Its write actions are explicitly scoped maintenance operations.
  for (const id of ["diag-refresh-catalog", "diag-validate-all", "diag-export"]) {
    assert.ok(diag.includes(`id="${id}"`), `expected maintenance action ${id}`);
  }
});

// ---------------------------------------------------- 29. first-run flow

test("29. a first-run flow exists and reaches a working configuration without exposing internals", () => {
  const onboarding = html.slice(html.indexOf('<section class="onboarding"'), html.indexOf("</section>", html.indexOf('<section class="onboarding"')));
  const text = visibleText(onboarding);
  // Connect a provider, show the connection facts, offer a real test request.
  assert.match(text, /Connect a provider/);
  assert.match(text, /Base URL/);
  assert.match(text, /Model name/);
  assert.match(text, /API key/);
  assert.match(text, /test request/i);
  assert.match(onboarding, /id="onboarding-snippet"/, "a copy-ready client configuration must be offered");
  // And it must not expose catalogs, weights, orchestration or shadow concepts.
  for (const pattern of [/catalog/i, /weight/i, /orchestration/i, /shadow/i, /utility/i]) {
    assert.ok(!pattern.test(text), `onboarding must not expose ${pattern}`);
  }
  // The test request goes through PARAGON's real public surface.
  assert.match(appJs, /runOnboardingTest[\s\S]{0,600}\/v1\/chat\/completions/, "the test request must hit the real /v1 surface");
});

// ---------------------------------------------------- provider summaries

function catalogWith(provider, entries) {
  const catalog = defaultCatalog();
  catalog.generation = 1;
  replaceProviderModels(catalog, provider, entries);
  catalog.schedule.lastSuccessfulRefreshAt = new Date().toISOString();
  return catalog;
}

test("providerSummary counts only what routing can actually use", () => {
  const catalog = catalogWith("p", [
    { modelId: "good-a", displayName: "good-a", state: "validated", discoverySource: "runtime_probe" },
    { modelId: "good-b", displayName: "good-b", state: "exposed", discoverySource: "cli_command" },
    { modelId: "nope", displayName: "nope", state: "rejected", discoverySource: "cli_command" },
    { modelId: "gone", displayName: "gone", state: "unavailable", discoverySource: "cli_command" },
    // Positively identified as non-chat: eligible by catalog state, but the
    // capability gate drops it, so the eligible count must not include it.
    { modelId: "text-embedding-3-large", displayName: "embed", state: "validated", discoverySource: "http_models_endpoint" }
  ]);
  const config = { providers: { p: { enabled: true, label: "P" } }, modelCatalog: { validationTtlHours: 24 } };

  const [summary] = buildProviderRoutingSummaries(config, { p: { ok: true } }, catalog);
  assert.equal(summary.catalogState, "assessed");
  assert.equal(summary.counts.eligible, 2, "the embedding model must not count as eligible");
  assert.equal(summary.counts.validated, 2);
  assert.equal(summary.counts.exposed, 1);
  assert.equal(summary.counts.blocked, 2);
  assert.equal(summary.health, "healthy");
  assert.equal(summary.selection, "automatic-per-request");
  // The deprecated configured-model field is gone from the summary entirely.
  assert.equal(summary.deprecatedConfiguredModel, undefined);
  assert.equal(summary.lastShadowModel, undefined);
});

test("providerSummary reports an unassessed enabled provider as pending, contributing nothing", () => {
  const config = { providers: { fresh: { enabled: true, label: "Fresh" } } };
  const [summary] = buildProviderRoutingSummaries(config, {}, defaultCatalog());
  assert.equal(summary.catalogState, "pending_assessment");
  assert.equal(summary.pendingAssessment, true);
  assert.equal(summary.counts.eligible, 0);
  assert.equal(summary.health, "unknown");
});

test("providerSummary distinguishes a disabled provider from a failing one", () => {
  const config = { providers: { off: { enabled: false, label: "Off" } } };
  const [summary] = buildProviderRoutingSummaries(config, {}, defaultCatalog());
  assert.equal(summary.catalogState, "disabled");
  assert.equal(summary.pendingAssessment, false);
});

test("providerSummary reports whether provider-default execution is itself validated", () => {
  const catalog = catalogWith("p", [
    { modelId: PROVIDER_DEFAULT_MODEL_ID, displayName: "(provider default)", state: "validated", discoverySource: "runtime_probe" }
  ]);
  const [summary] = buildProviderRoutingSummaries({ providers: { p: { enabled: true } } }, {}, catalog);
  assert.equal(summary.providerDefault.present, true);
  assert.equal(summary.providerDefault.validated, true);
  assert.equal(summary.providerDefault.eligible, true);
});

test("providerSummary treats a validated entry past its TTL as ineligible", () => {
  const catalog = catalogWith("p", [{ modelId: "m", displayName: "m", state: "validated", discoverySource: "runtime_probe" }]);
  const summaries = buildProviderRoutingSummaries(
    { providers: { p: { enabled: true } }, modelCatalog: { validationTtlHours: 1 } },
    {},
    catalog,
    null,
    { now: Date.now() + 3 * 3_600_000 }
  );
  assert.equal(summaries[0].counts.eligible, 0);
  assert.equal(summaries[0].counts.validated, 1, "state history is retained even when eligibility has lapsed");
});

test("providerSummary surfaces an observed usage limit with its reset instant", () => {
  const catalog = catalogWith("p", [{ modelId: "m", displayName: "m", state: "validated", discoverySource: "runtime_probe" }]);
  const quotaState = createQuotaStateStore();
  quotaState.recordQuotaFailure("p", {
    classification: "QUOTA_EXHAUSTED",
    detail: "You've hit your usage limit. Your usage limits will reset when your monthly cycle ends on 8/12/2099."
  });
  const [summary] = buildProviderRoutingSummaries({ providers: { p: { enabled: true } } }, {}, catalog, null, { quotaState });
  assert.ok(summary.usageLimit, "an exhausted allowance must be reported on the card");
  assert.equal(summary.usageLimit.resetSource, "provider_calendar_date");
});

test("a provider summary reports the executed model and keeps failures separate from usage", () => {
  const catalog = catalogWith("p", [{ modelId: "m", displayName: "m", state: "validated", discoverySource: "runtime_probe" }]);
  const activity = createRouteActivityStore();
  activity.recordFailed({ provider: "p", model: "m-bad", reason: "p did not return a response" });
  const [beforeSuccess] = buildProviderRoutingSummaries({ providers: { p: { enabled: true } } }, {}, catalog, activity);
  assert.equal(beforeSuccess.lastExecutedModel, null, "a failure must never be reported as usage");
  assert.equal(beforeSuccess.lastFailure.model, "m-bad");

  activity.recordExecuted({ provider: "p", model: "m" });
  const [afterSuccess] = buildProviderRoutingSummaries({ providers: { p: { enabled: true } } }, {}, catalog, activity);
  assert.equal(afterSuccess.lastExecutedModel.model, "m");
});

// ---------------------------------------------------- avatars (39)

test("39. avatar decoding trusts magic bytes, not the client-declared mime type", () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
  assert.equal(decodeAvatarDataUrl(`data:image/png;base64,${png.toString("base64")}`).ext, "png");

  // Declared as a PNG but actually a script: rejected on the bytes.
  const script = Buffer.from("<script>alert(1)</script>");
  assert.match(decodeAvatarDataUrl(`data:image/png;base64,${script.toString("base64")}`).error, /PNG, JPEG or WebP/);

  assert.match(decodeAvatarDataUrl("not-a-data-url").error, /base64 data URL/);
  assert.match(decodeAvatarDataUrl("data:image/png;base64,").error, /base64 data URL/);

  const huge = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(MAX_AVATAR_BYTES + 1)]);
  assert.match(decodeAvatarDataUrl(`data:image/jpeg;base64,${huge.toString("base64")}`).error, /limit is/);
});

test("39b. avatar provider ids are validated before being used as a filename", () => {
  assert.equal(isValidProviderId("lmstudio"), true);
  assert.equal(isValidProviderId("my-provider-2"), true);
  assert.equal(isValidProviderId("../../etc/passwd"), false);
  assert.equal(isValidProviderId("Upper"), false);
  assert.equal(isValidProviderId(""), false);
});

test("39c. every bundled provider avatar referenced by the dashboard exists on disk", () => {
  const referenced = [...appJs.matchAll(/"(\/avatars\/[a-z0-9-]+\.webp)"/g)].map((m) => m[1]);
  assert.ok(referenced.length >= 5, "expected bundled avatars for the shipped providers");
  for (const ref of referenced) {
    assert.ok(fs.existsSync(path.join(repoRoot, "public", ref)), `missing bundled avatar asset: ${ref}`);
  }
});

test("39d. provider cards keep the full-height avatar column and its glow treatment", () => {
  assert.match(appJs, /provider-avatar-image/);
  assert.match(appJs, /provider-avatar-initials/, "a provider with no avatar must fall back to initials, not a broken image");
  // Two-column card: avatar track then content track.
  assert.match(css, /\.provider-card\s*\{[^}]*grid-template-columns:\s*132px minmax\(0, 1fr\)/);
  assert.match(css, /\.provider-avatar\s*\{[^}]*align-self:\s*stretch/);
  // Same neon-purple glow as the metric cards at the top of the page.
  const metricGlow = /\.metric-card\s*\{[^}]*box-shadow:\s*var\(--glow-card\)/.test(css);
  const providerGlow = /\.provider-card\s*\{[^}]*box-shadow:\s*var\(--glow-card\)/.test(css);
  assert.ok(metricGlow && providerGlow, "provider cards must carry the same --glow-card as the top metric cards");
  assert.match(css, /\.providers-grid\s*\{[^}]*align-items:\s*stretch/);
});
