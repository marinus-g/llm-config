import test from "node:test";
import assert from "node:assert/strict";
import { dispatchAttach } from "../tui/workflow-tui.js";

const workflowID = "example-123";
const sessionID = "session-123";

test("closes the picker and dispatches attach through the active agent", async () => {
  const calls = [];
  const api = {
    ui: { dialog: { clear: () => calls.push("clear") } },
    client: { session: {
      command: async (request) => calls.push(["command", request]),
      promptAsync: async (request) => calls.push(["prompt", request]),
    } },
  };
  await dispatchAttach(api, sessionID, workflowID);
  assert.deepEqual(calls, [
    "clear",
    ["command", { sessionID, command: "workflow", arguments: `attach ${workflowID}` }],
  ]);
});

test("returns a thrown transport error to the active agent", async () => {
  const prompts = [];
  const api = {
    ui: { dialog: { clear() {} } },
    client: { session: {
      command: async () => { throw new Error("Connection lost."); },
      promptAsync: async (request) => prompts.push(request),
    } },
  };
  await dispatchAttach(api, sessionID, workflowID);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].sessionID, sessionID);
  assert.match(prompts[0].parts[0].text, /Exact error:\n\n```text\nConnection lost\.\n```/);
  assert.match(prompts[0].parts[0].text, /Do not claim the workflow is attached/);
});

test("returns an API error result to the active agent", async () => {
  const prompts = [];
  const api = {
    ui: { dialog: { clear() {} }, toast() {} },
    client: { session: {
      command: async () => ({ error: { message: "Invalid session." } }),
      promptAsync: async (request) => prompts.push(request),
    } },
  };
  await dispatchAttach(api, sessionID, workflowID);
  assert.match(prompts[0].parts[0].text, /```text\nInvalid session\.\n```/);
});

test("shows the exact original error when agent fallback also fails", async () => {
  const toasts = [];
  const api = {
    ui: { dialog: { clear() {} }, toast: (toast) => toasts.push(toast) },
    client: { session: {
      command: async () => ({ error: { message: "Invalid session." } }),
      promptAsync: async () => ({ error: { message: "Fallback failed." } }),
    } },
  };
  await dispatchAttach(api, sessionID, workflowID);
  assert.deepEqual(toasts, [{ variant: "error", message: "Invalid session." }]);
});
