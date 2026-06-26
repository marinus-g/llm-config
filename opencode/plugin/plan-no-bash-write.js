/**
 * plan-no-bash-write.js — Blocks filesystem-mutating bash commands for the plan agent.
 *
 * HOW IT WORKS
 * ============
 * The plan agent has `bash: { "*": "ask" }`, which lets a weak local model
 * run cp, mv, tee, and similar commands — bypassing the intent of plan mode.
 * This plugin intercepts `tool.execute.before` for bash and rejects any
 * command that mutates the filesystem when the active agent is "plan".
 *
 * It mirrors the pattern used by plugin/plan-no-jetbrains-write.js.
 *
 * DETECTION STRATEGY
 * ==================
 * The command string is split on shell separators (||, &&, |, ;, newlines) to
 * produce segments. Each segment's leading command word is checked against a
 * blocklist of write commands. Output redirections (> and >>) are also caught.
 * Specific patterns like `sed -i` and git write subcommands are blocked too.
 *
 * ALLOWED COMMANDS (examples)
 * ===========================
 * Read-only commands the plan agent legitimately uses:
 *   git status / diff / log / show / remote / fetch
 *   grep, rg, find, ls, cat, head, tail, wc, sort, echo, printf
 *   opencode --version, curl (to fetch docs / check versions)
 *   jq, python3 -c "..." (without file writes), openssl (read-only)
 *
 * WHY A BLOCKLIST (not an allowlist)
 * ====================================
 * An allowlist would be too restrictive for a planning agent that may need to
 * inspect diverse command outputs. The blocklist targets the specific commands
 * a plan agent should never run (file mutations), while keeping the guard small
 * and auditable.
 */

/** Command names that mutate the filesystem / environment. */
const WRITE_COMMAND_NAMES = new Set([
  // copy / move / delete
  "cp", "mv", "rm", "rmdir",
  // create
  "mkdir", "touch", "ln", "mkfifo", "mknod",
  // write to file
  "tee", "dd", "truncate", "install",
  // permissions / ownership (mutate file metadata)
  "chmod", "chown", "chgrp",
  // sync / deploy
  "rsync", "scp", "sftp",
]);

/** Git subcommands that mutate the working tree or history. */
const GIT_WRITE_SUBCOMMANDS = new Set([
  "add", "commit", "push", "pull", "merge", "rebase", "reset", "checkout",
  "switch", "restore", "rm", "mv", "apply", "am", "cherry-pick", "stash",
  "tag", "clean",
]);

/** Package managers + subcommands that install/mutate global/local deps. */
const PKG_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun", "pip", "pip3", "pipx",
  "pacman", "yay", "paru", "apt", "apt-get", "dnf", "brew"]);
const PKG_WRITE_SUBS = new Set(["install", "i", "add", "remove", "uninstall", "up",
  "update", "upgrade", "init", "create"]);

/**
 * Extract the leading command word from a shell segment, stripping common
 * prefixes (sudo, env VAR=val, time, nice) and path components (/usr/bin/cp → cp).
 */
function leadingCommand(segment) {
  let s = segment.trim();
  // Strip common prefixes
  s = s.replace(/^(sudo\s+|time\s+|nice(?:\s+-n\s+\d+)?\s+|ionice\s+|env\s+(?:\S+=\S+\s+)*)/, "");
  const word = s.split(/\s+/)[0] ?? "";
  return word.replace(/^.*\//, "").toLowerCase();
}

/** Detect output redirection (> or >>) that writes to a file. */
function hasOutputRedirection(segment) {
  // Remove single-quoted strings to reduce false positives from literals
  const cleaned = segment.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
  // Match > or >> NOT preceded by 2 (stderr redir is fine) or another < / >
  return /(?<![<>2&])>>?(?![>])/.test(cleaned);
}

/** Detect `sed -i` (in-place edit). */
function isSedInPlace(segment) {
  return /(?:^|\s)sed\s+.*-[a-zA-Z]*i(?:\s|$)/.test(segment.trim());
}

/** Detect git write subcommand. */
function isGitWrite(segment) {
  const parts = segment.trim().split(/\s+/);
  const cmd = (parts[0] ?? "").replace(/^.*\//, "").toLowerCase();
  if (cmd !== "git") return false;
  const sub = parts.slice(1).find((w) => !w.startsWith("-")) ?? "";
  return GIT_WRITE_SUBCOMMANDS.has(sub.toLowerCase());
}

/** Detect package manager install/mutation subcommand. */
function isPkgWrite(segment) {
  const parts = segment.trim().split(/\s+/);
  const cmd = (parts[0] ?? "").replace(/^.*\//, "").toLowerCase();
  if (!PKG_MANAGERS.has(cmd)) return false;
  const sub = parts.slice(1).find((w) => !w.startsWith("-")) ?? "";
  return PKG_WRITE_SUBS.has(sub.toLowerCase());
}

/**
 * Analyse one shell segment. Returns a human-readable reason if it mutates
 * the filesystem, or null if it's safe.
 */
function mutatingReason(segment) {
  const trimmed = segment.trim();
  if (!trimmed) return null;

  const cmd = leadingCommand(trimmed);
  if (WRITE_COMMAND_NAMES.has(cmd)) return `"${cmd}" mutates the filesystem`;
  if (hasOutputRedirection(trimmed)) return "output redirection (>) writes to a file";
  if (isSedInPlace(trimmed)) return '"sed -i" edits files in-place';
  if (isGitWrite(trimmed)) return "git write operation is not allowed in plan mode";
  if (isPkgWrite(trimmed)) return "package manager install/mutation not allowed in plan mode";
  return null;
}

/**
 * Scan the full command string for any mutating segment.
 * Returns `{ reason, segment }` on the first match, or null if all clear.
 */
function detectWriteOperation(command) {
  if (!command) return null;
  // Split on shell separators (order matters: || before |)
  const segments = command.split(/\|\||&&|[|;]|\n/);
  for (const seg of segments) {
    const reason = mutatingReason(seg);
    if (reason) return { reason, segment: seg.trim().slice(0, 100) };
  }
  return null;
}

/** Resolve the current agent name for a session. */
async function resolveAgent(client, sessionID) {
  try {
    const resp = await client.session.get({ path: { id: sessionID } });
    return resp?.data?.agent ?? resp?.data?.agentID ?? resp?.data?.name ?? null;
  } catch {
    return null;
  }
}

/** @type {import("@opencode-ai/plugin").Plugin} */
export const server = async ({ client }) => {
  const toast = (message, variant = "error") =>
    client.tui.showToast({ body: { message, variant } }).catch(() => {});

  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "bash") return;

      const sessionID = input.sessionID;
      if (!sessionID) return;

      const agent = await resolveAgent(client, sessionID);
      if (!agent || agent.toLowerCase() !== "plan") return;

      const cmd = (output.args?.command ?? "").trim();
      if (!cmd) return;

      const hit = detectWriteOperation(cmd);
      if (!hit) return;

      const preview = hit.segment.length > 70 ? hit.segment.slice(0, 67) + "…" : hit.segment;
      toast(`⛔ plan-no-bash-write: ${hit.reason}\n${preview}`, "error");
      throw new Error(
        `plan-no-bash-write: filesystem writes are not allowed in plan mode (${hit.reason}).\n` +
          `Command segment: ${hit.segment}\n` +
          `You are the plan agent. Do not implement changes — produce a plan in chat text. ` +
          `When the plan is complete, end your message with the marker:\n` +
          `[OPENCODE_PLAN_GATE]\n` +
          `Do not call any tools before or after the marker.`,
      );
    },
  };
};

export default server;
