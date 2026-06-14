/**
 * /goal plugin for OpenCode — faithful clone of Claude Code's /goal command,
 * extended with --interval for polling/monitoring goals.
 *
 * HOW IT WORKS
 * ============
 * Claude's /goal is a session-scoped prompt-based Stop hook: after every turn,
 * a small fast model checks the transcript against the completion condition and
 * returns yes/no + reason.  A "no" re-injects a new turn (with the reason as
 * guidance); a "yes" clears the goal.
 *
 * OpenCode has no Stop hook (see https://github.com/anomalyco/opencode/issues/16626
 * for the planned session.stopping hook).  We approximate it by subscribing to
 * the `session.idle` event and calling `client.session.promptAsync` to re-inject
 * a turn when needed.
 *
 * KNOWN ROUGH EDGES (until #16626 lands)
 * 1. The re-injected continuation appears as a *visible user message* rather than
 *    a silent system nudge.
 * 2. In headless `opencode run` mode, process teardown can race the re-prompt
 *    before it completes.  Interval goals are especially affected: the setTimeout
 *    timer is lost if the process exits during the wait.  Use interactive TUI for
 *    interval goals; a /goal resume after restart restarts the loop.
 *
 * COMMANDS
 *   /goal <condition> [--max-turns N] [--interval <dur>]
 *                                      — set a goal; starts a turn immediately
 *   /goal                              — show status of the active goal
 *   /goal clear  (aliases: stop|off|reset|none|cancel)  — clear active goal
 *   /goal pause                        — pause auto-continue (cancels pending timer)
 *   /goal resume                       — resume (kicks next turn immediately)
 *
 * INTERVAL SYNTAX: 30s · 5m · 2h · bare number = seconds (min 5s)
 *   No --interval (default) → immediate retries, best for coding tasks.
 *   With --interval         → waits before each retry, best for monitoring tasks.
 *
 * EVALUATOR
 *   Calls your configured `small_model` (qwen3-coder via llama-swap) with an
 *   OpenAI-compatible /chat/completions request.  Fails safe to {met:false} so
 *   a flaky evaluator never falsely declares success.
 *
 * PERSISTENCE
 *   Active goals are persisted to ~/.local/state/opencode/goal-state.json so
 *   they survive opencode --continue / --resume.  Timer + turn count reset on
 *   resume (matching Claude's behaviour).  Any pending interval timer is *not*
 *   persisted — use /goal resume after restarting to restart the loop.
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";

// ---------------------------------------------------------------------------
// Timer tracking (interval goals)
// ---------------------------------------------------------------------------

/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const timers = new Map();

function clearTimer(sessionID) {
  const t = timers.get(sessionID);
  if (t !== undefined) {
    clearTimeout(t);
    timers.delete(sessionID);
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @typedef {{
 *   condition: string,
 *   active: boolean,
 *   paused: boolean,
 *   turns: number,
 *   maxTurns: number,
 *   intervalMs: number,
 *   nextCheckAt: number | null,
 *   startedAt: number,
 *   tokenBaseline: number,
 *   tokensSpent: number,
 *   lastReason: string,
 *   achieved: boolean,
 *   achievedAt: number | null,
 * }} GoalState */

/** @type {Map<string, GoalState>} */
const goals = new Map();

const STATE_PATH = join(homedir(), ".local", "state", "opencode", "goal-state.json");

function loadState() {
  try {
    const raw = readFileSync(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    for (const [sid, state] of Object.entries(parsed)) {
      // On resume: reset timer + turn count but keep condition + intervalMs
      goals.set(sid, {
        ...state,
        startedAt: Date.now(),
        turns: 0,
        tokenBaseline: 0,
        tokensSpent: 0,
        nextCheckAt: null, // pending timers can't be restored; use /goal resume
      });
    }
  } catch {
    // No state file yet — fresh start
  }
}

function saveState() {
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true });
    const obj = {};
    for (const [sid, state] of goals) {
      obj[sid] = state;
    }
    writeFileSync(STATE_PATH, JSON.stringify(obj, null, 2), "utf8");
  } catch (e) {
    console.error("[goal] Failed to persist state:", e.message);
  }
}

