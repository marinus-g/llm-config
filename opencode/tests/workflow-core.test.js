import { after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SCHEMA_VERSION, setStorageRoot, parseWorkflowDoc, parseWorkflowPath,
  validateWorkflow, checkTodoInSource, uncheckTodosInSource, workflowIdFromPath, saveWorkflow,
  loadWorkflow, listWorkflows, deleteWorkflow, acquireLock, releaseLock,
  gitPreflight, createWorkflowBranch, verifyWorkflowBranch, createStageCommit,
  snapshotWorkflowSource, compareWorkflowSource, refreshWorkflowSourceSnapshot,
  appendWorkflowEvent, getStateDir, createWorkflowDirectory,
} from "../lib/workflow-core.js";

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "workflow-v2-")); setStorageRoot(join(root, "state")); });
after(() => { /* each test owns a unique temporary root */ });

function doc(options = {}) {
  const checked = options.checked ? "x" : " ";
  const context = options.context ?? "required";
  const verify = options.manual
    ? "  - Verify manual: Confirm the page renders."
    : "  - Verify: `node --version`";
  return `## Stage 01 - Setup\n- [${checked}] **01.1 Build setup**\n  Full requirement text.\n  - Context7: ${context}\n${verify}\n- Stage gate: \`node --check app.js\`\n`;
}

describe("strict parser", () => {
  it("captures body, Context7, command verification, and gate", () => {
    const parsed = parseWorkflowDoc(doc(), "task.md");
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.todos[0].body, "Full requirement text.");
    assert.equal(parsed.todos[0].context7, "required");
    assert.deepEqual(parsed.todos[0].verify, ["node --version"]);
    assert.equal(parsed.stages["1"].gate, "node --check app.js");
  });

  it("supports manual verification", () => {
    const parsed = parseWorkflowDoc(doc({ manual: true, context: "not-applicable" }));
    assert.equal(parsed.todos[0].manual[0], "Confirm the page renders.");
  });

  it("rejects missing Context7, verification, and gate", () => {
    const parsed = parseWorkflowDoc("## Stage 01 - X\n- [ ] **01.1 Bad**\n  text\n");
    assert.ok(parsed.errors.some((error) => error.includes("Context7")));
    assert.ok(parsed.errors.some((error) => error.includes("verification")));
  });

  it("rejects duplicate TODO IDs across files", () => {
    const dir = join(root, "tasks"); mkdirSync(dir);
    writeFileSync(join(dir, "01-a.md"), doc());
    writeFileSync(join(dir, "02-b.md"), doc().replace("Stage 01", "Stage 02"));
    const parsed = parseWorkflowPath(dir);
    assert.ok(parsed.errors.some((error) => error.includes("duplicate TODO")));
  });

  it("ignores evidence files and subdirectories from the source glob", () => {
    const dir = join(root, "harden"); mkdirSync(dir);
    writeFileSync(join(dir, "01-setup.md"), doc({ context: "not-applicable" }));
    // A file that would previously have been absorbed as workflow source
    writeFileSync(join(dir, "01-setup-evidence.md"), "## Stage 01 - Fake\nthis must not be parsed\n");
    // An NN-name.md file sitting in an evidence/ subfolder
    mkdirSync(join(dir, "evidence"));
    writeFileSync(join(dir, "evidence", "02-research.md"), doc({ context: "not-applicable" }).replace("Stage 01", "Stage 02"));
    const parsed = parseWorkflowPath(dir);
    // Only the real stage file should be picked up — no errors from the stray files
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.files.length, 1);
    assert.ok(parsed.files[0].endsWith("01-setup.md"));
    assert.equal(parsed.todos.length, 1);
    assert.equal(parsed.todos[0].id, "01.1");
  });

  it("validates minimum limits", () => {
    const file = join(root, "01.md"); writeFileSync(file, doc());
    const result = validateWorkflow(file, { maxStageTurns: 1, maxTotalTurns: 1 });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes("turns")));
  });
});

