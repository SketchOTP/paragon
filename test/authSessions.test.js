import assert from "node:assert/strict";
import test from "node:test";
import { clearAuthSession, ingestAuthOutput } from "../src/authSessions.js";

test("ingestAuthOutput extracts Claude browser URL and flags oauth-code mode", () => {
  clearAuthSession("claude");
  const session = ingestAuthOutput(
    "claude",
    "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=x"
  );
  assert.ok(session.url?.startsWith("https://claude.com/cai/oauth/"));
  // Verified by hand against the installed claude CLI: it prompts
  // "Paste code here if prompted >" after the browser step — this is not
  // a pure browser-only flow.
  assert.equal(session.mode, "oauth-code");
});

test("ingestAuthOutput sets oauth-code mode from the paste-code prompt even without a matching URL pattern", () => {
  clearAuthSession("claude");
  const session = ingestAuthOutput("claude", "Paste code here if prompted > ");
  assert.equal(session.mode, "oauth-code");
});

test("ingestAuthOutput extracts Cursor loginDeepControl URL", () => {
  clearAuthSession("cursor");
  const session = ingestAuthOutput(
    "cursor",
    "Open a browser and navigate to this link: https://cursor.com/loginDeepControl?challenge=abc&uuid=1"
  );
  assert.ok(session.url?.includes("loginDeepControl"));
});

test("ingestAuthOutput extracts Codex device URL and code", () => {
  clearAuthSession("codex");
  const session = ingestAuthOutput(
    "codex",
    "Open https://auth.openai.com/codex/device\nEnter code PBSZ-LN8YJ"
  );
  assert.equal(session.url, "https://auth.openai.com/codex/device");
  assert.equal(session.deviceCode, "PBSZ-LN8YJ");
  assert.equal(session.mode, "device");
});
