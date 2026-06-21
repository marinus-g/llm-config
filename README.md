# AI Assistant Configs

Centralized repository of configuration files for AI coding assistants on this machine.

## Contents

### Claude Desktop (`claude/`)
- `CLAUDE.md` — Project-level instructions
- `settings.json` — App settings
- `statusline-command.sh` — Status bar command
- `agents/` — 16 agent definitions (dotfiles-dev, general-dev, java-expert-dev, java-expert-dev-large-context, java-hard-solver, code-reviewer, obsidian-helper, system-admin, vision, planner, researcher, quick-fix, test-dev, webdev-dev, writer, expert-java-reviewer)
- `skills/` — graphify, hallmark skill configs
- `plugins/` — Plugin metadata (manifests only, no source code)
- `.credentials.json.example` — Redacted credentials template
- `settings.local.json.example` — Redacted local settings

### OpenCode (`opencode/`)
- `opencode.json` — Main configuration (providers, models, MCP, permissions)
- `opencode.json.example` — Redacted copy (apiKey values redacted)
- `tui.json` — TUI theme configuration
- `AGENTS.md` — Agent definitions and routing
- `vision-image-workflow.md` — Image handling workflow
- `package.json` — Plugin dependencies
- `agents/` — 15 Agent .md definitions (dotfiles-dev, explore, general-dev, java-dev, java-expert-dev, code-reviewer, obsidian-helper, orchestrator, research, system-admin, vision, workflow-orchestrator, step-orchestrator, step-planner, step-reviewer)
- `commands/` — 14 command definitions (workflow, hyprland-reload, dotfiles-status, system-health, session-prime, code-review, setup-audit, loop, loop-stop, check, check-loop, goal, btw, llm)
- `plugin/` — 15 custom plugins (agent-mode-override.js, bash-guard.js, codegraph-reindex.js, context-guard.js, goal.js, llama-swap-gpu.js, loop.js, model-override.js, notify.js, orchestrator-no-edit.js, plan-no-jetbrains-write.js, see-image.js, session-hud.tsx, tool-loop-guard.js, workflow.js)
- `skills/` — 116 skill directories (SKILL.md + support files only)

### AI Memory (`ai-memory/`)
Mirror of the Obsidian vault's AI-memory directory for persistent cross-session knowledge. Includes MOC files, category folders (Context, Decisions, Lessons, Preferences), and the write protocol document.

### Scripts (`scripts/`)
- `opencode-upgrade` — Version management: install, switch, and roll back OpenCode versions
- `validate.sh` — Pre-push validation: secret scanning, symlink checks, large file detection

### PI / JetBrains (`pi/`)
- `jetbrains.json` — JetBrains IDE integration config
- `skills/` — 7 PI skills (browser-tools, gccli, gdcli, gmcli, transcribe, vscode, youtube-transcript)

### Local LLM (`local-llm/`)
- `llama-swap/config.yaml` — Model definitions, matrix, macros (includes fastcontext-4b, fastcontext-4b-cpu, gemma3-vl-cpu)
- `llama-swap/config.yaml.example` — Redacted (paths → `${MODELS_DIR}`)
- `llama-swap/router.py` — Custom router with CPU fallback for fastcontext GPU load failures
- `llama-swap/promote-to-gpu.sh` — GPU promotion script
- `llm-manager/user-cookbook.json` — LLM manager cookbook
- `scripts/` — llm-start, llm-stop, llm-status

### Workspace Rules (`workspace-rules/`)
- `AGENTS.md` — Root workspace agent rules
- `dotfiles-AGENTS.md` — Dotfiles workspace agent rules

## Workflow System

Commands in this repo drive an autonomous workflow pipeline via the `/workflow` command. The system uses:

- **`workflow-orchestrator`** — Primary agent that drives workflow phases and delegates to step planners
- **`step-planner`** — Plans individual workflow steps
- **`step-reviewer`** — Verifies workflow step results
- **`workflow.js`** — Plugin implementing the workflow orchestration logic

The `orchestrator` agent is the everyday default, routing tasks to specialized subagents (dotfiles-dev, system-admin, code-reviewer, obsidian-helper, java-expert-dev, general-dev, vision).

## Security

See [SECURITY.md](SECURITY.md) for secret handling policy.

## What's NOT Included

- Runtime data (sessions, caches, history, plans, tasks)
- `node_modules/`, `__pycache__/`, `.git/` directories
- Backup files (`*.bak*`)
- Actual credentials (only `.example` templates)
- The `understand-anything` marketplace plugin source (49M) — only its manifest entry
- `skills-disabled/` from OpenCode
