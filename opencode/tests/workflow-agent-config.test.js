import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(join(root, "opencode.json"), "utf8"));
const reviewerPrompt = readFileSync(join(root, "agents", "step-reviewer.md"), "utf8");
const plannerPrompt = readFileSync(join(root, "agents", "step-planner.md"), "utf8");
const orchestratorPrompt = readFileSync(join(root, "agents", "orchestrator.md"), "utf8");
const workflowOrchestratorPrompt = readFileSync(join(root, "agents", "workflow-orchestrator.md"), "utf8");
const stepOrchestratorPrompt = readFileSync(join(root, "agents", "step-orchestrator.md"), "utf8");
const explorePrompt = readFileSync(join(root, "agents", "explore.md"), "utf8");
const researchPrompt = readFileSync(join(root, "agents", "research.md"), "utf8");
const seeImageSource = readFileSync(join(root, "plugin", "see-image.js"), "utf8");

test("step-reviewer is hidden, read-only, and uses the workflow review model", () => {
  const reviewer = config.agent["step-reviewer"];
  assert.equal(reviewer.mode, "subagent");
  assert.equal(reviewer.hidden, true);
  assert.equal(reviewer.model, "llamaswap/qwen3-coder-large");
  assert.equal(reviewer.permission.edit, "deny");
  assert.equal(reviewer.permission.write, "deny");
  assert.equal(reviewer.permission.task, "deny");
  assert.equal(reviewer.permission.workflow_review, "allow");
  assert.equal(reviewer.permission.webfetch, "allow");
  assert.equal(reviewer.permission.mcp, "allow");
  assert.equal(reviewer.permission.external_directory, "allow");
});

test("step-reviewer bash permissions deny destructive commands", () => {
  const bash = config.agent["step-reviewer"].permission.bash;
  assert.deepEqual(Object.keys(bash), ["*", "rm *", "rmdir *", "mv *", "cp *", "dd *", "install *", "truncate *"]);
  assert.deepEqual(bash, {
    "*": "allow",
    "rm *": "deny",
    "rmdir *": "deny",
    "mv *": "deny",
    "cp *": "deny",
    "dd *": "deny",
    "install *": "deny",
    "truncate *": "deny",
  });
  assert.match(reviewerPrompt, /Use CodeGraph for structural questions/);
  assert.match(reviewerPrompt, /VERDICT: PASS/);
  assert.match(reviewerPrompt, /VERDICT: FAIL/);
  assert.match(reviewerPrompt, /workflow_review/);
});

test("step-planner requires review and allows one corrective pass", () => {
  assert.match(plannerPrompt, /Dispatch \*\*one `step-reviewer` task\*\*/);
  assert.match(plannerPrompt, /Do not perform more than one corrective implementation pass/);
  assert.match(plannerPrompt, /STEP REVIEW: PASS/);
  assert.match(plannerPrompt, /STEP REVIEW: FAIL/);
  assert.match(plannerPrompt, /corrective \*\*`research`\*\* tasks/);
  assert.match(plannerPrompt, /only completed direct `research` child sessions count/);
});

test("workflow subagents cannot ask users or call workflow phase tools", () => {
  for (const name of ["explore", "step-planner", "step-reviewer", "step-orchestrator"]) {
    const permission = config.agent[name].permission;
    assert.equal(permission.question, "deny", `${name} question`);
    for (const tool of ["workflow_control", "workflow_verify", "workflow_commit", "workflow_handoff"]) {
      assert.equal(permission[tool], "deny", `${name} ${tool}`);
    }
  }
  assert.match(reviewerPrompt, /must never ask the user a question/);
  assert.match(reviewerPrompt, /return `VERDICT: FAIL`/);
});

