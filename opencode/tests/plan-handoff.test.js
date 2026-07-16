import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  clearPendingPlan,
  planHandoffDir,
  readPendingPlan,
  setPlanHandoffStorageRoot,
  writePendingPlan,
} from "../lib/plan-handoff.js";

const root = mkdtempSync(join(tmpdir(), "plan-handoff-"));
const owner = { pid: process.pid, token: "test-token-abc" };

before(() => setPlanHandoffStorageRoot(root));
after(() => rmSync(root, { recursive: true, force: true }));

test("planHandoffDir is under the injected storage root", () => {
  assert.ok(planHandoffDir().startsWith(root));
});

test("writePendingPlan creates a readable marker", () => {
  writePendingPlan("session-1", "## Plan\nDo things.", owner);
  const record = readPendingPlan("session-1");
  assert.equal(record.sessionID, "session-1");
  assert.ok(record.planText.includes("Do things."));
  assert.equal(record.owner.token, owner.token);
  assert.ok(typeof record.createdAt === "number");
});

test("readPendingPlan returns null for unknown session", () => {
  assert.equal(readPendingPlan("session-does-not-exist"), null);
});

test("writePendingPlan overwrites an existing marker", () => {
  writePendingPlan("session-overwrite", "first plan", owner);
  writePendingPlan("session-overwrite", "second plan", owner);
  const record = readPendingPlan("session-overwrite");
  assert.equal(record.planText, "second plan");
});

test("writePendingPlan rejects empty plan text", () => {
  assert.throws(() => writePendingPlan("session-empty", "   ", owner), /required/i);
  assert.throws(() => writePendingPlan("session-empty", "", owner), /required/i);
});

test("writePendingPlan rejects invalid owner (no pid)", () => {
  assert.throws(
    () => writePendingPlan("session-bad-owner", "plan text", { pid: "not-a-number", token: "x" }),
    /owner/i,
  );
});

test("writePendingPlan rejects invalid owner (no token)", () => {
  assert.throws(
    () => writePendingPlan("session-bad-owner", "plan text", { pid: 1 }),
    /owner/i,
  );
});

test("clearPendingPlan removes the marker unconditionally when no token is given", () => {
  writePendingPlan("session-clear", "will be cleared", owner);
  const cleared = clearPendingPlan("session-clear");
  assert.equal(cleared, true);
  assert.equal(readPendingPlan("session-clear"), null);
});

test("clearPendingPlan returns true and removes when token matches", () => {
  writePendingPlan("session-clear-token", "plan", owner);
  const cleared = clearPendingPlan("session-clear-token", owner.token);
  assert.equal(cleared, true);
  assert.equal(readPendingPlan("session-clear-token"), null);
});

test("clearPendingPlan returns false when token does not match", () => {
  writePendingPlan("session-wrong-token", "plan", owner);
  const cleared = clearPendingPlan("session-wrong-token", "wrong-token");
  assert.equal(cleared, false);
  // Marker must still be present.
  assert.ok(readPendingPlan("session-wrong-token") !== null);
});

test("clearPendingPlan returns true when there is nothing to clear", () => {
  const cleared = clearPendingPlan("session-never-written");
  assert.equal(cleared, true);
});

test("session IDs with special characters are safely encoded", () => {
  const sid = "session/with:special@chars#and spaces";
  writePendingPlan(sid, "safe path plan", owner);
  const record = readPendingPlan(sid);
  assert.equal(record.sessionID, sid);
  clearPendingPlan(sid);
});
