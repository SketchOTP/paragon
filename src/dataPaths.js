import path from "node:path";

const PRODUCTION_DATA_DIR = path.resolve(process.cwd(), "data");

/** Runtime data directory. Tests set ROUTERBOT_DATA_DIR to a temp path before writes. */
export function getDataDir() {
  const override = process.env.ROUTERBOT_DATA_DIR || process.env.SMARTROUTE_DATA_DIR;
  if (override) {
    return path.resolve(override);
  }
  return PRODUCTION_DATA_DIR;
}

export function getProductionDataDir() {
  return PRODUCTION_DATA_DIR;
}

export function isTestProcess() {
  return process.env.NODE_ENV === "test";
}

/** Refuse writes into the live production data/ tree during tests. */
export function assertNotProductionWrite(targetPath) {
  if (!isTestProcess()) {
    return;
  }
  const resolved = path.resolve(targetPath);
  const prod = getProductionDataDir();
  if (resolved === prod || resolved.startsWith(`${prod}${path.sep}`)) {
    throw new Error(`Refusing to write production data path during tests: ${resolved}`);
  }
}
