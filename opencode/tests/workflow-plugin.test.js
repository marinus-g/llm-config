import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setStorageRoot, workflowIdFromPath, loadWorkflow, saveWorkflow,
  parseWorkflowPath, snapshotWorkflowSource } from "../lib/workflow-core.js";
import { clearContextPressure, recordContextPressure } from "../lib/context-pressure.js";
import { isDanger, setDanger, setDangerStorageRoot } from "../lib/danger-mode.js";
import { server } from "../plugin/workflow.js";

const root = mkdtempSync(join(tmpdir(), "workflow-plugin-v2-"));
const repo = join(root, "repo");
const stateRoot = join(root, "state");
const sessionID = "session-test";
const prompts = [];
let sessionDirectory = repo;
let summarizeImpl = async () => ({ data: true });

function git(args) { return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim(); }

before(() => {
  setStorageRoot(stateRoot);
  setDangerStorageRoot(stateRoot);
  mkdirSync(repo);
  git(["init", "-b", "main"]);
  git(["config", "user.email", "workflow@example.invalid"]);
  git(["config", "user.name", "Workflow Test"]);
  writeFileSync(join(repo, "01-task.md"), `## Stage 01 - Test\n- [ ] **01.1 Complete test**\n  Implement the test behavior.\n  - Context7: required\n  - Verify: \`true\`\n- Stage gate: \`true\`\n`);
  git(["add", "."]); git(["commit", "-m", "initial"]);
});

test("danger mode asks for unsafe deletion but allows repository-local deletion", async () => {
  const sid = "session-danger-permission";
  sessionDirectory = repo;
  const hooks = await server({ client });
  setDanger(sid, true);

  const local = { status: "ask" };
  await hooks["permission.ask"]({
    sessionID: sid, type: "bash", pattern: "rm -rf ./build", callID: "local",
  }, local);
  assert.equal(local.status, "allow");

  const outside = { status: "allow" };
  await hooks["permission.ask"]({
    sessionID: sid, type: "bash", pattern: `rm -rf ${root}`, callID: "outside",
  }, outside);
  assert.equal(outside.status, "ask");

  const edit = { status: "ask" };
  await hooks["permission.ask"]({ sessionID: sid, type: "edit", pattern: "*" }, edit);
  assert.equal(edit.status, "allow");
  setDanger(sid, false);
});

test("danger mode survives plugin reload and is inherited by child sessions", async () => {
  const parent = "session-danger-parent";
  const child = "session-danger-child";
  const inheritedClient = {
    ...client,
    session: {
      ...client.session,
      get: async ({ path }) => ({ data: {
        directory: repo,
        ...(path.id === child ? { parentID: parent } : {}),
      } }),
    },
  };
  setDanger(parent, true);

  await server({ client: inheritedClient });
  const hooks = await server({ client: inheritedClient });
  assert.equal(isDanger(parent), true);

  const edit = { status: "ask" };
  await hooks["permission.ask"]({ sessionID: child, type: "edit", pattern: "*" }, edit);
  assert.equal(edit.status, "allow");

  const routine = { status: "ask" };
  await hooks["permission.ask"]({
    sessionID: child, type: "bash", pattern: "npm test", callID: "routine-child",
  }, routine);
  assert.equal(routine.status, "allow");

  const catastrophic = { status: "allow" };
  await hooks["permission.ask"]({
    sessionID: child, type: "bash", pattern: "mkfs.ext4 /dev/sda", callID: "danger-child",
  }, catastrophic);
  assert.equal(catastrophic.status, "ask");
  setDanger(parent, false);
});

test("danger mode replies to non-destructive permission events in child sessions", async () => {
  const parent = "session-danger-event-parent";
  const child = "session-danger-event-child";
  const replies = [];
  const eventClient = {
    ...client,
    postSessionIdPermissionsPermissionId: async (request) => { replies.push(request); return { data: true }; },
    session: {
      ...client.session,
      get: async ({ path }) => ({ data: {
        directory: repo,
        ...(path.id === child ? { parentID: parent } : {}),
      } }),
    },
  };
  const hooks = await server({ client: eventClient });
  setDanger(parent, true);

  const permissionEvent = (id, permission, patterns = ["*"]) => hooks.event({ event: {
    type: "permission.asked",
    properties: { id, sessionID: child, permission, patterns, metadata: {}, always: [] },
  } });
  await permissionEvent("mcp-codegraph", "codegraph_codegraph_context");
  await permissionEvent("mcp-context7", "_upstash_context7-mcp_query-docs");
  await permissionEvent("builtin-edit", "edit");
  await permissionEvent("bash-routine", "bash", ["npm test"]);
  await permissionEvent("bash-local-delete", "bash", ["rm -rf ./build"]);
  await permissionEvent("bash-destructive", "bash", ["mkfs.ext4 /dev/sda"]);
  await permissionEvent("bash-unclassifiable", "bash", []);
  await permissionEvent("mcp-codegraph", "codegraph_codegraph_context");

  assert.deepEqual(replies.map((request) => request.path.permissionID), [
    "mcp-codegraph", "mcp-context7", "builtin-edit", "bash-routine", "bash-local-delete",
  ]);
  assert.ok(replies.every((request) => request.path.id === child && request.body.response === "once"));
  setDanger(parent, false);
  await permissionEvent("danger-off", "codegraph_codegraph_search");
  assert.equal(replies.length, 5);
});

test("danger permission events support the v2 reply API", async () => {
  const sid = "session-danger-v2-reply";
  const replies = [];
  const hooks = await server({ client: {
    ...client,
    permission: { reply: async (request) => { replies.push(request); return { data: true }; } },
  } });
  setDanger(sid, true);
  await hooks.event({ event: { type: "permission.asked", properties: {
    id: "v2-request", sessionID: sid, permission: "codegraph_codegraph_search",
    patterns: ["*"], metadata: {}, always: [],
  } } });
  assert.deepEqual(replies, [{ path: { requestID: "v2-request" }, body: { reply: "once" } }]);
  setDanger(sid, false);
});

test("danger permission reply failures are retryable and never escape the event hook", async () => {
  const sid = "session-danger-reply-failure";
  let calls = 0;
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    const hooks = await server({ client: {
      ...client,
      postSessionIdPermissionsPermissionId: async () => {
        calls++;
        return { error: { data: { message: "permission backend failed" } } };
      },
    } });
    setDanger(sid, true);
    const event = { event: { type: "permission.asked", properties: {
      id: "failed-request", sessionID: sid, permission: "edit", patterns: ["*"], metadata: {}, always: [],
    } } };
    await hooks.event(event);
    await hooks.event(event);
    assert.equal(calls, 2);
    assert.equal(errors.length, 2);
    assert.match(errors[0], /permission backend failed/);
  } finally {
    setDanger(sid, false);
    console.error = originalError;
  }
});

test("danger permission reply tolerates missing APIs and already-resolved requests", async () => {
  const missingSid = "session-danger-missing-reply-api";
  const resolvedSid = "session-danger-resolved-reply";
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    const missingHooks = await server({ client });
    setDanger(missingSid, true);
    await missingHooks.event({ event: { type: "permission.asked", properties: {
      id: "missing-api", sessionID: missingSid, permission: "edit", patterns: ["*"], metadata: {}, always: [],
    } } });
    assert.match(errors[0], /no compatible permission reply API/);

    let calls = 0;
    const resolvedHooks = await server({ client: {
      ...client,
      postSessionIdPermissionsPermissionId: async () => { calls++; return { error: { message: "404 Not found" } }; },
    } });
    setDanger(resolvedSid, true);
    const resolvedEvent = { event: { type: "permission.asked", properties: {
      id: "resolved-request", sessionID: resolvedSid, permission: "edit", patterns: ["*"], metadata: {}, always: [],
    } } };
    await resolvedHooks.event(resolvedEvent);
    await resolvedHooks.event(resolvedEvent);
    assert.equal(calls, 1);
  } finally {
    setDanger(missingSid, false);
    setDanger(resolvedSid, false);
    console.error = originalError;
  }
});
after(() => rmSync(root, { recursive: true, force: true }));

