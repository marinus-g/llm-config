# OpenCode Setup Overview

Complete inventory of OpenCode agents, models, llama-swap routing, and plugin architecture.

## Architecture

```
opencode client → router.py (:5099) → llama-swap backend (:5100) → llama-server instances
                                      ↑
                              config.yaml (model profiles)
```

- **GPU**: RTX 5090 (32 GB VRAM), power-limited to 400W, clocks locked 900–1950 MHz
- **Primary model**: `llamaswap/qwen3-coder-large` (Qwen3.6-27B Q4_K_M, 196K ctx)
- **Router startup**: `~/.local/bin/llm-start` handles GPU tuning, backend launch, health checks, and GPU monitoring
- **Custom router**: `~/.config/llama-swap/router.py` adds prefer-GPU promotion logic

## Agents (20 configured)

### Core Agents

| Agent | Model | Domain |
|---|---|---|
| `orchestrator` | qwen3-coder-large | Pure routing, delegates to subagents, no file access |
| `workflow-orchestrator` | qwen3-coder-large | Drives `/workflow` runs, has workflow tool permissions |
| `explore` | fastcontext-4b | Read-only repo scout, max 8 tool calls |
| `research` | qwen3-coder | Context7 MCP documentation research |

### Specialized Agents

| Agent | Model | Domain |
|---|---|---|
| `dotfiles-dev` | qwen3-coder-mid | Hyprland, Waybar, Ghostty, rofi, dotfiles |
| `system-admin` | qwen3-coder-mid | Arch Linux, pacman, systemd, services |
| `code-reviewer` | qwen3-coder | Code review, audit changes |
| `java-expert-dev` | qwopus-coder-q6 | Java, Maven, Gradle, Spring Boot |
| `webdev-dev` | qwen3-coder-mid | React, Next.js, CSS, frontend |
| `general-dev` | qwen3-coder-mid | General programming, scripting |
| `obsidian-helper` | qwen3-coder | Obsidian vault management |
| `vision` | keye-vl | Deep image analysis |
| `writer` | qwen3-coder | Documentation, prose |
| `test-dev` | qwen3-coder-mid | Test development |
| `java-dev` | qwopus-coder-q6 | Lightweight Java tasks |

### Workflow Pipeline Agents

| Agent | Model | Role |
|---|---|---|
| `step-planner` | qwopus-coder-mid-q6 | Plans workflow steps |
| `step-orchestrator` | qwen3-coder-mid | Executes planned steps |
| `step-reviewer` | qwen3-coder | Reviews step results, PASS/FAIL |

### Manual-Only Agents

| Agent | Model | Notes |
|---|---|---|
| `expert-java-reviewer` | qwopus-coder-large-q6 | User-invoked only |
| `java-hard-solver` | qwopus-coder-large-q6 | User-invoked only |
| `java-expert-dev-large-context` | qwopus-coder-large-q6 | User-invoked only |

## Downloaded Models (14 unique GGUFs, ~137 GB total)

### GPU Models

| Profile ID | Model File | Size | VRAM Est. | Context | Role |
|---|---|---|---|---|---|
| `qwen3-coder` | Qwen3.6-27B-Q4_K_M.gguf | 16 GB | ~18 GB | 65K | Primary coder |
| `qwen3-coder-q6` | Qwen3.6-27B-Q6_K.gguf | 21 GB | ~24 GB | 65K | Quality test |
| `qwen3-coder-mid` | Qwen3.6-27B-Q4_K_M.gguf | 16 GB | ~28 GB | 98K | Delegated agents |
| `qwen3-coder-mid-q6` | Qwen3.6-27B-Q6_K.gguf | 21 GB | ~31 GB | 98K | Mid ctx quality |
| `qwen3-coder-large` | Qwen3.6-27B-Q4_K_M.gguf | 16 GB | ~40 GB\* | 196K | Large context |
| `qwen3-vl` | Qwen3.6-27B-Q4_K_M + mmproj | 17 GB | ~22 GB | 49K | Vision |
| `qwen3-moe` | Qwen3.6-35B-A3B-Q4_K_M.gguf | 20 GB | ~8 GB | 65K | MoE primary |
| `qwen3-moe-large` | Qwen3.6-35B-A3B-Q4_K_M.gguf | 20 GB | ~16 GB | 131K | MoE large ctx |
| `qwen3-moe-vl` | Qwen3.6-35B-A3B + mmproj | 21 GB | ~10 GB | 33K | MoE vision |
| `qwopus-coder-q6` | Qwopus3.6-27B-Coder-MTP-Q6_K.gguf | 21 GB | ~24 GB | 65K | Planning/coding |
| `qwopus-coder-mid-q6` | (same) | 21 GB | ~31 GB | 98K | Plan agent |
| `qwopus-coder-large-q6` | (same) | 21 GB | ~40 GB\* | 196K | Large ctx plan |
| `fastcontext-4b` | FastContext-1.0-4B-RL-Q4_K_M.gguf | 2.4 GB | ~3 GB | 393K | Repo exploration |
| `gemma4-31b` | gemma-4-31B-it-qat-UD-Q4_K_XL.gguf | 17 GB | ~20 GB | 65K | Gemma 4 dense |
| `keye-vl` | Keye-VL-2.0-30B-A3B-Q4_K_M + mmproj | 19 GB | ~10 GB | 33K | Kwai vision |
| `gemma4-12b-coder` | gemma4-coding-Q6_K.gguf | 9.2 GB | ~11 GB | 98K | Gemma coder |

