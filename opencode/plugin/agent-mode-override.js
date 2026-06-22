/**
 * Agent mode override for OpenCode
 *
 * Agent switches do not erase older transcript messages. Local models can
 * over-weight stale planning-agent turns after switching to orchestrator, so this
 * plugin folds a short current-agent reminder into the first system prompt.
 * Some local Qwen chat templates reject multiple system messages, so keep the
 * transformed system prompt as a single string.
 *
 * IMPORTANT: opencode's plugin.trigger() dispatcher passes output by reference but
 * does NOT read back re-assigned properties — the caller holds a local reference to
 * the original array `e` and uses that. So `output.system = [...]` is silently
 * ignored. All mutations to output.system MUST be in-place (splice/unshift/pop/…).
 */

async function resolveAgent(client, sessionID) {
  if (!sessionID) return null;

  try {
    const resp = await client.session.get({ path: { id: sessionID } });
    return resp?.data?.agent ?? resp?.data?.agentID ?? resp?.data?.name ?? null;
  } catch {
    return null;
  }
}

// Prepend a reminder to the system prompt IN PLACE (unshift on the existing array).
// Must not reassign output.system — opencode keeps a ref to the original array.
function prependSystem(output, reminder) {
  output.system.unshift(reminder);
}

function sanitizeText(text) {
  return text
    .replaceAll("plan-mode guard", "stale planning-agent guard")
    .replaceAll("Plan Mode", "the previous planning-agent state")
    .replaceAll("plan mode", "the previous planning-agent state")
    .replaceAll("still in the previous planning-agent state", "using stale planning-agent transcript context")
    .replaceAll("still in previous planning-agent state", "using stale planning-agent transcript context");
}

function sanitizeValue(value) {
  if (typeof value === "string") return sanitizeText(value);
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      value[key] = sanitizeValue(value[key]);
    }
  }
  return value;
}

/** @type {import("@opencode-ai/plugin").Plugin} */
export const server = async ({ client }) => {
  return {
    "experimental.chat.messages.transform": async (_input, output) => {
      output.messages = sanitizeValue(output.messages);
    },

    "experimental.chat.system.transform": async (input, output) => {
      const agent = await resolveAgent(client, input.sessionID);
      const agentLower = agent?.toLowerCase() ?? "";

      if (agentLower.includes("orchestrator")) {
        prependSystem(output,
          "Current agent override: the active agent is orchestrator. " +
            "Ignore earlier transcript text from the planning agent as historical context only; the planning agent is no longer active. " +
            "Call workflow_control, workflow_verify, workflow_commit, and workflow_handoff directly when an explicit workflow phase prompt requires them; never delegate those calls. " +
            "Delegate all other file, command, tool, log, local-state, validation, and MCP work with task(), using explore for read-only investigation.",
        );
      } else if (agentLower === "plan") {
        prependSystem(output,
          "Current agent override: the active agent is plan. " +
            "Do not implement changes or delegate writes; produce plans, findings, questions, or TODO content in chat. " +
            "When your plan is complete and final — ready for the user to act on — " +
            "print the full plan as normal chat text, then immediately call the `present_plan` tool with NO arguments. " +
            "Do NOT repeat the plan text inside the tool call; the system reads it from your message automatically. " +
            "Calling present_plan opens the plan-approval dialog so the user can choose to implement, " +
            "auto-implement, refine, or request changes. " +
            "After calling present_plan, stop generating; do not add further text.",
        );
      }

      // Qwen3-coder chat templates reject multiple system messages — they require exactly
      // ONE system block. Collapse IN PLACE so opencode's local `e` array reference
      // (which it holds and uses after the hook returns) ends up with length 1.
      // Reassigning `output.system = [...]` is silently ignored by opencode's dispatcher.
      if (output.system.length > 1) {
        const joined = output.system.filter(Boolean).join("\n\n");
        output.system.splice(0, output.system.length, joined);
      }
    },
  };
};

export default server;
