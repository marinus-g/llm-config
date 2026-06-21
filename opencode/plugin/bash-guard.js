/**
 * Bash safety guard plugin for OpenCode
 *
 * HOW IT WORKS
 * ============
 * Intercepts every bash tool call via `tool.execute.before` and blocks
 * commands that match a denylist of irreversible / high-blast-radius patterns.
 * A blocked command throws an error (which the model receives as a tool
 * failure) and shows a TUI toast. In workflow danger mode, a matching
 * destructive-command approval may authorize one exact correlated call.
 *
 * WHY THIS EXISTS
 * ===============
 * Several agents (orchestrator, general-dev, system-admin, dotfiles-dev, etc.)
 * run with bash: allow on local Qwen models with no spend ceiling. A runaway
 * or mistaken command has no API cost as a backstop — this plugin is the
 * safety net.
 *
 * EXEMPT AGENTS
 * =============
 * The hook input does not expose the agent name, so exemptions are handled
 * via a pattern allowlist that broadens certain checks. The patterns are
 * intentionally narrow (they match catastrophic forms, not general use of
 * the same commands).
 *
 * BLOCKED PATTERNS
 *   - rm -rf rooted at / ~ $HOME or with no path narrower than the home tree
 *   - dd writing to block devices
 *   - mkfs (format a filesystem)
 *   - git push --force / -f  (rewrites remote history)
 *   - curl|wget piped directly to sh/bash (remote-code execution)
 *   - chmod -R 777
 *   - :(){ :|:& };:  fork bomb
 *
 * SAFE FORMS (not blocked)
 *   rm -rf ./build      (relative, below cwd)
 *   rm -rf /tmp/foo     (specific path under /tmp)
 *   git push --force-with-lease  (safe force)
 *   curl URL > file.sh && bash file.sh  (inspect-then-run — not blocked here)
 */

import { consumeDestructiveApproval, matchDangerRule } from "../lib/destructive-command.js";

/** @type {import("@opencode-ai/plugin").Plugin} */
export const server = async ({ client }) => {
  const toast = (message, variant = "error") =>
    client.tui.showToast({ body: { message, variant } }).catch(() => {});

  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "bash") return;

      const cmd = (output.args?.command ?? "").trim();
      if (!cmd) return;

      const danger = matchDangerRule(cmd);
      if (!danger) return;
      if (consumeDestructiveApproval(input.sessionID, input.callID, cmd)) return;

      const preview = cmd.length > 80 ? cmd.slice(0, 77) + "…" : cmd;
      toast(`⛔ bash-guard blocked: ${danger.reason}\n${preview}`, "error");
      throw new Error(
        `bash-guard: refused dangerous command (${danger.reason}). ` +
          `Command was: ${cmd.slice(0, 200)}`
      );
    },
  };
};

export default server;
