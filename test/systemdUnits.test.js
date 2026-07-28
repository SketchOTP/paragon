import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

/** Minimal INI-section parser — good enough to check which section a key landed in. */
function parseSections(unitText) {
  const sections = {};
  let current = null;
  for (const rawLine of unitText.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      current = sectionMatch[1];
      sections[current] ??= [];
      continue;
    }
    const keyMatch = line.match(/^([A-Za-z]+)=/);
    if (keyMatch && current) {
      sections[current].push(keyMatch[1]);
    }
  }
  return sections;
}

test("paragon.service places StartLimitIntervalSec/StartLimitBurst in [Unit], not [Service]", () => {
  const unitText = fs.readFileSync(path.join(repoRoot, "deploy/paragon.service"), "utf8");
  const sections = parseSections(unitText);
  assert.ok(sections.Unit.includes("StartLimitIntervalSec"), "StartLimitIntervalSec must be under [Unit]");
  assert.ok(sections.Unit.includes("StartLimitBurst"), "StartLimitBurst must be under [Unit]");
  assert.ok(!sections.Service.includes("StartLimitIntervalSec"), "StartLimitIntervalSec must not be under [Service]");
  assert.ok(!sections.Service.includes("StartLimitBurst"), "StartLimitBurst must not be under [Service]");
  assert.ok(sections.Service.includes("Restart"));
});

test("paragon-tailscale.service bakes in explicit port placeholders rather than relying on fallback defaults", () => {
  const unitText = fs.readFileSync(path.join(repoRoot, "deploy/paragon-tailscale.service"), "utf8");
  assert.match(unitText, /Environment=PARAGON_PORT=%PARAGON_LOCAL_PORT%/);
  assert.match(unitText, /Environment=PARAGON_TAILSCALE_SERVE_PORT=%PARAGON_SERVE_PORT%/);
  assert.match(unitText, /Environment=PARAGON_TAILSCALE_FUNNEL_PORT=%PARAGON_FUNNEL_PORT%/);
  // Must not source /etc/paragon/environment — that would let a stale or
  // wrong environment file silently override the install-time-correct ports.
  assert.doesNotMatch(unitText, /EnvironmentFile=.*\/etc\/paragon\/environment/);
});

test("install-systemd.sh substitutes every placeholder deploy/paragon-tailscale.service defines", () => {
  const installScript = fs.readFileSync(path.join(repoRoot, "scripts/install-systemd.sh"), "utf8");
  for (const placeholder of ["%PARAGON_DIR%", "%PARAGON_LOCAL_PORT%", "%PARAGON_SERVE_PORT%", "%PARAGON_FUNNEL_PORT%"]) {
    assert.ok(installScript.includes(placeholder), `install-systemd.sh must substitute ${placeholder}`);
  }
});
