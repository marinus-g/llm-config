/** OpenCode /workflow v5: durable, permission-aware, stage-oriented project driver. */
import { tool } from "@opencode-ai/plugin";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  SCHEMA_VERSION, DEFAULT_MAX_STAGE_TURNS, DEFAULT_MAX_TOTAL_TURNS, elapsed,
  validateWorkflow, parseWorkflowPath, checkTodoInSource, uncheckTodosInSource, runCommand,
  workflowIdFromPath, saveWorkflow, loadWorkflow, listWorkflows, deleteWorkflow,
  acquireLock, releaseLock, inspectLock, archiveWorkflowState, git, gitPreflight, createWorkflowBranch,
  verifyWorkflowBranch, createStageCommit, createTodoCheckpointCommit, snapshotWorkflowSource, compareWorkflowSource,
  refreshWorkflowSourceSnapshot, appendWorkflowEvent, workflowGitDiagnostics,
  workflowFinishReport, analyzeWorkflowRecovery, workflowStageFacts, createWorkflowDirectory,
} from "../lib/workflow-core.js";
import {
  CONTEXT_WARNING_FRACTION, clearContextPressure, getContextPressure,
} from "../lib/context-pressure.js";
import { isDanger, setDanger } from "../lib/danger-mode.js";
import {
  classifyDestructiveCommand, clearDestructiveApprovals, rememberDestructiveApproval,
} from "../lib/destructive-command.js";
import { loadSessionWindowUsage } from "../lib/session-hud-message.js";
import { analyzeExecutionEvidence } from "../lib/workflow-execution-evidence.js";

const sessionToWorkflow = new Map();
const inFlight = new Set();
const pendingAutoCompactions = new Set();

