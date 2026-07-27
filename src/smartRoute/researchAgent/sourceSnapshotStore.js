import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  assertNotProductionWrite,
  getDataDir,
  RESEARCH_PATHS
} from "../dataPaths.js";

export { RESEARCH_PATHS };

export function dayStamp(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export async function saveSourceSnapshot({
  provider,
  sourceId,
  content,
  contentType = "text/plain",
  status = 200,
  url = null,
  fetchDurationMs = null
}) {
  const day = dayStamp();
  const dir = path.join(RESEARCH_PATHS.sourcesRoot, day);
  assertNotProductionWrite(dir);
  await fs.mkdir(dir, { recursive: true });

  const ext = contentType.includes("json") ? "json" : contentType.includes("html") ? "html" : "txt";
  const safeId = String(sourceId ?? "source").replace(/[^a-zA-Z0-9._-]+/g, "-");
  const filename = `${provider}-${safeId}.${ext}`;
  const filePath = path.join(dir, filename);
  const body = typeof content === "string" ? content : JSON.stringify(content, null, 2);
  const hash = sha256(body);

  assertNotProductionWrite(filePath);
  await fs.writeFile(filePath, body, "utf8");

  const meta = {
    provider,
    source_id: sourceId,
    url,
    path: filePath,
    relative_path: path.relative(getDataDir(), filePath),
    content_type: contentType,
    status,
    fetch_duration_ms: fetchDurationMs,
    source_hash: hash,
    fetched_at: new Date().toISOString(),
    bytes: Buffer.byteLength(body)
  };

  await fs.writeFile(`${filePath}.meta.json`, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  return meta;
}

export async function appendResearchLog(entry) {
  assertNotProductionWrite(RESEARCH_PATHS.researchLog);
  await fs.mkdir(getDataDir(), { recursive: true });
  await fs.appendFile(
    RESEARCH_PATHS.researchLog,
    `${JSON.stringify({ ...entry, at: entry.at ?? new Date().toISOString() })}\n`,
    "utf8"
  );
}

export async function writeJson(filePath, payload) {
  assertNotProductionWrite(filePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

export function catalogHash(catalog) {
  const payload = JSON.stringify({
    generated_at: catalog?.generated_at,
    pricing: catalog?.pricing ?? [],
    models: (catalog?.models ?? []).map((m) => m.canonical_id).sort()
  });
  return sha256(payload);
}
