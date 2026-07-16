import test from "node:test";
import assert from "node:assert/strict";
import {
  findCurrentTurnUser,
  loadSessionWindowUsage,
  loadTokenTotals,
  shouldShowElapsed,
  sumAssistantWindowUsage,
  sumAssistantUsage,
} from "../lib/session-hud-message.js";

const user = (id) => ({ id, role: "user", time: { created: 1 } });
const assistant = (id, parentID) => ({ id, role: "assistant", parentID });

test("ignores a queued user after the current turn", () => {
  const current = user("current");
  const queued = user("queued");

  assert.equal(
    findCurrentTurnUser([current, assistant("reply", current.id), queued]),
    current,
  );
});

test("switches to a queued user when its assistant turn starts", () => {
  const previous = user("previous");
  const current = user("current");

  assert.equal(
    findCurrentTurnUser([
      previous,
      assistant("previous-reply", previous.id),
      current,
      assistant("current-reply", current.id),
    ]),
    current,
  );
});

test("handles multiple assistant messages for the same user", () => {
  const current = user("current");

  assert.equal(
    findCurrentTurnUser([
      current,
      assistant("reply-1", current.id),
      assistant("reply-2", current.id),
    ]),
    current,
  );
});

test("selects the latest linked user across completed turns", () => {
  const previous = user("previous");
  const current = user("current");

  assert.equal(
    findCurrentTurnUser([
      previous,
      assistant("previous-reply", previous.id),
      current,
      assistant("current-reply", current.id),
    ]),
    current,
  );
});

test("does not depend on where assistant messages appear in the array", () => {
  const current = user("current");
  const queued = user("queued");

  assert.equal(
    findCurrentTurnUser([assistant("reply", current.id), current, queued]),
    current,
  );
});

test("ignores assistants with missing, empty, or unmatched parent IDs", () => {
  const queued = user("queued");

  assert.equal(
    findCurrentTurnUser([
      queued,
      { id: "missing", role: "assistant" },
      assistant("empty", ""),
      assistant("unmatched", "other-user"),
    ]),
    undefined,
  );
});

test("returns undefined when all user messages are queued", () => {
  assert.equal(findCurrentTurnUser([user("first"), user("second")]), undefined);
});

test("returns undefined for an empty message list", () => {
  assert.equal(findCurrentTurnUser([]), undefined);
});

test("hides only elapsed durations that format as 0s", () => {
  assert.equal(shouldShowElapsed(-1), false);
  assert.equal(shouldShowElapsed(0), false);
  assert.equal(shouldShowElapsed(999), false);
  assert.equal(shouldShowElapsed(1_000), true);
});

const completed = (id, parentID, created, input, output, options = {}) => ({
  info: {
    id,
    role: "assistant",
    parentID,
    time: { created },
  },
  parts: [{
    type: "step-finish",
    tokens: {
      input,
      output,
      reasoning: options.reasoning ?? 0,
      cache: {
        read: options.cacheRead ?? 0,
        write: options.cacheWrite ?? 0,
      },
    },
    cost: options.cost ?? 0,
  }],
});

test("sums step-finish usage and applies an inclusive turn cutoff", () => {
  const messages = [
    completed("old", "old-user", 99, 10, 2),
    completed("current", "current-user", 100, 20, 3, {
      reasoning: 4,
      cacheRead: 30,
      cacheWrite: 40,
      cost: 0.25,
    }),
  ];

  assert.deepEqual(sumAssistantUsage(messages), {
    up: 100,
    down: 9,
    cost: 0.25,
  });
  assert.deepEqual(sumAssistantUsage(messages, 100), {
    up: 90,
    down: 7,
    cost: 0.25,
  });
});

function clientFor(sessions, children = {}) {
  return {
    session: {
      messages: async ({ path: { id } }) => ({ data: sessions[id] ?? [] }),
      children: async ({ path: { id } }) => ({ data: children[id] ?? [] }),
    },
  };
}

test("uses the plugin client's path parameter for session requests", async () => {
  const requests = [];
  const client = {
    session: {
      messages: async (request) => {
        requests.push(["messages", request]);
        return { data: [] };
      },
      children: async (request) => {
        requests.push(["children", request]);
        return { data: [] };
      },
    },
  };

  await loadSessionWindowUsage(client, "root", 100, 200);

  assert.deepEqual(requests, [
    ["messages", { path: { id: "root" } }],
    ["children", { path: { id: "root" } }],
  ]);
});

