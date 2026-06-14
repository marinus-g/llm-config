/**
 * Bash safety guard plugin for OpenCode
 *
 * HOW IT WORKS
 * ============
 * Intercepts every bash tool call via `tool.execute.before` and blocks
 * commands that match a denylist of irreversible / high-blast-radius patterns.
 * A blocked command throws an error (which the model receives as a tool
 * failure) and shows a TUI toast.
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

/**
 * Each entry is { pattern: RegExp, reason: string }.
 * If ANY pattern matches the full command string, the call is blocked.
 */
const DANGER_RULES = [
  // rm -rf targeting filesystem roots or home directory
  {
    pattern: /\brm\s+(-\S*r\S*f|-\S*f\S*r)\s+(\/|~|"\$HOME"|\$HOME|"\$\{HOME\}"|\$\{HOME\})\s*$/im,
    reason: "rm -rf on / or $HOME",
  },
  {
    pattern: /\brm\s+(-\S*r\S*f|-\S*f\S*r)\s+(\/|~|"\$HOME"|\$HOME|"\$\{HOME\}"|\$\{HOME\})[\s/]/im,
    reason: "rm -rf rooted at / or $HOME",
  },
  // dd writing to block devices
  {
    pattern: /\bdd\b[^#\n]*\bof\s*=\s*\/dev\//i,
    reason: "dd writing to block device",
  },
  // mkfs (format a filesystem)
  {
    pattern: /\bmkfs(\.\w+)?\s+\//i,
    reason: "mkfs on a device",
  },
  // git push --force or -f (but NOT --force-with-lease, which is safe)
  {
    pattern: /\bgit\s+push\b(?!.*--force-with-lease).*\s(--force|-f)\b/i,
    reason: "git push --force (use --force-with-lease instead)",
  },
  // curl | sh/bash or wget | sh/bash (remote-code execution)
  {
    pattern: /\b(curl|wget)\b[^|#\n]*\|\s*(sudo\s+)?(ba)?sh\b/i,
    reason: "remote code execution via curl/wget pipe to shell",
  },
  // chmod -R 777
  {
    pattern: /\bchmod\s+(-R\s+777|777\s+-R)\b/i,
    reason: "chmod -R 777 (world-writable recursive)",
  },
  // Fork bomb
  {
    pattern: /:\(\)\s*\{[^}]*:\s*\|\s*:&\s*\}/,
    reason: "fork bomb",
  },
  // File writes via heredoc (cat > file <<)
  {
    pattern: /\bcat\s*>?\s+[\w\/~\.\-_]+\s*<</,
    reason: "file write via heredoc (cat > ... <<)",
  },
  // File writes via echo/printf redirect
  {
    pattern: /\b(?:echo|printf)\s+.*\s*>\s+[\w\/~\.\-_]+\b/,
    reason: "file write via echo/printf redirect",
  },
  // File writes via tee
  {
    pattern: /\btee\s+[\w\/~\.\-_]+\b/,
    reason: "file write via tee",
  },
];

/** @type {import("@opencode-ai/plugin").Plugin} */
export const server = async ({ client }) => {
  const toast = (message, variant = "error") =>
    client.tui.showToast({ body: { message, variant } }).catch(() => {});

  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "bash") return;

      const cmd = (output.args?.command ?? "").trim();
      if (!cmd) return;

      for (const { pattern, reason } of DANGER_RULES) {
        if (pattern.test(cmd)) {
          const preview = cmd.length > 80 ? cmd.slice(0, 77) + "…" : cmd;
          toast(`⛔ bash-guard blocked: ${reason}\n${preview}`, "error");
          throw new Error(
            `bash-guard: refused dangerous command (${reason}). ` +
              `Command was: ${cmd.slice(0, 200)}`
          );
        }
      }
    },
  };
};

export default server;
