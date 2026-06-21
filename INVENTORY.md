# File Inventory

Every copied file listed with source, destination, category, and secret risk.

| Category | Original Path | Repo Path | Secret Risk |
|---|---|---|---|
| **Claude** | `~/.claude/CLAUDE.md` | `claude/CLAUDE.md` | Low |
| **Claude** | `~/.claude/settings.json` | `claude/settings.json` | Low |
| **Claude** | `~/.claude/statusline-command.sh` | `claude/statusline-command.sh` | Low |
| **Claude** | `~/.claude/agents/*.md` (16 files) | `claude/agents/*.md` | Low |
| **Claude** | `~/.claude/skills/graphify/*` | `claude/skills/graphify/` | Low |
| **Claude** | `~/.claude/skills/hallmark/*` | `claude/skills/hallmark/` | Low |
| **Claude** | `~/.claude/plugins/installed_plugins.json` | `claude/plugins/installed_plugins.json` | Low |
| **Claude** | `~/.claude/plugins/blocklist.json` | `claude/plugins/blocklist.json` | Low |
| **Claude** | `~/.claude/plugins/known_marketplaces.json` | `claude/plugins/known_marketplaces.json` | Low |
| **Claude** | `~/.claude/.credentials.json` | `claude/.credentials.json.example` | **HIGH — REDACTED** |
| **Claude** | `~/.claude/settings.local.json` (symlink) | `claude/settings.local.json.example` | Low |
| **OpenCode** | `~/.config/opencode/AGENTS.md` | `opencode/AGENTS.md` | Low |
| **OpenCode** | `~/.config/opencode/opencode.json` | `opencode/opencode.json` | **MEDIUM — contains API key** |
| **OpenCode** | `~/.config/opencode/opencode.json` (redacted) | `opencode/opencode.json.example` | **HIGH — REDACTED** |
| **OpenCode** | `~/.config/opencode/vision-image-workflow.md` | `opencode/vision-image-workflow.md` | Low |
| **OpenCode** | `~/.config/opencode/package.json` | `opencode/package.json` | Low |
| **OpenCode** | `~/.config/opencode/agents/*.md` (13 agents) | `opencode/agents/*.md` | Low |
| **OpenCode** | `~/.config/opencode/commands/*.md` | `opencode/commands/*.md` | Low |
| **OpenCode** | `~/.config/opencode/plugin/*.js` | `opencode/plugin/*.js` | Low |
| **OpenCode** | `~/.config/opencode/skills/*/` (116 dirs) | `opencode/skills/` | Low |
| **OpenCode** | `~/.config/opencode/agents/explore.md` | `opencode/agents/explore.md` | Low |
| **OpenCode** | `~/.config/opencode/agents/step-orchestrator.md` | `opencode/agents/step-orchestrator.md` | Low |
| **OpenCode** | `~/.config/opencode/agents/step-planner.md` | `opencode/agents/step-planner.md` | Low |
| **OpenCode** | `~/.config/opencode/agents/step-reviewer.md` | `opencode/agents/step-reviewer.md` | Low |
| **OpenCode** | `~/.config/opencode/commands/workflow.md` | `opencode/commands/workflow.md` | Low |
| **OpenCode** | `~/.config/opencode/plugin/model-override.js` | `opencode/plugin/model-override.js` | Low |
| **OpenCode** | `~/.config/opencode/plugin/see-image.js` | `opencode/plugin/see-image.js` | Low |
| **OpenCode** | `~/.config/opencode/plugin/session-hud.tsx` | `opencode/plugin/session-hud.tsx` | Low |
| **OpenCode** | `~/.config/opencode/plugin/workflow.js` | `opencode/plugin/workflow.js` | Low |
| **OpenCode** | `~/.config/opencode/tui.json` | `opencode/tui.json` | Low |
| **PI** | `~/.pi/jetbrains.json` | `pi/jetbrains.json` | Low |
| **PI** | `~/.pi/agent/skills/pi-skills/browser-tools/SKILL.md` | `pi/skills/browser-tools/SKILL.md` | Low |
| **PI** | `~/.pi/agent/skills/pi-skills/gccli/SKILL.md` | `pi/skills/gccli/SKILL.md` | Low |
| **PI** | `~/.pi/agent/skills/pi-skills/gdcli/SKILL.md` | `pi/skills/gdcli/SKILL.md` | Low |
| **PI** | `~/.pi/agent/skills/pi-skills/gmcli/SKILL.md` | `pi/skills/gmcli/SKILL.md` | Low |
| **PI** | `~/.pi/agent/skills/pi-skills/transcribe/*` | `pi/skills/transcribe/` | Low |
| **PI** | `~/.pi/agent/skills/pi-skills/vscode/SKILL.md` | `pi/skills/vscode/SKILL.md` | Low |
| **PI** | `~/.pi/agent/skills/pi-skills/youtube-transcript/*` | `pi/skills/youtube-transcript/` | Low |
| **Local LLM** | `~/.config/llama-swap/config.yaml` (now includes fastcontext-4b, fastcontext-4b-cpu, gemma3-vl-cpu) | `local-llm/llama-swap/config.yaml` | **MEDIUM — contains model paths** |
| **Local LLM** | `~/.config/llama-swap/config.yaml` (redacted) | `local-llm/llama-swap/config.yaml.example` | **MEDIUM — REDACTED** |
| **Local LLM** | `~/.config/llama-swap/router.py` (has CPU fallback logic) | `local-llm/llama-swap/router.py` | Low |
| **Local LLM** | `~/.config/llama-swap/promote-to-gpu.sh` | `local-llm/llama-swap/promote-to-gpu.sh` | Low |
| **Local LLM** | `~/.config/llm-manager/user-cookbook.json` | `local-llm/llm-manager/user-cookbook.json` | Low |
| **Local LLM** | `~/.local/bin/llm-start` | `local-llm/scripts/llm-start` | Low |
| **Local LLM** | `~/.local/bin/llm-stop` | `local-llm/scripts/llm-stop` | Low |
| **Local LLM** | `~/.local/bin/llm-status` | `local-llm/scripts/llm-status` | Low |
| **Scripts** | `~/.local/bin/opencode-upgrade` | `scripts/opencode-upgrade` | Low |
| **Workspace** | `~/AGENTS.md` | `workspace-rules/AGENTS.md` | Low |
| **Workspace** | `~/dotfiles/AGENTS.md` | `workspace-rules/dotfiles-AGENTS.md` | Low |

### Redacted Files Summary

| File | What was redacted |
|---|---|
| `claude/.credentials.json.example` | All string values (accessToken, refreshToken) → `<REDACTED>` |
| `claude/settings.local.json.example` | Symlink target path reference |
| `opencode/opencode.json.example` | `apiKey` values → `<REDACTED>` |
| `local-llm/llama-swap/config.yaml.example` | Model file paths → `${MODELS_DIR}/...`, `llama-server` path → `${LLAMA_SERVER}` (also redacts fastcontext and gemma3 model paths) |
