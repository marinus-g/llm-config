---
description: Check dotfiles stow status and git state
agent: orchestrator
---

Check the state of the dotfiles repository.

Run these commands and summarize the results:

1. `git -C ~/dotfiles status --short` — show pending changes
2. `git -C ~/dotfiles log --oneline -5` — recent commits
3. Check which stow packages are linked: run `cd ~/dotfiles && stow --target=/home/marinus --adopt --verbose .` (dry-run check only, do not apply changes)

Report:
- Any uncommitted or unstaged changes
- Whether stow symlinks are in sync
- Recent activity
