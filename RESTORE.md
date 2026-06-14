# Restore Instructions

These instructions restore configs from this repo back to their original locations.

**WARNING:** Restoring will overwrite existing files in your config directories. Back up first.

## Prerequisites

```bash
# Make sure target directories exist
mkdir -p ~/.claude/agents ~/.claude/skills/graphify ~/.claude/skills/hallmark ~/.claude/plugins
mkdir -p ~/.config/opencode/agents ~/.config/opencode/commands ~/.config/opencode/plugin ~/.config/opencode/skills
mkdir -p ~/.pi/skills/{browser-tools,gccli,gdcli,gmcli,transcribe,vscode,youtube-transcript}
mkdir -p ~/.config/llama-swap ~/.config/llm-manager
```

## Claude

```bash
cp claude/CLAUDE.md ~/.claude/CLAUDE.md
cp claude/settings.json ~/.claude/settings.json
cp claude/statusline-command.sh ~/.claude/statusline-command.sh
cp claude/agents/*.md ~/.claude/agents/
cp -r claude/skills/graphify/* ~/.claude/skills/graphify/
cp -r claude/skills/hallmark/* ~/.claude/skills/hallmark/
cp claude/plugins/installed_plugins.json ~/.claude/plugins/
cp claude/plugins/blocklist.json ~/.claude/plugins/
cp claude/plugins/known_marketplaces.json ~/.claude/plugins/

# .credentials.json.example is a TEMPLATE — do NOT restore it as-is
# Copy it to ~/.claude/.credentials.json then fill in your real values
cp claude/.credentials.json.example ~/.claude/.credentials.json
# Edit ~/.claude/.credentials.json with your real credentials
chmod 600 ~/.claude/.credentials.json

# settings.local.json.example is a template
# The original was a symlink; you need to create the symlink yourself
# ln -sf ~/.dotfiles/.claude/settings.local.json ~/.claude/settings.local.json
```

## OpenCode

```bash
cp opencode/AGENTS.md ~/.config/opencode/AGENTS.md
cp opencode/opencode.json ~/.config/opencode/opencode.json
cp opencode/vision-image-workflow.md ~/.config/opencode/vision-image-workflow.md
cp opencode/package.json ~/.config/opencode/package.json
cp opencode/agents/*.md ~/.config/opencode/agents/
cp opencode/commands/*.md ~/.config/opencode/commands/
cp opencode/plugin/*.js ~/.config/opencode/plugin/

# Skills
for skill_dir in opencode/skills/*/; do
    skill_name=$(basename "$skill_dir")
    [ -f "$skill_dir/SKILL.md" ] && cp "$skill_dir/SKILL.md" ~/.config/opencode/skills/"$skill_name"/
    for subdir in scripts references assets expected_outputs; do
        [ -d "$skill_dir/$subdir" ] && cp -r "$skill_dir/$subdir" ~/.config/opencode/skills/"$skill_name"/
    done
    [ -f "$skill_dir/README.md" ] && cp "$skill_dir/README.md" ~/.config/opencode/skills/"$skill_name"/
    [ -f "$skill_dir/HOW_TO_USE.md" ] && cp "$skill_dir/HOW_TO_USE.md" ~/.config/opencode/skills/"$skill_name"/
    find "$skill_dir" -maxdepth 1 -name '*.py' -exec cp {} ~/.config/opencode/skills/"$skill_name"/ \;
done

# opencode.json.example is a TEMPLATE — restore opencode.json instead
# The .example has apiKey values redacted to <REDACTED>
```

## PI

```bash
cp pi/jetbrains.json ~/.pi/jetbrains.json
cp pi/skills/browser-tools/SKILL.md ~/.pi/agent/skills/pi-skills/browser-tools/
cp pi/skills/gccli/SKILL.md ~/.pi/agent/skills/pi-skills/gccli/
cp pi/skills/gdcli/SKILL.md ~/.pi/agent/skills/pi-skills/gdcli/
cp pi/skills/gmcli/SKILL.md ~/.pi/agent/skills/pi-skills/gmcli/
cp pi/skills/transcribe/* ~/.pi/agent/skills/pi-skills/transcribe/
cp pi/skills/vscode/SKILL.md ~/.pi/agent/skills/pi-skills/vscode/
cp pi/skills/youtube-transcript/* ~/.pi/agent/skills/pi-skills/youtube-transcript/
```

## Local LLM

```bash
cp local-llm/llama-swap/config.yaml ~/.config/llama-swap/config.yaml
cp local-llm/llama-swap/router.py ~/.config/llama-swap/router.py
cp local-llm/llama-swap/promote-to-gpu.sh ~/.config/llama-swap/promote-to-gpu.sh
cp local-llm/llm-manager/user-cookbook.json ~/.config/llm-manager/user-cookbook.json
cp local-llm/scripts/llm-start ~/.local/bin/llm-start
cp local-llm/scripts/llm-stop ~/.local/bin/llm-stop
cp local-llm/scripts/llm-status ~/.local/bin/llm-status

# Make scripts executable
chmod +x ~/.local/bin/llm-start ~/.local/bin/llm-stop ~/.local/bin/llm-status

# config.yaml.example is a TEMPLATE with ${MODELS_DIR} placeholders
# Restore config.yaml instead (which has real paths), or edit the .example
```

## Workspace Rules

```bash
cp workspace-rules/AGENTS.md ~/AGENTS.md
cp workspace-rules/dotfiles-AGENTS.md ~/dotfiles/AGENTS.md
```
