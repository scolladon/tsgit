#!/bin/bash
# PostToolUse hook: auto-format the file just written/edited.
#
# Behavior:
# - Runs `biome format --write` (formatting only — NEVER lint autofixes,
#   which can silently rewrite code in surprising ways).
# - Compares the file's hash before and after; if bytes actually changed,
#   prints a one-line notice to stderr so the agent knows the formatter
#   touched the file.
# - Stays silent when nothing changed.

set -euo pipefail

FILE_PATH="${CLAUDE_FILE_PATH:-}"

if [[ -z "$FILE_PATH" ]]; then
  exit 0
fi

if [[ "$FILE_PATH" != *.ts && "$FILE_PATH" != *.tsx && "$FILE_PATH" != *.js && "$FILE_PATH" != *.jsx && "$FILE_PATH" != *.json ]]; then
  exit 0
fi

if [[ "$FILE_PATH" == */node_modules/* || "$FILE_PATH" == */dist/* ]]; then
  exit 0
fi

if [[ ! -f "$FILE_PATH" ]]; then
  exit 0
fi

BEFORE=$(shasum -a 1 "$FILE_PATH" | awk '{print $1}')

# Format + organize-imports only — NEVER lint autofixes. `--linter-enabled=false`
# disables lint rules (which can rewrite semantic code), while keeping the
# formatter and organize-imports assist action active. This matches what
# `npm run check` enforces, so the agent's edits land formatter-clean on the
# first pass without surprising semantic rewrites.
if [[ -x node_modules/.bin/biome ]]; then
  node_modules/.bin/biome check --write --linter-enabled=false "$FILE_PATH" >/dev/null 2>&1 || true
else
  npx --no-install biome check --write --linter-enabled=false "$FILE_PATH" >/dev/null 2>&1 || true
fi

AFTER=$(shasum -a 1 "$FILE_PATH" | awk '{print $1}')

if [[ "$BEFORE" != "$AFTER" ]]; then
  echo "[auto-format] reformatted $FILE_PATH" >&2
fi
