/** Shared context-window accounting for pressure-aware plugins. */

export const CONTEXT_WARNING_FRACTION = 0.80;
export const DEFAULT_CONTEXT_LIMIT = 60_000;

const sessions = new Map();

export function effectiveInputTokens(tokens = {}) {
  return (tokens.input ?? 0) + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0);
}

export function recordContextPressure({ sessionID, tokens, limit, providerID, modelID }) {
  if (!sessionID || !limit) return null;
  const used = effectiveInputTokens(tokens);
  if (!used) return sessions.get(sessionID) ?? null;
  const pressure = { sessionID, used, limit, fraction: used / limit, providerID, modelID };
  sessions.set(sessionID, pressure);
  return pressure;
}

export function getContextPressure(sessionID) {
  return sessions.get(sessionID) ?? null;
}

export function clearContextPressure(sessionID) {
  sessions.delete(sessionID);
}

export async function resolveContextConfig(client, info = {}) {
  try {
    const cfg = (await client.config.get())?.data;
    if (!cfg) return null;

    let providerID = info.providerID ?? "";
    let modelID = info.modelID ?? "";
    if (!providerID || !modelID) {
      const model = cfg.model ?? cfg.small_model ?? "";
      const slash = model.indexOf("/");
      if (slash < 0) return null;
      providerID ||= model.slice(0, slash);
      modelID ||= model.slice(slash + 1);
    }

    const configured = cfg.provider?.[providerID]?.models?.[modelID]?.limit?.context;
    return { providerID, modelID, limit: configured ?? DEFAULT_CONTEXT_LIMIT };
  } catch {
    return null;
  }
}

export function resetContextPressureForTests() {
  sessions.clear();
}
