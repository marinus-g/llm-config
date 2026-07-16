import test from "node:test";
import assert from "node:assert/strict";
import { server } from "../plugin/orchestrator-no-edit.js";

function clientFor(agent) {
  return {
    session: { get: async () => ({ data: { agent } }) },
    tui: { showToast: async () => {} },
  };
}

test("orchestrator may execute workflow phase tools directly", async () => {
  const hooks = await server({ client: clientFor("orchestrator") });
  for (const tool of ["workflow_control", "workflow_verify", "workflow_commit", "workflow_handoff", "workflow_create"]) {
    await hooks["tool.execute.before"]({ tool, sessionID: "workflow-parent" }, { args: {} });
  }
});

test("orchestrator remains blocked from non-workflow tools", async () => {
  const hooks = await server({ client: clientFor("orchestrator") });
  await assert.rejects(
    hooks["tool.execute.before"]({ tool: "read", sessionID: "workflow-parent" }, { args: {} }),
    /orchestrator-router-guard/,
  );
});

test("workflow guard exception does not grant plan or subagent write access", async () => {
  const planHooks = await server({ client: clientFor("plan") });
  await planHooks["tool.execute.before"]({ tool: "workflow_handoff", sessionID: "plan-session" }, { args: {} });
  await assert.rejects(
    planHooks["tool.execute.before"]({ tool: "edit", sessionID: "plan-session" },
      { args: { file_path: "/tmp/source.js" } }),
    /must not edit source files directly/,
  );

  const subagentHooks = await server({ client: clientFor("general-dev") });
  await subagentHooks["tool.execute.before"]({ tool: "workflow_handoff", sessionID: "child-session" }, { args: {} });
});

test("orchestrator may call see_image directly", async () => {
  const hooks = await server({ client: clientFor("orchestrator") });
  await hooks["tool.execute.before"]({ tool: "see_image", sessionID: "test-session" }, { args: {} });
});

test("workflow-orchestrator and step-orchestrator may call see_image", async () => {
  for (const agentName of ["workflow-orchestrator", "step-orchestrator"]) {
    const hooks = await server({ client: clientFor(agentName) });
    await hooks["tool.execute.before"]({ tool: "see_image", sessionID: "test-session" }, { args: {} });
  }
});
