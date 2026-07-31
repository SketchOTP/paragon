import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export function evidenceRecord(input) {
  const rawRecordHash = input.rawRecordHash ?? crypto.createHash("sha256").update(JSON.stringify(input.raw ?? input)).digest("hex");
  return { ...input, rawRecordHash, fetchedAt: input.fetchedAt ?? new Date().toISOString(), attributionRequired: input.attributionRequired ?? false };
}

export function createEvidenceStore({ filePath = path.resolve(process.cwd(), "data/evidence.json") } = {}) {
  let state = { version: 1, records: [], updatedAt: null };
  return {
    snapshot: () => structuredClone(state),
    replace(records) { state = { version: 1, records: records.map(evidenceRecord), updatedAt: new Date().toISOString() }; return this.snapshot(); },
    add(records) { return this.replace([...state.records, ...(Array.isArray(records) ? records : [records])]); },
    async load() { try { state = JSON.parse(await fs.readFile(filePath, "utf8")); } catch (e) { if (e.code !== "ENOENT") throw e; } return this.snapshot(); },
    async save() { await fs.mkdir(path.dirname(filePath), { recursive: true }); const tmp = `${filePath}.${process.pid}.tmp`; await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`); await fs.rename(tmp, filePath); return this.snapshot(); }
  };
}

export function usableEvidence(records, { now = Date.now(), maxAgeMs = 48 * 60 * 60 * 1000 } = {}) {
  return (records ?? []).filter((r) => !r.expiresAt || Date.parse(r.expiresAt) >= now).filter((r) => !r.fetchedAt || now - Date.parse(r.fetchedAt) <= maxAgeMs);
}
