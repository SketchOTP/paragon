import assert from "node:assert/strict";
import test from "node:test";
import { clearAuthSession, ingestAuthOutput } from "../src/authSessions.js";

test("ingestAuthOutput extracts Claude browser URL", () => {
  clearAuthSession("claude");
  const session = ingestAuthOutput(
    "claude",
    "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=x"
  );
  assert.ok(session.url?.startsWith("https://claude.com/cai/oauth/"));
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

test("ingestAuthOutput extracts Antigravity Google OAuth URL", () => {
  clearAuthSession("antigravity");
  const session = ingestAuthOutput(
    "antigravity",
    "Authentication required. Please visit the URL to log in:\n  https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=x"
  );
  assert.ok(session.url?.startsWith("https://accounts.google.com/o/oauth2/auth"));
  assert.equal(session.mode, "oauth-code");
});
