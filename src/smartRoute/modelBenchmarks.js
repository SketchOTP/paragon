import fs from "node:fs/promises";
import { PATHS } from "./modelSnapshotStore.js";

const SWE_BENCH = {
  "claude-opus-4-6": { swe_bench_verified_resolved: 72.5, swe_bench_avg_cost: 0.12 },
  "claude-sonnet-4-6": { swe_bench_verified_resolved: 56.2, swe_bench_avg_cost: 0.05 },
  "gpt-5.4": { swe_bench_verified_resolved: 54.0, swe_bench_avg_cost: 0.06 },
  "gpt-5.4-mini": { swe_bench_verified_resolved: 42.0, swe_bench_avg_cost: 0.02 },
  "gpt-5-mini": { swe_bench_verified_resolved: 38.0, swe_bench_avg_cost: 0.015 },
  "codex:default": { swe_bench_verified_resolved: 50.0, swe_bench_avg_cost: 0.04 }
};

const DEFAULT_PARAGON_EVAL = {
  chat: 0.55,
  rewrite: 0.6,
  summarize: 0.62,
  extract_json: 0.58,
  code: 0.5,
  code_debug: 0.52,
  architecture: 0.48
};

export async function loadBenchmarkCache() {
  try {
    const raw = await fs.readFile(PATHS.benchmarkCache, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

export async function saveBenchmarkCache(cache) {
  await fs.mkdir(PATHS.benchmarkCache.replace(/[^/]+$/, ""), { recursive: true });
  await fs.writeFile(PATHS.benchmarkCache, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

export async function enrichModelBenchmarks(models) {
  const cache = await loadBenchmarkCache();
  const now = new Date().toISOString();
  const nextCache = { ...cache };

  const enriched = models.map((row) => {
    const benchmarks = resolveBenchmarks(row, cache, now);
    nextCache[row.canonical_id] = benchmarks;
    return { ...row, benchmarks };
  });

  await saveBenchmarkCache(nextCache);
  return enriched;
}

function resolveBenchmarks(row, cache, now) {
  if (cache[row.canonical_id]) {
    return { ...cache[row.canonical_id], benchmark_last_checked: now };
  }

  const key = row.canonical_id;
  const modelKey = String(row.model ?? "default").toLowerCase();
  const exact = SWE_BENCH[key] ?? SWE_BENCH[modelKey];
  const fuzzy = exact ? null : fuzzySweBench(modelKey);

  const swe = exact ?? fuzzy?.data ?? null;
  const confidence = exact ? 1 : fuzzy ? fuzzy.confidence : 0.35;

  const paragon_eval = { ...DEFAULT_PARAGON_EVAL };
  if (row.provider === "antigravity") {
    paragon_eval.chat = 0.5;
    paragon_eval.rewrite = 0.52;
    paragon_eval.summarize = 0.54;
    paragon_eval.extract_json = 0.48;
  }
  if (row.local) {
    for (const k of Object.keys(paragon_eval)) {
      paragon_eval[k] = Math.max(0.35, paragon_eval[k] - 0.1);
    }
  }

  return {
    swe_bench_verified_resolved: swe?.swe_bench_verified_resolved ?? null,
    swe_bench_avg_cost: swe?.swe_bench_avg_cost ?? null,
    coding_index: null,
    intelligence_index: null,
    paragon_eval,
    benchmark_sources: exact ? ["swebench", "paragon_eval"] : ["paragon_eval"],
    benchmark_last_checked: now,
    benchmark_confidence: confidence
  };
}

function fuzzySweBench(modelKey) {
  for (const [name, data] of Object.entries(SWE_BENCH)) {
    const base = name.replace(/^[^:]+:/, "");
    if (modelKey.includes("mini") && base.includes("mini")) {
      return { data, confidence: 0.55 };
    }
    if (modelKey.includes("opus") && base.includes("opus")) {
      return { data, confidence: 0.6 };
    }
    if (modelKey.includes("sonnet") && base.includes("sonnet")) {
      return { data, confidence: 0.6 };
    }
  }
  return null;
}

export function taskQualityScore(benchmarks, taskType) {
  const evals = benchmarks?.paragon_eval ?? {};
  const codingTasks = new Set(["code", "code_debug", "architecture"]);

  if (codingTasks.has(taskType)) {
    const swe = benchmarks?.swe_bench_verified_resolved;
    const sweNorm = swe != null ? swe / 100 : 0;
    const evalScore = evals[taskType] ?? evals.code ?? 0.5;
    return swe != null ? sweNorm * 0.6 + evalScore * 0.4 : evalScore;
  }

  const evalKey = taskType === "extract" ? "extract_json" : taskType;
  return evals[evalKey] ?? evals.chat ?? 0.5;
}

export function usesSweBenchForTask(taskType) {
  return ["code", "code_debug", "architecture"].includes(taskType);
}

export function benchmarkMatchConfidence(benchmarks, modelKey, referenceKey) {
  if (modelKey === referenceKey) {
    return 1;
  }
  return benchmarks?.benchmark_confidence ?? 0.5;
}
