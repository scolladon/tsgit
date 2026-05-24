#!/usr/bin/env bash
# Emit `code=true` or `code=false` to $GITHUB_OUTPUT based on whether the
# PR diff touches any code-relevant path (ADR-103).
#
# Usage:
#   has-code-changes.sh [BASE_SHA] [HEAD_SHA]
#
# On push events (no BASE_SHA), emits `code=true` unconditionally — the full
# pipeline must cover every push to main / tags. The diff-based skip is
# strictly a per-PR optimisation.
#
# Exit codes:
#   0 — success (the `code` output value is the decision)
#   2 — SHA format guard rejected an input
set -euo pipefail

BASE_SHA="${1:-}"
HEAD_SHA="${2:-HEAD}"

emit() {
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf 'code=%s\n' "$1" >> "$GITHUB_OUTPUT"
  fi
  echo "code=$1"
}

if [ -z "$BASE_SHA" ]; then
  echo "has-code-changes: no base SHA (push event) - assuming code=true"
  emit true
  exit 0
fi

# Defence-in-depth: same SHA-format guard the mutation script uses.
sha_or_ref_re='^[A-Za-z0-9_./~^@{}-]{1,200}$'
if ! [[ "$BASE_SHA" =~ $sha_or_ref_re ]]; then
  echo "has-code-changes: refusing BASE_SHA with unexpected characters" >&2
  exit 2
fi
if ! [[ "$HEAD_SHA" =~ $sha_or_ref_re ]]; then
  echo "has-code-changes: refusing HEAD_SHA with unexpected characters" >&2
  exit 2
fi

# Code-path allowlist. Order doesn't matter; grep -E uses the union.
CODE_RE='^(src/|test/|tooling/|scripts/|\.github/|package\.json$|package-lock\.json$|tsconfig.*\.json$|vitest\.config\.ts$|stryker\.config\.json$|rollup\.config\.ts$|mutation-budgets\.json$|biome\.json$|knip\.json$|\.ls-lint\.yml$|cspell\.json$)'

CHANGED=$(git diff --name-only "$BASE_SHA" "$HEAD_SHA")

if [ -z "$CHANGED" ]; then
  echo "has-code-changes: empty diff"
  emit false
  exit 0
fi

if echo "$CHANGED" | grep -qE "$CODE_RE"; then
  echo "has-code-changes: code paths changed"
  emit true
else
  echo "has-code-changes: only non-code paths changed"
  emit false
fi
