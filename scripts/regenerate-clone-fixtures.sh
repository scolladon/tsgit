#!/usr/bin/env bash
# Rebuild test/fixtures/clone-source/source.git from a deterministic commit.
#
# Idempotent: removes the existing fixture, recreates it with pinned author and
# timestamp, and writes the HEAD oid to HEAD-oid.txt so the integration test
# can assert on it without re-running the script.
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
  echo "hello, clone fixture" > README.md
  git add README.md
  GIT_AUTHOR_DATE='2026-05-01T00:00:00Z' \
  GIT_COMMITTER_DATE='2026-05-01T00:00:00Z' \
    git commit -m "initial" --quiet
)

git clone --bare "$DEST/work" "$DEST/source.git" --quiet
git -C "$DEST/source.git" rev-parse HEAD > "$DEST/HEAD-oid.txt"
# Strip hook samples and the description placeholder so the committed fixture
# only carries what git-http-backend needs to serve a clone.
rm -rf "$DEST/source.git/hooks" "$DEST/source.git/description"
rm -rf "$DEST/work"

echo "fixture rebuilt: $DEST/source.git, HEAD = $(cat "$DEST/HEAD-oid.txt")"
