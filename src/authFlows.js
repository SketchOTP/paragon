/** Auth flow metadata for built-in CLI providers (dashboard UX). */

export const AUTH_FLOWS = {
  // Verified by hand against the installed claude CLI (2.1.220):
  // `claude auth login` opens a browser, then prompts
  // "Paste code here if prompted >" on its own stdin — a manual
  // code-exchange step, not pure browser-only sign-in. Confirmed via
  // `script -qfec "claude auth login" <logfile>` to capture the real
  // (non-interactive) output rather than assumed.
  claude: {
    mode: "oauth-code",
    signInLabel: "Sign in",
    reSignInLabel: "Re-sign in",
    hint: "Open the Claude link, authorize, then paste the code below."
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
