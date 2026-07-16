import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { server } from "../plugin/tool-loop-guard.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testCounter = 0;

/**
 * Build a fresh mock client + hooks pair for a single test.
 * Each test gets a unique sessionID so the shared module-level sessions Map
 * never collides between tests (even under parallel execution).
 *
 * Returns { hooks, client, sessionID, toasts }.
 */
function createContext() {
  const sessionID = `test-session-${++testCounter}-${Date.now()}`;
  const toasts = [];
  const client = {
    tui: {
      showToast({ body }) {
        toasts.push(body);
        return Promise.resolve();
      },
    },
  };

  return { client, hooks: server({ client }), sessionID, toasts };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tool-loop-guard", () => {

  // -----------------------------------------------------------------------
  // Identical call detection
  // -----------------------------------------------------------------------
  describe("identical call detection", () => {
    it("allows first call to a tool", async () => {
      const { hooks, sessionID } = createContext();
      const h = await hooks;

      await assert.doesNotReject(
        h["tool.execute.before"](
          { sessionID, tool: "bash" },
          { args: { command: "echo hello" } }
        )
      );
    });

    it("allows second identical call (MAX_IDENTICAL_CALLS=2)", async () => {
      const { hooks, sessionID } = createContext();
      const h = await hooks;
      const input = { sessionID, tool: "bash" };
      const output = { args: { command: "echo hello" } };

      await h["tool.execute.before"](input, output);
      await assert.doesNotReject(h["tool.execute.before"](input, output));
    });

    it("blocks third identical call and throws", async () => {
      const { hooks, sessionID } = createContext();
      const h = await hooks;
      const input = { sessionID, tool: "bash" };
      const output = { args: { command: "echo hello" } };

      await h["tool.execute.before"](input, output);
      await h["tool.execute.before"](input, output);

      await assert.rejects(
        h["tool.execute.before"](input, output),
        (err) => {
          assert.ok(err.message.includes("recovery mode"));
          assert.ok(err.message.includes("bash"));
          return true;
        }
      );
    });

    it("does NOT block a 4th call with different args after 3rd was blocked", async () => {
      const { hooks, sessionID } = createContext();
      const h = await hooks;
      const input = { sessionID, tool: "bash" };

      const out1 = { args: { command: "echo hello" } };
      await h["tool.execute.before"](input, out1);
      await h["tool.execute.before"](input, out1);
      await assert.rejects(h["tool.execute.before"](input, out1));

      const out2 = { args: { command: "echo goodbye" } };
      await assert.doesNotReject(h["tool.execute.before"](input, out2));
    });
  });

  // -----------------------------------------------------------------------
  // Per-tool circuit isolation
  // -----------------------------------------------------------------------
  describe("per-tool circuit isolation", () => {
    it("blocking bash does not block edit", async () => {
      const { hooks, sessionID } = createContext();
      const h = await hooks;

      const bashIn = { sessionID, tool: "bash" };
      const bashOut = { args: { command: "echo loop" } };
      await h["tool.execute.before"](bashIn, bashOut);
      await h["tool.execute.before"](bashIn, bashOut);
      await assert.rejects(h["tool.execute.before"](bashIn, bashOut));

      const editIn = { sessionID, tool: "edit" };
      const editOut = { args: { filePath: "/tmp/x", oldString: "a", newString: "b" } };
      await assert.doesNotReject(h["tool.execute.before"](editIn, editOut));
    });

    it("blocking grep does not block bash", async () => {
      const { hooks, sessionID } = createContext();
      const h = await hooks;

      const grepIn = { sessionID, tool: "grep" };
      const grepOut = { args: { pattern: "foo" } };
      await h["tool.execute.before"](grepIn, grepOut);
      await h["tool.execute.before"](grepIn, grepOut);
      await assert.rejects(h["tool.execute.before"](grepIn, grepOut));

      const bashIn = { sessionID, tool: "bash" };
      const bashOut = { args: { command: "ls" } };
      await assert.doesNotReject(h["tool.execute.before"](bashIn, bashOut));
    });

    it("each tool has independent circuit state", async () => {
      const { hooks, sessionID } = createContext();
      const h = await hooks;

      // grep has the default limit of 2: trips on 3rd identical call
      const aIn = { sessionID, tool: "grep" };
      const aOut = { args: { pattern: "foo" } };
      await h["tool.execute.before"](aIn, aOut);
      await h["tool.execute.before"](aIn, aOut);
      await assert.rejects(h["tool.execute.before"](aIn, aOut));

      // glob has MAX_IDENTICAL_BY_TOOL limit of 1: trips on 2nd identical call
      const bIn = { sessionID, tool: "glob" };
      const bOut = { args: { pattern: "*.js" } };
      await h["tool.execute.before"](bIn, bOut);
      await assert.rejects(h["tool.execute.before"](bIn, bOut));

      // read is a third independent tool — tripping grep and glob must not affect it
      const cIn = { sessionID, tool: "read" };
      const cOut = { args: { filePath: "/tmp/test" } };
      await assert.doesNotReject(h["tool.execute.before"](cIn, cOut));
    });
  });

  // -----------------------------------------------------------------------
  // Recovery tools clear all circuits
  // -----------------------------------------------------------------------
  describe("recovery tools", () => {
    it("task tool clears all circuits", async () => {
      const { hooks, sessionID } = createContext();
      const h = await hooks;

      const bashIn = { sessionID, tool: "bash" };
      const bashOut = { args: { command: "echo loop" } };
      await h["tool.execute.before"](bashIn, bashOut);
      await h["tool.execute.before"](bashIn, bashOut);
      await assert.rejects(h["tool.execute.before"](bashIn, bashOut));

      await h["tool.execute.before"]({ sessionID, tool: "task" }, { args: {} });

      await assert.doesNotReject(h["tool.execute.before"](bashIn, bashOut));
    });

    it("question tool clears all circuits", async () => {
      const { hooks, sessionID } = createContext();
      const h = await hooks;

      const bashIn = { sessionID, tool: "bash" };
      const bashOut = { args: { command: "echo loop" } };
      await h["tool.execute.before"](bashIn, bashOut);
      await h["tool.execute.before"](bashIn, bashOut);
      await assert.rejects(h["tool.execute.before"](bashIn, bashOut));

      await h["tool.execute.before"](
        { sessionID, tool: "question" },
        { args: { questions: [] } }
      );

      await assert.doesNotReject(h["tool.execute.before"](bashIn, bashOut));
    });

    it("workflow_control clears all circuits", async () => {
      const { hooks, sessionID } = createContext();
      const h = await hooks;

      const bashIn = { sessionID, tool: "bash" };
      const bashOut = { args: { command: "echo loop" } };
      await h["tool.execute.before"](bashIn, bashOut);
      await h["tool.execute.before"](bashIn, bashOut);
      await assert.rejects(h["tool.execute.before"](bashIn, bashOut));

      await h["tool.execute.before"](
        { sessionID, tool: "workflow_control" },
        { args: { action: "status" } }
      );

      await assert.doesNotReject(h["tool.execute.before"](bashIn, bashOut));
    });

    it("workflow_verify clears all circuits", async () => {
      const { hooks, sessionID } = createContext();
      const h = await hooks;

      const bashIn = { sessionID, tool: "bash" };
      const bashOut = { args: { command: "echo loop" } };
      await h["tool.execute.before"](bashIn, bashOut);
      await h["tool.execute.before"](bashIn, bashOut);
      await assert.rejects(h["tool.execute.before"](bashIn, bashOut));

      await h["tool.execute.before"](
        { sessionID, tool: "workflow_verify" },
        { args: {} }
      );

      await assert.doesNotReject(h["tool.execute.before"](bashIn, bashOut));
    });

    it("workflow_commit clears all circuits", async () => {
      const { hooks, sessionID } = createContext();
      const h = await hooks;

      const bashIn = { sessionID, tool: "bash" };
      const bashOut = { args: { command: "echo loop" } };
      await h["tool.execute.before"](bashIn, bashOut);
      await h["tool.execute.before"](bashIn, bashOut);
      await assert.rejects(h["tool.execute.before"](bashIn, bashOut));

      await h["tool.execute.before"](
        { sessionID, tool: "workflow_commit" },
        { args: {} }
      );

      await assert.doesNotReject(h["tool.execute.before"](bashIn, bashOut));
    });

    it("non-recovery tools do NOT clear circuits", async () => {
      const { hooks, sessionID } = createContext();
      const h = await hooks;

      const bashIn = { sessionID, tool: "bash" };
      const bashOut = { args: { command: "echo loop" } };
      await h["tool.execute.before"](bashIn, bashOut);
      await h["tool.execute.before"](bashIn, bashOut);
      await assert.rejects(h["tool.execute.before"](bashIn, bashOut));

      await h["tool.execute.before"](
        { sessionID, tool: "read" },
        { args: { filePath: "/tmp/x" } }
      );

      await assert.rejects(h["tool.execute.before"](bashIn, bashOut));
    });
  });

  // -----------------------------------------------------------------------
  // Permission loop detection
  // -----------------------------------------------------------------------
  describe("permission loop detection", () => {
    it("allows first permission ask", async () => {
      const { hooks, sessionID } = createContext();
      const h = await hooks;

      const input = { sessionID, type: "tool_execution", pattern: ["bash"] };
      const output = { status: "pending" };
      await h["permission.ask"](input, output);
      assert.strictEqual(output.status, "pending");
    });

    it("allows second identical permission ask", async () => {
      const { hooks, sessionID } = createContext();
      const h = await hooks;

      const input = { sessionID, type: "tool_execution", pattern: ["bash"] };
      const output1 = { status: "pending" };
      await h["permission.ask"](input, output1);

      const output2 = { status: "pending" };
      await h["permission.ask"](input, output2);
      assert.strictEqual(output2.status, "pending");
    });

    it("blocks third identical permission ask", async () => {
      const { hooks, sessionID } = createContext();
      const h = await hooks;

      const input = { sessionID, type: "tool_execution", pattern: ["bash"] };
      await h["permission.ask"](input, { status: "pending" });
      await h["permission.ask"](input, { status: "pending" });
      const third = { status: "pending" };
      await h["permission.ask"](input, third);
      assert.strictEqual(third.status, "deny");
    });

    it("different permission type is not blocked by another type", async () => {
      const { hooks, sessionID } = createContext();
      const h = await hooks;

      const a = { sessionID, type: "tool_execution", pattern: ["bash"] };
      await h["permission.ask"](a, { status: "pending" });
      await h["permission.ask"](a, { status: "pending" });
      await h["permission.ask"](a, { status: "pending" });

      const bOut = { status: "pending" };
      const b = { sessionID, type: "write", pattern: ["*.lua"] };
      await h["permission.ask"](b, bOut);
      assert.strictEqual(bOut.status, "pending");
    });
  });

  // -----------------------------------------------------------------------
  // Time window expiry
  // -----------------------------------------------------------------------
  describe("time window expiry", () => {
    it("old entries expire so they do not count as repeats", async () => {
      const { hooks, sessionID } = createContext();
      const h = await hooks;

      const input = { sessionID, tool: "bash" };
      const output = { args: { command: "echo hello" } };

      await h["tool.execute.before"](input, output);
      await h["tool.execute.before"](input, output);

      const realNow = Date.now;
      globalThis.Date.now = () => realNow() + 95_000;

      try {
        await assert.doesNotReject(h["tool.execute.before"](input, output));
      } finally {
        globalThis.Date.now = realNow;
      }
    });
  });

  // -----------------------------------------------------------------------
  // Session cleanup
  // -----------------------------------------------------------------------
  describe("session cleanup", () => {
    it("deletes session state on session.deleted event", async () => {
      const { hooks, sessionID } = createContext();
      const h = await hooks;

      const input = { sessionID, tool: "bash" };
      const output = { args: { command: "echo hello" } };
      await h["tool.execute.before"](input, output);
      await h["tool.execute.before"](input, output);
      await assert.rejects(h["tool.execute.before"](input, output));

      await h.event({
        event: {
          type: "session.deleted",
          properties: { sessionID },
        },
      });

      await assert.doesNotReject(h["tool.execute.before"](input, output));
    });
  });

  // -----------------------------------------------------------------------
  // Success clears circuit
  // -----------------------------------------------------------------------
  describe("success clears circuit", () => {
    it("tool.execute.after with success clears that tool circuit", async () => {
      const { hooks, sessionID } = createContext();
      const h = await hooks;

      const bashIn = { sessionID, tool: "bash" };
      const bashOut = { args: { command: "echo loop" } };
      await h["tool.execute.before"](bashIn, bashOut);
      await h["tool.execute.before"](bashIn, bashOut);
      await assert.rejects(h["tool.execute.before"](bashIn, bashOut));

      await h["tool.execute.after"]({ sessionID, tool: "bash" }, {});

      await assert.doesNotReject(h["tool.execute.before"](bashIn, bashOut));
    });

    it("success on tool A does not clear circuit on tool B", async () => {
      const { hooks, sessionID } = createContext();
      const h = await hooks;

      const bashIn = { sessionID, tool: "bash" };
      const bashOut = { args: { command: "echo loop" } };
      await h["tool.execute.before"](bashIn, bashOut);
      await h["tool.execute.before"](bashIn, bashOut);
      await assert.rejects(h["tool.execute.before"](bashIn, bashOut));

      await h["tool.execute.after"]({ sessionID, tool: "edit" }, {});

      await assert.rejects(h["tool.execute.before"](bashIn, bashOut));
    });
  });

  // -----------------------------------------------------------------------
  // Toast notifications
  // -----------------------------------------------------------------------
  describe("toast notifications", () => {
    it("emits a toast when a tool loop is blocked", async () => {
      const { hooks, sessionID, toasts } = createContext();
      const h = await hooks;

      const input = { sessionID, tool: "bash" };
      const output = { args: { command: "echo hello" } };
      await h["tool.execute.before"](input, output);
      await h["tool.execute.before"](input, output);
      await assert.rejects(h["tool.execute.before"](input, output));

      assert.ok(toasts.some((t) => t.message.includes("Tool loop blocked")));
    });

    it("emits a toast when a permission loop is blocked", async () => {
      const { hooks, sessionID, toasts } = createContext();
      const h = await hooks;

      const input = { sessionID, type: "tool_execution", pattern: ["bash"] };
      await h["permission.ask"](input, { status: "pending" });
      await h["permission.ask"](input, { status: "pending" });
      await h["permission.ask"](input, { status: "pending" });

      assert.ok(toasts.some((t) => t.message.includes("Permission loop blocked")));
    });
  });

  // -----------------------------------------------------------------------
  // Cross-session isolation
  // -----------------------------------------------------------------------
  describe("cross-session isolation", () => {
    it("sessions are independent", async () => {
      const sid1 = `cross-session-A-${Date.now()}`;
      const sid2 = `cross-session-B-${Date.now()}`;
      const { hooks } = createContext();
      const h = await hooks;

      const inA = { sessionID: sid1, tool: "bash" };
      const outA = { args: { command: "echo loop" } };
      await h["tool.execute.before"](inA, outA);
      await h["tool.execute.before"](inA, outA);
      await assert.rejects(h["tool.execute.before"](inA, outA));

      const inB = { sessionID: sid2, tool: "bash" };
      const outB = { args: { command: "echo loop" } };
      await assert.doesNotReject(h["tool.execute.before"](inB, outB));
    });
  });

  // -----------------------------------------------------------------------
  // stableStringify determinism
  // -----------------------------------------------------------------------
  describe("stableStringify determinism", () => {
    it("object key order does not affect the call key", async () => {
      const { hooks, sessionID } = createContext();
      const h = await hooks;

      const in1 = { sessionID, tool: "edit" };
      const out1 = { args: { z: 1, a: 2 } };
      const out2 = { args: { a: 2, z: 1 } };

      await h["tool.execute.before"](in1, out1);
      await h["tool.execute.before"](in1, out2);
      const out3 = { args: { z: 1, a: 2 } };
      await assert.rejects(h["tool.execute.before"](in1, out3));
    });
  });
});
