/**
 * CodeGraph reindex nudge plugin for OpenCode
 *
 * HOW IT WORKS
 * ============
 * After any file write/edit by an agent, checks whether a `.codegraph/`
 * directory exists in the current session's project directory.  If it does,
 * debounces 2.5 seconds (to collapse burst edits) and then runs
 * `codegraph reindex` so the knowledge graph stays fresh.
 *
 * GATING
 * ======
 * Completely inert in repos that don't have CodeGraph initialized.
 * The fs.existsSync check on `.codegraph/` is done per tool call — it is
 * intentionally re-checked each time so that a project that initialises
 * CodeGraph mid-session picks it up without a restart.
 *
 * WHY THIS EXISTS
 * ===============
 * Agents are instructed to trust codegraph over grep (AGENTS.md, CLAUDE.md).
 * The `codegraph serve --mcp` file watcher debounces ~500ms, but only while
 * the MCP server is running inside the same opencode instance.  In practice
 * the MCP server may lag or miss edits during rapid batch writes.  This
 * plugin provides a belt-and-suspenders reindex with a longer debounce that
 * collapses the whole burst before touching the index.
 *
 * CAVEAT
 * ======
 * If the MCP watcher already keeps the index perfectly fresh in your
 * environment, this plugin is a no-op safety net (reindexing when the
 * index is already current is cheap).  Verify with:
 *   1. Edit a file.
 *   2. Wait ~3s.
 *   3. Call codegraph_status — check the `indexed_at` timestamp.
 * If the timestamp advances reliably without this plugin, you can disable
 * it by removing the file or adding it to the `plugin` allowlist in
 * opencode.json.
 *
 * COMMANDS WATCHED
 *   edit, write, patch  — the three tool names OpenCode uses for file changes
 */

import { existsSync } from "fs";
import { join } from "path";

/** @type {import("@opencode-ai/plugin").Plugin} */
export const server = async ({ $, directory }) => {
  let reindexTimer = null;

  function scheduleReindex(projectDir) {
    // Only act if .codegraph/ exists in the project directory
    if (!existsSync(join(projectDir, ".codegraph"))) return;

    if (reindexTimer !== null) clearTimeout(reindexTimer);

    reindexTimer = setTimeout(async () => {
      reindexTimer = null;
      // Re-check existence in case directory changed between scheduling and firing
      if (!existsSync(join(projectDir, ".codegraph"))) return;
      try {
        await $`codegraph reindex`.quiet().nothrow();
      } catch {
        // Reindex failure is non-fatal — the MCP watcher is the primary mechanism
      }
    }, 2500);
  }

  return {
    "tool.execute.after": async (input) => {
      if (!["edit", "write", "patch"].includes(input.tool)) return;
      scheduleReindex(directory);
    },
  };
};
