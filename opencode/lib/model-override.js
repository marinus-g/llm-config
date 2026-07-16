import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Model availability helpers
// ---------------------------------------------------------------------------

/**
 * Parse a "providerID/modelID" string into its two parts.
 * Returns null if the string is missing or malformed.
 * @param {string} str
 * @returns {{ providerID: string, modelID: string } | null}
 */
export function parseModelString(str) {
  if (!str || typeof str !== "string") return null;
  const idx = str.indexOf("/");
  if (idx <= 0 || idx >= str.length - 1) return null;
  return { providerID: str.slice(0, idx), modelID: str.slice(idx + 1) };
}

/**
 * Return the model object from the providers list if the provider is configured,
 * the model exists, and it is not deprecated.  Otherwise return null.
 * @param {Array<{ id: string, models?: Record<string, { id: string, status?: string }> }>} providers
 * @param {{ providerID: string, modelID: string }} model
 * @returns {object | null}
 */
export function findAvailableModel(providers, { providerID, modelID }) {
  if (!Array.isArray(providers) || !providerID || !modelID) return null;
  const provider = providers.find((p) => p.id === providerID);
  if (!provider) return null;
  const entry = Object.values(provider.models ?? {}).find((m) => m.id === modelID);
  if (!entry || entry.status === "deprecated") return null;
  return entry;
}

/**
 * Resolve the model an agent should use when an override is not available.
 * Checks (in order): agent-specific model in config → global model in config → null.
 * @param {object | null} config  Raw config object (from client.config.get().data)
 * @param {object | null} providersData  Providers response (from client.config.providers().data), used as last resort
 * @param {string} agentID
 * @returns {{ providerID: string, modelID: string } | null}
 */
export function resolveAgentDefaultModel(config, providersData, agentID) {
  if (config) {
    const agentModel = config?.agent?.[agentID]?.model;
    if (agentModel && typeof agentModel === "string") {
      const parsed = parseModelString(agentModel);
      if (parsed) return parsed;
    }
    const globalModel = config?.model;
    if (globalModel && typeof globalModel === "string") {
      const parsed = parseModelString(globalModel);
      if (parsed) return parsed;
    }
  }
  // Last resort: providers.default map (format unknown; try string values containing "/")
  const defaultMap = providersData?.default;
  if (defaultMap && typeof defaultMap === "object") {
    for (const key of [agentID, "", "default"]) {
      const val = defaultMap[key];
      if (val && typeof val === "string") {
        const parsed = parseModelString(val);
        if (parsed) return parsed;
      }
    }
  }
  return null;
}

// Patterns that suggest a model failed to load rather than a logical error in the request.
const LOAD_ERROR_RE =
  /model.*(not found|unavailable|overloaded|does not exist)|failed to load|unable to load|no healthy|cannot load|ECONNREFUSED|connection refused/i;

/**
 * Return true if the session.error payload looks like a model loading / availability failure.
 * Intentionally provider-agnostic.
 * @param {object | undefined} error
 * @returns {boolean}
 */
export function isModelLoadError(error) {
  if (!error) return false;
  const { name } = error;
  if (name === "ProviderAuthError") return true;
  const msg = error.data?.message ?? "";
  if (name === "APIError") {
    const status = error.data?.statusCode;
    if ([400, 404, 500, 502, 503].includes(status)) return true;
    return LOAD_ERROR_RE.test(msg);
  }
  if (name === "UnknownError") return LOAD_ERROR_RE.test(msg);
  return false;
}

export const MODEL_OVERRIDE_SCHEMA_VERSION = 1;
export const MODEL_OVERRIDE_MAX_DEPTH = 16;
export const MODEL_OVERRIDE_COMMAND = Object.freeze({
  name: "model-override",
  title: "Model: override agent model",
  category: "Model",
  namespace: "palette",
  slashName: "model-override",
});
export const AGENT_MODEL_OVERRIDE_COMMAND = Object.freeze({
  name: "agent-model-override",
  title: "Model: override configured agent",
  category: "Model",
  namespace: "palette",
  slashName: "agent-model-override",
});

