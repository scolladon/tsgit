#!/bin/bash
# PostToolUse hook (Write|Edit): single-file cspell on the markdown file just
# written. Catches unknown words at edit time instead of minutes later in the
# full `check:spelling` validate script. The tool call already ran, so this is
# feedback (exit 2 surfaces stderr to the agent), not a block: fix the word or
# deliberately add a legitimate coined term to cspell.json's words list.

set -euo pipefail

FILE_PATH="${CLAUDE_FILE_PATH:-}"

if [[ -z "$FILE_PATH" || "$FILE_PATH" != *.md ]]; then
  exit 0
fi
if [[ "$FILE_PATH" == */node_modules/* ]]; then
  exit 0
fi
if [[ ! -f "$FILE_PATH" ]]; then
  exit 0
fi

# Run from the file's own repo root so worktree edits resolve that checkout's
# cspell.json and node_modules.
ROOT=$(git -C "$(dirname "$FILE_PATH")" rev-parse --show-toplevel 2>/dev/null || true)
if [[ -z "$ROOT" || ! -f "$ROOT/cspell.json" || ! -x "$ROOT/node_modules/.bin/cspell" ]]; then
  exit 0
fi

OUT=$("$ROOT/node_modules/.bin/cspell" --no-progress --no-summary --no-color "$FILE_PATH" 2>/dev/null || true)

if [[ -n "$OUT" ]]; then
  {
    echo "[cspell] unknown words in $FILE_PATH:"
    echo "$OUT"
    echo "Fix the spelling, or add a legitimate coined term to cspell.json (words list) — check:spelling will fail validate otherwise."
  } >&2
  exit 2
fi
