import { spawn } from "node:child_process";
import { dedupeModels, splitTTYLines } from "./cliOutput.js";

function runCursorAgent(command, args, timeoutMs = 60000) {
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

export function parseCursorModelsOutput(stdout) {
  const models = [];
  for (const line of splitTTYLines(stdout)) {
    if (!line.includes(" - ")) {
      continue;
    }
    const [id, ...nameParts] = line.split(" - ");
    const trimmedId = id.trim();
    if (!trimmedId || trimmedId.toLowerCase() === "available models") {
      continue;
    }
    models.push({
      id: trimmedId,
      name: nameParts.join(" - ").replace(/\s+\((current|default)\)$/i, "").trim()
    });
  }
  return dedupeModels(models);
}

function sortCursorModels(models) {
  const rank = (id) => {
    if (id.startsWith("composer")) {
      return 0;
    }
    if (id === "auto") {
      return 1;
    }
    return 2;
  };
  return [...models].sort((a, b) => {
    const byRank = rank(a.id) - rank(b.id);
    if (byRank !== 0) {
      return byRank;
    }
    return a.name.localeCompare(b.name);
  });
}

export async function discoverCursorModels(command = "cursor-agent") {
  const result = await runCursorAgent(command, ["models"]);
  const models = parseCursorModelsOutput(result.stdout);
  if (!models.length) {
    throw new Error("cursor-agent models returned no models");
  }
  return sortCursorModels(models);
}
