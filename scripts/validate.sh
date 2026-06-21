#!/bin/bash
# validate.sh — Validate ai-assistant-configs repo before pushing

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ERRORS=0

echo "=== AI Assistant Configs Validator ==="
echo "Repo: $REPO_DIR"
echo ""

# 1. Check for secret patterns
echo "[1/6] Checking for secret patterns in .json values..."
SECRET_PATTERNS=(
  'sk-ant-oa'
  'sk-ant-ort'
  'ctx7sk-'
)
for pattern in "${SECRET_PATTERNS[@]}"; do
  if grep -r "$pattern" "$REPO_DIR" --include='*.json' 2>/dev/null | grep -v '\.example' | grep -q .; then
    echo "  FAIL: Found '$pattern' in a non-.example .json file:"
    grep -rn "$pattern" "$REPO_DIR" --include='*.json' 2>/dev/null | grep -v '\.example'
    ERRORS=$((ERRORS + 1))
  fi
done

# Also check .yaml files
for pattern in "${SECRET_PATTERNS[@]}"; do
  if grep -r "$pattern" "$REPO_DIR" --include='*.yaml' 2>/dev/null | grep -q .; then
    echo "  FAIL: Found '$pattern' in a .yaml file:"
    grep -rn "$pattern" "$REPO_DIR" --include='*.yaml' 2>/dev/null
    ERRORS=$((ERRORS + 1))
  fi
done

# Check for password/token in .json values (but not .example)
if grep -rP '"(?:password|token|secret|apiKey|api_key|access_token|refresh_token)"\s*:\s*"(?!<REDACTED>|\{env:)"' "$REPO_DIR" --include='*.json' 2>/dev/null | grep -v '\.example' | grep -q .; then
  echo "  FAIL: Found potential secrets in .json values:"
  grep -rnP '"(?:password|token|secret|apiKey|api_key|access_token|refresh_token)"\s*:\s*"(?!<REDACTED>|\{env:)"' "$REPO_DIR" --include='*.json' 2>/dev/null | grep -v '\.example'
  ERRORS=$((ERRORS + 1))
fi

# 2. Check for symlinks pointing outside the repo
echo "[2/6] Checking for symlinks pointing outside the repo..."
OUTSIDE_SYMLINKS=$(find "$REPO_DIR" -type l -exec sh -c 'target=$(readlink "$1"); case "$target" in *"$REPO_DIR"*) ;; *) echo "$1 -> $target" ;; esac' _ {} \; 2>/dev/null)
if [ -n "$OUTSIDE_SYMLINKS" ]; then
  echo "  FAIL: Symlinks pointing outside repo:"
  echo "$OUTSIDE_SYMLINKS"
  ERRORS=$((ERRORS + 1))
else
  echo "  OK: No external symlinks"
fi

# 3. Check for files exceeding 10MB
echo "[3/6] Checking for files exceeding 10MB..."
LARGE_FILES=$(find "$REPO_DIR" -type f -size +10M 2>/dev/null)
if [ -n "$LARGE_FILES" ]; then
  echo "  FAIL: Large files found:"
  echo "$LARGE_FILES"
  ERRORS=$((ERRORS + 1))
else
  echo "  OK: No files exceed 10MB"
fi

# 4. Check for excluded directories
echo "[4/6] Checking for excluded directories..."
EXCLUDED_DIRS="node_modules __pycache__ cache"
for dir in $EXCLUDED_DIRS; do
  if find "$REPO_DIR" -type d -name "$dir" 2>/dev/null | grep -q .; then
    echo "  FAIL: Found excluded directory: $dir"
    ERRORS=$((ERRORS + 1))
  fi
done
echo "  OK: No excluded directories found"

# 5. Check shell scripts are executable
echo "[5/6] Checking shell scripts in scripts/ are executable..."
SCRIPTS_DIR="$REPO_DIR/scripts"
if [ -d "$SCRIPTS_DIR" ]; then
  for script in "$SCRIPTS_DIR"/*.sh; do
    if [ -f "$script" ]; then
      if [ ! -x "$script" ]; then
        echo "  FAIL: Not executable: $script"
        ERRORS=$((ERRORS + 1))
      else
        echo "  OK: $script is executable"
      fi
    fi
  done
  # Also check llm-* scripts
  for script in "$REPO_DIR/local-llm/scripts"/llm-*; do
    if [ -f "$script" ]; then
      if [ ! -x "$script" ]; then
        echo "  FAIL: Not executable: $script"
        ERRORS=$((ERRORS + 1))
      else
        echo "  OK: $script is executable"
      fi
    fi
  done
fi

# 6. Check .example files don't contain real credentials
echo "[6/6] Checking .example files don't contain real credentials..."
EXAMPLE_FILES=$(find "$REPO_DIR" -name '*.example' -type f 2>/dev/null)
if [ -n "$EXAMPLE_FILES" ]; then
  for pattern in "${SECRET_PATTERNS[@]}"; do
    if echo "$EXAMPLE_FILES" | xargs grep -l "$pattern" 2>/dev/null; then
      echo "  FAIL: Found '$pattern' in an .example file"
      ERRORS=$((ERRORS + 1))
    fi
  done
  # Check that .credentials.json.example has <REDACTED> values
  if [ -f "$REPO_DIR/claude/.credentials.json.example" ]; then
    if grep -q '"accessToken":"<REDACTED>"' "$REPO_DIR/claude/.credentials.json.example" 2>/dev/null; then
      echo "  OK: .credentials.json.example is redacted"
    else
      echo "  FAIL: .credentials.json.example may contain real credentials"
      ERRORS=$((ERRORS + 1))
    fi
  fi
fi

echo ""
echo "=== Validation Complete ==="
if [ "$ERRORS" -eq 0 ]; then
  echo "PASS: No issues found"
  exit 0
else
  echo "FAIL: $ERRORS issue(s) found"
  exit 1
fi
