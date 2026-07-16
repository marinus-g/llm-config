import test from "node:test";
import assert from "node:assert/strict";
import { analyzeExecutionEvidence } from "../lib/workflow-execution-evidence.js";

function messages({ tools = [], text = "done", complete = true } = {}) {
  return [{ info: { role: "assistant" }, parts: [
    ...tools.map((tool) => ({ type: "tool", tool, state: { status: "completed" } })),
    { type: "text", text },
    ...(complete ? [{ type: "step-finish" }] : []),
  ] }];
}

function validTree(verdict = "VERDICT: PASS") {
  return { id: "parent", agent: "orchestrator", messages: messages(), children: [{
    id: "planner", agent: "step-planner", messages: messages(), children: [
      { id: "explore", agent: "explore", messages: messages({ tools: ["codegraph_context"] }), children: [] },
      { id: "implement", agent: "step-orchestrator", messages: messages(), children: [
        { id: "domain", agent: "general-dev", messages: messages({ tools: ["edit"] }), children: [] },
      ] },
      { id: "review", agent: "step-reviewer", messages: messages({ tools: ["read"], text: `${verdict}\nReviewed.` }), children: [] },
    ],
  }] };
}

function validContext7Tree() {
  const tree = validTree();
  tree.children[0].children[0] = {
    id: "research", agent: "research", messages: messages({
      tools: ["_upstash_context7-mcp_resolve-library-id", "_upstash_context7-mcp_query-docs"],
    }), children: [],
  };
  return tree;
}

test("accepts a completed workflow agent hierarchy with tool evidence", () => {
  const evidence = analyzeExecutionEvidence(validTree());
  assert.equal(evidence.ready, true);
  assert.equal(evidence.verdict, "VERDICT: PASS");
  assert.deepEqual(evidence.implementationAgentIDs, ["domain"]);
});

test("prefers a structured workflow_review verdict", () => {
  const tree = validTree("VERDICT: FAIL");
  tree.children[0].children[2].messages = messages({ tools: ["read"] });
  tree.children[0].children[2].messages[0].parts.splice(1, 0, {
    type: "tool", tool: "workflow_review",
    state: { status: "completed", input: { verdict: "PASS" } },
  });
  const evidence = analyzeExecutionEvidence(tree);
  assert.equal(evidence.ready, true);
  assert.equal(evidence.verdict, "VERDICT: PASS");
});

test("accepts narrowly wrapped legacy verdicts but rejects conflicting text", () => {
  const bold = analyzeExecutionEvidence(validTree("**VERDICT: PASS**"));
  assert.equal(bold.ready, true);
  assert.equal(bold.verdict, "VERDICT: PASS");

  const conflicting = analyzeExecutionEvidence(validTree("VERDICT: PASS\nVERDICT: FAIL"));
  assert.equal(conflicting.ready, false);
  assert.equal(conflicting.verdict, "");
});

test("workflow_review does not count as reviewer inspection", () => {
  const tree = validTree();
  tree.children[0].children[2].messages = messages({ tools: [] });
  tree.children[0].children[2].messages[0].parts.unshift({
    type: "tool", tool: "workflow_review",
    state: { status: "completed", input: { verdict: "PASS" } },
  });
  const evidence = analyzeExecutionEvidence(tree);
  assert.equal(evidence.ready, false);
  assert.match(evidence.missing.join("\n"), /inspection evidence/);
});

test("rejects a prose-only planner completion", () => {
  const tree = validTree();
  tree.children[0].children = [];
  const evidence = analyzeExecutionEvidence(tree);
  assert.equal(evidence.ready, false);
  assert.match(evidence.missing.join("\n"), /explore/);
  assert.match(evidence.missing.join("\n"), /step-orchestrator/);
  assert.match(evidence.missing.join("\n"), /step-reviewer/);
});

test("rejects missing tool activity and a failing reviewer", () => {
  const tree = validTree("VERDICT: FAIL");
  tree.children[0].children[0].messages = messages();
  tree.children[0].children[1].children[0].messages = messages();
  const evidence = analyzeExecutionEvidence(tree);
  assert.equal(evidence.ready, false);
  assert.match(evidence.missing.join("\n"), /tool evidence/);
  assert.match(evidence.missing.join("\n"), /VERDICT: FAIL/);
});

test("uses the latest reviewer verdict after a corrective pass", () => {
  const tree = validTree("VERDICT: PASS");
  tree.children[0].children.splice(2, 0,
    { id: "review-fail", agent: "step-reviewer", messages: messages({ tools: ["read"], text: "VERDICT: FAIL" }), children: [] },
    { id: "implement-fix", agent: "step-orchestrator", messages: messages(), children: [
      { id: "domain-fix", agent: "general-dev", messages: messages({ tools: ["edit"] }), children: [] },
    ] });
  const evidence = analyzeExecutionEvidence(tree);
  assert.equal(evidence.ready, true);
  assert.equal(evidence.reviewerID, "review");
});

