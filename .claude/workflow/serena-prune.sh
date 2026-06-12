#!/bin/bash
# tsgit forge declination — pre-teardown: prune Serena's record of the worktree being
# removed, so a later activate_project doesn't trip over a deleted path (the matched
# pair of the branch-phase activation). Defensive and idempotent: Serena's on-disk
# layout may evolve; prune what exists, succeed regardless.
#
# Usage: serena-prune.sh <worktree-path>   (invoked by forge worktree-teardown.sh)
set -euo pipefail

WT="${1:?usage: serena-prune.sh <worktree-path>}"
NAME=$(basename "$WT")
SERENA="$HOME/.serena"

[ -d "$SERENA" ] || { echo "serena-prune: no ~/.serena — nothing to do."; exit 0; }

pruned=0
if [ -d "$SERENA/projects/$NAME" ]; then
  rm -rf "$SERENA/projects/$NAME"
  echo "serena-prune: removed project dir ~/.serena/projects/$NAME"
  pruned=1
fi

CFG="$SERENA/serena_config.yml"
if [ -f "$CFG" ] && grep -qF "$WT" "$CFG"; then
  TMP=$(mktemp)
  grep -vF "$WT" "$CFG" > "$TMP" && mv "$TMP" "$CFG"
  echo "serena-prune: removed $WT from serena_config.yml"
  pruned=1
fi

[ "$pruned" -eq 0 ] && echo "serena-prune: no Serena record for $NAME — already clean."
exit 0
