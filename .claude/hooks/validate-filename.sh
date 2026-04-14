#!/bin/bash
# PreToolUse hook: validate kebab-case naming for new .ts files in src/ and test/
# Blocks file creation if naming convention is violated

set -euo pipefail

FILE_PATH="$CLAUDE_FILE_PATH"

if [[ -z "$FILE_PATH" ]]; then
  exit 0
fi

if [[ "$FILE_PATH" != *.ts ]]; then
  exit 0
fi

# Only validate src/ and test/ files
if [[ "$FILE_PATH" != */src/* ]] && [[ "$FILE_PATH" != */test/* ]]; then
  exit 0
fi

# Extract filename without extension
BASENAME=$(basename "$FILE_PATH")
NAME="${BASENAME%.ts}"
NAME="${NAME%.test}"
NAME="${NAME%.bench}"

# Check kebab-case: lowercase letters, digits, hyphens only
if [[ ! "$NAME" =~ ^[a-z][a-z0-9-]*$ ]]; then
  echo "BLOCKED: File '$BASENAME' violates kebab-case naming convention."
  echo "Expected: lowercase letters, digits, and hyphens (e.g., 'read-object.ts')"
  echo "Got: '$BASENAME'"
  exit 1
fi
