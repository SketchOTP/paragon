import assert from "node:assert/strict";
import test from "node:test";

import { extractRoutingHints, requiresJsonValidation, isValidJson } from "../src/routing/hints.js";

test("extractRoutingHints parses all supported headers", () => {
  const hints = extractRoutingHints({
    "x-paragon-force-provider": "codex",
    "x-paragon-force-model": "gpt-5.4",
    "x-paragon-max-cost-class": "economy",
    "x-paragon-disable-escalation": "true"
  });
  assert.deepEqual(hints, {
    forceProvider: "codex",
    forceModel: "gpt-5.4",
    maxCostClass: "economy",
    disableEscalation: true
  });
});

test("extractRoutingHints defaults to no hints when headers absent", () => {
  const hints = extractRoutingHints({});
  assert.deepEqual(hints, { forceProvider: null, forceModel: null, maxCostClass: null, disableEscalation: false });
});

test("extractRoutingHints rejects an invalid cost class rather than passing it through", () => {
  const hints = extractRoutingHints({ "x-paragon-max-cost-class": "ultra-mega" });
  assert.equal(hints.maxCostClass, null);
});

test("requiresJsonValidation only true for json_object/json_schema response_format", () => {
  assert.equal(requiresJsonValidation({ response_format: { type: "json_object" } }), true);
  assert.equal(requiresJsonValidation({ response_format: { type: "json_schema" } }), true);
  assert.equal(requiresJsonValidation({ response_format: { type: "text" } }), false);
  assert.equal(requiresJsonValidation({}), false);
});

test("isValidJson", () => {
  assert.equal(isValidJson('{"a":1}'), true);
  assert.equal(isValidJson("not json"), false);
  assert.equal(isValidJson(""), false);
  assert.equal(isValidJson(null), false);
});
