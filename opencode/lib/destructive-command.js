import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import rules from "./destructive-command-rules.json" with { type: "json" };

export const DANGER_RULES = rules.map(({ pattern, flags, reason }) => ({
  pattern: new RegExp(pattern, flags ?? ""),
  reason,
}));

const approvals = new Map();
const APPROVAL_TTL_MS = 5 * 60 * 1000;

export function matchDangerRule(command) {
  return DANGER_RULES.find(({ pattern }) => pattern.test(command)) ?? null;
}

export function rememberDestructiveApproval(sessionID, callID, command) {
  if (!callID) return;
  const key = `${sessionID}:${callID}`;
  const current = approvals.get(key);
  const commands = current?.commands ?? new Set();
  commands.add(command.trim());
  approvals.set(key, { commands, expires: Date.now() + APPROVAL_TTL_MS });
}

export function consumeDestructiveApproval(sessionID, callID, command) {
  if (!callID) return false;
  const key = `${sessionID}:${callID}`;
  const approval = approvals.get(key);
  approvals.delete(key);
  return Boolean(approval && approval.expires >= Date.now() && approval.commands.has(command.trim()));
}

export function clearDestructiveApprovals() { approvals.clear(); }

function shellSegments(command) {
  const segments = [];
  let words = [];
  let word = "";
  let quote = null;
  let escaped = false;
  let dynamic = false;
  const pushWord = () => {
    if (word || dynamic) words.push({ value: word, dynamic });
    word = "";
    dynamic = false;
  };
  const pushSegment = () => {
    pushWord();
    if (words.length) segments.push(words);
    words = [];
  };

  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (escaped) { word += char; escaped = false; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) {
      if (char === quote) { quote = null; continue; }
      if (quote === '"' && (char === "$" || char === "`")) dynamic = true;
      word += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === "$" || char === "`") dynamic = true;
    if (/\s/.test(char)) { pushWord(); if (char === "\n") pushSegment(); continue; }
    if (";&|".includes(char)) {
      pushSegment();
      if (command[i + 1] === char) i++;
      continue;
    }
    word += char;
  }
  if (escaped || quote) return { segments, uncertain: true };
  pushSegment();
  return { segments, uncertain: false };
}

function executableIndex(words) {
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index].value)) index++;
  for (;;) {
    const name = basename(words[index]?.value ?? "");
    if (name === "command") { index++; while (words[index]?.value.startsWith("-")) index++; continue; }
    if (name === "env") {
      index++;
      while (words[index] && (words[index].value.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index].value))) index++;
      continue;
    }
    if (name === "sudo") {
      index++;
      while (words[index]?.value.startsWith("-")) {
        const option = words[index++].value;
        if (["-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt", "-C", "--close-from"].includes(option)) index++;
      }
      continue;
    }
    return index;
  }
}

function canonicalCandidate(target) {
  if (existsSync(target)) return realpathSync(target);
  let ancestor = target;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) return null;
    ancestor = parent;
  }
  const canonicalAncestor = realpathSync(ancestor);
  return resolve(canonicalAncestor, relative(ancestor, target));
}

function isWithin(target, root) {
  const path = relative(root, target);
  return path === "" || (!path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && path !== ".." && !isAbsolute(path));
}

function rmTargets(words, rmIndex) {
  const targets = [];
  let options = true;
  for (let index = rmIndex + 1; index < words.length; index++) {
    const token = words[index];
    if (options && token.value === "--") { options = false; continue; }
    if (options && token.value.startsWith("-") && token.value !== "-") continue;
    targets.push(token);
  }
  return targets;
}

/** Classify a bash permission. Only simple, fully-resolved rm targets may bypass ask mode. */
export function classifyDestructiveCommand(command, { cwd, repoRoot = null }) {
  const text = String(command ?? "").trim();
  if (!text) return { destructive: false, safeToAutoAllow: false };
  const danger = matchDangerRule(text);
  if (danger) return { destructive: true, safeToAutoAllow: false, reason: danger.reason };

  const parsed = shellSegments(text);
  const invocations = [];
  for (const words of parsed.segments) {
    const index = executableIndex(words);
    if (basename(words[index]?.value ?? "") === "rm") invocations.push({ words, index });
  }
  if (!invocations.length) {
    return /(^|[^A-Za-z0-9_])rm([^A-Za-z0-9_]|$)/.test(text)
      ? { destructive: true, safeToAutoAllow: false, reason: "rm syntax could not be resolved" }
      : { destructive: false, safeToAutoAllow: false };
  }
  if (parsed.uncertain) return { destructive: true, safeToAutoAllow: false, reason: "incomplete shell syntax" };

  const roots = [cwd, repoRoot].filter(Boolean).map((root) => realpathSync(root));
  for (const { words, index } of invocations) {
    const targets = rmTargets(words, index);
    if (!targets.length) return { destructive: true, safeToAutoAllow: false, reason: "rm target is missing" };
    for (const target of targets) {
      if (target.dynamic || /[*?\[\]{}()<>]/.test(target.value) || target.value.startsWith("~")) {
        return { destructive: true, safeToAutoAllow: false, reason: `rm target is not static: ${target.value}` };
      }
      const absolute = resolve(cwd, target.value);
      const canonical = canonicalCandidate(absolute);
      if (!canonical || !roots.some((root) => isWithin(canonical, root))) {
        return { destructive: true, safeToAutoAllow: false, reason: `rm target is outside the working tree: ${target.value}` };
      }
    }
  }
  return { destructive: true, safeToAutoAllow: true, reason: "all rm targets are inside the working tree" };
}
