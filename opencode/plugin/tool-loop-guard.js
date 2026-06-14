/**
 * Tool loop guard for OpenCode
 *
 * Blocks runaway sessions that repeatedly execute the same tool with the same
 * arguments. This is intentionally session-local and conservative: legitimate
 * retries can happen once or twice, but the third identical call is stopped.
 */

const MAX_IDENTICAL_CALLS = 2;
const MAX_IDENTICAL_PERMISSION_ASKS = 2;
const MAX_FAILURE_STREAK = 3;
const MAX_RECENT_CALLS = 30;
const RECOVERY_TOOLS = new Set(["task", "question", "invalid"]);

/** @type {Map<string, { recent: string[], counts: Map<string, number>, failureStreak: number, circuitOpen: boolean, circuitReason: string | null }>} */
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
      recent: [],
      counts: new Map(),
      failureStreak: 0,
      circuitOpen: false,
      circuitReason: null,
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
  const count = (state.counts.get(key) ?? 0) + 1;

  state.counts.set(key, count);
  state.recent.push(key);

  while (state.recent.length > MAX_RECENT_CALLS) {
    const old = state.recent.shift();
    if (!old) break;
    const oldCount = (state.counts.get(old) ?? 1) - 1;
    if (oldCount <= 0) state.counts.delete(old);
    else state.counts.set(old, oldCount);
  }

  return count;
}

function openCircuit(sessionID, reason) {
  const state = getSession(sessionID);
  state.circuitOpen = true;
  state.circuitReason = reason;
}

function closeCircuit(sessionID) {
  const state = getSession(sessionID);
  state.circuitOpen = false;
  state.circuitReason = null;
  state.failureStreak = 0;
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
        openCircuit(input.sessionID, `${input.type} permission was requested repeatedly.`);
        toast(`Permission loop blocked: ${input.type} repeated ${count} times`);
      }
    },

    "tool.execute.before": async (input, output) => {
      const state = getSession(input.sessionID);
      if (state.circuitOpen && !RECOVERY_TOOLS.has(input.tool)) {
        toast(`Tool circuit open: blocked ${input.tool}; use task/question/final response`);
        throw new Error(recoveryMessage(state.circuitReason ?? "A repeated tool loop was detected."));
      }

      if (state.circuitOpen && RECOVERY_TOOLS.has(input.tool)) {
        closeCircuit(input.sessionID);
      }

      const key = `tool:${callKey(input.tool, output.args)}`;
      const count = track(input.sessionID, key);

      if (count > MAX_IDENTICAL_CALLS) {
        const preview = stableStringify(output.args ?? {}).slice(0, 240);
        openCircuit(
          input.sessionID,
          `${input.tool} was called repeatedly with the same arguments: ${preview}`,
        );
        toast(`Tool loop blocked: ${input.tool} repeated ${count} times`);
        throw new Error(recoveryMessage(
          `Refused repeated identical tool call (${input.tool}) after ` +
            `${MAX_IDENTICAL_CALLS} completed attempt(s). Arguments: ${preview}`,
        ));
      }
    },

    "tool.execute.after": async (input, output) => {
      const state = getSession(input.sessionID);
      const status = output?.state?.status ?? output?.status ?? null;
      if (status === "error") {
        state.failureStreak += 1;
        if (state.failureStreak >= MAX_FAILURE_STREAK) {
          openCircuit(
            input.sessionID,
            `${MAX_FAILURE_STREAK} consecutive tool errors were observed.`,
          );
          toast(`Tool failure circuit opened after ${state.failureStreak} errors`);
        }
        return;
      }

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