function expandPath(value) {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return resolve(value);
}
function flag(args, name, fallback) {
  const match = args.match(new RegExp(`--${name}\\s+(\\d+)`));
  return match ? Number(match[1]) : fallback;
}
function flagBool(args, name) {
  return args.includes(`--${name}`);
}
function stringFlag(args, name) {
  return args.match(new RegExp(`--${name}\\s+(?:"([^"]+)"|'([^']+)'|(\\S+))`))?.slice(1).find(Boolean) ?? null;
}
function stripFlags(args) {
  return args.replace(/--max-stage-turns\s+\d+/g, "").replace(/--max-total-turns\s+\d+/g, "")
    .replace(/--limit\s+\d+/g, "").replace(/--(?:branch|base)\s+(?:"[^"]+"|'[^']+'|\S+)/g, "")
    .replace(/--no-confirm/g, "").trim();
}
function activeState(sessionID) {
  const id = sessionToWorkflow.get(sessionID);
  if (id) return loadWorkflow(id);
  const restored = listWorkflows().find((state) =>
    state.sessionID === sessionID && ["running", "paused", "blocked"].includes(state.status));
  if (!restored) return null;
  sessionToWorkflow.set(sessionID, restored.id);
  return restored;
}
function maybeHealExpectedHead(state) {
  if (state.blocker?.reason === "workflow branch HEAD changed unexpectedly") {
    const headResult = git(["rev-parse", "HEAD"], state.projectCwd);
    if (headResult.status === 0) {
      state.expectedHead = headResult.stdout.trim();
    }
  }
}
function currentTodo(state) { return state.todos[state.cursor] ?? null; }
function stageTodos(state, stage = state.stage) { return state.todos.filter((todo) => todo.stage === stage); }
function stageComplete(state, stage = state.stage) { return stageTodos(state, stage).every((todo) => todo.done || todo.skipped); }

function sessionAgent(session, messages = []) {
  return session?.agent ?? messages.find((message) => message.info?.agent)?.info.agent ?? null;
}

async function loadExecutionNode(client, session, since, depth = 0, seen = new Set()) {
  const id = session?.id;
  if (!id || depth > 8 || seen.has(id)) return null;
  seen.add(id);
  const messages = (await client.session.messages({ path: { id } }))?.data ?? [];
  const createdAt = session.time?.created ?? session.timeCreated ?? 0;
  const node = { id, agent: sessionAgent(session, messages), createdAt, messages, children: [] };
  if (createdAt && createdAt < since) return node;
  const children = typeof client.session.children === "function"
    ? (await client.session.children({ path: { id } }))?.data ?? [] : [];
  for (const child of children) {
    const loaded = await loadExecutionNode(client, child, since, depth + 1, seen);
    if (loaded && (!loaded.createdAt || loaded.createdAt >= since)) node.children.push(loaded);
  }
  return node;
}

function event(state, type, details = {}) { appendWorkflowEvent(state, type, details); }

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function usageLines(report) {
  if (report.usageError) return [`  Usage: unavailable (${report.usageError})`];
  const tokens = report.usage.tokens;
  return [
    `  Subagents: ${report.usage.subagents.join(", ") || "none"}`,
    `  Tokens: ${tokens.total.toLocaleString("en-US")} total | input ${tokens.input.toLocaleString("en-US")} | output ${tokens.output.toLocaleString("en-US")} | reasoning ${tokens.reasoning.toLocaleString("en-US")} | cache read ${tokens.cacheRead.toLocaleString("en-US")} | write ${tokens.cacheWrite.toLocaleString("en-US")}`,
  ];
}

function formatTodoReport(todo, report) {
  return [
    `✓ Step report — ${todo.id} ${todo.title}`,
    `  Duration: ${formatDuration(report.completedAt - report.startedAt)}`,
    ...usageLines(report),
  ].join("\n");
}

function formatStageReport(handoff, report) {
  return [
    `✓ Stage report — ${handoff.stage}: ${handoff.title}`,
    `  Implemented: ${handoff.overview}`,
    `  Duration: ${formatDuration(report.completedAt - report.startedAt)}`,
    ...usageLines(report),
    `  Commit: ${handoff.commit}`,
    `  Completed: ${handoff.completedTodos.join(", ") || "none"}`,
    `  Skipped: ${handoff.skippedTodos.map((todo) => `${todo.id} (${todo.reason})`).join(", ") || "none"}`,
    `  Changed files: ${handoff.changedFiles.join(", ") || "none"}`,
    `  Gate: ${handoff.gate?.passed ? "passed" : "unavailable"}${handoff.gate?.command ? ` (${handoff.gate.command})` : ""}`,
  ].join("\n");
}

function logText(state, limit = 50) {
  const events = (state.auditEvents ?? []).slice(-Math.min(Math.max(limit, 1), 500));
  if (!events.length) return `◈ No audit events for ${state.id}.`;
  return events.map((entry) => {
    const where = [entry.stage ? `stage=${entry.stage}` : "", entry.todo ? `todo=${entry.todo}` : "", entry.phase ? `phase=${entry.phase}` : ""].filter(Boolean).join(" ");
    const details = Object.keys(entry.details ?? {}).length ? ` ${JSON.stringify(entry.details)}` : "";
    return `${entry.sequence}. ${new Date(entry.at).toISOString()} ${entry.type}${where ? ` [${where}]` : ""}${details}`;
  }).join("\n");
}

function statusText(state) {
  if (!state) return "◈ No workflow attached to this session. Use /workflow list or /workflow start <path>.";
  const done = state.todos.filter((todo) => todo.done).length;
  const skipped = state.todos.filter((todo) => todo.skipped).length;
  const todo = currentTodo(state);
  return [
    `◈ /workflow [${state.status}] — ${elapsed(state.startedAt)} | ${done}/${state.todos.length} verified | ${skipped} skipped`,
    `  ID: ${state.id} | branch: ${state.branch}`,
    todo ? `  Current: ${todo.id} ${todo.title} [${state.phase}]` : "  No current TODO.",
    `  Turns: ${state.turns}/${state.maxTotalTurns} | stage: ${state.stageTurns}/${state.maxStageTurns}`,
    state.blocker ? `  Blocker: ${state.blocker.reason}` : "",
    state.pauseRequest ? `  Pause requested: waiting for ${state.phase.startsWith("stage_") ? "stage context checkpoint" : "verified TODO checkpoint"}` : "",
    state.pausedCheckpoint ? `  Paused checkpoint: ${state.pausedCheckpoint.kind}` : "",
    state.compaction ? `  Compaction: ${Math.round(state.compaction.fraction * 100)}% context [${state.phase}]` : "",
    state.stageCompaction ? `  Stage context: ${state.stageCompaction.status}${state.stageCompaction.error ? ` (${state.stageCompaction.error})` : ""}` : "",
    state.stageTransition ? `  Transition: stage ${state.stageTransition.completedStage} → ${state.stageTransition.nextStage}` : "",
    state.commits.length ? `  Last commit: ${state.commits.at(-1).sha}` : "",
  ].filter(Boolean).join("\n");
}

function todoText(todo) {
  return [`**${todo.id} ${todo.title}**`, todo.body, `Context7: ${todo.context7}`,
    ...todo.verify.map((command, index) => `Verify ${index}: \`${command}\``),
    ...todo.manual.map((criterion) => `Manual verification: ${criterion}`),
  ].filter(Boolean).join("\n");
}

function stagePlanPrompt(state) {
  const stage = state.stages[state.stage];
  const todos = stageTodos(state).filter((todo) => !todo.done && !todo.skipped);
  const previous = state.commits.at(-1)?.stage;
  const handoff = previous ? state.stageHandoffs?.[previous] : null;
  return `◈ Workflow stage plan — Stage ${stage.displayId}: ${stage.title}\n\n` +
    `Treat repository files at HEAD as authoritative. Re-read AGENTS.md, workflow context documents, and ${stage.file}. ` +
    (handoff ? `Review the persisted previous-stage handoff below, then inspect relevant code with CodeGraph before relying on it.\n\n${formatStageHandoff(handoff)}\n\n` : "") +
    `Produce one concise plan covering only this stage and its ordered TODOs. Do not edit files.\n\n` +
    todos.map(todoText).join("\n\n") + "\n\nStop after the plan.";
}

function isNoCodeStep(todo) {
  // A no-code step has no verify commands and is a pure Context7 research task.
  return todo.context7 === "required" && todo.verify.length === 0;
}

function executePrompt(state, todo, retry = false) {
  const stepText = todoText(todo);
  const retryNote = retry ? " (This is a retry — previous verification failed.)" : "";
  const noCode = isNoCodeStep(todo);
  const evidenceDir = join(state.sourcePath, "evidence");
  const sourceGuidance = `Treat the snapshotted workflow source at ${state.sourcePath} as immutable. ` +
    `Write any generated evidence, research notes, or lookup records into ${evidenceDir}/ (create the directory if needed); ` +
    `do NOT write files directly under ${state.sourcePath} itself — especially not any NN-name.md file — ` +
    `and do not modify files in the workflow source snapshot. `;
  const delegateInstruction = noCode
    ? `Delegate this step to the \`step-planner\` subagent. This is a Context7 research step — ` +
      `instruct the step-planner to dispatch a direct \`research\` child that queries every required library ` +
      `with focused Context7 resolve and docs calls. Context7 calls made directly by the planner do not count. ` +
      `dispatch a \`step-orchestrator\` and documentation domain agent to record the actual results, then obtain a ` +
      `\`step-reviewer\` verdict. On review failure, it must run at most one corrective research/record/review pass without asking the user.`
    : `Delegate this step to the \`step-planner\` subagent. Pass it the full step text below and instruct it to ` +
      `explore, plan, dispatch a \`step-orchestrator\` to implement, and obtain a \`step-reviewer\` verdict.`;
  return `◈ Workflow ${retry ? "retry" : "execute"} — ${todo.id}${retryNote}\n\n` +
    `Workflow id: \`${state.id}\`. TODO id: \`${todo.id}\`. Pass both identifiers to the step-planner, ` +
    `which must pass them to the step-reviewer for its final \`workflow_review\` call. ` +
    `${delegateInstruction} Do not implement or review the step yourself. ` +
    sourceGuidance +
    `For a \`todo_execute\` prompt the orchestrator dispatches only \`step-planner\` and must not spawn ` +
    `\`explore\`, \`step-orchestrator\`, \`step-reviewer\`, or any domain agent itself — the planner owns the whole sub-hierarchy.\n\n` +
    `After the step-planner returns, treat its \`STEP REVIEW\` line as a summary only. ` +
    `The workflow engine validates the typed reviewer verdict, real child-session hierarchy, and completed tool evidence; prose claims cannot satisfy it. ` +
    (todo.context7 === "required"
      ? `Confirm that a direct \`research\` child of the step-planner completed both Context7 ` +
        `resolve-library-id and query-docs calls. Do not call those tools in this parent session; they will not count. ` +
        (todo.verify.length ? `Call workflow_verify for each verification command index (0 through ${todo.verify.length - 1}); it is the authoritative gate. ` : "")
      : (todo.verify.length
          ? `Call workflow_verify once for each command index (0 through ${todo.verify.length - 1}); it is the authoritative gate. Do not run substitutes. `
          : "")) +
    // Fix 3: When there are no automated verify commands, make the prohibition explicit.
    (!todo.verify.length ? `Do NOT call \`workflow_verify\` for this TODO — it has no automated verification command. ` : "") +
    (todo.manual.length ? "Manual verification will be requested separately by the workflow engine. " : "") +
    `Do not check the Markdown checkbox for this TODO.\n\n` +
    `## Step to delegate to step-planner\n\n${stepText}`;
}

function stageGatePrompt(state) {
  const stage = state.stages[state.stage];
  return `◈ Stage ${stage.displayId} gate\n\nCall workflow_verify with workflowId=${state.id}, scope=stage, index=0. ` +
    `The exact persisted gate is \`${stage.gate}\`. Do not run a substitute.`;
}

function stageCommitPrompt(state) {
  return `◈ Stage ${state.stages[state.stage].displayId} commit\n\n` +
    `Call workflow_commit with workflowId=${state.id}. It will verify branch, gate evidence, and stage completion before committing.`;
}

function stageHandoffPrompt(state) {
  const stage = state.stageTransition?.completedStage ?? state.stage;
  const info = state.stages[stage];
  return `◈ Stage ${info.displayId} handoff\n\n` +
    `The stage is committed. Do not edit files. Call workflow_handoff exactly once with workflowId=${state.id}, stage=${stage}. ` +
    "Record a concise overview, decisions that constrain later work, introduced or changed contracts, deviations from the workflow documents, and unresolved risks. Use empty arrays when a category has none.";
}

function formatStageHandoff(handoff) {
  return [
    `Stage ${handoff.stage}: ${handoff.title}`,
    `Commit: ${handoff.commit}`,
    `Overview: ${handoff.overview}`,
    `Decisions: ${(handoff.decisions ?? []).join("; ") || "none"}`,
    `Contracts: ${(handoff.contracts ?? []).join("; ") || "none"}`,
    `Deviations: ${(handoff.deviations ?? []).join("; ") || "none"}`,
    `Risks: ${(handoff.risks ?? []).join("; ") || "none"}`,
    `Changed files: ${(handoff.changedFiles ?? []).join(", ") || "none"}`,
    `Completed TODOs: ${(handoff.completedTodos ?? []).join(", ") || "none"}`,
    `Skipped TODOs: ${(handoff.skippedTodos ?? []).map((item) => `${item.id} (${item.reason})`).join(", ") || "none"}`,
  ].join("\n");
}

/** @type {import("@opencode-ai/plugin").Plugin} */
export const server = async ({ client }) => {
  clearDestructiveApprovals();
  const repliedPermissionRequests = new Set();
  const commandReceipts = new Map();
  const createAuthorizations = new Map();
  const COMMAND_RECEIPT_TTL_MS = 5 * 60 * 1000;
  const CREATE_AUTHORIZATION_TTL_MS = 2 * 60 * 60 * 1000;
  const MAX_COMMAND_RECEIPTS = 20;

  async function refreshExecutionEvidence(state, sessionID, todo) {
    const since = state.reporting?.todoStartedAt ?? state.startedAt;
    const root = await loadExecutionNode(client, { id: sessionID, agent: "workflow-orchestrator", time: { created: since } }, since);
    const opts = { requireImplementation: true, requireContext7: todo?.context7 === "required" };
    state.executionEvidence = analyzeExecutionEvidence(root, opts);
    event(state, state.executionEvidence.ready ? "execution.evidence_ready" : "execution.evidence_incomplete",
      { missing: state.executionEvidence.missing, reviewerID: state.executionEvidence.reviewerID,
        verdict: state.executionEvidence.verdict });
    saveWorkflow(state);
    return state.executionEvidence;
  }

  function commandKey(args) {
    return String(args ?? "").trim().replace(/\s+/g, " ");
  }

  function pruneCommandReceipts(sessionID) {
    const cutoff = Date.now() - COMMAND_RECEIPT_TTL_MS;
    const current = (commandReceipts.get(sessionID) ?? []).filter((receipt) => receipt.at >= cutoff);
    if (current.length) commandReceipts.set(sessionID, current.slice(-MAX_COMMAND_RECEIPTS));
    else commandReceipts.delete(sessionID);
    return current;
  }

  function rememberCommandReceipt(sessionID, args, parts) {
    if (!parts?.length) return;
    const receipts = pruneCommandReceipts(sessionID);
    receipts.push({ key: commandKey(args), parts: structuredClone(parts), at: Date.now() });
    commandReceipts.set(sessionID, receipts.slice(-MAX_COMMAND_RECEIPTS));
  }

  function consumeCommandReceipt(sessionID, args) {
    const receipts = pruneCommandReceipts(sessionID);
    const key = commandKey(args);
    const index = receipts.findIndex((receipt) => receipt.key === key);
    if (index < 0) return null;
    const [receipt] = receipts.splice(index, 1);
    if (receipts.length) commandReceipts.set(sessionID, receipts);
    else commandReceipts.delete(sessionID);
    return structuredClone(receipt.parts);
  }

  function clearCommandReceipts(sessionID) {
    commandReceipts.delete(sessionID);
  }

  function clearSessionTransientState(sessionID) {
    clearCommandReceipts(sessionID);
    createAuthorizations.delete(sessionID);
  }

  function workflowDestination(cwd, value) {
    if (value === "~") return homedir();
    if (value.startsWith("~/")) return join(homedir(), value.slice(2));
    return resolve(cwd, value);
  }

  function workflowCreateCommandPath(parts) {
    const value = parts.join(" ").trim();
    const quoted = value.match(/^(["'])(.*)\1$/s);
    return quoted ? quoted[2] : value;
  }

  async function authorizeWorkflowCreate(sessionID, path) {
    await requirePrimaryWorkflowCaller(sessionID);
    const session = (await client.session.get({ path: { id: sessionID } }))?.data;
    const cwd = session?.directory ?? process.cwd();
    createAuthorizations.set(sessionID, {
      at: Date.now(),
      destination: path ? workflowDestination(cwd, path) : null,
    });
  }

  function requireWorkflowCreateAuthorization(sessionID, destination) {
    const authorization = createAuthorizations.get(sessionID);
    if (!authorization) {
      throw new Error("workflow creation is not authorized; start with /workflow create [path]");
    }
    if (Date.now() - authorization.at > CREATE_AUTHORIZATION_TTL_MS) {
      createAuthorizations.delete(sessionID);
      throw new Error("workflow creation authorization expired; run /workflow create [path] again");
    }
    if (authorization.destination && authorization.destination !== destination) {
      throw new Error(`workflow creation is authorized only for ${authorization.destination}; run /workflow create again to change it`);
    }
  }

  async function dangerSessionFor(sessionID) {
    let current = sessionID;
    const seen = new Set();
    for (let depth = 0; current && depth < 12 && !seen.has(current); depth++) {
      seen.add(current);
      if (isDanger(current)) return current;
      try {
        const session = (await client.session.get({ path: { id: current } }))?.data;
        current = session?.parentID ?? null;
      } catch {
        return null;
      }
    }
    return null;
  }

  async function dangerPermissionDecision(input) {
    if (!await dangerSessionFor(input.sessionID)) return null;
    const permission = String(input.type ?? input.permission ?? "").toLowerCase();
    if (permission !== "bash") return "allow";

    const rawPatterns = input.patterns ?? input.pattern;
    const patterns = Array.isArray(rawPatterns) ? rawPatterns : [rawPatterns];
    const commands = patterns.filter((value) => typeof value === "string" && value.trim());
    if (!commands.length && typeof input.metadata?.command === "string") commands.push(input.metadata.command);
    if (!commands.length) return "ask";

    let cwd = null;
    try { cwd = (await client.session.get({ path: { id: input.sessionID } }))?.data?.directory ?? null; } catch { /* ask below */ }
    if (!cwd) return "ask";
    const rootResult = git(["rev-parse", "--show-toplevel"], cwd);
    const repoRoot = rootResult.status === 0 ? rootResult.stdout.trim() : null;
    const results = commands.map((command) => classifyDestructiveCommand(command, { cwd, repoRoot }));
    const destructive = results.some((result) => result.destructive);
    const safe = destructive && results.every((result) => !result.destructive || result.safeToAutoAllow);
    if (!destructive || safe) return "allow";

    for (const command of commands) rememberDestructiveApproval(input.sessionID, input.callID ?? input.tool?.callID, command);
    return "ask";
  }

  async function replyToPermissionRequest(request) {
    if (!request?.id || repliedPermissionRequests.has(request.id)) return;
    if (await dangerPermissionDecision(request) !== "allow") return;
    repliedPermissionRequests.add(request.id);
    try {
      let response;
      if (typeof client.postSessionIdPermissionsPermissionId === "function") {
        response = await client.postSessionIdPermissionsPermissionId({
          path: { id: request.sessionID, permissionID: request.id }, body: { response: "once" },
        });
      } else if (typeof client.permission?.reply === "function") {
        response = await client.permission.reply({ path: { requestID: request.id }, body: { reply: "once" } });
      } else {
        throw new Error("no compatible permission reply API is available");
      }
      if (response?.error) throw response.error;
    } catch (error) {
      // The synchronous permission hook or another plugin may have resolved it first.
      const message = typeof error === "string" ? error
        : error?.message ?? error?.data?.message ?? (() => { try { return JSON.stringify(error); } catch { return String(error); } })();
      if (!String(message).includes("404")) {
        repliedPermissionRequests.delete(request.id);
        console.error("[workflow] permission reply failed:", message);
      }
    }
  }

  async function workflowIdForSession(sessionID) {
    let current = sessionID;
    const seen = new Set();
    for (let depth = 0; current && depth < 12 && !seen.has(current); depth++) {
      seen.add(current);
      const direct = activeState(current);
      if (direct) return direct.id;
      try {
        const session = (await client.session.get({ path: { id: current } }))?.data;
        current = session?.parentID ?? null;
      } catch {
        return null;
      }
    }
    return null;
  }

  async function requirePrimaryWorkflowCaller(sessionID) {
    let session;
    try {
      session = (await client.session.get({ path: { id: sessionID } }))?.data;
    } catch (error) {
      throw new Error(`could not validate workflow caller: ${error.message}`);
    }
    if (session?.parentID) {
      throw new Error("workflow phase tools may only be called by the primary orchestrator session");
    }
    const WORKFLOW_DRIVER_AGENTS = new Set(["orchestrator", "workflow-orchestrator"]);
    if (session?.agent && !WORKFLOW_DRIVER_AGENTS.has(session.agent)) {
      throw new Error("workflow phase tools may only be called by a primary workflow orchestrator agent");
    }
  }

  async function requireActiveStepReviewer(sessionID, workflowId, todoId) {
    const state = loadWorkflow(workflowId);
    if (!state || !["running", "paused"].includes(state.status)) throw new Error("workflow is not active");
    const todo = currentTodo(state);
    if (!todo || todo.id !== todoId) throw new Error(`TODO ${todoId} is not the active workflow TODO`);
    if (!["todo_execute", "todo_verify"].includes(state.phase)) {
      throw new Error(`workflow review is not allowed during phase ${state.phase}`);
    }

    const reviewer = (await client.session.get({ path: { id: sessionID } }))?.data;
    const reviewerMessages = (await client.session.messages({ path: { id: sessionID } }))?.data ?? [];
    if (sessionAgent(reviewer, reviewerMessages) !== "step-reviewer") {
      throw new Error("workflow_review may only be called by a step-reviewer");
    }
    const plannerID = reviewer?.parentID;
    if (!plannerID) throw new Error("step-reviewer is missing its step-planner parent");
    const planner = (await client.session.get({ path: { id: plannerID } }))?.data;
    const plannerMessages = (await client.session.messages({ path: { id: plannerID } }))?.data ?? [];
    if (sessionAgent(planner, plannerMessages) !== "step-planner" || planner?.parentID !== state.sessionID) {
      throw new Error("step-reviewer is not in the active planner hierarchy");
    }
    const createdAt = reviewer?.time?.created ?? reviewer?.timeCreated ?? 0;
    if (createdAt && createdAt < (state.reporting?.todoStartedAt ?? state.startedAt)) {
      throw new Error("step-reviewer belongs to a stale TODO attempt");
    }
    const inspected = reviewerMessages.flatMap((message) => message.parts ?? []).some((part) => {
      if (part.type !== "tool" || part.state?.status !== "completed") return false;
      const name = String(part.tool ?? "").toLowerCase();
      return name !== "workflow_review" && ["read", "grep", "glob", "list", "bash", "git", "codegraph"]
        .some((toolName) => name.includes(toolName));
    });
    if (!inspected) throw new Error("inspect the repository or deliverable before recording a verdict");
  }

  function inject(sessionID, text, agent = "workflow-orchestrator", noReply = false) {
    return client.session.promptAsync({ path: { id: sessionID }, body: {
      ...(agent ? { agent } : {}), parts: [{ type: "text", text }], ...(noReply ? { noReply: true } : {}),
    }}).catch((error) => console.error("[workflow] inject failed:", error.message));
  }

  async function clearContextAndReseed(sessionID, state) {
    try {
      const messages = (await client.session.messages({ path: { id: sessionID } }))?.data ?? [];
      const firstID = messages[0]?.info?.id ?? messages[0]?.id;
      if (firstID) {
        await client.session.revert({ path: { id: sessionID }, body: { messageID: firstID } });
      }
    } catch (error) {
      console.error("[workflow] context clear failed:", error.message);
    }
    await inject(sessionID,
      `◈ Attached ${state.id} [${state.status}]. Context cleared.\n\nRe-read AGENTS.md (and the workflow context documents) before doing anything, then use /workflow resume.\n\n${statusText(state)}`,
      null, true);
  }

  async function collectReportUsage(state, sessionID, startedAt, completedAt) {
    try {
      return { usage: await loadSessionWindowUsage(client, sessionID, startedAt, completedAt) };
    } catch (error) {
      return { usage: null, usageError: error.message };
    }
  }

  async function persistTodoReport(state, sessionID, todo, completedAt) {
    state.reporting ??= { stageStartedAt: state.startedAt, todoStartedAt: state.startedAt, todos: {}, stages: {} };
    state.reporting.todos ??= {};
    if (state.reporting.todos[todo.id]) return state.reporting.todos[todo.id];
    const startedAt = state.reporting.todoStartedAt ?? state.reporting.stageStartedAt ?? state.startedAt;
    const report = { todo: todo.id, startedAt, completedAt,
      ...await collectReportUsage(state, sessionID, startedAt, completedAt) };
    state.reporting.todos[todo.id] = report;
    event(state, report.usageError ? "report.usage_unavailable" : "todo.reported",
      { scope: "todo", id: todo.id, error: report.usageError ?? null });
    saveWorkflow(state);
    await inject(sessionID, formatTodoReport(todo, report), null, true);
    return report;
  }

  async function persistStageReport(state, sessionID, handoff, completedAt) {
    state.reporting ??= { stageStartedAt: state.startedAt, todoStartedAt: state.startedAt, todos: {}, stages: {} };
    state.reporting.stages ??= {};
    if (state.reporting.stages[handoff.stage]) return state.reporting.stages[handoff.stage];
    const startedAt = state.reporting.stageStartedAt ?? state.startedAt;
    const report = { stage: handoff.stage, startedAt, completedAt,
      ...await collectReportUsage(state, sessionID, startedAt, completedAt) };
    state.reporting.stages[handoff.stage] = report;
    event(state, report.usageError ? "report.usage_unavailable" : "stage.reported",
      { scope: "stage", stage: handoff.stage, error: report.usageError ?? null });
    saveWorkflow(state);
    await inject(sessionID, formatStageReport(handoff, report), null, true);
    return report;
  }

  function persistBlock(state, sessionID, reason) {
    state.status = "blocked";
    state.blocker = { reason, at: Date.now() };
    event(state, "workflow.blocked", { reason });
    saveWorkflow(state);
    inject(sessionID, `⛔ Workflow blocked: ${reason}\nUse /workflow retry, /workflow skip confirm <reason>, or /workflow stop.`, null, true);
  }

  function sessionErrorBlockerReason(state) {
    const reason = state.blocker?.reason;
    if (reason && reason !== "session error") return reason;
    const execution = state.executionEvidence;
    if (execution && !execution.ready && execution.missing?.length) {
      const todo = currentTodo(state);
      const prefix = todo ? `Execution evidence is incomplete for ${todo.id}` : "Execution evidence is incomplete";
      return `${prefix}: ${execution.missing.join("; ")}`;
    }
    return reason ?? "session error";
  }

  function kick(sessionID) { setTimeout(() => onIdle(sessionID), 50); }

  async function pauseAtCheckpoint(state, sessionID, kind) {
    if (!state.pauseRequest) return false;
    state.status = "paused";
    state.pausedCheckpoint = { kind, at: Date.now(), phase: state.phase,
      stage: state.stage, todo: currentTodo(state)?.id ?? null };
    state.pauseRequest = null;
    event(state, "workflow.paused_at_checkpoint", state.pausedCheckpoint);
    saveWorkflow(state);
    await inject(sessionID, `⏸ Workflow paused at ${kind}. State is durable; it is safe to restart OpenCode.`, null, true);
    return true;
  }

  async function injectPreparedPhase(state, sessionID) {
    if (state.phase === "stage_plan") return inject(sessionID, stagePlanPrompt(state), "plan");
    if (state.phase === "todo_execute" || state.phase === "todo_verify") return inject(sessionID, executePrompt(state, currentTodo(state)));
    if (state.phase === "stage_gate") return inject(sessionID, stageGatePrompt(state));
    if (state.phase === "stage_commit") return inject(sessionID, stageCommitPrompt(state));
    if (state.phase === "stage_handoff") return inject(sessionID, stageHandoffPrompt(state));
    if (state.phase === "stage_compact") { kick(sessionID); return; }
  }

  async function resolveCompactionModel(sessionID) {
    const pressure = getContextPressure(sessionID);
    if (pressure?.providerID && pressure?.modelID) return { providerID: pressure.providerID, modelID: pressure.modelID };
    const response = await client.session.messages({ path: { id: sessionID }, query: { limit: 20 } });
    const entries = response?.data ?? [];
    for (let index = entries.length - 1; index >= 0; index--) {
      const info = entries[index]?.info ?? entries[index];
      if (info?.role === "assistant" && info.providerID && info.modelID) {
        return { providerID: info.providerID, modelID: info.modelID };
      }
    }
    throw new Error("could not resolve the active model for stage compaction");
  }

  async function advanceAfterStageRefresh(state, sessionID, checkpoint = null) {
    const transition = state.stageTransition;
    if (!transition) throw new Error("stage transition metadata is missing");
    state.cursor = transition.nextCursor;
    state.stage = transition.nextStage;
    state.stageTurns = 0;
    state.phase = "stage_plan";
    state.todoEvidence = {};
    state.gateEvidence = null;
    state.commitEvidence = null;
    state.manualEvidence = [];
    state.context7Evidence = { resolved: false, queried: false };
    state.executionEvidence = null;
    state.stageTransition = null;
    state.reporting.stageStartedAt = Date.now();
    state.reporting.todoStartedAt = null;
    event(state, "phase.changed", { to: "stage_plan" });
    saveWorkflow(state);
    if (checkpoint && await pauseAtCheckpoint(state, sessionID, checkpoint)) return;
    await inject(sessionID, stagePlanPrompt(state), "plan");
  }

  async function compactStageContext(state, sessionID) {
    const handoffStage = state.stageTransition?.completedStage;
    const handoff = handoffStage ? state.stageHandoffs?.[handoffStage] : null;
    if (!handoff) throw new Error("stage handoff is missing");
    const requestedAt = Date.now();
    state.stageCompaction = { stage: handoffStage, status: "running", requestedAt,
      completedAt: null, manualCompletedAt: null, error: null };
    event(state, "stage.compaction_requested", { stage: handoffStage });
    saveWorkflow(state);
    pendingAutoCompactions.add(sessionID);
    try {
      await inject(sessionID, `Persisted stage handoff before context refresh:\n\n${formatStageHandoff(handoff)}`, null, true);
      const model = await resolveCompactionModel(sessionID);
      state.stageCompaction.providerID = model.providerID;
      state.stageCompaction.modelID = model.modelID;
      saveWorkflow(state);
      const response = await client.session.summarize({ path: { id: sessionID }, body: model });
      if (response?.error || (response?.data !== true && response !== true)) {
        throw new Error(response?.error?.message ?? "OpenCode did not confirm stage compaction");
      }
      const fresh = loadWorkflow(state.id);
      if (!fresh || fresh.status !== "running" || fresh.blocker || fresh.phase !== "stage_compact" ||
          fresh.stageCompaction?.requestedAt !== requestedAt) return;
      clearContextPressure(sessionID);
      fresh.status = "running";
      fresh.blocker = null;
      fresh.stageCompaction = { ...fresh.stageCompaction, status: "completed", completedAt: Date.now(), error: null };
      event(fresh, "stage.compaction_completed", { stage: handoffStage });
      await advanceAfterStageRefresh(fresh, sessionID, "stage_context_refreshed");
    } catch (error) {
      const fresh = loadWorkflow(state.id);
      if (!fresh || fresh.stageCompaction?.requestedAt !== requestedAt) return;
      fresh.status = "paused";
      fresh.phase = "stage_compact_wait";
      fresh.blocker = { reason: `stage compaction failed: ${error.message}`, at: Date.now() };
      fresh.stageCompaction = { ...fresh.stageCompaction, status: "failed", error: error.message };
      event(fresh, "stage.compaction_failed", { stage: handoffStage, error: error.message });
      saveWorkflow(fresh);
      await inject(sessionID, `Stage context refresh failed: ${error.message}\nUse /workflow retry, or run /compact and then /workflow resume.`, null, true);
    } finally {
      pendingAutoCompactions.delete(sessionID);
    }
  }

  function ensureSourceFresh(state, sessionID) {
    const source = compareWorkflowSource(state);
    if (source.ok) return true;
    persistBlock(state, sessionID, `${source.reason}; use /workflow doctor or /workflow recover <path>`);
    return false;
  }

  function ensureLimits(state, sessionID) {
    state.turns++;
    state.stageTurns++;
    if (state.turns > state.maxTotalTurns) {
      persistBlock(state, sessionID, `total turn limit ${state.maxTotalTurns} reached`);
      return false;
    }
    if (state.stageTurns > state.maxStageTurns) {
      persistBlock(state, sessionID, `stage turn limit ${state.maxStageTurns} reached`);
      return false;
    }
    return true;
  }

  function sourceStillUnchecked(state, todo) {
    const fresh = parseWorkflowPath(state.sourcePath).todos.find((item) => item.id === todo.id);
    return fresh && !fresh.done;
  }

  async function beginNextTodoOrGate(state, sessionID, checkpoint = null) {
    if (stageComplete(state)) {
      state.phase = "stage_gate";
      state.gateEvidence = null;
      event(state, "phase.changed", { to: "stage_gate" });
      saveWorkflow(state);
      if (checkpoint && await pauseAtCheckpoint(state, sessionID, checkpoint)) return;
      await inject(sessionID, stageGatePrompt(state));
      return;
    }
    let next = state.cursor + 1;
    while (next < state.todos.length && (state.todos[next].done || state.todos[next].skipped)) next++;
    state.cursor = next;
    state.phase = "todo_execute";
    state.todoEvidence = {};
    state.manualEvidence = [];
    state.context7Evidence = { resolved: false, queried: false };
    state.executionEvidence = null;
    state.reporting.todoStartedAt = Date.now();
    event(state, "phase.changed", { to: "todo_execute" });
    saveWorkflow(state);
    if (checkpoint && await pauseAtCheckpoint(state, sessionID, checkpoint)) return;
    await inject(sessionID, executePrompt(state, currentTodo(state)));
  }

  async function completeTodo(state, sessionID) {
    const todo = currentTodo(state);
    if (!sourceStillUnchecked(state, todo)) {
      persistBlock(state, sessionID, `TODO ${todo.id} checkbox changed outside the workflow`);
      return;
    }
    if (!checkTodoInSource(todo)) {
      persistBlock(state, sessionID, `could not update source checkbox for ${todo.id}`);
      return;
    }
    todo.done = true;
    state.skipReasons ??= {};
    refreshWorkflowSourceSnapshot(state);
    event(state, "todo.completed", { id: todo.id });
    saveWorkflow(state);
    await persistTodoReport(state, sessionID, todo, Date.now());
    if (state.perTodoCommits) {
      const checkpointResult = createTodoCheckpointCommit(state, todo);
      if (!checkpointResult.ok) {
        persistBlock(state, sessionID, `todo checkpoint commit failed: ${checkpointResult.reason}`);
        return;
      }
      if (!checkpointResult.skipped) {
        state.expectedHead = checkpointResult.head;
        state.todoCommits ??= [];
        state.todoCommits.push({ stage: todo.stage, todoId: todo.id, sha: checkpointResult.sha, at: Date.now() });
        event(state, "todo.committed", { id: todo.id, sha: checkpointResult.sha });
        saveWorkflow(state);
      }
    }
    const pressure = getContextPressure(sessionID);
    if (pressure?.fraction >= CONTEXT_WARNING_FRACTION) {
      await autoCompactAtBoundary(state, sessionID, pressure);
      return;
    }
    await beginNextTodoOrGate(state, sessionID, "todo_verified");
  }

  async function autoCompactAtBoundary(state, sessionID, pressure) {
    const requestedAt = Date.now();
    state.status = "paused";
    state.phase = "compact_wait";
    state.compaction = {
      requestedAt,
      used: pressure.used,
      limit: pressure.limit,
      fraction: pressure.fraction,
      error: null,
    };
    event(state, "compaction.requested", { fraction: pressure.fraction });
    saveWorkflow(state);
    pendingAutoCompactions.add(sessionID);

    try {
      const response = await client.session.summarize({
        path: { id: sessionID },
        body: { providerID: pressure.providerID, modelID: pressure.modelID },
      });
      if (response?.error || (response?.data !== true && response !== true)) {
        throw new Error(response?.error?.message ?? "OpenCode did not confirm compaction");
      }

      const fresh = loadWorkflow(state.id);
      if (!fresh || fresh.phase !== "compact_wait" ||
          fresh.compaction?.requestedAt !== requestedAt || fresh.blocker) return;
      clearContextPressure(sessionID);
      fresh.status = "running";
      fresh.compaction = null;
      event(fresh, "compaction.completed");
      saveWorkflow(fresh);
      await beginNextTodoOrGate(fresh, sessionID, "todo_verified");
    } catch (error) {
      const fresh = loadWorkflow(state.id);
      if (!fresh || fresh.compaction?.requestedAt !== requestedAt) return;
      fresh.status = "paused";
      fresh.compaction.error = error.message;
      fresh.blocker = { reason: `automatic compaction failed: ${error.message}`, at: Date.now() };
      event(fresh, "compaction.failed", { error: error.message });
      saveWorkflow(fresh);
      await inject(sessionID,
        `Automatic compaction failed: ${error.message}\nRun /compact, then /workflow resume.`, null, true);
    } finally {
      pendingAutoCompactions.delete(sessionID);
    }
  }

  function commandEvidenceReady(state, todo) {
    return todo.verify.every((_, index) => state.todoEvidence?.[index]?.passed === true);
  }

  async function onIdle(sessionID) {
    const id = sessionToWorkflow.get(sessionID);
    if (!id || inFlight.has(sessionID)) return;
    inFlight.add(sessionID);
    try {
      const state = loadWorkflow(id);
      if (!state || state.status !== "running") return;
      if (!ensureSourceFresh(state, sessionID)) return;
      if (!ensureLimits(state, sessionID)) return;
      const branch = verifyWorkflowBranch(state);
      if (!branch.ok) { persistBlock(state, sessionID, branch.reason); return; }

      if (state.phase === "stage_plan") {
        state.stagePlans[state.stage] = { completedAt: Date.now() };
        state.phase = "todo_execute";
        state.todoEvidence = {};
        state.manualEvidence = [];
        state.context7Evidence = { resolved: false, queried: false };
        state.executionEvidence = null;
        state.reporting.todoStartedAt = Date.now();
        event(state, "phase.changed", { from: "stage_plan", to: "todo_execute" });
        saveWorkflow(state);
        await inject(sessionID, executePrompt(state, currentTodo(state)));
        return;
      }

      if (state.phase === "todo_execute" || state.phase === "todo_verify") {
        const todo = currentTodo(state);
        if (!sourceStillUnchecked(state, todo)) {
          persistBlock(state, sessionID, `TODO ${todo.id} checkbox changed before authoritative verification`);
          return;
        }
        const execution = await refreshExecutionEvidence(state, sessionID, todo);
        if (!execution.ready) {
          state.phase = "todo_execute";
          saveWorkflow(state);
          const hierarchy = isNoCodeStep(todo)
            ? "planner → research, planner → step-orchestrator → documentation agent, planner → step-reviewer"
            : (todo.context7 === "required"
                ? "planner → research, planner → step-orchestrator → domain agent, planner → step-reviewer"
                : "planner → explore, planner → step-orchestrator → domain agent, planner → step-reviewer");
          await inject(sessionID, `Execution evidence is incomplete for ${todo.id}: ${execution.missing.join("; ")}. ` +
            `Run the required ${hierarchy} hierarchy before verification.`, "workflow-orchestrator");
          return;
        }
        if (todo.context7 === "required" && !(state.context7Evidence?.resolved && state.context7Evidence?.queried)) {
          state.phase = "todo_execute";
          saveWorkflow(state);
          await inject(sessionID, `Context7 evidence is incomplete for ${todo.id}. Call both resolve-library-id and query-docs, then review the implementation against those docs.`, "workflow-orchestrator");
          return;
        }
        const failed = Object.values(state.todoEvidence ?? {}).find((entry) => entry.passed === false);
        if (failed) {
          state.attempts++;
          state.todoEvidence = {};
          state.phase = "todo_execute";
          state.executionEvidence = null;
          state.reporting.todoStartedAt = Date.now();
          event(state, "verification.retry", { exit: failed.exit, attempt: state.attempts });
          saveWorkflow(state);
          await inject(sessionID, `${executePrompt(state, todo, true)}\n\nPrevious verification failed: ${failed.error || failed.stderr || `exit ${failed.exit}`}`);
          return;
        }
        if (!commandEvidenceReady(state, todo)) {
          state.phase = "todo_verify";
          event(state, "phase.changed", { to: "todo_verify" });
          saveWorkflow(state);
          await inject(sessionID, `Verification evidence is incomplete for ${todo.id}. Call workflow_verify for each missing persisted command index.`, "workflow-orchestrator");
          return;
        }
        if (todo.manual.length && state.manualEvidence.length < todo.manual.length) {
          if (state.noConfirm) {
            state.manualEvidence = todo.manual.map((criterion) => ({
              criterion,
              evidence: "--no-confirm auto-confirmed",
              at: Date.now(),
            }));
            saveWorkflow(state);
            await completeTodo(state, sessionID);
            return;
          }
          state.status = "paused";
          state.phase = "manual_wait";
          event(state, "phase.changed", { to: "manual_wait" });
          saveWorkflow(state);
          await inject(sessionID, `Manual verification required for ${todo.id}:\n${todo.manual.map((item, i) => `${i + 1}. ${item}`).join("\n")}\nUse /workflow confirm <evidence> after checking it.`, null, true);
          return;
        }
        await completeTodo(state, sessionID);
        return;
      }

      if (state.phase === "stage_gate") {
        if (!state.gateEvidence) { await inject(sessionID, stageGatePrompt(state)); return; }
        if (!state.gateEvidence.passed) {
          state.gateEvidence = null;
          event(state, "stage.gate_failed");
          saveWorkflow(state);
          await inject(sessionID, `Stage gate failed. Fix the stage, then call workflow_verify for the stage gate again.`, "workflow-orchestrator");
          return;
        }
        state.phase = "stage_commit";
        event(state, "phase.changed", { to: "stage_commit" });
        saveWorkflow(state);
        await inject(sessionID, stageCommitPrompt(state));
        return;
      }

      if (state.phase === "stage_handoff") {
        const stage = state.stageTransition?.completedStage;
        if (!stage || !state.stageHandoffs?.[stage]) {
          await inject(sessionID, stageHandoffPrompt(state));
          return;
        }
        await persistStageReport(state, sessionID, state.stageHandoffs[stage], Date.now());
        if (state.stageTransition.nextCursor < 0) {
          state.status = Object.keys(state.skipReasons ?? {}).length ? "completed_with_skips" : "completed";
          state.completedAt = Date.now();
          event(state, "workflow.completed", { status: state.status });
          saveWorkflow(state);
          releaseLock(state.id);
          setDanger(sessionID, false);
          sessionToWorkflow.delete(sessionID);
          clearSessionTransientState(sessionID);
          await inject(sessionID, `✓ Workflow ${state.status}. ${state.todos.filter((todo) => todo.done).length} verified, ${Object.keys(state.skipReasons ?? {}).length} skipped.`, null, true);
          return;
        }
        state.phase = "stage_compact";
        event(state, "phase.changed", { to: "stage_compact" });
        saveWorkflow(state);
        if (await pauseAtCheckpoint(state, sessionID, "stage_handoff")) return;
        await compactStageContext(state, sessionID);
        return;
      }

      if (state.phase === "stage_compact") {
        await compactStageContext(state, sessionID);
        return;
      }

      if (state.phase === "stage_commit") {
        if (!state.commitEvidence?.passed) { await inject(sessionID, stageCommitPrompt(state)); return; }
        const completedStage = state.stage;
        state.commits.push({ stage: completedStage, sha: state.commitEvidence.sha, at: Date.now() });
        state.expectedHead = state.commitEvidence.head;
        state.commitEvidence = null;
        const remaining = state.todos.findIndex((todo) => !todo.done && !todo.skipped);
        state.stageTransition = { completedStage, nextCursor: remaining, nextStage: remaining < 0 ? null : state.todos[remaining].stage,
          commit: state.expectedHead, createdAt: Date.now() };
        state.stageCompaction = null;
        state.phase = "stage_handoff";
        event(state, "phase.changed", { to: "stage_handoff" });
        saveWorkflow(state);
        if (await pauseAtCheckpoint(state, sessionID, "stage_committed")) return;
        await inject(sessionID, stageHandoffPrompt(state));
      }
    } catch (error) {
      const state = loadWorkflow(id);
      if (state) persistBlock(state, sessionID, `internal error: ${error.message}`);
    } finally { inFlight.delete(sessionID); }
  }

  const workflowVerify = tool({
    description: "Run an exact verification command persisted by the active workflow. Commands cannot be supplied by the caller.",
    args: {
      workflowId: tool.schema.string(),
      scope: tool.schema.enum(["todo", "stage"]),
      index: tool.schema.number().int().nonnegative(),
    },
    async execute(args, context) {
      await requirePrimaryWorkflowCaller(context.sessionID);
      const state = loadWorkflow(args.workflowId);
      if (!state || state.sessionID !== context.sessionID) throw new Error("workflow is not attached to this session");
      const source = compareWorkflowSource(state);
      if (!source.ok) { persistBlock(state, context.sessionID, source.reason); throw new Error(source.reason); }
      const branch = verifyWorkflowBranch(state);
      if (!branch.ok) throw new Error(branch.reason);
      let command;
      if (args.scope === "todo") {
        const todo = currentTodo(state);
        // Fix 3: Give a directive error for manual-only TODOs instead of a cryptic index error.
        if (!todo?.verify?.length) {
          throw new Error(
            `TODO ${todo?.id ?? "unknown"} has no automated verification — it completes via manual ` +
            `confirmation (/workflow confirm). Do not call workflow_verify; wait for the engine's manual-verification prompt.`
          );
        }
        command = todo.verify[args.index];
        if (!command) throw new Error(`unknown TODO verification index ${args.index} (valid range: 0–${todo.verify.length - 1})`);
        const execution = await refreshExecutionEvidence(state, context.sessionID, todo);
        if (!execution.ready) throw new Error(`execution evidence incomplete: ${execution.missing.join("; ")}`);
      } else {
        if (args.index !== 0 || state.phase !== "stage_gate") throw new Error("invalid stage gate request");
        command = state.stages[state.stage]?.gate;
      }
      context.metadata({ title: `Workflow ${args.scope} verification`, metadata: { command } });
      const result = runCommand(command, state.projectCwd);
      if (args.scope === "todo") {
        state.todoEvidence[args.index] = result;
      } else state.gateEvidence = result;
      event(state, "verification.completed", { scope: args.scope, index: args.index, command,
        passed: result.passed, exit: result.exit, outputTail: (result.stdout || result.stderr || result.error || "").slice(-1000) });
      saveWorkflow(state);
      return { output: `${result.passed ? "PASS" : "FAIL"} exit=${result.exit}\n${result.stdout || result.stderr || result.error || "(no output)"}`, metadata: result };
    },
  });

  const workflowReview = tool({
    description: "Record a typed PASS or FAIL verdict for the active workflow TODO after inspecting its result.",
    args: {
      workflowId: tool.schema.string(),
      todoId: tool.schema.string(),
      verdict: tool.schema.enum(["PASS", "FAIL"]),
    },
    async execute(args, context) {
      await requireActiveStepReviewer(context.sessionID, args.workflowId, args.todoId);
      context.metadata({ title: `Workflow review ${args.todoId}: ${args.verdict}` });
      return `Recorded VERDICT: ${args.verdict} for ${args.todoId}`;
    },
  });

  const workflowHandoff = tool({
    description: "Persist the required structured handoff for a just-committed workflow stage before context compaction.",
    args: {
      workflowId: tool.schema.string(),
      stage: tool.schema.string(),
      overview: tool.schema.string(),
      decisions: tool.schema.array(tool.schema.string()),
      contracts: tool.schema.array(tool.schema.string()),
      deviations: tool.schema.array(tool.schema.string()),
      risks: tool.schema.array(tool.schema.string()),
    },
    async execute(args, context) {
      await requirePrimaryWorkflowCaller(context.sessionID);
      const state = loadWorkflow(args.workflowId);
      if (!state || state.sessionID !== context.sessionID) throw new Error("workflow is not attached to this session");
      const expectedStage = state.stageTransition?.completedStage;
      if (state.phase !== "stage_handoff" || args.stage !== expectedStage) {
        throw new Error(`handoff is only valid for committed stage ${expectedStage ?? "none"}`);
      }
      if (!args.overview.trim()) throw new Error("handoff overview cannot be empty");
      const facts = workflowStageFacts(state, expectedStage, state.expectedHead);
      const handoff = { ...facts, overview: args.overview.trim(),
        decisions: args.decisions.map((item) => item.trim()).filter(Boolean),
        contracts: args.contracts.map((item) => item.trim()).filter(Boolean),
        deviations: args.deviations.map((item) => item.trim()).filter(Boolean),
        risks: args.risks.map((item) => item.trim()).filter(Boolean), submittedAt: Date.now() };
      state.stageHandoffs ??= {};
      state.stageHandoffs[expectedStage] = handoff;
      event(state, "stage.handoff_submitted", { stage: expectedStage, commit: handoff.commit });
      saveWorkflow(state);
      return { output: `Stage ${expectedStage} handoff persisted for context refresh.`, metadata: handoff };
    },
  });

  const workflowCommit = tool({
    description: "Commit one fully verified workflow stage on its dedicated branch.",
    args: { workflowId: tool.schema.string() },
    async execute(args, context) {
      await requirePrimaryWorkflowCaller(context.sessionID);
      const state = loadWorkflow(args.workflowId);
      if (!state || state.sessionID !== context.sessionID) throw new Error("workflow is not attached to this session");
      const source = compareWorkflowSource(state);
      if (!source.ok) { persistBlock(state, context.sessionID, source.reason); throw new Error(source.reason); }
      if (state.phase !== "stage_commit" || !state.gateEvidence?.passed || !stageComplete(state)) throw new Error("stage is not ready to commit");
      const result = createStageCommit(state, state.stage);
      state.commitEvidence = result.passed === false ? result : { ...result, passed: result.ok };
      if (result.ok) state.expectedHead = result.head;
      event(state, result.ok ? "stage.committed" : "stage.commit_failed", result);
      saveWorkflow(state);
      if (!result.ok) throw new Error(result.reason);
      return { output: `Committed stage ${state.stage}: ${result.sha}`, metadata: result };
    },
  });

  let commandHook;
  const workflowControl = tool({
    description: "Execute one /workflow control action deterministically. Use this tool whenever a /workflow command prompt is received.",
    args: {
      action: tool.schema.enum(["validate", "start", "list", "list-plain", "attach", "status", "pause", "resume", "retry", "confirm", "skip", "stop", "reset", "rewind", "log", "doctor", "finish", "recover", "danger"]),
      path: tool.schema.string().optional(),
      workflowId: tool.schema.string().optional(),
      evidence: tool.schema.string().optional(),
      reason: tool.schema.string().optional(),
      stage: tool.schema.string().optional(),
      branch: tool.schema.string().optional(),
      baseBranch: tool.schema.string().optional(),
      limit: tool.schema.number().int().positive().max(500).optional(),
      confirm: tool.schema.boolean().optional(),
      immediate: tool.schema.boolean().optional(),
      noConfirm: tool.schema.boolean().optional(),
      dangerMode: tool.schema.enum(["toggle", "on", "off"]).optional(),
      maxStageTurns: tool.schema.number().int().positive().optional(),
      maxTotalTurns: tool.schema.number().int().positive().optional(),
    },
    async execute(args, context) {
      await requirePrimaryWorkflowCaller(context.sessionID);
      let raw = args.action;
      if (["validate", "start"].includes(args.action)) {
        if (!args.path) throw new Error(`${args.action} requires path`);
        raw += ` ${args.path}`;
        if (args.maxStageTurns) raw += ` --max-stage-turns ${args.maxStageTurns}`;
        if (args.maxTotalTurns) raw += ` --max-total-turns ${args.maxTotalTurns}`;
        if (args.action === "start" && args.noConfirm) raw += " --no-confirm";
      } else if (args.action === "attach") {
        if (!args.workflowId) throw new Error("attach requires workflowId");
        raw += ` ${args.workflowId}`;
      } else if (args.action === "confirm") {
        if (!args.evidence) throw new Error("confirm requires evidence");
        raw += ` ${args.evidence}`;
      } else if (args.action === "skip") {
        if (!args.reason) throw new Error("skip requires reason");
        raw += ` confirm ${args.reason}`;
      } else if (args.action === "reset") {
        raw += `${args.workflowId ? ` ${args.workflowId}` : ""} confirm`;
      } else if (args.action === "rewind") {
        if (!args.stage || !args.confirm) throw new Error("rewind requires stage and confirm");
        raw += ` stage ${args.stage} confirm`;
      } else if (args.action === "log") {
        if (args.limit) raw += ` --limit ${args.limit}`;
      } else if (args.action === "doctor") {
        if (args.workflowId) raw += ` ${args.workflowId}`;
      } else if (args.action === "pause") {
        if (args.immediate) raw += " now";
      } else if (args.action === "recover") {
        if (!args.path) throw new Error("recover requires path");
        raw += ` ${args.path}`;
        if (args.branch) raw += ` --branch ${args.branch}`;
        if (args.baseBranch) raw += ` --base ${args.baseBranch}`;
        if (args.confirm) raw += " confirm";
      } else if (args.action === "danger" && args.dangerMode && args.dangerMode !== "toggle") {
        raw += ` ${args.dangerMode}`;
      }
      const output = { parts: [] };
      await commandHook({ command: "workflow", sessionID: context.sessionID, arguments: raw,
        workflowControlDispatch: true }, output);
      return output.parts.map((part) => part.type === "text" ? part.text : "").filter(Boolean).join("\n") || "Workflow action accepted.";
    },
  });

  const workflowCreate = tool({
    description: "Create a new workflow directory from a user-confirmed interactive draft. The primary session must first be authorized by an explicit /workflow create [path] command; authorization is single-use after successful creation.",
    args: {
      path: tool.schema.string(),
      files: tool.schema.array(tool.schema.object({
        path: tool.schema.string(),
        content: tool.schema.string(),
      })),
    },
    async execute(args, context) {
      await requirePrimaryWorkflowCaller(context.sessionID);
      const cwd = (await client.session.get({ path: { id: context.sessionID } }))?.data?.directory ?? process.cwd();
      const destination = workflowDestination(cwd, args.path);
      requireWorkflowCreateAuthorization(context.sessionID, destination);
      const result = createWorkflowDirectory(destination, args.files);
      if (!result.ok) return `⛔ Invalid workflow draft:\n- ${result.errors.join("\n- ")}`;
      createAuthorizations.delete(context.sessionID);
      context.metadata({ title: "Workflow created", metadata: result });
      return [
        `✓ Created workflow: ${result.path}`,
        `  ${result.files} files | ${result.stages} stages | ${result.todos} TODOs | minimum ${result.requiredTurns} turns`,
        `  Validated successfully. Start deliberately with: /workflow start ${result.path}`,
      ].join("\n");
    },
  });

  const hooks = {
    tool: { workflow_control: workflowControl, workflow_verify: workflowVerify, workflow_review: workflowReview,
      workflow_commit: workflowCommit, workflow_handoff: workflowHandoff,
      workflow_create: workflowCreate },

    "permission.ask": async (input, output) => {
      const decision = await dangerPermissionDecision(input);
      if (decision) output.status = decision;
    },

    "experimental.compaction.autocontinue": async (input, output) => {
      if (pendingAutoCompactions.has(input.sessionID)) output.enabled = false;
    },

    "tool.execute.after": async (input) => {
      const id = await workflowIdForSession(input.sessionID);
      if (!id) return;
      const name = input.tool.toLowerCase();
      if (!name.includes("resolve-library-id") && !name.includes("query-docs")) return;
      const state = loadWorkflow(id);
      if (!state || state.status !== "running") return;
      state.context7Evidence ??= { resolved: false, queried: false };
      if (name.includes("resolve-library-id")) state.context7Evidence.resolved = true;
      if (name.includes("query-docs")) state.context7Evidence.queried = true;
      event(state, "context7.evidence", { resolved: state.context7Evidence.resolved, queried: state.context7Evidence.queried });
      saveWorkflow(state);
    },

    "command.execute.before": async (input, output) => {
      if (input.command !== "workflow") return;
      const sessionID = input.sessionID;
      const args = (input.arguments ?? "").trim();
      if (input.workflowControlDispatch) {
        const receipt = consumeCommandReceipt(sessionID, args);
        if (receipt) { output.parts = receipt; return; }
      }
      let deferToDispatch = false;
      try {
      const [sub = "status", ...parts] = args.split(/\s+/);

      if (sub === "create") {
        const requestedPath = workflowCreateCommandPath(parts);
        await authorizeWorkflowCreate(sessionID, requestedPath || null);
        output.parts = [{ type: "text", text: "◈ Starting interactive workflow creation. The destination must not already exist." }];
        return;
      }

      if (sub === "validate") {
        const source = expandPath(stripFlags(parts.join(" ")));
        const result = validateWorkflow(source, {
          maxStageTurns: flag(args, "max-stage-turns", DEFAULT_MAX_STAGE_TURNS),
          maxTotalTurns: flag(args, "max-total-turns", DEFAULT_MAX_TOTAL_TURNS),
        });
        output.parts = [{ type: "text", text: result.ok
          ? `✓ Valid workflow: ${result.todos.length} TODOs, ${Object.keys(result.stages).length} stages, minimum ${result.requiredTurns} turns.`
          : `⛔ Invalid workflow:\n- ${result.errors.join("\n- ")}` }];
        return;
      }

      if (sub === "list-plain") {
        const states = listWorkflows();
        output.parts = [{ type: "text", text: states.length ? states.map((state) =>
          `${state.schemaVersion === SCHEMA_VERSION ? "" : "LEGACY "}${state.id} [${state.status}] ${state.sourcePath}`).join("\n") : "◈ No persisted workflows." }];
        return;
      }

      if (sub === "list") {
        const states = listWorkflows();
        if (!states.length) {
          output.parts = [{ type: "text", text: "◈ No persisted workflows." }];
          return;
        }
        if (!input.workflowControlDispatch) {
          // Direct command path: do NOT open the picker here. Defer to the tool
          // dispatch (chat) so the picker opens exactly once, via chat.
          deferToDispatch = true;
          output.parts = [{ type: "text", text: "◈ Opening workflow picker…" }];
          return;
        }
        // Dispatch (chat) path: open the TUI picker via the workflow-list bridge.
        // client.tui.executeCommand only resolves fixed aliases — use publish instead.
        // app.tsx: event.on("tui.command.execute") → keymap.dispatchCommand(command)
        // which resolves our registerLayer command by its name "workflow-list".
        try {
          await client.tui.publish({
            body: { type: "tui.command.execute", properties: { command: "workflow-list" } },
          });
          output.parts = [{ type: "text", text: "◈ Opening workflow picker…" }];
        } catch {
          // headless / no TUI → fall back to plain text list
          output.parts = [{ type: "text", text: states.map((state) =>
            `${state.schemaVersion === SCHEMA_VERSION ? "" : "LEGACY "}${state.id} [${state.status}] ${state.sourcePath}`).join("\n") }];
        }
        return;
      }

      if (sub === "doctor") {
        const id = parts[0] || sessionToWorkflow.get(sessionID);
        const state = id ? loadWorkflow(id) : null;
        if (!state) { output.parts = [{ type: "text", text: "◈ Workflow not found. Pass an ID or attach a workflow." }]; return; }
        const source = state.schemaVersion === SCHEMA_VERSION && state.sourceSnapshot
          ? compareWorkflowSource(state) : { ok: false, reason: state.migrationError || `state is not schema v${SCHEMA_VERSION}` };
        const lock = inspectLock(state.id);
        const gitInfo = workflowGitDiagnostics(state);
        const issues = [state.migrationError, source.ok ? null : source.reason, ...(gitInfo.errors ?? []),
          lock.exists && !lock.alive ? "workflow lock is stale" : null,
          lock.alive && lock.sessionID !== state.sessionID ? `lock belongs to session ${lock.sessionID}, state records ${state.sessionID}` : null,
          state.phase === "stage_compact_wait" ? state.blocker?.reason ?? "stage compaction requires attention" : null,
          state.phase === "stage_handoff" && !state.stageTransition ? "stage handoff is missing transition metadata" : null].filter(Boolean);
        output.parts = [{ type: "text", text: [
          `◈ Workflow doctor: ${state.id}`,
          `  Schema: v${state.schemaVersion}${state.migrationError ? ` (migration failed: ${state.migrationError})` : ""}`,
          `  Status: ${state.status} | phase: ${state.phase ?? "unknown"}`,
          `  Source: ${source.ok ? "ok" : source.reason}`,
          `  Lock: ${!lock.exists ? "none" : lock.alive ? `live pid=${lock.pid} session=${lock.sessionID}` : "stale"}`,
          `  Git: ${gitInfo.ok ? "ok" : (gitInfo.errors ?? []).join("; ") || "unavailable"}`,
          `  Stage context: ${state.stageCompaction?.status ?? "idle"}`,
          issues.length ? `  Recovery: ${state.migrationError || !source.ok ? `run /workflow recover ${state.sourcePath}` : "resolve the issues above, then retry or resume"}` : "  No issues found.",
        ].join("\n") }];
        return;
      }

      if (sub === "recover") {
        const confirmed = parts.includes("confirm");
        const rawSource = stripFlags(parts.filter((part) => part !== "confirm").join(" "));
        if (!rawSource) { output.parts = [{ type: "text", text: "Usage: /workflow recover <path> [--branch name] [--base name] [confirm]" }]; return; }
        const sourcePath = expandPath(rawSource);
        const cwd = (await client.session.get({ path: { id: sessionID } }))?.data?.directory ?? process.cwd();
        const analysis = analyzeWorkflowRecovery(sourcePath, cwd, {
          branch: stringFlag(args, "branch"), baseBranch: stringFlag(args, "base"),
        });
        if (!analysis.parsed) { output.parts = [{ type: "text", text: `⛔ Recovery unavailable:\n- ${(analysis.errors ?? ["unknown error"]).join("\n- ")}` }]; return; }
        const existing = loadWorkflow(analysis.id);
        const existingHealthy = existing && existing.schemaVersion === SCHEMA_VERSION && !existing.migrationError &&
          compareWorkflowSource(existing).ok && !String(existing.blocker?.reason ?? "").includes("migrated from v1");
        if (existingHealthy) { output.parts = [{ type: "text", text: `⛔ Healthy state ${analysis.id} already exists; use /workflow attach ${analysis.id}.` }]; return; }
        const preview = [
          `◈ Recovery preview: ${analysis.id}`,
          `  Documents: ${analysis.parsed.todos.filter((todo) => todo.done).length}/${analysis.parsed.todos.length} checked`,
          `  Workflow branch: ${analysis.branch ?? `ambiguous (${analysis.branchCandidates?.join(", ") || "none"})`}`,
          `  Base branch: ${analysis.baseBranch ?? `ambiguous (${analysis.baseCandidates?.join(", ") || "none"})`}`,
          `  Stage commits found: ${analysis.commits.length}`,
          `  Worktree: ${analysis.dirty ? "dirty (preserved)" : "clean"}`,
          "  Reset: verification, manual and Context7 evidence, retries, turns, skips, and old audit history.",
          ...(analysis.errors ?? []).map((error) => `  Blocker: ${error}`),
        ];
        if (!confirmed) { output.parts = [{ type: "text", text: `${preview.join("\n")}\nRun the same command with confirm after resolving blockers.` }]; return; }
        if (!analysis.ok) { output.parts = [{ type: "text", text: `⛔ Recovery confirmation refused:\n- ${analysis.errors.join("\n- ")}` }]; return; }
        const lock = inspectLock(analysis.id);
        if (lock.exists && lock.alive && lock.sessionID !== sessionID) {
          output.parts = [{ type: "text", text: `⛔ Workflow is locked by live session ${lock.sessionID}.` }]; return;
        }
        if (!acquireLock(analysis.id, sessionID, { takePaused: true })) {
          output.parts = [{ type: "text", text: "⛔ Could not acquire workflow lock." }]; return;
        }
        archiveWorkflowState(analysis.id);
        const committedStages = new Set(analysis.commits.map((commit) => String(commit.stage).replace(/^0+(?=\d)/, "")));
        let cursor = -1;
        let phase = "todo_execute";
        let stage = null;
        for (const stageId of Object.keys(analysis.parsed.stages).sort((a, b) => Number(a) - Number(b))) {
          const todos = analysis.parsed.todos.filter((todo) => todo.stage === stageId);
          if (committedStages.has(stageId) && todos.every((todo) => todo.done)) continue;
          stage = stageId;
          cursor = analysis.parsed.todos.findIndex((todo) => todo.stage === stageId && !todo.done);
          if (cursor < 0) { cursor = analysis.parsed.todos.findIndex((todo) => todo.stage === stageId); phase = "stage_gate"; }
          break;
        }
        const completed = stage === null;
        const recovered = {
          schemaVersion: SCHEMA_VERSION, id: analysis.id, sourcePath: analysis.parsed.sourcePath,
          sourceSnapshot: analysis.sourceSnapshot, projectCwd: analysis.projectCwd, sessionID,
          status: completed ? "completed" : "paused", phase: completed ? "stage_commit" : phase,
          stage: stage ?? analysis.parsed.todos.at(-1)?.stage, todos: analysis.parsed.todos,
          stages: analysis.parsed.stages, cursor: Math.max(cursor, 0), attempts: 0, turns: 0, stageTurns: 0,
          maxStageTurns: DEFAULT_MAX_STAGE_TURNS, maxTotalTurns: DEFAULT_MAX_TOTAL_TURNS,
          branch: analysis.branch, baseBranch: analysis.baseBranch, baseHead: analysis.baseHead,
          expectedHead: analysis.head, stagePlans: {}, todoEvidence: {}, gateEvidence: null,
          commitEvidence: null, manualEvidence: [], context7Evidence: { resolved: false, queried: false },
          skipReasons: {}, commits: analysis.commits.map(({ stage: commitStage, sha }) => ({ stage: commitStage, sha, at: Date.now() })),
          blocker: null, startedAt: Date.now(), completedAt: completed ? Date.now() : null,
          noConfirm: false, auditEvents: [], pauseRequest: null, pausedCheckpoint: null,
          stageHandoffs: {}, stageCompaction: null, stageTransition: null,
          executionEvidence: null,
          reporting: { stageStartedAt: Date.now(), todoStartedAt: null, todos: {}, stages: {} },
        };
        event(recovered, "workflow.recovered", { documentsChecked: recovered.todos.filter((todo) => todo.done).length,
          commits: recovered.commits.length, resetEvidence: true, dirtyWorktreePreserved: analysis.dirty });
        saveWorkflow(recovered);
        sessionToWorkflow.set(sessionID, recovered.id);
        output.parts = [{ type: "text", text: `${preview.join("\n")}\n✓ Recovered in ${recovered.status} state${completed ? "." : "; use /workflow resume."}` }];
        return;
      }

      if (sub === "start") {
        const rawSource = stripFlags(parts.join(" "));
        if (!rawSource) { output.parts = [{ type: "text", text: "Usage: /workflow start <path> [--max-stage-turns N] [--max-total-turns N]" }]; return; }
        const source = expandPath(rawSource);
        const maxStageTurns = flag(args, "max-stage-turns", DEFAULT_MAX_STAGE_TURNS);
        const maxTotalTurns = flag(args, "max-total-turns", DEFAULT_MAX_TOTAL_TURNS);
        const parsed = validateWorkflow(source, { maxStageTurns, maxTotalTurns });
        if (!parsed.ok) { output.parts = [{ type: "text", text: `⛔ Invalid workflow:\n- ${parsed.errors.join("\n- ")}` }]; return; }
        if (!parsed.todos.some((todo) => !todo.done)) {
          output.parts = [{ type: "text", text: "✓ Workflow document is already fully checked." }];
          return;
        }
        const cwd = (await client.session.get({ path: { id: sessionID } }))?.data?.directory ?? process.cwd();
        const preflight = gitPreflight(cwd);
        if (!preflight.ok) { output.parts = [{ type: "text", text: `⛔ Git preflight failed: ${preflight.reason}` }]; return; }
        const id = workflowIdFromPath(parsed.sourcePath);
        if (!acquireLock(id, sessionID)) { output.parts = [{ type: "text", text: `⛔ Workflow ${id} is locked by another session.` }]; return; }
        const branchResult = createWorkflowBranch(preflight.root, id);
        if (!branchResult.ok) { releaseLock(id); output.parts = [{ type: "text", text: `⛔ ${branchResult.reason}` }]; return; }
        const first = parsed.todos.findIndex((todo) => !todo.done);
        const state = {
          schemaVersion: SCHEMA_VERSION, id, sourcePath: parsed.sourcePath, projectCwd: preflight.root,
          sourceSnapshot: snapshotWorkflowSource(parsed.sourcePath), auditEvents: [],
          sessionID, status: "running", phase: "stage_plan", stage: parsed.todos[first].stage,
          todos: parsed.todos, stages: parsed.stages, cursor: first, attempts: 0, turns: 0, stageTurns: 0,
          maxStageTurns, maxTotalTurns, branch: branchResult.branch, baseBranch: preflight.branch,
          baseHead: preflight.head, expectedHead: preflight.head, stagePlans: {}, todoEvidence: {},
          gateEvidence: null, commitEvidence: null, manualEvidence: [], context7Evidence: { resolved: false, queried: false },
          skipReasons: {}, commits: [], blocker: null, startedAt: Date.now(), updatedAt: Date.now(), completedAt: null,
          noConfirm: flagBool(args, "no-confirm"), pauseRequest: null, pausedCheckpoint: null,
          perTodoCommits: true, todoCommits: [],
          stageHandoffs: {}, stageCompaction: null, stageTransition: null,
          executionEvidence: null,
          reporting: { stageStartedAt: Date.now(), todoStartedAt: null, todos: {}, stages: {} },
        };
        event(state, "workflow.started", { sourcePath: parsed.sourcePath, branch: branchResult.branch });
        saveWorkflow(state);
        sessionToWorkflow.set(sessionID, id);
        output.parts = [{ type: "text", text: `◈ Started ${id} on ${branchResult.branch}. ${parsed.todos.length} TODOs; minimum ${parsed.requiredTurns} turns.` }];
        await inject(sessionID, stagePlanPrompt(state), "plan");
        return;
      }

      if (sub === "attach") {
        const id = parts[0];
        const state = id ? loadWorkflow(id) : null;
        if (!state) { output.parts = [{ type: "text", text: "◈ Workflow not found." }]; return; }
        if (state.schemaVersion !== SCHEMA_VERSION || state.migrationError) { output.parts = [{ type: "text", text: `⛔ Workflow state is unusable: ${state.migrationError || `schema v${state.schemaVersion}`}. Run /workflow doctor ${id}.` }]; return; }
        if (!acquireLock(id, sessionID, { takePaused: state.status !== "running" })) { output.parts = [{ type: "text", text: "⛔ Workflow is still owned by a live session." }]; return; }
        const previousSessionID = state.sessionID;
        if (previousSessionID && previousSessionID !== sessionID) {
          setDanger(previousSessionID, false);
          sessionToWorkflow.delete(previousSessionID);
          clearSessionTransientState(previousSessionID);
        }
        state.sessionID = sessionID;
        if (state.status === "running") state.status = "paused";
        event(state, "workflow.attached", { sessionID });
        saveWorkflow(state);
        sessionToWorkflow.set(sessionID, id);
        output.parts = [{ type: "text", text: `◈ Attached ${id} [${state.status}]. Clearing context…` }];
        setTimeout(() => {
          const attached = loadWorkflow(id);
          if (attached) clearContextAndReseed(sessionID, attached);
        }, 50);
        return;
      }

      if (sub === "status" || !sub) { output.parts = [{ type: "text", text: statusText(activeState(sessionID)) }]; return; }

      if (sub === "reset") {
        const explicitId = parts[0] !== "confirm" ? parts[0] : sessionToWorkflow.get(sessionID);
        const confirmed = parts.includes("confirm");
        if (!confirmed || !explicitId) { output.parts = [{ type: "text", text: "Usage: /workflow reset [id] confirm" }]; return; }
        const resetState = loadWorkflow(explicitId);
        if (resetState?.sessionID) { setDanger(resetState.sessionID, false); clearSessionTransientState(resetState.sessionID); }
        releaseLock(explicitId); deleteWorkflow(explicitId);
        if (sessionToWorkflow.get(sessionID) === explicitId) sessionToWorkflow.delete(sessionID);
        output.parts = [{ type: "text", text: `◈ Reset ${explicitId}.` }]; return;
      }
      const state = activeState(sessionID);
      if (!state) { output.parts = [{ type: "text", text: "◈ No workflow attached." }]; return; }

      if (sub === "rewind") {
        const targetStage = parts[0] === "stage" ? parts[1] : null;
        if (!targetStage || !parts.includes("confirm")) {
          output.parts = [{ type: "text", text: "Usage: /workflow rewind stage <stage> confirm" }]; return;
        }
        if (!state.stages[targetStage]) {
          output.parts = [{ type: "text", text: `⛔ Unknown workflow stage ${targetStage}.` }]; return;
        }
        if (!['paused', 'blocked', 'stopped'].includes(state.status)) {
          output.parts = [{ type: "text", text: "⛔ Pause or stop the workflow before rewinding." }]; return;
        }
        const source = compareWorkflowSource(state);
        if (!source.ok) { output.parts = [{ type: "text", text: `⛔ ${source.reason}` }]; return; }
        const stageOrder = Object.keys(state.stages);
        const targetIndex = stageOrder.indexOf(targetStage);
        const rewoundStages = new Set(stageOrder.slice(targetIndex));
        const committed = state.commits.filter((commit) => rewoundStages.has(commit.stage));
        if (committed.length) {
          output.parts = [{ type: "text", text: `⛔ Cannot rewind committed stage ${committed[0].stage}; Git history must be recovered separately.` }]; return;
        }
        archiveWorkflowState(state.id, `pre-rewind-stage-${targetStage}`);
        const completedTodos = state.todos.filter((item) => rewoundStages.has(item.stage) && item.done);
        const unchecked = uncheckTodosInSource(completedTodos);
        if (!unchecked.ok) {
          output.parts = [{ type: "text", text: `⛔ Could not uncheck ${unchecked.todo}; workflow state was not changed.` }]; return;
        }
        for (const todo of state.todos.filter((item) => rewoundStages.has(item.stage))) {
          todo.done = false;
          todo.skipped = false;
          delete state.skipReasons[todo.id];
          delete state.reporting?.todos?.[todo.id];
        }
        for (const stage of rewoundStages) {
          delete state.stagePlans[stage];
          delete state.stageHandoffs?.[stage];
          delete state.reporting?.stages?.[stage];
        }
        state.cursor = state.todos.findIndex((todo) => todo.stage === targetStage);
        state.stage = targetStage;
        state.status = "paused";
        state.phase = "stage_plan";
        state.attempts = 0;
        state.stageTurns = 0;
        state.todoEvidence = {};
        state.gateEvidence = null;
        state.commitEvidence = null;
        state.manualEvidence = [];
        state.context7Evidence = { resolved: false, queried: false };
        state.executionEvidence = null;
        state.blocker = null;
        state.pauseRequest = null;
        state.pausedCheckpoint = null;
        state.stageTransition = null;
        state.stageCompaction = null;
        state.reporting.stageStartedAt = Date.now();
        state.reporting.todoStartedAt = null;
        refreshWorkflowSourceSnapshot(state);
        event(state, "workflow.rewound", { stage: targetStage, preservedCommits: state.commits.map((commit) => commit.stage) });
        saveWorkflow(state);
        output.parts = [{ type: "text", text: `↶ Rewound to Stage ${targetStage}. Earlier commits are preserved; use /workflow resume.` }]; return;
      }

      if (sub === "log") {
        output.parts = [{ type: "text", text: logText(state, flag(args, "limit", 50)) }]; return;
      }
      if (sub === "finish") {
        const report = workflowFinishReport(state);
        output.parts = [{ type: "text", text: report.ok ? [
          `✓ Workflow ${state.id} is ready to integrate.`,
          `Base: ${report.baseBranch} | workflow: ${report.branch}`,
          ...report.commits.map((commit) => `- stage ${commit.stage}: ${commit.sha}`),
          ...Object.entries(report.skipped).map(([id, reason]) => `- skipped ${id}: ${reason}`),
          "", ...report.commands,
        ].join("\n") : `⛔ Cannot finish: ${report.reason}` }];
        return;
      }
      if (sub === "pause") {
        if (parts[0] === "now") {
          state.status = "paused";
          state.pauseRequest = null;
          state.pausedCheckpoint = null;
          event(state, "workflow.paused_immediately");
          saveWorkflow(state);
          output.parts = [{ type: "text", text: "⏸ Workflow paused immediately. Active tool or response work may still finish." }];
          return;
        }
        if (state.status !== "running") {
          output.parts = [{ type: "text", text: `◈ Workflow is already ${state.status}.` }];
          return;
        }
        if (!state.pauseRequest) {
          state.pauseRequest = { requestedAt: Date.now(), requestedPhase: state.phase,
            requestedStage: state.stage, requestedTodo: currentTodo(state)?.id ?? null };
          event(state, "workflow.pause_requested", state.pauseRequest);
          saveWorkflow(state);
        }
        output.parts = [{ type: "text", text: "⏳ Checkpoint pause requested. The workflow will pause after the current verified TODO or stage commit." }];
        return;
      }
      if (sub === "resume") {
        if (!["paused", "blocked", "stopped"].includes(state.status)) { output.parts = [{ type: "text", text: `◈ Workflow is ${state.status}.` }]; return; }
        if (!ensureSourceFresh(state, sessionID)) { output.parts = [{ type: "text", text: `⛔ ${state.blocker.reason}` }]; return; }
        if (state.phase === "stage_compact_wait") {
          if (!state.stageCompaction?.manualCompletedAt) {
            output.parts = [{ type: "text", text: "⛔ Stage context is not compacted. Run /compact first, or use /workflow retry to retry automatic compaction." }];
            return;
          }
          state.status = "running";
          state.blocker = null;
          state.stageCompaction = { ...state.stageCompaction, status: "completed", completedAt: state.stageCompaction.manualCompletedAt, error: null };
          event(state, "stage.compaction_completed", { stage: state.stageCompaction.stage, manual: true });
          output.parts = [{ type: "text", text: "▶ Workflow resumed after manual stage compaction." }];
          await advanceAfterStageRefresh(state, sessionID, "stage_context_refreshed");
          return;
        }
        maybeHealExpectedHead(state);
        const checkpoint = state.pausedCheckpoint;
        state.status = "running"; state.blocker = null; state.stageTurns = 0; state.pausedCheckpoint = null;
        event(state, "workflow.resumed", { pausePending: Boolean(state.pauseRequest) }); saveWorkflow(state);
        if (state.phase === "compact_wait") {
          state.compaction = null;
          saveWorkflow(state);
          output.parts = [{ type: "text", text: "▶ Workflow resumed after compaction boundary." }];
          await beginNextTodoOrGate(state, sessionID, "todo_verified");
          return;
        }
        if (checkpoint) {
          output.parts = [{ type: "text", text: `▶ Workflow resumed from ${checkpoint.kind}.` }];
          await injectPreparedPhase(state, sessionID);
          return;
        }
        output.parts = [{ type: "text", text: "▶ Workflow resumed." }]; kick(sessionID); return;
      }
      if (sub === "retry") {
        if (!ensureSourceFresh(state, sessionID)) { output.parts = [{ type: "text", text: `⛔ ${state.blocker.reason}` }]; return; }
        state.status = "running"; state.attempts++; state.stageTurns = 0;
        if (["todo_execute", "todo_verify", "manual_wait"].includes(state.phase)) {
          state.phase = "todo_execute"; state.todoEvidence = {}; state.manualEvidence = [];
          state.context7Evidence = { resolved: false, queried: false };
          state.executionEvidence = null;
          state.reporting.todoStartedAt = Date.now();
        }
        if (state.phase === "stage_compact_wait") state.phase = "stage_compact";
        maybeHealExpectedHead(state);
        state.blocker = null;
        event(state, "workflow.retried", { attempt: state.attempts });
        saveWorkflow(state); output.parts = [{ type: "text", text: "↺ Workflow retry scheduled." }]; kick(sessionID); return;
      }
      if (sub === "confirm") {
        const evidence = parts.join(" ").trim();
        const todo = currentTodo(state);
        if (state.phase !== "manual_wait" || !evidence) { output.parts = [{ type: "text", text: "Usage: /workflow confirm <manual evidence>" }]; return; }
        if (!ensureSourceFresh(state, sessionID)) { output.parts = [{ type: "text", text: `⛔ ${state.blocker.reason}` }]; return; }
        state.manualEvidence = todo.manual.map((criterion) => ({ criterion, evidence, at: Date.now() }));
        state.status = "running"; state.phase = "todo_execute"; event(state, "manual.confirmed", { evidence }); saveWorkflow(state);
        output.parts = [{ type: "text", text: "✓ Manual evidence recorded." }]; kick(sessionID); return;
      }
      if (sub === "skip") {
        if (parts[0] !== "confirm" || !parts.slice(1).join(" ").trim()) { output.parts = [{ type: "text", text: "Usage: /workflow skip confirm <reason>" }]; return; }
        if (!ensureSourceFresh(state, sessionID)) { output.parts = [{ type: "text", text: `⛔ ${state.blocker.reason}` }]; return; }
        const todo = currentTodo(state); todo.skipped = true; state.skipReasons[todo.id] = parts.slice(1).join(" "); state.status = "running";
        event(state, "todo.skipped", { id: todo.id, reason: state.skipReasons[todo.id] });
        saveWorkflow(state); output.parts = [{ type: "text", text: `⏭ Skipped ${todo.id}; stage gate remains mandatory.` }]; await beginNextTodoOrGate(state, sessionID, "todo_skipped"); return;
      }
      if (sub === "stop") { state.status = "stopped"; event(state, "workflow.stopped"); saveWorkflow(state); releaseLock(state.id); setDanger(sessionID, false); sessionToWorkflow.delete(sessionID); clearSessionTransientState(sessionID); output.parts = [{ type: "text", text: "◈ Workflow stopped; state preserved." }]; return; }
      if (sub === "danger") {
        const dangerState = activeState(sessionID);
        if (!dangerState) { output.parts = [{ type: "text", text: "⛔ Attach or start a workflow first (/workflow start|attach)." }]; return; }
        const target = parts[0] === "on" ? true : parts[0] === "off" ? false : !isDanger(sessionID);
        setDanger(sessionID, target);
        event(dangerState, "danger.toggled", { on: target });
        saveWorkflow(dangerState);
        client.tui.showToast({ body: { message: target ? "⚠ DANGER MODE ON — approvals bypassed" : "Danger mode off", variant: target ? "warning" : "info" } }).catch(() => {});
        output.parts = [{ type: "text", text: target ? "⚠ Danger mode ON — command/edit approvals are bypassed for this session." : "✓ Danger mode OFF." }];
        return;
      }
      output.parts = [{ type: "text", text: `◈ Unknown workflow command: ${sub}` }];
      } finally {
        if (!input.workflowControlDispatch && !deferToDispatch) rememberCommandReceipt(sessionID, args, output.parts);
      }
    },

    event: async ({ event }) => {
      const sessionID = event.properties?.sessionID;
      if (!sessionID) return;
      if (event.type === "session.deleted") {
        clearSessionTransientState(sessionID);
        return;
      }
      if (event.type === "permission.asked") {
        await replyToPermissionRequest(event.properties);
        return;
      }
      if (event.type === "session.error") {
        const state = activeState(sessionID);
        if (state) {
          state.status = "paused";
          state.blocker = { reason: sessionErrorBlockerReason(state), at: Date.now() };
          appendWorkflowEvent(state, "session.error");
          saveWorkflow(state);
          releaseLock(state.id);
        }
        return;
      }
      if (event.type === "session.compacted") {
        clearContextPressure(sessionID);
        const state = activeState(sessionID);
        if (state?.phase === "stage_compact_wait" && state.stageCompaction) {
          state.stageCompaction.manualCompletedAt = Date.now();
          appendWorkflowEvent(state, "stage.compaction_manual", { stage: state.stageCompaction.stage });
          saveWorkflow(state);
        }
        return;
      }
      if (event.type === "session.idle") await onIdle(sessionID);
    },
  };
  commandHook = hooks["command.execute.before"];
  return hooks;
};
