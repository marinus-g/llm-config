---
description: Review unstaged or staged code changes
agent: code-reviewer
subtask: true
---

Review the current pending changes in the repository.

1. Run `git status` to see what's changed
2. Run `git diff` to see unstaged changes
3. Run `git diff --cached` to see staged changes
4. Analyze all changes for:
   - Correctness and logic errors
   - Security issues
   - Convention violations
   - Performance concerns
   - Missing error handling
5. Report findings by severity: Critical, Warning, Info
6. Give a verdict: Approve, Needs Changes, or Reject

If there are no pending changes, report that the working tree is clean.
