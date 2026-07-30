/**
 * PARAGON-D-004D1 — dashboard routing truthfulness.
 *
 * Two kinds of check live here:
 *
 *  1. Surface contracts on the shipped dashboard assets. These assert the
 *     *absence* of controls that claimed authority the backend does not give
 *     them (a provider model dropdown, a default-provider selector, a
 *     fallback-chain editor) and the *presence* of the honest replacements.
 *     They are deliberately written against structural markers — element ids,
 *     `data-` hooks, endpoint paths — rather than prose, so ordinary copy
 *     edits do not fail them while a reintroduced control does.
 *
 *  2. Unit tests for the new pure modules that feed those surfaces.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { defaultCatalog, replaceProviderModels } from "../src/modelCatalog.js";
import { buildProviderRoutingSummaries } from "../src/routing/providerSummary.js";
import { createRouteActivityStore } from "../src/routing/routeActivity.js";
import { ACTIVE_BUT_MISREPRESENTED_FIELDS, DEPRECATED_CONFIG_FIELDS } from "../src/deprecatedConfig.js";
import { decodeAvatarDataUrl, isValidProviderId, MAX_AVATAR_BYTES } from "../src/providerAvatars.js";
import { PROVIDER_DEFAULT_MODEL_ID } from "../src/modelCapability.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const html = fs.readFileSync(path.join(repoRoot, "public/index.html"), "utf8");
const appJs = fs.readFileSync(path.join(repoRoot, "public/app.js"), "utf8");
const css = fs.readFileSync(path.join(repoRoot, "public/styles.css"), "utf8");

// --- Phase 1: provider cards -------------------------------------------------

test("1. provider cards no longer expose a normal model-selection dropdown", () => {
  // The old control was `<select data-provider=... data-key="model">`, populated
  // by modelOptions(). Both the binding and its populator must be gone.
  assert.ok(!/data-key="model"/.test(appJs), "a data-key=\"model\" input/select is still rendered");
  assert.ok(!/function modelOptions\b/.test(appJs), "modelOptions() still exists to populate a model dropdown");
  assert.ok(!/data-refresh-models/.test(appJs), "the per-card model refresh button is still rendered");
  // No model field on the add-provider form either — a new provider must not
  // start life with a configured-model preference.
  assert.ok(!/id="new-provider-model"/.test(html), "add-provider still has an HTTP model field");
  assert.ok(!/id="new-provider-cli-model"/.test(html), "add-provider still has a CLI model field");
});

test("2. provider cards state that selection is automatic per request", () => {
  assert.match(appJs, /provider-routing-selection/, "no selection statement element on the card");
  assert.match(appJs, /Selection: automatic per request/, "the card does not say selection is automatic per request");
  // The read-only summary must report the fields the directive requires.
  for (const label of [
    "Eligible models",
    "Validated / exposed",
    "Rejected or unavailable",
    "Catalog refreshed",
    "Last live model",
    "Last shadow model",
    "Provider default",
    "Health"
  ]) {
    assert.ok(appJs.includes(label), `provider routing summary is missing "${label}"`);
  }
});

test("3. individual-model validation remains available as an advanced action", () => {
  assert.match(appJs, /data-inspect-catalog/, "no per-provider catalog inspect action");
  assert.match(html, /id="catalog-inspect-dialog"/, "no catalog inspect dialog");
  assert.match(appJs, /data-inspect-validate/, "the inspector offers no per-model validate action");
  // Still routed through the existing catalog validation path, not a new one.
  assert.match(appJs, /\/api\/model-catalog\/providers\/\$\{encodeURIComponent\(provider\)\}\/models\//);
});

test("4. no dashboard code path writes providerConfig.model", () => {
  // The one remaining assignment to a provider's `model` is the explicit empty
  // string when a provider is created; nothing may set it to a real model id.
  const assignments = [...appJs.matchAll(/\.model\s*=\s*([^;\n]+)/g)].map((m) => m[1].trim());
  assert.deepEqual(
    assignments.filter((value) => value !== '""'),
    [],
    `dashboard assigns a value to providerConfig.model: ${assignments.join(", ")}`
  );
  assert.match(appJs, /model: "",/, "new providers should be created with an empty deprecated model field");
});

// --- Phases 2 and 3: removed controls ---------------------------------------

test("5. the default-provider selector is absent from the primary UI", () => {
  assert.ok(!/id="default-provider"/.test(html), "default-provider select is still in the markup");
  assert.ok(!/defaultProvider\s*=\s*els\./.test(appJs), "a UI control still writes routing.defaultProvider");
  // Replaced by an explanatory live-routing status block.
  assert.match(html, /id="live-router-facts"/);
  assert.match(appJs, /Static default fallback/);
});

test("6. the fallback-chain visualization is absent", () => {
  assert.ok(!/id="fallback-viz"/.test(html), "fallback chain visualization is still in the markup");
  assert.ok(!/renderFallbackViz/.test(appJs), "renderFallbackViz() still exists");
  assert.ok(!/fallback-chip/.test(css), "fallback chip styling still present");
  // Replaced by a real explanation of how fallback candidates are derived.
  assert.match(html, /Fallback behavior/);
  assert.match(html, /Candidate order comes from the live ranked registry/);
});

test("7. the fallback-chain editor is absent", () => {
  for (const marker of ["id=\"fallback-dialog\"", "id=\"fallback-order\"", "id=\"fallback-add-select\"", "id=\"fallback-add-btn\""]) {
    assert.ok(!html.includes(marker), `fallback editor markup remains: ${marker}`);
  }
  for (const marker of ["openFallbackDialog", "renderFallbackDialog", "addToFallbackDraft", "saveFallbackDialog", "fallbackDraft"]) {
    assert.ok(!appJs.includes(marker), `fallback editor logic remains: ${marker}`);
  }
  // And nothing may invent a chain value on the client any more.
  assert.ok(!/ensureFallbackChain/.test(appJs), "the client still fabricates a fallbackChain default");
});

// --- Phase 4: task preference relabeling ------------------------------------

test("11/12/13. task provider preferences stay editable, labeled as a scoring bonus, and never as a route", () => {
  // Editable: the select and its change handler survive.
  assert.match(appJs, /select\.dataset\.task/, "task preference selects are no longer wired");
  assert.match(appJs, /config\.routing\.taskRoutes\[select\.dataset\.task\] = select\.value/);

  // Labeled with the real weight, read from the live engine rather than typed
  // in as a literal — so the label cannot drift from WEIGHTS.taskRoutePreference.
  assert.match(appJs, /taskProviderPreferencePoints/);
  assert.match(appJs, /live-routing preference/);
  assert.match(appJs, /not a forced route/);

  // Renamed section, and no residual "routes to" framing.
  assert.match(html, /Legacy live provider preferences/);
  assert.ok(!/\broutes to\b/i.test(html), "markup still says a task 'routes to' a provider");
  assert.ok(!/will use model/i.test(html), "markup still claims a provider 'will use' a model");
});

// --- Phases 5 and 6: live vs shadow ----------------------------------------

test("14/15/16. the live router is labeled D-004C1, the shadow router D-004D, and shadow is marked non-executing", () => {
  assert.match(appJs, /"Engine", "PARAGON-D-004C1"/);
  assert.match(appJs, /"Engine", "PARAGON-D-004D"/);
  assert.match(appJs, /Affects provider execution/);
  assert.match(appJs, /Additional provider calls/);
  assert.match(appJs, /PARAGON-D-004C1 currently determines real execution/);
  assert.match(appJs, /PARAGON-D-004D is advisory only/);
  assert.match(html, /router-engine-tag shadow">advisory/);
  assert.match(html, /router-engine-tag live">executes/);
});

test("17. latest live and shadow winners are displayed independently", () => {
  assert.match(appJs, /"Latest live winner"/);
  assert.match(appJs, /"Latest shadow winner"/);
  assert.match(appJs, /"Latest shadow confidence"/);
  // And per-provider, on the card.
  assert.match(appJs, /lastLiveModel/);
  assert.match(appJs, /lastShadowModel/);
});

test("6b. live and shadow settings are separate panels, not one ambiguous Routing panel", () => {
  assert.match(html, /Live routing &amp; enforcement settings — PARAGON-D-004C1/);
  assert.match(html, /Shadow routing settings — PARAGON-D-004D/);
  assert.match(html, /Deprecated compatibility fields/);
  // Only real shadow inputs are exposed.
  for (const id of [
    "shadow-setting-quota-scarcity",
    "shadow-setting-context-threshold",
    "shadow-setting-min-samples",
    "shadow-setting-max-attempts",
    "shadow-setting-retention-days"
  ]) {
    assert.ok(html.includes(`id="${id}"`), `missing real shadow setting control: ${id}`);
  }
  // Mode is shown but not settable — activation is a separate directive.
  assert.match(html, /id="shadow-setting-mode" readonly/);
});

// --- Phases 18, 19, 22: integrity guardrails -------------------------------

test("18. no UI path restores fallback.staticDefault", () => {
  // The dashboard may *report* that the static default is disabled (it reads
  // liveRouter.staticDefaultFallback for exactly that). What it must not do is
  // reference the removed reason code or the removed attempt builder.
  assert.ok(!/fallback\.staticDefault/.test(appJs), "the dashboard references the removed fallback.staticDefault reason code");
  assert.ok(!/fallback\.staticDefault/.test(html), "the markup references the removed fallback.staticDefault reason code");
  assert.match(appJs, /"Static default fallback".*"disabled"/s, "the dashboard should state that the static default is disabled");

  const serverSrc = ["src/openaiApi.js", "src/routing/router.js", "src/providerFallback.js"]
    .map((rel) => fs.readFileSync(path.join(repoRoot, rel), "utf8"))
    .join("\n");
  assert.ok(
    !/reasonCode\s*[:=]\s*["'`]fallback\.staticDefault/.test(serverSrc),
    "the backend can emit the removed fallback.staticDefault reason code again"
  );
  const providerFallback = fs.readFileSync(path.join(repoRoot, "src/providerFallback.js"), "utf8");
  assert.ok(!/export function buildProviderAttempts/.test(providerFallback), "the removed config-derived attempt builder is back");
});

test("19. no UI path bypasses catalog eligibility", () => {
  // Every model the dashboard can act on comes from a catalog endpoint; there
  // is no client-side list of models used for routing.
  assert.ok(!/providerConfig\.models\b/.test(appJs), "the dashboard still reads providerConfig.models for a routing control");
  assert.match(appJs, /\/api\/routing\/providers/);
  assert.match(appJs, /\/api\/model-catalog/);
});

/**
 * The repo-wide guard against the removed legacy router already lives in
 * routingIntegrity.test.js ("25. no ... files or references exist in shipped
 * source") and is scoped to src/, test/ and public/. Duplicating that walk
 * here would only add a second thing to maintain — and a broader walk trips
 * over docs/evidence/PARAGON-D-002C-CUTOVER.md, which legitimately records
 * that router's *removal*. What is worth asserting separately is that this
 * directive's own new files are clean, since they are the ones a reviewer has
 * not seen before.
 *
 * The banned name is assembled from fragments rather than written out, so this
 * file does not itself trip the repo-wide guard that walks test/.
 */
