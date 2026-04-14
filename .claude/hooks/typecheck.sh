#!/bin/bash
# PostToolUse hook: type-check after editing .ts files
# Runs tsc --noEmit and reports errors

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

OUTPUT=$(npx tsc --noEmit 2>&1) || {
  echo "TypeScript errors detected:"
  echo "$OUTPUT"
  exit 0
}