describe("workflow creation", () => {
  const files = () => [
    { path: "00-context.md", content: "# Test Workflow\n\nBuild the test behavior.\n" },
    { path: "01-setup.md", content: doc({ context: "not-applicable" }) },
    { path: "evidence/notes.md", content: "# Supporting notes\n" },
  ];

  it("atomically creates a full validated workflow directory", () => {
    const target = join(root, "created-workflow");
    const result = createWorkflowDirectory(target, files());
    assert.equal(result.ok, true);
    assert.equal(result.path, target);
    assert.equal(result.files, 3);
    assert.equal(result.stages, 1);
    assert.equal(result.todos, 1);
    assert.equal(readFileSync(join(target, "00-context.md"), "utf8").startsWith("# Test Workflow"), true);
  });

  it("removes staging output when the workflow is invalid", () => {
    const target = join(root, "invalid-workflow");
    const invalid = files();
    invalid[1].content = "## Stage 01 - Missing work\n";
    const result = createWorkflowDirectory(target, invalid);
    assert.equal(result.ok, false);
    assert.equal(existsSync(target), false);
    assert.equal(readdirSync(root).some((name) => name.startsWith(".invalid-workflow.workflow-create-")), false);
  });

  it("refuses existing destinations and unsafe file paths", () => {
    const existing = join(root, "existing-workflow");
    mkdirSync(existing);
    assert.throws(() => createWorkflowDirectory(existing, files()), /already exists/);
    assert.throws(() => createWorkflowDirectory(join(root, "traversal-workflow"), [
      ...files(), { path: "../escape.md", content: "unsafe" },
    ]), /unsafe workflow file path/);
    assert.equal(existsSync(join(root, "traversal-workflow")), false);
  });

  it("requires a context document, a stage file, and an existing parent", () => {
    assert.throws(() => createWorkflowDirectory(join(root, "no-context"), files().slice(1)), /00-context/);
    assert.throws(() => createWorkflowDirectory(join(root, "no-stage"), [files()[0]]), /numbered stage/);
    assert.throws(() => createWorkflowDirectory(join(root, "missing", "workflow"), files()), /parent directory/);
  });
});

describe("source authority", () => {
  it("only checks the exact TODO", () => {
    const file = join(root, "task.md"); writeFileSync(file, doc());
    const todo = parseWorkflowPath(file).todos[0];
    assert.equal(checkTodoInSource(todo), true);
    assert.match(readFileSync(file, "utf8"), /- \[x\] \*\*01\.1 Build setup\*\*/);
    assert.equal(checkTodoInSource(todo), false);
  });

  it("unchecks a batch of completed TODOs", () => {
    const file = join(root, "task.md"); writeFileSync(file, doc({ checked: true }));
    const todo = parseWorkflowPath(file).todos[0];
    assert.deepEqual(uncheckTodosInSource([todo]), { ok: true });
    assert.match(readFileSync(file, "utf8"), /- \[ \] \*\*01\.1 Build setup\*\*/);
  });
});

describe("isolated persistence and locks", () => {
  it("round trips current-schema state and lists it", () => {
    const state = { schemaVersion: SCHEMA_VERSION, id: "x", status: "paused", updatedAt: 0 };
    saveWorkflow(state);
    assert.equal(loadWorkflow("x").status, "paused");
    assert.equal(listWorkflows()[0].id, "x");
    deleteWorkflow("x");
    assert.equal(loadWorkflow("x"), null);
  });

  it("uses an exclusive lock", () => {
    assert.equal(acquireLock("x", "a"), true);
    assert.equal(acquireLock("x", "b"), false);
    releaseLock("x");
    assert.equal(acquireLock("x", "b"), true);
    releaseLock("x");
  });

  it("hashes canonical paths to avoid suffix collisions", () => {
    const a = join(root, "a", "tasks"); const b = join(root, "b", "tasks");
    mkdirSync(a, { recursive: true }); mkdirSync(b, { recursive: true });
    assert.notEqual(workflowIdFromPath(a), workflowIdFromPath(b));
  });
});

