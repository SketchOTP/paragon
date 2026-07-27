import { defaultTailscaleCursorBaseUrl } from "./cursorBaseUrl.js";

export function tailscaleUrls(server) {
  const host = (server.tailscaleHost || "").replace(/\/$/, "");
  const servePort = server.tailscaleServePort ?? 9420;
  const funnelPort = server.tailscaleFunnelPort ?? 10000;
  if (!host) {
    return null;
  }
  const base = `https://${host}`;
  return {
    tailnetDashboard: `${base}:${servePort}`,
    tailnetApi: `${base}:${servePort}/v1`,
    funnelDashboard: `${base}:${funnelPort}`,
    cursorBaseUrl: defaultTailscaleCursorBaseUrl(server) || `${base}:${funnelPort}/v1`
  };
}