const client = {
  tui: { showToast: async () => {} },
  session: {
    get: async ({ path }) => ({ data: {
      directory: sessionDirectory,
      ...(path.id === "context7-child" ? { parentID: sessionID } : {}),
      ...(path.id.endsWith(":reviewer") ? { agent: "step-reviewer", parentID: path.id.replace(/:reviewer$/, "") } : {}),
      ...(path.id.endsWith(":planner") ? { agent: "step-planner", parentID: path.id.replace(/:planner$/, "") } : {}),
    } }),
    promptAsync: async ({ body }) => { prompts.push(body); return { data: null }; },
    children: async ({ path }) => {
      const id = path.id;
      if (id.endsWith(":planner")) return { data: [
        { id: `${id}:explore`, agent: "explore", time: { created: Date.now() } },
        { id: `${id}:research`, agent: "research", time: { created: Date.now() } },
        { id: `${id}:orchestrator`, agent: "step-orchestrator", time: { created: Date.now() } },
        { id: `${id}:reviewer`, agent: "step-reviewer", time: { created: Date.now() } },
      ] };
      if (id.endsWith(":orchestrator")) return { data: [
        { id: `${id}:domain`, agent: "general-dev", time: { created: Date.now() } },
      ] };
      if (id.includes(":")) return { data: [] };
      return { data: [{ id: `${id}:planner`, agent: "step-planner", time: { created: Date.now() } }] };
    },
    messages: async ({ path } = { path: { id: "root" } }) => {
      const id = path.id;
      const agent = id.endsWith(":planner") ? "step-planner"
        : id.endsWith(":explore") ? "explore"
          : id.endsWith(":research") ? "research"
          : id.endsWith(":orchestrator") ? "step-orchestrator"
            : id.endsWith(":domain") ? "general-dev"
              : id.endsWith(":reviewer") ? "step-reviewer" : "orchestrator";
      const activeTool = ["explore", "research", "general-dev", "step-reviewer"].includes(agent);
      return { data: [{ info: { role: "assistant", agent, providerID: "test-provider", modelID: "test-model" }, parts: [
        ...(activeTool ? [{ type: "tool", tool: "read", state: { status: "completed" } }] : []),
        ...(agent === "research" ? [
          { type: "tool", tool: "_upstash_context7-mcp_resolve-library-id", state: { status: "completed" } },
          { type: "tool", tool: "_upstash_context7-mcp_query-docs", state: { status: "completed" } },
        ] : []),
        ...(agent === "step-reviewer" ? [{ type: "text", text: "VERDICT: PASS\nReviewed." }] : []),
        { type: "step-finish", tokens: {} },
      ] }] };
    },
    summarize: async (options) => summarizeImpl(options),
  },
};

test("child sessions cannot attach or execute workflow phase tools", async () => {
  const hooks = await server({ client });
  const file = join(repo, "01-task.md");
  const output = { parts: [] };
  await hooks["command.execute.before"]({ command: "workflow", sessionID,
    arguments: `start ${file}` }, output);
  const id = workflowIdFromPath(file);
  await hooks.event({ event: { type: "session.idle", properties: { sessionID } } });
  await hooks["tool.execute.after"]({ tool: "_upstash_context7-mcp_resolve-library-id",
    sessionID: "context7-child", callID: "resolve-child-guard" }, { output: "ok" });
  await hooks["tool.execute.after"]({ tool: "_upstash_context7-mcp_query-docs",
    sessionID: "context7-child", callID: "query-child-guard" }, { output: "ok" });
  assert.deepEqual(loadWorkflow(id).context7Evidence, { resolved: true, queried: true });
  await hooks.tool.workflow_control.execute({ action: "retry" }, { sessionID, metadata() {} });
  assert.deepEqual(loadWorkflow(id).context7Evidence, { resolved: false, queried: false });
  await assert.rejects(
    hooks.tool.workflow_control.execute({ action: "attach", workflowId: id },
      { sessionID: "context7-child", metadata() {} }),
    /primary orchestrator session/,
  );
  assert.equal(loadWorkflow(id).sessionID, sessionID);
  await assert.rejects(
    hooks.tool.workflow_verify.execute({ workflowId: id, scope: "todo", index: 0 },
      { sessionID: "context7-child", metadata() {} }),
    /primary orchestrator session/,
  );
  const branch = loadWorkflow(id).branch;
  await hooks.tool.workflow_control.execute({ action: "stop" }, { sessionID, metadata() {} });
  await hooks.tool.workflow_control.execute({ action: "reset", workflowId: id }, { sessionID, metadata() {} });
  execFileSync("git", ["checkout", "main"], { cwd: repo });
  execFileSync("git", ["branch", "-D", branch], { cwd: repo });
});

test("slash commands are consumed once when workflow_control repeats them after restart", async () => {
  const commandRepo = join(root, "command-receipt-repo");
  mkdirSync(commandRepo);
  execFileSync("git", ["init", "-b", "main"], { cwd: commandRepo });
  execFileSync("git", ["config", "user.email", "workflow@example.invalid"], { cwd: commandRepo });
  execFileSync("git", ["config", "user.name", "Workflow Test"], { cwd: commandRepo });
  const file = join(commandRepo, "workflow.md");
  writeFileSync(file, `## Stage 01 - Receipt\n- [ ] **01.1 Work**\n  Work.\n  - Context7: not-applicable\n  - Verify: \`true\`\n- Stage gate: \`true\`\n`);
  execFileSync("git", ["add", "."], { cwd: commandRepo });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: commandRepo });
  sessionDirectory = commandRepo;
  const sid = "session-command-receipt";
  const initialHooks = await server({ client });
  await initialHooks["command.execute.before"]({ command: "workflow", sessionID: sid,
    arguments: `start ${file}` }, { parts: [] });

  // A plugin restart loses old receipts but must still deduplicate every new slash command.
  const hooks = await server({ client });
  const context = { sessionID: sid, metadata() {} };
  const runSlashThenTool = async (raw, toolArgs) => {
    const direct = { parts: [] };
    await hooks["command.execute.before"]({ command: "workflow", sessionID: sid, arguments: raw }, direct);
    const result = await hooks.tool.workflow_control.execute(toolArgs, context);
    assert.equal(result, direct.parts.map((part) => part.text).join("\n"));
  };

  await runSlashThenTool("pause", { action: "pause" });
  let state = loadWorkflow(workflowIdFromPath(file));
  assert.equal(state.auditEvents.filter((entry) => entry.type === "workflow.pause_requested").length, 1);

  await runSlashThenTool("danger", { action: "danger", dangerMode: "toggle" });
  assert.equal(isDanger(sid), true);
  await runSlashThenTool("danger", { action: "danger", dangerMode: "toggle" });
  assert.equal(isDanger(sid), false);
  await runSlashThenTool("danger on", { action: "danger", dangerMode: "on" });
  assert.equal(isDanger(sid), true);
  await runSlashThenTool("danger off", { action: "danger", dangerMode: "off" });
  assert.equal(isDanger(sid), false);

  state = loadWorkflow(workflowIdFromPath(file));
  assert.deepEqual(state.auditEvents.filter((entry) => entry.type === "danger.toggled")
    .map((entry) => entry.details.on), [true, false, true, false]);

  // A direct tool call without a slash-command receipt still executes normally.
  await hooks.tool.workflow_control.execute({ action: "danger", dangerMode: "on" }, context);
  assert.equal(isDanger(sid), true);
  await runSlashThenTool("stop", { action: "stop" });
  assert.equal(loadWorkflow(workflowIdFromPath(file)).status, "stopped");
  assert.equal(isDanger(sid), false);
  const id = workflowIdFromPath(file);
  await runSlashThenTool(`reset ${id} confirm`, { action: "reset", workflowId: id });
  assert.equal(loadWorkflow(id), null);
  sessionDirectory = repo;
});

function workflowDraft() {
  return [
    { path: "00-context.md", content: "# Generated Workflow\n" },
    { path: "01-build.md", content: `## Stage 01 - Build\n- [ ] **01.1 Build feature**\n  Build it.\n  - Context7: not-applicable\n  - Verify: \`true\`\n- Stage gate: \`true\`\n` },
  ];
}

test("workflow_create rejects unarmed and child-session calls without writing", async () => {
  const hooks = await server({ client });
  const unarmed = join(repo, "unarmed-workflow");
  await assert.rejects(hooks.tool.workflow_create.execute({
    path: "unarmed-workflow", files: workflowDraft(),
  }, { sessionID: "session-unarmed-create", metadata() {} }), /not authorized.*\/workflow create/);
  assert.equal(existsSync(unarmed), false);

  const childClient = { ...client, session: { ...client.session,
    get: async ({ path }) => ({ data: { directory: repo,
      ...(path.id === "session-create-child" ? { parentID: "session-create-parent" } : {}) } }),
  } };
  const childHooks = await server({ client: childClient });
  await assert.rejects(childHooks.tool.workflow_create.execute({
    path: "child-workflow", files: workflowDraft(),
  }, { sessionID: "session-create-child", metadata() {} }), /primary orchestrator session/);
  assert.equal(existsSync(join(repo, "child-workflow")), false);
});

test("workflow_create enforces the authorized path and expiration", async () => {
  const hooks = await server({ client });
  const sid = "session-create-constraints";
  sessionDirectory = repo;
  await hooks["command.execute.before"]({ command: "workflow", sessionID: sid,
    arguments: "create authorized-workflow" }, { parts: [] });
  await assert.rejects(hooks.tool.workflow_create.execute({
    path: "different-workflow", files: workflowDraft(),
  }, { sessionID: sid, metadata() {} }), /authorized only for.*authorized-workflow/);
  assert.equal(existsSync(join(repo, "different-workflow")), false);

  const realNow = Date.now;
  try {
    Date.now = () => realNow() + (2 * 60 * 60 * 1000) + 1;
    await assert.rejects(hooks.tool.workflow_create.execute({
      path: "authorized-workflow", files: workflowDraft(),
    }, { sessionID: sid, metadata() {} }), /authorization expired/);
  } finally {
    Date.now = realNow;
  }
  assert.equal(existsSync(join(repo, "authorized-workflow")), false);
});

