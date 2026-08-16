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
# root fields. Since the per-command export split (one rollup entry per
# `src/application/commands/*.ts`, ADR-640), that runtime/types pair is now
# emitted across 60 entries and 143 shared chunks instead of 11 entries and
# 16 chunks, so the honest floor moved with it. Measured: published 3.3.0
# packed 94 files / 736 732 B (95.9% of the old 750 KiB cap); the real
# split-build pack, packed and measured in this change, is 580 files /
# 867 276 B — 846.95 KiB, 112.9% of the old cap, which is why it FAILed and
# the cap had to move. The new cap is set ~14% above the honest pre-split
# floor (≈825 KiB, the registry-corrected projection that grounded this
# number before the split was built) — the same convention that produced
# 750 KiB from a 656 KiB floor — leaving ~93 KiB of headroom over the actual
# pack, so a change that meaningfully grows any of the three still fires the
# guard for a considered review rather than an automatic bump. Source maps
# are not shipped, so they do not count against this cap.
SIZE_CAP=$((940 * 1024))

# Register cleanup before any temp file exists so a failure between two
# creations cannot leak the earlier ones; `rm -f` on the empty placeholders
# is a no-op.
PACKDIR=""
INVENTORY=""
BUNDLE=""
DEFAULT_ENTRY_DIR=""
RESOLVE_DIR=""
cleanup() {
  rm -f "$INVENTORY" "$BUNDLE"
  if [ -n "$PACKDIR" ]; then rm -rf "$PACKDIR"; fi
  if [ -n "$DEFAULT_ENTRY_DIR" ]; then rm -rf "$DEFAULT_ENTRY_DIR"; fi
  if [ -n "$RESOLVE_DIR" ]; then rm -rf "$RESOLVE_DIR"; fi
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

# Subpath resolution guard (ADR-644). `attw --pack` enumerates `exports`
# keys literally and prints "(wildcard)" for a pattern without resolving
# anything behind it — that is precisely how a `./commands/*` wildcard whose
# only built file was `commands/index` shipped past a green check:exports
# while every other command subpath 404'd. This proves what attw cannot:
# every concrete specifier the packed `exports` map promises — explicit keys
# and wildcard expansions alike — actually loads. It runs unconditionally
# (not gated by QUICK) because it is the check this file exists to host, and
# early — before any content/shape check below — so a broken specifier fails
# on its own resolution error rather than as a side effect of some other
# check tripping over the same missing file. Resolved against the packed
# tree, never the worktree's dist/, or it would verify files
# `files: ["dist","LICENSE","README.md"]` might not ship; and through
# Node's own resolver via dynamic `import()`, never path arithmetic, because
# the defect is a *resolution* failure and path arithmetic proves nothing
# about it.
RESOLVE_DIR=$(mktemp -d -t tsgit-resolve.XXXXXX)
mkdir -p "$RESOLVE_DIR/node_modules/@scolladon"
tar -xzf "$TARBALL" -C "$RESOLVE_DIR"
mv "$RESOLVE_DIR/package" "$RESOLVE_DIR/node_modules/@scolladon/tsgit"

RESOLVE_DIR="$RESOLVE_DIR" node --input-type=module -e '
import { existsSync, readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";

const pkgDir = path.resolve(process.env.RESOLVE_DIR, "node_modules/@scolladon/tsgit");
const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));

// A leaf conditions node carries a `default` runtime target somewhere in
// its condition tree (node/browser/default, import/require, ...); walk
// down to the first one found — every branch of a given key shares the
// same `*` position, so any branch is representative for wildcard expansion.
const findRuntimeTarget = (node) => {
  if (node === null || typeof node !== "object") return undefined;
  if (typeof node.default === "string") return node.default;
  for (const child of Object.values(node)) {
    const found = findRuntimeTarget(child);
    if (found !== undefined) return found;
  }
  return undefined;
};

const specifiers = new Set();
for (const [key, node] of Object.entries(pkg.exports ?? {})) {
  const target = findRuntimeTarget(node);
  if (target === undefined) continue;
  if (!key.includes("*")) {
    specifiers.add(key);
    continue;
  }
  const keyDir = path.posix.dirname(key);
  const targetDir = path.posix.dirname(target);
  const targetSuffix = path.posix.basename(target).replace("*", "");
  const absTargetDir = path.join(pkgDir, targetDir);
  if (!existsSync(absTargetDir)) continue;
  for (const file of readdirSync(absTargetDir)) {
    if (!file.endsWith(targetSuffix)) continue;
    const stem = file.slice(0, -targetSuffix.length);
    specifiers.add(`${keyDir}/${stem}`);
  }
}

const failures = [];
for (const key of [...specifiers].sort()) {
  const specifier = key === "." ? pkg.name : `${pkg.name}${key.slice(1)}`;
  try {
    await import(specifier);
  } catch (err) {
    failures.push(`${specifier}: ${err.code ?? err.message}`);
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`${specifiers.size} export subpaths resolve.`);
' || {
  echo "FAIL: one or more exports subpaths failed to resolve from the packed tarball" >&2
  exit 1
}

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
