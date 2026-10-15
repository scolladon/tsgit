# Design — byte-exact index entry paths

> Brief: index entry paths are decoded with the BOM-stripping `decode`
> (`src/domain/git-index/index-parser.ts:117`), so any tsgit index write renames an entry whose
> path starts with U+FEFF, and rewrites a non-UTF-8 entry name as U+FFFD. Decode entry paths
> losslessly, on the model of the cache-tree's `nameBytes` (#317), and close every route that can
> drop or re-admit the lossy name: parse, write, order, match, index → tree, tree → index.
> Backlog 32.21 (data integrity).
> Status: draft → self-reviewed ×3

<!-- cspell:ignore xbfz injectivity xffit cgit bytewise FEFF FFFD DFFF EFBBBF EFBFBD efbbbf efbfbd ffff latin1 Latin1 roundtrip unpaired -->

## Context

### Binding constraints

| Source | Constraint on this design |
|---|---|
| ADR-226 / CLAUDE.md (git-faithfulness) | git stores entry paths as opaque bytes. Every rule below comes from the pinned matrix (§D1), not from memory. |
| ADR-249 (structured data only) | Any new field is data (raw bytes), not a rendering. No display string is added. |
| ADR-966 | Entries are ordered by the UTF-8 bytes of their path, then by stage. A raw-byte path must order by its raw bytes. |
| #317 cache-tree `nameBytes` (`CacheTreeEntry.nameBytes`, `cache-tree.ts`) | House pattern: decode for display, keep raw bytes only when they do not round-trip, ASCII short-circuit, `slice()` copies, writers emit the bytes verbatim, matching keys on bytes. |
| Tree side (`TreeEntry.nameBytes`, `WalkTreeOptions.pathBytes`, `resolve-tree-path.ts:208`) | Bytes are authoritative, the decoded string is a display view, matches use bytes. `TreeEntry.name` is already `decodePreservingBom(nameBytes)`. |
| ADR-963 / 964 / 965 | A content-changing index write invalidates the cache-tree along the changed paths. A changed lossy path must invalidate the subtree whose `nameBytes` carry it. |
| CLAUDE.md performance priorities | The index parse is a hot path (every command). UTF-8 paths must not allocate more than today. |

All pins below ran in `mktemp -d` throwaways, never in this worktree.

### What exists today (verified in the tree, main `732b6172`)

| Asset | File : symbol | Status for this feature |
|---|---|---|
| Entry parse | `src/domain/git-index/index-parser.ts` — `parseIndex(bytes, digestLength)`; line 117 `const path = decode(bytes.subarray(offset, pathEnd));`, line 118 `validateIndexPath(path, entryStart, mode)`, line 139 `path: FilePathFactory.from(path)` | **Change** (§D3) |
| Cache-tree parse | same file, `parseCacheTreeEntry` lines 269-271 (`decode(rawName)`, `roundTrips(path, rawName) ? undefined : rawName.slice()`), `roundTrips` lines 308-316 (`ASCII_LIMIT = 0x80`) | `roundTrips` reused for entries |
| Codecs | `src/domain/objects/encoding.ts` — `decode` (line 78, default `TextDecoder`: strips a leading BOM, maps invalid bytes to U+FFFD), `decodePreservingBom` (line 91, `ignoreBOM: true`), `encode`, `compareBytes` (line 35), `bytesEqual` | Reused |
| Index model | `src/domain/git-index/index-entry.ts` — `IndexEntry { …, path: FilePath }` (lines 20-34); `CacheTreeEntry.nameBytes?` (lines 52-63); `skipWorktreeEntry` (lines 128-146) | **Change** (§D2) |
| Writer + order | `src/domain/git-index/index-writer.ts` — `serializeIndex` (line 110; line 115 `encode(entry.path as string)`), `writeEntry` (line 165; name length `Math.min(pathBytes.length, 0xfff)` line 183), `compareEntryPath` (57), `comparePathStrings` (61), `pathStringComparatorFor` (82), `pathComparatorFor` (93), `inOrder` (100) | **Change** (§D4) |
| Index diff | `src/domain/git-index/diff-index-entries.ts` — `IndexChange { changedPaths: ReadonlyArray<FilePath>, trackedSetChanged, resolvedUnmerged }`, `comparatorForBoth`, `collectChangedPaths` (`mark` dedups on `entry.path`), `skipSamePath`, `pathSetsDiffer` | **Change** (§D6) |
| Extension carry | `src/domain/git-index/carry-extensions.ts` — `carryTree` → `invalidateCacheTree(root, change.changedPaths)`; `withRestagedPaths(change, restagedPaths)` sorts with `pathStringComparatorFor` | **Change** (§D6) |
| Cache-tree | `src/domain/git-index/cache-tree.ts` — `invalidateCacheTree(root, paths: ReadonlyArray<FilePath>)` splits on `'/'`; `keyOfBytes`, `keyOfComponent`, `keyOfChild`, `groupByComponent` | **Change** (§D6) |
| Path validation | `src/domain/git-index/path-validator.ts` — `validateIndexPath(path, offset, mode)` → `verifyPath` (`src/domain/path/verify-path.ts`; HFS ignorable set includes `0xfeff`, line 32) | Unchanged (§D9) |
| Index lock | `src/application/primitives/internal/index-lock.ts` — `IndexLock.commit(entries, kind)`; `withRefreshedStat` (line 211, `new Map(refreshed.map((e) => [e.path, e]))`); the carry diff (line 197) | **Change** (§D5) |
| Racy smudge | `src/application/primitives/internal/smudge-racily-clean.ts` — `carriedOver` (line 60, `racyByPath` keyed on `entry.path`) | **Change** (§D5) |
| Index → tree | `src/application/commands/commit.ts` — `buildTreeFromIndex` (line 393; `insertEntry` splits `entry.path` on `'/'`, `files: Map<string, …>`, `subdirs: Map<string, …>`; `writeSubtree` → `treeEntry(mode, name, id)`); `src/application/primitives/synthesize-tree-from-index.ts` — `synthesizeTreeFromIndex` (line 216), `buildTrieFrames` (163), `treeEntry(file.mode, file.path, file.id)` (187), `treeEntry(FILE_MODE.DIRECTORY, frame.name, subId)` (206) | **Change** (§D7) |
| Tree → index | `src/application/primitives/build-index-from-tree.ts` — `donorByPath` (60), `collectLeaves` (69, `walkTree` without options), `zeroStatEntry` (78), `buildIndexFromTree` (125); `src/application/primitives/materialize-tree.ts` — `collectTargetEntries` (98), `filterByPaths`, `indexEntriesByPath`, `writtenEntriesByPath`, `preserveOutOfScope`, `mergeNewIndexEntries`, `materializeTree` (252); `src/application/primitives/apply-changeset.ts` (entry built from `relPath`, line ~288) | **Change** (§D8) |
| Tree walk | `src/application/primitives/walk-tree.ts` — `WalkTreeOptions.pathBytes` (fresh array per entry when on), `nextFrameEntry`, `buildRootPrefix`, `buildChildPrefix`, `buildYieldedEntry`; `WalkTreeEntry.pathBytes?` (`src/application/primitives/types.ts:211`) | **Change** (§D8) |
| Tree entry | `src/domain/objects/tree.ts` — `treeEntry(mode, name: string \| Uint8Array, id)` (copies bytes; `name = decodePreservingBom(nameBytes)`) | Reused (bytes overload) |
| Index-writing commands with path-keyed maps | `add.ts` (`existing`/`newEntries: Map<FilePath, IndexEntry>`, lines 231-266, 586-652), `rm.ts` (`byPath`, lines 87-115), `mv.ts` (`readIndexMap` 129, `applyToIndex` 298, spread `{ ...entry, path: newPath }` line 306), `internal/apply-sparse-checkout.ts` (`toSkipWorktree` rebuilds without spread, `writtenByPath` 185), `internal/unstage-changes-unless-new.ts` (`byPath` → `comparePathStrings`, `occupiedBy` Sets), `submodule.ts:617`, `status.ts:225` (`stage0Map`), `stash.ts:376` (`tracked` Set), `internal/clean-work-tree.ts:40`, `find-would-overwrite.ts:88`, `compute-changeset.ts:45`, `apply-merge-to-worktree.ts:293` | **Change** (§D5) |
| Interop harness | `test/integration/interop-helpers.ts` (`makePeerPair`, `initBothRepos`, `runGit`, `GIT_AVAILABLE`); precedent `test/integration/index-interop.test.ts` (ADR-966 twin) | Extended (§Test strategy) |
| Unit fixtures | `test/unit/domain/git-index/arbitraries.ts` (`arbFilePath`, `arbIndexEntry`, `arbGitIndexV2/V3`, `arbCacheTreeEntry`); `index-parser.test.ts`, `index-writer.test.ts`, `diff-index-entries.test.ts`, `cache-tree.test.ts`, `carry-extensions.test.ts` and their `*.properties.test.ts` siblings; cache-tree `nameBytes` example tests at `cache-tree-parser.test.ts:451-505` | Extended |
| Public API | `GitIndex` / `IndexEntry` (domain) reach `reports/api.json` through `export type * from './domain/git-index/index.js'` (`src/public-types.ts:75`); `readIndex` is public | **Changes** (§D10) |

