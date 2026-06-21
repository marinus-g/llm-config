# AI Assistant Configs

Centralized repository of configuration files for AI coding assistants on this machine.

## Contents

### Claude Desktop (`claude/`)
- `CLAUDE.md` — Project-level instructions
- `settings.json` — App settings
- `statusline-command.sh` — Status bar command
- `agents/` — 16 agent definitions
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
- `agents/` — 13 Agent .md definitions (dotfiles-dev, explore, general-dev, java-dev, java-expert-dev, obsidian-helper, orchestrator, step-orchestrator, step-planner, step-reviewer, system-admin, code-reviewer, vision)
- `commands/` — Command definitions (including `workflow.md`)
- `plugin/` — Custom plugins (model-override.js, see-image.js, session-hud.tsx, workflow.js)
- `skills/` — 116 skill directories (SKILL.md + support files only)

### Scripts (`scripts/`)
- `opencode-upgrade` — Version management: install, switch, and roll back OpenCode versions

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

## What's NOT Included

- Runtime data (sessions, caches, history, plans, tasks)
- `node_modules/`, `__pycache__/`, `.git/` directories
- Backup files (`*.bak*`)
- Actual credentials (only `.example` templates)
- The `understand-anything` marketplace plugin source (49M) — only its manifest entry
- `skills-disabled/` from OpenCode

## Security

See [SECURITY.md](SECURITY.md) for secret handling policy.
