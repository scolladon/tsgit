#!/usr/bin/env bash
# Verifies the published tarball: size cap, content inventory, and types
# resolution. Run via `npm run verify:tarball` or in CI on tag push.

set -euo pipefail

# 500 KiB compressed cap from Phase 11 design §6. The Phase 10 dist is around
# 220 KiB so the cap provides headroom without inviting drift.
SIZE_CAP=$((500 * 1024))

# `npm pack` prints the tarball filename on stdout; capture that directly so
# we never pick up a stale .tgz from a previously-interrupted run.
TARBALL=$(npm pack --silent)
INVENTORY=$(mktemp -t tsgit-tarball-inventory.XXXXXX)
SIZE=$(wc -c < "$TARBALL" | tr -d ' ')

cleanup() {
  rm -f "$TARBALL" "$INVENTORY"
}
trap cleanup EXIT

if (( SIZE > SIZE_CAP )); then
  echo "FAIL: tarball ${TARBALL} is ${SIZE} bytes (cap ${SIZE_CAP})" >&2
  exit 1
fi

tar -tzf "$TARBALL" >"$INVENTORY"

# Required content.
grep -E "^package/dist/" "$INVENTORY" >/dev/null || {
  echo "FAIL: tarball missing dist/" >&2
  exit 1
}
grep -E "^package/package\.json$" "$INVENTORY" >/dev/null || {
  echo "FAIL: tarball missing package.json" >&2
  exit 1
}
grep -E "^package/LICENSE$" "$INVENTORY" >/dev/null || {
  echo "FAIL: tarball missing LICENSE" >&2
  exit 1
}
grep -E "^package/README\.md$" "$INVENTORY" >/dev/null || {
  echo "FAIL: tarball missing README.md" >&2
  exit 1
}

# Forbidden content.
for forbidden in "^package/src/" "^package/test/" "^package/reports/" "^package/\.claude/" "^package/\.github/"; do
  if grep -E "$forbidden" "$INVENTORY" >/dev/null; then
    echo "FAIL: tarball contains forbidden path matching ${forbidden}" >&2
    exit 1
  fi
done

# Resolution check — call the pinned, locally-installed attw rather than
# `npx --yes` so the version cannot drift between this check and the published
# release. node_modules/.bin/attw is provisioned by `npm ci` upstream.
node_modules/.bin/attw --pack "$TARBALL" --profile node16 || {
  echo "FAIL: arethetypeswrong reported issues" >&2
  exit 1
}

echo "OK: tarball ${TARBALL} verified at ${SIZE} bytes."