### Pinning harness

```sh
G()  { env -i PATH="<git-2.55.0>/bin:/usr/bin:/bin" HOME=<tmp>/home GIT_CONFIG_NOSYSTEM=1 \
         GIT_CEILING_DIRECTORIES=<tmp> \
         git -c user.name=t -c user.email=t@t -c init.defaultBranch=main -c commit.gpgsign=false "$@"; }
TS() { node <scratch>/probe.mjs "$@"; }   # esbuild bundle of src/ at 732b6172: add / rm --cached /
                                          # commit / reset --mixed HEAD / status / dump index paths as hex
LSF(){ G ls-files -s -z | …xxd -p; }      # "<mode> <oid> <stage> | <path bytes as hex>"
$ G version
git version 2.55.0
```

Non-UTF-8 names cannot exist as files on APFS, so those entries are staged with
`update-index -z --index-info` (no working-tree file). BOM names are real files.

## Requirements

- **R1** Parsing then writing an index (no entry touched) yields the same path bytes for every entry,
  in the same order, whatever the bytes are (BOM-prefixed, non-UTF-8, overlong, surrogate-encoded).
- **R2** A path that begins with U+FEFF is decoded with the BOM kept: `entry.path` carries it, so it
  matches the working tree name, the tree-walk path and a pathspec exactly as any other UTF-8 name.
- **R3** A path whose bytes are not valid UTF-8 keeps its raw bytes on the entry. The index writer
  emits them verbatim; the name-length field is the raw length.
- **R4** Entries order by raw path bytes then stage (ADR-966), raw-byte entries included. A
  tsgit-written index passes `git fsck` and lists in `git ls-files` the order git lists.
- **R5** Two entries whose bytes differ never collapse into one, even when they decode to the same
  string (`\xff.txt` and `\xef\xbf\xbd.txt`; `caf\xe9` and `caf\xe8`). The same holds for a BOM
  name and its BOM-less twin. Every index-writing command keys entries by a byte-faithful key.
- **R6** Index → tree: `commit` and `synthesizeTreeFromIndex` emit each tree entry name with the
  entry's raw bytes. After a tsgit commit, `git ls-tree -r -z HEAD` lists the index path bytes.
- **R7** Tree → index: `reset`, `read-tree`-style rebuilds and checkout/switch (`buildIndexFromTree`,
  `materializeTree`) carry the tree entry's raw bytes into the index entry.
- **R8** A changed raw-byte path invalidates the cache-tree node whose `nameBytes` it runs through.
  A carried `TREE` never claims an oid for a directory whose entries changed.
