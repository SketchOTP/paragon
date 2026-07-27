import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "../src/defaultConfig.js";
import { resolveNamedRouteProvider, listNamedRouteModels, NAMED_ROUTE_IDS } from "../src/namedRoutes.js";

test("named routes resolve four model names", () => {
  for (const id of NAMED_ROUTE_IDS) {
    const hit = resolveNamedRouteProvider(id, defaultConfig);
    assert.ok(hit, `missing named route ${id}`);
    assert.equal(hit.routeName, id);
    assert.ok(defaultConfig.providers[hit.provider]?.enabled !== false);
  }
});

test("listNamedRouteModels exposes all four ids", () => {
  const models = listNamedRouteModels(defaultConfig);
  assert.equal(models.length, 4);
  assert.deepEqual(
    models.map((m) => m.id).sort(),
    [...NAMED_ROUTE_IDS].sort()
  );
});

test("default config's smartRoute section defaults to shadow mode, never serving live", () => {
  // PARAGON-D-001 stage 3 (shadow scheduling): smartRoute is instrumented
  // and observed by default, but must never be allowed to serve a live
  // request until an operator explicitly opts into a serving mode.
  assert.equal(defaultConfig.routing.smartRoute.mode, "shadow_test");
  assert.equal(defaultConfig.routing.smartRoute.canary.enabled, false);
});

test("default config's taskRoutes still cover every classifiable task (legacy path unchanged)", () => {
  for (const task of Object.keys(defaultConfig.routing.taskPatterns)) {
    assert.ok(defaultConfig.routing.taskRoutes[task], `no legacy taskRoute for ${task}`);
  }
});
