#!/usr/bin/env bash
# Daemon: when only CPU shadow models are running and the GPU is idle,
# request the GPU counterpart so llama-swap loads it alongside.
# The CPU model's short TTL (120 s) then lets it unload naturally.
# Convention: CPU model IDs are the GPU model ID with "-cpu" appended.
#
# Environment variables (with defaults):
#   PROMOTE_ENDPOINT  — router URL   (default: http://127.0.0.1:5099)
#   PROMOTE_API_KEY   — Bearer token (default: llama-local)
#   PROMOTE_INTERVAL  — poll seconds (default: 15)

ENDPOINT="${PROMOTE_ENDPOINT:-http://127.0.0.1:5099}"
API_KEY="${PROMOTE_API_KEY:-llama-local}"
INTERVAL="${PROMOTE_INTERVAL:-15}"

while true; do
    sleep "${INTERVAL}"

    response=$(curl -sf --max-time 2 \
        -H "Authorization: Bearer ${API_KEY}" \
        "${ENDPOINT}/running" 2>/dev/null) || continue

    promote=$(printf '%s' "${response}" | python3 -c "
import json, sys
data = json.load(sys.stdin)
models = data.get('running', [])
ready  = [m for m in models if m.get('state') == 'ready']
cpu    = [m for m in ready if m['model'].endswith('-cpu')]
gpu    = [m for m in ready if not m['model'].endswith('-cpu')]
if cpu and not gpu:
    for m in cpu:
        print(m['model'][:-4])  # strip '-cpu' → GPU model id
" 2>/dev/null)

    [[ -z "${promote}" ]] && continue

    while IFS= read -r gpu_model; do
        curl -sf --max-time 120 \
            -H "Authorization: Bearer ${API_KEY}" \
            -H "Content-Type: application/json" \
            -d "{\"model\":\"${gpu_model}\",\"messages\":[{\"role\":\"user\",\"content\":\"_\"}],\"max_tokens\":1}" \
            "${ENDPOINT}/v1/chat/completions" > /dev/null &
    done <<< "${promote}"
done
