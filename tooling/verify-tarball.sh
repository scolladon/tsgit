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
PACKDIR=""
INVENTORY=""
BUNDLE=""
DEFAULT_ENTRY_DIR=""
cleanup() {
  rm -f "$INVENTORY" "$BUNDLE"
  if [ -n "$PACKDIR" ]; then rm -rf "$PACKDIR"; fi
  if [ -n "$DEFAULT_ENTRY_DIR" ]; then rm -rf "$DEFAULT_ENTRY_DIR"; fi
}
trap cleanup EXIT

# Pack into a private temp directory: `attw --pack` (check:exports) packs the
# same default filename into the repo root, and the two checks run
# concurrently under wireit — sharing the root makes each one's cleanup race
# the other's. `npm pack` prints the tarball filename on stdout; capture that
# directly so we never pick up a stale .tgz from a previously-interrupted run.
PACKDIR=$(mktemp -d -t tsgit-pack.XXXXXX)
TARBALL="$PACKDIR/$(npm pack --silent --pack-destination "$PACKDIR")"
INVENTORY=$(mktemp -t tsgit-tarball-inventory.XXXXXX)
BUNDLE=$(mktemp -t tsgit-browser-bundle.XXXXXX)
SIZE=$(wc -c < "$TARBALL" | tr -d ' ')

if (( SIZE > SIZE_CAP )); then
  echo "FAIL: tarball $(basename "$TARBALL") is ${SIZE} bytes (cap ${SIZE_CAP})" >&2
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
# static-import predicate anchors on statement position (start of line, or
# after ; }) so the word "import" inside a string literal does not trip the
# gate; the dynamic-import predicate needs no anchor because the `("`/`('`
# suffix does not occur in prose.
tar -xzOf "$TARBALL" "$BUNDLE_MEMBER" >"$BUNDLE"

if LC_ALL=C grep -aqE '(^|[;}])[[:space:]]*import[[:space:]]*[{*'\''"(A-Za-z]' "$BUNDLE"; then
  echo "FAIL: browser bundle contains an import statement — it is not single-file" >&2
  exit 1
fi
if LC_ALL=C grep -aqE 'import[[:space:]]*\([[:space:]]*["'\'']' "$BUNDLE"; then
  echo "FAIL: browser bundle contains a dynamic import — it is not single-file" >&2
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
if LC_ALL=C grep -aqE '(import|from|require)[^"'\'']*["'\'']node:' "$BUNDLE"; then
  echo "FAIL: browser bundle references a node: specifier — it cannot run in a browser" >&2
  exit 1
fi

# The default entry (package.json "." default condition + ./auto/memory) is the
# runtime-agnostic one: a node: specifier there hard-fails any runtime without
# node builtins (plain browsers, workerd without nodejs_compat). Check the
# entry file AND every chunk in its static import graph.
DEFAULT_ENTRY_DIR=$(mktemp -d -t tsgit-default-entry.XXXXXX)
tar -xzf "$TARBALL" -C "$DEFAULT_ENTRY_DIR" 'package/dist/esm'
if ! DEFAULT_ENTRY_DIR="$DEFAULT_ENTRY_DIR" node --input-type=module -e '
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
const seen = new Set();
const queue = [resolve(process.env.DEFAULT_ENTRY_DIR, "package/dist/esm/index.default.js")];
const specifierRe = /(?:import|from)\s*["'"'"']([^"'"'"']+)["'"'"']|import\s*\(\s*["'"'"']([^"'"'"']+)["'"'"']\s*\)/g;
while (queue.length > 0) {
  const file = queue.pop();
  if (seen.has(file)) continue;
  seen.add(file);
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(specifierRe)) {
    const spec = match[1] ?? match[2];
    if (spec === undefined) continue;
    if (spec.startsWith("node:")) {
      console.error(`node: specifier "${spec}" reachable from index.default.js via ${file}`);
      process.exit(1);
    }
    if (spec.startsWith(".")) queue.push(resolve(dirname(file), spec));
  }
}
' ; then
  echo "FAIL: the default (runtime-agnostic) entry reaches a node: specifier" >&2
  exit 1
fi

# The single-file checks above are absence-only and a CommonJS artefact would
# pass them all; assert the bundle is actually ESM by requiring a
# statement-position export to survive minification.
if ! LC_ALL=C grep -aqE '(^|[;}])[[:space:]]*export[[:space:]]*[{*]' "$BUNDLE"; then
  echo "FAIL: browser bundle carries no export statement — it is not an ESM module" >&2
  exit 1
fi

# Export parity. The bundle must expose exactly the surface the code-split
# browser entry exposes — no addition, no removal. Both files are imported
# from dist/, which is byte-for-byte what npm pack just archived; the bundle
# path is the same unpkg-derived one every other check uses.
BUNDLE_REL="${UNPKG_FIELD#./}" node --input-type=module -e '
import { pathToFileURL } from "node:url";
const root = pathToFileURL(process.cwd() + "/").href;
const esm = Object.keys(await import(new URL("dist/esm/index.browser.js", root).href)).sort();
const bundle = Object.keys(await import(new URL(process.env.BUNDLE_REL, root).href)).sort();
const missing = esm.filter((name) => !bundle.includes(name));
const extra = bundle.filter((name) => !esm.includes(name));
if (missing.length > 0 || extra.length > 0) {
  console.error(`missing from bundle: [${missing.join(", ")}] — extra in bundle: [${extra.join(", ")}]`);
  process.exit(1);
}
' || {
  echo "FAIL: browser bundle export set differs from dist/esm/index.browser.js" >&2
  exit 1
}

# Resolution check — call the pinned, locally-installed attw rather than
# `npx --yes` so the version cannot drift between this check and the published
# release. node_modules/.bin/attw is provisioned by `npm ci` upstream.
if (( QUICK == 0 )); then
  node_modules/.bin/attw --pack "$TARBALL" --profile node16 || {
    echo "FAIL: arethetypeswrong reported issues" >&2
    exit 1
  }
fi

echo "OK: tarball $(basename "$TARBALL") verified at ${SIZE} bytes."