- **R9** Valid UTF-8 paths (ASCII or not) cost what they cost today on the parse, write and walk
  hot paths: no extra allocation, at most one extra scan of the decoded string.
- **R10** Path validation verdicts are unchanged for every path git and tsgit both accept today, and
  a BOM-prefixed `.git` alias is still refused.

## Design

### D1. Pinned behaviour (git 2.55.0 vs tsgit `732b6172`)

#### D1.1 Matrix

| # | Setup | git 2.55 | tsgit today | Class |
|---|---|---|---|---|
| A1 | `mkdir $'\uFEFF'a; add .; commit` (+ `z`) | index & tree: `7a` (`z`), `efbbbf612f78` (`\uFEFFa/x`): BOM name sorts after `z` (`EF > 7A`) | — | pin |
| A2 | tsgit reads that index | — | paths `7a`, `612f78`: the BOM is gone, and the in-memory list is out of byte order | parse defect |
| A3 | `echo z2 > z`; **tsgit** `add z`; `git ls-files -s` | — | `612f78` (`a/x`), `7a` (new z): entry renamed; `git fsck` exit 0; `git status`: `AD a/x`, `M  z`, `?? \uFEFFa/` | **data loss** (rename) |
| A4 | then **tsgit** `commit` | — | tree lists `a/x`; `diff-tree HEAD~1 HEAD`: `A a/x`, `M z`, `D \uFEFFa/x` | **data loss** (history) |
| B1 | `update-index --index-info` `\xff.txt`, `b/\xc3`; `commit` | index & tree keep `ff2e747874`, `622fc3`; order `b/\xc3`, `z`, `\xff.txt`; `fsck` exit 0 | — | pin |
| B2 | tsgit reads that index | — | `622fefbfbd`, `7a`, `efbfbd2e747874`: each invalid byte (run) became U+FFFD | parse defect |
| B3 | **tsgit** `add z` (modified) | — | git lists `622fefbfbd`, `7a`, `efbfbd2e747874`: both entries renamed, name lengths grew 1 → 3 bytes | **data loss** (rename) |
| B4 | then **tsgit** `commit` | — | tree has `efbfbd…`; `diff-tree`: `D b/\xc3`, `A b/�`, `M z`, `A �.txt`, `D \xff.txt` | **data loss** (history) |
| C1 | `update-index`: `\xff.txt` (blob x), `\xef\xbf\xbd.txt` (blob y), `\xef\xbb\xbfz` (blob y), plus `z` | 4 entries: `7a`, `efbbbf7a`, `efbfbd2e747874`, `ff2e747874` | — | pin |
| C2 | tsgit reads it | — | paths `z`, `z`, `�.txt`, `�.txt`: two pairs of identical strings | parse defect |
| C3 | **tsgit** `add z` | — | git lists **2** entries: `7a`, `efbfbd2e747874` with blob **x** (the `\xff.txt` blob under the U+FFFD name). `\xef\xbb\xbfz` and the real U+FFFD entry (blob y) are gone | **data loss** (entries dropped) |
| D1 | clean repo with `\uFEFFa/x` and `sub/\uFEFFy` committed by git | `git status` clean | `status`: `a/x` staged-added + unstaged-deleted, `\uFEFFa/x` staged-deleted, `\uFEFFa/x` untracked. `sub/\uFEFFy` (BOM not at path start) reads correctly | wrong report |
| D2 | **tsgit** `rm --cached $'\uFEFF'a/x` | — | `PATHSPEC_NO_MATCH`: the BOM entry cannot be addressed | wrong refusal |
| E1 | HEAD tree has `\xff.txt`, `\uFEFFb`; index lacks them; **tsgit** `reset --mixed HEAD` | `git read-tree HEAD` restores `efbbbf62`, `ff2e747874` | `efbbbf62` (BOM kept: tree names use `decodePreservingBom`), `efbfbd2e747874` (lossy) | **re-admission** route (tree → index) |
| F1 | git index `d/y`, `d/\xff`, `e/f`, valid `TREE`; **tsgit** `add e/f` | — | entries `d/y`, `d/�`, `e/f`; the carried `TREE` keeps `d` valid (only `e/f` changed) | stale cache-tree |
| F2 | then `git write-tree` | tree `d` = cached oid, i.e. `d/\xff` | — | index entries and `TREE` disagree: `git write-tree` emits `\xff`, the entries say U+FFFD; `fsck --cache` exit 0 (undetected) |

git treats entry paths as bytes in every row: no BOM handling, no UTF-8 validation, bytewise order.

#### D1.2 Classification and impact

| Gap | Rows | Impact |
|---|---|---|
| G1 — BOM stripped at parse | A2-A4, D1, D2 | Data loss on **every** tsgit index write (add, rm, mv, commit-time refresh, status refresh write-back, reset, checkout, stash, merge…) in a repo holding one BOM-prefixed top-level path. Read commands misreport. |
| G2 — non-UTF-8 → U+FFFD at parse | B2-B4 | Same write-path data loss for Latin-1 / Shift-JIS / any legacy-encoded name (Linux repos). |
| G3 — distinct byte paths collapse | C2-C3 | Silent loss of whole entries (and their blob association) on any write. Includes the BOM twin pair (`\uFEFFz`/`z`) until G1 is fixed. |
| G4 — tree → index re-admits U+FFFD | E1 | Fixing the parser alone does not close the loop: `reset`/checkout rebuild the entry from the lossy walk path. |
| G5 — index → tree emits U+FFFD | A4, B4 | `commit` rewrites history names. For BOM this closes with G1. For non-UTF-8 the tree emitter needs bytes. |
| G6 — cache-tree keeps a stale node | F1-F2 | An index whose `TREE` and entries disagree: git's next `write-tree`/`commit` resurrects the old bytes. Today a side effect of G2; after the fix it is the invariant R8 protects. |

### D2. Data model

