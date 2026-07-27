import { readConfig } from "./configStore.js";
import { accessSync, constants } from "node:fs";
import { execSync } from "node:child_process";

async function check() {
  console.log("Checking RouterBot configuration...");
  let config;
  try {
    config = await readConfig();
  } catch (e) {
    console.error("Error loading config:", e.message);
    process.exit(1);
  }

  let ok = true;
  for (const [provider, providerConfig] of Object.entries(config.providers)) {
    if (providerConfig.type === "http") continue; // HTTP providers don't have commands

    const cmd = providerConfig.command;
    if (!cmd) {
      console.error(`- Provider '${provider}' has no command configured.`);
      ok = false;
      continue;
    }

    try {
      // Use 'which' to check if the command exists in the PATH
      execSync(`which ${cmd}`, { stdio: "ignore" });
      console.log(`- Provider '${provider}' command '${cmd}' found.`);
    } catch (e) {
      console.error(`- Provider '${provider}' command '${cmd}' not found.`);
      ok = false;
    }
  }

  if (ok) {
    console.log("Configuration is valid.");
    process.exit(0);
  } else {
    console.error("Configuration is invalid.");
    process.exit(1);
  }
}

check();
