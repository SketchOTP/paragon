import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createApiKeyPrompt } from "../public/apiKeyPrompt.js";

function fakeDialog() {
  return {
    open: false,
    showModal() {
      if (this.open) {
        throw new Error("InvalidStateError");
      }
      this.open = true;
    },
    close() {
      this.open = false;
    }
  };
}

describe("createApiKeyPrompt", () => {
  it("coalesces concurrent prompts so one submit unblocks all waiters", async () => {
    const dialog = fakeDialog();
    const form = { onsubmit: null };
    const input = { value: "" };
    let stored = "";

    const prompt = createApiKeyPrompt({
      dialog,
      form,
      input,
      getStored: () => stored,
      setStored: (key) => {
        stored = key;
      }
    });

    const a = prompt();
    const b = prompt();
    assert.equal(a, b, "concurrent callers must share one Promise");
    assert.equal(dialog.open, true);

    input.value = "secret-key";
    form.onsubmit({ preventDefault() {} });

    await Promise.all([a, b]);
    assert.equal(stored, "secret-key");
    assert.equal(dialog.open, false);

    const c = prompt();
    assert.notEqual(c, a, "next prompt starts a new flight");
    assert.equal(dialog.open, true);
    input.value = "next";
    form.onsubmit({ preventDefault() {} });
    await c;
    assert.equal(stored, "next");
  });

  it("does not call showModal again while dialog already open", async () => {
    const dialog = fakeDialog();
    dialog.open = true;
    let showCount = 0;
    dialog.showModal = function showModal() {
      showCount += 1;
      if (this.open) {
        throw new Error("InvalidStateError");
      }
      this.open = true;
    };

    const form = { onsubmit: null };
    const input = { value: "" };
    const prompt = createApiKeyPrompt({
      dialog,
      form,
      input,
      getStored: () => "",
      setStored: () => {}
    });

    const pending = prompt();
    assert.equal(showCount, 0);
    form.onsubmit({ preventDefault() {} });
    await pending;
  });
});