const BANNED_ROUTER_PATTERN = new RegExp(["smart", "[-_]?", "route"].join(""), "i");

test("22. nothing this directive added references the removed legacy router", () => {
  const added = [
    "src/routing/routeActivity.js",
    "src/routing/providerSummary.js",
    "src/deprecatedConfig.js",
    "src/providerAvatars.js",
    "public/app.js",
    "public/index.html",
    "public/styles.css"
  ];
  for (const rel of added) {
    const source = fs.readFileSync(path.join(repoRoot, rel), "utf8");
    assert.ok(!BANNED_ROUTER_PATTERN.test(source), `${rel} references the removed legacy router`);
  }
});

// --- New modules ------------------------------------------------------------

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
  const config = { providers: { p: { enabled: true, label: "P", model: "good-a" } }, modelCatalog: { validationTtlHours: 24 } };

  const [summary] = buildProviderRoutingSummaries(config, { p: { ok: true } }, catalog);
  assert.equal(summary.catalogState, "assessed");
  assert.equal(summary.counts.eligible, 2, "the embedding model must not count as eligible");
  assert.equal(summary.counts.validated, 2);
  assert.equal(summary.counts.exposed, 1);
  assert.equal(summary.counts.blocked, 2);
  assert.equal(summary.health, "healthy");
  assert.equal(summary.selection, "automatic-per-request");
  // Reported for transparency, explicitly labeled as the deprecated field.
  assert.equal(summary.deprecatedConfiguredModel, "good-a");
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

