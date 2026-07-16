import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_MODEL_OVERRIDE_COMMAND,
  agentModelOverridePath,
  availableAgentOptions,
  availableModelOptions,
  clearAgentModelOverrides,
  clearModelOverride,
  createModelOverrideHooks,
  createModelOverrideOwner,
  findAvailableModel,
  formatModelOverride,
  isFreeModel,
  isModelLoadError,
  MODEL_OVERRIDE_COMMAND,
  modelOverridePath,
  parseModelString,
  readAgentModelOverrides,
  readModelOverride,
  resolveAgentDefaultModel,
  resolveModelOverride,
  setModelOverrideStorageRoot,
  updateAgentModelOverride,
  writeAgentModelOverrides,
  writeModelOverride,
} from "../lib/model-override.js";

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "model-override-"));
  setModelOverrideStorageRoot(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("persists an override atomically using a safe session filename", () => {
  const owner = createModelOverrideOwner(123);
  writeModelOverride("session/unsafe", {
    mode: "override",
    model: { providerID: "provider", modelID: "model" },
  }, owner);
  assert.match(modelOverridePath("session/unsafe"), /session_unsafe\.json$/);
  assert.deepEqual(readModelOverride("session/unsafe", () => true).model,
    { providerID: "provider", modelID: "model" });
});

test("ignores malformed records and records whose owner exited", () => {
  const owner = createModelOverrideOwner(123);
  writeModelOverride("dead", { mode: "default" }, owner);
  assert.equal(readModelOverride("dead", () => false), null);
  writeFileSync(modelOverridePath("dead"), "not json");
  assert.equal(readModelOverride("dead", () => true), null);
});

test("only clears another writer's record when no owner token is required", () => {
  const owner = createModelOverrideOwner(123);
  writeModelOverride("session", { mode: "default" }, owner);
  assert.equal(clearModelOverride("session", "different"), false);
  assert.ok(readFileSync(modelOverridePath("session")));
  assert.equal(clearModelOverride("session", owner.token), true);
});

test("persists agent overrides and rejects dead, malformed, or foreign-owned state", () => {
  const owner = createModelOverrideOwner(123);
  const overrides = { reviewer: { providerID: "provider", modelID: "model" } };
  writeAgentModelOverrides(overrides, owner);
  assert.deepEqual(readAgentModelOverrides(() => true).overrides, overrides);
  assert.equal(readAgentModelOverrides(() => false), null);
  assert.equal(clearAgentModelOverrides("different"), false);
  assert.ok(readFileSync(agentModelOverridePath()));
  writeFileSync(agentModelOverridePath(), "not json");
  assert.equal(readAgentModelOverrides(() => true), null);
});

test("updates and removes individual agent overrides without mutating the source", () => {
  const original = { first: { providerID: "p", modelID: "one" } };
  const added = updateAgentModelOverride(original, "second", { providerID: "p", modelID: "two" });
  assert.deepEqual(Object.keys(original), ["first"]);
  assert.deepEqual(Object.keys(added), ["first", "second"]);
  assert.deepEqual(updateAgentModelOverride(added, "first", null), {
    second: { providerID: "p", modelID: "two" },
  });
});

test("resolves the nearest ancestor record and stops at an explicit default", async () => {
  const records = new Map([
    ["root", { mode: "override", model: { providerID: "p", modelID: "root" } }],
    ["child", { mode: "default" }],
  ]);
  const parents = { grandchild: "child", child: "root", root: null };
  const resolved = await resolveModelOverride("grandchild", (id) => parents[id], {
    read: (id) => records.get(id) ?? null,
  });
  assert.equal(resolved.mode, "default");
  assert.equal(resolved.sourceSessionID, "child");
});

test("returns null for parent cycles and parent lookup failures", async () => {
  assert.equal(await resolveModelOverride("a", (id) => id === "a" ? "b" : "a", {
    read: () => null,
  }), null);
  assert.equal(await resolveModelOverride("a", async () => { throw new Error("gone"); }, {
    read: () => null,
  }), null);
});

test("chat hook replaces the model without retaining its variant", async () => {
  const client = { session: { get: async () => ({ data: { parentID: null } }) } };
  const hooks = createModelOverrideHooks(client, {
    read: () => ({ mode: "override", model: { providerID: "new", modelID: "chosen" } }),
  });
  const output = { message: {
    id: "message", agent: "agent",
    model: { providerID: "old", modelID: "configured", variant: "high" },
  }, parts: [] };
  await hooks["chat.message"]({ sessionID: "session" }, output);
  assert.deepEqual(output.message.model, { providerID: "new", modelID: "chosen" });
  assert.equal(output.message.agent, "agent");
});

test("chat hook leaves the configured model for a default record", async () => {
  const hooks = createModelOverrideHooks({ session: {} }, {
    read: () => ({ mode: "default" }),
  });
  const output = { message: { model: { providerID: "old", modelID: "configured" } }, parts: [] };
  await hooks["chat.message"]({ sessionID: "session" }, output);
  assert.deepEqual(output.message.model, { providerID: "old", modelID: "configured" });
});

test("chat hook applies agent overrides after session resolution", async () => {
  const client = { session: { get: async () => ({ data: { parentID: null } }) } };
  const agentRecord = {
    overrides: { reviewer: { providerID: "agent-provider", modelID: "agent-model" } },
  };
  const hooks = createModelOverrideHooks(client, {
    read: () => null,
    readAgent: () => agentRecord,
  });
  const output = { message: {
    agent: "reviewer",
    model: { providerID: "old", modelID: "configured", variant: "high" },
  }, parts: [] };
  await hooks["chat.message"]({ sessionID: "session", agent: "reviewer" }, output);
  assert.deepEqual(output.message.model, { providerID: "agent-provider", modelID: "agent-model" });
});

test("session model wins while a session default falls through to the agent override", async () => {
  const client = { session: { get: async () => ({ data: { parentID: null } }) } };
  const readAgent = () => ({
    overrides: { reviewer: { providerID: "agent-provider", modelID: "agent-model" } },
  });
  const output = () => ({ message: {
    agent: "reviewer",
    model: { providerID: "old", modelID: "configured" },
  }, parts: [] });

  const sessionHooks = createModelOverrideHooks(client, {
    read: () => ({ mode: "override", model: { providerID: "session-provider", modelID: "session-model" } }),
    readAgent,
  });
  const sessionOutput = output();
  await sessionHooks["chat.message"]({ sessionID: "session", agent: "reviewer" }, sessionOutput);
  assert.deepEqual(sessionOutput.message.model, { providerID: "session-provider", modelID: "session-model" });

  const defaultHooks = createModelOverrideHooks(client, {
    read: () => ({ mode: "default" }),
    readAgent,
  });
  const defaultOutput = output();
  await defaultHooks["chat.message"]({ sessionID: "session", agent: "reviewer" }, defaultOutput);
  assert.deepEqual(defaultOutput.message.model, { providerID: "agent-provider", modelID: "agent-model" });
});

test("builds sorted options and excludes deprecated models", () => {
  const options = availableModelOptions([{ id: "p", name: "Provider", models: {
    z: { id: "z", name: "Zulu", status: "active" },
    a: { id: "a", name: "Alpha", status: "deprecated" },
  } }]);
  assert.deepEqual(options.map((option) => option.description), ["p/z"]);
  assert.equal(formatModelOverride({ mode: "default" }), "MODEL agent default");
});

test("identifies local, zero-cost, and explicitly free models", () => {
  assert.equal(isFreeModel({ id: "llamaswap" }, { id: "local" }), true);
  assert.equal(isFreeModel({ id: "remote" }, {
    id: "zero-cost",
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
  }), true);
  assert.equal(isFreeModel({ id: "remote" }, { id: "model-free" }), true);
  assert.equal(isFreeModel({ id: "remote" }, { id: "paid", cost: { input: 1, output: 2 } }), false);
  assert.equal(isFreeModel({ id: "remote" }, { id: "unknown" }), false);
});

test("free-only options hide paid, unknown, and deprecated remote models", () => {
  const providers = [
    { id: "llamaswap", name: "Local", models: {
      local: { id: "local", name: "Local" },
    } },
    { id: "remote", name: "Remote", models: {
      free: { id: "free", name: "Free", cost: { input: 0, output: 0 } },
      paid: { id: "paid", name: "Paid", cost: { input: 1, output: 2 } },
      unknown: { id: "unknown", name: "Unknown" },
      old: { id: "old-free", name: "Old Free", status: "deprecated" },
    } },
  ];

  assert.deepEqual(
    availableModelOptions(providers, { freeOnly: true }).map((option) => option.description),
    ["llamaswap/local", "remote/free"],
  );
  assert.deepEqual(
    availableModelOptions(providers).map((option) => option.description),
    ["llamaswap/local", "remote/free", "remote/paid", "remote/unknown"],
  );
});

test("builds configured agent options with override status and excludes disabled agents", () => {
  const options = availableAgentOptions({
    worker: { mode: "subagent", hidden: true, model: "p/worker" },
    primary: { mode: "primary", model: "p/primary" },
    fallback: { mode: "subagent" },
    disabled: { mode: "primary", disable: true, model: "p/disabled" },
  }, {
    worker: { providerID: "override", modelID: "chosen" },
  });
  assert.deepEqual(options.map((option) => option.value), ["primary", "fallback", "worker"]);
  assert.match(options[2].description, /Override: override\/chosen/);
  assert.match(options[1].description, /Configured: global default/);
});

test("registers the picker as a discoverable slash command", () => {
  assert.equal(MODEL_OVERRIDE_COMMAND.namespace, "palette");
  assert.equal(MODEL_OVERRIDE_COMMAND.slashName, "model-override");
  assert.equal(MODEL_OVERRIDE_COMMAND.name, "model-override");
  assert.equal(AGENT_MODEL_OVERRIDE_COMMAND.slashName, "agent-model-override");
  assert.equal(AGENT_MODEL_OVERRIDE_COMMAND.name, "agent-model-override");
});

// ---------------------------------------------------------------------------
// parseModelString
// ---------------------------------------------------------------------------

test("parseModelString splits on the first slash", () => {
  assert.deepEqual(parseModelString("p/m"), { providerID: "p", modelID: "m" });
  assert.deepEqual(parseModelString("llamaswap/qwen3-coder-large"),
    { providerID: "llamaswap", modelID: "qwen3-coder-large" });
  assert.deepEqual(parseModelString("a/b/c"), { providerID: "a", modelID: "b/c" });
});

test("parseModelString returns null for malformed or empty input", () => {
  assert.equal(parseModelString(""), null);
  assert.equal(parseModelString(null), null);
  assert.equal(parseModelString("noSlash"), null);
  assert.equal(parseModelString("/noProvider"), null);
  assert.equal(parseModelString("noModel/"), null);
});

// ---------------------------------------------------------------------------
// findAvailableModel
// ---------------------------------------------------------------------------

const FAKE_PROVIDERS = [
  { id: "p1", models: {
    active: { id: "active", status: "active" },
    deprecated: { id: "deprecated", status: "deprecated" },
    nostatus: { id: "nostatus" },
  } },
];

test("findAvailableModel returns model when provider and model exist and are not deprecated", () => {
  assert.ok(findAvailableModel(FAKE_PROVIDERS, { providerID: "p1", modelID: "active" }));
  assert.ok(findAvailableModel(FAKE_PROVIDERS, { providerID: "p1", modelID: "nostatus" }));
});

test("findAvailableModel returns null for deprecated, missing model, or missing provider", () => {
  assert.equal(findAvailableModel(FAKE_PROVIDERS, { providerID: "p1", modelID: "deprecated" }), null);
  assert.equal(findAvailableModel(FAKE_PROVIDERS, { providerID: "p1", modelID: "nonexistent" }), null);
  assert.equal(findAvailableModel(FAKE_PROVIDERS, { providerID: "unknown", modelID: "active" }), null);
  assert.equal(findAvailableModel([], { providerID: "p1", modelID: "active" }), null);
  assert.equal(findAvailableModel(null, { providerID: "p1", modelID: "active" }), null);
});

// ---------------------------------------------------------------------------
// resolveAgentDefaultModel
// ---------------------------------------------------------------------------

test("resolveAgentDefaultModel prefers the agent-specific model from config", () => {
  const config = { model: "p/global", agent: { myagent: { model: "p/agent" } } };
  assert.deepEqual(resolveAgentDefaultModel(config, null, "myagent"),
    { providerID: "p", modelID: "agent" });
});

test("resolveAgentDefaultModel falls back to the global model", () => {
  const config = { model: "p/global", agent: { other: { model: "p/other" } } };
  assert.deepEqual(resolveAgentDefaultModel(config, null, "myagent"),
    { providerID: "p", modelID: "global" });
});

test("resolveAgentDefaultModel uses providers.default as last resort", () => {
  const providersData = { providers: [], default: { "": "fallback/model" } };
  assert.deepEqual(resolveAgentDefaultModel(null, providersData, "agent"),
    { providerID: "fallback", modelID: "model" });
});

test("resolveAgentDefaultModel returns null when nothing is configured", () => {
  assert.equal(resolveAgentDefaultModel(null, null, "agent"), null);
  assert.equal(resolveAgentDefaultModel({}, null, "agent"), null);
});

// ---------------------------------------------------------------------------
// isModelLoadError
// ---------------------------------------------------------------------------

test("isModelLoadError returns true for ProviderAuthError", () => {
  assert.equal(isModelLoadError({ name: "ProviderAuthError", data: { message: "unauthorized" } }), true);
});

test("isModelLoadError returns true for APIError with load-related status codes", () => {
  for (const status of [400, 404, 500, 502, 503]) {
    assert.equal(isModelLoadError({ name: "APIError", data: { statusCode: status, message: "" } }), true,
      `should be true for status ${status}`);
  }
});

test("isModelLoadError returns true for APIError or UnknownError with load-related message", () => {
  const loadMessages = [
    "model not found",
    "model unavailable",
    "model overloaded",
    "failed to load the model weights",
    "unable to load model",
    "no healthy backends",
    "cannot load quantization",
    "ECONNREFUSED 127.0.0.1:5099",
    "connection refused",
  ];
  for (const msg of loadMessages) {
    assert.equal(isModelLoadError({ name: "APIError", data: { statusCode: 200, message: msg } }), true,
      `APIError: should be true for message "${msg}"`);
    assert.equal(isModelLoadError({ name: "UnknownError", data: { message: msg } }), true,
      `UnknownError: should be true for message "${msg}"`);
  }
});

test("isModelLoadError returns false for non-load errors", () => {
  assert.equal(isModelLoadError({ name: "APIError", data: { statusCode: 200, message: "context too long" } }), false);
  assert.equal(isModelLoadError({ name: "UnknownError", data: { message: "timeout" } }), false);
  assert.equal(isModelLoadError({ name: "MessageAbortedError", data: {} }), false);
  assert.equal(isModelLoadError(null), false);
  assert.equal(isModelLoadError(undefined), false);
});

// ---------------------------------------------------------------------------
// createModelOverrideHooks — preflight fallback (Layer 1)
// ---------------------------------------------------------------------------

function makeFakeClient({ parentID = null, configData = null, providersData = null, promptFn = null } = {}) {
  return {
    session: {
      get: async () => ({ data: { parentID } }),
      ...(promptFn ? { prompt: promptFn } : {}),
    },
    config: {
      get: async () => ({ data: configData }),
      providers: async () => ({ data: providersData }),
    },
  };
}

test("preflight: applies override when model is available in providers", async () => {
  const notifyCalls = [];
  const client = makeFakeClient({
    providersData: { providers: [{ id: "p", models: { m: { id: "m" } } }], default: {} },
    configData: { model: "p/default-model", agent: {} },
  });
  const hooks = createModelOverrideHooks(client, {
    read: () => ({ mode: "override", model: { providerID: "p", modelID: "m" } }),
    notify: (...args) => notifyCalls.push(args),
  });
  const output = { message: { agent: "agent", model: { providerID: "old", modelID: "old" } }, parts: [] };
  await hooks["chat.message"]({ sessionID: "s1", agent: "agent" }, output);
  assert.deepEqual(output.message.model, { providerID: "p", modelID: "m" });
  assert.equal(notifyCalls.length, 0, "no notification when model is available");
});

test("preflight: falls back to agent default when override model is absent from providers", async () => {
  const notifyCalls = [];
  const client = makeFakeClient({
    providersData: { providers: [{ id: "p", models: { real: { id: "real" } } }], default: {} },
    configData: { model: "p/default-model", agent: { myagent: { model: "p/agent-default" } } },
  });
  const hooks = createModelOverrideHooks(client, {
    read: () => ({ mode: "override", model: { providerID: "p", modelID: "bogus" } }),
    notify: (...args) => notifyCalls.push(args),
  });
  const output = { message: { agent: "myagent", model: {} }, parts: [] };
  await hooks["chat.message"]({ sessionID: "s2", agent: "myagent" }, output);
  assert.deepEqual(output.message.model, { providerID: "p", modelID: "agent-default" });
  assert.equal(notifyCalls.length, 1);
  assert.match(notifyCalls[0][0], /fallback/i);
  assert.match(notifyCalls[0][1], /bogus/);
  assert.match(notifyCalls[0][1], /agent-default/);
});

test("preflight: applies override optimistically when providers list is empty", async () => {
  const notifyCalls = [];
  const client = makeFakeClient({
    providersData: { providers: [], default: {} },
    configData: { model: "p/default", agent: {} },
  });
  const hooks = createModelOverrideHooks(client, {
    read: () => ({ mode: "override", model: { providerID: "p", modelID: "any" } }),
    notify: (...args) => notifyCalls.push(args),
  });
  const output = { message: { agent: "agent", model: {} }, parts: [] };
  await hooks["chat.message"]({ sessionID: "s3", agent: "agent" }, output);
  assert.deepEqual(output.message.model, { providerID: "p", modelID: "any" });
  assert.equal(notifyCalls.length, 0);
});

// ---------------------------------------------------------------------------
// createModelOverrideHooks — runtime fallback (Layer 2)
// ---------------------------------------------------------------------------

test("runtime fallback: session.error with load error triggers one re-prompt on agent default", async () => {
  const notifyCalls = [];
  const promptCalls = [];
  const client = makeFakeClient({
    providersData: { providers: [{ id: "p", models: { m: { id: "m" } } }], default: {} },
    configData: { model: "p/global", agent: { worker: { model: "p/worker-default" } } },
    promptFn: async (args) => { promptCalls.push(args); return {}; },
  });
  const hooks = createModelOverrideHooks(client, {
    read: () => ({ mode: "override", model: { providerID: "p", modelID: "m" } }),
    notify: (...args) => notifyCalls.push(args),
  });

  // Turn 1: apply override (model available — track for runtime fallback)
  const output = { message: { agent: "worker", model: {} }, parts: [{ type: "text", text: "hello" }] };
  await hooks["chat.message"]({ sessionID: "rt1", agent: "worker", messageID: "msg1" }, output);
  assert.deepEqual(output.message.model, { providerID: "p", modelID: "m" });

  // Simulate session.error with a load failure
  await hooks.event({ event: {
    type: "session.error",
    properties: { sessionID: "rt1", error: { name: "APIError", data: { statusCode: 503, message: "service unavailable" } } },
  } });

  assert.equal(promptCalls.length, 1, "should re-prompt exactly once");
  assert.deepEqual(promptCalls[0].body.model, { providerID: "p", modelID: "worker-default" });
  assert.equal(promptCalls[0].path.id, "rt1");
  assert.equal(notifyCalls.length, 1);
  assert.match(notifyCalls[0][0], /fallback/i);

  // Second identical error should NOT trigger another re-prompt
  await hooks.event({ event: {
    type: "session.error",
    properties: { sessionID: "rt1", error: { name: "APIError", data: { statusCode: 503, message: "service unavailable" } } },
  } });
  assert.equal(promptCalls.length, 1, "second error must not produce a second re-prompt");
});

test("runtime fallback: non-load errors do not trigger re-prompt", async () => {
  const promptCalls = [];
  const client = makeFakeClient({
    providersData: { providers: [{ id: "p", models: { m: { id: "m" } } }], default: {} },
    configData: { model: "p/global", agent: {} },
    promptFn: async (args) => { promptCalls.push(args); return {}; },
  });
  const hooks = createModelOverrideHooks(client, {
    read: () => ({ mode: "override", model: { providerID: "p", modelID: "m" } }),
  });

  const output = { message: { agent: "a", model: {} }, parts: [] };
  await hooks["chat.message"]({ sessionID: "rt2", agent: "a" }, output);

  await hooks.event({ event: {
    type: "session.error",
    properties: { sessionID: "rt2", error: { name: "UnknownError", data: { message: "context window exceeded" } } },
  } });

  assert.equal(promptCalls.length, 0, "non-load error must not re-prompt");
});

test("runtime fallback: retry turn skips override so agent default takes effect", async () => {
  let promptCalls = [];
  const client = makeFakeClient({
    providersData: { providers: [{ id: "p", models: { m: { id: "m" } } }], default: {} },
    configData: { model: "p/global", agent: {} },
    promptFn: async (args) => { promptCalls.push(args); return {}; },
  });
  const hooks = createModelOverrideHooks(client, {
    read: () => ({ mode: "override", model: { providerID: "p", modelID: "m" } }),
  });

  // Apply override
  const out1 = { message: { agent: "a", model: {} }, parts: [] };
  await hooks["chat.message"]({ sessionID: "rt3", agent: "a" }, out1);
  assert.deepEqual(out1.message.model, { providerID: "p", modelID: "m" });

  // Trigger runtime fallback
  await hooks.event({ event: {
    type: "session.error",
    properties: { sessionID: "rt3", error: { name: "ProviderAuthError", data: { message: "auth failed" } } },
  } });

  // Simulate the re-prompt's chat.message call (retry turn)
  const out2 = { message: { agent: "a", model: { providerID: "p", modelID: "global" } }, parts: [] };
  await hooks["chat.message"]({ sessionID: "rt3", agent: "a" }, out2);
  // Override should NOT have been applied; model stays as what opencode resolved
  assert.deepEqual(out2.message.model, { providerID: "p", modelID: "global" });
});