describe("workflow schema safety", () => {
  it("detects source drift and accepts an explicit snapshot refresh", () => {
    const file = join(root, "01.md"); writeFileSync(file, doc());
    const state = { sourcePath: file, sourceSnapshot: snapshotWorkflowSource(file) };
    assert.equal(compareWorkflowSource(state).ok, true);
    writeFileSync(file, doc().replace("Full requirement text.", "Changed requirement."));
    assert.equal(compareWorkflowSource(state).ok, false);
    refreshWorkflowSourceSnapshot(state);
    assert.equal(compareWorkflowSource(state).ok, true);
  });

  it("caps audit history at 500 entries", () => {
    const state = { auditEvents: [], todos: [], cursor: 0 };
    for (let i = 0; i < 510; i++) appendWorkflowEvent(state, "test", { i });
    assert.equal(state.auditEvents.length, 500);
    assert.equal(state.auditEvents[0].details.i, 10);
    assert.equal(state.auditEvents.at(-1).sequence, 510);
  });

  it("automatically migrates v2 state and creates a backup", () => {
    const file = join(root, "01.md"); writeFileSync(file, doc());
    const parsed = parseWorkflowPath(file);
    saveWorkflow({ schemaVersion: 2, id: "migrate-v2", sourcePath: file,
      todos: parsed.todos, stages: parsed.stages, status: "paused", phase: "todo_execute",
      cursor: 0, stage: "1", commits: [] });
    const state = loadWorkflow("migrate-v2");
    assert.equal(state.schemaVersion, SCHEMA_VERSION);
    assert.equal(state.sourceSnapshot.files.length, 1);
    assert.equal(state.auditEvents[0].type, "state.migrated");
    assert.equal(existsSync(join(getStateDir(), "workflow-migrate-v2.json.schema-v2.bak")), true);
  });

  it("does not treat non-TODO workflow documents as v2 definition drift", () => {
    const dir = join(root, "migration-docs"); mkdirSync(dir);
    writeFileSync(join(dir, "00-context.md"), "# Shared context\n\nNo executable TODOs.\n");
    writeFileSync(join(dir, "01-work.md"), doc());
    const parsed = parseWorkflowPath(dir);
    saveWorkflow({ schemaVersion: 2, id: "migrate-context", sourcePath: dir,
      todos: parsed.todos, stages: parsed.stages, status: "paused", phase: "todo_execute",
      cursor: 0, stage: "1", commits: [] });
    const state = loadWorkflow("migrate-context");
    assert.equal(state.schemaVersion, SCHEMA_VERSION);
    assert.equal(state.status, "paused");
    assert.equal(state.blocker, undefined);
    assert.equal(state.sourceSnapshot.files.length, 2);
  });

  it("initializes checkpoint pause fields when migrating v3", () => {
    saveWorkflow({ schemaVersion: 3, id: "migrate-v3", status: "paused", auditEvents: [] });
    const state = loadWorkflow("migrate-v3");
    assert.equal(state.schemaVersion, SCHEMA_VERSION);
    assert.equal(state.pauseRequest, null);
    assert.equal(state.pausedCheckpoint, null);
    assert.deepEqual(state.stageHandoffs, {});
    assert.equal(state.stageCompaction, null);
    assert.equal(state.stageTransition, null);
  });

  it("initializes durable report boundaries when migrating v5", () => {
    saveWorkflow({ schemaVersion: 5, id: "migrate-v5", status: "paused", auditEvents: [] });
    const state = loadWorkflow("migrate-v5");
    assert.equal(state.schemaVersion, SCHEMA_VERSION);
    assert.equal(typeof state.reporting.stageStartedAt, "number");
    assert.equal(typeof state.reporting.todoStartedAt, "number");
    assert.deepEqual(state.reporting.todos, {});
    assert.deepEqual(state.reporting.stages, {});
    assert.equal(state.auditEvents.at(-1).type, "state.migrated");
  });

  it("migrates v1 history but stops active execution", () => {
    const file = join(root, "01.md"); writeFileSync(file, doc());
    const parsed = parseWorkflowPath(file);
    saveWorkflow({ schemaVersion: 1, id: "migrate-v1", sourcePath: file,
      todos: parsed.todos.map(({ id, file: todoFile, title, verify, stage, done, skipped }) =>
        ({ id, file: todoFile, title, verify, stage, done, skipped })),
      gates: { "1": parsed.stages["1"].gate }, stageTitles: { "1": parsed.stages["1"].title },
      status: "running", todoPhase: "executing", cursor: 0, stage: "1", commits: [] });
    const state = loadWorkflow("migrate-v1");
    assert.equal(state.schemaVersion, SCHEMA_VERSION);
    assert.equal(state.status, "stopped");
    assert.match(state.blocker.reason, /cannot be recovered safely/);
  });

  it("leaves future schemas read-only", () => {
    saveWorkflow({ schemaVersion: 99, id: "future", status: "paused" });
    const state = loadWorkflow("future");
    assert.equal(state.schemaVersion, 99);
    assert.match(state.migrationError, /newer than supported/);
  });

  it("detects files added to a directory workflow", () => {
    const dir = join(root, "tasks"); mkdirSync(dir);
    writeFileSync(join(dir, "01-a.md"), doc());
    const state = { sourcePath: dir, sourceSnapshot: snapshotWorkflowSource(dir) };
    writeFileSync(join(dir, "02-b.md"), doc().replaceAll("01", "02"));
    assert.equal(compareWorkflowSource(state).ok, false);
  });
});

