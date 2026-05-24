#!/usr/bin/env bash
# Rebuild test/fixtures/clone-source/source.git from a deterministic 5-commit chain.
#
# Idempotent: removes the existing fixture, recreates it with pinned author and
# timestamps, and writes the HEAD oid to HEAD-oid.txt + the per-commit history
# (oldest → newest) to HEAD-history.txt so the integration tests can assert on
# both the tip and the shallow boundary without re-running the script.
#
# Requires the `git` CLI on $PATH. CI runners (Ubuntu, macOS) have it
# pre-installed; Windows is out of scope for this fixture (Phase 14.4 work).

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
DEST="$ROOT/test/fixtures/clone-source"

rm -rf "$DEST"
mkdir -p "$DEST/work"

(
  cd "$DEST/work"
  git init --initial-branch=main --quiet
  git config user.email "fixture@tsgit.invalid"
  git config user.name  "tsgit fixture"
  for i in 1 2 3 4 5; do
    echo "commit-${i}" > "file-${i}.txt"
    git add "file-${i}.txt"
    GIT_AUTHOR_DATE="2026-05-0${i}T00:00:00Z" \
    GIT_COMMITTER_DATE="2026-05-0${i}T00:00:00Z" \
      git commit -m "commit ${i}" --quiet
  done
)

git clone --bare "$DEST/work" "$DEST/source.git" --quiet
git -C "$DEST/source.git" rev-parse HEAD > "$DEST/HEAD-oid.txt"
# Oldest → newest, one oid per line. Used by integration tests to assert on
# the shallow boundary (HEAD = last line) without re-computing the oids.
git -C "$DEST/source.git" rev-list --reverse HEAD > "$DEST/HEAD-history.txt"
# Strip the clone-induced [remote "origin"] section so the committed fixture
# does not leak the absolute path of the regeneration host.
git -C "$DEST/source.git" config --remove-section remote.origin 2>/dev/null || true
# Strip hook samples and the description placeholder so the committed fixture
# only carries what git-http-backend needs to serve a clone.
rm -rf "$DEST/source.git/hooks" "$DEST/source.git/description"
# Git does not track empty directories. Without these .gitkeep files the
# committed fixture has no `refs/`, `objects/info/`, or `objects/pack/`
# directories — git-http-backend on a fresh checkout then reports
# "Not a git repository" because the directory layout is invalid.
touch "$DEST/source.git/refs/heads/.gitkeep"
touch "$DEST/source.git/refs/tags/.gitkeep"
touch "$DEST/source.git/objects/info/.gitkeep"
touch "$DEST/source.git/objects/pack/.gitkeep"
rm -rf "$DEST/work"

echo "fixture rebuilt: $DEST/source.git, HEAD = $(cat "$DEST/HEAD-oid.txt")"
echo "history (oldest → newest):"
cat "$DEST/HEAD-history.txt"