test("create command authorizes one successful workflow_create relative to the session", async () => {
  const hooks = await server({ client });
  const sid = "session-create-workflow";
  sessionDirectory = repo;
  const direct = { parts: [] };
  await hooks["command.execute.before"]({ command: "workflow", sessionID: sid,
    arguments: "create generated-workflow" }, direct);
  assert.match(direct.parts[0].text, /interactive workflow creation/);

  const result = await hooks.tool.workflow_create.execute({
    path: "generated-workflow",
    files: workflowDraft(),
  }, { sessionID: sid, metadata() {} });
  assert.match(result, /Created workflow/);
  assert.match(result, /Validated successfully/);
  assert.equal(existsSync(join(repo, "generated-workflow", "01-build.md")), true);
  rmSync(join(repo, "generated-workflow"), { recursive: true });
  await assert.rejects(hooks.tool.workflow_create.execute({
    path: "generated-workflow", files: workflowDraft(),
  }, { sessionID: sid, metadata() {} }), /not authorized/);
  assert.equal(existsSync(join(repo, "generated-workflow")), false);
  sessionDirectory = repo;
});

test("create command without a path authorizes a later chosen destination", async () => {
  const hooks = await server({ client });
  const sid = "session-create-workflow-no-path";
  sessionDirectory = repo;
  await hooks["command.execute.before"]({ command: "workflow", sessionID: sid,
    arguments: "create" }, { parts: [] });
  const result = await hooks.tool.workflow_create.execute({
    path: "chosen-workflow", files: workflowDraft(),
  }, { sessionID: sid, metadata() {} });
  assert.match(result, /Created workflow/);
  rmSync(join(repo, "chosen-workflow"), { recursive: true });
  sessionDirectory = repo;
});

test("create command path binding supports a quoted destination with spaces", async () => {
  const hooks = await server({ client });
  const sid = "session-create-workflow-spaces";
  sessionDirectory = repo;
  await hooks["command.execute.before"]({ command: "workflow", sessionID: sid,
    arguments: 'create "workflow with spaces"' }, { parts: [] });
  const result = await hooks.tool.workflow_create.execute({
    path: "workflow with spaces", files: workflowDraft(),
  }, { sessionID: sid, metadata() {} });
  assert.match(result, /Created workflow/);
  rmSync(join(repo, "workflow with spaces"), { recursive: true });
  sessionDirectory = repo;
});

test("drives one stage through plan, verification, gate, commit, and completion", async () => {
  const hooks = await server({ client });
  const controlResult = await hooks.tool.workflow_control.execute({
    action: "validate",
    path: join(repo, "01-task.md"),
    maxStageTurns: 80,
    maxTotalTurns: 800,
  }, { sessionID, metadata() {} });
  assert.match(controlResult, /Valid workflow/);
  const output = { parts: [] };
  await hooks["command.execute.before"]({ command: "workflow", sessionID, arguments: `start ${join(repo, "01-task.md")}` }, output);
  assert.match(output.parts[0].text, /Started/);
  assert.equal(prompts.at(-1).agent, "plan");

  const idle = () => hooks.event({ event: { type: "session.idle", properties: { sessionID } } });
  await idle();
  assert.match(prompts.at(-1).parts[0].text, /Workflow execute/);
  assert.match(prompts.at(-1).parts[0].text, /step-reviewer/);
  assert.match(prompts.at(-1).parts[0].text, /workflow_review/);
  assert.match(prompts.at(-1).parts[0].text, /authoritative gate/);
  assert.match(prompts.at(-1).parts[0].text, /snapshotted workflow source/);
  assert.match(prompts.at(-1).parts[0].text, /evidence\//);
  assert.match(prompts.at(-1).parts[0].text, /do NOT write files directly under/);

  await hooks["tool.execute.after"]({ tool: "_upstash_context7-mcp_resolve-library-id", sessionID: "context7-child", callID: "resolve" }, { output: "ok" });
  await hooks["tool.execute.after"]({ tool: "_upstash_context7-mcp_query-docs", sessionID: "context7-child", callID: "query" }, { output: "ok" });

  const id = workflowIdFromPath(join(repo, "01-task.md"));
  assert.deepEqual(loadWorkflow(id).context7Evidence, { resolved: true, queried: true });
  const context = { sessionID, metadata() {} };
  const review = await hooks.tool.workflow_review.execute({
    workflowId: id, todoId: "01.1", verdict: "PASS",
  }, { sessionID: `${sessionID}:planner:reviewer`, metadata() {} });
  assert.match(review, /Recorded VERDICT: PASS/);
  await assert.rejects(() => hooks.tool.workflow_review.execute({
    workflowId: id, todoId: "01.1", verdict: "PASS",
  }, context), /step-reviewer/);
  await hooks.tool.workflow_verify.execute({ workflowId: id, scope: "todo", index: 0 }, context);
  await idle();
  assert.match(prompts.at(-1).parts[0].text, /gate/);
  assert.match(readFileSync(join(repo, "01-task.md"), "utf8"), /\[x\]/);

  await hooks.tool.workflow_verify.execute({ workflowId: id, scope: "stage", index: 0 }, context);
  await idle();
  assert.match(prompts.at(-1).parts[0].text, /workflow_commit/);

  await hooks.tool.workflow_commit.execute({ workflowId: id }, context);
  setDanger(sessionID, true);
  await idle();
  let state = loadWorkflow(id);
  assert.equal(state.status, "running");
  assert.equal(state.phase, "stage_handoff");
  assert.equal(state.stageTransition.nextStage, null);
  assert.match(prompts.at(-1).parts[0].text, /Stage 01 handoff/);

  await hooks.tool.workflow_handoff.execute({ workflowId: id, stage: "1",
    overview: "Implemented and verified the test behavior.", decisions: [], contracts: [], deviations: [], risks: [] }, context);
  await idle();
  state = loadWorkflow(id);
  assert.equal(state.status, "completed");
  assert.equal(state.commits.length, 1);
  assert.ok(state.reporting.todos["01.1"]);
  assert.ok(state.reporting.stages["1"]);
  assert.ok(prompts.some((prompt) => /Step report — 01\.1/.test(prompt.parts[0].text)));
  assert.ok(prompts.some((prompt) => /Stage report — 1: Test/.test(prompt.parts[0].text)));
  assert.ok(prompts.some((prompt) => /Implemented: Implemented and verified the test behavior\./.test(prompt.parts[0].text)));
  assert.equal(isDanger(sessionID), false);
  assert.match(git(["log", "-1", "--pretty=%s"]), /workflow\(1\): Test/);
});

test("workflow verification rejects a prose-only planner without child evidence", async () => {
  const evidenceRepo = join(root, "missing-execution-evidence");
  mkdirSync(evidenceRepo);
  execFileSync("git", ["init", "-b", "main"], { cwd: evidenceRepo });
  execFileSync("git", ["config", "user.email", "workflow@example.invalid"], { cwd: evidenceRepo });
  execFileSync("git", ["config", "user.name", "Workflow Test"], { cwd: evidenceRepo });
  const file = join(evidenceRepo, "workflow.md");
  writeFileSync(file, "## Stage 01 - Evidence\n- [ ] **01.1 Work**\n  Work.\n  - Context7: not-applicable\n  - Verify: `true`\n- Stage gate: `true`\n");
  execFileSync("git", ["add", "."], { cwd: evidenceRepo });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: evidenceRepo });
  sessionDirectory = evidenceRepo;
  const sid = "session-missing-execution-evidence";
  const noChildrenClient = { ...client, session: { ...client.session,
    children: async () => ({ data: [] }) } };
  const hooks = await server({ client: noChildrenClient });
  await hooks["command.execute.before"]({ command: "workflow", sessionID: sid,
    arguments: `start ${file}` }, { parts: [] });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } });
  const id = workflowIdFromPath(file);
  await assert.rejects(hooks.tool.workflow_verify.execute(
    { workflowId: id, scope: "todo", index: 0 }, { sessionID: sid, metadata() {} }),
  /execution evidence incomplete/);
  assert.equal(loadWorkflow(id).todos[0].done, false);
});