```ts
export interface IndexEntry {
  // … unchanged fields …
  readonly path: FilePath;           // decodePreservingBom(raw): display + matching view
  /**
   * The raw path bytes, present only when `path` does not re-encode to them
   * (a non-UTF-8 name). Writers emit these verbatim.
   */
  readonly pathBytes?: Uint8Array;   // fresh copy (slice), never a view on the index buffer
}
```

- **BOM is not lossy.** `decodePreservingBom` keeps U+FEFF, and `encode` gives `EF BB BF` back, so a
  BOM path round-trips: no `pathBytes`. It matches the working tree (Node's `readdir` keeps the
  BOM, pinned D1: the untracked listing shows `\uFEFFa/x`), the tree walk (`TreeEntry.name` already
  uses `decodePreservingBom`) and a pathspec. This fixes G1 completely (DC2).
- **Invalid UTF-8 is lossy** (any sequence the WHATWG decoder rejects: stray continuation,
  truncated lead, overlong, `ED A0..BF` surrogate encodings, `F5..FF`). `path` holds the U+FFFD view
  and `pathBytes` the truth (DC1).
- **Invariant P (stated on the type, enforced by construction helpers):** `pathBytes === undefined`
  ⇔ `encode(path)` equals the on-disk bytes. Anything that sets `path` to a new value
  must drop or recompute `pathBytes` (§D5.3).
- **Ownership:** parsed entries are shared through the index cache (`readIndex`), so `pathBytes`
  is read-only by contract, like `TreeEntry.nameBytes`. No consumer writes into it.
- **ASCII is never lossy**: the WHATWG decoder never consumes an ASCII byte into an error sequence,
  so `/`, `.` and every ASCII byte sit at the same positions in `path` and `pathBytes`. Segment
  structure (component count, `..`, `.git`) is the same in both views (§D9).

### D3. Parse

```ts
// index-parser.ts, parseIndex loop
const rawPath = bytes.subarray(offset, pathEnd);
const path = decodePreservingBom(rawPath);
const pathBytes = decodesLosslessly(path, rawPath) ? undefined : rawPath.slice();
validateIndexPath(path, entryStart, mode);
…
entries.push(pathBytes === undefined ? { …, path } : { …, path, pathBytes });
```

- `decodesLosslessly(text, raw)` (new, `src/domain/objects/encoding.ts`) is
  `!text.includes('\uFFFD') || bytesEqual(encode(text), raw)`. The BOM-preserving decoder emits
  U+FFFD only for an invalid sequence or a literal `EF BF BD`, and a valid UTF-8 decode re-encodes
  to the same bytes (the WHATWG decoder rejects overlong sequences and surrogate encodings). So a path with
  no U+FFFD is lossless without encoding, and only a path showing U+FFFD pays the re-encode. This
  is cheaper than the cache-tree's `roundTrips`, which must re-encode every non-ASCII name because
  its BOM-stripping `decode` can lose bytes without producing U+FFFD. `roundTrips` stays as is.
- Absent key, not `pathBytes: undefined`: entries keep today's shape for UTF-8 paths, which keeps
  `toEqual` fixtures and the public object shape unchanged (§D10).
- The cache-tree parse keeps `decode` + `nameBytes` (a BOM name there carries `nameBytes`). Both
  views give the same component key (§D6), so no change there.

### D4. Write and order

- `serializeIndex`: `const pathBytes = entry.pathBytes ?? encode(entry.path)`. The length field is
  `Math.min(pathBytes.length, 0xfff)`, as today; it is now the raw length (B3 shows today's 1 → 3
  byte growth).
- `pathComparatorFor(entries)` keeps its pick-once shape, with a third tier:

```ts
export function pathComparatorFor(entries) {
  if (entries.some(hasPathBytes)) return compareEntryBytes;    // new: rare, byte-exact
  return entries.some(isAboveSurrogateStart) ? compareEntryPath : compareUtf16Path;
}
const bytesOf = (e: IndexEntry) => e.pathBytes ?? encode(e.path);
export const compareEntryBytes = (a, b) =>
  a.pathBytes === undefined && b.pathBytes === undefined
    ? comparePathStrings(a.path, b.path)          // both UTF-8: the ADR-966 code-unit rank
    : compareBytes(bytesOf(a), bytesOf(b));       // one side raw: encode the other
```

  `compareEntryPath` becomes `compareEntryBytes` for every caller that passes `IndexEntry` (the
  exported name stays, behaviour widens). `comparePathStrings` / `pathStringComparatorFor` stay
  string-only; their callers (`unstage-changes-unless-new.ts`, `withRestagedPaths`) switch to the
  entry comparator or to keys (§D5, §D6).
- Cost: the third tier is chosen only when an entry has `pathBytes`. The encode of the UTF-8 side
  runs once per comparison in that rare index.

### D5. Keys: no collapse in index-writing code

#### D5.1 The key

```ts
// domain/git-index/index-path-key.ts
export type IndexPathKey = string & { readonly __brand: 'IndexPathKey' };
const LOSSY_KEY_PREFIX = '\0';     // NUL never occurs in a valid entry path (validateIndexPath)
export const indexPathKey = (entry: { path: FilePath; pathBytes?: Uint8Array }): IndexPathKey =>
  (entry.pathBytes === undefined ? entry.path : LOSSY_KEY_PREFIX + latin1(entry.pathBytes)) as IndexPathKey;
```

- Injective: a UTF-8 path is its own key. A lossy key starts with NUL, which no UTF-8 key can
  contain, and `latin1` is one char per byte. Two different byte strings → two different keys.
- Zero cost for UTF-8 paths (no allocation, the key *is* the string). A plain `FilePath` lookup
  (pathspec, working tree, walk path without bytes) is `indexPathKey({ path })`, so it hits every
  UTF-8 entry and never a lossy one. A string cannot name non-UTF-8 bytes, so that is correct.
- The brand makes the compiler reject a `Map<IndexPathKey, …>.get(entry.path)`: each keyed site in
  the sweep fails `check:types` until it is converted.

