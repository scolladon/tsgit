#!/bin/bash
# Stop hook: fires EVERY TIME the main agent finishes a response turn (not at
# session exit; subagents fire SubagentStop, which is not configured). It is a
# per-turn quality signal, so it MUST stay cheap: scoped to what actually
# changed — seconds, not minutes. A clean working tree exits immediately.
#
# - biome lint scoped to the changed .ts/.js/.json files
# - tsc full project (type errors are cross-file; scoping is meaningless)
# - unit tests scoped to the tests RELATED to the changed files, derived from
#   the mirror layout: src/<path>/<name>.ts → test/unit/<path>/<name>.test.ts
#   (+ .properties.test.ts sibling); changed test files run themselves.
#
# Clean working tree → exits immediately (worktree-based sessions gate their
# own changes via slice gates + phase validates).

set -euo pipefail

cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)"

if [[ ! -f "package.json" ]]; then
  exit 0
fi

CHANGED=$(
  {
    git diff --name-only HEAD 2>/dev/null
    git ls-files --others --exclude-standard 2>/dev/null
  } | sort -u
)

if [[ -z "$CHANGED" ]]; then
  exit 0
fi

CHANGED_CODE=()
RELATED_TESTS=()
while IFS= read -r f; do
  [[ "$f" != *.ts && "$f" != *.js && "$f" != *.json ]] && continue
  [[ ! -f "$f" ]] && continue
  CHANGED_CODE+=("$f")
  if [[ "$f" == test/*.test.ts ]]; then
    RELATED_TESTS+=("$f")
  elif [[ "$f" == src/*.ts ]]; then
    rel="${f#src/}"
    base="${rel%.ts}"
    for candidate in "test/unit/${base}.test.ts" "test/unit/${base}.properties.test.ts"; do
      [[ -f "$candidate" ]] && RELATED_TESTS+=("$candidate")
    done
  fi
done <<<"$CHANGED"

ERRORS=""

if ((${#CHANGED_CODE[@]} > 0)); then
  if ! npx --no-install biome check --no-errors-on-unmatched "${CHANGED_CODE[@]}" >/dev/null 2>&1; then
    ERRORS="${ERRORS}\n- Biome lint/format errors in changed files"
  fi
fi

if ! npx --no-install tsc --noEmit >/dev/null 2>&1; then
  ERRORS="${ERRORS}\n- TypeScript type errors detected"
fi

if ((${#RELATED_TESTS[@]} > 0)); then
  UNIQUE_TESTS=()
  while IFS= read -r t; do
    UNIQUE_TESTS+=("$t")
  done < <(printf '%s\n' "${RELATED_TESTS[@]}" | sort -u)
  if ! npx --no-install vitest run "${UNIQUE_TESTS[@]}" >/dev/null 2>&1; then
    ERRORS="${ERRORS}\n- Related unit tests failing (${#UNIQUE_TESTS[@]} file(s))"
  fi
fi

if [[ -n "$ERRORS" ]]; then
  echo "Quality issues found before session end:"
  echo -e "$ERRORS"
  echo ""
  echo "The project may be in a broken state. Consider fixing before ending."
  exit 0
fi
