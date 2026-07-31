import { spawn, execSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { parseCodexModelsCatalog } from "./modelList.js";

const DISCOVERY_ARG_SETS = [
  ["debug", "models", "--bundled"],
  ["debug", "models"]
];

function runCodex(command, args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} ${args.join(" ")} timed out`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(stderr.trim() || `${command} exited ${code}`));
    });
  });
}

/** Resolve the same native Codex ELF used by CLI execution, not a snap launcher. */
export function resolveCodexBinary(command = "codex") {
  if (command.includes("/")) {
    return realpathSync(command);
  }
  const snapBinary = `/snap/${command}/current/bin/${command}`;
  if (existsSync(snapBinary)) {
    return realpathSync(snapBinary);
  }
  const which = execSync(`command -v ${command}`, {
    encoding: "utf8",
    env: process.env
  }).trim();
  return realpathSync(which);
}

/** Bundled catalog embedded in the codex binary (same source as `codex debug models --bundled`). */
export function loadCodexBundledCatalog(command = "codex") {
  try {
    const binaryPath = resolveCodexBinary(command);
    const text = readFileSync(binaryPath).toString("latin1");
    const models = [];
    const seen = new Set();
    const slugPattern = /"slug": "([^"]+)"/g;
    let match;
    while ((match = slugPattern.exec(text)) !== null) {
      const id = match[1];
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      models.push({ id, name: id });
    }
    return models;
  } catch {
    return [];
  }
}

/** Uses `codex debug models` when the installed CLI supports it. */
export async function discoverCodexModels(command = "codex") {
  let executable = command;
  try {
    executable = resolveCodexBinary(command);
  } catch {
    // Preserve the configured command so the authoritative discovery error is
    // still handled by the normal fallback path.
  }
  for (const args of DISCOVERY_ARG_SETS) {
    try {
      const result = await runCodex(executable, args);
      const models = parseCodexModelsCatalog(result.stdout);
      if (models.length) {
        return models;
      }
    } catch {
      // Try the next discovery command shape.
    }
  }
  return loadCodexBundledCatalog(executable);
}
