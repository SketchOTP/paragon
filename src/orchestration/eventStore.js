import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { redactSecrets } from "./redaction.js";

/**
 * Append-only JSONL event store with a serialized write queue and
 * crash-tolerant recovery. One instance per record kind (jobs, sessions,
 * runs, checkpoints, decisions).
 */
export function createEventStore({ name, dataDir, idField = "id" }) {
  const filePath = path.join(dataDir, `${name}.jsonl`);
  const records = new Map();
  let writeQueue = Promise.resolve();
  let loaded = false;

  function loadSync() {
    records.clear();
    let raw = "";
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        loaded = true;
        return;
      }
      throw error;
    }

    const lines = raw.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const record = JSON.parse(trimmed);
        if (record && record[idField]) {
          records.set(record[idField], record);
        }
      } catch {
        // Corrupt or partially-written final line — isolate and skip it.
      }
    }
    loaded = true;
  }

  function ensureLoaded() {
    if (!loaded) {
      loadSync();
    }
  }

  async function ensureDir() {
    await fsp.mkdir(dataDir, { recursive: true });
  }

  /** Appends (or overwrites, by idField, on next compaction) a redacted record. Serialized to preserve write order. */
  function append(record) {
    ensureLoaded();
    const safe = redactSecrets(record);
    records.set(safe[idField], safe);
    writeQueue = writeQueue
      .then(async () => {
        await ensureDir();
        await fsp.appendFile(filePath, `${JSON.stringify(safe)}\n`, "utf8");
      })
      .catch((error) => {
        console.warn(`orchestration: failed to persist ${name} record: ${error.message}`);
      });
    return writeQueue.then(() => safe);
  }

  function get(id) {
    ensureLoaded();
    return records.get(id);
  }

  function all() {
    ensureLoaded();
    return Array.from(records.values());
  }

  /** Atomic full-state snapshot — compacts append-only history into one file (write tmp, then rename). */
  async function snapshot() {
    ensureLoaded();
    const snapshotDir = path.join(dataDir, "snapshots");
    await fsp.mkdir(snapshotDir, { recursive: true });
    const snapshotPath = path.join(snapshotDir, `${name}-${Date.now()}.json`);
    const tmpPath = `${snapshotPath}.tmp`;
    await fsp.writeFile(tmpPath, JSON.stringify(all(), null, 2), "utf8");
    await fsp.rename(tmpPath, snapshotPath);
    return snapshotPath;
  }

  /** Rewrites the JSONL file to only the current in-memory record set, dropping entries older than retentionDays. */
  async function compactWithRetention(retentionDays) {
    ensureLoaded();
    if (!retentionDays || retentionDays <= 0) {
      return 0;
    }
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const [id, record] of records) {
      const ts = Date.parse(record.createdAt ?? record.startTime ?? record.timestamp ?? 0);
      if (Number.isFinite(ts) && ts < cutoff) {
        records.delete(id);
        removed += 1;
      }
    }
    if (removed > 0) {
      await ensureDir();
      const body = all().map((r) => JSON.stringify(r)).join("\n");
      await fsp.writeFile(filePath, body ? `${body}\n` : "", "utf8");
    }
    return removed;
  }

  function reload() {
    loaded = false;
    ensureLoaded();
  }

  return { append, get, all, snapshot, compactWithRetention, reload, filePath };
}