function git(args, cwd) { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }
function repo() {
  const dir = join(root, "repo"); mkdirSync(dir);
  git(["init", "-b", "main"], dir);
  git(["config", "user.email", "workflow@example.invalid"], dir);
  git(["config", "user.name", "Workflow Test"], dir);
  writeFileSync(join(dir, "app.js"), "export {};\n");
  git(["add", "app.js"], dir); git(["commit", "-m", "initial"], dir);
  return dir;
}

describe("Git isolation", () => {
  it("requires a clean repository with an initial commit", () => {
    const dir = repo(); assert.equal(gitPreflight(dir).ok, true);
    writeFileSync(join(dir, "dirty.txt"), "dirty");
    assert.equal(gitPreflight(dir).ok, false);
  });

  it("creates and verifies a dedicated branch", () => {
    const dir = repo(); const pre = gitPreflight(dir);
    const branch = createWorkflowBranch(dir, "demo");
    assert.equal(branch.ok, true);
    const state = { projectCwd: dir, branch: branch.branch, expectedHead: pre.head };
    assert.equal(verifyWorkflowBranch(state).ok, true);
  });

  it("commits a completed stage and returns the new head", () => {
    const dir = repo(); const pre = gitPreflight(dir); const branch = createWorkflowBranch(dir, "demo");
    writeFileSync(join(dir, "app.js"), "export const done = true;\n");
    const state = { projectCwd: dir, branch: branch.branch, expectedHead: pre.head, stages: { "1": { title: "Setup" } } };
    const result = createStageCommit(state, "1");
    assert.equal(result.ok, true);
    assert.notEqual(result.head, pre.head);
  });

  it("refuses an unexpected HEAD", () => {
    const dir = repo(); const pre = gitPreflight(dir); const branch = createWorkflowBranch(dir, "demo");
    const state = { projectCwd: dir, branch: branch.branch, expectedHead: "0".repeat(40) };
    assert.equal(verifyWorkflowBranch(state).ok, false);
  });
});