#### D5.2 Sweep: every path-keyed structure on an index-writing route

| Site | Today | Change |
|---|---|---|
| `add.ts` `existing` / `newEntries` / `walked` maps (231-266, 378-383, 586-652); `restagedPaths.push(previous.path)` (556) | `Map<FilePath, …>` keyed on `entry.path` / walk path; restaged paths as strings | `Map<IndexPathKey, …>`; walk outcomes are UTF-8 (fs strings) → `indexPathKey({ path })`; restaged items become `ChangedPath` projections of `previous` (§D6) |
| `rm.ts` `byPath` (87-115) | `byPath.set(entry.path)`, `byPath.delete(path)` | key by `indexPathKey(entry)`; delete by the matched entry's key, not the pathspec string |
| `mv.ts` `readIndexMap`, `classifySource`, `applyToIndex` (129-306) | `Map<FilePath, …>`; spread `{ ...entry, path: newPath }` | keys; re-path through `withPath` (§D5.3) |
| `index-lock.ts` `withRefreshedStat` (211) | `new Map(refreshed.map(e => [e.path, e]))` | `indexPathKey` |
| `smudge-racily-clean.ts` `carriedOver` (60) | `racyByPath` on `entry.path` | `indexPathKey` |
| `apply-sparse-checkout.ts` `toSkipWorktree` (~161), `writtenByPath` (185) | rebuilds the entry **without spread** (drops `pathBytes`); string map | spread the entry's path fields (`path`, `pathBytes`); keys |
| `unstage-changes-unless-new.ts` `byPath`, `occupiedBy`, the ordered walk at line 62 | `comparePathStrings`; `Set<string>` of paths and ancestor dirs | entry comparator (§D4); key Sets by `indexPathKey`; ancestor dirs of a lossy path are cut from `pathBytes` at `0x2f` |
| `build-index-from-tree.ts` `donorByPath` (60) | `Map<FilePath, IndexEntry>` | keys (§D8) |
| `materialize-tree.ts` `indexEntriesByPath`, `writtenEntriesByPath`, `filterByPaths`, `preserveOutOfScope` | `Map`/`Set<FilePath>` | keys (§D8) |
| `apply-merge-to-worktree.ts:293` `buildUnmergedIndex` sort | `pathComparatorFor(combined)` | inherits §D4 |
| `find-would-overwrite.ts:88` `stage0ByPath` | `Map<FilePath, IndexEntry>`, looked up by merge outcome path | keys; outcome paths are tree strings (merge engine out of scope, §Out of scope) → `indexPathKey({ path })` |
| `compute-changeset.ts:45` `projectIndex` | `Map<FilePath, IndexProjection>` | keys; target side carries walk `pathBytes` (§D8) |
| `stash.ts:376` `tracked`, `clean-work-tree.ts:40` `indexPaths`, `submodule.ts:617`, `status.ts:225` `stage0Map` | `Set`/`Map` of `entry.path` | keys. These sites only read, but status and stash feed later writes |

Read-only consumers that match user strings (`grep`, `blame`, `rev-parse :path`, `checkout.ts:449`
pathspec listing, `archive-subst`) keep `path`: a lossy entry shows its U+FFFD view there and
cannot be addressed by string. Listed in §Out of scope.

#### D5.3 Construction helpers (invariant P)

```ts
// index-entry.ts
// Builds the entry field by field from `entry`'s stat/id/mode/flags, then sets `path` and,
// only when defined, `pathBytes`: the old bytes never ride along to a new path.
export const withPath = (entry: IndexEntry, path: FilePath, pathBytes?: Uint8Array): IndexEntry
```

- `mv` directory moves re-path `d/<raw>` → `e/<raw>` at the byte level when the source entry has
  `pathBytes`: `concat(encode(targetPrefix), pathBytes.subarray(encode(sourcePrefix).length)).slice()`.
  The prefix is a user string (UTF-8), and the ASCII-position invariant (§D2) makes the cut exact.
- A spread that keeps `path` (`{ ...entry, flags }`, `zeroStat`, `clearSkipWorktree`) carries
  `pathBytes` unchanged. That is correct by construction, so those sites need no change.
- `skipWorktreeEntry`, `stage0Entry`, `zeroStatEntry` accept an optional `pathBytes` and set the
  key only when it is defined (absent-key rule of §D3).

### D6. Diff and cache-tree invalidation

- `IndexChange.changedPaths: ReadonlyArray<FilePath>` becomes
  `changedPaths: ReadonlyArray<ChangedPath>` with
  `type ChangedPath = { readonly path: FilePath; readonly pathBytes?: Uint8Array }` (a projection of
  the entry). `mark` dedups on `indexPathKey`. `diffIndexEntries` orders with the §D4 comparator, so
  `comparatorForBoth` picks the strongest tier of the two sides: bytes if either side has
  `pathBytes`, else code-unit rank if either side has a unit ≥ U+D800, else native UTF-16.
- `withRestagedPaths(change, restaged)`: restaged items become `ChangedPath`. The union dedups on
  `indexPathKey` and sorts by `compareBytes(bytesOf)` when any item has bytes, else as today.
- `invalidateCacheTree(root, paths: ReadonlyArray<ChangedPath>)` precomputes component keys:
  a UTF-8 path splits on `'/'` and maps through `keyOfComponent` (as today). A lossy path splits
  `pathBytes` on `0x2f` and maps each component through `keyOfBytes`. `keyOfChild` already
  keys a child by `nameBytes` when present, so a change under `\xff/x` reaches node `\xff`. With
  string keys, the U+FFFD component keys to `latin1(EF BF BD)` and misses the child keyed
  `latin1(FF)`, so that node stays valid over a changed path (R8; F1-F2 show the stale node). A BOM top-level
  component `\uFEFFa` keys to `latin1(EF BB BF 61)` and matches a cache-tree child whose
  `nameBytes` are `EF BB BF 61`. Today the BOM-stripped `a` misses it (part of G1).
