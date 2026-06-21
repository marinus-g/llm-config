/**
 * /loop plugin for OpenCode
 *
 * HOW IT WORKS
 * ============
 * Intercepts the /loop command, stores {prompt, remaining, max} per session,
 * and listens for `session.idle` events to re-inject the prompt until the
 * counter hits zero.
 *
 * COMMANDS
 *   /loop <N> <prompt>  — run <prompt> N times total (starts immediately)
 *   /loop-stop          — cancel the active loop in this session early
 *   /check-loop         — show current loop status via toast + notify-send (no AI turn)
 *
 * COUNTING
 *   Round 1 is the literal command turn (command.execute.before sets output.parts).
 *   Rounds 2..N are re-injected by the session.idle handler.
 *   So `remaining` starts at N-1 and each idle fires decrements it.
 *
 * SAFETY STOPS
 *   - Max count reached → `Loop finished (N/N)` toast, no more re-injection.
 *   - session.error event → loop cleared with error toast.
 *   - client.session.promptAsync failure → loop cleared with error toast.
 *   - inFlight guard prevents double-injection on rapid idle events.
 *   - /loop-stop → immediate cancellation.
 */

import { loops, recentlyCompleted } from "../lib/loop-state.js";

// ---------------------------------------------------------------------------
// Loop summary helpers
// ---------------------------------------------------------------------------

async function resolveEvaluatorConfig(client) {
  try {
    const resp = await client.config.get();
    const cfg = resp.data;
    const smallModelId = cfg?.small_model ?? "llamaswap/qwen3-coder";
    const [providerId, modelId] = smallModelId.includes("/")
      ? smallModelId.split("/")
      : ["llamaswap", smallModelId];
    const provider = (cfg?.provider ?? {})[providerId];
    const baseURL = provider?.options?.baseURL ?? "http://127.0.0.1:5099/v1";
    const apiKey = provider?.options?.apiKey ?? "llama-local";
    return { baseURL, apiKey, modelId: modelId ?? "qwen3-coder" };
  } catch {
    return { baseURL: "http://127.0.0.1:5099/v1", apiKey: "llama-local", modelId: "qwen3-coder" };
  }
}

/**
 * Fetches assistant messages created on or after `startedAt`.
 * Falls back to the last max*2 assistant messages if no timestamp filter applies.
 */
async function fetchLoopMessages(client, sessionID, max, startedAt) {
  try {
    const resp = await client.session.messages({
      path: { id: sessionID },
      query: { limit: Math.max(80, max * 6) },
    });
    const entries = resp.data ?? [];
    const assistant = entries.filter((e) => e.info?.role === "assistant");
    // Filter by start time if available; otherwise take the trailing max rounds
    const filtered = startedAt
      ? assistant.filter((e) => (e.info?.time?.created ?? 0) >= startedAt)
      : assistant.slice(-max * 2);
    return filtered;
  } catch {
    return [];
  }
}

/**
 * Calls the small model to produce a concise bullet summary of what the agent
 * accomplished across all loop rounds.  Returns the formatted summary string,
 * or null if the call fails or produces nothing useful.
 */
async function buildLoopSummary(client, sessionID, { prompt, max, startedAt }) {
  const messages = await fetchLoopMessages(client, sessionID, max, startedAt);
  if (messages.length === 0) return null;

  const MAX_PART_CHARS = 500;
  const MAX_TOTAL_CHARS = 8000;

  const chunks = messages.map((entry, i) => {
    const pieces = [];
    for (const p of entry.parts ?? []) {
      if (p.type === "text" && p.text) {
        pieces.push(p.text.trim().slice(0, MAX_PART_CHARS));
      } else if (p.type === "tool" && p.state?.status === "completed") {
        const title = p.state.title ? ` — ${p.state.title}` : "";
        pieces.push(`[${p.tool}${title}]`);
      }
    }
    return `[Turn ${i + 1}]\n${pieces.join("\n")}`;
  });

  const transcript = chunks.join("\n\n").slice(0, MAX_TOTAL_CHARS);

  const { baseURL, apiKey, modelId } = await resolveEvaluatorConfig(client);

  const system =
    `You summarise what an AI coding agent accomplished across ${max} loop run(s). ` +
    `The repeated task was: "${prompt}". ` +
    `Write a concise markdown bullet list (max 12 bullets). ` +
    `Be specific: name files changed, commands run, tests passed/failed, and outcomes. ` +
    `Group by round only if the rounds did meaningfully different things. ` +
    `Do not include meta-commentary about the summary itself.`;

  try {
    const url = baseURL.replace(/\/$/, "") + "/chat/completions";
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: modelId,
        messages: [
          { role: "system", content: system },
          { role: "user", content: `Agent output:\n\n${transcript}` },
        ],
        max_tokens: 600,
        temperature: 0,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = (data?.choices?.[0]?.message?.content ?? "").trim();
    if (!text) return null;
    return `## Loop summary — ${max} run(s) of: \`${prompt}\`\n\n${text}`;
  } catch {
    return null;
  }
}

