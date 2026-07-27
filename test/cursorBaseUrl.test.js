import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultTailscaleCursorBaseUrl,
  effectiveCursorBaseUrl,
  isPublicTunnelUrl,
  reconcilePersistedCursorBaseUrl
} from "../src/cursorBaseUrl.js";

const server = {
  tailscaleHost: "atlas-2.tail1a5964.ts.net",
  tailscaleFunnelPort: 10000,
  tunnels: { ngrokDomain: "briskly-marine-paced.ngrok-free.dev" }
};

test("defaultTailscaleCursorBaseUrl uses funnel port", () => {
  assert.equal(
    defaultTailscaleCursorBaseUrl(server),
    "https://atlas-2.tail1a5964.ts.net:10000/v1"
  );
});

test("isPublicTunnelUrl detects ngrok and trycloudflare hosts", () => {
  assert.equal(isPublicTunnelUrl("https://briskly-marine-paced.ngrok-free.dev/v1", server), true);
  assert.equal(isPublicTunnelUrl("https://foo-bar.trycloudflare.com/v1"), true);
  assert.equal(
    isPublicTunnelUrl("https://atlas-2.tail1a5964.ts.net:10000/v1", server),
    false
  );
});

test("reconcilePersistedCursorBaseUrl reverts saved tunnel URL to tailscale", () => {
  const next = reconcilePersistedCursorBaseUrl(
    { ...server, cursorBaseUrl: "https://briskly-marine-paced.ngrok-free.dev/v1" },
    { cloudflared: { running: true }, ngrok: { running: true } }
  );
  assert.equal(next, "https://atlas-2.tail1a5964.ts.net:10000/v1");
});

test("reconcilePersistedCursorBaseUrl keeps tailscale override while ngrok runs", () => {
  const tailscale = "https://atlas-2.tail1a5964.ts.net:10000/v1";
  const next = reconcilePersistedCursorBaseUrl(
    { ...server, cursorBaseUrl: tailscale },
    {
      cloudflared: { running: false },
      ngrok: { running: true, cursorBaseUrl: "https://briskly-marine-paced.ngrok-free.dev/v1" }
    }
  );
  assert.equal(next, tailscale);
});

test("effectiveCursorBaseUrl uses ngrok while tunnel is running", () => {
  const ngrok = "https://briskly-marine-paced.ngrok-free.dev/v1";
  const tailscale = "https://atlas-2.tail1a5964.ts.net:10000/v1";
  const next = effectiveCursorBaseUrl(
    { ...server, cursorBaseUrl: tailscale },
    { cloudflared: { running: false }, ngrok: { running: true, cursorBaseUrl: ngrok } }
  );
  assert.equal(next, ngrok);
});