test("rewind reopens a stage while preserving earlier commits", async () => {
  const rewindRepo = join(root, "rewind-stage");
  mkdirSync(rewindRepo);
  execFileSync("git", ["init", "-b", "main"], { cwd: rewindRepo });
  execFileSync("git", ["config", "user.email", "workflow@example.invalid"], { cwd: rewindRepo });
  execFileSync("git", ["config", "user.name", "Workflow Test"], { cwd: rewindRepo });
  const file = join(rewindRepo, "workflow.md");
  writeFileSync(file, "## Stage 01 - Kept\n- [x] **01.1 Kept work**\n  Kept.\n  - Context7: not-applicable\n  - Verify: `true`\n- Stage gate: `true`\n\n## Stage 02 - Reopen\n- [x] **02.1 Reopen work**\n  Reopen.\n  - Context7: not-applicable\n  - Verify: `true`\n- Stage gate: `true`\n");
  execFileSync("git", ["add", "."], { cwd: rewindRepo });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: rewindRepo });
  sessionDirectory = rewindRepo;
  const sid = "session-rewind-stage";
  const hooks = await server({ client });
  const id = workflowIdFromPath(file);
  const parsed = parseWorkflowPath(file);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: rewindRepo, encoding: "utf8" }).trim();
  saveWorkflow({ schemaVersion: 6, id, sourcePath: parsed.sourcePath,
    sourceSnapshot: snapshotWorkflowSource(parsed.sourcePath), projectCwd: rewindRepo, sessionID: sid,
    status: "paused", phase: "todo_execute", stage: "2", todos: parsed.todos, stages: parsed.stages,
    cursor: 1, attempts: 2, turns: 0, stageTurns: 0, maxStageTurns: 80, maxTotalTurns: 800,
    branch: "main", baseBranch: "main", baseHead: head, expectedHead: head,
    stagePlans: { "1": { completedAt: 1 }, "2": { completedAt: 2 } }, todoEvidence: { 0: { passed: true } },
    gateEvidence: null, commitEvidence: null, manualEvidence: [], context7Evidence: { resolved: true, queried: true },
    executionEvidence: { ready: true }, skipReasons: {}, commits: [{ stage: "1", sha: head.slice(0, 12), at: 1 }],
    blocker: null, startedAt: 1, completedAt: null, noConfirm: false, auditEvents: [], pauseRequest: null,
    pausedCheckpoint: { kind: "todo_verified" }, stageHandoffs: {}, stageCompaction: null, stageTransition: null,
    reporting: { stageStartedAt: 1, todoStartedAt: 2,
      todos: { "01.1": { todo: "01.1" }, "02.1": { todo: "02.1" } }, stages: {} } });
  const result = await hooks.tool.workflow_control.execute(
    { action: "rewind", stage: "2", confirm: true }, { sessionID: sid, metadata() {} });
  assert.match(result, /Rewound to Stage 2/);
  const state = loadWorkflow(id);
  assert.equal(state.phase, "stage_plan");
  assert.equal(state.status, "paused");
  assert.deepEqual(state.commits.map((commit) => commit.stage), ["1"]);
  assert.equal(state.todos.find((todo) => todo.id === "01.1").done, true);
  assert.equal(state.todos.find((todo) => todo.id === "02.1").done, false);
  assert.match(readFileSync(file, "utf8"), /- \[x\] \*\*01\.1 Kept work\*\*/);
  assert.match(readFileSync(file, "utf8"), /- \[ \] \*\*02\.1 Reopen work\*\*/);
});

test("restores a persisted session attachment after plugin state is lost", async () => {
  const persistedSession = "session-persisted-attachment";
  const persistedID = "persisted-attachment-test";
  const template = loadWorkflow(workflowIdFromPath(join(repo, "01-task.md")));
  saveWorkflow({
    ...template,
    id: persistedID,
    sessionID: persistedSession,
    status: "paused",
    blocker: null,
  });
  setDanger(persistedSession, true);

  const hooks = await server({ client });
  const status = { parts: [] };
  await hooks["command.execute.before"]({
    command: "workflow", sessionID: persistedSession, arguments: "status",
  }, status);
  assert.match(status.parts[0].text, new RegExp(persistedID));

  await hooks["command.execute.before"]({
    command: "workflow", sessionID: persistedSession, arguments: "danger off",
  }, { parts: [] });
  assert.equal(isDanger(persistedSession), false);
  await hooks["command.execute.before"]({
    command: "workflow", sessionID: persistedSession, arguments: `reset ${persistedID} confirm`,
  }, { parts: [] });
});

test("manual confirmation completes a pending checkpoint pause", async () => {
  const manualRepo = join(root, "manual-repo");
  mkdirSync(manualRepo);
  execFileSync("git", ["init", "-b", "main"], { cwd: manualRepo });
  execFileSync("git", ["config", "user.email", "workflow@example.invalid"], { cwd: manualRepo });
  execFileSync("git", ["config", "user.name", "Workflow Test"], { cwd: manualRepo });
  const file = join(manualRepo, "01-manual.md");
  writeFileSync(file, `## Stage 01 - Manual\n- [ ] **01.1 Inspect page**\n  Inspect the page.\n  - Context7: not-applicable\n  - Verify manual: Confirm the page renders.\n- Stage gate: \`true\`\n`);
  execFileSync("git", ["add", "."], { cwd: manualRepo });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: manualRepo });
  sessionDirectory = manualRepo;
  const sid = "session-manual";
  const hooks = await server({ client });
  const output = { parts: [] };
  await hooks["command.execute.before"]({ command: "workflow", sessionID: sid, arguments: `start ${file}` }, output);
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } });
  await hooks["command.execute.before"]({ command: "workflow", sessionID: sid, arguments: "pause" }, { parts: [] });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } });
  const id = workflowIdFromPath(file);
  assert.equal(loadWorkflow(id).phase, "manual_wait");
  await hooks["command.execute.before"]({ command: "workflow", sessionID: sid, arguments: "confirm rendered correctly" }, { parts: [] });
  assert.equal(loadWorkflow(id).phase, "todo_execute");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(loadWorkflow(id).phase, "stage_gate");
  assert.equal(loadWorkflow(id).status, "paused");
  assert.equal(loadWorkflow(id).pausedCheckpoint.kind, "todo_verified");
});

test("--no-confirm auto-confirms manual verification steps", async () => {
  const autoRepo = join(root, "auto-confirm-repo");
  mkdirSync(autoRepo);
  execFileSync("git", ["init", "-b", "main"], { cwd: autoRepo });
  execFileSync("git", ["config", "user.email", "workflow@example.invalid"], { cwd: autoRepo });
  execFileSync("git", ["config", "user.name", "Workflow Test"], { cwd: autoRepo });
  const file = join(autoRepo, "01-auto.md");
  writeFileSync(file, `## Stage 01 - Auto Confirm\n- [ ] **01.1 Inspect**\n  Inspect the page.\n  - Context7: not-applicable\n  - Verify manual: Confirm the page renders.\n- Stage gate: \`true\`\n`);
  execFileSync("git", ["add", "."], { cwd: autoRepo });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: autoRepo });
  sessionDirectory = autoRepo;
  const sid = "session-auto-confirm";
  const hooks = await server({ client });
  const output = { parts: [] };
  await hooks["command.execute.before"]({ command: "workflow", sessionID: sid, arguments: `start ${file} --no-confirm` }, output);
  assert.match(output.parts[0].text, /Started/);
  const id = workflowIdFromPath(file);
  const state = loadWorkflow(id);
  assert.equal(state.noConfirm, true);
  // First idle advances stage_plan → todo_execute; second idle hits manual verification with --no-confirm
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } });
  // wait for async settle
  await new Promise((resolve) => setTimeout(resolve, 100));
  const stateAfter = loadWorkflow(id);
  assert.equal(stateAfter.phase, "stage_gate");
});

test("without --no-confirm manual TODO still pauses in manual_wait", async () => {
  const noAutoRepo = join(root, "no-auto-repo");
  mkdirSync(noAutoRepo);
  execFileSync("git", ["init", "-b", "main"], { cwd: noAutoRepo });
  execFileSync("git", ["config", "user.email", "workflow@example.invalid"], { cwd: noAutoRepo });
  execFileSync("git", ["config", "user.name", "Workflow Test"], { cwd: noAutoRepo });
  const file = join(noAutoRepo, "01-no-auto.md");
  writeFileSync(file, `## Stage 01 - No Auto\n- [ ] **01.1 Inspect**\n  Inspect.\n  - Context7: not-applicable\n  - Verify manual: Confirm it works.\n- Stage gate: \`true\`\n`);
  execFileSync("git", ["add", "."], { cwd: noAutoRepo });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: noAutoRepo });
  sessionDirectory = noAutoRepo;
  const sid = "session-no-auto-confirm";
  const hooks = await server({ client });
  const output = { parts: [] };
  await hooks["command.execute.before"]({ command: "workflow", sessionID: sid, arguments: `start ${file}` }, output);
  const id = workflowIdFromPath(file);
  const state = loadWorkflow(id);
  assert.equal(state.noConfirm, false);
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const stateAfter = loadWorkflow(id);
  assert.equal(stateAfter.phase, "manual_wait");
});

test("retry auto-heals HEAD mismatch blocker", async () => {
  const retryRepo = join(root, "retry-heal-repo");
  mkdirSync(retryRepo);
  execFileSync("git", ["init", "-b", "main"], { cwd: retryRepo });
  execFileSync("git", ["config", "user.email", "workflow@example.invalid"], { cwd: retryRepo });
  execFileSync("git", ["config", "user.name", "Workflow Test"], { cwd: retryRepo });
  const file = join(retryRepo, "01-retry.md");
  writeFileSync(file, `## Stage 01 - Retry Heal\n- [ ] **01.1 Do work**\n  Do the work.\n  - Context7: not-applicable\n  - Verify: \`true\`\n- Stage gate: \`true\`\n`);
  execFileSync("git", ["add", "."], { cwd: retryRepo });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: retryRepo });
  sessionDirectory = retryRepo;
  const sid = "session-retry-heal";
  const hooks = await server({ client });

  // Start the workflow
  const output = { parts: [] };
  await hooks["command.execute.before"]({ command: "workflow", sessionID: sid, arguments: `start ${file}` }, output);
  const id = workflowIdFromPath(file);
  const state = loadWorkflow(id);
  const originalHead = state.expectedHead;

  // Simulate an external commit on the workflow branch (e.g. lockfile commit during task execution)
  writeFileSync(join(retryRepo, "extra.txt"), "extra");
  execFileSync("git", ["add", "."], { cwd: retryRepo });
  execFileSync("git", ["commit", "-m", "simulated external commit"], { cwd: retryRepo });
  const newHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: retryRepo, encoding: "utf8" }).trim();
  assert.notEqual(originalHead, newHead);

  // Trigger onIdle — should detect HEAD mismatch and block
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } });
  await new Promise((resolve) => setTimeout(resolve, 100));
  let stateAfterBlock = loadWorkflow(id);
  assert.equal(stateAfterBlock.status, "blocked");
  assert.equal(stateAfterBlock.blocker.reason, "workflow branch HEAD changed unexpectedly");
  assert.equal(stateAfterBlock.expectedHead, originalHead); // expectedHead was NOT updated by onIdle

  // Trigger retry — should auto-heal expectedHead
  await hooks["command.execute.before"]({ command: "workflow", sessionID: sid, arguments: "retry" }, { parts: [] });
  stateAfterBlock = loadWorkflow(id);
  assert.equal(stateAfterBlock.status, "running");
  assert.equal(stateAfterBlock.blocker, null);
  assert.equal(stateAfterBlock.expectedHead, newHead); // expectedHead IS now updated

  // Trigger onIdle — should NOT re-block on HEAD mismatch
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } });
  await new Promise((resolve) => setTimeout(resolve, 100));
  stateAfterBlock = loadWorkflow(id);
  assert.notEqual(stateAfterBlock.status, "blocked", "workflow should not be blocked after retry auto-heal");
});

