/**
 * Plan / orchestrator JetBrains write guard
 *
 * HOW IT WORKS
 * ============
 * Intercepts JetBrains MCP tool calls via `tool.execute.before`.  The plan
 * agent can use read-only JetBrains tools, but cannot use write-capable
 * tools. The orchestrator is a pure router and cannot use JetBrains tools
 * directly.
 *
 * WHY THIS EXISTS
 * ===============
 * The plan and orchestrator agents have `"edit": "deny"` on their built-in edit tool and
 * `"mcp": "allow"` on all MCP servers.  The JetBrains MCP server has write-
 * capable tools (applyFileDiff, createFile) that the agent can call freely —
 * bypassing the "no writes" rule.  This plugin closes that backdoor while
 * still allowing non-router subagents to use JetBrains normally.
 *
 * BLOCKED TOOLS (JetBrains MCP)
 *   - applyFileDiff  — applies a patch/diff to a file
 *   - createFile     — creates a new file
 *   - runTool        — can dispatch to any IDE action including file writes
 *
 * DETECTION STRATEGY
 * ==================
 * Tool-name pattern blocks known write-capable JetBrains tool names,
 * regardless of prefix. Orchestrator blocks all JetBrains tools separately.
 *
 * SESSION DETECTION
 * =================
 * `client.session.get()` resolves the current agent name per sessionID. This
 * is intentionally not cached because OpenCode can switch agents in-place.
 *
 * TOOLS DEBUGGING
 * ===============
 * On first encounter of a JetBrains MCP tool, logs the full tool name and
 * arguments to console for debugging.  This helps identify the actual
 * naming convention opencode uses (e.g. "mcp-jetbrains-applyFileDiff" vs
 * "jetbrains-applyFileDiff").
 */

/** JetBrains MCP tool names that can write/modify files. */
const WRITE_TOOL_PATTERNS = ["applyFileDiff", "createFile", "runTool"];

/** Agent names that must not use JetBrains write tools. */
const READONLY_AGENTS = ["plan", "orchestrator"];

/**
 * Track tool names we've seen from the JetBrains server for debugging.
 * @type {Set<string>}
 */
const seenJetBrainsTools = new Set();

/**
 * Try to resolve the agent name for a session.
 * @returns {Promise<string | null>} agent name or null if not readonly.
 */
async function resolveAgent(client, sessionID) {
	try {
		const resp = await client.session.get({ path: { id: sessionID } });
		return resp?.data?.agent ?? resp?.data?.agentID ?? resp?.data?.name ?? null;
	} catch {
		return null;
	}
}

/**
 * Check if a tool name belongs to the JetBrains MCP server.
 *
 * Opencode prefixes MCP tool names with the server identifier.  Common
 * conventions include:
 *   - "mcp-serverName-toolName"    (e.g. "mcp-jetbrains-applyFileDiff")
 *   - "serverName/toolName"        (e.g. "jetbrains/applyFileDiff")
 *   - "serverName-toolName"        (e.g. "jetbrains-applyFileDiff")
 *
 * We check for the server name as a substring, which covers all these.
 * @param {string} toolName - the tool name as opencode knows it.
 * @returns {boolean}
 */
function isJetBrainsTool(toolName) {
	const lower = String(toolName ?? "").toLowerCase();
	return (
		lower.includes("jetbrains") ||
		lower.includes("intellij") ||
		lower.includes("idea")
	);
}

/**
 * Check if a tool name matches a known write-capable JetBrains tool.
 * @param {string} toolName
 * @returns {boolean}
 */
function isWriteTool(toolName) {
	const lower = String(toolName ?? "").toLowerCase();
	return WRITE_TOOL_PATTERNS.some((p) => lower.includes(p.toLowerCase()));
}

/** @type {import("@opencode-ai/plugin").Plugin} */
export const server = async ({ client }) => {
	const toast = (message, variant = "error") =>
		client.tui.showToast({ body: { message, variant } }).catch(() => {});

	return {
		"tool.execute.before": async (input, output) => {
			const toolName = input.tool;
			if (!isJetBrainsTool(toolName)) return;

			const sessionID = input.sessionID;
			if (!sessionID) return;

			// Debug: log first encounter of any JetBrains tool
			if (!seenJetBrainsTools.has(toolName)) {
				seenJetBrainsTools.add(toolName);
				console.log(
					"[plan-no-jetbrains-write] JetBrains tool seen: " +
						toolName +
						" | args:",
					output.args,
				);
			}

			const agent = await resolveAgent(client, sessionID);
			if (!agent || !READONLY_AGENTS.some((a) => agent.toLowerCase().includes(a)))
				return; // not a readonly agent — allow

			const isWrite = isWriteTool(toolName);
			const isOrchestrator = agent.toLowerCase().includes("orchestrator");
			const isPlan = agent.toLowerCase().includes("plan");

			if (isPlan && !isWrite) return;

			const reason = isOrchestrator
				? `JetBrains MCP tool "${toolName}" is blocked for the orchestrator agent.`
				: `JetBrains write tool "${toolName}" is not allowed for the plan agent.`;
			const action = isOrchestrator
				? "Do not retry this tool. Call task() to delegate to a subagent, ask a concise question, or provide a final status message."
				: "Do not retry this tool. Report the block or ask a concise question.";

			toast(`⛔ plan-no-jetbrains: ${reason}`, "error");

			throw new Error(
				`plan-no-jetbrains-write: ${reason}\n` +
					`Tool: ${toolName}\n` +
					`Session: ${sessionID}\n` +
					`${action}`,
			);
		},
	};
};

export default server;