test("routeActivity records observed live and shadow choices without carrying prompt text", () => {
  const store = createRouteActivityStore();
  assert.equal(store.lastLive("claude"), null);

  store.recordLivePlan({
    taskType: "code",
    attemptPlan: [
      { order: 1, provider: "claude", model: "claude-sonnet-5" },
      { order: 2, provider: "codex", model: "gpt-5.4" }
    ],
    at: "2026-07-29T12:00:00.000Z"
  });
  store.recordExecuted({ provider: "claude", model: "claude-sonnet-5", at: "2026-07-29T12:00:00.000Z" });
  store.recordShadow({
    provider: "codex",
    model: "gpt-5.4-mini",
    reasoningEffort: "low",
    taskProfile: { workType: "implementation", complexity: "moderate", prompt: "SHOULD NOT BE STORED" },
    attemptPlan: [{ order: 1, provider: "codex", providerModelId: "gpt-5.4-mini" }],
    agrees: false,
    at: "2026-07-29T12:00:01.000Z"
  });

  assert.deepEqual(store.lastLive("claude"), { model: "claude-sonnet-5", providerDefault: false, at: "2026-07-29T12:00:00.000Z" });
  assert.equal(store.lastShadow("codex").model, "gpt-5.4-mini");
  assert.equal(store.lastShadow("codex").reasoningEffort, "low");

  const plans = store.plans();
  assert.equal(plans.live.engine, "paragon-d-004c1");
  assert.equal(plans.live.plan.length, 2);
  assert.equal(plans.shadow.engine, "paragon-d-004d");
  assert.equal(plans.shadow.plan[0].model, "gpt-5.4-mini", "providerModelId must normalize to model");
  assert.equal(plans.shadow.agrees, false);

  // The only task-shape fields retained are the derived ones — the prompt
  // field passed in above must not survive anywhere in the serialized store.
  const serialized = JSON.stringify(plans);
  assert.ok(!serialized.includes("SHOULD NOT BE STORED"), "routeActivity retained prompt text");
  assert.equal(plans.shadow.taskProfile.workType, "implementation");
  assert.ok(!("prompt" in plans.shadow.taskProfile));
});

