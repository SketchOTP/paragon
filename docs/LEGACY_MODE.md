# PARAGON legacy routing

PARAGON's live request path uses **keyword-based task classification** and a **provider fallback chain** —
this is the same routing behavior RouterBot always had, and it is what actually serves every request today.
Alongside it, an adaptive routing engine now runs in shadow mode by default (see
[../README.md#orchestration-adaptive-routing](../README.md#orchestration-adaptive-routing)) — it computes and
logs what it would have selected but never serves a request. Set `routing.smartRoute.mode` to `"legacy"` to
disable that engine entirely and go back to exactly this document's behavior with zero adaptive overhead.

## How routing works

1. **Explicit override** — `metadata.paragon_task` or `x-paragon-task` header (legacy `paragon_task`/`x-routerbot-task` still accepted)
2. **Cursor mode** — Ask → `ask`, Plan → `plan`, Agent → `agent`, etc.
3. **Keyword patterns** — regex on the prompt (see `routing.taskPatterns` in config)
4. **Default** — `code` when nothing else matches

Each task maps to a provider via `routing.taskRoutes`. If that provider fails, PARAGON walks `routing.fallbackChain`.

## OpenAI-compatible models

| Model | Default provider | Use |
|-------|------------------|-----|
| `cheap` | cursor | Planner, revision, compaction |
| `review` | codex | Critique, result review |
| `research` | claude | Research skill |
| `fallback` | antigravity | Named fallback route |

Set `model` to one of the names above for a fixed route, or use `paragon` (or your configured
`exposedModel`) for automatic keyword routing. The pre-rename id `routerbot-local` is still accepted as an
alias for one migration release.

Override mappings in `data/config.json` → `routing.namedRoutes` and `routing.taskRoutes`.

## Verify routes

```bash
npm run routes:verify
```

With a running server and `PARAGON_API_KEY` set, this also checks live `/v1/models`.

## Dashboard

**http://127.0.0.1:4117** — configure providers, task routes, and the fallback chain under **Routing**;
adaptive routing policy, model rankings, and shadow analysis under **Orchestration**.
