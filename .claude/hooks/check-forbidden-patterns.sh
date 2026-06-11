#!/bin/bash
# PreToolUse hook (Write|Edit): block newly-introduced forbidden patterns in
# src/ and test/ TypeScript files (CLAUDE.md non-negotiables):
#   - suppression directives: @ts-ignore, @ts-expect-error, eslint-disable,
#     biome-ignore, v8 ignore, istanbul ignore, and `Stryker disable` lines
#     that carry no `equivalent` rationale
#   - provenance references: ADR-NNN, §N, Phase N, BACKLOG — design docs and
#     PR bodies carry provenance; source and test code stay silent about it
#
# Only ADDED occurrences block: the baseline is the edit's old_string (Edit)
# or the file's current on-disk content (Write), so approved pre-existing
# directives and historical comments carried through an edit never trip it.

set -euo pipefail

INPUT=$(cat)
FILE_PATH=$(jq -r '.tool_input.file_path // empty' <<<"$INPUT")

if [[ -z "$FILE_PATH" || "$FILE_PATH" != *.ts ]]; then
  exit 0
fi
if [[ "$FILE_PATH" != */src/* && "$FILE_PATH" != */test/* ]]; then
  exit 0
fi

NEW=$(jq -r '.tool_input.content // .tool_input.new_string // empty' <<<"$INPUT")
if [[ -z "$NEW" ]]; then
  exit 0
fi

OLD=$(jq -r '.tool_input.old_string // empty' <<<"$INPUT")
if [[ -z "$OLD" && -f "$FILE_PATH" ]]; then
  OLD=$(cat "$FILE_PATH")
fi

count_matches() {
  # grep -c exits 1 on zero matches; the substitution still captures "0".
  grep -cE "$1" <<<"$2" || true
}

PATTERNS=(
  '@ts-ignore'
  '@ts-expect-error'
  'eslint-disable'
  'biome-ignore'
  'v8 ignore'
  'istanbul ignore'
  'ADR-[0-9]+'
  '§[0-9]'
  'Phase [0-9]'
  'BACKLOG'
)

BLOCKED=""
for p in "${PATTERNS[@]}"; do
  new_count=$(count_matches "$p" "$NEW")
  old_count=$(count_matches "$p" "$OLD")
  if ((new_count > old_count)); then
    BLOCKED="${BLOCKED}\n- ${p}"
  fi
done

count_bare_stryker() {
  grep -iE 'stryker[ -]disable' <<<"$1" | grep -civ 'equivalent' || true
}
new_stryker=$(count_bare_stryker "$NEW")
old_stryker=$(count_bare_stryker "$OLD")
if ((new_stryker > old_stryker)); then
  BLOCKED="${BLOCKED}\n- Stryker disable without an inline 'equivalent' rationale"
fi

if [[ -n "$BLOCKED" ]]; then
  {
    echo "BLOCKED: forbidden pattern(s) introduced in $FILE_PATH:"
    echo -e "$BLOCKED"
    echo "Suppression directives and phase/ADR/backlog provenance are banned in src/ and test/ (CLAUDE.md non-negotiables). Fix the code honestly or move the reference to the design doc / PR body."
  } >&2
  exit 2
fi
