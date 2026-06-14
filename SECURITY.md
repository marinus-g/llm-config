# Security Policy

## Secret Handling

### Files with Redacted Copies

The following files contain sensitive data. Only `.example` versions with redacted values should be committed to a public repo:

- **`claude/.credentials.json.example`** — OAuth access and refresh tokens for Claude AI. ALL string values replaced with `<REDACTED>`.
- **`opencode/opencode.json.example`** — API keys for providers. `apiKey` values replaced with `<REDACTED>`.
- **`local-llm/llama-swap/config.yaml.example`** — Absolute model file paths replaced with `${MODELS_DIR}/...`.

### Files with Live Data (NEVER Commit Publicly)

- `claude/.credentials.json` — NOT copied. Never commit the original.
- `opencode/opencode.json` — Contains a live Context7 API key (`--api-key` in MCP config). **Do not push to a public repo.**

## Patterns to Watch For

Never commit files containing these patterns as values:

- `sk-ant-oa` (Anthropic access tokens)
- `sk-ant-ort` (Anthropic refresh tokens)
- `ctx7sk-` (Context7 API keys)
- `{env:OPENCODE_API_KEY}` is OK (env var reference)
- `"apiKey"` as a JSON key with a real token as the value

## What Was Intentionally Excluded

- `~/.claude/history.jsonl` — Session history (may contain prompts with secrets)
- `~/.claude/sessions/`, `~/.claude/tasks/`, `~/.claude/plans/` — Runtime data
- `~/.claude/cache/`, `~/.claude/downloads/`, `~/.claude/backups/` — Cached/downloaded data
- `~/.claude/.git/`, `~/.claude/.last-cleanup` — Git and maintenance files
- `~/.claude/.credentials.json` (original) — Never copied, only redacted example created
- `~/.config/opencode/skills-disabled/` — 136 disabled skill directories
- `~/.config/opencode/node_modules/` — Node dependencies
- `~/.pi/agent/sessions/` — Session data
- `~/.config/llama-swap/config.yaml.bak-*`, `router.py.bak-*` — Backups
- `~/.local/bin/llama-swap` — Binary file

## Validation

Run `scripts/validate.sh` before pushing to check:
1. No real credentials in any file
2. No symlinks pointing outside the repo
3. No files exceed 10MB
4. No excluded directories (node_modules, __pycache__, .git, cache)
5. Shell scripts are executable
6. `.example` files don't contain real credentials