test("resume auto-heals HEAD mismatch blocker", async () => {
  const resumeRepo = join(root, "resume-heal-repo");
  mkdirSync(resumeRepo);
  execFileSync("git", ["init", "-b", "main"], { cwd: resumeRepo });
  execFileSync("git", ["config", "user.email", "workflow@example.invalid"], { cwd: resumeRepo });
  execFileSync("git", ["config", "user.name", "Workflow Test"], { cwd: resumeRepo });
  const file = join(resumeRepo, "01-resume.md");
  writeFileSync(file, `## Stage 01 - Resume Heal\n- [ ] **01.1 Do work**\n  Do the work.\n  - Context7: not-applicable\n  - Verify: \`true\`\n- Stage gate: \`true\`\n`);
  execFileSync("git", ["add", "."], { cwd: resumeRepo });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: resumeRepo });
  sessionDirectory = resumeRepo;
  const sid = "session-resume-heal";
  const hooks = await server({ client });

  // Start the workflow
  const output = { parts: [] };
  await hooks["command.execute.before"]({ command: "workflow", sessionID: sid, arguments: `start ${file}` }, output);
  const id = workflowIdFromPath(file);
  const state = loadWorkflow(id);
  const originalHead = state.expectedHead;

  // Pause first
  await hooks["command.execute.before"]({ command: "workflow", sessionID: sid, arguments: "pause" }, { parts: [] });

  // Simulate external commit while paused
  writeFileSync(join(resumeRepo, "extra.txt"), "extra");
  execFileSync("git", ["add", "."], { cwd: resumeRepo });
  execFileSync("git", ["commit", "-m", "simulated external commit"], { cwd: resumeRepo });
  const newHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: resumeRepo, encoding: "utf8" }).trim();
  assert.notEqual(originalHead, newHead);

  // Manually set blocker to simulate a HEAD mismatch block
  const pausedState = loadWorkflow(id);
  pausedState.status = "blocked";
  pausedState.blocker = { reason: "workflow branch HEAD changed unexpectedly", at: Date.now() };
  saveWorkflow(pausedState);
  // Note: expectedHead is still originalHead

  // Resume — should auto-heal expectedHead
  await hooks["command.execute.before"]({ command: "workflow", sessionID: sid, arguments: "resume" }, { parts: [] });
  const resumedState = loadWorkflow(id);
  assert.equal(resumedState.status, "running");
  assert.equal(resumedState.blocker, null);
  assert.equal(resumedState.expectedHead, newHead, "expectedHead should be updated to current HEAD on resume");

  // Trigger onIdle — should NOT re-block
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const finalState = loadWorkflow(id);
  assert.notEqual(finalState.status, "blocked", "workflow should not be blocked after resume auto-heal");
});

test("retry without HEAD mismatch works normally", async () => {
  const normalRetryRepo = join(root, "normal-retry-repo");
  mkdirSync(normalRetryRepo);
  execFileSync("git", ["init", "-b", "main"], { cwd: normalRetryRepo });
  execFileSync("git", ["config", "user.email", "workflow@example.invalid"], { cwd: normalRetryRepo });
  execFileSync("git", ["config", "user.name", "Workflow Test"], { cwd: normalRetryRepo });
  const file = join(normalRetryRepo, "01-normal.md");
  writeFileSync(file, `## Stage 01 - Normal Retry\n- [ ] **01.1 Do work**\n  Do the work.\n  - Context7: not-applicable\n  - Verify: \`true\`\n- Stage gate: \`true\`\n`);
  execFileSync("git", ["add", "."], { cwd: normalRetryRepo });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: normalRetryRepo });
  sessionDirectory = normalRetryRepo;
  const sid = "session-normal-retry";
  const hooks = await server({ client });

  // Start the workflow
  const output = { parts: [] };
  await hooks["command.execute.before"]({ command: "workflow", sessionID: sid, arguments: `start ${file}` }, output);
  const id = workflowIdFromPath(file);
  const state = loadWorkflow(id);
  const originalHead = state.expectedHead;

  // Simulate a non-HEAD blocker (e.g. turn limit)
  const blockedState = loadWorkflow(id);
  blockedState.status = "blocked";
  blockedState.blocker = { reason: "stage turn limit 80 reached", at: Date.now() };

  // Retry — should NOT change expectedHead when blocker is not a HEAD mismatch
  await hooks["command.execute.before"]({ command: "workflow", sessionID: sid, arguments: "retry" }, { parts: [] });
  const retriedState = loadWorkflow(id);
  assert.equal(retriedState.status, "running");
  assert.equal(retriedState.blocker, null);
  assert.equal(retriedState.expectedHead, originalHead, "expectedHead should remain unchanged when blocker is not HEAD mismatch");
  assert.equal(retriedState.attempts, 1, "attempts should increment on retry");
});

test("auto-compacts at a verified high-pressure boundary before injecting the next TODO", async () => {
  const compactRepo = join(root, "compact-repo");
  mkdirSync(compactRepo);
  execFileSync("git", ["init", "-b", "main"], { cwd: compactRepo });
  execFileSync("git", ["config", "user.email", "workflow@example.invalid"], { cwd: compactRepo });
  execFileSync("git", ["config", "user.name", "Workflow Test"], { cwd: compactRepo });
  const file = join(compactRepo, "01-compact.md");
  writeFileSync(file, `## Stage 01 - Compact\n- [ ] **01.1 First**\n  First task.\n  - Context7: not-applicable\n  - Verify: \`true\`\n- [ ] **01.2 Second**\n  Second task.\n  - Context7: not-applicable\n  - Verify: \`true\`\n- Stage gate: \`true\`\n`);
  execFileSync("git", ["add", "."], { cwd: compactRepo });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: compactRepo });
  sessionDirectory = compactRepo;
  const sid = "session-auto-compact";
  const hooks = await server({ client });
  await hooks["command.execute.before"](
    { command: "workflow", sessionID: sid, arguments: `start ${file}` }, { parts: [] });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } });
  const id = workflowIdFromPath(file);
  await hooks.tool.workflow_verify.execute(
    { workflowId: id, scope: "todo", index: 0 }, { sessionID: sid, metadata() {} });
  recordContextPressure({
    sessionID: sid,
    tokens: { input: 20, cache: { read: 60 } },
    limit: 100,
    providerID: "provider",
    modelID: "model",
  });

  let releaseSummary;
  summarizeImpl = async () => new Promise((resolve) => { releaseSummary = resolve; });
  const promptsBefore = prompts.length;
  const idlePromise = hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  let state = loadWorkflow(id);
  assert.equal(state.status, "paused");
  assert.equal(state.phase, "compact_wait");
  assert.equal(state.todos[0].done, true);
  assert.equal(prompts.length, promptsBefore + 1, "only the completed-step report may be added before compaction");
  assert.match(prompts.at(-1).parts[0].text, /Step report — 01\.1/);
  assert.doesNotMatch(prompts.at(-1).parts[0].text, /Workflow execute — 01\.2/);
  assert.match(readFileSync(file, "utf8"), /\[x\] \*\*01\.1 First/);

  const autoContinue = { enabled: true };
  await hooks["experimental.compaction.autocontinue"]({ sessionID: sid }, autoContinue);
  assert.equal(autoContinue.enabled, false);
  releaseSummary({ data: true });
  await idlePromise;

  state = loadWorkflow(id);
  assert.equal(state.status, "running");
  assert.equal(state.phase, "todo_execute");
  assert.equal(state.cursor, 1);
  assert.match(prompts.at(-1).parts[0].text, /01\.2 Second/);
  assert.equal(prompts.length, promptsBefore + 2);
  clearContextPressure(sid);
  summarizeImpl = async () => ({ data: true });
});

