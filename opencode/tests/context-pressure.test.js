import test from "node:test";
import assert from "node:assert/strict";
import {
  clearContextPressure, effectiveInputTokens, getContextPressure, recordContextPressure,
} from "../lib/context-pressure.js";

test("effective context includes cached prompt tokens", () => {
  assert.equal(effectiveInputTokens({
    input: 2_500,
    cache: { read: 157_800, write: 300 },
  }), 160_600);
});

test("records and clears pressure by session", () => {
  const pressure = recordContextPressure({
    sessionID: "pressure-test",
    tokens: { input: 10, cache: { read: 70 } },
    limit: 100,
    providerID: "provider",
    modelID: "model",
  });
  assert.equal(pressure.fraction, 0.8);
  assert.equal(getContextPressure("pressure-test").modelID, "model");
  clearContextPressure("pressure-test");
  assert.equal(getContextPressure("pressure-test"), null);
});
