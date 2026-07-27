import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { addLog } from "../logStore.js";
import { buildShadowReport } from "./shadowReport.js";
import { assertNotProductionWrite, getDataDir, PATHS } from "./dataPaths.js";

function getLogPath() {
  return PATHS.decisionLog;
}

const maxFileBytes = 5 * 1024 * 1024;

export async function logRoutingDecision(record) {
  const entry = {
    request_id: record.requestId ?? crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    ...record
  };

  addLog({
    type: "smart_route",
    provider: record.selected_provider ?? record.selectedProvider ?? "routerbot",
    level: "info",
    message: formatLogMessage(entry)
  });

  try {
    const logPath = getLogPath();
    assertNotProductionWrite(logPath);
    await fs.mkdir(getDataDir(), { recursive: true });
    await rotateIfNeeded();
    await fs.appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (error) {
    console.warn("SmartRoute log write failed:", error.message);
  }

  return entry;
}

function formatLogMessage(entry) {
  const smart = entry.smart_provider
    ? `${entry.smart_provider}/${entry.smart_model ?? ""}`
    : "n/a";
  const legacy = entry.legacy_provider ?? "n/a";
  const match = entry.shadow_match === true ? "match" : entry.shadow_match === false ? "diff" : "n/a";
  return `smart=${smart} legacy=${legacy} shadow=${match} task=${entry.task_type ?? "n/a"}`;
}

async function rotateIfNeeded() {
  const logPath = getLogPath();
  try {
    const stat = await fs.stat(logPath);
    if (stat.size < maxFileBytes) {
      return;
    }
    const rotated = `${logPath}.${Date.now()}.bak`;
    assertNotProductionWrite(rotated);
    await fs.rename(logPath, rotated);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

export async function readRecentDecisions(limit = 100) {
  const all = await readAllDecisions();
  return all.slice(-limit);
}

export async function readAllDecisions() {
  try {
    const raw = await fs.readFile(getLogPath(), "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export function summarizeDecisions(decisions, registry = []) {
  return buildShadowReport(decisions, registry);
}

export async function appendDecisionFeedback(requestId, feedback) {
  const decisions = await readAllDecisions();
  let updated = false;
  const next = decisions.map((row) => {
    if (row.request_id !== requestId || row.type === "feedback") {
      return row;
    }
    updated = true;
    return {
      ...row,
      user_feedback: feedback.type ?? feedback,
      feedback_note: feedback.note ?? null,
      feedback_at: new Date().toISOString()
    };
  });

  if (!updated) {
    return false;
  }

  const logPath = getLogPath();
  assertNotProductionWrite(logPath);
  await fs.mkdir(getDataDir(), { recursive: true });
  await fs.writeFile(logPath, `${next.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  return true;
}