test("explore is hidden and read-only while research owns Context7", () => {
  const explore = config.agent.explore;
  assert.equal(explore.mode, "subagent");
  assert.equal(explore.hidden, true);
  assert.equal(explore.model, "llamaswap/fastcontext-4b");
  assert.equal(explore.steps, 512);
  assert.equal(explore.temperature, 0);
  assert.equal(explore.top_p, 0.8);
  assert.equal(explore.permission["*"], "deny");
  for (const tool of ["read", "glob", "grep", "list"]) {
    assert.equal(explore.permission[tool], "allow", `${tool} should be allowed`);
  }
  for (const tool of [
    "edit", "write", "bash", "task", "webfetch", "websearch", "todowrite",
    "lsp", "skill", "external_directory", "question", "doom_loop", "mcp",
    "workflow_control", "workflow_verify", "workflow_commit", "workflow_handoff",
    "workflow_create",
  ]) {
    assert.equal(explore.permission[tool], "deny", `${tool} should be denied`);
  }
  assert.match(explorePrompt, /steps: 512/);
  assert.match(explorePrompt, /temperature: 0/);
  assert.match(explorePrompt, /top_p: 0\.8/);
  assert.match(explorePrompt, /Maximum 2 search rounds/);
  assert.match(explorePrompt, /Maximum 8 tool calls total/);
  assert.match(explorePrompt, /exactly 2 tool-using responses/);
  assert.match(explorePrompt, /Maximum 5 files in the final answer/);
  assert.match(explorePrompt, /Do not read the same file twice unless/);
  assert.match(explorePrompt, /Return only this format/);
  assert.match(researchPrompt, /name: research/);
  assert.match(researchPrompt, /mode: subagent/);
  assert.match(researchPrompt, /mcp: allow/);
  assert.match(researchPrompt, /resolve-library-id/);
  assert.match(researchPrompt, /query-docs/);
});

test("workflow phase tools are isolated to workflow-orchestrator", () => {
  const orchestrator = config.agent.orchestrator;
  const workflowOrchestrator = config.agent["workflow-orchestrator"];
  assert.equal(config.permission.workflow_create, "deny");
  for (const tool of ["workflow_control", "workflow_verify", "workflow_commit", "workflow_handoff", "workflow_create"]) {
    assert.equal(orchestrator.permission[tool], "deny");
    assert.match(orchestratorPrompt, new RegExp(`${tool}: deny`));
    assert.equal(workflowOrchestrator.permission[tool], "allow");
    assert.match(workflowOrchestratorPrompt, new RegExp(`${tool}: allow`));
  }
  assert.match(orchestratorPrompt, /purely exploratory request/);
  assert.match(orchestratorPrompt, /delegate to `explore` instead of a domain implementation agent/);
  assert.match(orchestratorPrompt, /dispatch one focused `explore` task per area in parallel/);
  assert.match(orchestratorPrompt, /candidate context, not final truth/);
  assert.match(orchestratorPrompt, /must verify important files itself before editing/);
  assert.match(orchestratorPrompt, /Do not use `explore` for edits, command execution, validation/);
  assert.match(workflowOrchestratorPrompt, /Use `explore` only for a focused repository-location query/);
  assert.match(plannerPrompt, /Treat its paths and\s+line ranges as candidate/);
});

test("orchestrator agents can use see_image and the bridge prefers Qwen3-VL", () => {
  for (const name of ["orchestrator", "workflow-orchestrator", "step-orchestrator"]) {
    assert.equal(config.agent[name].permission.see_image, "allow", `${name} see_image`);
  }

  assert.match(orchestratorPrompt, /see_image: allow/);
  assert.match(workflowOrchestratorPrompt, /see_image: allow/);
  assert.match(stepOrchestratorPrompt, /see_image: allow/);
  assert.match(orchestratorPrompt, /call the \*\*`see_image` tool\*\* immediately/);
  assert.match(workflowOrchestratorPrompt, /call `see_image` immediately/);
  assert.match(stepOrchestratorPrompt, /call[\s\S]*see_image[\s\S]*immediately/);
  assert.match(seeImageSource, /const PRIMARY_MODEL\s+=\s+"keye-vl"/);
  assert.match(seeImageSource, /const FALLBACK_MODEL\s+=\s+"gemma3-vl-cpu"/);
  assert.match(seeImageSource, /Qwen3-VL primary → gemma3-vl-cpu CPU fallback/);
});
