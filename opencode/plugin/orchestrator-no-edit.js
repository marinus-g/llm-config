/**
 * Orchestrator edit guard for OpenCode
 *
 * HOW IT WORKS
 * ============
 * Intercepts write-capable tool calls. If the calling session belongs to the
 * orchestrator or plan agent, the call is blocked with a recovery instruction
 * appropriate to that agent. The plan agent reports findings only; it must not
 * delegate writing to subagents.
 *
 * WHY THIS EXISTS
 * ===============
 * The orchestrator's system prompt says "never edit source files — always
 * delegate", but local Qwen models ignore soft meta-instructions and edit
 * directly when they can.  `permission: {edit: "deny"}` in opencode.json is
 * the primary hard stop; this plugin is belt-and-suspenders: it provides a
 * clear, actionable error message that guides the model to recover correctly
 * (delegate) rather than silently failing.
 *
 * SESSION DETECTION
 * =================
 * The `tool.execute.before` hook exposes `input.sessionID`.  We try
 * `client.session.get()` once per sessionID to read the agent name.  If the
 * API call fails or returns no agent name, we skip the block (fail-open) so
 * legitimate subagent edits are never accidentally blocked.
 *
 * Pure-router mode means the orchestrator has no direct write exceptions.
 */

/** MCP tool name patterns that write/modify files (defense-in-depth against any MCP server). */
const MCP_WRITE_PATTERNS = [
  "applyfilediff",
  "createfile",
  "writefile",
  "str_replace",
  "runtool",
];

/** Agent names that must never edit source files directly. */
const READONLY_AGENTS = ["orchestrator", "plan"];

/** Pure-router orchestrator recovery tools + workflow tools the orchestrator
 *  is explicitly instructed to run directly in its own session. */
const ORCHESTRATOR_ALLOWED_TOOLS = new Set([
  "task", "question", "invalid",
  "workflow_control", "workflow_verify", "workflow_commit", "workflow_handoff", "workflow_create",
]);

/**
 * Try to resolve metadata for a session. Do not cache this value: OpenCode can
 * switch a session from plan to orchestrator without changing the session ID.
 */
async function resolveSessionMeta(client, sessionID) {
  try {
    // The opencode client exposes session.get() following the same REST pattern
    // used by session.messages() in goal.js.
    const resp = await client.session.get({ path: { id: sessionID } });
    const agent = resp?.data?.agent ?? resp?.data?.agentID ?? resp?.data?.name ?? null;
    return { agent: agent ?? null };
  } catch {
    // API unavailable or session.get not supported — fail open.
    return null;
  }
}

async function resolveAgent(client, sessionID) {
  return (await resolveSessionMeta(client, sessionID))?.agent ?? null;
}

function planAgentMessage(action) {
  return (
    `planning-agent guard: ${action} is not allowed for the plan agent.\n` +
    `Do not retry this tool and do not delegate to a subagent to perform the write. ` +
    `Return the plan or TODO content in the chat, or ask the user to switch agents.`
  );
}

