#!/usr/bin/env bash
# Verifies the published tarball: size cap, content inventory, and types
# resolution. Run via `npm run verify:tarball` or in CI on tag push.

set -euo pipefail

QUICK=0
for arg in "$@"; do
  case "$arg" in
    --quick) QUICK=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# Compressed tarball cap. The published package ships dual ESM+CJS code plus
# dual .d.ts/.d.cts types (both structurally required — dropping either is a
# breaking change) plus the single-file browser bundle served from the CDN
# root fields, so the honest floor is code+types+bundle ≈ 656 KiB compressed;
# the real pack measures around that mark. The cap is set ~14% above that —
# tight by choice: a change that meaningfully grows any of the three fires the
# guard for a considered review rather than an automatic bump. Source maps are
# not shipped, so they do not count against this cap.
SIZE_CAP=$((750 * 1024))

# Register cleanup before any temp file exists so a failure between two
# creations cannot leak the earlier ones; `rm -f` on the empty placeholders
# is a no-op.
TARBALL=""
INVENTORY=""
BUNDLE=""
cleanup() {
  rm -f "$TARBALL" "$INVENTORY" "$BUNDLE"
}
trap cleanup EXIT

# `npm pack` prints the tarball filename on stdout; capture that directly so
# we never pick up a stale .tgz from a previously-interrupted run.
TARBALL=$(npm pack --silent)
INVENTORY=$(mktemp -t tsgit-tarball-inventory.XXXXXX)
BUNDLE=$(mktemp -t tsgit-browser-bundle.XXXXXX)
SIZE=$(wc -c < "$TARBALL" | tr -d ' ')

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
# The CDN root URLs resolve through the package's top-level unpkg/jsdelivr
# fields, so the expected bundle path is derived from them — the fields become
# verified claims: dropping one, letting them disagree, or renaming the rollup
# output without updating them all fail here instead of shipping silently.
UNPKG_FIELD=$(node -p "require('./package.json').unpkg ?? ''")
JSDELIVR_FIELD=$(node -p "require('./package.json').jsdelivr ?? ''")
if [ -z "$UNPKG_FIELD" ] || [ "$UNPKG_FIELD" != "$JSDELIVR_FIELD" ]; then
  echo "FAIL: package.json unpkg/jsdelivr must both name the browser bundle (unpkg='${UNPKG_FIELD}' jsdelivr='${JSDELIVR_FIELD}')" >&2
  exit 1
fi
BUNDLE_MEMBER="package/${UNPKG_FIELD#./}"
grep -Fx "$BUNDLE_MEMBER" "$INVENTORY" >/dev/null || {
  echo "FAIL: tarball missing ${UNPKG_FIELD} (the unpkg/jsdelivr target)" >&2
  exit 1
}

# Forbidden content.
for forbidden in "^package/src/" "^package/test/" "^package/reports/" "^package/\.claude/" "^package/\.github/" "^package/.*\.map$"; do
  if grep -E "$forbidden" "$INVENTORY" >/dev/null; then
    echo "FAIL: tarball contains forbidden path matching ${forbidden}" >&2
    exit 1
  fi
done

# Artefact shape. The browser bundle is the no-build CDN entry: a <script
# type="module"> must fetch it and nothing else. Any surviving module specifier
# means the build re-split and consumers would pay extra round trips. The
# import predicate anchors on statement position (start of file, or after ; })
# so the word "import" inside a string literal cannot false-positive the gate.
tar -xzOf "$TARBALL" "$BUNDLE_MEMBER" >"$BUNDLE"

if LC_ALL=C grep -aqE '(^|[;}])[[:space:]]*import[[:space:]]*[{*'\''"(A-Za-z]' "$BUNDLE"; then
  echo "FAIL: browser bundle contains an import statement — it is not single-file" >&2
  exit 1
fi
if LC_ALL=C grep -aqE '[}][[:space:]]*from[[:space:]]*["'\'']' "$BUNDLE"; then
  echo "FAIL: browser bundle contains a re-export — it is not single-file" >&2
  exit 1
fi
if LC_ALL=C grep -aqE '(^|[^A-Za-z0-9_$])export[[:space:]]*\*[[:space:]]*from' "$BUNDLE"; then
  echo "FAIL: browser bundle contains a star re-export — it is not single-file" >&2
  exit 1
fi
if LC_ALL=C grep -aqE '["'\'']node:' "$BUNDLE"; then
  echo "FAIL: browser bundle references a node: specifier — it cannot run in a browser" >&2
  exit 1
fi

# The single-file checks above are absence-only and a CommonJS artefact would
# pass them all; assert the bundle is actually ESM by requiring an export
# statement to survive minification.
if ! LC_ALL=C grep -aqE '(^|[^A-Za-z0-9_$])export[[:space:]]*[{*]' "$BUNDLE"; then
  echo "FAIL: browser bundle carries no export statement — it is not an ESM module" >&2
  exit 1
fi

# Export parity. The bundle must expose exactly the surface the code-split
# browser entry exposes — no addition, no removal. Both files are imported
# from dist/, which is byte-for-byte what npm pack just archived.
node --input-type=module -e '
import { pathToFileURL } from "node:url";
const root = pathToFileURL(process.cwd() + "/").href;
const esm = Object.keys(await import(new URL("dist/esm/index.browser.js", root).href)).sort();
const bundle = Object.keys(await import(new URL("dist/browser/tsgit.js", root).href)).sort();
if (esm.length !== bundle.length || esm.some((name, i) => name !== bundle[i])) {
  console.error(`FAIL: bundle exports (${bundle.length}) differ from dist/esm/index.browser.js (${esm.length})`);
  process.exit(1);
}
' || exit 1

# Resolution check — call the pinned, locally-installed attw rather than
# `npx --yes` so the version cannot drift between this check and the published
# release. node_modules/.bin/attw is provisioned by `npm ci` upstream.
if (( QUICK == 0 )); then
  node_modules/.bin/attw --pack "$TARBALL" --profile node16 || {
    echo "FAIL: arethetypeswrong reported issues" >&2
    exit 1
  }
fi

echo "OK: tarball ${TARBALL} verified at ${SIZE} bytes."
