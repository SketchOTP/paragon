/** Pending login URLs/codes parsed from CLI auth output (for dashboard browser open). */

const sessions = new Map();

const URL_PATTERNS = [
  /https:\/\/claude\.com\/cai\/oauth\/\S+/i,
  /https:\/\/cursor\.com\/loginDeepControl\?\S+/i,
  /https:\/\/auth\.openai\.com\/codex\/device\b/i,
  /https:\/\/auth\.openai\.com\/oauth\/authorize\?\S+/i,
  /https:\/\/accounts\.google\.com\/o\/oauth2\/(?:v2\/)?auth\S+/i
];

const DEVICE_CODE_PATTERN = /\b([A-Z0-9]{4,5}-[A-Z0-9]{4,5})\b/;

export function clearAuthSession(provider) {
  sessions.delete(provider);
}

export function ingestAuthOutput(provider, text) {
  const plain = stripAnsi(String(text ?? ""));
  if (!plain.trim()) {
    return getAuthSession(provider);
  }

  const current = sessions.get(provider) ?? {
    provider,
    url: null,
    deviceCode: null,
    mode: "browser",
    updatedAt: null
  };

  for (const pattern of URL_PATTERNS) {
    const match = plain.match(pattern);
    if (match) {
      current.url = match[0].replace(/[)\]}>"']+$/, "");
      current.updatedAt = new Date().toISOString();
      if (current.url.includes("auth.openai.com/codex/device")) {
        current.mode = "device";
      } else if (current.url.includes("accounts.google.com")) {
        current.mode = "oauth-code";
      }
    }
  }

  if (current.mode === "device" || plain.toLowerCase().includes("one-time code")) {
    const codeMatch = plain.match(DEVICE_CODE_PATTERN);
    if (codeMatch) {
      current.deviceCode = codeMatch[1];
      current.updatedAt = new Date().toISOString();
    }
  }

  if (current.url || current.deviceCode) {
    sessions.set(provider, current);
  }
  return current;
}

export function getAuthSession(provider) {
  return sessions.get(provider) ?? null;
}

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\r/g, "");
}
