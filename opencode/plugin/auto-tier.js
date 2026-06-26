/**
 * Auto-tier: deterministic model-tier selection for llamaswap.
 *
 * Estimates the token count of the incoming message and upgrades the agent's
 * configured model to a higher-context variant within the same model family
 * when the message is large enough to warrant it.
 *
 * Rules:
 * - Only acts on llamaswap models with known family tiers.
 * - Never downgrades — only upgrades from the configured baseline.
 * - Manual overrides (session-level or agent-level) always take priority.
 * - Once a tier is selected for a session, it sticks (avoids llama-swap
 *   load/evict thrashing across turns in a long-running primary session).
 * - Falls back gracefully to the configured model if the target tier is
 *   unavailable (validated via preflight against the providers list).
 */

import {
  readModelOverride,
  readAgentModelOverrides,
  findAvailableModel,
} from "../lib/model-override.js";

const PROVIDER_ID = "llamaswap";

// Upgrade thresholds (estimated tokens; ~4 chars per token).
// MID: a few files of code context in the prompt.
// LARGE: a very large dump — many files, long transcripts, etc.
const MID_THRESHOLD = 20_000;
const LARGE_THRESHOLD = 60_000;

// Family table: every known modelID → [focused, mid, large]
// null means the tier doesn't exist for this family.
const FAMILY_MAP = new Map([
  // qwen3-coder (no quant suffix)
  ["qwen3-coder",            ["qwen3-coder",         "qwen3-coder-mid",       "qwen3-coder-large"]],
  ["qwen3-coder-mid",        ["qwen3-coder",         "qwen3-coder-mid",       "qwen3-coder-large"]],
  ["qwen3-coder-large",      ["qwen3-coder",         "qwen3-coder-mid",       "qwen3-coder-large"]],
  // qwen3-coder-q6 (q6 quant; large is shared with non-q6)
  ["qwen3-coder-q6",         ["qwen3-coder-q6",      "qwen3-coder-mid-q6",   "qwen3-coder-large"]],
  ["qwen3-coder-mid-q6",     ["qwen3-coder-q6",      "qwen3-coder-mid-q6",   "qwen3-coder-large"]],
  // qwopus-coder-q6
  ["qwopus-coder-q6",        ["qwopus-coder-q6",     "qwopus-coder-mid-q6",  "qwopus-coder-large-q6"]],
  ["qwopus-coder-mid-q6",    ["qwopus-coder-q6",     "qwopus-coder-mid-q6",  "qwopus-coder-large-q6"]],
  ["qwopus-coder-large-q6",  ["qwopus-coder-q6",     "qwopus-coder-mid-q6",  "qwopus-coder-large-q6"]],
  // qwable-q6
  ["qwable-q6",              ["qwable-q6",            "qwable-mid-q6",        "qwable-large"]],
  ["qwable-mid-q6",          ["qwable-q6",            "qwable-mid-q6",        "qwable-large"]],
  ["qwable-large",           ["qwable-q6",            "qwable-mid-q6",        "qwable-large"]],
  // qwable-mtp (no large variant for MTP)
  ["qwable-mtp",             ["qwable-mtp",           "qwable-mtp-mid",       null]],
  ["qwable-mtp-mid",         ["qwable-mtp",           "qwable-mtp-mid",       null]],
  // qwen3-moe (no mid variant)
  ["qwen3-moe",              ["qwen3-moe",            null,                   "qwen3-moe-large"]],
  ["qwen3-moe-large",        ["qwen3-moe",            null,                   "qwen3-moe-large"]],
]);

function estimateTokens(parts) {
  if (!Array.isArray(parts)) return 0;
  let chars = 0;
  for (const part of parts) {
    if (typeof part?.text === "string") chars += part.text.length;
  }
  return Math.ceil(chars / 4);
}

function wantedTierIndex(estimatedTokens) {
  if (estimatedTokens >= LARGE_THRESHOLD) return 2;
  if (estimatedTokens >= MID_THRESHOLD) return 1;
  return 0;
}

// sessionID → selected modelID (sticky within a session to prevent thrashing)
const sessionTierCache = new Map();

/** @type {import("@opencode-ai/plugin").Plugin} */
export const server = async ({ client }) => {
  let _providers = null;
  let _providersExpiry = 0;

  async function fetchProviders() {
    if (!client.config?.providers) return null;
    const now = Date.now();
    if (_providers && now < _providersExpiry) return _providers;
    try {
      const resp = await client.config.providers();
      _providers = resp?.data ?? null;
      _providersExpiry = now + 5_000;
    } catch { /* keep stale or null */ }
    return _providers;
  }

  return {
    "chat.message": async (input, output) => {
      const { sessionID } = input;
      const agentID = input.agent ?? output.message?.agent;

      // Manual overrides always win — don't interfere
      const sessionRecord = readModelOverride(sessionID);
      if (sessionRecord?.mode === "override") return;

      const agentOverrides = readAgentModelOverrides();
      if (agentOverrides?.overrides?.[agentID]) return;

      // Only act on llamaswap
      const currentModel = output.message?.model;
      if (!currentModel || currentModel.providerID !== PROVIDER_ID) return;

      const configuredID = currentModel.modelID;
      const tiers = FAMILY_MAP.get(configuredID);
      if (!tiers) return;

      // Session stickiness: reuse the tier selected on the first message
      const cached = sessionTierCache.get(sessionID);
      if (cached !== undefined) {
        if (cached !== configuredID) {
          output.message.model = { providerID: PROVIDER_ID, modelID: cached };
        }
        return;
      }

      const estimatedTokens = estimateTokens(output.parts);
      const currentIdx = tiers.indexOf(configuredID);
      const wantedIdx = wantedTierIndex(estimatedTokens);

      // Only upgrade, never downgrade
      if (wantedIdx <= currentIdx) {
        sessionTierCache.set(sessionID, configuredID);
        return;
      }

      // Walk down from wanted tier to find the first non-null tier above current
      let targetID = null;
      for (let i = wantedIdx; i > currentIdx; i--) {
        if (tiers[i]) { targetID = tiers[i]; break; }
      }
      if (!targetID) {
        sessionTierCache.set(sessionID, configuredID);
        return;
      }

      // Preflight: confirm target tier is available in the loaded provider list
      const providersData = await fetchProviders();
      const providers = providersData?.providers ?? [];
      if (providers.length > 0) {
        const available = findAvailableModel(providers, { providerID: PROVIDER_ID, modelID: targetID });
        if (!available) {
          console.error(`[auto-tier] ${targetID} unavailable, keeping ${configuredID}`);
          sessionTierCache.set(sessionID, configuredID);
          return;
        }
      }

      console.log(`[auto-tier] ${agentID}: ~${estimatedTokens}t → ${configuredID} → ${targetID}`);
      sessionTierCache.set(sessionID, targetID);
      output.message.model = { providerID: PROVIDER_ID, modelID: targetID };
    },
  };
};

export default server;