- These **component keys** (`latin1` of the component bytes for non-ASCII, the component itself
  for ASCII) are a different scheme from `IndexPathKey` (§D5.1), which keys whole paths. Both use
  one shared `latin1` helper.
- `Pending` becomes `ReadonlyArray<string>` of **keys** (not components). `groupByComponent` stops
  calling `keyOfComponent` per level. That removes one regex test per component per level.

### D7. Index → tree (commit, synthesize)

- `commit.ts buildTreeFromIndex`: `insertEntry` walks the entry's components. For a UTF-8 entry
  these are `path.split('/')` (today). For a lossy entry they are `pathBytes` cut at `0x2f`, each
  component paired with its decoded view. The `files` / `subdirs` maps key on the component key
  (`keyOfComponent` / `keyOfBytes`) and store the name bytes. `writeSubtree` calls
  `treeEntry(mode, nameBytes, id)` (the existing `Uint8Array` overload) whenever the component came
  from bytes, and the string form otherwise.
- `synthesize-tree-from-index.ts`: `PendingEntry` gains `pathBytes?`. `buildTrieFrames` cuts
  bytes at `0x2f` for lossy entries. `treeEntry(file.mode, …)` at line 187 and the directory entry at
  line 206 take bytes when present. `validateIndexPath` / `assertDepthBounded` keep running on the
  string view: same slash count (§D2).
- BOM entries need nothing here: `encode('\uFEFFa')` is `EF BB BF 61`. A4's rename disappears with §D3.

### D8. Tree → index (reset, read-tree rebuild, checkout/switch)

- `walkTree` gains a lossy-only byte channel (DC4): with `{ lossyPathBytes: true }`, a yielded
  entry carries `pathBytes` exactly when its own name or an ancestor's does not round-trip
  (`decodesLosslessly(entry.name, entry.nameBytes)`; `TreeEntry.name` is already
  `decodePreservingBom(nameBytes)`, so the §D3 shortcut holds). The frame prefix records
  "lossy below here" plus the prefix bytes. Bytes are materialised only for lossy frames: a
  non-lossy prefix is `encode(prefix.text)` on demand, which round-trips by definition.
- `buildIndexFromTree.collectLeaves` and `materializeTree.collectTargetEntries` walk with that option,
  carry `pathBytes` on `TargetLeaf` / `TargetEntry`, key donor and written maps with `indexPathKey`,
  and build entries through the §D5.3 helpers.
- `apply-changeset.ts` builds the post-write entry from `relPath` (the fs-facing string). It takes
  `pathBytes` from the changeset entry when present. The file itself is written under the string
  name. That residual is listed in §Out of scope.

### D9. Path validation

`validateIndexPath` keeps running on the decoded string:

- BOM now stays in the string. `verifyPath` strips HFS-ignorable code points (U+FEFF among them,
  `verify-path.ts:32`) before the `.git` alias test, so `\uFEFF.git/x` is still refused. Today it
  is refused because the BOM is stripped and the result is `.git`. Same verdict, different reason
  (R10). One unit test pins it.
- Non-UTF-8: ASCII bytes keep their positions (§D2), so `.`/`..`/empty segments, leading `/`,
  NUL and the `.git`/`git~1` ASCII aliases give the same verdict on either view. The HFS alias
  check decodes non-ASCII. git's `next_hfs_char` on invalid UTF-8 is not pinned here (§Out of scope).

### D10. Public API

`IndexEntry` (domain) is public as a **type**: `src/public-types.ts:75` re-exports the
`domain/git-index` barrel with `export type *`, and `readIndex` returns `GitIndex`. It appears in
`reports/api.json` (e.g. `ctimeNanoseconds`, line 20217). Adding `pathBytes?: Uint8Array` is an
**additive public type change**. Regenerate `reports/api.json` with `npm run docs:json` in the slice
that adds the field: it is a prepush gate (`check:doc-typedoc`), not a validate gate
(`.claude/workflow/surface-gates.md`). The `feat`/`fix` commit drives the release-please CHANGELOG.
`path` semantics change for BOM paths (the string now carries U+FEFF): consumers that compared
`entry.path` to a BOM-stripped string get the git-faithful value instead. That is a behaviour fix,
not a break. `compareEntryPath` / `serializeIndex` / `parseIndex` are barrel values, which
`export type *` drops, so they are not public; `IndexChange`, `invalidateCacheTree` and the new key
module are internal. The snapshot `IndexEntryRow` (public, read-only) keeps `path` only (§Out of scope).

### D11. Route checklist: every writer and reader of `IndexEntry.path`

| Route | Writes / reads | Bypass or re-admission risk | Closed by |
|---|---|---|---|
| `parseIndex` | writes | BOM strip, U+FFFD | §D3 |
| `serializeIndex` | reads | encode of a lossy string | §D4 |
| sorts feeding the writer (`build-index-from-tree:132`, `materialize-tree:155/178`, `apply-merge-to-worktree:293`, `diff-index-entries`, `unstage-changes-unless-new`) | read | string order ≠ byte order for raw paths | §D4 |
| keyed maps in index writers (§D5.2) | read | collapse (G3) | §D5 |
| `mv` re-path, `apply-sparse-checkout.toSkipWorktree` | write | stale or dropped bytes | §D5.3 |
| `diffIndexEntries` → `carryTree` → `invalidateCacheTree` | read | stale `TREE` node (G6) | §D6 |
| `commit.buildTreeFromIndex`, `synthesizeTreeFromIndex` | read | U+FFFD tree names (G5) | §D7 |
| `buildIndexFromTree`, `materializeTree`, `apply-changeset` | write | U+FFFD from walk path (G4) | §D8 |
| `indexEntryFromStat` (add, refresh) | write | none: the path comes from the fs port (a UTF-8 string by construction); a lossy entry is never re-statted because a string cannot address it | — |
| merge engine (`mergedBlobEntries`/`stage0Entry`, `conflictsToIndexEntries`, `merge.ts:1902`) | write | U+FFFD from merge outcome paths | **not closed**: §Out of scope; an untouched lossy entry still survives through the carried index |
| snapshot rows, `grep`, `blame`, `rev-parse :path`, status output | read | display only | — (U+FFFD view, ADR-249) |
| hash width | — | none: `pathBytes` is independent of `digestLength`; the parser's offset arithmetic is unchanged | — |