test("routeActivity is bounded — one record per provider, replaced not appended", () => {
  const store = createRouteActivityStore();
  for (let i = 0; i < 500; i += 1) {
    store.recordExecuted({ provider: "claude", model: `model-${i}` });
    store.recordLivePlan({ attemptPlan: [{ order: 1, provider: "claude", model: `model-${i}` }] });
  }
  assert.equal(store.lastLive("claude").model, "model-499");
  assert.equal(store.plans().live.plan.length, 1);
});

test("routeActivity caps an implausibly long attempt plan", () => {
  const store = createRouteActivityStore();
  store.recordLivePlan({
    attemptPlan: Array.from({ length: 100 }, (_, i) => ({ order: i + 1, provider: "p", model: `m${i}` }))
  });
  assert.ok(store.plans().live.plan.length <= 12);
});

/**
 * A plan is a decision; an execution is an outcome. A request can be planned
 * and then refused by a live-enforcement gate before any provider runs, so
 * recording a plan must never imply that a model was used.
 */
test("routeActivity keeps a planned route distinct from an executed one", () => {
  const store = createRouteActivityStore();
  store.recordLivePlan({ taskType: "code", attemptPlan: [{ order: 1, provider: "claude", model: "claude-sonnet-5" }] });
  assert.ok(store.plans().live, "the plan should be recorded");
  assert.equal(store.lastLive("claude"), null, "a plan alone must not claim a model was used");

  // Fallback moved execution to the second attempt: the card must report the
  // executor, not the original pick.
  store.recordExecuted({ provider: "codex", model: "gpt-5.4" });
  assert.equal(store.lastLive("claude"), null);
  assert.equal(store.lastShadow("codex"), null);
  assert.equal(store.lastLive("codex").model, "gpt-5.4");
});

test("deprecation metadata covers exactly the three retired controls and never claims authority", () => {
  assert.deepEqual(
    DEPRECATED_CONFIG_FIELDS.map((f) => f.path).sort(),
    ["providers.*.model", "routing.defaultProvider", "routing.fallbackChain"]
  );
  for (const field of DEPRECATED_CONFIG_FIELDS) {
    assert.equal(field.status, "deprecated");
    assert.equal(field.retainedForBackwardCompatibility, true);
    assert.equal(field.authoritativeForLiveRouting, false);
    assert.equal(field.hiddenFromPrimaryDashboard, true);
    assert.match(field.scheduledRemoval, /migration/);
    assert.ok(field.supersededBy && field.reason, `${field.path} must say what replaced it and why`);
  }
  // taskRoutes is still read by the live scorer, so it must NOT be listed as
  // deprecated — it is listed as an active-but-misrepresented preference.
  assert.deepEqual(ACTIVE_BUT_MISREPRESENTED_FIELDS.map((f) => f.path), ["routing.taskRoutes"]);
  assert.equal(ACTIVE_BUT_MISREPRESENTED_FIELDS[0].notARoute, true);
});

test("avatar decoding trusts magic bytes, not the client-declared mime type", () => {
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

test("avatar provider ids are validated before being used as a filename", () => {
  assert.equal(isValidProviderId("lmstudio"), true);
  assert.equal(isValidProviderId("my-provider-2"), true);
  assert.equal(isValidProviderId("../../etc/passwd"), false);
  assert.equal(isValidProviderId("Upper"), false);
  assert.equal(isValidProviderId(""), false);
});

test("every bundled provider avatar referenced by the dashboard exists on disk", () => {
  const referenced = [...appJs.matchAll(/"(\/avatars\/[a-z0-9-]+\.webp)"/g)].map((m) => m[1]);
  assert.ok(referenced.length >= 5, "expected bundled avatars for the shipped providers");
  for (const ref of referenced) {
    assert.ok(fs.existsSync(path.join(repoRoot, "public", ref)), `missing bundled avatar asset: ${ref}`);
  }
});

test("provider cards render an avatar column sized to the full card height", () => {
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