/** @type {import("@opencode-ai/plugin").Plugin} */
export const server = async ({ client, $ }) => {
  const toast = (message, variant = "info") =>
    client.tui.showToast({ body: { message, variant } }).catch(() => {});

  const notify = (summary, body) =>
    $`notify-send -a opencode ${summary} ${body}`.quiet().nothrow().catch(() => {});

  return {
    // -------------------------------------------------------------------------
    // Intercept /loop and /loop-stop commands
    // -------------------------------------------------------------------------
    "command.execute.before": async (input, output) => {
      // /check-loop — show loop status via toast + notify-send, no AI turn
      if (input.command === "check-loop") {
        const st = loops.get(input.sessionID);
        if (!st || !st.running) {
          toast("◎ No active loop in this session");
        } else {
          // currentRound: remaining starts at max-1 for round 1, so round = max - remaining
          const currentRound = st.max - st.remaining;
          const afterThis = st.remaining;
          const afterStr = afterThis === 0 ? "last round" : `${afterThis} more after this`;
          const msg = `Round ${currentRound}/${st.max} — ${afterStr}\nPrompt: "${st.prompt}"`;
          toast(msg);
          notify("↺ opencode /loop", `Round ${currentRound}/${st.max} — ${afterStr}`).catch(() => {});
        }
        // Empty parts → no content to send → no AI turn
        output.parts = [];
        return;
      }

      // /loop-stop — cancel any active loop for this session
      if (input.command === "loop-stop") {
        if (loops.has(input.sessionID)) {
          loops.delete(input.sessionID);
          toast("Loop stopped");
        }
        // Return a silent no-op so no AI turn fires
        output.parts = [{ type: "text", text: "⏹ Loop stopped." }];
        // noReply: true is not in command.execute.before output shape,
        // but the text will appear as a user message; the session will respond.
        // For a truly silent stop the user can just dismiss. This is acceptable.
        return;
      }

      if (input.command !== "loop") return;

      const arg = (input.arguments ?? "").trim();
      const m = arg.match(/^(\d+)\s+([\s\S]+)$/);
      if (!m) {
        output.parts = [
          {
            type: "text",
            text:
              "Usage: /loop <count> <prompt>\n" +
              "Example: /loop 5 run the tests and fix any failures",
          },
        ];
        return;
      }

      const max = Math.max(1, parseInt(m[1], 10));
      const prompt = m[2].trim();

      loops.set(input.sessionID, {
        prompt,
        remaining: max - 1,
        max,
        inFlight: false,
        running: true,
        startedAt: Date.now(),
      });

      // Round 1: inject the prompt as the user message for this turn
      output.parts = [{ type: "text", text: prompt }];
    },

    // -------------------------------------------------------------------------
    // On session.idle: re-inject the prompt while remaining > 0
    // -------------------------------------------------------------------------
    event: async ({ event }) => {
      // Safety stop: clear loop on session error
      if (event.type === "session.error") {
        const id = event.properties?.sessionID;
        if (id && loops.has(id)) {
          loops.delete(id);
          toast("Loop stopped (session error)", "error");
        }
        return;
      }

      if (event.type !== "session.idle") return;

      const id = event.properties?.sessionID;
      if (!id) return;

      const st = loops.get(id);
      if (!st || !st.running || st.inFlight) return;

      // Loop exhausted — clean up, notify, then post summary
      if (st.remaining <= 0) {
        const captured = { prompt: st.prompt, max: st.max, startedAt: st.startedAt };
        loops.delete(id);
        recentlyCompleted.add(id);
        setTimeout(() => recentlyCompleted.delete(id), 6000);
        toast(`✓ Loop finished (${st.max}/${st.max}) — generating summary…`);
        notify("✓ opencode /loop", `Done (${st.max}/${st.max})`).catch(() => {});

        buildLoopSummary(client, id, captured)
          .then((summary) => {
            const text = summary ?? `## Loop finished (${captured.max}/${captured.max})\n\n*(summary unavailable)*`;
            return client.session.promptAsync({
              path: { id },
              body: { parts: [{ type: "text", text }], noReply: true },
            });
          })
          .catch(() => {});

        return;
      }

      // Inject next round
      st.remaining--;
      st.inFlight = true;

      const current = st.max - st.remaining;
      const roundDone = current - 1;
      const turnsLeft = st.remaining + 1;
      notify(
        "↺ opencode /loop",
        `Round ${roundDone}/${st.max} done — ${turnsLeft} left`
      ).catch(() => {});
      client.session
        .promptAsync({
          path: { id },
          body: {
            parts: [{ type: "text", text: st.prompt }],
          },
        })
        .catch(() => {
          st.running = false;
          loops.delete(id);
          toast("Loop stopped (re-inject failed)", "error");
        })
        .finally(() => {
          st.inFlight = false;
        });
    },
  };
};

export default server;
