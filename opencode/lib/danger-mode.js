/** Durable per-session danger-mode markers.
 *
 *  Danger mode bypasses command/edit approval prompts for a session while a
 *  workflow is attached. State is stored as empty marker files under
 *  ~/.local/state/opencode/danger/<sessionID> so both the server plugin and
 *  the TUI plugin can read the same flag without shared memory.
 *
 *  Markers survive plugin reloads and are cleared by workflow terminal actions
 *  (danger off, stop, reset, completion, or transfer to another session).
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

let storageRoot = join(homedir(), ".local", "state", "opencode");
export function setDangerStorageRoot(root) { storageRoot = root; }

export function dangerDir() {
  return join(storageRoot, "danger");
}

/** Sanitise a session ID so it is safe as a filename. */
function markerPath(sessionID) {
  const safe = String(sessionID).replace(/[^a-zA-Z0-9_\-]/g, "_");
  return join(dangerDir(), safe);
}

/** Returns true if danger mode is active for sessionID. */
export function isDanger(sessionID) {
  return existsSync(markerPath(sessionID));
}

/** Enable or disable danger mode for sessionID. */
export function setDanger(sessionID, on) {
  if (on) {
    mkdirSync(dangerDir(), { recursive: true });
    writeFileSync(markerPath(sessionID), "");
  } else {
    try {
      rmSync(markerPath(sessionID), { force: true });
    } catch {
      // already absent — fine
    }
  }
}

/** Wipe all danger markers. Primarily useful for tests and administrative cleanup. */
export function clearAllDanger() {
  rmSync(dangerDir(), { recursive: true, force: true });
}
