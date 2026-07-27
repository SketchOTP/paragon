# RouterBot routing

RouterBot uses **keyword-based task classification** and a **provider fallback chain**. There is no smart model selection, canary rollout, or shadow evaluation.

## How routing works

1. **Explicit override** — `metadata.routerbot_task` or `x-routerbot-task` header
2. **Cursor mode** — Ask → `ask`, Plan → `plan`, Agent → `agent`, etc.
3. **Keyword patterns** — regex on the prompt (see `routing.taskPatterns` in config)
4. **Default** — `code` when nothing else matches

Each task maps to a provider via `routing.taskRoutes`. If that provider fails, RouterBot walks `routing.fallbackChain`.

## OpenAI-compatible models

| Model | Default provider | Use |
|-------|------------------|-----|
| `cheap` | cursor | Planner, revision, compaction |
| `review` | codex | Critique, result review |
| `research` | claude | Research skill |
| `fallback` | antigravity | Named fallback route |

Set `model` to one of the names above for a fixed route, or use `routerbot-local` (or your configured `exposedModel`) for automatic keyword routing.

Override mappings in `data/config.json` → `routing.namedRoutes` and `routing.taskRoutes`.

## Verify routes

```bash
npm run routes:verify
```

With a running server and `ROUTERBOT_API_KEY` set, this also checks live `/v1/models`.

## Dashboard

**http://127.0.0.1:4117** — configure providers, task routes, and the fallback chain under **Routing**.
