import path from "node:path";

const PRODUCTION_DATA_DIR = path.resolve(process.cwd(), "data");

/**
 * Runtime data directory. Tests must set SMARTROUTE_DATA_DIR (or ROUTERBOT_DATA_DIR)
 * to a temp path before any write.
 */
export function getDataDir() {
  const override = process.env.SMARTROUTE_DATA_DIR || process.env.ROUTERBOT_DATA_DIR;
  if (override) {
    return path.resolve(override);
  }
  return PRODUCTION_DATA_DIR;
}

export function getProductionDataDir() {
  return PRODUCTION_DATA_DIR;
}

export function isTestProcess() {
  return process.env.NODE_ENV === "test" || process.env.SMARTROUTE_TEST === "1";
}

/**
 * Refuse writes into the live production data/ tree during tests.
 */
export function assertNotProductionWrite(targetPath) {
  if (!isTestProcess()) {
    return;
  }
  const resolved = path.resolve(targetPath);
  const prod = getProductionDataDir();
  if (resolved === prod || resolved.startsWith(`${prod}${path.sep}`)) {
    throw new Error(
      `Refusing to write production SmartRoute data path during tests: ${resolved}`
    );
  }
}

export function buildModelPaths(dataDir = getDataDir()) {
  return {
    current: path.join(dataDir, "model-intelligence-current.json"),
    historyDir: path.join(dataDir, "model-intelligence-history"),
    refreshLog: path.join(dataDir, "model-refresh-log.jsonl"),
    pricingCache: path.join(dataDir, "model-pricing-cache.json"),
    pricingCatalog: path.join(dataDir, "model-pricing-openrouter-catalog.json"),
    benchmarkCache: path.join(dataDir, "model-benchmark-cache.json"),
    providerHealth: path.join(dataDir, "model-provider-health.json"),
    pricingOverrides: path.join(dataDir, "model-pricing-overrides.json"),
    decisionLog: path.join(dataDir, "smart-route-log.jsonl"),
    canaryState: path.join(dataDir, "smart-route-canary-state.json"),
    liveGuardState: path.join(dataDir, "smart-route-live-guard-state.json"),
    modelsRegistry: path.join(dataDir, "models.json"),
    config: path.join(dataDir, "config.json")
  };
}

export function buildResearchPaths(dataDir = getDataDir()) {
  return {
    sourcesRoot: path.join(dataDir, "research-sources"),
    current: path.join(dataDir, "model-research-current.json"),
    historyDir: path.join(dataDir, "model-research-history"),
    pricingEvidence: path.join(dataDir, "model-pricing-evidence.json"),
    benchmarkEvidence: path.join(dataDir, "model-benchmark-evidence.json"),
    researchLog: path.join(dataDir, "model-research-log.jsonl"),
    providerSources: path.join(dataDir, "provider-pricing-sources.json")
  };
}

/** Live-updating path map (respects SMARTROUTE_DATA_DIR changes). */
export const PATHS = new Proxy(
  {},
  {
    get(_target, prop) {
      if (typeof prop !== "string") return undefined;
      return buildModelPaths()[prop];
    },
    ownKeys() {
      return Object.keys(buildModelPaths());
    },
    getOwnPropertyDescriptor(_target, prop) {
      const value = buildModelPaths()[prop];
      if (value === undefined) return undefined;
      return { configurable: true, enumerable: true, value };
    }
  }
);

export const RESEARCH_PATHS = new Proxy(
  {},
  {
    get(_target, prop) {
      if (typeof prop !== "string") return undefined;
      return buildResearchPaths()[prop];
    },
    ownKeys() {
      return Object.keys(buildResearchPaths());
    },
    getOwnPropertyDescriptor(_target, prop) {
      const value = buildResearchPaths()[prop];
      if (value === undefined) return undefined;
      return { configurable: true, enumerable: true, value };
    }
  }
);
