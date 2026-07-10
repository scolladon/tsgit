#!/usr/bin/env bash
# Verifies the published tarball: size cap, content inventory, and types
# resolution. Run via `npm run verify:tarball` or in CI on tag push.

set -euo pipefail

# Compressed tarball cap. The published package ships dual ESM+CJS code plus
# dual .d.ts/.d.cts types (both structurally required — dropping either is a
# breaking change), so the honest floor is code+types ≈ 482 KiB compressed;
# the real pack measures ~504 KiB. The cap is set ~9% above that — tight by
# choice: a change that adds ~47 KiB compressed fires the guard for a
# considered review rather than an automatic bump. Source maps are not shipped,
# so they do not count against this cap.
SIZE_CAP=$((550 * 1024))

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
for forbidden in "^package/src/" "^package/test/" "^package/reports/" "^package/\.claude/" "^package/\.github/" "^package/.*\.map$"; do
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
