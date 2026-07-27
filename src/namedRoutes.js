/** OpenAI-compatible named routes for legacy mode (cheap / review / research / fallback). */

export const NAMED_ROUTE_IDS = ["cheap", "review", "research", "fallback"];

export function resolveNamedRouteProvider(model, config) {
  const routes = config.routing?.namedRoutes ?? {};
  const key = String(model ?? "").toLowerCase();
  if (!NAMED_ROUTE_IDS.includes(key)) {
    return null;
  }
  const provider = routes[key];
  if (!provider) {
    return null;
  }
  return { routeName: key, provider };
}

export function listNamedRouteModels(config) {
  const routes = config.routing?.namedRoutes ?? {};
  return NAMED_ROUTE_IDS.filter((id) => routes[id]).map((id) => ({
    id,
    object: "model",
    created: 0,
    owned_by: "routerbot"
  }));
}
