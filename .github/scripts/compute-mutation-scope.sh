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

# Defence-in-depth: reject anything that does not look like a SHA / short SHA / ref name.
# When the CI workflow is `pull_request_target` (not the current trigger), `base.sha` /
# `head.sha` would gain write-token context — this guard removes the latent injection
# surface before that ever happens. Mirrors .github/scripts/docs-pr-gate.sh.
# Accept SHAs, branch names, tag names, and revision navigation suffixes
# (HEAD~N, HEAD^, branch@{N}). Rejects shell metacharacters, whitespace,
# and quotes — the actual injection surface.
sha_or_ref_re='^[A-Za-z0-9_./~^@{}-]{1,200}$'
if ! [[ "$BASE_SHA" =~ $sha_or_ref_re ]]; then
  echo "compute-mutation-scope: refusing BASE_SHA with unexpected characters" >&2
  exit 2
fi
if ! [[ "$HEAD_SHA" =~ $sha_or_ref_re ]]; then
  echo "compute-mutation-scope: refusing HEAD_SHA with unexpected characters" >&2
  exit 2
fi

git diff --name-only --diff-filter=AMR "$BASE_SHA" "$HEAD_SHA" \
  | grep -E '^src/.*\.ts$' \
  | grep -vE '/(index\.ts|.*\.d\.ts)$' \
  | grep -vE '^src/adapters/browser/' \
  || true