\*Large context profiles exceed 32 GB VRAM; they run with partial offload or are reserved for low-competition moments.

### CPU Shadow Models

| Profile ID | Model | Size | Context | Role |
|---|---|---|---|---|
| `fastcontext-4b-cpu` | FastContext 4B Q4_K_M | 2.4 GB | 393K | CPU exploration |
| `qwen3-coder-cpu` | Qwen3-1.7B-Q8_0 (draft) | 1.8 GB | 33K | GPU busy fallback |
| `qwen3-coder-mid-cpu` | Qwen3-1.7B-Q8_0 | 1.8 GB | 65K | Mid ctx fallback |
| `qwen3-coder-large-cpu` | Qwen3-1.7B-Q8_0 | 1.8 GB | 145K | Large ctx fallback |
| `qwen3-vl-cpu` | Qwen3.6-27B + mmproj | 17 GB | 49K | Vision fallback |
| `qwen3-moe-cpu` | Qwen3-1.7B-Q8_0 | 1.8 GB | 65K | MoE fallback |
| `qwen3-moe-large-cpu` | Qwen3-1.7B-Q8_0 | 1.8 GB | 131K | MoE large fallback |
| `qwen3-moe-vl-cpu` | Qwen3.6-35B-A3B + mmproj | 21 GB | 33K | MoE vision fallback |
| `gemma3-vl-cpu` | gemma-3-4b-it-Q4_K_M + mmproj | 3.2 GB | 8K | Vision CPU |

### Cloud Models (opencode provider)

| Model ID | Type | Notes |
|---|---|---|
| `opencode/big-pickle` | Free tier | Default cloud fallback |
| `opencode/qwen3.6-plus-free` | Free tier | Strong reasoning |
| `opencode/kimi-k2.5-free` | Free tier | Long context |

## Coexistence Matrix

GPU+CPU pairs can run simultaneously. Two GPU models or two CPU models cannot coexist:

- **FastContext-4B** on GPU evicts the primary GPU model entirely (not in coexistence set)
- **Qwopus** profiles run alone (no CPU shadow allowed)
- **Any other GPU model** can pair with one CPU shadow

## Plugins (14 active)

| Plugin | Purpose |
|---|---|
| `llama-swap-gpu.js` | GPU preference header + `/llm` status display |
| `see-image.js` | Vision bridge: keye-vl → gemma3-vl-cpu fallback |
| `orchestrator-no-edit.js` | Blocks orchestrator from editing files |
| `bash-guard.js` | Blocks dangerous commands (rm -rf /, dd, mkfs) |
| `context-guard.js` | 80%/92% context pressure warnings |
| `tool-loop-guard.js` | Circuit breaker for repeated tool calls |
| `notify.js` | Desktop notifications for idle/errors/prompts |
| `goal.js` | `/goal` autonomous evaluation loop |
| `workflow.js` | Full `/workflow` durable project engine |
| `agent-mode-override.js` | Agent mode transition injection |
| `model-override.js` | Model override hooks |
| `plan-no-jetbrains-write.js` | Blocks JetBrains write for plan/orchestrator |
| `codegraph-reindex.js` | Auto-reindex after edits (2.5 s debounce) |
| `loop.js` | `/loop` repeat prompt N times |

## MCP Servers

| Server | Type | Purpose |
|---|---|---|
| `@upstash/context7-mcp` | Local (npx) | Library documentation research |
| `browserbase` | Remote | Web browsing automation |
| `jetbrains` | Remote (SSE) | IDE integration |
| `codegraph` | Local | Code intelligence, symbol graph |

## Provider Configuration

| Provider | Endpoint | Models Count | Auth |
|---|---|---|---|
| `llamaswap` (local) | `127.0.0.1:5099/v1` | 25 profiles | API key: `llama-local` |
| `opencode` (cloud) | `opencode.ai/zen/v1` | 3 free models | Env: `OPENCODE_API_KEY` |

---

tags: ai/memory/context/opencode | source: orchestrator | modified: 2026-06-21
