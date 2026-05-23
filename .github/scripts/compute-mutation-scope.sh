#!/usr/bin/env bash
# Compute the diff-scoped Stryker mutate-list for a PR (Phase 19.1).
#
# Usage:
#   compute-mutation-scope.sh [BASE_SHA] [HEAD_SHA]
#
# Defaults:
#   BASE_SHA = $GITHUB_BASE_REF (CI) or "main"
#   HEAD_SHA = "HEAD"
#
# Prints a newline-separated list of changed src/*.ts files (excluding the
# globs Stryker also excludes: index.ts, *.d.ts, src/adapters/browser/**).
#
# Exit codes:
#   0 — success (empty output is valid; caller gates on -s file)
#   non-zero — git diff itself failed (propagated from `set -e`)
#
# See `docs/design/phase-19-1-mutation-pyramid.md`.
set -euo pipefail

BASE_SHA="${1:-${GITHUB_BASE_REF:-main}}"
HEAD_SHA="${2:-HEAD}"

git diff --name-only --diff-filter=AMR "$BASE_SHA" "$HEAD_SHA" \
  | grep -E '^src/.*\.ts$' \
  | grep -vE '/(index\.ts|.*\.d\.ts)$' \
  | grep -vE '^src/adapters/browser/' \
  || true