function defaultState(condition, maxTurns, intervalMs) {
  return {
    condition,
    active: true,
    paused: false,
    turns: 0,
    maxTurns,
    intervalMs,
    nextCheckAt: null,
    startedAt: Date.now(),
    tokenBaseline: 0,
    tokensSpent: 0,
    lastReason: "",
    achieved: false,
    achievedAt: null,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function elapsed(startedAt) {
  const ms = Date.now() - startedAt;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function fmtInterval(ms) {
  if (!ms) return null;
  const s = Math.round(ms / 1000);
  if (s % 3600 === 0) return `${s / 3600}h`;
  if (s % 60 === 0) return `${s / 60}m`;
  return `${s}s`;
}

function statusText(state) {
  if (!state) return "◎ No active goal.";
  if (state.achieved) {
    return (
      `✓ Goal achieved in ${elapsed(state.startedAt)}, ${state.turns} turn(s).\n` +
      `  Condition: ${state.condition}\n` +
      `  Reason:    ${state.lastReason}`
    );
  }
  const budgetStr = state.maxTurns < Infinity ? ` / ${state.maxTurns}` : "";
  const tokenStr = state.tokensSpent > 0 ? `, ~${state.tokensSpent.toLocaleString()} tokens` : "";
  const intervalStr = state.intervalMs ? ` | every ${fmtInterval(state.intervalMs)}` : "";
  let nextStr = "";
  if (state.intervalMs && state.nextCheckAt) {
    const inMs = state.nextCheckAt - Date.now();
    nextStr = inMs > 0 ? `\n  Next check in: ~${fmtInterval(Math.max(0, inMs))}` : "";
  }
  return (
    `◎ /goal active — ${elapsed(state.startedAt)}, ${state.turns}${budgetStr} turn(s)${tokenStr}${intervalStr}\n` +
    (state.paused ? "  ⏸ PAUSED\n" : "") +
    `  Condition: ${state.condition}\n` +
    (state.lastReason ? `  Last eval: ${state.lastReason}` : "  (waiting for first turn to complete)") +
    nextStr
  );
}

/**
 * Parse a duration string into milliseconds.
 * Accepts: 30s · 5m · 2h · bare number (= seconds).
 * Returns 0 for missing/invalid.
 */
function parseDuration(str) {
  if (!str) return 0;
  const m = str.match(/^(\d+(?:\.\d+)?)\s*([smh]?)$/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  switch ((m[2] || "s").toLowerCase()) {
    case "h": return Math.round(n * 3600000);
    case "m": return Math.round(n * 60000);
    default:  return Math.round(n * 1000);
  }
}

const MIN_INTERVAL_MS = 5000; // 5s — prevent hammering

/**
 * Parse flags from the argument string.
 * Returns { condition, maxTurns, intervalMs }.
 * Strips recognised flags from the condition.
 */
function parseArgs(args) {
  let rest = args;

  const maxMatch = rest.match(/--max-turns\s+(\d+)/);
  const maxTurns = maxMatch ? parseInt(maxMatch[1], 10) : Infinity;
  rest = rest.replace(/--max-turns\s+\d+/, "");

  const intMatch = rest.match(/--interval\s+(\S+)/);
  let intervalMs = intMatch ? parseDuration(intMatch[1]) : 0;
  if (intervalMs > 0 && intervalMs < MIN_INTERVAL_MS) intervalMs = MIN_INTERVAL_MS;
  rest = rest.replace(/--interval\s+\S+/, "");

  return { condition: rest.trim(), maxTurns, intervalMs };
}

const CLEAR_ALIASES = new Set(["clear", "stop", "off", "reset", "none", "cancel"]);

// ---------------------------------------------------------------------------
// Evaluator — calls small_model via OpenAI-compatible API
// ---------------------------------------------------------------------------

/**
 * Resolves the evaluator endpoint from the OpenCode config.
 * Falls back to a reasonable default if config is unavailable.
 */
async function resolveEvaluatorConfig(client) {
  try {
    const resp = await client.config.get();
    const cfg = resp.data;
    const smallModelId = cfg?.small_model ?? "llamaswap/qwen3-coder";
    const [providerId, modelId] = smallModelId.includes("/")
      ? smallModelId.split("/")
      : ["llamaswap", smallModelId];

    const providers = cfg?.provider ?? {};
    const provider = providers[providerId];
    const baseURL = provider?.options?.baseURL ?? "http://127.0.0.1:5099/v1";
    const apiKey = provider?.options?.apiKey ?? "llama-local";

    return { baseURL, apiKey, modelId: modelId ?? "qwen3-coder" };
  } catch {
    return {
      baseURL: "http://127.0.0.1:5099/v1",
      apiKey: "llama-local",
      modelId: "qwen3-coder",
    };
  }
}

/**
 * Fetch recent assistant messages from the session to give the evaluator
 * transcript context (capped to avoid token bloat).
 *
 * The SDK returns Array<{ info: Message, parts: Part[] }> — the message
 * metadata is on `entry.info`, content is in `entry.parts`.
 */
async function fetchRecentTranscript(client, sessionID, maxMessages = 8) {
  try {
    const resp = await client.session.messages({
      path: { id: sessionID },
      query: { limit: maxMessages * 4 }, // fetch more to filter down
    });
    const entries = resp.data ?? [];

    const assistantEntries = entries
      .filter((e) => e.info?.role === "assistant")
      .slice(-maxMessages);

    const MAX_TOOL_OUTPUT = 800;
    const MAX_TOTAL = 6000;

    const chunks = assistantEntries.map((entry) => {
      const parts = entry.parts ?? [];
      const pieces = [];

      for (const part of parts) {
        if (part.type === "text" && part.text) {
          pieces.push(part.text.trim());
        } else if (part.type === "tool" && part.state?.status === "completed") {
          const header = `[tool: ${part.tool}${part.state.title ? " — " + part.state.title : ""}]`;
          const output = String(part.state.output ?? "").slice(0, MAX_TOOL_OUTPUT);
          pieces.push(`${header}\n${output}`);
        }
      }

      return pieces.filter(Boolean).join("\n");
    });

    const transcript = chunks.filter(Boolean).join("\n\n---\n\n");
    return transcript.slice(0, MAX_TOTAL) || "(no assistant output yet)";
  } catch {
    return "(transcript unavailable)";
  }
}

/**
 * Evaluates the goal condition against the session transcript using the
 * small_model.  Returns {met: boolean, reason: string}.  Fails safe to
 * {met: false} on any error so a flaky evaluator never falsely completes.
 */
async function evaluateGoal(client, sessionID, condition) {
  const { baseURL, apiKey, modelId } = await resolveEvaluatorConfig(client);
  const transcript = await fetchRecentTranscript(client, sessionID);

  const systemPrompt =
    "You are a goal completion evaluator. " +
    "Given a completion condition and recent assistant output from a session, " +
    "judge ONLY from what is explicitly present in the transcript — do NOT infer success. " +
    'Reply with strict JSON: {"met": true|false, "reason": "one sentence explanation"}.';

  const userContent =
    `CONDITION:\n${condition}\n\nRECENT TRANSCRIPT:\n${transcript || "(no assistant output yet)"}`;

  try {
    const url = baseURL.replace(/\/$/, "") + "/chat/completions";
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelId,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
        max_tokens: 512,
        temperature: 0,
        // Disable Qwen3 thinking mode — the evaluator doesn't need CoT,
        // and thinking blocks consume tokens before the JSON output.
        chat_template_kwargs: { enable_thinking: false },
      }),
    });

    if (!response.ok) {
      console.error(`[goal] Evaluator HTTP ${response.status}`);
      return { met: false, reason: `Evaluator error: HTTP ${response.status}` };
    }

    const data = await response.json();
    const raw = data?.choices?.[0]?.message?.content ?? "";

    // Strip Qwen3 thinking blocks (<think>…</think>) and markdown fences
    // before searching for JSON.
    const text = raw
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .replace(/```(?:json)?\s*/gi, "")
      .trim();

    const jsonMatch = text.match(/\{[\s\S]*"met"[\s\S]*\}/);
    if (!jsonMatch) {
      console.error("[goal] Evaluator returned non-JSON (raw excerpt):", raw.slice(0, 300));
      return { met: false, reason: "Evaluator returned non-JSON response" };
    }
    const result = JSON.parse(jsonMatch[0]);
    return {
      met: Boolean(result.met),
      reason: String(result.reason ?? ""),
    };
  } catch (e) {
    console.error("[goal] Evaluator error:", e.message);
    return { met: false, reason: `Evaluator error: ${e.message}` };
  }
}

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

/** @type {import("@opencode-ai/plugin").Plugin} */
export const server = async ({ client }) => {
  loadState();

  /**
   * Inject the "keep working" continuation prompt for a given session.
   * Re-reads state to guard against race with clear/pause happening
   * between the timer being set and firing.
   */
  function injectContinuation(sessionID) {
    const state = goals.get(sessionID);
    if (!state || !state.active || state.paused) return;

    const budgetStr =
      state.maxTurns < Infinity
        ? ` (${state.turns}/${state.maxTurns} turns)`
        : ` (${state.turns} turn(s) so far)`;

    client.session.promptAsync({
      path: { id: sessionID },
      body: {
        parts: [
          {
            type: "text",
            text:
              `◎ Goal not yet met${budgetStr}. Evaluator says: ${state.lastReason}\n\n` +
              `Keep working toward the goal. Make progress, then demonstrate ` +
              `the outcome clearly so the evaluator can confirm.`,
          },
        ],
      },
    }).catch((e) => {
      console.error("[goal] Failed to inject continuation:", e.message);
    });
  }

  return {
    // -------------------------------------------------------------------------
    // Intercept /goal command
    // -------------------------------------------------------------------------
    "command.execute.before": async (input, output) => {
      if (input.command !== "goal") return;

      const sessionID = input.sessionID;
      const args = (input.arguments ?? "").trim();

      // STATUS — no arguments
      if (!args) {
        const state = goals.get(sessionID) ?? null;
        output.parts = [{ type: "text", text: statusText(state) }];
        return;
      }

      // CLEAR aliases
      if (CLEAR_ALIASES.has(args.toLowerCase())) {
        clearTimer(sessionID);
        const prev = goals.get(sessionID);
        goals.delete(sessionID);
        saveState();
        output.parts = [
          {
            type: "text",
            text: prev
              ? `◎ Goal cleared: ${prev.condition}`
              : "◎ No active goal to clear.",
          },
        ];
        return;
      }

      // PAUSE
      if (args.toLowerCase() === "pause") {
        const state = goals.get(sessionID);
        if (state && state.active) {
          clearTimer(sessionID);
          state.paused = true;
          state.nextCheckAt = null;
          saveState();
          output.parts = [{ type: "text", text: "⏸ Goal paused." }];
        } else {
          output.parts = [{ type: "text", text: "◎ No active goal to pause." }];
        }
        return;
      }

      // RESUME
      if (args.toLowerCase() === "resume") {
        const state = goals.get(sessionID);
        if (state && state.active && state.paused) {
          state.paused = false;
          state.nextCheckAt = null;
          saveState();
          output.parts = [{ type: "text", text: "▶ Goal resumed — starting next check." }];
          // Kick the loop: no session.idle will fire for us, so inject directly.
          // Use setImmediate-equivalent so output.parts is returned first.
          setTimeout(() => injectContinuation(sessionID), 50);
        } else if (state && state.active) {
          output.parts = [{ type: "text", text: "◎ Goal is already running." }];
        } else {
          output.parts = [{ type: "text", text: "◎ No paused goal to resume." }];
        }
        return;
      }

      // SET GOAL — any other text is treated as the condition
      const { condition, maxTurns, intervalMs } = parseArgs(args);
      if (!condition) {
        output.parts = [
          { type: "text", text: "Usage: /goal <condition> [--max-turns N] [--interval <Ns|Nm|Nh>]" },
        ];
        return;
      }

      // Cancel any pending timer from a previous goal in this session
      clearTimer(sessionID);
      goals.set(sessionID, defaultState(condition, maxTurns, intervalMs));
      saveState();

      const budgetStr = maxTurns < Infinity ? ` | max ${maxTurns} turns` : "";
      const intervalStr = intervalMs ? ` | every ${fmtInterval(intervalMs)}` : "";
      output.parts = [
        {
          type: "text",
          text:
            `◎ Goal set${budgetStr}${intervalStr}: ${condition}\n\n` +
            `Work toward completing this goal. When you believe the condition is ` +
            `met, demonstrate it clearly in your output (run the relevant checks, ` +
            `show test results, print the file contents, etc.) so the evaluator ` +
            `can confirm. Do not claim success without visible evidence.`,
        },
      ];
    },

    // -------------------------------------------------------------------------
    // On session.idle: evaluate and re-inject (immediately or after interval)
    // -------------------------------------------------------------------------
    event: async ({ event }) => {
      if (event.type === "message.updated") {
        // Accumulate token usage from assistant messages.
        // assistantMessage.tokens is {input, output, reasoning, cache} — not a number.
        const info = event.properties?.info;
        if (info?.role === "assistant" && info.tokens) {
          const sessionID = info.sessionID;
          const state = sessionID ? goals.get(sessionID) : null;
          if (state) {
            const { input = 0, output = 0, reasoning = 0 } = info.tokens;
            state.tokensSpent = (input + output + reasoning) - state.tokenBaseline;
          }
        }
        return;
      }

      if (event.type !== "session.idle") return;

      const sessionID = event.properties?.sessionID;
      if (!sessionID) return;

      const state = goals.get(sessionID);
      if (!state || !state.active || state.paused) return;

      // If an interval timer is already pending, don't stack another loop.
      // (Can happen if user sends a message manually while waiting.)
      if (timers.has(sessionID)) return;

      state.turns += 1;

      // Hard turn-budget stop
      if (state.maxTurns < Infinity && state.turns >= state.maxTurns) {
        clearTimer(sessionID);
        state.active = false;
        goals.set(sessionID, state);
        saveState();

        client.session.promptAsync({
          path: { id: sessionID },
          body: {
            parts: [
              {
                type: "text",
                text:
                  `◎ Goal stopped: turn budget of ${state.maxTurns} reached.\n` +
                  `Condition was: ${state.condition}\n` +
                  `Last evaluator note: ${state.lastReason || "(none yet)"}`,
              },
            ],
            noReply: true,
          },
        }).catch(() => {});
        return;
      }

      // Evaluate
      const { met, reason } = await evaluateGoal(client, sessionID, state.condition);
      state.lastReason = reason;

      if (met) {
        clearTimer(sessionID);
        state.active = false;
        state.achieved = true;
        state.achievedAt = Date.now();
        goals.set(sessionID, state);
        saveState();

        client.session.promptAsync({
          path: { id: sessionID },
          body: {
            parts: [
              {
                type: "text",
                text:
                  `✓ Goal achieved in ${elapsed(state.startedAt)}, ${state.turns} turn(s).\n` +
                  `Condition: ${state.condition}\n` +
                  `Reason:    ${reason}`,
              },
            ],
            noReply: true,
          },
        }).catch(() => {});
      } else {
        // Not met — schedule or immediately inject the continuation
        if (state.intervalMs > 0) {
          state.nextCheckAt = Date.now() + state.intervalMs;
          goals.set(sessionID, state);
          saveState();

          const t = setTimeout(() => {
            timers.delete(sessionID);
            injectContinuation(sessionID);
          }, state.intervalMs);
          timers.set(sessionID, t);
        } else {
          goals.set(sessionID, state);
          saveState();
          injectContinuation(sessionID);
        }
      }
    },
  };
};
