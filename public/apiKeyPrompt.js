/**
 * Coalesce concurrent API-key prompts into one dialog.
 * Parallel 401 handlers must share one Promise — otherwise the second
 * overwrites onsubmit and the first fetch hangs forever (frozen dashboard).
 */
export function createApiKeyPrompt({ dialog, form, input, getStored, setStored }) {
  let inflight = null;

  return function promptForApiKey() {
    if (inflight) {
      return inflight;
    }

    inflight = new Promise((resolve) => {
      input.value = getStored();
      if (!dialog.open) {
        dialog.showModal();
      }

      form.onsubmit = (event) => {
        event.preventDefault();
        setStored(input.value.trim());
        if (dialog.open) {
          dialog.close();
        }
        form.onsubmit = null;
        inflight = null;
        resolve();
      };
    });

    return inflight;
  };
}
