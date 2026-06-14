---
description: Review and validate all agent configs and opencode setup
agent: orchestrator
---

Audit the current OpenCode setup.

Check:
1. List all agents in `~/.config/opencode/agents/` and verify each has valid YAML frontmatter
2. Validate `~/.config/opencode/opencode.json` is valid JSON
3. List available skills (count only) and note if there are too many
4. Check for any commands in `~/.config/opencode/commands/`
5. Check MCP server status

Report a summary of the setup and any issues found.