/** @type {import("@opencode-ai/plugin").Plugin} */
export const server = async ({ client }) => {
  const toast = (message, variant = "error") =>
    client.tui.showToast({ body: { message, variant } }).catch(() => {});

  /**
   * Shell patterns that write or modify files — these bypass the `edit` tool
   * and must be blocked for read-only agents just like the edit tool itself.
   */
  const SHELL_WRITE_PATTERNS = [
    { pattern: /\bcat\s*>?\s+[\w\/~\.\-_]+\s*<</, reason: "heredoc (cat > file <<)" },
    { pattern: /\b(?:echo|printf)\s+.*\s*>\s+[\w\/~\.\-_]+/, reason: "echo/printf redirect" },
    { pattern: /\btee\s+[\w\/~\.\-_]+/, reason: "tee" },
    { pattern: /\bsed\s+-i\s+/, reason: "sed -i (in-place edit)" },
    { pattern: /\bpython3?\s+-c\s+.*\bopen\b\(.*['"]w/, reason: "python open(,w)" },
    { pattern: /\bnode\s+-e\s+.*fs\.writeFile/, reason: "node fs.writeFile" },
  ];

  return {
    "tool.execute.before": async (input, output) => {
      const tool = input.tool;
      const sessionID = input.sessionID;
      const agent = sessionID ? await resolveAgent(client, sessionID) : null;
      const agentLower = agent?.toLowerCase() ?? "";
      const isPlanAgent = agentLower.includes("plan");
      const isOrchestratorAgent = agentLower.includes("orchestrator");

      if (
        isOrchestratorAgent &&
        !ORCHESTRATOR_ALLOWED_TOOLS.has(tool)
      ) {
        toast(`⛔ orchestrator router guard: blocked ${tool}; delegate with task()`, "error");
        throw new Error(
          `orchestrator-router-guard: the orchestrator is a pure routing agent and must not call "${tool}".\n` +
            `Do not retry this tool. Call task() to delegate to the correct subagent, ask a concise question, or provide a final status message.`
        );
      }

      // --- Bash write guard for read-only agents ---
      if (tool === "bash") {
        const cmd = (output.args?.command ?? "").trim();
        if (cmd) {
          if (agent && READONLY_AGENTS.some(name => agentLower.includes(name))) {
            for (const { pattern, reason } of SHELL_WRITE_PATTERNS) {
              if (pattern.test(cmd)) {
                const preview = cmd.length > 80 ? cmd.slice(0, 77) + "…" : cmd;
                toast(`⛔ no-edit guard: blocked bash file write (${reason})
${preview}`, "error");
                const action = isPlanAgent
                  ? planAgentMessage(`bash file write (${reason})`)
                  : `Do not retry this tool. Delegate to a subagent via task(), ask a concise question, or provide a final status message.`;
                throw new Error(
                  `no-edit guard: agent "${agent}" must not write files via bash.
Pattern: ${reason}\nCommand: ${cmd.slice(0, 200)}\nAction: ${action}`
                );
              }
            }
          }
        }
      }

      const isNativeWrite = tool === "edit" || tool === "write";
      const isMCPWrite = !isNativeWrite && MCP_WRITE_PATTERNS.some((p) =>
        String(tool).toLowerCase().includes(p),
      );
      if (!isNativeWrite && !isMCPWrite) return;

      if (!sessionID) return;

      if (
        (!agent || !READONLY_AGENTS.some((name) => agent.toLowerCase().includes(name)))
      ) return;

      // Determine the target file path from the tool arguments.
      // edit: { file_path, old_string, new_string }
      // write: { file_path, content }
      // JetBrains MCP: { path, ... } or { file_path, ... }
      const filePath = output.args?.file_path ?? output.args?.path ?? "";
      if (!filePath) return; // can't determine — skip

      const preview = filePath.length > 80 ? "…" + filePath.slice(-77) : filePath;
      const isPlan = isPlanAgent;
      const isMCPTOol = isMCPWrite;
      const hint = isPlan
        ? planAgentMessage(`${tool} file write`)
        : isMCPTOol
          ? `MCP write tool "${tool}" is blocked. Do not retry this tool. Delegate to a subagent via task() (e.g. dotfiles-dev, general-dev, java-expert-dev, system-admin), ask a concise question, or provide a final status message.`
          : "Do not retry this edit. Delegate to the appropriate subagent via task() (e.g. dotfiles-dev, general-dev, java-expert-dev, system-admin), ask a concise question, or provide a final status message.";

      toast(`⛔ no-edit guard: blocked direct edit of ${preview}\n${hint}`, "error");
      throw new Error(
        `no-edit guard: agent "${agent}" must not edit source files directly.\n` +
          `File: ${filePath}\n` +
          `Action: ${hint}\n` +
          `NOTE: also do not use bash to write files (cat >, echo >, tee, etc.) — this is blocked too.`
      );
    },
  };
};

export default server;
