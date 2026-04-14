#!/bin/bash
# PostToolUse hook: auto-format .ts files after Write/Edit
# Runs biome check --write on the modified file

set -euo pipefail

FILE_PATH="$CLAUDE_FILE_PATH"

if [[ -z "$FILE_PATH" ]]; then
  exit 0
fi

if [[ "$FILE_PATH" != *.ts ]]; then
  exit 0
fi

if [[ "$FILE_PATH" == */node_modules/* ]] || [[ "$FILE_PATH" == */dist/* ]]; then
  exit 0
fi

if [[ -f "$FILE_PATH" ]]; then
  npx biome check --write "$FILE_PATH" 2>/dev/null || true
fi
