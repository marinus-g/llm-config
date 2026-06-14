/**
 * Agent mode override for OpenCode
 *
 * Agent switches do not erase older transcript messages. Local models can
 * over-weight stale planning-agent turns after switching to orchestrator, so this
 * plugin folds a short current-agent reminder into the first system prompt.
 * Some local Qwen chat templates reject multiple system messages, so keep the
 * transformed system prompt as a single string.
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

function prependSystem(output, reminder) {
  const existing = output.system.filter(Boolean).join("\n\n");
  output.system = [existing ? `${reminder}\n\n${existing}` : reminder];
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
            "Follow the orchestrator routing rules and delegate file, command, tool, log, local-state, validation, and MCP work with task().",
        );
      } else if (agentLower.includes("plan")) {
        prependSystem(output,
          "Current agent override: the active agent is plan. " +
            "Do not implement changes or delegate writes; produce plans, findings, questions, or TODO content in chat.",
        );
      }
    },
  };
};

export default server;
