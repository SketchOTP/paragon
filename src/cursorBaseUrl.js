/** Resolve Cursor/PARAGON public base URL from Tailscale vs tunnel state. */

export function defaultTailscaleCursorBaseUrl(server) {
  const host = (server?.tailscaleHost || "").trim();
  if (!host) {
    return "";
  }
  const funnelPort = server?.tailscaleFunnelPort ?? 10000;
  return `https://${host}:${funnelPort}/v1`;
}

export function isPublicTunnelUrl(url, server = null) {
  const trimmed = String(url ?? "").trim();
  if (!trimmed) {
    return false;
  }
  try {
    const hostname = new URL(trimmed).hostname.toLowerCase();
    if (/\.trycloudflare\.com$/i.test(hostname)) {
      return true;
    }
    if (/\.ngrok-free\.dev$/i.test(hostname)) {
      return true;
    }
    if (/\.ngrok\.app$/i.test(hostname)) {
      return true;
    }
    if (/\.ngrok\.io$/i.test(hostname)) {
      return true;
    }
    if (/\.ngrok\.dev$/i.test(hostname)) {
      return true;
    }
    const customDomain = (server?.tunnels?.ngrokDomain || "")
      .trim()
      .replace(/^https?:\/\//, "")
      .replace(/\/$/, "")
      .toLowerCase();
    return Boolean(customDomain && hostname === customDomain);
  } catch {
    return false;
  }
}

/** Runtime URL for clients — active public tunnel wins over saved override. */
export function effectiveCursorBaseUrl(server, tunnelStatus = null) {
  const configured = (server?.cursorBaseUrl || "").trim();
  const cfRunning = Boolean(tunnelStatus?.cloudflared?.running);
  const ngRunning = Boolean(tunnelStatus?.ngrok?.running);

  if (ngRunning && tunnelStatus?.ngrok?.cursorBaseUrl) {
    return tunnelStatus.ngrok.cursorBaseUrl;
  }
  if (cfRunning && tunnelStatus?.cloudflared?.cursorBaseUrl) {
    return tunnelStatus.cloudflared.cursorBaseUrl;
  }

  if (configured) {
    return configured;
  }
  return defaultTailscaleCursorBaseUrl(server);
}

/** Saved settings override — tunnel URLs belong in runtime effective URL, not saved override. */
export function reconcilePersistedCursorBaseUrl(server, _tunnelStatus = null) {
  const configured = (server?.cursorBaseUrl || "").trim();
  if (isPublicTunnelUrl(configured, server)) {
    const tailscale = defaultTailscaleCursorBaseUrl(server);
    return tailscale || "";
  }
  return configured;
}

/** @deprecated use effectiveCursorBaseUrl */
export function reconcileCursorBaseUrl(server, tunnelStatus = null) {
  return effectiveCursorBaseUrl(server, tunnelStatus);
}