### D12. Parts

Each part is one TDD unit with its own interop twin.

**Part 1 — BOM-preserving parse (G1).**
Context: `src/domain/git-index/index-parser.ts` `parseIndex` line 117 (`decode` → `decodePreservingBom`,
import from `../objects/encoding.js`). Nothing else changes for BOM: the writer's `encode`, the
comparator (U+FEFF ranks `0xF6FF` > `z`, bytes `EF > 7A`), tree walk names and `keyOfComponent`
(component → `EF BB BF …`) are already consistent. Tests: `test/unit/domain/git-index/index-parser.test.ts`
(new "Given a path starting with U+FEFF"), `path-validator.test.ts` (`\uFEFF.git/x` still refused,
reason `dotgit-hfs-alias`), interop twin rows A1-A4 + D1 + D2 in a new
`test/integration/index-path-bytes-interop.test.ts`.

**Part 2 — raw bytes on the entry, writer, order, keys, cache-tree (G2, G3, G6).**
Context: `IndexEntry` (`index-entry.ts:20-34`) + `withPath`; `index-parser.ts` lines 115-139 (reuse
new `decodesLosslessly` in `src/domain/objects/encoding.ts` next to `decodePreservingBom`);
`index-writer.ts` `serializeIndex` line 115, `pathComparatorFor` line 93,
`compareEntryPath` line 57, `compareBytes` from `../objects/encoding.js`; new
`src/domain/git-index/index-path-key.ts` (`IndexPathKey`, `indexPathKey`, `latin1`, the
`bytesOf` helper; `cache-tree.ts`'s `keyOfBytes` moves here or is imported so one definition
exists); `diff-index-entries.ts` (`IndexChange`, `collectChangedPaths.mark`, `comparatorForBoth`);
`carry-extensions.ts` `withRestagedPaths`; `cache-tree.ts` `invalidateCacheTree`, `Pending`,
`groupByComponent`; the §D5.2 sweep (index-lock, smudge, add, rm, mv, apply-sparse-checkout,
unstage-changes-unless-new, stash, clean-work-tree, submodule, status, find-would-overwrite).
Fixtures: `arbitraries.ts` gains `arbRawPathBytes()` (byte arrays with at least one invalid
sequence, ASCII `/`-separated, no `.`/`..`/empty components) and `arbIndexEntryWithRawPath()`.
Tests: `index-parser.test.ts`, `index-writer.test.ts`, `diff-index-entries.test.ts`,
`cache-tree.test.ts`, `carry-extensions.test.ts` + property siblings; interop rows B1-B3, C1-C3, F1-F2.

**Part 3 — tree emission and tree → index (G4, G5).**
Context: `commit.ts` `buildTreeFromIndex` / `insertEntry` / `writeSubtree` (393-440);
`synthesize-tree-from-index.ts` `PendingEntry`, `buildTrieFrames` (163), lines 187 and 206;
`walk-tree.ts` `WalkConfig`, `nextFrameEntry`, `buildRootPrefix`, `buildChildPrefix`,
`buildYieldedEntry`, `WalkTreeOptions` / `WalkTreeEntry` in `primitives/types.ts:198-235`;
`build-index-from-tree.ts` (`TargetLeaf`, `collectLeaves`, `zeroStatEntry`, `donorByPath`);
`materialize-tree.ts` (`TargetEntry`, `collectTargetEntries`, the four keyed helpers);
`compute-changeset.ts` (`ChangesetEntry` gains `pathBytes?` from the target walk, `projectIndex`);
`apply-changeset.ts` entry builder (~288); `treeEntry(mode, Uint8Array, id)` in
`src/domain/objects/tree.ts`. Tests: `walk-tree.test.ts` (lossy-only channel), commit and
synthesize unit tests; interop rows A4, B4, E1 (`git ls-tree -r -z` byte equality).

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| DC1 | Representation of a non-UTF-8 entry path | **A** optional `IndexEntry.pathBytes`, present only when lossy (cache-tree / tree precedent), byte keys at every keyed site (§D5). **B** lossless "escaped" string: decode each invalid byte `b` to the lone surrogate `U+DC00+b`, so `path` is injective. Every Map/Set/`===` is then correct for free. Costs: a custom codec at every encode site (writer, `treeEntry`, `keyOfComponent`, `comparePaths`), the comparator needs a byte fallback when an escape is involved, and `TreeEntry.name` must switch decoders too or index↔tree string matches break. Lone surrogates enter the public `FilePath`. **C** refuse: a typed error when an index carrying a non-round-tripping path would be written (ADR divergence: git accepts them). | **A** | Matches the house pattern three times over (`TreeEntry.nameBytes`, `CacheTreeEntry.nameBytes`, `WalkTreeEntry.pathBytes`). The public `path` stays well-formed UTF-16. B touches fewer files but changes the meaning of every tree name and `FilePath` in the API. C trades silent loss for a refusal and diverges from git |
| DC2 | BOM-prefixed paths | **A** `decodePreservingBom`: `path` carries U+FEFF and needs no bytes. **B** treat BOM as lossy like the cache-tree does (`decode` + `pathBytes`) | **A** | A BOM path is valid UTF-8 and round-trips. With A, status, pathspec, the working tree and tree-walk matching all work (D1 and D2 are fixed). With B every one of those would still key on the stripped string |
| DC3 | Scope of this run | **A** the integrity set: Parts 1-3 (parse, write, order, keys in index writers, cache-tree, index → tree, tree → index). The merge engine, the fs port and pathspec addressing of lossy names stay out. **B** Parts 1-2 only; tree routes (G4, G5) go to a new backlog entry. **C** A plus the merge engine (`three-way-tree` works on strings throughout) | **A** | G4 re-admits the loss on the next `reset`/checkout, and G5 rewrites history on the next `commit`. Without them the invariant holds only until the next tree round trip. C roughly doubles the surface (the merge engine is string-pathed end to end) for a case that already survives as carried entries |
| DC4 | Where tree → index gets the raw bytes | **A** new lossy-only `walkTree` channel: bytes yielded only for lossy entries, one ASCII scan per name. **B** turn on the existing `pathBytes: true` in `collectLeaves` / `collectTargetEntries` (one fresh array per entry, every entry). **C** a second walk to fetch bytes, only when the first walk saw a U+FFFD | **A** | `reset` and checkout walk whole trees on the hot path. B allocates on every entry for a case that is almost never present. C walks twice and still needs a lossy detector |
| DC5 | Collision keying | **A** branded `IndexPathKey` (`path` for UTF-8, `'\0' + latin1(bytes)` for lossy) at every site in §D5.2; the compiler finds the sites. **B** refuse an index whose entries decode to duplicate strings with different bytes (one check in the parse). Then string keys stay injective and the §D5.2 sweep shrinks to re-path/constructor sites. ADR divergence: git accepts `caf\xe9` next to `caf\xe8` | **A** | git-faithful (the C rows are a legal git index). Zero cost for UTF-8 keys. B makes a valid Latin-1 repo unusable for tsgit writes |