test("compaction failure pauses at the completed boundary and manual resume advances", async () => {
  const failureRepo = join(root, "compact-failure-repo");
  mkdirSync(failureRepo);
  execFileSync("git", ["init", "-b", "main"], { cwd: failureRepo });
  execFileSync("git", ["config", "user.email", "workflow@example.invalid"], { cwd: failureRepo });
  execFileSync("git", ["config", "user.name", "Workflow Test"], { cwd: failureRepo });
  const file = join(failureRepo, "01-compact-failure.md");
  writeFileSync(file, `## Stage 01 - Compact\n- [ ] **01.1 First**\n  First task.\n  - Context7: not-applicable\n  - Verify: \`true\`\n- [ ] **01.2 Second**\n  Second task.\n  - Context7: not-applicable\n  - Verify: \`true\`\n- Stage gate: \`true\`\n`);
  execFileSync("git", ["add", "."], { cwd: failureRepo });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: failureRepo });
  sessionDirectory = failureRepo;
  const sid = "session-compact-failure";
  const hooks = await server({ client });
  await hooks["command.execute.before"](
    { command: "workflow", sessionID: sid, arguments: `start ${file}` }, { parts: [] });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } });
  const id = workflowIdFromPath(file);
  await hooks.tool.workflow_verify.execute(
    { workflowId: id, scope: "todo", index: 0 }, { sessionID: sid, metadata() {} });
  recordContextPressure({
    sessionID: sid,
    tokens: { input: 80 },
    limit: 100,
    providerID: "provider",
    modelID: "model",
  });
  summarizeImpl = async () => { throw new Error("summary unavailable"); };
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } });

  let state = loadWorkflow(id);
  assert.equal(state.status, "paused");
  assert.equal(state.phase, "compact_wait");
  assert.match(state.blocker.reason, /summary unavailable/);
  assert.equal(state.todos[0].done, true);

  await hooks["command.execute.before"](
    { command: "workflow", sessionID: sid, arguments: "resume" }, { parts: [] });
  state = loadWorkflow(id);
  assert.equal(state.status, "running");
  assert.equal(state.cursor, 1);
  assert.match(prompts.at(-1).parts[0].text, /01\.2 Second/);
  clearContextPressure(sid);
  summarizeImpl = async () => ({ data: true });
});

test("blocks when workflow source drifts", async () => {
  const driftRepo = join(root, "drift-repo");
  mkdirSync(driftRepo);
  execFileSync("git", ["init", "-b", "main"], { cwd: driftRepo });
  execFileSync("git", ["config", "user.email", "workflow@example.invalid"], { cwd: driftRepo });
  execFileSync("git", ["config", "user.name", "Workflow Test"], { cwd: driftRepo });
  const file = join(driftRepo, "01-drift.md");
  writeFileSync(file, `## Stage 01 - Drift\n- [ ] **01.1 Work**\n  Original requirement.\n  - Context7: not-applicable\n  - Verify: \`true\`\n- Stage gate: \`true\`\n`);
  execFileSync("git", ["add", "."], { cwd: driftRepo });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: driftRepo });
  sessionDirectory = driftRepo;
  const sid = "session-source-drift";
  const hooks = await server({ client });
  await hooks["command.execute.before"]({ command: "workflow", sessionID: sid, arguments: `start ${file}` }, { parts: [] });
  writeFileSync(file, readFileSync(file, "utf8").replace("Original requirement.", "Changed requirement."));
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } });
  const state = loadWorkflow(workflowIdFromPath(file));
  assert.equal(state.status, "blocked");
  assert.match(state.blocker.reason, /workflow source changed/);
});

test("session.error preserves actionable execution evidence details", async () => {
  const errorRepo = join(root, "session-error-repo");
  mkdirSync(errorRepo);
  execFileSync("git", ["init", "-b", "main"], { cwd: errorRepo });
  execFileSync("git", ["config", "user.email", "workflow@example.invalid"], { cwd: errorRepo });
  execFileSync("git", ["config", "user.name", "Workflow Test"], { cwd: errorRepo });
  const file = join(errorRepo, "01-error.md");
  writeFileSync(file, `## Stage 01 - Error\n- [ ] **01.1 Work**\n  Error path.\n  - Context7: required\n  - Verify: \`true\`\n- Stage gate: \`true\`\n`);
  execFileSync("git", ["add", "."], { cwd: errorRepo });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: errorRepo });
  sessionDirectory = errorRepo;
  const sid = "session-error-blocker";
  const hooks = await server({ client });
  await hooks["command.execute.before"]({ command: "workflow", sessionID: sid, arguments: `start ${file}` }, { parts: [] });
  const id = workflowIdFromPath(file);
  const state = loadWorkflow(id);
  state.executionEvidence = {
    ready: false,
    missing: ["completed step-reviewer with inspection evidence", "passing reviewer verdict (got none)"],
    plannerID: null,
    exploreIDs: [],
    researchIDs: [],
    orchestratorIDs: [],
    implementationAgentIDs: [],
    reviewerID: null,
    verdict: "",
    checkedAt: Date.now(),
  };
  state.blocker = { reason: "session error", at: Date.now() };
  saveWorkflow(state);
  await hooks.event({ event: { type: "session.error", properties: { sessionID: sid } } });
  const updated = loadWorkflow(id);
  assert.equal(updated.status, "paused");
  assert.match(updated.blocker.reason, /Execution evidence is incomplete for 01\.1/);
  assert.doesNotMatch(updated.blocker.reason, /^session error$/);
});

test("recovers from documents and Git, then exposes log, doctor, and finish", async () => {
  const recoveryRepo = join(root, "recovery-repo");
  mkdirSync(recoveryRepo);
  execFileSync("git", ["init", "-b", "main"], { cwd: recoveryRepo });
  execFileSync("git", ["config", "user.email", "workflow@example.invalid"], { cwd: recoveryRepo });
  execFileSync("git", ["config", "user.name", "Workflow Test"], { cwd: recoveryRepo });
  const file = join(recoveryRepo, "01-recover.md");
  writeFileSync(file, `## Stage 01 - Recover\n- [ ] **01.1 Work**\n  Recover this work.\n  - Context7: not-applicable\n  - Verify: \`true\`\n- Stage gate: \`true\`\n`);
  execFileSync("git", ["add", "."], { cwd: recoveryRepo });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: recoveryRepo });
  const id = workflowIdFromPath(file);
  const branch = `workflow/${id}`;
  execFileSync("git", ["switch", "-c", branch], { cwd: recoveryRepo });
  writeFileSync(file, readFileSync(file, "utf8").replace("- [ ]", "- [x]"));
  execFileSync("git", ["add", "."], { cwd: recoveryRepo });
  execFileSync("git", ["commit", "-m", "workflow(1): Recover"], { cwd: recoveryRepo });
  sessionDirectory = recoveryRepo;
  const sid = "session-recovery";
  const hooks = await server({ client });

  const preview = { parts: [] };
  await hooks["command.execute.before"]({ command: "workflow", sessionID: sid, arguments: `recover ${file}` }, preview);
  assert.match(preview.parts[0].text, /Recovery preview/);
  assert.match(preview.parts[0].text, /1\/1 checked/);

  const confirmed = { parts: [] };
  await hooks["command.execute.before"]({ command: "workflow", sessionID: sid, arguments: `recover ${file} confirm` }, confirmed);
  assert.match(confirmed.parts[0].text, /Recovered in completed state/);
  assert.equal(loadWorkflow(id).status, "completed");

  const logOutput = { parts: [] };
  await hooks["command.execute.before"]({ command: "workflow", sessionID: sid, arguments: "log" }, logOutput);
  assert.match(logOutput.parts[0].text, /workflow\.recovered/);

  const doctorOutput = { parts: [] };
  await hooks["command.execute.before"]({ command: "workflow", sessionID: sid, arguments: "doctor" }, doctorOutput);
  assert.match(doctorOutput.parts[0].text, /No issues found/);

  const before = git(["rev-parse", "HEAD"]);
  const finishOutput = { parts: [] };
  await hooks["command.execute.before"]({ command: "workflow", sessionID: sid, arguments: "finish" }, finishOutput);
  assert.match(finishOutput.parts[0].text, /git merge --ff-only/);
  assert.equal(git(["rev-parse", "HEAD"]), before);
});

test("recovery resumes an earlier checked but uncommitted stage at its gate", async () => {
  const partialRepo = join(root, "partial-recovery-repo");
  mkdirSync(partialRepo);
  execFileSync("git", ["init", "-b", "main"], { cwd: partialRepo });
  execFileSync("git", ["config", "user.email", "workflow@example.invalid"], { cwd: partialRepo });
  execFileSync("git", ["config", "user.name", "Workflow Test"], { cwd: partialRepo });
  const file = join(partialRepo, "workflow.md");
  writeFileSync(file, `## Stage 01 - First\n- [ ] **01.1 First work**\n  First.\n  - Context7: not-applicable\n  - Verify: \`true\`\n- Stage gate: \`true\`\n## Stage 02 - Second\n- [ ] **02.1 Second work**\n  Second.\n  - Context7: not-applicable\n  - Verify: \`true\`\n- Stage gate: \`true\`\n`);
  execFileSync("git", ["add", "."], { cwd: partialRepo });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: partialRepo });
  const id = workflowIdFromPath(file);
  execFileSync("git", ["switch", "-c", `workflow/${id}`], { cwd: partialRepo });
  writeFileSync(file, readFileSync(file, "utf8").replace("- [ ] **01.1", "- [x] **01.1"));
  sessionDirectory = partialRepo;
  const sid = "session-partial-recovery";
  const hooks = await server({ client });
  const output = { parts: [] };
  await hooks["command.execute.before"]({ command: "workflow", sessionID: sid, arguments: `recover ${file} confirm` }, output);
  const state = loadWorkflow(id);
  assert.equal(state.status, "paused");
  assert.equal(state.stage, "1");
  assert.equal(state.phase, "stage_gate");
});

