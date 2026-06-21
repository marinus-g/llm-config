/**
 * Tool loop guard for OpenCode
 *
 * Blocks runaway sessions that repeatedly execute the same tool with the same
 * arguments. Circuit breakers are per-tool: a loop in one tool only blocks that
 * tool, not unrelated ones. Legitimate retries can happen once or twice, but
 * the third identical call is stopped.
 */

const MAX_IDENTICAL_CALLS = 2;
const MAX_IDENTICAL_PERMISSION_ASKS = 2;
const REPEAT_WINDOW_MS = 90_000; // identical calls only count toward a loop if within this gap
const RECOVERY_TOOLS = new Set([
  "task", "question", "invalid",
  "workflow_control", "workflow_verify", "workflow_commit",
]);

// Fix 4: Catch repeated-call storms on workflow tools (NOT task — it's legitimately called many
// times in multi-agent workflows). Limit is generous: these tools are called at most a few times
// per TODO in normal operation.
const WORKFLOW_STORM_TOOLS = new Set(["workflow_verify", "workflow_control", "workflow_commit"]);
const MAX_WORKFLOW_STORM_CALLS = 8;

/** @type {Map<string, { counts: Map<string, { count: number, lastSeen: number }>, failureStreak: number, circuitsOpen: Map<string, { open: boolean, reason: string | null, blockedArgs: Set<string> }> }>} */
const sessions = new Map();

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function getSession(sessionID) {
  let state = sessions.get(sessionID);
  if (!state) {
    state = {
      counts: new Map(),
      failureStreak: 0,
      circuitsOpen: new Map(),
    };
    sessions.set(sessionID, state);
  }
  return state;
}

function callKey(tool, args) {
  if (tool === "bash") {
    return `bash:${String(args?.command ?? "").trim()}`;
  }
  return `${tool}:${stableStringify(args ?? {})}`;
}

function permissionKey(input) {
  const patterns = Array.isArray(input.pattern)
    ? input.pattern.map((item) => String(item).trim()).sort()
    : [String(input.pattern ?? "").trim()];
  return `${input.type}:${patterns.join(" && ")}`;
}

function track(sessionID, key) {
  const state = getSession(sessionID);
  const now = Date.now();
  const prev = state.counts.get(key);
  const withinWindow = prev !== undefined && now - prev.lastSeen <= REPEAT_WINDOW_MS;
  const count = withinWindow ? prev.count + 1 : 1;
  state.counts.set(key, { count, lastSeen: now });

  // Evict stale entries to bound memory usage.
  for (const [k, v] of state.counts) {
    if (now - v.lastSeen > REPEAT_WINDOW_MS) state.counts.delete(k);
  }

  return count;
}

function openCircuit(sessionID, tool, reason, blockedKey) {
  const state = getSession(sessionID);
  let circuit = state.circuitsOpen.get(tool);
  if (!circuit) {
    circuit = { open: false, reason: null, blockedArgs: new Set() };
    state.circuitsOpen.set(tool, circuit);
  }
  circuit.open = true;
  circuit.reason = reason;
  if (blockedKey) circuit.blockedArgs.add(blockedKey);
}

function clearToolCircuit(sessionID, tool) {
  const state = getSession(sessionID);
  state.circuitsOpen.delete(tool);
  // Also reset the call counts for this tool so the next invocation
  // is treated as fresh rather than immediately re-hitting the threshold.
  for (const key of state.counts.keys()) {
    if (key.startsWith(`tool:${tool}:`)) state.counts.delete(key);
  }
}

function clearAllCircuits(sessionID) {
  const state = getSession(sessionID);
  state.circuitsOpen.clear();
  // Reset all tool call counts so every tool starts fresh.
  for (const key of state.counts.keys()) {
    if (key.startsWith("tool:")) state.counts.delete(key);
  }
}

function recoveryMessage(reason) {
  return (
    `tool-loop-guard: session recovery mode is active. ${reason}\n` +
    `Do not retry the blocked tool. Stop tool use and either call task() to delegate ` +
    `to the correct subagent, ask the user a concise question, or provide a final ` +
    `status message explaining the block.`
  );
}

