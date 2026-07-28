const MODERN_PREFIX = "PARAGON_";
const LEGACY_PREFIX = "ROUTERBOT_";

const warnedKeys = new Set();

/**
 * Reads a PARAGON_<name> env var, falling back to the deprecated
 * ROUTERBOT_<name> spelling with a one-time deprecation warning.
 */
export function getEnv(name) {
  const modernKey = `${MODERN_PREFIX}${name}`;
  const modern = process.env[modernKey];
  if (modern !== undefined) {
    return modern;
  }
  const legacyKey = `${LEGACY_PREFIX}${name}`;
  const legacy = process.env[legacyKey];
  if (legacy !== undefined) {
    if (!warnedKeys.has(legacyKey)) {
      warnedKeys.add(legacyKey);
      console.warn(`[paragon] ${legacyKey} is deprecated, use ${modernKey} instead`);
    }
    return legacy;
  }
  return undefined;
}
