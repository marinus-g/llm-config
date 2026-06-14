#!/bin/sh
# Claude Code statusLine command - based on robbyrussell Oh My Zsh theme

input=$(cat)

cwd=$(echo "$input" | jq -r '.workspace.current_dir // .cwd // ""')
model=$(echo "$input" | jq -r '.model.display_name // ""')
used_pct=$(echo "$input" | jq -r '.context_window.used_percentage // empty')
rl5_pct=$(echo "$input" | jq -r '.rate_limits.five_hour.used_percentage // empty')
rl5_reset=$(echo "$input" | jq -r '.rate_limits.five_hour.resets_at // empty')
rl7_pct=$(echo "$input" | jq -r '.rate_limits.seven_day.used_percentage // empty')

# Basename of current directory (like %c in robbyrussell)
dir=$(basename "$cwd")

# Git branch (skip optional locks to avoid hangs)
branch=""
if git -C "$cwd" rev-parse --git-dir >/dev/null 2>&1; then
  branch=$(git -C "$cwd" -c core.fsmonitor=false symbolic-ref --short HEAD 2>/dev/null \
           || git -C "$cwd" -c core.fsmonitor=false rev-parse --short HEAD 2>/dev/null)
fi

# ANSI colors
CYAN='\033[0;36m'
BOLD_BLUE='\033[1;34m'
RED='\033[0;31m'
RESET='\033[0m'

# Build prompt segments
if [ -n "$branch" ]; then
  git_part=$(printf " ${BOLD_BLUE}git:(${RED}%s${BOLD_BLUE})${RESET}" "$branch")
else
  git_part=""
fi

# Context usage segment
ctx_part=""
if [ -n "$used_pct" ]; then
  ctx_int=$(printf "%.0f" "$used_pct")
  ctx_part=" | ctx:${ctx_int}%"
fi

# Rate-limit usage segment (Pro/Max only; absent before first API response)
usage_part=""
if [ -n "$rl5_pct" ]; then
  rl5_int=$(printf "%.0f" "$rl5_pct")
  reset_str=""
  if [ -n "$rl5_reset" ]; then
    now=$(date +%s)
    mins=$(( (rl5_reset - now) / 60 ))
    [ "$mins" -lt 0 ] && mins=0
    if [ "$mins" -ge 60 ]; then
      reset_str=$(printf " (%dh%02dm)" "$((mins / 60))" "$((mins % 60))")
    else
      reset_str=$(printf " (%dm)" "$mins")
    fi
  fi
  usage_part=" | 5h:${rl5_int}%${reset_str}"
  if [ -n "$rl7_pct" ]; then
    rl7_int=$(printf "%.0f" "$rl7_pct")
    usage_part="${usage_part} 7d:${rl7_int}%"
  fi
fi

# Model segment
model_part=""
if [ -n "$model" ]; then
  model_part=" | ${model}"
fi

printf "${CYAN}%s${RESET}%s%s%s%s" "$dir" "$git_part" "$ctx_part" "$usage_part" "$model_part"
