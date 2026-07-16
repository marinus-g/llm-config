/**
 * Tests for plugin/agent-mode-override.js
 *
 * Critical invariant: output.system must be mutated IN PLACE (splice/unshift), not
 * reassigned. opencode's plugin dispatcher passes the array by reference and the
 * caller uses its own local reference after the hook returns — reassignment is silently
 * ignored. These tests enforce that the same array object is modified, not replaced.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Helper: create a minimal mock client whose session.get returns a given agent name.
function makeClient(agentName) {
  return {
    session: {
      get: async () => ({ data: { agent: agentName } }),
    },
  };
}

// Helper: call the system.transform hook with a given output.system array and return
// the hook (via the server factory) for a given agent context.
async function callTransform(agentName, systemBlocks, model = { providerID: "llamaswap" }) {
  const client = makeClient(agentName);
  const { server } = await import("../plugin/agent-mode-override.js??t=" + Date.now()); // bust cache
  const hooks = await server({ client });
  const hook = hooks["experimental.chat.system.transform"];
  const output = { system: systemBlocks };
  await hook({ sessionID: "ses_test", model }, output);
  return output;
}

// ── Core invariant: in-place mutation, not replacement ──────────────────────

test("collapse mutates the SAME array reference (not reassignment)", async () => {
  const systemArray = ["block one", "block two", "block three"];
  const originalRef = systemArray;

  const client = makeClient("step-reviewer");
  const { server } = await import("../plugin/agent-mode-override.js??cache=" + Math.random());
  const hooks = await server({ client });
  const hook = hooks["experimental.chat.system.transform"];

  await hook({ sessionID: "ses_test", model: { providerID: "llamaswap" } }, { system: systemArray });

  // The SAME array object must now have length 1.
  assert.strictEqual(systemArray, originalRef, "array reference must not change");
  assert.equal(systemArray.length, 1, "array must be collapsed to length 1 in place");
  assert.ok(systemArray[0].includes("block one"), "first block content preserved");
  assert.ok(systemArray[0].includes("block two"), "second block content preserved");
  assert.ok(systemArray[0].includes("block three"), "third block content preserved");
});

// ── Single block: no-op ──────────────────────────────────────────────────────

test("single system block is left unchanged", async () => {
  const systemArray = ["only block"];
  const originalRef = systemArray;

  const client = makeClient("step-reviewer");
  const { server } = await import("../plugin/agent-mode-override.js??cache=" + Math.random());
  const hooks = await server({ client });
  const hook = hooks["experimental.chat.system.transform"];

  await hook({ sessionID: "ses_test", model: { providerID: "llamaswap" } }, { system: systemArray });

  assert.strictEqual(systemArray, originalRef);
  assert.equal(systemArray.length, 1);
  assert.equal(systemArray[0], "only block");
});

// ── Orchestrator reminder prepended then collapsed ──────────────────────────

test("orchestrator: reminder is prepended then whole array collapsed to 1 block", async () => {
  // Simulate: opencode already built [agentMd, mcpInstructions] before the hook
  const systemArray = ["orchestrator agent system prompt", "MCP codegraph instructions"];
  const originalRef = systemArray;

  const client = makeClient("orchestrator");
  const { server } = await import("../plugin/agent-mode-override.js??cache=" + Math.random());
  const hooks = await server({ client });
  const hook = hooks["experimental.chat.system.transform"];

  await hook({ sessionID: "ses_test", model: { providerID: "llamaswap" } }, { system: systemArray });

  assert.strictEqual(systemArray, originalRef, "same array reference");
  assert.equal(systemArray.length, 1, "collapsed to 1 block");
  assert.ok(systemArray[0].includes("orchestrator"), "orchestrator reminder present");
  assert.ok(systemArray[0].includes("MCP codegraph instructions"), "original content preserved");
});

// ── mcp:allow agent (step-reviewer) with multiple blocks ────────────────────

test("step-reviewer (mcp:allow): MCP instructions + agent prompt collapsed to 1", async () => {
  // Mirrors what opencode does for mcp:allow agents: [agentSystemPrompt, mcpServerInstructions]
  const systemArray = [
    "You are the step-reviewer. Inspect the implementation and return VERDICT: PASS or FAIL.",
    "# MCP Server Instructions\n## codegraph\nCodegraph is a SQLite knowledge graph…",
  ];
  const originalRef = systemArray;

  const client = makeClient("step-reviewer");
  const { server } = await import("../plugin/agent-mode-override.js??cache=" + Math.random());
  const hooks = await server({ client });
  const hook = hooks["experimental.chat.system.transform"];

  await hook({ sessionID: "ses_reviewer", model: { providerID: "llamaswap" } }, { system: systemArray });

  assert.strictEqual(systemArray, originalRef, "same array reference");
  assert.equal(systemArray.length, 1, "must be exactly 1 — Jinja template requires this");
  assert.ok(systemArray[0].includes("step-reviewer"), "agent prompt content preserved");
  assert.ok(systemArray[0].includes("codegraph"), "MCP instruction content preserved");
});

// ── Load-order safety: collapse absorbs a late push (simulates see-image.js) ─

test("collapse absorbs a block pushed AFTER hook runs (simulates load-order issue)", async () => {
  // This test replicates what happened when agent-mode-override was earlier than see-image.js
  // in the plugin list: see-image pushed to output.system AFTER the collapse ran, leaving
  // 2 blocks. Moving agent-mode-override last fixes it — simulate that here by confirming
  // that a fresh invocation on [agentPrompt, seeImageBlock] correctly collapses to 1.
  const systemArray = [
    "You are the step-reviewer. Return VERDICT: PASS or FAIL.",
    "# Vision bridge — see_image tool\nYou have a see_image tool...",
  ];
  const originalRef = systemArray;

  const client = makeClient("step-reviewer");
  const { server } = await import("../plugin/agent-mode-override.js??cache=" + Math.random());
  const hooks = await server({ client });
  const hook = hooks["experimental.chat.system.transform"];

  await hook({ sessionID: "ses_reviewer", model: { providerID: "llamaswap" } }, { system: systemArray });

  assert.strictEqual(systemArray, originalRef, "same array reference");
  assert.equal(systemArray.length, 1, "MUST be 1 — two system blocks cause Jinja template crash");
  assert.ok(systemArray[0].includes("VERDICT"), "reviewer content preserved");
  assert.ok(systemArray[0].includes("see_image"), "see-image content preserved");
});

// ── Filters empty/null blocks ────────────────────────────────────────────────

test("empty/null blocks are filtered out before joining", async () => {
  const systemArray = ["real content", "", null, "  ", "more content"];
  const originalRef = systemArray;

  const client = makeClient("general");
  const { server } = await import("../plugin/agent-mode-override.js??cache=" + Math.random());
  const hooks = await server({ client });
  const hook = hooks["experimental.chat.system.transform"];

  await hook({ sessionID: "ses_test", model: {} }, { system: systemArray });

  assert.strictEqual(systemArray, originalRef, "same array reference");
  assert.equal(systemArray.length, 1);
  assert.ok(systemArray[0].includes("real content"));
  assert.ok(systemArray[0].includes("more content"));
  assert.ok(!systemArray[0].includes("null"), "null blocks not included");
});
