/**
 * Find the latest user message that has started an assistant turn.
 * Newer user messages without an assistant child are still queued.
 */
export function findCurrentTurnUser(messages) {
  const assistantParentIDs = new Set();

  for (const message of messages) {
    if (message?.role === "assistant" && message.parentID) {
      assistantParentIDs.add(message.parentID);
    }
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user" && assistantParentIDs.has(message.id)) {
      return message;
    }
  }

  return undefined;
}

/** The formatter floors milliseconds, so values below one second display as 0s. */
export function shouldShowElapsed(elapsedMs) {
  return elapsedMs >= 1_000;
}

function emptyTotals() {
  return { up: 0, down: 0, cost: 0 };
}

function emptyUsage() {
  return {
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
    agents: new Set(),
  };
}

function addTotals(target, source) {
  target.up += source.up;
  target.down += source.down;
  target.cost += source.cost;
}

/** Sum completed assistant steps, optionally excluding messages before a turn. */
export function sumAssistantUsage(messages, since) {
  const totals = emptyTotals();

  for (const { info, parts } of messages) {
    if (info?.role !== "assistant") continue;
    if (since !== undefined && (info.time?.created ?? -Infinity) < since) continue;

    for (const part of parts ?? []) {
      if (part.type !== "step-finish") continue;
      totals.up += (part.tokens?.input ?? 0)
        + (part.tokens?.cache?.read ?? 0)
        + (part.tokens?.cache?.write ?? 0);
      totals.down += (part.tokens?.output ?? 0)
        + (part.tokens?.reasoning ?? 0);
      totals.cost += part.cost ?? 0;
    }
  }

  return totals;
}

function addWindowUsage(target, source) {
  for (const key of ["input", "output", "reasoning", "cacheRead", "cacheWrite", "total"]) {
    target.tokens[key] += source.tokens[key];
  }
  target.cost += source.cost;
  for (const agent of source.agents) target.agents.add(agent);
}

function sessionRequest(sessionID, requestFormat) {
  if (requestFormat === "v2") return { sessionID };
  if (requestFormat === "legacy") return { path: { id: sessionID } };
  throw new Error(`Unsupported session client request format: ${requestFormat}`);
}

/** Sum completed assistant steps created within an inclusive time window. */
export function sumAssistantWindowUsage(messages, since, until = Date.now()) {
  const usage = emptyUsage();
  for (const { info, parts } of messages) {
    if (info?.role !== "assistant") continue;
    const created = info.time?.created;
    if (created === undefined || created < since || created > until) continue;
    if (info.agent) usage.agents.add(info.agent);

    for (const part of parts ?? []) {
      if (part.type !== "step-finish") continue;
      const input = part.tokens?.input ?? 0;
      const output = part.tokens?.output ?? 0;
      const reasoning = part.tokens?.reasoning ?? 0;
      const cacheRead = part.tokens?.cache?.read ?? 0;
      const cacheWrite = part.tokens?.cache?.write ?? 0;
      usage.tokens.input += input;
      usage.tokens.output += output;
      usage.tokens.reasoning += reasoning;
      usage.tokens.cacheRead += cacheRead;
      usage.tokens.cacheWrite += cacheWrite;
      usage.tokens.total += input + output + reasoning + cacheRead + cacheWrite;
      usage.cost += part.cost ?? 0;
    }
  }
  return usage;
}

async function loadSessionWindowTree(client, sessionID, since, until, depth, seen, requestFormat) {
  const usage = emptyUsage();
  if (depth > 12 || seen.has(sessionID)) return usage;
  seen.add(sessionID);

  const messages = (await client.session.messages(sessionRequest(sessionID, requestFormat)))?.data ?? [];
  addWindowUsage(usage, sumAssistantWindowUsage(messages, since, until));
  const children = typeof client.session.children === "function"
    ? (await client.session.children(sessionRequest(sessionID, requestFormat)))?.data ?? []
    : [];
  for (const child of children) {
    addWindowUsage(usage, await loadSessionWindowTree(
      client, child.id, since, until, depth + 1, seen, requestFormat,
    ));
  }
  return usage;
}

/** Load detailed usage for a session tree within an inclusive time window. */
export async function loadSessionWindowUsage(
  client,
  sessionID,
  since,
  until = Date.now(),
  primaryAgent = "orchestrator",
  requestFormat = "legacy",
) {
  const usage = await loadSessionWindowTree(
    client, sessionID, since, until, 0, new Set(), requestFormat,
  );
  return {
    tokens: usage.tokens,
    cost: usage.cost,
    agents: [...usage.agents].sort(),
    subagents: [...usage.agents].filter((agent) => agent !== primaryAgent).sort(),
  };
}

async function sumSessionTree(
  client,
  sessionID,
  since,
  depth = 0,
  seen = new Set(),
  ownMessages,
  requestFormat = "legacy",
) {
  const result = { total: emptyTotals(), turn: emptyTotals() };
  if (depth > 5 || seen.has(sessionID)) return result;
  seen.add(sessionID);

  const messages = ownMessages
    ?? (await client.session.messages(sessionRequest(sessionID, requestFormat)))?.data
    ?? [];
  addTotals(result.total, sumAssistantUsage(messages));
  if (since !== undefined) {
    addTotals(result.turn, sumAssistantUsage(messages, since));
  }

  const children = typeof client.session.children === "function"
    ? (await client.session.children(sessionRequest(sessionID, requestFormat)))?.data ?? []
    : [];
  for (const child of children) {
    const childResult = await sumSessionTree(
      client,
      child.id,
      since,
      depth + 1,
      seen,
      undefined,
      requestFormat,
    );
    addTotals(result.total, childResult.total);
    addTotals(result.turn, childResult.turn);
  }

  return result;
}

/** Load cumulative and current-turn usage for a session and all descendants. */
export async function loadTokenTotals(client, sessionID, requestFormat = "legacy") {
  const response = await client.session.messages(sessionRequest(sessionID, requestFormat));
  const messages = response?.data ?? [];
  const currentUser = findCurrentTurnUser(messages.map(({ info }) => info));
  const since = currentUser?.time?.created;

  return sumSessionTree(
    client,
    sessionID,
    since,
    0,
    new Set(),
    messages,
    requestFormat,
  );
}
