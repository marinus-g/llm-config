import test from "node:test";
import assert from "node:assert/strict";
import { server } from "../plugin/context-guard.js";
import { resetContextPressureForTests } from "../lib/context-pressure.js";

test("cached usage triggers once and can trigger again after compaction", async () => {
  resetContextPressureForTests();
  const toasts = [];
  const hooks = await server({ client: {
    config: { get: async () => ({ data: {
      model: "provider/model",
      provider: { provider: { models: { model: { limit: { context: 100 } } } } },
    } }) },
    tui: { showToast: async ({ body }) => { toasts.push(body); } },
  } });
  const message = {
    type: "message.updated",
    properties: { info: {
      role: "assistant",
      sessionID: "guard-test",
      providerID: "provider",
      modelID: "model",
      tokens: { input: 10, cache: { read: 70, write: 0 } },
    } },
  };

  await hooks.event({ event: message });
  await hooks.event({ event: message });
  assert.equal(toasts.length, 1);
  assert.match(toasts[0].message, /80%/);

  await hooks.event({ event: {
    type: "session.compacted",
    properties: { sessionID: "guard-test" },
  } });
  await hooks.event({ event: message });
  assert.equal(toasts.length, 2);
});
