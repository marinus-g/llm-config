import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setStorageRoot } from "../lib/workflow-core.js";
import { setDangerStorageRoot } from "../lib/danger-mode.js";

const root = mkdtempSync(join(tmpdir(), "workflow-help-test"));
const repo = join(root, "repo");
const stateRoot = join(root, "state");
let sessionDirectory = repo;

function git(args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

before(() => {
  setStorageRoot(stateRoot);
  setDangerStorageRoot(stateRoot);
  mkdirSync(repo);
  git(["init", "-b", "main"]);
  git(["config", "user.email", "workflow@example.invalid"]);
  git(["config", "user.name", "Workflow Test"]);
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

const client = {
  tui: { showToast: async () => {} },
  session: {
    get: async ({ path }) => ({ data: { directory: sessionDirectory } }),
  },
};

test("direct /workflow help returns general help text", async () => {
  const { server } = await import("../plugin/workflow.js");
  const hooks = await server({ client });
  const output = { parts: [] };
  await hooks["command.execute.before"]({
    command: "workflow",
    sessionID: "test-help-session",
    arguments: "help",
  }, output);
  assert.equal(output.parts.length, 1);
  assert.equal(output.parts[0].type, "text");
  assert.match(output.parts[0].text, /◈ \/workflow — staged project driver/);
  assert.match(output.parts[0].text, /Lifecycle/);
  assert.match(output.parts[0].text, /Control/);
  assert.match(output.parts[0].text, /State/);
  assert.match(output.parts[0].text, /Diagnostics/);
  assert.match(output.parts[0].text, /Other/);
});

test("workflow_control with action help returns help text", async () => {
  const { server } = await import("../plugin/workflow.js");
  const hooks = await server({ client });
  const result = await hooks.tool.workflow_control.execute({
    action: "help",
  }, { sessionID: "test-help-session-2", metadata() {} });
  assert.match(result, /◈ \/workflow — staged project driver/);
  assert.match(result, /Lifecycle/);
  assert.match(result, /Control/);
});

test("receipt dedup: command then tool produces matching help output", async () => {
  const { server } = await import("../plugin/workflow.js");
  const hooks = await server({ client });
  const sid = "test-help-dedup";

  // Direct command
  const direct = { parts: [] };
  await hooks["command.execute.before"]({
    command: "workflow",
    sessionID: sid,
    arguments: "help",
  }, direct);

  // Tool dispatch (should consume the receipt)
  const toolResult = await hooks.tool.workflow_control.execute({
    action: "help",
  }, { sessionID: sid, metadata() {} });

  assert.equal(toolResult, direct.parts.map(p => p.text).join("\n"));
});

test("direct /workflow help start returns subcommand detail", async () => {
  const { server } = await import("../plugin/workflow.js");
  const hooks = await server({ client });
  const output = { parts: [] };
  await hooks["command.execute.before"]({
    command: "workflow",
    sessionID: "test-help-sub",
    arguments: "help start",
  }, output);
  assert.equal(output.parts.length, 1);
  assert.match(output.parts[0].text, /\/workflow start/);
  assert.match(output.parts[0].text, /Start a workflow/);
});

test("workflow_control with subcommand returns subcommand detail", async () => {
  const { server } = await import("../plugin/workflow.js");
  const hooks = await server({ client });
  const result = await hooks.tool.workflow_control.execute({
    action: "help",
    subcommand: "start",
  }, { sessionID: "test-help-sub2", metadata() {} });
  assert.match(result, /\/workflow start/);
  assert.match(result, /Start a workflow/);
});

test("receipt dedup for subcommand help", async () => {
  const { server } = await import("../plugin/workflow.js");
  const hooks = await server({ client });
  const sid = "test-help-sub-dedup";

  const direct = { parts: [] };
  await hooks["command.execute.before"]({
    command: "workflow",
    sessionID: sid,
    arguments: "help start",
  }, direct);

  const toolResult = await hooks.tool.workflow_control.execute({
    action: "help",
    subcommand: "start",
  }, { sessionID: sid, metadata() {} });

  assert.equal(toolResult, direct.parts.map(p => p.text).join("\n"));
});

test("unknown subcommand returns error with valid list", async () => {
  const { server } = await import("../plugin/workflow.js");
  const hooks = await server({ client });
  const result = await hooks.tool.workflow_control.execute({
    action: "help",
    subcommand: "notreal",
  }, { sessionID: "test-help-unknown", metadata() {} });
  assert.match(result, /Unknown subcommand: notreal/);
  assert.match(result, /Valid commands/);
});

test("help works without an attached workflow", async () => {
  const { server } = await import("../plugin/workflow.js");
  const hooks = await server({ client });
  // No workflow started — help should still work
  const output = { parts: [] };
  await hooks["command.execute.before"]({
    command: "workflow",
    sessionID: "test-help-no-workflow",
    arguments: "help",
  }, output);
  assert.equal(output.parts.length, 1);
  assert.match(output.parts[0].text, /◈ \/workflow — staged project driver/);
});
