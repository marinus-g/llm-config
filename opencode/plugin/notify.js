/**
 * Desktop notifications plugin for OpenCode
 *
 * HOW IT WORKS
 * ============
 * Fires native notify-send notifications for events that matter when you're
 * away from the TUI (long autonomous /goal or /loop runs, permission prompts
 * that gate the `build` agent, session errors).
 *
 * EVENTS
 *   session.idle   → "Turn finished" (debounced 2.5s; cancelled by a
 *                    new incoming message so loop/goal re-injections
 *                    don't fire a false-positive idle notification)
 *   session.error  → critical notification with error summary
 *   permission.ask → normal notification when any agent needs approval
 *
 * DEBOUNCE DESIGN
 *   /loop and /goal re-inject a new user message within ~100ms of idle.
 *   The chat.message hook clears the 2.5s idle timer, so only the final
 *   resting idle state produces a notification.
 *
 * LOOP INTEGRATION
 *   loop.js fires its own per-round notifications with progress info.
 *   This plugin suppresses the generic "Turn finished" ping for any session
 *   that is (or recently was) a /loop session, to avoid duplicate notifications.
 */

import { loops, recentlyCompleted } from "./loop.js";

/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const idleTimers = new Map();

/** @type {Map<string, {agent?: string, model?: string}>} */
const sessionContext = new Map();

function shortSession(id) {
  return id ? id.slice(0, 8) : "unknown";
}

function modelName(model) {
  if (!model) return "";
  if (typeof model === "string") return model;
  return model.modelID ?? model.id ?? "";
}

function rememberSession(sessionID, agent, model) {
  if (!sessionID) return;
  const prev = sessionContext.get(sessionID) ?? {};
  sessionContext.set(sessionID, {
    agent: agent ?? prev.agent,
    model: modelName(model) || prev.model,
  });
}

function contextLine(sessionID) {
  if (!sessionID) return "session: unknown";
  const ctx = sessionContext.get(sessionID) ?? {};
  const bits = [`session ${shortSession(sessionID)}`];
  if (ctx.agent) bits.push(ctx.agent);
  if (ctx.model) bits.push(ctx.model);
  return bits.join(" / ");
}

/** @type {import("@opencode-ai/plugin").Plugin} */
export const server = async ({ $ }) => {
  const timeoutByUrgency = {
    low: 4000,
    normal: 6000,
    critical: 12000,
  };

  const notify = (summary, body, urgency = "normal") => {
    const timeout = timeoutByUrgency[urgency] ?? timeoutByUrgency.normal;
    const args = ["-a", "opencode", "-u", urgency, "-t", String(timeout), summary];
    if (body) args.push(body);
    return $`notify-send ${args}`.quiet().nothrow();
  };

  return {
    // -------------------------------------------------------------------------
    // Intercept permission prompts — fire before the dialog appears
    // -------------------------------------------------------------------------
    "permission.ask": async (input) => {
      // Observe only; do not modify output.status
      notify(
        "⏸ opencode needs approval",
        (input.title ?? input.type ?? "permission required").slice(0, 100),
        "normal"
      ).catch(() => {});
    },

    // -------------------------------------------------------------------------
    // Cancel idle notification when a new message arrives (loop/goal re-inject)
    // -------------------------------------------------------------------------
    "chat.message": async ({ sessionID, agent, model }) => {
      rememberSession(sessionID, agent, model);
      const t = idleTimers.get(sessionID);
      if (t !== undefined) {
        clearTimeout(t);
        idleTimers.delete(sessionID);
      }
    },

    "chat.headers": async (input) => {
      rememberSession(input.sessionID, input.agent, input.model);
    },

    // -------------------------------------------------------------------------
    // Bus events
    // -------------------------------------------------------------------------
    event: async ({ event }) => {
      // Urgent notification on session error
      if (event.type === "session.error") {
        const sessionID = event.properties?.sessionID;
        const err = event.properties?.error;
        const msg =
          (err && typeof err === "object" && "data" in err && err.data?.message) ||
          (err && typeof err === "object" && "message" in err && err.message) ||
          "session error";
        notify(
          "❌ opencode error",
          `${contextLine(sessionID)}\n${String(msg).slice(0, 160)}`,
          "normal"
        ).catch(() => {});
        return;
      }

      // Debounced idle notification
      if (event.type === "session.idle") {
        const id = event.properties.sessionID;
        // Clear any prior timer (handles rapid idle-idle if loop fires multiple rounds quickly)
        const prev = idleTimers.get(id);
        if (prev !== undefined) clearTimeout(prev);

        idleTimers.set(
          id,
          setTimeout(() => {
            idleTimers.delete(id);
            // loop.js handles its own notifications; skip generic ping for loop sessions
            if (loops.has(id) || recentlyCompleted.has(id)) return;
            notify("✓ opencode idle", `Turn finished\n${contextLine(id)}`).catch(() => {});
          }, 2500)
        );
      }
    },
  };
};

export default server;
