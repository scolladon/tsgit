#!/usr/bin/env bash
# Path-based docs PR gate (Phase 18.3, warn-only — ADR-099).
#
# When this PR touches src/application/{commands,primitives}/<name>.ts, the
# same PR should also touch docs/use/{commands,primitives}/<kebab>.md or the
# funnel README.md. On mismatch, write an informational PR comment + step
# summary. NEVER exits non-zero — the calling job sets continue-on-error: true
# as belt-and-braces.
#
# All inputs come via env vars from the workflow (BASE_SHA, HEAD_SHA,
# GH_TOKEN, REPO, PR_NUMBER, COMMENT_TAG). The script does not interpolate
# any unsanitised GitHub event data into shell — env vars are referenced via
# "$VAR" quoting.

set -euo pipefail

: "${BASE_SHA:?missing}"
: "${HEAD_SHA:?missing}"
: "${REPO:?missing}"
: "${PR_NUMBER:?missing}"
: "${COMMENT_TAG:?missing}"
: "${GITHUB_STEP_SUMMARY:?missing}"

# Defense-in-depth: the GitHub event payload constrains these inputs to safe
# character sets (PR_NUMBER is integer, REPO is owner/name, BASE/HEAD are
# 40-char hex). Reassert that invariant before we interpolate them into URLs.
if [[ ! "$PR_NUMBER" =~ ^[0-9]+$ ]]; then
  echo "docs-pr-gate: PR_NUMBER ($PR_NUMBER) is not numeric — refusing to proceed" >&2
  exit 0
fi
if [[ ! "$REPO" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]]; then
  echo "docs-pr-gate: REPO ($REPO) is not owner/name shape — refusing to proceed" >&2
  exit 0
fi
if [[ ! "$BASE_SHA" =~ ^[0-9a-f]{7,64}$ ]] || [[ ! "$HEAD_SHA" =~ ^[0-9a-f]{7,64}$ ]]; then
  echo "docs-pr-gate: BASE_SHA / HEAD_SHA do not look like git OIDs — refusing to proceed" >&2
  exit 0
fi

changed=$(git diff --name-only "$BASE_SHA...$HEAD_SHA")
mismatches=""

# Composite-doc allowlist: maps `<src-prefix>` → `<composite-doc>`. When a
# source file under <src-prefix> changes AND <composite-doc> is in the PR's
# changed set (or already covered in the funnel README), suppress the
# per-file mismatch. See `docs-pr-gate.allowlist.txt` for the rationale.
allowlist_file="$(dirname "$0")/docs-pr-gate.allowlist.txt"
allowlist_entries=""
if [ -f "$allowlist_file" ]; then
  allowlist_entries=$(grep -v '^[[:space:]]*#' "$allowlist_file" | grep -v '^[[:space:]]*$' || true)
fi

is_allowlisted() {
  local src="$1"
  local prefix doc
  if [ -z "$allowlist_entries" ]; then
    return 1
  fi
  while IFS=' ' read -r prefix doc; do
    case "$src" in
      "${prefix}"*)
        if echo "$changed" | grep -qxF "$doc"; then
          return 0
        fi
        ;;
    esac
  done <<< "$allowlist_entries"
  return 1
}

while IFS= read -r src; do
  case "$src" in
    src/application/commands/*.ts | src/application/primitives/*.ts) ;;
    *) continue ;;
  esac
  # Skip nested `internal/` helpers (per-feature implementation pieces, not
  # user-facing commands/primitives). The gate's bash case glob otherwise
  # matches deeper paths like `commands/internal/foo.ts` against
  # `commands/*.ts`, surfacing internal-only files as missing docs.
  case "$src" in
    src/application/commands/internal/* | src/application/primitives/internal/*)
      continue
      ;;
  esac
  case "$src" in
    *.test.ts) continue ;;
  esac

  if is_allowlisted "$src"; then
    continue
  fi

  kind="commands"
  case "$src" in
    src/application/primitives/*) kind="primitives" ;;
  esac

  base=$(basename "$src" .ts)
  doc="docs/use/${kind}/${base}.md"
  index="docs/use/${kind}/README.md"

  if echo "$changed" | grep -qxF "$doc"; then
    continue
  fi
  if echo "$changed" | grep -qxF "$index"; then
    continue
  fi

  mismatches+="- \`$src\` → expected \`$doc\` or a row update in \`$index\`"$'\n'
done <<< "$changed"

if [ -z "$mismatches" ]; then
  {
    echo "## Docs drift gate"
    echo ""
    echo "No drift detected — commands/primitives changes match their docs."
  } >> "$GITHUB_STEP_SUMMARY"
  exit 0
fi

{
  echo "## Docs drift — informational only"
  echo ""
  echo "The following commands/primitives changed in this PR without a matching"
  echo "\`docs/use/*\` update. After one cycle of tuning this gate will start blocking;"
  echo "please consider adding the docs update in the same PR."
  echo ""
  printf '%s' "$mismatches"
  echo ""
  echo "_Suppressing this is fine if the change is intentionally code-only — type-only refactor, internal-only signature change, etc. The blocking phase will add an explicit \`[skip-docs-gate]\` PR-label escape hatch._"
} > /tmp/docs-pr-gate.md

cat /tmp/docs-pr-gate.md >> "$GITHUB_STEP_SUMMARY"

{
  echo "$COMMENT_TAG"
  cat /tmp/docs-pr-gate.md
} > /tmp/docs-pr-gate-body.md

gh api "repos/${REPO}/issues/${PR_NUMBER}/comments" \
  | jq -r --arg tag "$COMMENT_TAG" '.[] | select(.body | startswith($tag)) | .id' \
  | xargs -r -I{} gh api -X DELETE "repos/${REPO}/issues/comments/{}"

gh api -X POST "repos/${REPO}/issues/${PR_NUMBER}/comments" \
  --field body=@/tmp/docs-pr-gate-body.md

exit 0
