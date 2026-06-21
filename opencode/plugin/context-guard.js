/** Warns when the active model context approaches its configured limit. */
import {
  CONTEXT_WARNING_FRACTION, DEFAULT_CONTEXT_LIMIT, clearContextPressure,
  recordContextPressure, resolveContextConfig,
} from "../lib/context-pressure.js";

const THRESHOLDS = [
  { frac: 0.92, label: "92%", variant: "error", msg: "Context 92% full - compact now to avoid degradation." },
  { frac: CONTEXT_WARNING_FRACTION, label: "80%", variant: "warning", msg: "Context 80% full - consider compacting soon." },
];

/** @type {import("@opencode-ai/plugin").Plugin} */
export const server = async ({ client }) => {
  const toast = (message, variant = "info") =>
    client.tui.showToast({ body: { message, variant } }).catch(() => {});
  const sessions = new Map();

  function getState(sessionID) {
    if (!sessions.has(sessionID)) {
      sessions.set(sessionID, { firedThresholds: new Set(), context: null, limitResolved: false });
    }
    return sessions.get(sessionID);
  }

  return {
    event: async ({ event }) => {
      if (event.type === "session.compacted") {
        const sessionID = event.properties?.sessionID;
        if (sessionID) {
          clearContextPressure(sessionID);
          getState(sessionID).firedThresholds.clear();
        }
        return;
      }
      if (event.type !== "message.updated") return;

      const info = event.properties?.info;
      if (!info || info.role !== "assistant" || !info.tokens || !info.sessionID) return;
      const state = getState(info.sessionID);

      if (!state.limitResolved) {
        state.limitResolved = true;
        state.context = await resolveContextConfig(client, info);
      }

      const context = state.context ?? {
        providerID: info.providerID,
        modelID: info.modelID,
        limit: DEFAULT_CONTEXT_LIMIT,
      };
      const pressure = recordContextPressure({
        sessionID: info.sessionID,
        tokens: info.tokens,
        ...context,
      });
      if (!pressure) return;

      if (pressure.fraction < CONTEXT_WARNING_FRACTION && state.firedThresholds.size) {
        state.firedThresholds.clear();
      }

      const usedK = Math.round(pressure.used / 1000);
      const limitK = Math.round(pressure.limit / 1000);
      for (const threshold of THRESHOLDS) {
        if (pressure.fraction >= threshold.frac && !state.firedThresholds.has(threshold.label)) {
          state.firedThresholds.add(threshold.label);
          toast(`${threshold.msg}\n(${usedK}k / ${limitK}k tokens)`, threshold.variant);
          break;
        }
      }
    },
  };
};

export default server;
