/** Durable per-session "pending plan" markers for the plan-gate approval flow.
 *
 *  When the plan agent calls present_plan, the plan text and owner are stored
 *  here so both the server plugin and TUI plugin can read the same data
 *  without shared memory. Follows the same convention as lib/danger-mode.js
 *  and lib/model-override.js: atomic temp-file write, owner-pid validation,
 *  injectable storage root for tests.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

let storageRoot = join(homedir(), ".local", "state", "opencode");
export function setPlanHandoffStorageRoot(root) { storageRoot = root; }
export function planHandoffDir() { return join(storageRoot, "plan-handoff"); }

function markerPath(sessionID) {
  const safe = String(sessionID).replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(planHandoffDir(), `${safe}.json`);
}

function validOwner(owner) {
  return Number.isInteger(owner?.pid) && owner.pid > 0
    && typeof owner?.token === "string" && owner.token.length > 0;
}

/** Write a pending plan marker for sessionID. Throws if owner or planText invalid. */
export function writePendingPlan(sessionID, planText, owner) {
  if (!validOwner(owner)) throw new Error("A valid owner is required.");
  if (typeof planText !== "string" || !planText.trim()) throw new Error("Plan text is required.");
  const dir = planHandoffDir();
  mkdirSync(dir, { recursive: true });
  const target = markerPath(sessionID);
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const record = { sessionID, planText, createdAt: Date.now(), owner };
  try {
    writeFileSync(tmp, JSON.stringify(record, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, target);
  } finally {
    rmSync(tmp, { force: true });
  }
  return record;
}

/** Read the pending plan for sessionID. Returns null if absent or malformed. */
export function readPendingPlan(sessionID) {
  try {
    const raw = JSON.parse(readFileSync(markerPath(sessionID), "utf8"));
    if (raw?.sessionID !== sessionID || typeof raw?.planText !== "string") return null;
    return raw;
  } catch {
    return null;
  }
}

/** Clear the pending plan marker.
 *  If ownerToken is supplied, returns false (and does nothing) when the token
 *  does not match the stored owner — preventing other sessions from deleting it. */
export function clearPendingPlan(sessionID, ownerToken) {
  if (ownerToken !== undefined) {
    const record = readPendingPlan(sessionID);
    if (record?.owner?.token !== ownerToken) return false;
  }
  try {
    rmSync(markerPath(sessionID), { force: true });
    return true;
  } catch {
    return false;
  }
}
