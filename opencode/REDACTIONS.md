# Redaction & Security Audit Log

This file tracks all redactions and security findings for the OpenCode configuration repository.

## Audit History

### 2025-07-16 — Recovery of lib/, tests/, test/, tui/

**Audited files:**
- `lib/` (11 files): context-pressure.js, danger-mode.js, destructive-command.js, destructive-command-rules.json, loop-state.js, model-override.js, plan-handoff.js, plan-question-autoanswer.js, session-hud-message.js, workflow-core.js, workflow-execution-evidence.js
- `tests/` (18 files): all .test.js files
- `test/` (1 file): agent-mode-override.test.js
- `tui/` (3 files): model-override-tui.tsx, plan-gate-tui.js, workflow-tui.js
- `plugin/` (6 files): agent-mode-override.js, llama-swap-gpu.js, model-override.js, plan-gate.js, tool-loop-guard.js, workflow.js

**Findings:**
- **No secrets, API keys, passwords, or credentials found**
- **No hardcoded personal paths (`/home/marinus`) found**
- **No real email addresses found** (only `workflow@example.invalid` in test fixtures)
- All `token` references are UUID-based ownership tokens (`randomUUID()`) or LLM usage metrics
- All `auth` references are workflow authorization logic (user must run `/workflow create` first)
- Test fixtures use synthetic tokens (`test-token-abc`, `tok-impl`, `t1`, `wrong-token`) — not real credentials

**Redactions applied:**
- None required — all files are clean

**Previous redactions (from prior commits):**
- `opencode.json`: Context7 API key redacted as `<REDACTED>` (commit 25055e0)

## Redaction Policy

- All API keys must be replaced with `<REDACTED>`
- All passwords must be replaced with `<REDACTED>`
- All personal paths must use `~` instead of `/home/username/`
- All email addresses must be replaced with `<EMAIL>` unless they're test fixtures using `.example.invalid`
- All tokens must be replaced with `<TOKEN>` unless they're runtime-generated UUIDs