test("supports pause, stop, attach, resume, skip, and reset lifecycle", async () => {
  const lifecycleRepo = join(root, "lifecycle-repo");
  mkdirSync(lifecycleRepo);
  execFileSync("git", ["init", "-b", "main"], { cwd: lifecycleRepo });
  execFileSync("git", ["config", "user.email", "workflow@example.invalid"], { cwd: lifecycleRepo });
  execFileSync("git", ["config", "user.name", "Workflow Test"], { cwd: lifecycleRepo });
  const file = join(lifecycleRepo, "workflow.md");
  writeFileSync(file, `## Stage 01 - Lifecycle\n- [ ] **01.1 Work**\n  Work.\n  - Context7: not-applicable\n  - Verify: \`true\`\n- Stage gate: \`true\`\n`);
  execFileSync("git", ["add", "."], { cwd: lifecycleRepo });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: lifecycleRepo });
  sessionDirectory = lifecycleRepo;
  const firstSession = "session-lifecycle-first";
  const secondSession = "session-lifecycle-second";
  const hooks = await server({ client });
  await hooks["command.execute.before"]({ command: "workflow", sessionID: firstSession, arguments: `start ${file}` }, { parts: [] });
  const id = workflowIdFromPath(file);
  await hooks["command.execute.before"]({ command: "workflow", sessionID: firstSession, arguments: "pause now" }, { parts: [] });
  assert.equal(loadWorkflow(id).status, "paused");
  assert.equal(loadWorkflow(id).auditEvents.at(-1).type, "workflow.paused_immediately");
  await hooks["command.execute.before"]({ command: "workflow", sessionID: firstSession, arguments: "danger on" }, { parts: [] });
  await hooks.event({ event: { type: "session.error", properties: { sessionID: firstSession } } });
  const statusAfterError = { parts: [] };
  await hooks["command.execute.before"]({ command: "workflow", sessionID: firstSession, arguments: "status" }, statusAfterError);
  assert.match(statusAfterError.parts[0].text, new RegExp(id));
  assert.equal(isDanger(firstSession), true);
  await hooks["command.execute.before"]({ command: "workflow", sessionID: firstSession, arguments: "stop" }, { parts: [] });
  assert.equal(loadWorkflow(id).status, "stopped");
  assert.equal(isDanger(firstSession), false);
  setDanger(firstSession, true);
  await hooks["command.execute.before"]({ command: "workflow", sessionID: secondSession, arguments: `attach ${id}` }, { parts: [] });
  assert.equal(isDanger(firstSession), false);
  assert.equal(isDanger(secondSession), false);
  await hooks["command.execute.before"]({ command: "workflow", sessionID: secondSession, arguments: "resume" }, { parts: [] });
  await hooks["command.execute.before"]({ command: "workflow", sessionID: secondSession, arguments: "skip confirm intentionally omitted" }, { parts: [] });
  assert.equal(loadWorkflow(id).todos[0].skipped, true);
  setDanger(secondSession, true);
  await hooks["command.execute.before"]({ command: "workflow", sessionID: secondSession, arguments: `reset ${id} confirm` }, { parts: [] });
  assert.equal(loadWorkflow(id), null);
  assert.equal(isDanger(secondSession), false);
});

test("checkpoint pause waits for every verification and resumes by injecting the prepared next TODO", async () => {
  const pauseRepo = join(root, "checkpoint-pause-repo");
  mkdirSync(pauseRepo);
  execFileSync("git", ["init", "-b", "main"], { cwd: pauseRepo });
  execFileSync("git", ["config", "user.email", "workflow@example.invalid"], { cwd: pauseRepo });
  execFileSync("git", ["config", "user.name", "Workflow Test"], { cwd: pauseRepo });
  const file = join(pauseRepo, "workflow.md");
  writeFileSync(file, `## Stage 01 - Pause\n- [ ] **01.1 First**\n  First.\n  - Context7: not-applicable\n  - Verify: \`true\`\n  - Verify: \`true\`\n- [ ] **01.2 Second**\n  Second.\n  - Context7: not-applicable\n  - Verify: \`true\`\n- Stage gate: \`true\`\n`);
  execFileSync("git", ["add", "."], { cwd: pauseRepo });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: pauseRepo });
  sessionDirectory = pauseRepo;
  const sid = "session-checkpoint-pause";
  const hooks = await server({ client });
  await hooks["command.execute.before"]({ command: "workflow", sessionID: sid, arguments: `start ${file}` }, { parts: [] });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } });
  const id = workflowIdFromPath(file);
  await hooks["command.execute.before"]({ command: "workflow", sessionID: sid, arguments: "pause" }, { parts: [] });
  assert.equal(loadWorkflow(id).status, "running");
  assert.equal(loadWorkflow(id).pauseRequest.requestedTodo, "01.1");
  await hooks.tool.workflow_verify.execute({ workflowId: id, scope: "todo", index: 0 }, { sessionID: sid, metadata() {} });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } });
  assert.equal(loadWorkflow(id).status, "running");
  assert.ok(loadWorkflow(id).pauseRequest);
  await hooks.tool.workflow_verify.execute({ workflowId: id, scope: "todo", index: 1 }, { sessionID: sid, metadata() {} });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } });
  let state = loadWorkflow(id);
  assert.equal(state.status, "paused");
  assert.equal(state.todos[0].done, true);
  assert.equal(state.cursor, 1);
  assert.equal(state.phase, "todo_execute");
  assert.equal(state.pausedCheckpoint.kind, "todo_verified");
  assert.equal(state.pauseRequest, null);
  assert.doesNotMatch(prompts.at(-1).parts[0].text, /Workflow execute — 01\.2/);

  await hooks["command.execute.before"]({ command: "workflow", sessionID: sid, arguments: "resume" }, { parts: [] });
  state = loadWorkflow(id);
  assert.equal(state.status, "running");
  assert.equal(state.pausedCheckpoint, null);
  assert.match(prompts.at(-1).parts[0].text, /Workflow execute — 01\.2/);
});

test("checkpoint pause survives failed verification and waits for a passing retry", async () => {
  const retryRepo = join(root, "checkpoint-retry-repo");
  mkdirSync(retryRepo);
  execFileSync("git", ["init", "-b", "main"], { cwd: retryRepo });
  execFileSync("git", ["config", "user.email", "workflow@example.invalid"], { cwd: retryRepo });
  execFileSync("git", ["config", "user.name", "Workflow Test"], { cwd: retryRepo });
  const file = join(retryRepo, "workflow.md");
  writeFileSync(file, `## Stage 01 - Retry\n- [ ] **01.1 Retry**\n  Retry.\n  - Context7: not-applicable\n  - Verify: \`test -f pass.flag\`\n- Stage gate: \`true\`\n`);
  execFileSync("git", ["add", "."], { cwd: retryRepo });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: retryRepo });
  sessionDirectory = retryRepo;
  const sid = "session-checkpoint-retry";
  const hooks = await server({ client });
  await hooks["command.execute.before"]({ command: "workflow", sessionID: sid, arguments: `start ${file}` }, { parts: [] });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } });
  const id = workflowIdFromPath(file);
  await hooks["command.execute.before"]({ command: "workflow", sessionID: sid, arguments: "pause" }, { parts: [] });
  await hooks.tool.workflow_verify.execute({ workflowId: id, scope: "todo", index: 0 }, { sessionID: sid, metadata() {} });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } });
  let state = loadWorkflow(id);
  assert.equal(state.status, "running");
  assert.ok(state.pauseRequest);
  assert.equal(state.attempts, 1);
  writeFileSync(join(retryRepo, "pass.flag"), "pass\n");
  await hooks.tool.workflow_verify.execute({ workflowId: id, scope: "todo", index: 0 }, { sessionID: sid, metadata() {} });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } });
  state = loadWorkflow(id);
  assert.equal(state.status, "paused");
  assert.equal(state.pausedCheckpoint.kind, "todo_verified");
  assert.equal(state.phase, "stage_gate");
});

