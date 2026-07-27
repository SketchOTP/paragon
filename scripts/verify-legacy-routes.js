#!/usr/bin/env node
/** Smoke-check named routes: /v1/models + provider resolution. */
import { defaultConfig } from "../src/defaultConfig.js";
import { listNamedRouteModels, resolveNamedRouteProvider, NAMED_ROUTE_IDS } from "../src/namedRoutes.js";

const baseUrl = process.env.ROUTERBOT_BASE_URL ?? "http://127.0.0.1:4117";
const apiKey = process.env.ROUTERBOT_API_KEY ?? "";

const localModels = listNamedRouteModels(defaultConfig);
console.log("configured_named_routes:", localModels.map((m) => m.id).join(", "));

for (const id of NAMED_ROUTE_IDS) {
  const hit = resolveNamedRouteProvider(id, defaultConfig);
  if (!hit) {
    console.error(`FAIL: named route ${id} not configured`);
    process.exit(1);
  }
  console.log(`OK resolve ${id} -> provider ${hit.provider}`);
}

if (!apiKey) {
  console.log("SKIP live /v1/models (set ROUTERBOT_API_KEY to probe running server)");
  process.exit(0);
}

const res = await fetch(`${baseUrl}/v1/models`, {
  headers: { Authorization: `Bearer ${apiKey}` }
});
if (!res.ok) {
  console.error(`FAIL GET /v1/models ${res.status}`);
  process.exit(1);
}
const body = await res.json();
const ids = (body.data ?? []).map((row) => row.id).sort();
console.log("live_models:", ids.join(", "));
for (const id of NAMED_ROUTE_IDS) {
  if (!ids.includes(id)) {
    console.error(`FAIL live models missing ${id}`);
    process.exit(1);
  }
}
console.log("OK routes verified end-to-end");
