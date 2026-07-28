# Contributing to PARAGON

Thanks for helping improve PARAGON.

## Development setup

```bash
git clone https://github.com/YOUR_ORG/paragon.git
cd paragon
npm install
npm start
```

Open `http://127.0.0.1:4117` for the dashboard. On first run, note the generated API key printed in the terminal.

## Adding a provider

### HTTP (OpenAI-compatible)

Use the dashboard **Add provider** button or edit `data/config.json`:

```json
"my-local-llm": {
  "type": "http",
  "label": "Local LLM",
  "icon": "🦙",
  "enabled": true,
  "baseUrl": "http://127.0.0.1:8080/v1",
  "apiKey": "",
  "model": "my-model",
  "timeoutMs": 300000
}
```

Works with Ollama (`http://127.0.0.1:11434/v1`), vLLM, LM Studio, LocalAI, and other OpenAI-compatible servers.

### Generic CLI

```json
"my-cli": {
  "type": "generic-cli",
  "label": "My CLI",
  "icon": "🔧",
  "enabled": true,
  "command": "my-cli",
  "runArgs": ["--model", "{{model}}", "-"],
  "model": "default",
  "stdinMode": "prompt",
  "timeoutMs": 300000
}
```

Use `{{model}}` in `runArgs` where the CLI expects a model flag. Optional fields: `icon` (emoji), `authArgs`, `statusArgs`, `modelsArgs`, `fallbackModels`.

The dashboard **Add provider** flow and per-card emoji picker set `icon` for you.

### Built-in providers

Claude Code, Codex, Cursor Agent, and Gemini CLI have dedicated adapters in `src/cli.js` with auth flows and model discovery. Extend those in code if you need new built-in behavior.

## Routing

- Task routes map keywords to providers (`src/taskClassifier.js`).
- `routing.fallbackChain` lists providers to try after the routed provider fails.

## Tests and release checks

```bash
npm test
npm run check   # tests + sensitive-data scan
```

## Pull requests

- Keep changes focused.
- Do not commit `data/`, secrets, or personal hostnames.
- Update `README.md` when behavior or configuration changes.
