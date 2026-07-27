#!/usr/bin/env node
/**
 * Multi-provider cheap-task probe — one minimal request per provider family.
 * Exercises claude, codex, cursor, antigravity, lmstudio directly (not single-winner SmartRoute).
 */
import { readConfig } from "../src/configStore.js";
import { readCurrentSnapshot } from "../src/smartRoute/modelSnapshotStore.js";
import { rankModelsForTask } from "../src/smartRoute/modelRanker.js";
import { runProvider } from "../src/cli.js";
import { classifyProviderRunResult } from "../src/smartRoute/providerResult.js";

const PROMPT = "Reply with one word: ok";
const TASK = "rewrite";
const maxTokensNote = "minimal probe prompt";
const providers = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const json = process.argv.includes("--json");

async function pickBestModel(snapshot, provider) {
  const ranked = rankModelsForTask(snapshot.models, TASK, { costSensitive: true });
  const match = ranked.find((r) => r.model.provider === provider);
  if (match) {
    return {
      canonical_id: match.model.canonical_id,
      model: match.model.model,
      global_rank: ranked.findIndex((r) => r.model.canonical_id === match.model.canonical_id) + 1
    };
  }
  const config = await readConfig();
  const cfg = config.providers?.[provider];
  if (!cfg?.enabled) {
    return null;
  }
  return { canonical_id: `${provider}:${cfg.model || "default"}`, model: cfg.model || "default", global_rank: null };
}

async function main() {
  const config = await readConfig();
  const snapshot = await readCurrentSnapshot();
  if (!snapshot?.models?.length) {
    console.error("No snapshot");
    process.exit(1);
  }

  const targetProviders =
    providers.length > 0
      ? providers
      : Object.entries(config.providers ?? {})
          .filter(([, c]) => c.enabled !== false)
          .map(([name]) => name)
          .filter((p) => ["claude", "codex", "cursor", "antigravity", "lmstudio"].includes(p));

  const results = [];

  for (const provider of targetProviders) {
    const pick = await pickBestModel(snapshot, provider);
    if (!pick) {
      results.push({ provider, skipped: true, reason: "disabled_or_missing" });
      continue;
    }

    const providerConfig = { ...config.providers[provider], model: pick.model };
    process.stdout.write(`${provider} (${pick.canonical_id})... `);
    const started = Date.now();
    try {
      const result = await runProvider(provider, providerConfig, PROMPT);
      const check = classifyProviderRunResult(result, null, { requireContent: true });
      const ms = Date.now() - started;
      console.log(check.ok ? `OK ${ms}ms` : `FAIL ${check.failure_category}`);
      results.push({
        provider,
        canonical_id: pick.canonical_id,
        model: pick.model,
        global_rank_for_rewrite: pick.global_rank,
        ok: check.ok,
        latency_ms: ms,
        failure_category: check.failure_category ?? null,
        stdout_preview: (result.stdout ?? "").slice(0, 80)
      });
    } catch (error) {
      console.log(`ERROR ${error.message}`);
      results.push({
        provider,
        canonical_id: pick.canonical_id,
        ok: false,
        error: error.message
      });
    }
  }

  if (json) {
    console.log(JSON.stringify({ task: TASK, prompt: PROMPT, results }, null, 2));
    return;
  }

  const ok = results.filter((r) => r.ok).length;
  console.log(`\n${ok}/${results.length} providers responded (${maxTokensNote})`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
