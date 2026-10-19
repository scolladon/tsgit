#!/bin/bash
# Stop hook: keeps the "## Release order" table in docs/BACKLOG.md in sync with
# the open work. Every `[ ]`/`[~]` backlog id and every open GitHub issue must
# appear in the table, struck or not; a shipped id (`[x]`/`[-]`) or a closed
# issue must be struck (~~id~~). Drift blocks the turn (exit 2) so the session inserts the
# item at its rank before ending; the second stop in a row (stop_hook_active)
# lets the turn end, so a session can never be trapped.
#
# Cost: local greps on every stop; `gh` at most once per 10 minutes (cache).

set -euo pipefail

cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)"
BACKLOG="docs/BACKLOG.md"
[[ -f "$BACKLOG" ]] || exit 0

INPUT=$(cat)
if grep -qE '"stop_hook_active"[[:space:]]*:[[:space:]]*true' <<<"$INPUT"; then
  exit 0
fi

# Table body: heading to next heading, version-like tokens removed (6.0.0,
# git 2.56). A struck id (~~id~~) still counts as listed, so a PR may strike the
# item it is about to close; a strike only exempts the id from the stale check.
TABLE=$(awk '/^## Release order/{f=1;next} /^## /{f=0} f' "$BACKLOG" \
  | sed -E 's/\b[0-9]+\.[0-9]+\.[0-9x]+\b//g; s/git 2\.[0-9]+(\.x)?//g')
[[ -n "$TABLE" ]] || exit 0
UNSTRUCK=$(sed -E 's/~~[^~]*~~//g' <<<"$TABLE")

listed_ids=$(grep -oE '\b[0-9]+\.[0-9]+\b' <<<"$TABLE" | sort -u || true)
listed_issues=$(grep -oE '#[0-9]+' <<<"$TABLE" | tr -d '#' | sort -u || true)
unstruck_ids=$(grep -oE '\b[0-9]+\.[0-9]+\b' <<<"$UNSTRUCK" | sort -u || true)
unstruck_issues=$(grep -oE '#[0-9]+' <<<"$UNSTRUCK" | tr -d '#' | sort -u || true)
open_ids=$(grep -oE '^- \[[ ~]\] \*\*[0-9]+\.[0-9]+\*\*' "$BACKLOG" | grep -oE '[0-9]+\.[0-9]+' | sort -u || true)
done_ids=$(grep -oE '^- \[[x-]\] \*\*[0-9]+\.[0-9]+\*\*' "$BACKLOG" | grep -oE '[0-9]+\.[0-9]+' | sort -u || true)

DRIFT=""
NOTE=""
missing=$(comm -23 <(echo "$open_ids") <(echo "$listed_ids"))
[[ -n "$missing" ]] && DRIFT+=$'\n'"- open backlog ids missing from the table: $(tr '\n' ' ' <<<"$missing")"
stale=$(comm -12 <(echo "$done_ids") <(echo "$unstruck_ids"))
[[ -n "$stale" ]] && DRIFT+=$'\n'"- shipped backlog ids listed without their strike: $(tr '\n' ' ' <<<"$stale")"

CACHE="${TMPDIR:-/tmp}/tsgit-release-order-issues.txt"
if [[ ! -f "$CACHE" ]] || [[ -n "$(find "$CACHE" -mmin +10 2>/dev/null)" ]]; then
  if gh issue list --state all --limit 500 --json number,state \
      --jq '.[] | "\(.number) \(.state)"' >"$CACHE.tmp" 2>/dev/null; then
    mv "$CACHE.tmp" "$CACHE"
  else
    rm -f "$CACHE.tmp"
    NOTE="release-order: issue check skipped (gh unavailable); backlog ids checked only"
  fi
fi
if [[ -f "$CACHE" ]]; then
  open_issues=$(awk '$2=="OPEN"{print $1}' "$CACHE" | sort -u)
  closed_issues=$(awk '$2!="OPEN"{print $1}' "$CACHE" | sort -u)
  missing=$(comm -23 <(echo "$open_issues") <(echo "$listed_issues"))
  [[ -n "$missing" ]] && DRIFT+=$'\n'"- open issues missing from the table: #${missing//$'\n'/ #}"
  stale=$(comm -12 <(echo "$closed_issues") <(echo "$unstruck_issues"))
  [[ -n "$stale" ]] && DRIFT+=$'\n'"- closed issues listed without their strike: #${stale//$'\n'/ #}"
fi

if [[ -n "$DRIFT" ]]; then
  {
    echo "docs/BACKLOG.md '## Release order' is out of sync with the open work:"
    echo -e "$DRIFT"
    echo "Insert each missing id at its rank (rank rule in the table header; never append)."
    echo "Strike shipped ids in place as ~~id~~ / ~~#N~~."
    [[ -n "$NOTE" ]] && echo "$NOTE"
  } >&2
  exit 2
fi
[[ -n "$NOTE" ]] && echo "$NOTE"
exit 0
