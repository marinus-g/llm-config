/** Tests for plugin/plan-gate.js — marker-based plan detection and choice dispatch.
 *
 *  Strategy: mock the opencode client (no real SDK needed) and exercise the
 *  event handler (session.idle) and command.execute.before handler.
 *  Uses lib/danger-mode and lib/plan-handoff with injected storage roots so
 *  tests are fully isolated.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isDanger, setDanger, setDangerStorageRoot } from "../lib/danger-mode.js";
import {
  clearPendingPlan,
  readPendingPlan,
  setPlanHandoffStorageRoot,
  writePendingPlan,
} from "../lib/plan-handoff.js";
import { setStorageRoot, saveWorkflow } from "../lib/workflow-core.js";
import { server } from "../plugin/plan-gate.js";

const root = mkdtempSync(join(tmpdir(), "plan-gate-plugin-"));
const stateRoot = join(root, "state");

// ---- Minimal client mock --------------------------------------------------

const injectedMessages = [];
const toasts = [];
let tuiPublishShouldFail = false;
let configGetMock = null;
let sessionCreateMock = null;
const sessionPromptCalls = [];
const sessionDeleteCalls = [];

// Per-test override for session.messages responses. Map<sessionID, entry[]>.
// Each entry: { info: { role: "assistant" }, parts: [{ type: "text", text: "..." }] }
const sessionMessageMocks = new Map();

// Per-test override for session.get agent response. Map<sessionID, string>.
const sessionAgentMocks = new Map();

// Per-test override for session.get title response. Map<sessionID, string>.
// Default "" (empty) — triggers the title-override path.
const sessionTitleMocks = new Map();

const tuiPublishCalls = [];
const sessionUpdateCalls = [];
const client = {
  session: {
    get({ path }) {
      const sid = path?.id;
      const agent = sessionAgentMocks.get(sid) ?? "orchestrator";
      const title = sessionTitleMocks.get(sid) ?? "";
      return Promise.resolve({ data: { agent, title } });
    },
    update({ path, body }) {
      sessionUpdateCalls.push({ sessionID: path?.id, ...body });
      return Promise.resolve({ data: {} });
    },
    promptAsync({ path, body }) {
      injectedMessages.push({ sessionID: path?.id ?? path?.sessionID, ...body });
      return Promise.resolve({ data: {} });
    },
    messages({ path }) {
      const sid = path?.id;
      const entries = sessionMessageMocks.get(sid) ?? [];
      return Promise.resolve({ data: entries });
    },
    create({ body }) {
      return Promise.resolve(sessionCreateMock ?? { data: { id: null } });
    },
    prompt({ path, body }) {
      sessionPromptCalls.push({ sessionID: path?.id, body });
      return Promise.resolve({ data: { parts: [{ type: "text", text: "Mock Generated Title" }] } });
    },
    delete({ path }) {
      sessionDeleteCalls.push(path?.id);
      return Promise.resolve({});
    },
  },
  config: {
    get() {
      return Promise.resolve(configGetMock ?? { data: {} });
    },
  },
  tui: {
    publish(body) {
      tuiPublishCalls.push(body);
      if (tuiPublishShouldFail) return Promise.reject(new Error("no TUI"));
      return Promise.resolve({});
    },
    showToast({ body }) {
      toasts.push(body);
      return Promise.resolve({});
    },
  },
};

// --------------------------------------------------------------------------

let hooks;

before(async () => {
  setPlanHandoffStorageRoot(stateRoot);
  setDangerStorageRoot(stateRoot);
  setStorageRoot(stateRoot); // workflow state used by sessionHasActiveWorkflow
  hooks = await server({ client });
});

after(() => rmSync(root, { recursive: true, force: true }));

function resetMessages() {
  injectedMessages.length = 0;
  toasts.length = 0;
  tuiPublishCalls.length = 0;
  sessionUpdateCalls.length = 0;
  sessionPromptCalls.length = 0;
  sessionDeleteCalls.length = 0;
}

// ---- Helper: fake ToolContext --------------------------------------------
function fakeContext(sessionID) {
  return {
    sessionID,
    messageID: "msg-1",
    agent: "plan",
    directory: "/tmp",
    worktree: "/tmp",
    abort: new AbortController().signal,
    metadata() {},
    ask() { return Promise.resolve(); },
  };
}

// ---- session.idle event: marker-based plan detection --------------------

test("session.idle with [OPENCODE_PLAN_GATE] marker persists plan and opens TUI dialog", async () => {
  resetMessages();
  const sid = "session-marker-1";
  sessionAgentMocks.set(sid, "plan");
  sessionMessageMocks.set(sid, [
    {
      info: { role: "assistant" },
      parts: [{ type: "text", text: "## My Plan\nDo stuff.\n[OPENCODE_PLAN_GATE]" }],
    },
  ]);
  try {
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } });

    // Plan should be persisted (without the marker)
    const record = readPendingPlan(sid);
    assert.ok(record !== null, "pending plan should be written");
    assert.ok(record.planText.includes("Do stuff."), "plan text should be extracted from the message");
    assert.ok(!record.planText.includes("OPENCODE_PLAN_GATE"), "marker should be stripped from plan text");

    // TUI dialog should have been opened
    assert.ok(tuiPublishCalls.length > 0, "tui.publish should be called");
    const publishBody = tuiPublishCalls[0];
    assert.equal(publishBody.body?.type, "tui.command.execute");
    assert.equal(publishBody.body?.properties?.command, "plan-gate-open");
  } finally {
    sessionAgentMocks.delete(sid);
    sessionMessageMocks.delete(sid);
  }
});

test("session.idle headless fallback injects a noReply message when TUI is unavailable", async () => {
  resetMessages();
  const sid = "session-headless-1";
  sessionAgentMocks.set(sid, "plan");
  sessionMessageMocks.set(sid, [
    {
      info: { role: "assistant" },
      parts: [{ type: "text", text: "Headless plan text.\n[OPENCODE_PLAN_GATE]" }],
    },
  ]);
  tuiPublishShouldFail = true;
  try {
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } });

    // Plan should still be persisted
    const record = readPendingPlan(sid);
    assert.ok(record !== null, "pending plan should be written");
    assert.ok(record.planText.includes("Headless plan text."));

    // Should inject a noReply message as fallback
    const noReplyMessages = injectedMessages.filter((m) => m.noReply);
    assert.ok(noReplyMessages.length > 0, "should inject a noReply message");
    const text = noReplyMessages[0].parts?.[0]?.text ?? "";
    assert.ok(text.includes("plan-gate"), "headless message should mention /plan-gate");
  } finally {
    tuiPublishShouldFail = false;
    sessionAgentMocks.delete(sid);
    sessionMessageMocks.delete(sid);
  }
});

test("session.idle without [OPENCODE_PLAN_GATE] marker does nothing for short messages", async () => {
  resetMessages();
  const sid = "session-no-marker";
  sessionAgentMocks.set(sid, "plan");
  sessionMessageMocks.set(sid, [
    {
      info: { role: "assistant" },
      parts: [{ type: "text", text: "Just some thoughts, not a final plan." }],
    },
  ]);
  try {
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } });

    // No plan should be persisted
    assert.equal(readPendingPlan(sid), null, "no plan should be written without marker");

    // No TUI dialog should open
    assert.equal(tuiPublishCalls.length, 0, "no TUI publish without marker");

    // No messages should be injected (text is below MIN_PLAN_CHARS threshold)
    assert.equal(injectedMessages.length, 0, "no messages injected for short text without marker");
  } finally {
    sessionAgentMocks.delete(sid);
    sessionMessageMocks.delete(sid);
  }
});

test("session.idle without marker but with substantial plan text injects a nudge (once)", async () => {
  resetMessages();
  const sid = "session-nudge-1";
  const longPlanText =
    "## Plan\n" +
    "Step 1: Check git status and recent commits to understand what changed.\n".repeat(6) +
    "Step 2: Redact API keys from opencode.json.example before committing.\n".repeat(6);
  const mockMsg = {
    info: { id: "msg-nudge-1", role: "assistant" },
    parts: [{ type: "text", text: longPlanText }],
  };
  sessionAgentMocks.set(sid, "plan");
  sessionMessageMocks.set(sid, [mockMsg]);
  try {
    // First idle: nudge should fire
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } });

    assert.equal(readPendingPlan(sid), null, "no plan persisted without marker");
    assert.equal(tuiPublishCalls.length, 0, "no TUI dialog opened without marker");
    const nudge = injectedMessages.find((m) => m.agent === "plan");
    assert.ok(nudge, "a nudge should be injected to the plan agent");
    const nudgeText = nudge.parts?.[0]?.text ?? "";
    assert.ok(nudgeText.includes("[OPENCODE_PLAN_GATE]"), "nudge should mention the marker");

    // Second idle with the same message: nudge must NOT fire again (dedupe)
    resetMessages();
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } });
    assert.equal(injectedMessages.length, 0, "nudge must not fire twice for the same message");
  } finally {
    sessionAgentMocks.delete(sid);
    sessionMessageMocks.delete(sid);
  }
});

// ---- session.idle: backstop guard — open questions in plan text ----------

test("session.idle: gate held when plan has unanswered Questions section (lines ending with ?)", async () => {
  resetMessages();
  const sid = "session-open-questions-1";
  sessionAgentMocks.set(sid, "plan");
  const planWithQuestions =
    "## Plan\nDo stuff.\n\n## Questions\n1. Font tarballs (~22 MB): Keep in repo?\n2. .config/spicetify/ tracked — still correct?\n\n[OPENCODE_PLAN_GATE]";
  sessionMessageMocks.set(sid, [
    {
      info: { id: "msg-oq-1", role: "assistant" },
      parts: [{ type: "text", text: planWithQuestions }],
    },
  ]);
  try {
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } });

    // Plan must NOT be persisted
    assert.equal(readPendingPlan(sid), null, "plan must not be written while questions are open");

    // TUI dialog must NOT open
    assert.equal(tuiPublishCalls.length, 0, "TUI dialog must not open while questions are open");

    // A noReply held-gate note must be injected
    const heldNote = injectedMessages.find((m) => m.noReply);
    assert.ok(heldNote, "a noReply gate-held note must be injected");
    const text = heldNote.parts?.[0]?.text ?? "";
    assert.ok(
      text.toLowerCase().includes("open question") || text.toLowerCase().includes("held"),
      "note must mention open questions or that the gate was held",
    );

    // Second idle on the same message must NOT inject again (dedupe)
    resetMessages();
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } });
    assert.equal(injectedMessages.length, 0, "gate-held note must not fire twice for the same message");
  } finally {
    sessionAgentMocks.delete(sid);
    sessionMessageMocks.delete(sid);
  }
});

test("session.idle: gate opens normally when Questions section has no ? lines (resolved/rhetorical)", async () => {
  resetMessages();
  const sid = "session-open-questions-resolved";
  sessionAgentMocks.set(sid, "plan");
  const resolvedPlan =
    "## Plan\nDo stuff.\n\n## Questions\nAll decisions resolved — no action needed.\n\n[OPENCODE_PLAN_GATE]";
  sessionMessageMocks.set(sid, [
    {
      info: { id: "msg-oq-resolved", role: "assistant" },
      parts: [{ type: "text", text: resolvedPlan }],
    },
  ]);
  try {
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } });

    // Plan SHOULD be persisted (no unanswered ? lines)
    const record = readPendingPlan(sid);
    assert.ok(record !== null, "plan should be written when Questions section has no ? lines");

    // TUI dialog SHOULD open
    assert.ok(tuiPublishCalls.length > 0, "TUI dialog should open when no unanswered questions");
  } finally {
    sessionAgentMocks.delete(sid);
    sessionMessageMocks.delete(sid);
  }
});

// ---- command.execute.before: implement -----------------------------------
// The agent switch is driven by the plan-gate-implement command's FRONTMATTER
// agent (orchestrator); the handler puts the implement instruction in
// output.parts so it runs under that agent. No promptAsync inject is used.

test("implement (plan-gate-implement) puts the implement instruction in output.parts without danger mode", async () => {
  resetMessages();
  const sid = "session-implement-1";
  writePendingPlan(sid, "The implementation plan.", { pid: process.pid, token: "tok-impl" });

  const output = { parts: [] };
  await hooks["command.execute.before"]({ command: "plan-gate-implement", sessionID: sid, arguments: "implement" }, output);

  // Should NOT set danger mode.
  assert.equal(isDanger(sid), false, "danger should not be set for implement");

  // Must NOT inject — the command frontmatter switches the agent; output.parts carries the prompt.
  assert.equal(injectedMessages.length, 0, "implement must not inject — relies on command frontmatter agent");

  // output.parts must contain the full implement instruction with plan text and routing rules.
  assert.ok(output.parts.length > 0, "output.parts should be set");
  assert.ok(output.parts[0].text.includes("The implementation plan."), "output.parts should contain plan text");
  assert.ok(output.parts[0].text.includes("ROUTING RULES"), "output.parts should contain routing rules");
  assert.ok(!output.parts[0].text.toUpperCase().includes("AUTO MODE"), "implement should not include auto prefix");

  // Pending plan should be cleared.
  assert.equal(readPendingPlan(sid), null, "pending plan should be cleared");
});

// ---- command.execute.before: auto ----------------------------------------

test("auto (plan-gate-implement) enables danger mode and puts the implement instruction in output.parts", async () => {
  resetMessages();
  setDanger("session-auto-1", false); // ensure clean state
  const sid = "session-auto-1";
  writePendingPlan(sid, "Auto plan.", { pid: process.pid, token: "tok-auto" });

  const output = { parts: [] };
  await hooks["command.execute.before"]({ command: "plan-gate-implement", sessionID: sid, arguments: "auto" }, output);

  // Danger mode must be enabled.
  assert.equal(isDanger(sid), true, "danger should be set for auto");

  // Must NOT inject — command frontmatter does the switch.
  assert.equal(injectedMessages.length, 0, "auto must not inject — relies on command frontmatter agent");

  // output.parts must contain the AUTO prefix, routing rules, and plan text.
  assert.ok(output.parts.length > 0, "output.parts should be set");
  assert.ok(output.parts[0].text.toUpperCase().includes("AUTO MODE"), "output.parts should include auto mode prefix");
  assert.ok(output.parts[0].text.includes("Auto plan."), "output.parts should contain plan text");

  // Pending plan should be cleared.
  assert.equal(readPendingPlan(sid), null, "pending plan should be cleared");

  // Clean up danger marker.
  setDanger(sid, false);
});

// ---------------------------------------------------------------------------
// Implement title glyph
// ---------------------------------------------------------------------------

test("implement prefixes session title with ⚙", async () => {
  resetMessages();
  const sid = "session-impl-glyph";
  sessionTitleMocks.set(sid, "Add dark mode toggle");
  writePendingPlan(sid, "The implementation plan.", { pid: process.pid, token: "tok-impl" });

  const output = { parts: [] };
  await hooks["command.execute.before"]({ command: "plan-gate-implement", sessionID: sid, arguments: "implement" }, output);

  assert.ok(sessionUpdateCalls.length > 0, "session.update should be called");
  assert.equal(sessionUpdateCalls[0].title, "⚙ Add dark mode toggle");
});

test("auto prefixes session title with ⚡", async () => {
  resetMessages();
  const sid = "session-auto-glyph";
  sessionTitleMocks.set(sid, "Add dark mode toggle");
  writePendingPlan(sid, "Auto plan.", { pid: process.pid, token: "tok-auto" });
  setDanger(sid, false);

  const output = { parts: [] };
  await hooks["command.execute.before"]({ command: "plan-gate-implement", sessionID: sid, arguments: "auto" }, output);

  assert.ok(sessionUpdateCalls.length > 0, "session.update should be called");
  assert.equal(sessionUpdateCalls[0].title, "⚡ Add dark mode toggle");

  setDanger(sid, false);
});

test("idempotency: switching ⚙ to auto produces ⚡, no stacked glyph", async () => {
  resetMessages();
  const sid = "session-idempotent";
  sessionTitleMocks.set(sid, "⚙ Add dark mode toggle");
  writePendingPlan(sid, "Plan text.", { pid: process.pid, token: "tok-idem" });
  setDanger(sid, false);

  const output = { parts: [] };
  await hooks["command.execute.before"]({ command: "plan-gate-implement", sessionID: sid, arguments: "auto" }, output);

  assert.equal(sessionUpdateCalls[0].title, "⚡ Add dark mode toggle", "should replace ⚙ with ⚡, not stack");

  setDanger(sid, false);
});

test("empty title falls back to firstMeaningfulLine of plan, glyph-prefixed", async () => {
  resetMessages();
  const sid = "session-empty-title";
  sessionTitleMocks.set(sid, "");
  writePendingPlan(sid, "## Reduce Ghostty transparency\nEdit the opacity setting.\nDo more stuff.", { pid: process.pid, token: "tok-empty" });

  const output = { parts: [] };
  await hooks["command.execute.before"]({ command: "plan-gate-implement", sessionID: sid, arguments: "implement" }, output);

  assert.equal(sessionUpdateCalls[0].title, "⚙ Reduce Ghostty transparency");
});

test("session.idle: empty title triggers generatePlanTitle with small model", async () => {
  resetMessages();
  configGetMock = { data: { small_model: "llamaswap/qwen3-coder-large" } };
  sessionCreateMock = { data: { id: "child-title-gen" } };

  const sid = "session-empty-title";
  sessionAgentMocks.set(sid, "plan");
  sessionTitleMocks.set(sid, ""); // empty so it falls through to generated
  sessionMessageMocks.set(sid, [
    {
      info: { role: "assistant" },
      parts: [{ type: "text", text: "## Plan\nDo stuff.\n[OPENCODE_PLAN_GATE]" }],
    },
  ]);

  await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } });

  // Verify session.create was called (for the child title-gen session)
  assert.ok(sessionCreateMock, "session.create should be called for title generation");

  // Verify promptAsync was called with the small model
  const promptAsyncCalls = injectedMessages.filter((m) =>
    (m.system ?? m.body?.system)?.includes("concise plan titler"),
  );
  assert.ok(promptAsyncCalls.length > 0, "promptAsync should be called for title generation");
  assert.equal(promptAsyncCalls[0].model.modelID, "qwen3-coder-large", "should use small model");
  assert.equal(promptAsyncCalls[0].model.providerID, "llamaswap", "should use correct provider");

  // Simulate the child session becoming idle with a generated title
  sessionMessageMocks.set("child-title-gen", [
    {
      info: { role: "assistant" },
      parts: [{ type: "text", text: "Generated Title" }],
    },
  ]);
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "child-title-gen" } } });

  // Verify the title was updated
  assert.ok(sessionUpdateCalls.some((u) => u.title === "Generated Title"),
    "session.update should set the generated title");

  // Reset mocks
  configGetMock = null;
  sessionCreateMock = null;
});

// ---- command.execute.before: danger isolation ----------------------------

test("implement does NOT set danger — only auto does", async () => {
  resetMessages();
  const sidImpl = "session-danger-isolation-impl";
  const sidAuto = "session-danger-isolation-auto";
  setDanger(sidImpl, false);
  setDanger(sidAuto, false);

  writePendingPlan(sidImpl, "plan", { pid: process.pid, token: "t1" });
  writePendingPlan(sidAuto, "plan", { pid: process.pid, token: "t2" });

  await hooks["command.execute.before"](
    { command: "plan-gate", sessionID: sidImpl, arguments: "implement" }, { parts: [] },
  );
  await hooks["command.execute.before"](
    { command: "plan-gate", sessionID: sidAuto, arguments: "auto" }, { parts: [] },
  );

  assert.equal(isDanger(sidImpl), false, "implement must not enable danger");
  assert.equal(isDanger(sidAuto), true, "auto must enable danger");

  setDanger(sidAuto, false);
});

// ---- command.execute.before: refine --------------------------------------

test("refine choice auto-re-prompts the plan agent (no user input needed) and clears the pending plan", async () => {
  resetMessages();
  const sid = "session-refine-1";
  writePendingPlan(sid, "Rough plan.", { pid: process.pid, token: "tok-refine" });

  const output = { parts: [] };
  await hooks["command.execute.before"]({ command: "plan-gate", sessionID: sid, arguments: "refine" }, output);

  // Should inject into the plan agent.
  const planMsg = injectedMessages.find((m) => m.agent === "plan");
  assert.ok(planMsg, "should inject into plan agent");
  assert.ok(
    planMsg.parts?.[0]?.text?.toLowerCase().includes("refine") ||
    planMsg.parts?.[0]?.text?.toLowerCase().includes("stronger model"),
  );
  assert.ok(planMsg.parts?.[0]?.text?.includes("Rough plan."));

  // Pending plan should be cleared.
  assert.equal(readPendingPlan(sid), null, "pending plan should be cleared after refine");

  // Danger must NOT be set.
  assert.equal(isDanger(sid), false);

  // output.parts should be set.
  assert.ok(output.parts.length > 0);
});

// ---- command.execute.before: change requests -----------------------------

test("change choice keeps the plan marker and stays on plan agent", async () => {
  resetMessages();
  const sid = "session-change-1";
  writePendingPlan(sid, "Plan to change.", { pid: process.pid, token: "tok-change" });

  const output = { parts: [] };
  await hooks["command.execute.before"]({ command: "plan-gate", sessionID: sid, arguments: "change" }, output);

  // Pending plan should NOT be cleared — kept for reference.
  const record = readPendingPlan(sid);
  assert.ok(record !== null, "pending plan should NOT be cleared after change");

  // Should NOT inject any message.
  assert.equal(injectedMessages.length, 0, "change should not inject any messages");

  // output.parts should indicate to type change requests.
  assert.ok(output.parts.length > 0, "output.parts should be set");
  assert.ok(output.parts[0].text.toLowerCase().includes("change"), "output.parts should mention change");
  assert.ok(output.parts[0].text.toLowerCase().includes("prompt") || output.parts[0].text.toLowerCase().includes("type"), "output.parts should mention typing");

  // Danger must NOT be set.
  assert.equal(isDanger(sid), false);
});

// ---- command.execute.before: unknown choice ------------------------------

test("unknown choice sets output.parts with error text", async () => {
  const output = { parts: [] };
  await hooks["command.execute.before"](
    { command: "plan-gate", sessionID: "session-unknown", arguments: "totally-wrong" },
    output,
  );
  assert.ok(output.parts.length > 0);
  assert.ok(output.parts[0].text.toLowerCase().includes("unknown") || output.parts[0].text.includes("totally-wrong"));
});

// ---- command.execute.before: ignores other commands ---------------------

test("non-plan-gate commands are not intercepted", async () => {
  const output = { parts: [] };
  await hooks["command.execute.before"](
    { command: "workflow", sessionID: "session-other", arguments: "status" },
    output,
  );
  // output.parts should remain empty (not intercepted).
  assert.equal(output.parts.length, 0);
});

// ---------------------------------------------------------------------------
// Plan-gate suppression for workflow sessions
// ---------------------------------------------------------------------------

test("session.idle for plan agent with an active workflow does NOT open the plan gate", async () => {
  resetMessages();
  const sid = "session-workflow-plan-1";
  sessionAgentMocks.set(sid, "plan");

  // Write a plan message with the gate marker — would normally trigger the gate.
  sessionMessageMocks.set(sid, [
    {
      info: { role: "assistant" },
      parts: [{ type: "text", text: "## Stage 02 Plan\nDo the thing.\n[OPENCODE_PLAN_GATE]" }],
    },
  ]);

  // Save a fake active workflow that lists this session.
  const wfID = "test-wf-plan-gate-suppression";
  saveWorkflow({
    schemaVersion: 4,
    id: wfID,
    sourcePath: "/tmp/fake-workflow",
    sourceSnapshot: {},
    projectCwd: "/tmp",
    sessionID: sid,
    sessionIDs: [sid],
    status: "running",
    phase: "stage_plan",
    stage: "02",
    todos: [],
    stages: {},
    cursor: 0,
    attempts: 0,
    turns: 0,
    stageTurns: 0,
    maxStageTurns: 80,
    maxTotalTurns: 800,
    branch: "workflow/test",
    baseBranch: "main",
    baseHead: "abc123",
    expectedHead: "abc123",
    stagePlans: {},
    todoEvidence: {},
    gateEvidence: null,
    commitEvidence: null,
    manualEvidence: [],
    context7Evidence: { resolved: false, queried: false },
    skipReasons: {},
    commits: [],
    blocker: null,
    startedAt: Date.now(),
    completedAt: null,
    noConfirm: false,
    pauseRequest: null,
    pausedCheckpoint: null,
    stageHandoffs: {},
    stageCompaction: null,
    stageTransition: null,
    executionEvidence: null,
    auditEvents: [],
    reporting: { stageStartedAt: Date.now(), todoStartedAt: null, todos: {}, stages: {} },
  });

  try {
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } });

    // The plan gate must NOT publish the TUI command.
    assert.equal(
      tuiPublishCalls.filter((c) => c.body?.properties?.command === "plan-gate-open").length,
      0,
      "plan-gate-open must not be published for workflow sessions",
    );

    // The pending plan must NOT be written.
    const record = readPendingPlan(sid);
    assert.equal(record, null, "pending plan must not be written for workflow sessions");

    // No injected messages either (no marker-nudge or open-questions message).
    assert.equal(injectedMessages.length, 0, "no messages must be injected for workflow sessions");
  } finally {
    sessionAgentMocks.delete(sid);
    sessionMessageMocks.delete(sid);
  }
});

// ---------------------------------------------------------------------------
// Plan title override
// ---------------------------------------------------------------------------

test("session.idle sets session title from plan text when title is empty", async () => {
  resetMessages();
  const sid = "session-title-empty";
  sessionAgentMocks.set(sid, "plan");
  sessionTitleMocks.set(sid, ""); // empty title → should be overridden
  sessionMessageMocks.set(sid, [
    {
      info: { id: "msg-title-1", role: "assistant" },
      parts: [{ type: "text", text: "## Reduce Ghostty transparency\nEdit the opacity setting.\n[OPENCODE_PLAN_GATE]" }],
    },
  ]);
  try {
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } });

    // session.update must have been called with a non-empty title
    assert.ok(sessionUpdateCalls.length > 0, "session.update should be called when title is empty");
    const update = sessionUpdateCalls[0];
    assert.ok(typeof update.title === "string" && update.title.length >= 3, "title should be a non-trivial string");
    assert.ok(!update.title.includes("OPENCODE_PLAN_GATE"), "title must not contain the gate marker");
    assert.equal(update.sessionID, sid, "session.update must target the correct session");
  } finally {
    sessionAgentMocks.delete(sid);
    sessionTitleMocks.delete(sid);
    sessionMessageMocks.delete(sid);
  }
});

test("session.idle sets session title when title contains the gate marker", async () => {
  resetMessages();
  const sid = "session-title-marker";
  sessionAgentMocks.set(sid, "plan");
  sessionTitleMocks.set(sid, "[OPENCODE_PLAN_GATE]"); // marker leaked into title
  sessionMessageMocks.set(sid, [
    {
      info: { id: "msg-title-2", role: "assistant" },
      parts: [{ type: "text", text: "## Add dark mode toggle\nImplement theme switching.\n[OPENCODE_PLAN_GATE]" }],
    },
  ]);
  try {
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } });

    assert.ok(sessionUpdateCalls.length > 0, "session.update should be called when title is the gate marker");
    const update = sessionUpdateCalls[0];
    assert.ok(!update.title.includes("OPENCODE_PLAN_GATE"), "replacement title must not contain the gate marker");
  } finally {
    sessionAgentMocks.delete(sid);
    sessionTitleMocks.delete(sid);
    sessionMessageMocks.delete(sid);
  }
});

test("session.idle does NOT overwrite a user-set title", async () => {
  resetMessages();
  const sid = "session-title-user-set";
  sessionAgentMocks.set(sid, "plan");
  sessionTitleMocks.set(sid, "My custom title"); // user already set a real title
  sessionMessageMocks.set(sid, [
    {
      info: { id: "msg-title-3", role: "assistant" },
      parts: [{ type: "text", text: "## Refactor auth module\nExtract token logic.\n[OPENCODE_PLAN_GATE]" }],
    },
  ]);
  try {
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } });

    // session.update must NOT be called — the existing title is not empty/marker
    assert.equal(sessionUpdateCalls.length, 0, "session.update must not be called when user has a custom title");
  } finally {
    sessionAgentMocks.delete(sid);
    sessionTitleMocks.delete(sid);
    sessionMessageMocks.delete(sid);
  }
});

test("session.idle for plan agent with a COMPLETED workflow still opens the plan gate", async () => {
  resetMessages();
  const sid = "session-workflow-plan-completed";
  sessionAgentMocks.set(sid, "plan");

  sessionMessageMocks.set(sid, [
    {
      info: { role: "assistant" },
      parts: [{ type: "text", text: "## My Plan\nDo stuff.\n[OPENCODE_PLAN_GATE]" }],
    },
  ]);

  // Save a COMPLETED workflow — sessionHasActiveWorkflow must return false for it.
  const wfID = "test-wf-completed";
  saveWorkflow({
    schemaVersion: 4,
    id: wfID,
    sourcePath: "/tmp/fake-workflow-completed",
    sourceSnapshot: {},
    projectCwd: "/tmp",
    sessionID: sid,
    sessionIDs: [sid],
    status: "completed", // <-- not active
    phase: "stage_commit",
    stage: "01",
    todos: [],
    stages: {},
    cursor: 0,
    attempts: 0,
    turns: 0,
    stageTurns: 0,
    maxStageTurns: 80,
    maxTotalTurns: 800,
    branch: "workflow/test-done",
    baseBranch: "main",
    baseHead: "abc123",
    expectedHead: "abc123",
    stagePlans: {},
    todoEvidence: {},
    gateEvidence: null,
    commitEvidence: null,
    manualEvidence: [],
    context7Evidence: { resolved: false, queried: false },
    skipReasons: {},
    commits: [],
    blocker: null,
    startedAt: Date.now() - 10000,
    completedAt: Date.now(),
    noConfirm: false,
    pauseRequest: null,
    pausedCheckpoint: null,
    stageHandoffs: {},
    stageCompaction: null,
    stageTransition: null,
    executionEvidence: null,
    auditEvents: [],
    reporting: { stageStartedAt: Date.now() - 10000, todoStartedAt: null, todos: {}, stages: {} },
  });

  try {
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } });

    // A completed workflow is not "active" — the gate SHOULD fire.
    const publishedGate = tuiPublishCalls.some(
      (c) => c.body?.properties?.command === "plan-gate-open",
    );
    assert.ok(publishedGate, "plan gate should open when the associated workflow is completed");

    const record = readPendingPlan(sid);
    assert.ok(record !== null, "pending plan should be persisted when workflow is completed");
  } finally {
    sessionAgentMocks.delete(sid);
    sessionMessageMocks.delete(sid);
  }
});
