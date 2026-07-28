/** Auth flow metadata for built-in CLI providers (dashboard UX). */

export const AUTH_FLOWS = {
  claude: {
    mode: "browser",
    signInLabel: "Sign in",
    reSignInLabel: "Re-sign in",
    hint: "Opens Claude in your browser. Complete sign-in there."
  },
  codex: {
    mode: "device",
    signInLabel: "Device login",
    reSignInLabel: "Re-login",
    hint: "Open the device URL and enter the one-time code shown below."
  },
  cursor: {
    mode: "browser",
    signInLabel: "Sign in",
    reSignInLabel: "Re-sign in",
    hint: "Opens Cursor login in your browser."
  }
};

export function authFlowFor(provider) {
  return AUTH_FLOWS[provider] ?? {
    mode: "browser",
    signInLabel: "Sign in",
    reSignInLabel: "Re-sign in",
    hint: "Complete sign-in using the link below."
  };
}
