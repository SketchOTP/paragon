#!/usr/bin/env node
/**
 * Live SmartRoute trial — sends mixed prompts through RouterBot /v1/chat/completions.
 * Usage: node scripts/smart-route-trial.js [--limit N] [--base URL] [--key KEY]
 */
import fs from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const limitIdx = args.indexOf("--limit");
const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : 30;
const baseIdx = args.indexOf("--base");
const baseUrl = baseIdx >= 0 ? args[baseIdx + 1] : "http://127.0.0.1:4117";
const keyIdx = args.indexOf("--key");
const apiKey = keyIdx >= 0 ? args[keyIdx + 1] : (process.env.PARAGON_API_KEY ?? process.env.ROUTERBOT_API_KEY ?? "paragon");

const TRIAL_PROMPTS = [
  { id: "chat-1", category: "simple_chat", message: "Say hello in one friendly sentence." },
  { id: "chat-2", category: "simple_chat", message: "What is 17 + 28?" },
  {
    id: "rewrite-1",
    category: "rewrite",
    message: "Rewrite this more professionally: hey can u send the file asap thx"
  },
  {
    id: "rewrite-2",
    category: "rewrite",
    message: "Rephrase without changing meaning: The deployment failed because the config was wrong."
  },
  {
    id: "summarize-1",
    category: "summarize",
    message:
      "Summarize in 2 bullets: SmartRoute uses deterministic gates, a cheap classifier, and a policy scorer to pick models."
  },
  {
    id: "summarize-2",
    category: "summarize",
    message: "TL;DR this paragraph: Canary mode routes a small percent of safe traffic actively while logging shadow decisions."
  },
  {
    id: "extract-1",
    category: "extract",
    message: 'Extract as bullet list: Name: Dana Lee; Role: SRE; Email: dana@example.com; Team: Platform.'
  },
  {
    id: "extract-2",
    category: "extract",
    message: "Extract the three action items from: Ship v2 API, fix auth bug, write runbook by Friday."
  },
  {
    id: "long-1",
    category: "planning",
    message:
      "We run a Node.js OpenAI-compatible router with Claude, Codex, Cursor, Antigravity, and LMStudio backends. " +
      "Traffic mixes chat, code, planning, and batch jobs. Design a phased rollout plan for SmartRoute balanced mode " +
      "that includes shadow evaluation, canary, budget caps, escalation on validation failure, and rollback triggers. " +
      "Include risks, metrics to watch, and a week-by-week checklist for a solo maintainer."
  },
  {
    id: "code-1",
    category: "code_generation",
    message: "Write a Python function `is_palindrome(s: str) -> bool` with a docstring."
  },
  {
    id: "code-2",
    category: "code_generation",
    message: "Implement a TypeScript function that debounces another function by 300ms."
  },
  {
    id: "debug-1",
    category: "code_debug",
    message: "Why does this fail? `def avg(nums): return sum(nums)/len(nums); print(avg([]))`"
  },
  {
    id: "debug-2",
    category: "code_debug",
    message: "Fix the bug: for i in range(len(arr)): if arr[i] > arr[i+1]: swap — IndexError on last element."
  },
  {
    id: "arch-1",
    category: "architecture",
    message: "Outline a microservices architecture for a multi-tenant SaaS billing system."
  },
  {
    id: "arch-2",
    category: "architecture",
    message: "Compare event-driven vs request-response for an order fulfillment workflow."
  },
  {
    id: "research-1",
    category: "research",
    message: "Compare Redis vs Memcached for session caching in a Node.js API."
  },
  {
    id: "research-2",
    category: "research",
    message: "What are tradeoffs between SQLite and Postgres for a local-first app?"
  },
  {
    id: "plan-1",
    category: "planning",
    message: "Create a 6-week plan to migrate a Django monolith to services with minimal downtime."
  },
  {
    id: "plan-2",
    category: "planning",
    message: "Break down steps to add OAuth2 login to an existing Express API."
  },
  {
    id: "json-1",
    category: "structured_json",
    message: 'Return JSON only: {"task":"demo","priority":"low","estimate_hours":2}',
    response_format: { type: "json_object" }
  },
  {
    id: "json-2",
    category: "structured_json",
    message: 'Extract fields as JSON: "Meeting with Alex on Friday at 3pm about Q3 roadmap."',
    response_format: { type: "json_object" }
  },
  { id: "chat-3", category: "simple_chat", message: "Give one tip for better commit messages." },
  {
    id: "summarize-3",
    category: "summarize",
    message: "Summarize the difference between shadow_test and balanced routing modes."
  },
  {
    id: "code-3",
    category: "code_generation",
    message: "Write a bash one-liner to count lines in all .js files recursively."
  },
  {
    id: "debug-3",
    category: "code_debug",
    message: "Diagnose: TypeError: Cannot read properties of undefined (reading 'map') in React render."
  },
  {
    id: "arch-3",
    category: "architecture",
    message: "Design API gateway responsibilities for RouterBot-style LLM routing."
  },
  {
    id: "research-3",
    category: "research",
    message: "Research-style summary: when does model routing save money vs hurt quality?"
  },
  {
    id: "plan-3",
    category: "planning",
    message: "Plan a rollout from shadow_test to canary to balanced for SmartRoute."
  },
  {
    id: "rewrite-3",
    category: "rewrite",
    message: "Make this clearer: RouterBot picks providers using gates then classifier then scorer."
  },
  {
    id: "chat-4", category: "simple_chat", message: "Explain what an API gateway does in one sentence."
  },
  {
    id: "code-4",
    category: "code_generation",
    message: "Create a minimal Express health check endpoint in JavaScript."
  },
  {
    id: "debug-4",
    category: "code_debug",
    message: "Stack trace shows NullPointerException in Java getter — list 3 likely causes."
  },
  {
    id: "json-3",
    category: "structured_json",
    message: 'JSON array of 3 task types suitable for cheap models: ["...", "...", "..."]',
    response_format: { type: "json_object" }
  }
];

