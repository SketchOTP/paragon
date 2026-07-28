import crypto from "node:crypto";

export function generateApiKey() {
  return crypto.randomBytes(24).toString("base64url");
}

export function requestHasApiKey(req, expectedKey) {
  const auth = req.get("authorization") ?? "";
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1];
  const xApiKey = req.get("x-api-key");
  const queryKey = typeof req.query?.key === "string" ? req.query.key : undefined;
  return bearer === expectedKey || xApiKey === expectedKey || queryKey === expectedKey;
}

function clientIp(req) {
  const forwarded = req.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket?.remoteAddress ?? "";
}

export function isLoopback(req) {
  const ip = clientIp(req);
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

export function createAuthMiddleware(getConfig, { allowLocalhost = false } = {}) {
  return async (req, res, next) => {
    const config = await getConfig();
    const expectedKey = config.server.apiKey;
    if (!expectedKey) {
      res.status(503).json({
        error: {
          message: "PARAGON API key is not configured",
          type: "paragon_auth_error"
        }
      });
      return;
    }
    if (requestHasApiKey(req, expectedKey)) {
      next();
      return;
    }
    if (allowLocalhost && isLoopback(req)) {
      next();
      return;
    }
    res.status(401).json({
      error: {
        message: "Missing or invalid PARAGON API key",
        type: "paragon_auth_error"
      }
    });
  };
}
