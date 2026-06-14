/**
 * Context-window guard plugin for OpenCode
 *
 * HOW IT WORKS
 * ============
 * Watches token usage on every assistant message.  When cumulative input
 * tokens cross 80% or 92% of the active model's context limit, it fires a
 * TUI toast warning.  Each threshold fires once per session (not once per
 * message) to avoid spamming.
 *
 * WHY THIS EXISTS
 * ===============
 * Local Qwen models cap at 64k–131k tokens (opencode.json).  Context
 * overflow degrades output quality silently — the model just starts ignoring
 * earlier turns.  An early warning gives you a chance to /compact before
 * quality degrades.
 *
 * TOKEN READING
 * =============
 * Reads `info.tokens` from `message.updated` events, mirroring the pattern
 * already used in goal.js:413-420.  `info.tokens` is
 * `{input, output, reasoning, cache}` (all numbers).  We use `input` as the
 * proxy for context window usage (it counts everything the model sees).
 *
 * MODEL LIMIT RESOLUTION
 * ======================
 * On first use per session, reads the config via client.config.get() and
 * finds the context limit for the active model.  Falls back to a
 * conservative 60k if the limit can't be resolved (avoids false silence on
 * unknown models).
 *
 * THRESHOLDS
 *   ≥ 80% → warning toast (yellow)
 *   ≥ 92% → urgent toast (error), reminder to /compact soon
 */

// Thresholds as fractions
const THRESHOLDS = [
  { frac: 0.92, label: "92%", variant: "error", msg: "⚠ Context 92% full — /compact now to avoid degradation." },
  { frac: 0.80, label: "80%", variant: "warning", msg: "⚠ Context 80% full — consider /compact soon." },
];

const DEFAULT_LIMIT = 60_000; // conservative fallback in tokens

/**
 * Resolves the context token limit for the model used in a given session.
 * Returns null if the model or limit can't be found (caller uses DEFAULT_LIMIT).
 */
async function resolveContextLimit(client) {
  try {
    const resp = await client.config.get();
    const cfg = resp.data;
    if (!cfg) return null;

    // Determine active model id — fall back through small_model → model
    const modelStr = cfg.model ?? cfg.small_model ?? "";
    if (!modelStr) return null;

    // Model id format: "providerId/modelId"
    const slashIdx = modelStr.indexOf("/");
    if (slashIdx < 0) return null;
    const providerId = modelStr.slice(0, slashIdx);
    const modelId = modelStr.slice(slashIdx + 1);

    const providerCfg = cfg.provider?.[providerId];
    const modelCfg = providerCfg?.models?.[modelId];
    return modelCfg?.limit?.context ?? null;
  } catch {
    return null;
  }
}

/** @type {import("@opencode-ai/plugin").Plugin} */
export const server = async ({ client }) => {
  const toast = (message, variant = "info") =>
    client.tui.showToast({ body: { message, variant } }).catch(() => {});

  /**
   * Per-session state:
   *   firedThresholds: Set<string>  — threshold labels already toasted this session
   *   contextLimit:    number | null — resolved limit (null = pending first message)
   */
  /** @type {Map<string, { firedThresholds: Set<string>, contextLimit: number | null, limitResolved: boolean }>} */
  const sessions = new Map();

  function getState(sessionID) {
    if (!sessions.has(sessionID)) {
      sessions.set(sessionID, {
        firedThresholds: new Set(),
        contextLimit: null,
        limitResolved: false,
      });
    }
    return sessions.get(sessionID);
  }

  return {
    event: async ({ event }) => {
      if (event.type !== "message.updated") return;

      const info = event.properties?.info;
      // Only care about assistant messages with token data
      if (!info || info.role !== "assistant") return;

      const tokens = info.tokens;
      if (!tokens) return;

      const sessionID = info.sessionID;
      if (!sessionID) return;

      const state = getState(sessionID);

      // Resolve the context limit once per session
      if (!state.limitResolved) {
        state.limitResolved = true; // prevent concurrent resolution
        const resolved = await resolveContextLimit(client);
        state.contextLimit = resolved ?? DEFAULT_LIMIT;
      }

      const limit = state.contextLimit ?? DEFAULT_LIMIT;
      const used = (tokens.input ?? 0);
      if (!used || !limit) return;

      const usedPct = used / limit;
      const usedK = Math.round(used / 1000);
      const limitK = Math.round(limit / 1000);

      // Check thresholds from highest to lowest (fire only the worst untoasted one)
      for (const t of THRESHOLDS) {
        if (usedPct >= t.frac && !state.firedThresholds.has(t.label)) {
          state.firedThresholds.add(t.label);
          toast(`${t.msg}\n(${usedK}k / ${limitK}k tokens)`, t.variant);
          break; // Only toast one level per message; the 92% toast subsumes 80%
        }
      }
    },
  };
};

export default server;