let storageRoot = join(homedir(), ".local", "state", "opencode");

export function setModelOverrideStorageRoot(root) {
  storageRoot = root;
}

export function modelOverrideDir() {
  return join(storageRoot, "model-overrides");
}

export function modelOverridePath(sessionID) {
  const safe = String(sessionID).replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(modelOverrideDir(), `${safe}.json`);
}

export function agentModelOverridePath() {
  return join(modelOverrideDir(), "agent-model-overrides.json");
}

export function createModelOverrideOwner(pid = process.pid) {
  return { pid, token: randomUUID() };
}

function validOwner(owner) {
  return Number.isInteger(owner?.pid) && owner.pid > 0
    && typeof owner?.token === "string" && owner.token.length > 0;
}

function validRecord(record) {
  if (record?.schemaVersion !== MODEL_OVERRIDE_SCHEMA_VERSION || !validOwner(record.owner)) {
    return false;
  }
  if (record.mode === "default") return true;
  return record.mode === "override"
    && typeof record.model?.providerID === "string" && record.model.providerID.length > 0
    && typeof record.model?.modelID === "string" && record.model.modelID.length > 0;
}

function validModel(model) {
  return typeof model?.providerID === "string" && model.providerID.length > 0
    && typeof model?.modelID === "string" && model.modelID.length > 0;
}

function validAgentRecord(record) {
  return record?.schemaVersion === MODEL_OVERRIDE_SCHEMA_VERSION
    && validOwner(record.owner)
    && record.overrides && typeof record.overrides === "object"
    && !Array.isArray(record.overrides)
    && Object.entries(record.overrides).every(([agentID, model]) => agentID.length > 0 && validModel(model));
}

export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function readModelOverride(sessionID, alive = isProcessAlive) {
  try {
    const record = JSON.parse(readFileSync(modelOverridePath(sessionID), "utf8"));
    if (!validRecord(record) || !alive(record.owner.pid)) return null;
    return record;
  } catch {
    return null;
  }
}

