function completedAssistant(messages) {
  return messages.some((message) => message.info?.role === "assistant"
    && (message.parts ?? []).some((part) => part.type === "step-finish"));
}

function completedTools(messages) {
  return messages.flatMap((message) => message.parts ?? []).filter((part) =>
    part.type === "tool" && part.state?.status === "completed");
}

const INSPECTION_TOOLS = ["read", "grep", "glob", "list", "bash", "git", "codegraph"];

function isInspectionTool(part) {
  const name = String(part?.tool ?? "").toLowerCase();
  return name !== "workflow_review" && INSPECTION_TOOLS.some((tool) => name.includes(tool));
}

function structuredVerdict(messages) {
  let verdict = "";
  for (const part of completedTools(messages)) {
    if (String(part.tool ?? "").toLowerCase() !== "workflow_review") continue;
    const value = String(part.state?.input?.verdict ?? "").toUpperCase();
    if (value === "PASS" || value === "FAIL") verdict = `VERDICT: ${value}`;
  }
  return verdict;
}

function textVerdict(messages) {
  const texts = messages.filter((message) => message.info?.role === "assistant")
    .flatMap((message) => message.parts ?? []).filter((part) => part.type === "text")
    .map((part) => part.text ?? "").filter(Boolean);
  const verdicts = new Set();
  for (const text of texts) {
    for (const line of text.split(/\r?\n/)) {
      const normalized = line.trim()
        .replace(/^#{1,6}\s+/, "")
        .replace(/^(?:\*\*|__|`)(.*)(?:\*\*|__|`)$/, "$1")
        .trim();
      const match = normalized.match(/^VERDICT:\s*(PASS|FAIL)$/i);
      if (match) verdicts.add(match[1].toUpperCase());
    }
  }
  return verdicts.size === 1 ? `VERDICT: ${[...verdicts][0]}` : "";
}

function extractVerdict(messages) {
  return structuredVerdict(messages) || textVerdict(messages);
}

function analyzePlannerSubtree(planner, requireImplementation, requireContext7) {
  const latest = (nodes) => [...nodes].sort((a, b) => a.createdAt - b.createdAt).at(-1);
  const missing = [];
  if (!completedAssistant(planner.messages)) missing.push("completed step-planner");
  const explores = planner.children?.filter((node) => node.agent === "explore") ?? [];
  const researchNodes = planner.children?.filter((node) => node.agent === "research") ?? [];
  if (!requireContext7 && !explores.some((node) =>
    completedAssistant(node.messages) && completedTools(node.messages).length)) {
    missing.push("completed explore task with tool evidence");
  }
  if (requireContext7) {
    const completedResearch = researchNodes.filter((node) => completedAssistant(node.messages));
    if (!completedResearch.some((node) => completedTools(node.messages).length)) {
      missing.push("completed research task with Context7 tool evidence");
    }
    const researchTools = completedResearch.flatMap((node) => completedTools(node.messages))
      .map((part) => String(part.tool ?? "").toLowerCase());
    if (!researchTools.some((name) => name.includes("resolve-library-id"))) {
      missing.push("completed Context7 resolve-library-id evidence");
    }
    if (!researchTools.some((name) => name.includes("query-docs"))) {
      missing.push("completed Context7 query-docs evidence");
    }
  }
  const orchestrators = planner.children?.filter((node) => node.agent === "step-orchestrator") ?? [];
  const implementationAgents = orchestrators.flatMap((node) => node.children).filter((node) =>
    !["explore", "research", "step-planner", "step-orchestrator", "step-reviewer"].includes(node.agent));
  if (requireImplementation) {
    if (!orchestrators.some((node) => completedAssistant(node.messages))) missing.push("completed step-orchestrator");
    if (!implementationAgents.some((node) => completedAssistant(node.messages) && completedTools(node.messages).length)) {
      missing.push("completed domain implementation agent with tool evidence");
    }
  }
  const reviewers = planner.children?.filter((node) => node.agent === "step-reviewer") ?? [];
  const reviewer = latest(reviewers);
  const verdict = extractVerdict(reviewer?.messages ?? []);
  const reviewerTools = completedTools(reviewer?.messages ?? []);
  if (!reviewer || !completedAssistant(reviewer.messages) || !reviewerTools.some(isInspectionTool)) {
    missing.push("completed step-reviewer with inspection evidence");
  }
  // Fix 2: For Context7 / no-code research steps, require the reviewer to have
  // actually opened (read/grep/glob) the produced deliverable, not just queried Context7.
  if (requireContext7 && reviewer) {
    if (!reviewerTools.some(isInspectionTool)) {
      missing.push("reviewer did not inspect the deliverable (no read/grep/glob call found)");
    }
  }
  if (verdict !== "VERDICT: PASS") {
    const got = verdict || "none";
    missing.push(`passing reviewer verdict (got ${got.length > 80 ? got.slice(0, 77) + "…" : got})`);
  }
  return { missing, plannerID: planner.id,
    exploreIDs: explores.map((node) => node.id), researchIDs: researchNodes.map((node) => node.id),
    orchestratorIDs: orchestrators.map((node) => node.id),
    implementationAgentIDs: implementationAgents.map((node) => node.id),
    reviewerID: reviewer?.id ?? null, verdict };
}

export function analyzeExecutionEvidence(root, opts = {}) {
  const { requireImplementation = true, requireContext7 = false } = opts;
  const planners = root?.children?.filter((node) => node.agent === "step-planner") ?? [];
  if (planners.length === 0) {
    const investigation = requireContext7
      ? "completed research task with Context7 tool evidence"
      : "completed explore task with tool evidence";
    const missing = ["completed step-planner", investigation];
    if (requireContext7) {
      missing.push("completed Context7 resolve-library-id evidence", "completed Context7 query-docs evidence");
    }
    if (requireImplementation) missing.push("completed step-orchestrator", "completed domain implementation agent with tool evidence");
    missing.push("completed step-reviewer with inspection evidence", "passing reviewer verdict (got none)");
    return { ready: false, missing, plannerID: null, exploreIDs: [], researchIDs: [], orchestratorIDs: [],
      implementationAgentIDs: [], reviewerID: null, verdict: "", checkedAt: Date.now() };
  }
  // Evaluate all planner subtrees; return ready if any is complete, otherwise return the best.
  let bestResult = null;
  for (const planner of planners) {
    const result = analyzePlannerSubtree(planner, requireImplementation, requireContext7);
    if (result.missing.length === 0) {
      return { ready: true, ...result, checkedAt: Date.now() };
    }
    if (!bestResult || result.missing.length < bestResult.missing.length) bestResult = result;
  }
  return { ready: false, ...bestResult, checkedAt: Date.now() };
}
