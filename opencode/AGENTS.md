# Quick-Reference: When X → Do Y

| Trigger | Action |
|---|---|
| Image / screenshot / diagram attached or referenced (1 or more) | Delegate to `vision` — state how many images. Vision handles its own clipboard fallback via `system-admin`. Full: `vision-image-workflow.md` |
| Hyprland config change | `luac -p <file>` → `hyprctl reload` → `hyprctl configerrors`. See §Hyprland |
| Need a symbol / caller / impact | Use `codegraph_*`, not grep. See §CodeGraph |
| Something worth saving to vault | Ask the user first. See §AI Memory |

---

# Knowledge Vault

An Obsidian vault exists at `~/Obsidian\ Vault/`. Do not read from it proactively — only consult it if the user explicitly asks.

## AI Memory

The `05 AI-memory/` directory holds persistent knowledge across sessions. Only consult it when the current task suggests it would be relevant (e.g. returning to a previous topic, working on Hyprland/dotfiles, or the user referencing past decisions).

To scan, read the 5 MOC files in the category subfolders (`Context/`, `Decisions/`, `Lessons/`, `Preferences/`, and the root `AI-memory-MOC.md`). They list every note with a one-line summary inline — no need to open individual note files. Only open a note file when its summary warrants it.

### Writing

When you discover something worth remembering:

1. Read `~/Obsidian\ Vault/05\ AI-memory/AI-memory-write-protocol.md` first — it has naming, tagging, and structure rules.
2. **Ask the user** before writing: "I found something worth saving to the vault — should I?"
3. Only write after receiving permission.

### Attachments

You CANNOT see images natively. When any image/screenshot/diagram is present:

1. Task → `vision` — preprompt must state how many images and "use your clipboard recovery if you can't see them"
2. Vision handles clipboard fallback itself (delegates to `system-admin` for `wl-paste`/`cliphist`)
3. Act on the description (or delegate to specialist)

Multiple images: attach all before sending; vision recovers them in order via `cliphist` if stripped.

Full preprompt examples: `~/.config/opencode/vision-image-workflow.md`

---

# Code Intelligence

## CodeGraph (prefer over file reading)

This project has a CodeGraph MCP server (`codegraph_*` tools) — a tree-sitter-parsed knowledge graph of every symbol, edge, and file. Use it for structural questions instead of reading files.

| Question | Tool |
|---|---|
| "Where is X defined?" / "Find symbol named X" | `codegraph_search` |
| "What calls function Y?" | `codegraph_callers` |
| "What does Y call?" | `codegraph_callees` |
| "What would break if I changed Z?" | `codegraph_impact` |
| "Show me Y's signature / source" | `codegraph_node` |
| "Give me focused context for a task/area" | `codegraph_context` |
| "See several related symbols' source at once" | `codegraph_explore` |
| "What files exist under path/" | `codegraph_files` |

**Rules:**
- Never `grep` or read a file just to find where a symbol is defined — use `codegraph_search` first.
- Don't chain `codegraph_search` + `codegraph_node` for context — use `codegraph_context` instead.
- Use `rg` / `fd` only for literal text searches (log messages, string contents, comments).
- Use JetBrains MCP only for opening files in the IDE or getting the currently open file — not for codebase exploration.

---

# Workflow Protocol

## Default Agent

Use the `orchestrator` primary agent. It routes tasks to specialized subagents:

| Agent | Domain |
|---|---|
| `dotfiles-dev` | Hyprland, Waybar, Ghostty, rofi, stow |
| `system-admin` | Arch Linux, pacman, systemd, services |
| `code-reviewer` | Review changes, audit code |
| `obsidian-helper` | Obsidian vault, notes, MOC |
| `java-expert-dev` | Java, Maven, Gradle, Spring Boot |
| `java-hard-solver` | Hard Java problems delegated from `java-expert-dev` only |
| `general-dev` | Any other programming task |
| `vision` | Image analysis, screenshots, diagrams, OCR (local VL model) |

## Hyprland Changes — Always Validate

**NEVER apply Hyprland config changes without validation:**

1. Edit `.lua` file in `~/dotfiles/hyprland/.config/hypr/`
2. `luac -p <file>` → MUST pass. If it fails: report error, stop.
3. `hyprctl reload`
4. `hyprctl configerrors` → MUST be empty. If not: report errors, suggest fix, stop.
5. Only report success when all four steps pass.

## Dotfiles Conventions

- Config packages in `~/dotfiles/` managed via **GNU stow**
- Stow creates relative symlinks into `~/.config/<tool>/`
- After adding/removing files: run `stow` from repo root
- Hyprland Lua: dotted config keys use string syntax (`["col.active_border"] = "..."`)
- Hyprland Lua: `hl.exec_cmd` doesn't invoke a shell — pipelines need `sh -c "..."`
- Reference programs through `programs.lua` module (`M.terminal`, `M.browser`, etc.)

## Custom Commands

Use these for common tasks:

| Command | Purpose |
|---|---|
| `/hyprland-reload` | Validate + reload Hyprland config |
| `/dotfiles-status` | Check stow + git status |
| `/system-health` | Check updates, disk, services |
| `/session-prime` | Load context for new session |
| `/code-review` | Review pending changes |
| `/setup-audit` | Audit OpenCode setup |

## Communication Style

- Be concise — prefer short answers on the CLI
- Show commands before running them
- Report errors and fixes, not just success
- Ask before destructive operations
