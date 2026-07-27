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

test("default config has no smartRoute section", () => {
  assert.equal(defaultConfig.routing.smartRoute, undefined);
});