test("checkpoint pause requested at a stage gate waits through the stage commit", async () => {
  const stageRepo = join(root, "checkpoint-stage-repo");
  mkdirSync(stageRepo);
  execFileSync("git", ["init", "-b", "main"], { cwd: stageRepo });
  execFileSync("git", ["config", "user.email", "workflow@example.invalid"], { cwd: stageRepo });
  execFileSync("git", ["config", "user.name", "Workflow Test"], { cwd: stageRepo });
  const file = join(stageRepo, "workflow.md");
  writeFileSync(file, `## Stage 01 - First\n- [ ] **01.1 First**\n  First.\n  - Context7: not-applicable\n  - Verify: \`true\`\n- Stage gate: \`true\`\n## Stage 02 - Second\n- [ ] **02.1 Second**\n  Second.\n  - Context7: not-applicable\n  - Verify: \`true\`\n- Stage gate: \`true\`\n`);
  execFileSync("git", ["add", "."], { cwd: stageRepo });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: stageRepo });
  sessionDirectory = stageRepo;
  const sid = "session-checkpoint-stage";
  const hooks = await server({ client });
  await hooks["command.execute.before"]({ command: "workflow", sessionID: sid, arguments: `start ${file}` }, { parts: [] });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } });
  const id = workflowIdFromPath(file);
  await hooks.tool.workflow_verify.execute({ workflowId: id, scope: "todo", index: 0 }, { sessionID: sid, metadata() {} });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } });
  assert.equal(loadWorkflow(id).phase, "stage_gate");
  await hooks["command.execute.before"]({ command: "workflow", sessionID: sid, arguments: "pause" }, { parts: [] });
  await hooks.tool.workflow_verify.execute({ workflowId: id, scope: "stage", index: 0 }, { sessionID: sid, metadata() {} });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } });
  assert.equal(loadWorkflow(id).status, "running");
  assert.equal(loadWorkflow(id).phase, "stage_commit");
  await hooks.tool.workflow_commit.execute({ workflowId: id }, { sessionID: sid, metadata() {} });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } });
  let state = loadWorkflow(id);
  assert.equal(state.status, "paused");
  assert.equal(state.pausedCheckpoint.kind, "stage_committed");
  assert.equal(state.stage, "1");
  assert.equal(state.phase, "stage_handoff");
  assert.equal(state.stageTransition.nextStage, "2");

  await hooks.event({ event: { type: "session.error", properties: { sessionID: sid } } });
  const resumedSid = "session-checkpoint-stage-restarted";
  await hooks["command.execute.before"]({ command: "workflow", sessionID: resumedSid, arguments: `attach ${id}` }, { parts: [] });
  await hooks["command.execute.before"]({ command: "workflow", sessionID: resumedSid, arguments: "resume" }, { parts: [] });
  assert.match(prompts.at(-1).parts[0].text, /Stage 01 handoff/);
  await assert.rejects(() => hooks.tool.workflow_handoff.execute({ workflowId: id, stage: "1", overview: "Child attempt.",
    decisions: [], contracts: [], deviations: [], risks: [] },
  { sessionID: "handoff-child-session", metadata() {} }), /workflow is not attached to this session/);
  await hooks.tool.workflow_handoff.execute({ workflowId: id, stage: "1", overview: "Stage one is complete.",
    decisions: ["Use the shared contract"], contracts: ["First API"], deviations: [], risks: [] },
  { sessionID: resumedSid, metadata() {} });
  let summarizeOptions;
  let releaseSummary;
  summarizeImpl = async (options) => { summarizeOptions = options; return new Promise((resolve) => { releaseSummary = resolve; }); };
  const compaction = hooks.event({ event: { type: "session.idle", properties: { sessionID: resumedSid } } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await hooks["command.execute.before"]({ command: "workflow", sessionID: resumedSid, arguments: "pause" }, { parts: [] });
  releaseSummary({ data: true });
  await compaction;
  state = loadWorkflow(id);
  assert.equal(state.status, "paused");
  assert.equal(state.stage, "2");
  assert.equal(state.phase, "stage_plan");
  assert.equal(state.stageTransition, null);
  assert.equal(state.stageCompaction.status, "completed");
  assert.equal(state.pausedCheckpoint.kind, "stage_context_refreshed");
  assert.equal(state.stageHandoffs["1"].commit, state.expectedHead);
  assert.ok(state.stageHandoffs["1"].changedFiles.includes("workflow.md"));
  assert.deepEqual(summarizeOptions.body, { providerID: "test-provider", modelID: "test-model" });
  await hooks["command.execute.before"]({ command: "workflow", sessionID: resumedSid, arguments: "resume" }, { parts: [] });
  assert.match(prompts.at(-1).parts[0].text, /Workflow stage plan — Stage 02/);
  assert.match(prompts.at(-1).parts[0].text, /Use the shared contract/);
  await assert.rejects(() => hooks.tool.workflow_handoff.execute({ workflowId: id, stage: "1", overview: "duplicate",
    decisions: [], contracts: [], deviations: [], risks: [] }, { sessionID: resumedSid, metadata() {} }), /only valid/);
  summarizeImpl = async () => ({ data: true });
});

test("checkpoint pause survives automatic compaction", async () => {
  const compactRepo = join(root, "checkpoint-compact-repo");
  mkdirSync(compactRepo);
  execFileSync("git", ["init", "-b", "main"], { cwd: compactRepo });
  execFileSync("git", ["config", "user.email", "workflow@example.invalid"], { cwd: compactRepo });
  execFileSync("git", ["config", "user.name", "Workflow Test"], { cwd: compactRepo });
  const file = join(compactRepo, "workflow.md");
  writeFileSync(file, `## Stage 01 - Compact\n- [ ] **01.1 First**\n  First.\n  - Context7: not-applicable\n  - Verify: \`true\`\n- [ ] **01.2 Second**\n  Second.\n  - Context7: not-applicable\n  - Verify: \`true\`\n- Stage gate: \`true\`\n`);
  execFileSync("git", ["add", "."], { cwd: compactRepo });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: compactRepo });
  sessionDirectory = compactRepo;
  const sid = "session-checkpoint-compact";
  const hooks = await server({ client });
  await hooks["command.execute.before"]({ command: "workflow", sessionID: sid, arguments: `start ${file}` }, { parts: [] });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } });
  const id = workflowIdFromPath(file);
  await hooks["command.execute.before"]({ command: "workflow", sessionID: sid, arguments: "pause" }, { parts: [] });
  await hooks.tool.workflow_verify.execute({ workflowId: id, scope: "todo", index: 0 }, { sessionID: sid, metadata() {} });
  recordContextPressure({ sessionID: sid, tokens: { input: 80 }, limit: 100,
    providerID: "provider", modelID: "model" });
  summarizeImpl = async () => ({ data: true });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } });
  const state = loadWorkflow(id);
  assert.equal(state.status, "paused");
  assert.equal(state.cursor, 1);
  assert.equal(state.phase, "todo_execute");
  assert.equal(state.pausedCheckpoint.kind, "todo_verified");
  assert.equal(state.compaction, null);
  clearContextPressure(sid);
});

test("stage compaction failure requires retry or a confirmed manual compaction", async () => {
  const refreshRepo = join(root, "stage-refresh-failure-repo");
  mkdirSync(refreshRepo);
  execFileSync("git", ["init", "-b", "main"], { cwd: refreshRepo });
  execFileSync("git", ["config", "user.email", "workflow@example.invalid"], { cwd: refreshRepo });
  execFileSync("git", ["config", "user.name", "Workflow Test"], { cwd: refreshRepo });
  const file = join(refreshRepo, "workflow.md");
  writeFileSync(file, `## Stage 01 - First\n- [ ] **01.1 First**\n  First.\n  - Context7: not-applicable\n  - Verify: \`true\`\n- Stage gate: \`true\`\n## Stage 02 - Second\n- [ ] **02.1 Second**\n  Second.\n  - Context7: not-applicable\n  - Verify: \`true\`\n- Stage gate: \`true\`\n`);
  execFileSync("git", ["add", "."], { cwd: refreshRepo });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: refreshRepo });
  sessionDirectory = refreshRepo;
  const sid = "session-stage-refresh-failure";
  const hooks = await server({ client });
  await hooks["command.execute.before"]({ command: "workflow", sessionID: sid, arguments: `start ${file}` }, { parts: [] });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } });
  const id = workflowIdFromPath(file);
  await hooks.tool.workflow_verify.execute({ workflowId: id, scope: "todo", index: 0 }, { sessionID: sid, metadata() {} });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } });
  await hooks.tool.workflow_verify.execute({ workflowId: id, scope: "stage", index: 0 }, { sessionID: sid, metadata() {} });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } });
  await hooks.tool.workflow_commit.execute({ workflowId: id }, { sessionID: sid, metadata() {} });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } });
  await hooks.tool.workflow_handoff.execute({ workflowId: id, stage: "1", overview: "Ready for stage two.",
    decisions: [], contracts: [], deviations: [], risks: [] }, { sessionID: sid, metadata() {} });
  summarizeImpl = async () => { throw new Error("stage summary unavailable"); };
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } });
  let state = loadWorkflow(id);
  assert.equal(state.status, "paused");
  assert.equal(state.phase, "stage_compact_wait");
  assert.match(state.blocker.reason, /stage summary unavailable/);

  const refused = { parts: [] };
  await hooks["command.execute.before"]({ command: "workflow", sessionID: sid, arguments: "resume" }, refused);
  assert.match(refused.parts[0].text, /Run \/compact first/);
  await hooks["command.execute.before"]({ command: "workflow", sessionID: sid, arguments: "retry" }, { parts: [] });
  await new Promise((resolve) => setTimeout(resolve, 100));
  state = loadWorkflow(id);
  assert.equal(state.phase, "stage_compact_wait");
  assert.equal(state.attempts, 1);

  await hooks.event({ event: { type: "session.compacted", properties: { sessionID: sid } } });
  assert.ok(loadWorkflow(id).stageCompaction.manualCompletedAt);
  const resumed = { parts: [] };
  await hooks["command.execute.before"]({ command: "workflow", sessionID: sid, arguments: "resume" }, resumed);
  state = loadWorkflow(id);
  assert.equal(state.status, "running");
  assert.equal(state.phase, "stage_plan");
  assert.equal(state.stage, "2");
  assert.match(prompts.at(-1).parts[0].text, /Workflow stage plan — Stage 02/);
  summarizeImpl = async () => ({ data: true });
});