export function writeModelOverride(sessionID, value, owner) {
  if (!validOwner(owner)) throw new Error("A valid model override owner is required.");
  const record = {
    schemaVersion: MODEL_OVERRIDE_SCHEMA_VERSION,
    owner,
    mode: value.mode,
    ...(value.mode === "override" ? { model: value.model } : {}),
  };
  if (!validRecord(record)) throw new Error("Invalid model override value.");

  const directory = modelOverrideDir();
  const target = modelOverridePath(sessionID);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  mkdirSync(directory, { recursive: true });
  try {
    writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
  return record;
}

export function readAgentModelOverrides(alive = isProcessAlive) {
  try {
    const record = JSON.parse(readFileSync(agentModelOverridePath(), "utf8"));
    if (!validAgentRecord(record) || !alive(record.owner.pid)) return null;
    return record;
  } catch {
    return null;
  }
}

export function writeAgentModelOverrides(overrides, owner) {
  if (!validOwner(owner)) throw new Error("A valid model override owner is required.");
  const record = { schemaVersion: MODEL_OVERRIDE_SCHEMA_VERSION, owner, overrides };
  if (!validAgentRecord(record)) throw new Error("Invalid agent model overrides.");

  const directory = modelOverrideDir();
  const target = agentModelOverridePath();
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  mkdirSync(directory, { recursive: true });
  try {
    writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
  return record;
}

export function clearAgentModelOverrides(ownerToken) {
  const record = readAgentModelOverrides(() => true);
  if (ownerToken && record?.owner.token !== ownerToken) return false;
  try {
    rmSync(agentModelOverridePath(), { force: true });
    return true;
  } catch {
    return false;
  }
}

export function updateAgentModelOverride(overrides, agentID, model) {
  const next = { ...(overrides ?? {}) };
  if (model) next[agentID] = model;
  else delete next[agentID];
  return next;
}

export function clearModelOverride(sessionID, ownerToken) {
  const record = readModelOverride(sessionID, () => true);
  if (ownerToken && record?.owner.token !== ownerToken) return false;
  try {
    rmSync(modelOverridePath(sessionID), { force: true });
    return true;
  } catch {
    return false;
  }
}

export async function resolveModelOverride(sessionID, getParentID, options = {}) {
  const read = options.read ?? readModelOverride;
  const maxDepth = options.maxDepth ?? MODEL_OVERRIDE_MAX_DEPTH;
  const seen = new Set();
  let current = sessionID;

  for (let depth = 0; current && depth < maxDepth; depth += 1) {
    if (seen.has(current)) return null;
    seen.add(current);

    const record = read(current);
    if (record) return { ...record, sourceSessionID: current };

    try {
      current = await getParentID(current);
    } catch {
      return null;
    }
  }
  return null;
}

const FREE_LOCAL_PROVIDER_IDS = new Set(["llamaswap"]);
const FREE_MODEL_MARKER = /(?:^|[\s_:/()-])free(?:$|[\s_:/()-])/i;

function isZeroCost(cost) {
  if (!cost || typeof cost !== "object") return false;
  if (cost.input !== 0 || cost.output !== 0) return false;

  const optionalPrices = [
    cost.reasoning,
    cost.cache_read,
    cost.cache_write,
    cost.input_audio,
    cost.output_audio,
    cost.cache?.read,
    cost.cache?.write,
  ];
  if (optionalPrices.some((price) => typeof price === "number" && price !== 0)) return false;

  return (cost.tiers ?? []).every((tier) => isZeroCost(tier));
}

export function isFreeModel(provider, model) {
  if (FREE_LOCAL_PROVIDER_IDS.has(provider?.id)) return true;
  if (isZeroCost(model?.cost)) return true;
  return FREE_MODEL_MARKER.test(model?.id ?? "")
    || FREE_MODEL_MARKER.test(model?.name ?? "");
}

export function availableModelOptions(providers, options = {}) {
  const freeOnly = options.freeOnly ?? false;
  return (providers ?? []).flatMap((provider) =>
    Object.values(provider.models ?? {})
      .filter((model) => model.status !== "deprecated")
      .filter((model) => !freeOnly || isFreeModel(provider, model))
      .map((model) => ({
        title: model.name || model.id,
        value: { providerID: provider.id, modelID: model.id },
        description: `${provider.id}/${model.id}`,
        category: provider.name || provider.id,
      })))
    .sort((left, right) =>
      left.category.localeCompare(right.category) || left.title.localeCompare(right.title));
}

export function availableAgentOptions(agents, overrides = {}) {
  const modeOrder = { primary: 0, all: 1, subagent: 2 };
  return Object.entries(agents ?? {})
    .filter(([, agent]) => agent && agent.disable !== true)
    .map(([agentID, agent]) => {
      const configured = typeof agent.model === "string" ? agent.model : "global default";
      const override = overrides[agentID];
      return {
        title: agentID,
        value: agentID,
        description: override
          ? `Override: ${override.providerID}/${override.modelID} · Configured: ${configured}`
          : `Configured: ${configured}`,
        category: agent.mode === "primary" ? "Primary" : agent.mode === "all" ? "All" : "Subagent",
        mode: agent.mode ?? "subagent",
      };
    })
    .sort((left, right) =>
      (modeOrder[left.mode] ?? 3) - (modeOrder[right.mode] ?? 3)
      || left.title.localeCompare(right.title))
    .map(({ mode: _mode, ...option }) => option);
}

export function formatModelOverride(record) {
  if (!record) return "";
  if (record.mode === "default") return "MODEL agent default";
  return `MODEL ${record.model.providerID}/${record.model.modelID}`;
}

export function createModelOverrideHooks(client, options = {}) {
  const getParentID = async (sessionID) => {
    const response = await client.session.get({ path: { id: sessionID } });
    return response?.data?.parentID ?? null;
  };

  const notify = options.notify ?? (() => {});

  // ---------------------------------------------------------------------------
  // Memoised config and providers (5s TTL).  Guards against no-op when
  // client.config is absent (e.g. in unit tests).
  // ---------------------------------------------------------------------------
  let _config = null;
  let _configExpiry = 0;
  let _providers = null;
  let _providersExpiry = 0;

  async function fetchConfig() {
    if (!client.config?.get) return null;
    const now = Date.now();
    if (_config && now < _configExpiry) return _config;
    try {
      const resp = await client.config.get();
      _config = resp?.data ?? null;
      _configExpiry = now + 5_000;
    } catch { /* ignore; return stale or null */ }
    return _config;
  }

  async function fetchProviders() {
    if (!client.config?.providers) return null;
    const now = Date.now();
    if (_providers && now < _providersExpiry) return _providers;
    try {
      const resp = await client.config.providers();
      _providers = resp?.data ?? null;
      _providersExpiry = now + 5_000;
    } catch { /* ignore */ }
    return _providers;
  }

  // ---------------------------------------------------------------------------
  // Per-session state for Layer 2 (runtime fallback).
  //
  // lastOverrideTurn — the most recent turn where we applied an override model.
  //   Keys:    sessionID
  //   Values:  { messageID, parts, agent, appliedModel, retried }
  //
  // skipOverrideOnce — sessions where the *next* chat.message should skip the
  //   override so the runtime-fallback retry uses the agent default.
  // ---------------------------------------------------------------------------
  /** @type {Map<string, { messageID?: string, parts: any[], agent: string, appliedModel: { providerID: string, modelID: string } | null, retried: boolean }>} */
  const lastOverrideTurn = new Map();
  /** @type {Set<string>} */
  const skipOverrideOnce = new Set();

  // ---------------------------------------------------------------------------
  // Internal helper: apply model with preflight validation.
  // Returns { applied, isFallback }.
  // ---------------------------------------------------------------------------
  async function applyWithPreflight(overrideModel, agentID, sessionID, output) {
    const [config, providersData] = await Promise.all([fetchConfig(), fetchProviders()]);

    if (config || providersData) {
      const providers = providersData?.providers ?? [];
      // Only validate when we actually have provider data to check
      if (providers.length > 0) {
        const available = findAvailableModel(providers, overrideModel);
        if (!available) {
          const agentDefault = resolveAgentDefaultModel(config, providersData, agentID);
          const overrideStr = `${overrideModel.providerID}/${overrideModel.modelID}`;
          const defaultStr = agentDefault
            ? `${agentDefault.providerID}/${agentDefault.modelID}`
            : "agent default";
          console.error(`[model-override] preflight fallback: ${overrideStr} unavailable → ${defaultStr}`);
          notify(
            "⤵ Model fallback",
            `${agentID} / ${String(sessionID).slice(0, 8)}: ${overrideStr} unavailable → ${defaultStr}`,
          );
          if (agentDefault) {
            output.message.model = { providerID: agentDefault.providerID, modelID: agentDefault.modelID };
          }
          return { applied: agentDefault ?? null, isFallback: true };
        }
      }
    }

    // Available (or could not validate) — apply the override as requested.
    output.message.model = { providerID: overrideModel.providerID, modelID: overrideModel.modelID };
    return { applied: overrideModel, isFallback: false };
  }

  return {
    // -------------------------------------------------------------------------
    // chat.message: Layer 1 preflight + turn tracking for Layer 2
    // -------------------------------------------------------------------------
    "chat.message": async (input, output) => {
      const { sessionID } = input;

      // Layer 2 loop guard: if this turn is the runtime-fallback retry, skip
      // the override so the model passed in the re-prompt body takes effect.
      if (skipOverrideOnce.has(sessionID)) {
        skipOverrideOnce.delete(sessionID);
        return;
      }

      // Resolve session-level override (walks parent chain).
      const record = await resolveModelOverride(sessionID, getParentID, options);

      if (record?.mode === "override") {
        const agentID = input.agent ?? output.message.agent;
        const { applied, isFallback } = await applyWithPreflight(record.model, agentID, sessionID, output);
        if (!isFallback) {
          lastOverrideTurn.set(sessionID, {
            messageID: input.messageID,
            parts: [...(output.parts ?? [])],
            agent: agentID,
            appliedModel: applied,
            retried: false,
          });
        } else {
          // Preflight already fell back — no need to track for runtime retry.
          lastOverrideTurn.delete(sessionID);
        }
        return;
      }

      // For mode === "default" or no session record: fall through to agent overrides.
      // ("default" means "do not inherit a parent session override" but agent-level
      // overrides are still applied — original behaviour preserved.)
      const agentID = input.agent ?? output.message.agent;
      const agentRecord = (options.readAgent ?? readAgentModelOverrides)();
      const agentOverrideModel = agentRecord?.overrides?.[agentID];

      if (agentOverrideModel) {
        const { applied, isFallback } = await applyWithPreflight(agentOverrideModel, agentID, sessionID, output);
        if (!isFallback) {
          lastOverrideTurn.set(sessionID, {
            messageID: input.messageID,
            parts: [...(output.parts ?? [])],
            agent: agentID,
            appliedModel: applied,
            retried: false,
          });
        } else {
          lastOverrideTurn.delete(sessionID);
        }
      } else {
        lastOverrideTurn.delete(sessionID);
      }
    },

    // -------------------------------------------------------------------------
    // event: Layer 2 — catch runtime load failures and re-prompt on agent default
    // -------------------------------------------------------------------------
    event: async ({ event }) => {
      if (event.type !== "session.error") return;
      const sessionID = event.properties?.sessionID;
      if (!sessionID) return;

      const turn = lastOverrideTurn.get(sessionID);
      if (!turn || turn.retried) return;

      const error = event.properties?.error;
      if (!isModelLoadError(error)) return;

      // Mark as retried immediately to prevent a second retry if the event fires again.
      turn.retried = true;
      lastOverrideTurn.delete(sessionID);

      // Resolve agent default for the re-prompt.
      let agentDefault = null;
      try {
        const [config, providersData] = await Promise.all([fetchConfig(), fetchProviders()]);
        agentDefault = resolveAgentDefaultModel(config, providersData, turn.agent);
      } catch { /* proceed without explicit model */ }

      const overrideStr = turn.appliedModel
        ? `${turn.appliedModel.providerID}/${turn.appliedModel.modelID}`
        : "override";
      const defaultStr = agentDefault
        ? `${agentDefault.providerID}/${agentDefault.modelID}`
        : "agent default";

      console.error(`[model-override] runtime fallback: ${overrideStr} load error → retrying with ${defaultStr}`);
      notify(
        "⤵ Model fallback",
        `${turn.agent} / ${String(sessionID).slice(0, 8)}: ${overrideStr} failed → retrying with ${defaultStr}`,
      );

      // Ensure the retry's chat.message skips the override so our explicit model wins.
      skipOverrideOnce.add(sessionID);

      try {
        await client.session.prompt({
          path: { id: sessionID },
          body: {
            agent: turn.agent,
            ...(agentDefault ? { model: agentDefault } : {}),
            parts: turn.parts?.length
              ? turn.parts
              : [{ type: "text", text: "(retry with agent default model)" }],
          },
        });
      } catch (err) {
        console.error(`[model-override] runtime fallback: re-prompt failed: ${err?.message}`);
        // Roll back the skip-once flag so a manual retry can still trigger the override.
        skipOverrideOnce.delete(sessionID);
      }
    },
  };
}