test("succeeds when an earlier planner completed correctly and a later one errored", () => {
  const tree = validTree("VERDICT: PASS");
  // Give the valid planner a low timestamp so it is not the "latest"
  tree.children[0].createdAt = 1000;
  // Add a later errored planner with no children (simulates a session that crashed)
  tree.children.push({ id: "planner-errored", agent: "step-planner",
    createdAt: 2000, messages: [{ info: { role: "assistant" }, parts: [{ type: "text", text: "error" }] }], children: [] });
  const evidence = analyzeExecutionEvidence(tree);
  assert.equal(evidence.ready, true);
  assert.equal(evidence.plannerID, "planner");
});

test("requireImplementation:false accepts a planner→explore→reviewer tree without orchestrator/domain", () => {
  const tree = { id: "parent", agent: "orchestrator", messages: messages(), children: [{
    id: "planner", agent: "step-planner", messages: messages(), children: [
      { id: "explore", agent: "explore", messages: messages({ tools: ["resolve-library-id"] }), children: [] },
      { id: "review", agent: "step-reviewer", messages: messages({ tools: ["read"], text: "VERDICT: PASS\nEvidence recorded." }), children: [] },
    ],
  }] };
  const evidence = analyzeExecutionEvidence(tree, { requireImplementation: false });
  assert.equal(evidence.ready, true);
  assert.equal(evidence.verdict, "VERDICT: PASS");
  assert.deepEqual(evidence.orchestratorIDs, []);
});

test("requireImplementation:false still requires explore tool evidence and reviewer PASS", () => {
  const tree = { id: "parent", agent: "orchestrator", messages: messages(), children: [{
    id: "planner", agent: "step-planner", messages: messages(), children: [
      { id: "explore", agent: "explore", messages: messages(), children: [] }, // no tools
      { id: "review", agent: "step-reviewer", messages: messages({ tools: ["read"], text: "VERDICT: FAIL" }), children: [] },
    ],
  }] };
  const evidence = analyzeExecutionEvidence(tree, { requireImplementation: false });
  assert.equal(evidence.ready, false);
  assert.match(evidence.missing.join("\n"), /tool evidence/);
  assert.match(evidence.missing.join("\n"), /VERDICT: FAIL/);
  assert.ok(!evidence.missing.some((m) => m.includes("step-orchestrator")));
});

test("Context7 steps require completed resolve and docs-query tool evidence", () => {
  const tree = validContext7Tree();
  tree.children[0].children[0].messages = messages({ tools: [] });
  let evidence = analyzeExecutionEvidence(tree, { requireContext7: true });
  assert.equal(evidence.ready, false);
  assert.match(evidence.missing.join("\n"), /research task/);
  assert.match(evidence.missing.join("\n"), /resolve-library-id/);
  assert.match(evidence.missing.join("\n"), /query-docs/);

  tree.children[0].children[0].messages = messages({
    tools: ["_upstash_context7-mcp_resolve-library-id", "_upstash_context7-mcp_query-docs"],
  });
  evidence = analyzeExecutionEvidence(tree, { requireContext7: true });
  assert.equal(evidence.ready, true);
  assert.deepEqual(evidence.researchIDs, ["research"]);
});

test("Context7 steps reject tools called directly by the step-planner", () => {
  const tree = validTree();
  tree.children[0].messages = messages({
    tools: ["_upstash_context7-mcp_resolve-library-id", "_upstash_context7-mcp_query-docs"],
  });
  const evidence = analyzeExecutionEvidence(tree, { requireContext7: true });
  assert.equal(evidence.ready, false);
  assert.match(evidence.missing.join("\n"), /research task/);
  assert.match(evidence.missing.join("\n"), /resolve-library-id/);
  assert.match(evidence.missing.join("\n"), /query-docs/);
});

test("Context7 steps reject tools on a nested implementation agent", () => {
  const tree = validTree();
  tree.children[0].children[1].children[0].messages = messages({
    tools: ["edit", "_upstash_context7-mcp_resolve-library-id", "_upstash_context7-mcp_query-docs"],
  });
  const evidence = analyzeExecutionEvidence(tree, { requireContext7: true });
  assert.equal(evidence.ready, false);
  assert.match(evidence.missing.join("\n"), /research task/);
});

test("Context7 research does not accept a nested explore as direct evidence", () => {
  const tree = validContext7Tree();
  const research = tree.children[0].children.shift();
  tree.children[0].children[0].children.push(research);
  tree.children[0].children[0].children.push({
    id: "nested-explore", agent: "explore",
    messages: messages({ tools: ["read"] }), children: [],
  });
  const evidence = analyzeExecutionEvidence(tree, { requireContext7: true });
  assert.equal(evidence.ready, false);
  assert.match(evidence.missing.join("\n"), /research task/);
});

test("ordinary implementation steps still require a direct explore child", () => {
  const tree = validContext7Tree();
  const evidence = analyzeExecutionEvidence(tree);
  assert.equal(evidence.ready, false);
  assert.match(evidence.missing.join("\n"), /explore task/);
});