## Test strategy

- **Interop** (`test/integration/index-path-bytes-interop.test.ts`, `@proves surface: index,
  bucket: cross-tool-interop`): one `describe` per matrix row group. Each test uses real git to
  build the state (`mkdir` + `add` for BOM, `update-index -z --index-info` for non-UTF-8, so it runs
  on APFS and NTFS). tsgit then acts (`add`, `rm --cached`, `commit`, `reset --mixed`), and the
  test asserts `git ls-files -s -z` / `git ls-tree -r -z HEAD` **bytes** (hex) equal the pinned git
  bytes. It also asserts `git fsck` exit 0, and for F the `git write-tree` tree equals the tree
  of the entries. D1: tsgit `status` on a clean BOM repo returns `clean: true`.
- **Unit, example** (`index-parser.test.ts`): BOM path kept with no `pathBytes` key. Each invalid
  class (`ff`, lone `80`, truncated `c3`, overlong `c0 af`, surrogate `ed a0 80`, `f5`) gets
  `pathBytes` equal to the raw bytes and `path` equal to the U+FFFD view. Mutating the source buffer
  after parse does not change `pathBytes` (the `slice` copy). Non-ASCII valid UTF-8 has no key.
  `index-writer.test.ts`: raw bytes emitted verbatim, length field raw, order `b/\xc3 < z < \xff.txt`,
  and `compareEntryBytes` across mixed pairs (raw vs UTF-8 with the same lead byte, raw vs astral).
  `index-path-key.test.ts`: injectivity across the C1 set. `cache-tree.test.ts`: lossy changed
  path invalidates the `nameBytes` child; a BOM changed path invalidates the BOM child.
  `diff-index-entries.test.ts`: `\xff` vs `\xef\xbf\xbd` are two changes, not one.
- **Properties** (parser/serializer and comparator are in scope, per
  `.claude/workflow/property-testing.md`):
  - round-trip: `serializeIndex(parseIndex(serializeIndex(index)))` is byte-equal for
    `arbGitIndexV2/V3` extended with raw-path entries;
  - order: `compareEntryBytes` agrees in sign with `compareBytes(bytesOf(a), bytesOf(b))` on
    mixed arbitraries;
  - key: `indexPathKey(a) === indexPathKey(b)` ⇔ `bytesEqual(bytesOf(a), bytesOf(b))`;
  - invalidation: for raw changed paths, no cache-tree node on a changed path stays valid.
- **Mutation**: the absent-key branches (`pathBytes === undefined ? … : …`) and the comparator tier
  selection each need an isolated test per branch (CLAUDE.md guard-clause rule).
- **Bench**: `test/bench/status.bench.ts`, `checkout.bench.ts`, `commit.bench.ts` before/after
  (`bench:ab`). Expected flat (R9). The only added per-entry work is one U+FFFD scan of the decoded
  path in parse and in the lossy-only walk check.

## Out of scope

- **Working-tree I/O of non-UTF-8 names**: the `FileSystem` port is string-pathed, so a checkout writes
  the U+FFFD name and status cannot stat a raw-byte file. It needs a byte-path port, which is its own
  design. Today's behaviour is unchanged.
- **Pathspec addressing of non-UTF-8 entries** (`rm`, `add`, `checkout -- <path>` with a raw-byte
  name): a JS string cannot express the bytes. Directory and glob pathspecs still match through the
  U+FFFD view.
- **Merge engine** (`three-way-tree`, `mergedBlobEntries`, `conflictsToIndexEntries`, rename detection,
  `merge.ts:1902`): string-pathed end to end. A lossy path a merge *touches* still comes out as U+FFFD
  (DC3-C). Untouched lossy entries survive through §D5.
- **Snapshot rows / display surfaces** (`IndexEntryRow`, `grep`, `blame`, `rev-parse :path`, archive,
  diff/patch headers): they read the decoded view, as `TreeEntry.name` does today (ADR-249).
- **Cache-tree decode switch to `decodePreservingBom`**: not needed. Matching already keys on
  `nameBytes`, and a change would churn #317's tests for no observable gain.
- **HFS alias check on invalid UTF-8**: git's `next_hfs_char` on malformed sequences is not pinned.
  To prove it: stage `.g\xffit/x` and `.\xe2\x80\x8cgit` via `update-index` under
  `core.protectHFS=true` and compare the refusal with `validateIndexPath`.
- **tsgit refusing unsafe paths at parse** (git verifies at write, not read): an existing divergence,
  untouched.