const resultsPath = path.resolve("data/smart-route-trial-results.jsonl");

async function sendPrompt(promptDef, index) {
  const body = {
    model: "paragon",
    messages: [{ role: "user", content: promptDef.message }],
    max_tokens: 512,
    stream: false
  };
  if (promptDef.response_format) {
    body.response_format = promptDef.response_format;
  }

  const started = Date.now();
  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "X-RouterBot-Dev": "1"
      },
      body: JSON.stringify(body)
    });

    const durationMs = Date.now() - started;
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text.slice(0, 500) };
    }

    const content = json?.choices?.[0]?.message?.content ?? "";
    const paragon = json?.paragon ?? {};
    const smartRoute = paragon.smartRoute ?? null;

    return {
      index,
      id: promptDef.id,
      category: promptDef.category,
      ok: response.ok,
      status: response.status,
      duration_ms: durationMs,
      provider: paragon.provider ?? null,
      routed_provider: paragon.routedProvider ?? null,
      fallback: paragon.fallback ?? false,
      smart_route: smartRoute,
      content_preview: String(content).slice(0, 120),
      error: json?.error?.message ?? null
    };
  } catch (error) {
    return {
      index,
      id: promptDef.id,
      category: promptDef.category,
      ok: false,
      status: 0,
      duration_ms: Date.now() - started,
      error: error.message
    };
  }
}

async function reloadConfig() {
  const config = JSON.parse(await fs.readFile("data/config.json", "utf8"));
  const response = await fetch(`${baseUrl}/api/config`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(config)
  });
  if (!response.ok) {
    throw new Error(`Config reload failed: ${response.status}`);
  }
}

async function main() {
  const selected = TRIAL_PROMPTS.slice(0, Math.min(limit, TRIAL_PROMPTS.length));
  console.log(`SmartRoute live trial: ${selected.length} requests → ${baseUrl}`);

  try {
    await reloadConfig();
    console.log("Config pushed to running server (mode=balanced)");
  } catch (error) {
    console.warn(`Config push skipped: ${error.message}`);
  }

  const results = [];
  for (let i = 0; i < selected.length; i += 1) {
    const prompt = selected[i];
    process.stdout.write(`[${i + 1}/${selected.length}] ${prompt.id} (${prompt.category})... `);
    const result = await sendPrompt(prompt, i + 1);
    results.push(result);
    await fs.appendFile(resultsPath, `${JSON.stringify(result)}\n`, "utf8");
    console.log(result.ok ? `${result.provider ?? "?"} ${result.duration_ms}ms` : `FAIL ${result.error}`);
  }

  const ok = results.filter((r) => r.ok).length;
  console.log(`\nDone: ${ok}/${results.length} succeeded. Results: ${resultsPath}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
