/**
 * plan-task-allowlist.js — Restricts which subagents the plan agent may spawn.
 *
 * HOW IT WORKS
 * ============
 * The plan agent has `task: "allow"` so it can delegate exploration to read-only
 * subagents. Without this guard a weak local model could spawn any subagent,
 * including edit-capable ones (general-dev, java-expert-dev, etc.), whose sessions
 * bypass the orchestrator-no-edit.js guard which keys on the CALLING agent being
 * "plan". This plugin closes that gap.
 *
 * Only task() calls in the plan agent's session are inspected. If the target
 * subagent is in the allowlist the call proceeds normally. Anything else throws
 * with a recovery message that steers the model back to self-exploration or the
 * plan output.
 *
 * ALLOWLIST
 * =========
 * - explore   — FastContext read-only file scout (read/glob/grep/list only)
 * - research  — Context7 + CodeGraph doc/API researcher (mcp read-only)
 *
 * The plan model should still call codegraph_* MCP tools directly (cheaper and
 * more accurate for structural lookups than delegating via explore). Delegation
 * to explore/research pays off for broad multi-file reading sweeps that would
 * otherwise bloat the planning model's context.
 *
 * IMPLEMENTATION NOTES
 * ====================
 * - Mirrors plan-no-bash-write.js in structure (resolveAgent, toast, throw).
 * - Fails open if the session agent cannot be resolved (matches existing guards).
 * - The target agent name is read from output.args.agent (SDK SubtaskPartInput
 *   schema). A defensive fallback checks output.args.subagent_type and
 *   output.args.name so the guard degrades gracefully if the field ever changes.
 */

/** Read-only subagents the plan agent is permitted to spawn. */
const ALLOWED_SUBAGENTS = new Set(["explore", "research"]);

/** Resolve the current agent name for a session. */
async function resolveAgent(client, sessionID) {
  try {
    const resp = await client.session.get({ path: { id: sessionID } });
    return resp?.data?.agent ?? resp?.data?.agentID ?? resp?.data?.name ?? null;
  } catch {
    return null;
  }
}

/** @type {import("@opencode-ai/plugin").Plugin} */
export const server = async ({ client }) => {
  const toast = (message, variant = "error") =>
    client.tui.showToast({ body: { message, variant } }).catch(() => {});

  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "task") return;

      const sessionID = input.sessionID;
      if (!sessionID) return;

      const agent = await resolveAgent(client, sessionID);
      if (!agent || agent.toLowerCase() !== "plan") return;

      // Defensive multi-field read — SDK uses output.args.agent but guard against future renames.
      const args = output.args ?? {};
      const target = (
        args.agent ?? args.subagent_type ?? args.subagentType ?? args.name ?? ""
      ).toLowerCase().trim();

      if (!target) {
        // Can't determine target — fail open to avoid blocking legitimate calls.
        return;
      }

      if (ALLOWED_SUBAGENTS.has(target)) return;

      const preview = target.length > 60 ? target.slice(0, 57) + "…" : target;
      toast(
        `⛔ plan-task-allowlist: blocked delegation to "${preview}"\n` +
          `plan may only spawn explore or research subagents`,
        "error",
      );
      throw new Error(
        `plan-task-allowlist: the plan agent may only delegate to read-only subagents ` +
          `(explore, research). Spawning "${target}" is blocked.\n` +
          `Do not retry this task() call. Instead:\n` +
          `• Use read/glob/grep/list tools or codegraph_* MCP tools to explore the codebase yourself.\n` +
          `• Delegate narrow file discovery to the "explore" subagent.\n` +
          `• Delegate library/API doc lookups to the "research" subagent.\n` +
          `• When your plan is complete, output the full plan text followed by:\n` +
          `[OPENCODE_PLAN_GATE]`,
      );
    },
  };
};

export default server;
