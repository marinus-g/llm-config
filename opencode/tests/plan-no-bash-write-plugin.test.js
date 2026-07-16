/** Tests for plugin/plan-no-bash-write.js — blocks filesystem-mutating bash commands for the plan agent. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { server } from "../plugin/plan-no-bash-write.js";

function clientFor(agent) {
  return {
    session: { get: async () => ({ data: { agent } }) },
    tui: { showToast: async () => {} },
  };
}

async function before(client, tool, command, sessionID = "test-session") {
  const hooks = await server({ client });
  return hooks["tool.execute.before"](
    { tool, sessionID },
    { args: { command } },
  );
}

// ---- Plan agent: mutating commands are blocked ----------------------------

test("plan agent: cp is blocked", async () => {
  await assert.rejects(
    before(clientFor("plan"), "bash", "cp ~/.config/opencode/foo.js repo/foo.js"),
    /plan-no-bash-write/,
  );
});

test("plan agent: mv is blocked", async () => {
  await assert.rejects(
    before(clientFor("plan"), "bash", "mv old.txt new.txt"),
    /plan-no-bash-write/,
  );
});

test("plan agent: rm is blocked", async () => {
  await assert.rejects(
    before(clientFor("plan"), "bash", "rm -rf build/"),
    /plan-no-bash-write/,
  );
});

test("plan agent: mkdir is blocked", async () => {
  await assert.rejects(
    before(clientFor("plan"), "bash", "mkdir -p dist/assets"),
    /plan-no-bash-write/,
  );
});

test("plan agent: touch is blocked", async () => {
  await assert.rejects(
    before(clientFor("plan"), "bash", "touch newfile.txt"),
    /plan-no-bash-write/,
  );
});

test("plan agent: tee is blocked", async () => {
  await assert.rejects(
    before(clientFor("plan"), "bash", "echo hello | tee output.txt"),
    /plan-no-bash-write/,
  );
});

test("plan agent: output redirection (>) is blocked", async () => {
  await assert.rejects(
    before(clientFor("plan"), "bash", "echo 'content' > file.txt"),
    /plan-no-bash-write/,
  );
});

test("plan agent: append redirection (>>) is blocked", async () => {
  await assert.rejects(
    before(clientFor("plan"), "bash", "echo 'more' >> file.txt"),
    /plan-no-bash-write/,
  );
});

test("plan agent: sed -i is blocked", async () => {
  await assert.rejects(
    before(clientFor("plan"), "bash", "sed -i 's/foo/bar/' file.js"),
    /plan-no-bash-write/,
  );
});

test("plan agent: git commit is blocked", async () => {
  await assert.rejects(
    before(clientFor("plan"), "bash", "git commit -m 'update'"),
    /plan-no-bash-write/,
  );
});

test("plan agent: git add is blocked", async () => {
  await assert.rejects(
    before(clientFor("plan"), "bash", "git add -A"),
    /plan-no-bash-write/,
  );
});

test("plan agent: cp chained with && is blocked", async () => {
  await assert.rejects(
    before(clientFor("plan"), "bash", "git diff HEAD && cp src/foo.js /tmp/backup.js"),
    /plan-no-bash-write/,
  );
});

test("plan agent: chmod is blocked", async () => {
  await assert.rejects(
    before(clientFor("plan"), "bash", "chmod +x script.sh"),
    /plan-no-bash-write/,
  );
});

// ---- Plan agent: read-only commands are allowed ---------------------------

test("plan agent: git status is allowed", async () => {
  await before(clientFor("plan"), "bash", "git status");
});

test("plan agent: git diff is allowed", async () => {
  await before(clientFor("plan"), "bash", "git diff HEAD~2 --stat");
});

test("plan agent: git log is allowed", async () => {
  await before(clientFor("plan"), "bash", "git log --oneline -10");
});

test("plan agent: git show is allowed", async () => {
  await before(clientFor("plan"), "bash", "git show de1b676 --stat");
});

test("plan agent: grep is allowed", async () => {
  await before(clientFor("plan"), "bash", "grep -rn 'foo' src/");
});

test("plan agent: find is allowed", async () => {
  await before(clientFor("plan"), "bash", "find . -name '*.md' | sort");
});

test("plan agent: ls is allowed", async () => {
  await before(clientFor("plan"), "bash", "ls -la agents/");
});

test("plan agent: cat is allowed", async () => {
  await before(clientFor("plan"), "bash", "cat README.md");
});

test("plan agent: git fetch is allowed", async () => {
  await before(clientFor("plan"), "bash", "git fetch origin");
});

test("plan agent: git remote -v is allowed", async () => {
  await before(clientFor("plan"), "bash", "git remote -v");
});

test("plan agent: non-bash tool is not checked", async () => {
  await before(clientFor("plan"), "read", null);
});

// ---- Non-plan agents: bash writes are NOT blocked -------------------------

test("general-dev agent: cp is allowed through (not the plan agent)", async () => {
  await before(clientFor("general-dev"), "bash", "cp src/a.js dst/a.js");
});

test("orchestrator agent: cp is allowed through", async () => {
  await before(clientFor("orchestrator"), "bash", "cp foo bar");
});

test("dotfiles-dev agent: mkdir is allowed through", async () => {
  await before(clientFor("dotfiles-dev"), "bash", "mkdir -p ~/.config/foo");
});
