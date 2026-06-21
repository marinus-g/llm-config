# AI Memory Write Protocol

Persistent memory directory for AI agents (pi, Claude, Codex, Gemini, etc.).

## Write Protocol

Agents should write notes here when they discover information worth preserving across sessions. Follow these conventions:

### 1. Pick the right folder

| Folder | Write here when... |
|---|---|
| `Context/` | System facts, project state, environment details |
| `Decisions/` | A choice was made with trade-offs considered |
| `Lessons/` | Something broke, a pattern emerged, or a workaround was discovered |
| `Preferences/` | User preference discovered or stated |

### 2. Naming

- Use `kebab-case-filename.md`
- Start with a descriptive title — not a date
- Be specific: `hyprland-autostart-timing.md` not `fix.md`

### 3. Structure (required)

Every note file follows this format:

```markdown
# Short Title

One line: what this is about.

Full details here — what, why, and what to do about it.

If relevant: link to a [[Linux Desktop]] or another note.

---
tags: ai/memory/lesson/hyprland | source: pi | modified: 2026-05-30
```

### 4. Register in the MOC (required)

After creating the note file, **add it to the category's MOC** (`AI-memory/<Category>/AI-<category>-MOC.md`):

```markdown
- [filename.md](./filename.md) — One line: what this is about.
```

This is the scanning surface. The MOC is all an agent needs to see to decide if a note is relevant. Individual note files are only opened when the summary warrants it.

### 5. Tagging

Use tags in a footer at the bottom of the note file:

```markdown
---
tags: ai/memory/lesson/hyprland | source: pi | modified: 2026-05-30
```

Hierarchy:
- `ai/memory/context` · `ai/memory/decision` · `ai/memory/lesson` · `ai/memory/preference`
- Add domain sub-tags: `ai/memory/lesson/hyprland`, `ai/memory/decision/nvidia`, etc.

### 6. Cross-references

- Link to related system docs: `[[Hyprland]]`, `[[NVIDIA GPU]]`
- Link to related memory notes: `[[Hyprland Lua Migration Notes]]`

### 7. Avoid

- ❌ Duplicates — search MOCs first
- ❌ Temporary debug output — only write lasting insights
- ❌ Redundant system facts — link to `02 Systems/` docs instead
- ❌ Overly long notes — if it's > 200 lines, split it

## Reading (optimized for token efficiency)

1. Read the 5 MOC files — that's the complete index with titles + descriptions
2. Only open individual note files when a MOC entry looks relevant