/** @type {import("@opencode-ai/plugin").Plugin} */
export const server = async ({ client }) => {
  const toast = (message, variant = "error") =>
    client.tui.showToast({ body: { message, variant } }).catch(() => {});

  return {
    "permission.ask": async (input, output) => {
      const key = `permission:${permissionKey(input)}`;
      const count = track(input.sessionID, key);

      if (count > MAX_IDENTICAL_PERMISSION_ASKS) {
        output.status = "deny";
        openCircuit(
          input.sessionID,
          input.type,
          `${input.type} permission was requested repeatedly.`,
        );
        toast(`Permission loop blocked: ${input.type} repeated ${count} times`);
      }
    },

    "tool.execute.before": async (input, output) => {
      const state = getSession(input.sessionID);
      const { tool } = input;

      // Recovery tools clear ALL other circuits, but first check for workflow-tool storms.
      if (RECOVERY_TOOLS.has(tool)) {
        // Fix 4: Detect repeated-call storms on specific workflow tools (excluding task,
        // which is legitimately called many times in multi-agent orchestration).
        if (WORKFLOW_STORM_TOOLS.has(tool)) {
          const stormKey = `storm:${tool}`;
          const stormCount = track(input.sessionID, stormKey);
          if (stormCount > MAX_WORKFLOW_STORM_CALLS) {
            const msg =
              `${tool} was called ${stormCount} times in a short window — this indicates a loop. ` +
              `Stop all tool use. Provide a final status message to the user or ask what to do next.`;
            toast(`Workflow tool storm blocked: ${tool} called ${stormCount}×`, "error");
            throw new Error(recoveryMessage(msg));
          }
        }
        clearAllCircuits(input.sessionID);
        return;
      }

      // Check if THIS tool's circuit is open
      const circuit = state.circuitsOpen.get(tool);
      if (circuit && circuit.open) {
        const key = callKey(tool, output.args);
        const argHash = stableStringify(output.args ?? {});

        if (circuit.blockedArgs.has(argHash)) {
          toast(`Tool circuit open: blocked ${tool}; use task/question/final response`);
          throw new Error(
            recoveryMessage(circuit.reason ?? "A repeated tool loop was detected."),
          );
        }

        // Circuit is open but args are different → allow through and clear this tool's circuit
        clearToolCircuit(input.sessionID, tool);
      }

      const key = `tool:${callKey(tool, output.args)}`;
      const count = track(input.sessionID, key);

      if (count > MAX_IDENTICAL_CALLS) {
        const preview = stableStringify(output.args ?? {}).slice(0, 240);
        const argHash = stableStringify(output.args ?? {});
        openCircuit(
          input.sessionID,
          tool,
          `${tool} was called repeatedly with the same arguments: ${preview}`,
          argHash,
        );
        toast(`Tool loop blocked: ${tool} repeated ${count} times`);
        throw new Error(recoveryMessage(
          `Refused repeated identical tool call (${tool}) after ` +
            `${MAX_IDENTICAL_CALLS} completed attempt(s). Arguments: ${preview}`,
        ));
      }
    },

    "tool.execute.after": async (input, output) => {
      const state = getSession(input.sessionID);

      // Fix 4: workflow_control attach/resume/danger are legit workflow transitions —
      // reset the storm counters for all workflow tools so a fresh TODO starts clean.
      if (input.tool === "workflow_control") {
        for (const t of WORKFLOW_STORM_TOOLS) state.counts.delete(`storm:${t}`);
      }

      // Reset failure streak on success and clear that tool's circuit
      clearToolCircuit(input.sessionID, input.tool);
      state.failureStreak = 0;
    },

    event: async ({ event }) => {
      if (event.type === "session.deleted") {
        const id = event.properties?.sessionID;
        if (id) sessions.delete(id);
      }
    },
  };
};

export default server;
