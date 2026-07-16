/** Pure parsing, persistence, locking, verification, and Git helpers for /workflow. */
import {
  chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync,
  realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";

export const SCHEMA_VERSION = 6;
export const MAX_AUDIT_EVENTS = 500;
export const DEFAULT_MAX_STAGE_TURNS = 80;
export const DEFAULT_MAX_TOTAL_TURNS = 800;

let storageRoot = join(homedir(), ".local", "state", "opencode");
export function setStorageRoot(root) { storageRoot = resolve(root); }
export function getStateDir() { return join(storageRoot, "workflow"); }
export function getLockDir() { return join(storageRoot, "locks"); }

export function elapsed(startedAt) {
  const seconds = Math.floor((Date.now() - (startedAt ?? Date.now())) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function normalizeStage(raw) { return raw.replace(/^0+(?=\d)/, "") || raw; }
function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/** Strict schema: Stage heading, TODO body, Context7 line, verification lines, one gate. */
export function parseWorkflowDoc(content, filePath = "<inline>") {
  const lines = content.split(/\r?\n/);
  const todos = [];
  const stages = {};
  const errors = [];
  let currentStage = null;

  for (let i = 0; i < lines.length;) {
    const heading = lines[i].match(/^##\s+Stage\s+(\d+)\s*[-–—]\s*(.+?)\s*$/i);
    if (heading) {
      const id = normalizeStage(heading[1]);
      if (stages[id]) errors.push(`${filePath}:${i + 1}: duplicate stage ${heading[1]}`);
      stages[id] ??= { id, displayId: heading[1], title: heading[2].trim(), gate: null, file: filePath };
      currentStage = id;
      i++;
      continue;
    }

    const gate = lines[i].match(/^\s*-\s+Stage gate:\s+`([^`]+)`\s*$/i);
    if (gate) {
      if (!currentStage) errors.push(`${filePath}:${i + 1}: stage gate outside a stage`);
      else if (stages[currentStage].gate) errors.push(`${filePath}:${i + 1}: duplicate gate for stage ${currentStage}`);
      else stages[currentStage].gate = gate[1].trim();
      i++;
      continue;
    }

    const todoMatch = lines[i].match(/^(\s*)-\s*\[([ xX])\]\s*\*\*(\d+(?:\.\d+)+)\s+(.+?)\*\*\s*$/);
    if (!todoMatch) { i++; continue; }
    if (!currentStage) {
      errors.push(`${filePath}:${i + 1}: TODO ${todoMatch[3]} outside a stage`);
      i++;
      continue;
    }

    const indent = todoMatch[1].length;
    const bodyLines = [];
    const verify = [];
    const manual = [];
    let context7 = null;
    const startLine = i + 1;
    i++;
    while (i < lines.length) {
      if (/^##\s+Stage\s+/i.test(lines[i])) break;
      if (/^\s*-\s+Stage gate:/i.test(lines[i])) break;
      if (/^\s*-\s*\[[ xX]\]\s*\*\*/.test(lines[i]) && (lines[i].match(/^\s*/)?.[0].length ?? 0) <= indent) break;
      const context = lines[i].match(/^\s+-\s+Context7:\s*(required|not-applicable)\s*$/i);
      const command = lines[i].match(/^\s+-\s+Verify:\s+`([^`]+)`\s*$/i);
      const manualCheck = lines[i].match(/^\s+-\s+Verify manual:\s*(.+?)\s*$/i);
      if (context) context7 = context[1].toLowerCase();
      else if (command) verify.push(command[1].trim());
      else if (manualCheck) manual.push(manualCheck[1].trim());
      else if (lines[i].trim()) bodyLines.push(lines[i].trim());
      i++;
    }

    const id = todoMatch[3];
    const idStage = normalizeStage(id.split(".")[0]);
    if (idStage !== currentStage) errors.push(`${filePath}:${startLine}: TODO ${id} does not match stage ${currentStage}`);
    if (context7 === null) errors.push(`${filePath}:${startLine}: TODO ${id} is missing Context7 metadata`);
    if (verify.length === 0 && manual.length === 0) errors.push(`${filePath}:${startLine}: TODO ${id} has no verification`);
    todos.push({
      id, file: filePath, line: startLine, title: todoMatch[4].trim(), body: bodyLines.join("\n"),
      verify, manual, context7: context7 ?? "missing", stage: idStage,
      done: todoMatch[2].toLowerCase() === "x", skipped: false,
    });
  }
  return { todos, stages, errors };
}

export function parseWorkflowPath(sourcePath) {
  const canonical = realpathSync(sourcePath);
  const stat = statSync(canonical);
  const files = stat.isDirectory()
    ? readdirSync(canonical, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /^\d\d-.*\.md$/.test(entry.name) && !entry.name.endsWith("-evidence.md"))
        .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
        .map((entry) => join(canonical, entry.name))
    : [canonical];
  const result = { sourcePath: canonical, isDir: stat.isDirectory(), files, todos: [], stages: {}, errors: [] };
  for (const file of files) {
    const parsed = parseWorkflowDoc(readFileSync(file, "utf8"), file);
    result.todos.push(...parsed.todos);
    for (const [id, stage] of Object.entries(parsed.stages)) {
      if (result.stages[id]) result.errors.push(`${file}: duplicate stage ${id} across workflow files`);
      else result.stages[id] = stage;
    }
    result.errors.push(...parsed.errors);
  }
  const ids = new Set();
  for (const todo of result.todos) {
    if (ids.has(todo.id)) result.errors.push(`duplicate TODO ${todo.id}`);
    ids.add(todo.id);
  }
  const orderedStages = Object.keys(result.stages).sort((a, b) => Number(a) - Number(b));
  for (const stageId of orderedStages) {
    const stage = result.stages[stageId];
    const stageTodos = result.todos.filter((todo) => todo.stage === stageId);
    if (stageTodos.length === 0) result.errors.push(`stage ${stageId} has no TODOs`);
    if (!stage.gate) result.errors.push(`stage ${stageId} has no Stage gate`);
  }
  if (result.todos.length === 0) result.errors.push("workflow contains no TODOs");
  result.requiredTurns = result.todos.filter((todo) => !todo.done).length + orderedStages.length * 3;
  return result;
}

export function validateWorkflow(sourcePath, limits = {}) {
  try {
    const parsed = parseWorkflowPath(sourcePath);
    const maxStageTurns = limits.maxStageTurns ?? DEFAULT_MAX_STAGE_TURNS;
    const maxTotalTurns = limits.maxTotalTurns ?? DEFAULT_MAX_TOTAL_TURNS;
    for (const stageId of Object.keys(parsed.stages)) {
      const needed = parsed.todos.filter((todo) => todo.stage === stageId && !todo.done).length + 3;
      if (needed > maxStageTurns) parsed.errors.push(`stage ${stageId} needs at least ${needed} turns; limit is ${maxStageTurns}`);
    }
    if (parsed.requiredTurns > maxTotalTurns) parsed.errors.push(`workflow needs at least ${parsed.requiredTurns} turns; limit is ${maxTotalTurns}`);
    return { ok: parsed.errors.length === 0, ...parsed, maxStageTurns, maxTotalTurns };
  } catch (error) {
    return { ok: false, errors: [error.message], todos: [], stages: {}, files: [], requiredTurns: 0 };
  }
}

function safeWorkflowFilePath(value) {
  if (typeof value !== "string" || !value.trim() || isAbsolute(value) || value.includes("\\")) return null;
  if (value.split("/").includes("..")) return null;
  const normalized = normalize(value);
  if (normalized === "." || normalized === ".." || normalized.startsWith(`..${sep}`) || !normalized.endsWith(".md")) return null;
  return normalized;
}

/** Create a new, validated workflow directory without exposing partial output. */
export function createWorkflowDirectory(destination, files) {
  if (!Array.isArray(files) || files.length === 0) throw new Error("workflow files are required");
  const target = resolve(destination);
  if (existsSync(target)) throw new Error("destination already exists");
  const parent = dirname(target);
  if (!existsSync(parent) || !statSync(parent).isDirectory()) throw new Error("destination parent directory does not exist");
  const canonicalParent = realpathSync(parent);
  if (canonicalParent !== parent) throw new Error("destination parent must not contain symlinks");

  const entries = [];
  const seen = new Set();
  for (const file of files) {
    const relativePath = safeWorkflowFilePath(file?.path);
    if (!relativePath) throw new Error(`unsafe workflow file path: ${file?.path ?? "<missing>"}`);
    if (seen.has(relativePath)) throw new Error(`duplicate workflow file path: ${relativePath}`);
    if (typeof file.content !== "string") throw new Error(`workflow file content must be text: ${relativePath}`);
    seen.add(relativePath);
    entries.push({ path: relativePath, content: file.content });
  }
  if (!seen.has("00-context.md")) throw new Error("workflow requires 00-context.md");
  if (!entries.some((entry) => /^\d\d-.+\.md$/.test(entry.path) && entry.path !== "00-context.md")) {
    throw new Error("workflow requires at least one numbered stage file");
  }

  const staging = join(canonicalParent, `.${basename(target)}.workflow-create-${randomUUID()}`);
  mkdirSync(staging, { mode: 0o700 });
  try {
    for (const entry of entries) {
      const output = join(staging, entry.path);
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, entry.content, { encoding: "utf8", flag: "wx" });
    }
    const validation = validateWorkflow(staging);
    if (!validation.ok) return { ok: false, errors: validation.errors };
    renameSync(staging, target);
    return {
      ok: true, path: target, files: entries.length,
      todos: validation.todos.length, stages: Object.keys(validation.stages).length,
      requiredTurns: validation.requiredTurns,
    };
  } finally {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  }
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

function normalizedDefinition(parsed) {
  return {
    files: parsed.files.map((file) => realpathSync(file)).sort(),
    todos: parsed.todos.map(({ id, title, body, verify, manual, context7, stage, file }) => ({
      id, title, body, verify, manual, context7, stage, file: realpathSync(file),
    })),
    stages: Object.fromEntries(Object.entries(parsed.stages).map(([id, stage]) => [id, {
      id, displayId: stage.displayId, title: stage.title, gate: stage.gate, file: realpathSync(stage.file),
    }])),
  };
}

function normalizedSemanticDefinition(parsed) {
  const definition = normalizedDefinition(parsed);
  return {
    todos: definition.todos.map(({ file: _file, ...todo }) => todo),
    stages: Object.fromEntries(Object.entries(definition.stages).map(([id, { file: _file, ...stage }]) => [id, stage])),
  };
}

export function snapshotWorkflowSource(sourcePath) {
  const parsed = parseWorkflowPath(sourcePath);
  return {
    files: parsed.files.map((file) => ({ path: realpathSync(file), sha256: sha256(readFileSync(file)) })),
    definitionHash: sha256(JSON.stringify(normalizedDefinition(parsed))),
  };
}

export function compareWorkflowSource(state) {
  if (!state.sourceSnapshot) return { ok: false, reason: "workflow has no source snapshot", changed: [] };
  try {
    const current = snapshotWorkflowSource(state.sourcePath);
    const expected = new Map(state.sourceSnapshot.files.map((entry) => [entry.path, entry.sha256]));
    const actual = new Map(current.files.map((entry) => [entry.path, entry.sha256]));
    const changed = [...new Set([...expected.keys(), ...actual.keys()])]
      .filter((path) => expected.get(path) !== actual.get(path));
    return changed.length
      ? { ok: false, reason: `workflow source changed: ${changed.join(", ")}`, changed, current }
      : { ok: true, changed: [], current };
  } catch (error) {
    return { ok: false, reason: `workflow source unavailable: ${error.message}`, changed: [] };
  }
}

export function refreshWorkflowSourceSnapshot(state) {
  state.sourceSnapshot = snapshotWorkflowSource(state.sourcePath);
  return state.sourceSnapshot;
}

export function appendWorkflowEvent(state, type, details = {}) {
  state.auditEvents ??= [];
  const sequence = (state.auditEvents.at(-1)?.sequence ?? 0) + 1;
  state.auditEvents.push({ sequence, at: Date.now(), type, phase: state.phase ?? null,
    stage: state.stage ?? null, todo: state.todos?.[state.cursor]?.id ?? null, details });
  if (state.auditEvents.length > MAX_AUDIT_EVENTS) state.auditEvents.splice(0, state.auditEvents.length - MAX_AUDIT_EVENTS);
  return state.auditEvents.at(-1);
}

export function checkTodoInSource(todo) {
  const content = readFileSync(todo.file, "utf8");
  const pattern = new RegExp(`(^\\s*-\\s*)\\[ \\](\\s*\\*\\*${escapeRegex(todo.id)}\\s+${escapeRegex(todo.title)}\\*\\*)`, "m");
  const updated = content.replace(pattern, "$1[x]$2");
  if (updated === content) return false;
  writeFileSync(todo.file, updated, "utf8");
  return true;
}

export function uncheckTodoInSource(todo) {
  const content = readFileSync(todo.file, "utf8");
  const pattern = new RegExp(`(^\\s*-\\s*)\\[x\\](\\s*\\*\\*${escapeRegex(todo.id)}\\s+${escapeRegex(todo.title)}\\*\\*)`, "mi");
  const updated = content.replace(pattern, "$1[ ]$2");
  if (updated === content) return false;
  writeFileSync(todo.file, updated, "utf8");
  return true;
}

export function uncheckTodosInSource(todos) {
  const updates = new Map();
  for (const todo of todos) {
    const content = updates.get(todo.file) ?? readFileSync(todo.file, "utf8");
    const pattern = new RegExp(`(^\\s*-\\s*)\\[x\\](\\s*\\*\\*${escapeRegex(todo.id)}\\s+${escapeRegex(todo.title)}\\*\\*)`, "mi");
    const updated = content.replace(pattern, "$1[ ]$2");
    if (updated === content) return { ok: false, todo: todo.id };
    updates.set(todo.file, updated);
  }
  for (const [file, content] of updates) writeFileSync(file, content, "utf8");
  return { ok: true };
}

export function runCommand(command, cwd, timeoutMs = 300_000) {
  const result = spawnSync("sh", ["-c", command], { cwd, timeout: timeoutMs, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return {
    command, exit: result.status ?? -1, passed: result.status === 0 && !result.error,
    stdout: String(result.stdout ?? "").slice(-4000), stderr: String(result.stderr ?? "").slice(-4000),
    error: result.error?.message ?? null, at: Date.now(),
  };
}

function statePath(id) { return join(getStateDir(), `workflow-${id}.json`); }
function lockPath(id) { return join(getLockDir(), `workflow-${id}.lock`); }

export function workflowIdFromPath(sourcePath) {
  const canonical = realpathSync(sourcePath);
  const slug = basename(canonical).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-|-$/g, "") || "workflow";
  return `${slug}-${createHash("sha256").update(canonical).digest("hex").slice(0, 12)}`;
}

export function saveWorkflow(state) {
  mkdirSync(getStateDir(), { recursive: true });
  const target = statePath(state.id);
  const tmp = `${target}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeFileSync(fd, JSON.stringify({ ...state, updatedAt: Date.now() }, null, 2), "utf8");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(tmp, target);
}

function migrationBackupPath(id, version) { return `${statePath(id)}.schema-v${version}.bak`; }

function migrateV1ToV2(state) {
  const parsed = parseWorkflowPath(state.sourcePath);
  const previous = new Map((state.todos ?? []).map((todo) => [todo.id, todo]));
  for (const todo of parsed.todos) {
    const old = previous.get(todo.id);
    if (old) { todo.done = Boolean(old.done || todo.done); todo.skipped = Boolean(old.skipped); }
  }
  const stages = Object.fromEntries(Object.entries(parsed.stages).map(([id, stage]) => [id, {
    ...stage, gate: state.gates?.[id] ?? stage.gate, title: state.stageTitles?.[id] ?? stage.title,
  }]));
  return {
    ...state, schemaVersion: 2, todos: parsed.todos, stages,
    phase: state.todoPhase === "executing" ? "todo_execute" : "stage_plan",
    stagePlans: {}, todoEvidence: {}, gateEvidence: null, commitEvidence: null,
    manualEvidence: [], context7Evidence: { resolved: false, queried: false }, skipReasons: {},
    noConfirm: false, baseBranch: null, baseHead: null, branch: null, expectedHead: null,
    status: ["completed", "completed_with_skips"].includes(state.status) ? state.status : "stopped",
    blocker: ["completed", "completed_with_skips"].includes(state.status) ? state.blocker : {
      reason: "migrated from v1; Git and verification state cannot be recovered safely", at: Date.now(),
    },
  };
}

function migrateV2ToV3(state) {
  let sourceSnapshot = null;
  let mismatch = null;
  try {
    const parsed = parseWorkflowPath(state.sourcePath);
    sourceSnapshot = snapshotWorkflowSource(state.sourcePath);
    const storedDefinition = normalizedSemanticDefinition({
      files: [...new Set((state.todos ?? []).map((todo) => todo.file))],
      todos: state.todos ?? [], stages: state.stages ?? {},
    });
    const currentDefinition = normalizedSemanticDefinition(parsed);
    if (sha256(JSON.stringify(storedDefinition)) !== sha256(JSON.stringify(currentDefinition))) mismatch = "workflow definition changed before schema migration";
  } catch (error) { mismatch = `workflow source unavailable during migration: ${error.message}`; }
  const migrated = { ...state, schemaVersion: 3, sourceSnapshot, auditEvents: state.auditEvents ?? [] };
  appendWorkflowEvent(migrated, "state.migrated", { from: 2, to: 3 });
  if (mismatch && !["completed", "completed_with_skips"].includes(migrated.status)) {
    migrated.status = "blocked";
    migrated.blocker = { reason: `${mismatch}; restart required`, at: Date.now() };
    appendWorkflowEvent(migrated, "workflow.blocked", { reason: migrated.blocker.reason });
  }
  return migrated;
}

function migrateV3ToV4(state) {
  const migrated = { ...state, schemaVersion: 4,
    pauseRequest: state.pauseRequest ?? null, pausedCheckpoint: state.pausedCheckpoint ?? null };
  appendWorkflowEvent(migrated, "state.migrated", { from: 3, to: 4 });
  return migrated;
}

function migrateV4ToV5(state) {
  const migrated = { ...state, schemaVersion: 5,
    stageHandoffs: state.stageHandoffs ?? {}, stageCompaction: state.stageCompaction ?? null,
    stageTransition: state.stageTransition ?? null };
  appendWorkflowEvent(migrated, "state.migrated", { from: 4, to: 5 });
  return migrated;
}

function migrateV5ToV6(state) {
  const now = Date.now();
  const migrated = { ...state, schemaVersion: 6,
    reporting: state.reporting ?? {
      stageStartedAt: now, todoStartedAt: now, todos: {}, stages: {},
    } };
  appendWorkflowEvent(migrated, "state.migrated", { from: 5, to: 6 });
  return migrated;
}

export function migrateWorkflowState(state) {
  if (!state || !Number.isInteger(state.schemaVersion)) throw new Error("workflow state has no schemaVersion");
  if (state.schemaVersion > SCHEMA_VERSION) throw new Error(`workflow schema v${state.schemaVersion} is newer than supported v${SCHEMA_VERSION}`);
  let migrated = state;
  while (migrated.schemaVersion < SCHEMA_VERSION) {
    if (migrated.schemaVersion === 1) migrated = migrateV1ToV2(migrated);
    else if (migrated.schemaVersion === 2) migrated = migrateV2ToV3(migrated);
    else if (migrated.schemaVersion === 3) migrated = migrateV3ToV4(migrated);
    else if (migrated.schemaVersion === 4) migrated = migrateV4ToV5(migrated);
    else if (migrated.schemaVersion === 5) migrated = migrateV5ToV6(migrated);
    else throw new Error(`no migration from workflow schema v${migrated.schemaVersion}`);
  }
  return migrated;
}

export function loadWorkflow(id) {
  for (const path of [statePath(id), `${statePath(id)}.tmp`]) {
    if (!existsSync(path)) continue;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8"));
      if (raw.schemaVersion === SCHEMA_VERSION) return raw;
      try {
        const backup = migrationBackupPath(id, raw.schemaVersion ?? "unknown");
        if (!existsSync(backup)) { copyFileSync(path, backup); chmodSync(backup, 0o600); }
        const migrated = migrateWorkflowState(raw);
        saveWorkflow(migrated);
        return migrated;
      } catch (error) { return { ...raw, migrationError: error.message }; }
    } catch { /* fail closed */ }
  }
  return null;
}

export function listWorkflows() {
  if (!existsSync(getStateDir())) return [];
  return readdirSync(getStateDir()).filter((name) => /^workflow-.*\.json$/.test(name)).map((name) => {
    const id = name.slice("workflow-".length, -".json".length);
    return loadWorkflow(id);
  }).filter(Boolean).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

export function deleteWorkflow(id) {
  rmSync(statePath(id), { force: true });
  rmSync(`${statePath(id)}.tmp`, { force: true });
}

export function archiveWorkflowState(id, label = "recovered") {
  const source = statePath(id);
  if (!existsSync(source)) return null;
  const target = `${source}.${label}-${Date.now()}.bak`;
  copyFileSync(source, target);
  chmodSync(target, 0o600);
  return target;
}

export function acquireLock(id, sessionID, options = {}) {
  mkdirSync(getLockDir(), { recursive: true });
  const path = lockPath(id);
  if (existsSync(path)) {
    try {
      const current = JSON.parse(readFileSync(path, "utf8"));
      let alive = false;
      try { process.kill(current.pid, 0); alive = true; } catch { /* stale */ }
      if (alive && current.sessionID !== sessionID && !options.takePaused) return false;
      unlinkSync(path);
    } catch { rmSync(path, { force: true }); }
  }
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify({ pid: process.pid, sessionID, at: Date.now() })); }
  finally { closeSync(fd); }
  return true;
}

export function releaseLock(id) { rmSync(lockPath(id), { force: true }); }

export function inspectLock(id) {
  const path = lockPath(id);
  if (!existsSync(path)) return { exists: false, alive: false };
  try {
    const lock = JSON.parse(readFileSync(path, "utf8"));
    let alive = false;
    try { process.kill(lock.pid, 0); alive = true; } catch { /* stale */ }
    return { exists: true, alive, ...lock };
  } catch (error) { return { exists: true, alive: false, error: error.message }; }
}

export function git(args, cwd) { return spawnSync("git", args, { cwd, encoding: "utf8" }); }
export function gitPreflight(cwd) {
  const root = git(["rev-parse", "--show-toplevel"], cwd);
  if (root.status !== 0) return { ok: false, reason: "not a Git repository" };
  const projectRoot = root.stdout.trim();
  const status = git(["status", "--porcelain"], projectRoot);
  if (status.status !== 0) return { ok: false, reason: status.stderr.trim() };
  if (status.stdout.trim()) return { ok: false, reason: "worktree must be clean before workflow start" };
  const head = git(["rev-parse", "HEAD"], projectRoot);
  if (head.status !== 0) return { ok: false, reason: "repository has no initial commit" };
  const branch = git(["branch", "--show-current"], projectRoot).stdout.trim();
  return { ok: true, root: projectRoot, head: head.stdout.trim(), branch };
}

export function createWorkflowBranch(root, id) {
  const branch = `workflow/${id}`;
  const exists = git(["show-ref", "--verify", `refs/heads/${branch}`], root).status === 0;
  if (exists) return { ok: false, reason: `branch ${branch} already exists` };
  const result = git(["switch", "-c", branch], root);
  return result.status === 0 ? { ok: true, branch } : { ok: false, reason: result.stderr.trim() };
}

export function verifyWorkflowBranch(state) {
  const branch = git(["branch", "--show-current"], state.projectCwd);
  if (branch.status !== 0 || branch.stdout.trim() !== state.branch) return { ok: false, reason: `expected branch ${state.branch}` };
  const head = git(["rev-parse", "HEAD"], state.projectCwd);
  if (head.status !== 0 || head.stdout.trim() !== state.expectedHead) return { ok: false, reason: "workflow branch HEAD changed unexpectedly" };
  return { ok: true };
}

export function createTodoCheckpointCommit(state, todo) {
  const branchCheck = verifyWorkflowBranch(state);
  if (!branchCheck.ok) return branchCheck;
  const status = git(["status", "--porcelain"], state.projectCwd);
  if (!status.stdout.trim()) return { ok: true, skipped: true };
  const add = git(["add", "-A"], state.projectCwd);
  if (add.status !== 0) return { ok: false, reason: add.stderr.trim() };
  const commit = git(["commit", "-m", `workflow-todo(${todo.id}): ${todo.title}`, "-m", "Co-Authored-By: workflow-plugin <noreply@opencode>"], state.projectCwd);
  if (commit.status !== 0) return { ok: false, reason: commit.stderr.trim() };
  const head = git(["rev-parse", "HEAD"], state.projectCwd).stdout.trim();
  return { ok: true, skipped: false, sha: head.slice(0, 12), head };
}

export function createStageCommit(state, stage) {
  const branchCheck = verifyWorkflowBranch(state);
  if (!branchCheck.ok) return branchCheck;
  const status = git(["status", "--porcelain"], state.projectCwd);
  if (!status.stdout.trim()) {
    // When per-todo commits are enabled, the stage's changes are already committed;
    // always create an empty stage marker so recovery and rewind stay intact.
    if (!state.perTodoCommits) return { ok: false, reason: "nothing to commit" };
  } else {
    const add = git(["add", "-A"], state.projectCwd);
    if (add.status !== 0) return { ok: false, reason: add.stderr.trim() };
  }
  const title = state.stages[stage]?.title ?? `Stage ${stage}`;
  const commitArgs = ["commit", ...(state.perTodoCommits ? ["--allow-empty"] : []),
    "-m", `workflow(${stage}): ${title}`, "-m", "Co-Authored-By: workflow-plugin <noreply@opencode>"];
  const commit = git(commitArgs, state.projectCwd);
  if (commit.status !== 0) return { ok: false, reason: commit.stderr.trim() };
  const head = git(["rev-parse", "HEAD"], state.projectCwd).stdout.trim();
  return { ok: true, sha: head.slice(0, 12), head };
}

export function workflowStageFacts(state, stage, commitHead = state.expectedHead) {
  // When per-todo commits are active, the stage marker commit is empty; diff
  // the full range from the previous stage commit (or base) to the current HEAD.
  let changed;
  if (state.perTodoCommits) {
    const prevHead = state.commits.at(-1)?.head ?? state.baseHead;
    changed = prevHead
      ? git(["diff", "--name-only", prevHead, commitHead], state.projectCwd)
      : git(["diff-tree", "--no-commit-id", "--name-only", "-r", commitHead], state.projectCwd);
  } else {
    changed = git(["diff-tree", "--no-commit-id", "--name-only", "-r", commitHead], state.projectCwd);
  }
  const todos = state.todos.filter((todo) => todo.stage === stage);
  return {
    stage,
    title: state.stages[stage]?.title ?? `Stage ${stage}`,
    commit: commitHead,
    changedFiles: changed.status === 0 ? changed.stdout.split("\n").map((line) => line.trim()).filter(Boolean) : [],
    completedTodos: todos.filter((todo) => todo.done).map((todo) => todo.id),
    skippedTodos: todos.filter((todo) => todo.skipped).map((todo) => ({ id: todo.id, reason: state.skipReasons?.[todo.id] ?? "unspecified" })),
    gate: state.gateEvidence ? { command: state.gateEvidence.command, passed: state.gateEvidence.passed,
      exit: state.gateEvidence.exit, at: state.gateEvidence.at } : null,
  };
}

function gitText(args, cwd) {
  const result = git(args, cwd);
  return { ok: result.status === 0, stdout: String(result.stdout ?? "").trim(), stderr: String(result.stderr ?? "").trim() };
}

function shellQuote(value) { return `'${String(value).replaceAll("'", `'"'"'`)}'`; }

export function workflowGitDiagnostics(state) {
  const root = gitText(["rev-parse", "--show-toplevel"], state.projectCwd);
  if (!root.ok) return { ok: false, errors: ["project directory is not a Git repository"] };
  const currentBranch = gitText(["branch", "--show-current"], root.stdout).stdout;
  const head = gitText(["rev-parse", "HEAD"], root.stdout).stdout;
  const dirty = Boolean(gitText(["status", "--porcelain"], root.stdout).stdout);
  const branchExists = state.branch ? gitText(["show-ref", "--verify", `refs/heads/${state.branch}`], root.stdout).ok : false;
  const baseExists = state.baseBranch ? gitText(["show-ref", "--verify", `refs/heads/${state.baseBranch}`], root.stdout).ok : false;
  const errors = [];
  if (state.branch && !branchExists) errors.push(`workflow branch ${state.branch} is missing`);
  if (state.baseBranch && !baseExists) errors.push(`base branch ${state.baseBranch} is missing`);
  if (state.branch && currentBranch !== state.branch) errors.push(`current branch is ${currentBranch || "detached HEAD"}; expected ${state.branch}`);
  if (state.expectedHead && head !== state.expectedHead) errors.push("current HEAD differs from expectedHead");
  return { ok: errors.length === 0, root: root.stdout, currentBranch, head, dirty, branchExists, baseExists, errors };
}

export function workflowFinishReport(state) {
  if (!["completed", "completed_with_skips"].includes(state.status)) return { ok: false, reason: `workflow is ${state.status}` };
  const diagnostics = workflowGitDiagnostics(state);
  if (!diagnostics.branchExists || !diagnostics.baseExists) return { ok: false, reason: diagnostics.errors.join("; ") || "workflow Git metadata is incomplete", diagnostics };
  if (!state.baseHead) return { ok: false, reason: "workflow has no recorded base HEAD", diagnostics };
  const ancestry = gitText(["merge-base", "--is-ancestor", state.baseHead, state.branch], state.projectCwd);
  if (!ancestry.ok) return { ok: false, reason: "workflow branch no longer descends from its recorded base", diagnostics };
  return { ok: true, diagnostics, baseBranch: state.baseBranch, branch: state.branch,
    commits: state.commits ?? [], skipped: state.skipReasons ?? {},
    commands: [`git switch ${shellQuote(state.baseBranch)}`, `git merge --ff-only ${shellQuote(state.branch)}`] };
}

export function analyzeWorkflowRecovery(sourcePath, cwd, options = {}) {
  const parsed = validateWorkflow(sourcePath);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  const root = gitText(["rev-parse", "--show-toplevel"], cwd);
  if (!root.ok) return { ok: false, errors: ["session directory is not a Git repository"] };
  const currentBranch = gitText(["branch", "--show-current"], root.stdout).stdout;
  const derivedId = workflowIdFromPath(parsed.sourcePath);
  const branches = gitText(["for-each-ref", "--format=%(refname:short)", "refs/heads"], root.stdout).stdout.split("\n").filter(Boolean);
  const branchCandidates = [...new Set([
    options.branch,
    branches.includes(`workflow/${derivedId}`) ? `workflow/${derivedId}` : null,
    currentBranch.startsWith("workflow/") ? currentBranch : null,
  ].filter(Boolean))];
  const branch = options.branch ?? (branchCandidates.length === 1 ? branchCandidates[0] : null);
  if (branch && !branches.includes(branch)) return { ok: false, errors: [`branch ${branch} does not exist`] };
  const nonWorkflow = branches.filter((name) => !name.startsWith("workflow/") && name !== branch);
  const baseCandidates = branch ? nonWorkflow.filter((name) => gitText(["merge-base", "--is-ancestor", name, branch], root.stdout).ok) : [];
  const baseBranch = options.baseBranch ?? (baseCandidates.length === 1 ? baseCandidates[0] : null);
  const errors = [];
  if (!branch) errors.push("workflow branch is ambiguous; pass --branch");
  if (branch && currentBranch !== branch) errors.push(`workflow branch ${branch} is not currently checked out`);
  if (!baseBranch) errors.push("base branch is ambiguous; pass --base");
  let baseHead = null;
  let head = null;
  let commits = [];
  if (branch) head = gitText(["rev-parse", branch], root.stdout).stdout;
  if (branch && baseBranch) {
    baseHead = gitText(["merge-base", baseBranch, branch], root.stdout).stdout;
    const log = gitText(["log", "--format=%H%x09%s", `${baseHead}..${branch}`], root.stdout).stdout;
    commits = log.split("\n").filter(Boolean).map((line) => {
      const [sha, ...subjectParts] = line.split("\t");
      const subject = subjectParts.join("\t");
      const match = subject.match(/^workflow\(([^)]+)\):\s*(.+)$/);
      if (!match) return null;
      const stage = normalizeStage(match[1]);
      if (!parsed.stages[stage] || parsed.stages[stage].title !== match[2]) return null;
      return { stage, sha: sha.slice(0, 12), head: sha, subject };
    }).filter(Boolean).reverse();
    for (const commit of commits) {
      if (parsed.todos.some((todo) => todo.stage === commit.stage && !todo.done)) {
        errors.push(`stage ${commit.stage} has a workflow commit but unchecked TODOs`);
      }
    }
  }
  return { ok: errors.length === 0, errors, id: derivedId, parsed, projectCwd: root.stdout,
    branch, baseBranch, baseHead, head, currentBranch, dirty: Boolean(gitText(["status", "--porcelain"], root.stdout).stdout),
    commits, branchCandidates, baseCandidates, sourceSnapshot: snapshotWorkflowSource(parsed.sourcePath) };
}