test("uses the TUI v2 sessionID parameter for HUD token requests", async () => {
  const requests = [];
  const sessions = {
    root: [completed("root-reply", "root-user", 100, 10, 1)],
    child: [completed("child-reply", "child-user", 110, 20, 2)],
  };
  const client = {
    session: {
      messages: async (request) => {
        requests.push(["messages", request]);
        return { data: sessions[request.sessionID] ?? [] };
      },
      children: async (request) => {
        requests.push(["children", request]);
        return { data: request.sessionID === "root" ? [{ id: "child" }] : [] };
      },
    },
  };

  const totals = await loadTokenTotals(client, "root", "v2");

  assert.deepEqual(totals.total, { up: 30, down: 3, cost: 0 });
  assert.deepEqual(requests, [
    ["messages", { sessionID: "root" }],
    ["children", { sessionID: "root" }],
    ["messages", { sessionID: "child" }],
    ["children", { sessionID: "child" }],
  ]);
});

test("keeps a queued message on the previous turn until its reply starts", async () => {
  const previous = { ...user("previous"), time: { created: 100 } };
  const queued = { ...user("queued"), time: { created: 200 } };
  const sessions = {
    root: [
      { info: previous, parts: [] },
      completed("previous-reply", previous.id, 100, 10, 1),
      { info: queued, parts: [] },
    ],
  };

  const before = await loadTokenTotals(clientFor(sessions), "root");
  assert.deepEqual(before.turn, before.total);

  sessions.root.push(completed("queued-reply", queued.id, 200, 20, 2));
  const after = await loadTokenTotals(clientFor(sessions), "root");
  assert.deepEqual(after.turn, { up: 20, down: 2, cost: 0 });
  assert.deepEqual(after.total, { up: 30, down: 3, cost: 0 });
});

test("includes descendant usage created during the current turn", async () => {
  const current = { ...user("current"), time: { created: 200 } };
  const sessions = {
    root: [
      { info: current, parts: [] },
      completed("root-reply", current.id, 200, 10, 1),
    ],
    child: [
      completed("old-child-reply", "child-user-1", 150, 20, 2),
      completed("new-child-reply", "child-user-2", 250, 30, 3),
    ],
  };
  const client = clientFor(sessions, { root: [{ id: "child" }] });

  const totals = await loadTokenTotals(client, "root");
  assert.deepEqual(totals.turn, { up: 40, down: 4, cost: 0 });
  assert.deepEqual(totals.total, { up: 60, down: 6, cost: 0 });
});

test("returns a zero turn total when no user message has started", async () => {
  const sessions = {
    root: [completed("orphan", "missing-user", 100, 10, 1)],
  };

  const totals = await loadTokenTotals(clientFor(sessions), "root");
  assert.deepEqual(totals.turn, { up: 0, down: 0, cost: 0 });
  assert.deepEqual(totals.total, { up: 10, down: 1, cost: 0 });
});

test("sums detailed usage within an inclusive window", () => {
  const messages = [
    completed("before", "user-1", 99, 100, 100),
    completed("first", "user-2", 100, 10, 2, { reasoning: 3, cacheRead: 4, cacheWrite: 5, cost: 0.1 }),
    completed("last", "user-3", 200, 20, 6, { cost: 0.2 }),
    completed("after", "user-4", 201, 100, 100),
  ];
  messages[1].info.agent = "orchestrator";
  messages[2].info.agent = "step-planner";

  const usage = sumAssistantWindowUsage(messages, 100, 200);
  assert.deepEqual(usage.tokens, {
    input: 30, output: 8, reasoning: 3, cacheRead: 4, cacheWrite: 5, total: 50,
  });
  assert.ok(Math.abs(usage.cost - 0.3) < Number.EPSILON);
  assert.deepEqual([...usage.agents].sort(), ["orchestrator", "step-planner"]);
});

test("loads windowed usage and agents from nested session descendants", async () => {
  const rootMessage = completed("root-reply", "root-user", 100, 10, 1);
  rootMessage.info.agent = "orchestrator";
  const childMessage = completed("child-reply", "child-user", 110, 20, 2);
  childMessage.info.agent = "step-planner";
  const grandchildMessage = completed("grandchild-reply", "grandchild-user", 120, 30, 3);
  grandchildMessage.info.agent = "step-orchestrator";
  const client = clientFor({ root: [rootMessage], child: [childMessage], grandchild: [grandchildMessage] }, {
    root: [{ id: "child" }], child: [{ id: "grandchild" }],
  });

  const usage = await loadSessionWindowUsage(client, "root", 100, 120);
  assert.equal(usage.tokens.total, 66);
  assert.deepEqual(usage.agents, ["orchestrator", "step-orchestrator", "step-planner"]);
  assert.deepEqual(usage.subagents, ["step-orchestrator", "step-planner"]);
});
