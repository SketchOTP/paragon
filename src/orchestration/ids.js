import crypto from "node:crypto";

const ID_PATTERN = /^[a-z]+_[0-9a-f]{24}$/;

const PREFIXES = {
  job: "job",
  session: "sess",
  run: "run",
  attempt: "att",
  checkpoint: "ckpt",
  decision: "dec"
};

/** Collision-resistant, locally generated — no secrets or user content encoded. */
export function generateId(kind) {
  const prefix = PREFIXES[kind];
  if (!prefix) {
    throw new Error(`Unknown id kind: ${kind}`);
  }
  return `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
}

export function isValidId(id) {
  return typeof id === "string" && ID_PATTERN.test(id);
}

/** Returns the supplied id if structurally valid, otherwise a freshly generated one. */
export function acceptOrGenerateId(kind, supplied) {
  if (supplied != null && isValidId(supplied)) {
    return supplied;
  }
  return generateId(kind);
}
