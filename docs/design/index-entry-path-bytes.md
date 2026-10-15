# Design — byte-exact index entry paths

> Brief: index entry paths are decoded with the BOM-stripping `decode`
> (`src/domain/git-index/index-parser.ts:117`), so any tsgit index write renames an entry whose
> path starts with U+FEFF, and rewrites a non-UTF-8 entry name as U+FFFD. Decode entry paths
> losslessly, on the model of the cache-tree's `nameBytes` (#317), and close every route that can
> drop or re-admit the lossy name: parse, write, order, match, index → tree, tree → index.
> Backlog 32.21 (data integrity).
> Status: draft → self-reviewed ×3 → Parts 1-15 implemented → **revision 2** (2026-10-15): folds
> ADR-973 (lossy entries never touched on disk), ADR-974 (no write through a leading symlink) and
> the cycle-1 review (code / security / tests / perf). §D1-§D12 keep the original design; claims the
> review falsified are marked **[falsified, see §Dn]** in place. New design: §D13-§D19, Parts 16-24.

<!-- cspell:ignore xbfz injectivity xffit cgit bytewise FEFF FFFD DFFF EFBBBF EFBFBD efbbbf efbfbd ffff latin1 Latin1 roundtrip unpaired EILSEQ surrogateescape FFFE noncharacter noncharacters xfe xbe xaf xed xc0 xc3 xf4 lstat lstats unlinks pcheckout dirname -->
<!-- cspell:ignore protectHFS protectNTFS ignorecase APFS mkdir symlinked repath repathed sut xbfit multibyte unloadable -->


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
| ADR-968 … ADR-972 | Ratified DC1-DC5 below (raw `pathBytes` when lossy, BOM kept, tree round trip in scope, lossy-only walk channel, `IndexPathKey`). |
| ADR-973 (revision 2) | A lossy entry has no working-tree file tsgit can name: never written, unlinked, stat'd or read through its decoded view. It reads as absent for every reader (§D13). |
| ADR-974 (revision 2) | A working-tree write never follows a symlink in its leading path, whatever order the pool runs writes in (§D18). |

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
| `rm.ts` `byPath` (87-115) | `byPath.set(entry.path)`, `byPath.delete(path)` | key by `indexPathKey(entry)`; delete by the matched entry's key, not the pathspec string. **[falsified, see §D15]**: the *match* itself still runs on `entry.path`, so a literal `�.txt` selects the lossy twin; the HEAD lookup of the safety valve (`rm.ts:204` `head.get(entry.path)`) collapses the twins too |
| `mv.ts` `readIndexMap`, `classifySource`, `applyToIndex` (129-306) | `Map<FilePath, …>`; spread `{ ...entry, path: newPath }` | keys; re-path through `withPath` (§D5.3). **[falsified, see §D16]**: `classifySource` matches directory members on the view |
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
  **[falsified, see §D16]**: the cut is exact only if membership was decided on bytes. Membership
  ran on the view, so source `�` selected the lossy `\xff/x` and the cut at 3 bytes landed past
  its `/`: the security repro re-pathed an entry to `.git/p`, which no check re-validated.
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
  name. That residual is listed in §Out of scope. **[superseded by ADR-973, see §D13-§D14]**: the
  view-named write corrupts the literal twin (`reset --hard` wrote `\xff.txt`'s blob into
  `�.txt`, pinned T2); a lossy entry is now never written.

### D9. Path validation

`validateIndexPath` keeps running on the decoded string:

- BOM now stays in the string. `verifyPath` strips HFS-ignorable code points (U+FEFF among them,
  `verify-path.ts:32`) before the `.git` alias test, so `\uFEFF.git/x` is still refused. Today it
  is refused because the BOM is stripped and the result is `.git`. Same verdict, different reason
  (R10). One unit test pins it.
- Non-UTF-8: ASCII bytes keep their positions (§D2), so `.`/`..`/empty segments, leading `/`,
  NUL and the `.git`/`git~1` ASCII aliases give the same verdict on either view. The HFS alias
  check decodes non-ASCII. git's `next_hfs_char` on invalid UTF-8 is not pinned here (§Out of scope).
  **[falsified, see §D17]**: git's HFS check ends a name at the first sequence its own UTF-8
  picker rejects, so `.git\xff/x` is a `.git` alias under `core.protectHFS`. The view cannot tell
  that `\xff` from a literal U+FFFD, and the picker also rejects U+FFFE/U+FFFF, which the WHATWG
  decoder accepts.

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
| `indexEntryFromStat` (add, refresh) | write | none: the path comes from the fs port (a UTF-8 string by construction); a lossy entry is never re-statted because a string cannot address it. **[falsified]**: `compareAndRefresh` stats `entry.path`, the view (status reported `\xff.txt` as `modified` against `�.txt`'s file, pin T1) | §D14 Part 16 |
| merge engine (`mergedBlobEntries`/`stage0Entry`, `conflictsToIndexEntries`, `merge.ts:1902`) | write | U+FFFD from merge outcome paths | **not closed**: §Out of scope; an untouched lossy entry still survives through the carried index. **[falsified, pin T9]**: a three-way merge rebuilds the whole tree from `flattenTree` outcomes, so an *untouched* `\xff.txt` lands in the merge commit as `efbfbd2e747874` | §D19, DC8 |
| snapshot rows, `grep`, `blame`, `rev-parse :path`, status output | read | display only | — (U+FFFD view, ADR-249) |
| hash width | — | none: `pathBytes` is independent of `digestLength`; the parser's offset arithmetic is unchanged | — |

Revision 2 rows (each pinned in §D13; "absent" = the ADR-973 rule of §D14):

| Route | Touches disk for an entry? | Before revision 2 | Closed by |
|---|---|---|---|
| `compareAndRefresh` (`compare-working-tree-entry.ts:255`) → status, diff, `clean-work-tree`, `find-would-overwrite`, `smudge-racily-clean`, rm safety valve, stash dirty checks | lstat + read | stats and hashes the view file | absent → `deleted` without an fs call (Part 16) |
| `apply-sparse-checkout.partition` (`ctx.fs.exists`, `isDirty`) | exists + read | probes the view | absent (Part 16) |
| `add --renormalize` | lstat + read | view | missing-file branch (Part 16) |
| `add -A` / `add -u` / `add <glob>` | walk join | `-A` already removes (walk never yields a lossy key); a glob does **not** stage the deletion (pin T4 vs git S5) | glob reach through the matching view (Part 18) |
| stash push worktree tree | lstat + read | view | absent → recorded as deleted (Part 16) |
| `apply-changeset` write (`applyWriteEntry`) | write | writes blob under the view, last write wins | skipped; zero-stat entry with `pathBytes` (Part 17) |
| `apply-changeset` delete (`applyDeleteEntry`) | unlink | unlinks the view | skipped (Part 17) |
| `rm` (non-cached) unlink | unlink | unlinks the view | skipped (Part 17) |
| `rm` pathspec match + HEAD map | — | literal selects lossy twin; `head.get(entry.path)` collapses twins | matching view + key-built HEAD map (Part 18) |
| `checkout -- <paths>` universe, `materializeTree` `filterByPaths` / `preserveOutOfScope` | — | view `Set<FilePath>` | key sets (Part 18) |
| `apply-sparse-checkout` `addEntry` / `deleteEntry` / `noopEntry` | — | drop `pathBytes` (lossy blob written into the literal twin) | spread path fields (Part 20) |
| `mv` member match, cut, disk check, rename | rename | view match, unchecked cut, no member lstat | byte-prefix match, `validateIndexPath` on re-pathed entries, lossy member = bad source (Part 19) |
| `verifyPath` HFS alias | — | view | git's picker over bytes (Part 21) |
| write wave leading directories | mkdir -p | concurrent `mkdir -p` follows a symlink created by another group | §D18 (Part 22) |
| merge engine tree synthesis + worktree writer | write | view (history rewrite, pin T9) | DC8 (Part 23) |

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

Parts 1-3 were planned as Parts 1-15 (`docs/plan/index-entry-path-bytes.md`) and are landed.
Revision 2 adds Parts 16-24. Each new part is one TDD unit with its own interop rows from §D13.
**Security diff review by the user before commit:** Part 19 (mv cut, HIGH) and Part 22 (leading
symlink race, CRITICAL). Order: 16 → 17 → 18 → 19 → 20 → 21 → 22 → 23 → 24 (17 and 22 both edit
`apply-changeset.ts`; 18 changes `materializeTree`'s `paths` type, which 20 and 23 consume).

**Part 16 — Lossy entries read as absent (ADR-973, readers).**
Context: one predicate `isLossy(entry: IndexPath): boolean` (`entry.pathBytes !== undefined`) in
`src/domain/git-index/index-path-key.ts`. Chokepoint `src/application/primitives/compare-working-tree-entry.ts`
`compareAndRefresh` (line 255, `lstat` at 261): for a lossy entry, return exactly what it returns when
`lstat` rejects, with no fs call. That one change serves `compareWorkingTreeDelta` (270),
`compareWorkingTreeEntry` (299) and their callers: `status.ts` (`compareAndRefresh`), `rm.ts`
safety valve, `internal/clean-work-tree.ts:40`, `find-would-overwrite.ts`,
`internal/smudge-racily-clean.ts` (`compareWorkingTreeDelta`), `stash.ts` dirty checks.
Other readers: `internal/apply-sparse-checkout.ts` `partition` (`ctx.fs.exists` + `isDirty`,
lines ~70-90) → `present: false`; `add.ts` renormalize branch → its missing-file branch;
`stash.ts` worktree-tree builder → the entry is recorded deleted. Tests: one unit per site, "Given a
lossy entry and a file at its view, When <route>, Then the verdict is absent and the fs double saw no
call naming the view". Interop: S1 (status `.D`), S2/S3 (`add --all` removes lossy, already green,
pin it), S4 (refusal, index bytes unchanged), S10 (stash worktree tree names), S16 (index stat untouched).

**Part 17 — Lossy entries are never written or unlinked (ADR-973, writers).**
Context: `src/application/primitives/apply-changeset.ts` `applyWriteEntry` (~307): a lossy changeset
entry writes nothing and returns a zero-stat entry carrying `pathBytes` (reuse `zeroStatEntry`
from `build-index-from-tree.ts:78`; move it to `primitives/internal/` if both import it);
`applyDeleteEntry` (~295): return before the scan; `assertNoDirtyOverwrite` → `checkDirty`: a lossy
entry is never dirty nor an untracked overwrite (it is absent). `rm.ts` unlink loop (~108): iterate
`removedEntries` and skip lossy ones. Result reporting per DC6. Tests: `apply-changeset.test.ts`
("Given L and U, When applied, Then U's file holds U's blob, no write names L's view, L's entry has
zero stat and its bytes"), `rm.test.ts`. Interop: S1b/T2 (after tsgit `reset --hard`: worktree `z`,
`�.txt` = U's bytes, no `d/`; `git status` shows ` D` for both lossy paths; `git ls-files -s -z`
bytes unchanged), S8b, S12b, S13 (switch adds a lossy path: index carries `6efe`).

**Part 18 — Pathspec matching view; key-scoped restore and rm.**
Context: new `src/domain/pathspec/matching-path.ts` `matchingPathOf(entry: IndexPath): string` and
`matchesIndexPath(spec: Pathspec, entry: IndexPath): boolean` (§D15). Sites: `rm.ts:95`
(`matchesPathspec(matcher, entry.path)`), and the safety valve's HEAD map `rm.ts:204-213`
(`isStaged`, `headTreeEntries` → `Map<IndexPathKey, …>` built with `walkTreeWithLossyBytes`, since
the string-keyed `FlatTree` collapses L and U: pin T7); `checkout.ts:319-336` `pathRestore`
(`enumerateSourcePaths` returns `IndexPath[]`; `pathSet: Set<IndexPathKey>`); `materialize-tree.ts`
`MaterializeTreeOpts.paths` (line 61) becomes `ReadonlySet<IndexPathKey>`, `filterByPaths` (114) and
`preserveOutOfScope` (136) test `indexPathKey(e)`; `add.ts:534` (tracked-entry match) and `:616`;
`apply-sparse-checkout.ts:60` `isIncluded` runs the `SparseMatcher` on `matchingPathOf(entry)`.
Tests: `matching-path.test.ts` + `matching-path.properties.test.ts` (UTF-8 entry → `path` itself;
injective over bytes; no literal compiled from a well-formed string matches a lossy entry; `*`
matches every lossy entry under its directory). If a pathspec carrying a lone surrogate matches a
lossy entry in that test, add a well-formedness refusal to `resolvePathspec`. Interop: S5, S5b, S6,
S7, S7b, S8b, S12, S12b.

**Part 19 — mv: byte-prefix members, re-validation, absent lossy members.** *(user security review)*
Context: `src/application/commands/mv.ts` `classifySource` (231-241): `exact` stays
`byPath.get(keyOfPath(source))`; members are entries where `pathBytesOf(entry)` starts with
`encode(source)` followed by `0x2f` (new `hasBytePrefix(bytes, prefix)` next to `splitAtSlash` in
`index-path-key.ts`). `movedPath` (322) then cuts at a real component boundary. `applyToIndex` (307)
runs `validateIndexPath(moved.path, NO_PARSER_OFFSET, moved.mode, moved.pathBytes)` on every
re-pathed entry before `byPath.set`. `validateMove` (203): a directory source with a lossy member
yields `bad-source` naming that member (`refusal`, line 334); under `-k` that member is skipped and
stays at its old path while the rest moves (pins M1, S9c). Tests: unit for the `.git/p` security
repro (index stays valid), U+FFFD source selects only literal members (M2), lossy-member refusal and
`-k`; interop M1, M2, S9, S9c.

**Part 20 — sparse-checkout changeset builders carry `pathBytes`.**
Context: `internal/apply-sparse-checkout.ts` `deleteEntry` (97), `addEntry` (107), `noopEntry` (117):
copy `path` and, when defined, `pathBytes` (one `changesetPathOf(entry)` helper). Delete the vacuous
spy test `test/unit/application/commands/internal/apply-sparse-checkout.test.ts:155`; replace it with
an end-to-end unit test without the `applyChangeset` mock (L+U, narrow then widen: U keeps U's blob,
L keeps its bytes, nothing written for L). Interop: S15 analogue (index bytes unchanged).

**Part 21 — HFS alias verdict on raw bytes.**
Context: `src/domain/path/verify-path.ts` `verifyPath(path, mode)` gains `pathBytes?: Uint8Array`
(DC9 decides the call sites); `matchAliasPart` (73) and `matchGitmodulesAliasPart` (~160) take the HFS
candidate from a new pure `hfsCandidate(component, componentBytes?)` (§D17).
`src/domain/git-index/path-validator.ts` `validateIndexPath` (line ~101) forwards bytes; callers
holding an entry pass `entry.pathBytes`: `index-parser.ts:128`, `synthesize-tree-from-index.ts:90`,
`build-index-from-tree.ts:123`, `apply-changeset.ts:233`, mv (Part 19). Tests: one example per H row;
property sibling (`verify-path.properties.test.ts`, extend or create): for component bytes
`.git` + `X`, the verdict is an alias iff git's picker rejects `X`'s first sequence, or `X` is only
HFS-ignorable code points followed by end or a rejected sequence. Interop: H rows with
`core.protectHFS=true` (tsgit refuses where git prints `Ignoring path`).

**Part 22 — Leading-symlink-safe write wave (ADR-974).** *(user security review)*
Context: §D18. `apply-changeset.ts` `applyWriteWave` (~470), `groupByCaseFoldedPath` (427),
`applyWriteGroup`; `internal/symlinked-leading-path.ts` `PrefixShape` (gains `directory` vs `other`),
new `ensureLeadingDirectories(path)` on `LeadingPathScanner`; `internal/write-working-tree-file.ts`
`writeWorkingTreeEntry` (symlink arm invalidates the memo, as today). Test double: new
`test/unit/application/primitives/support/interleaving-fs.ts` (§D18.3). Tests:
`apply-changeset.test.ts` both name orders, no write or mkdir ever sees a symlinked prefix;
`symlinked-leading-path.test.ts` for `ensureLeadingDirectories`; interop R1/R2 on a case-insensitive
filesystem (gated on `nodeFilenameProbe`, `src/adapters/node/node-filename-probe.ts`) and R4 everywhere.

**Part 23 — Three-way merge over lossy names (DC8).**
Context (option B): the flatten walk (`src/application/primitives/internal/flatten-raw.ts`,
`flattenRawTree` line 105) reports whether any name is lossy (`nameBytes` that do not round-trip).
One helper asserts "no lossy side" on the flattened base/ours/theirs wherever a side is flattened
for the engine: `apply-merge-to-worktree.ts` `applyMergeToWorktree` (445) and `mergeTreesToTree`
(511), plus each of `merge.ts`, `stash.ts`, `internal/replay-sequence.ts`,
`internal/rebase-merges-steps.ts` that calls the domain `mergeTrees` with its own flatten (all four
call `mergeTrees`, `applyMergeToWorktree` or `mergeTreesToTree`; check which flatten each uses). The
refusal is raised before any ref, index or worktree write.
Interop: T9 (tsgit refuses; HEAD, index and worktree unchanged).

**Part 24 — Review test gaps and LOW findings.**
Context and items: (a) `commit.ts:413` lossy directory with two children (example test + property:
no duplicate tree entry; kills the surviving `typeof name === 'string'` → `true` mutant);
(b) `build-index-from-tree.ts:99` zero-stat rebuild of a lossy leaf with an empty index;
(c) public `walkTree` (`walk-tree.ts:285`) never yields `pathBytes` (assert `Object.keys` on a `\xff`
name); (d) `rm.ts:109` removing a lossy entry by key (`rm --cached -r d` over `d/y` + `d/\xff`);
(e) `test/integration/index-path-bytes-interop.test.ts:190` and `:203`: the result variable is not
`sut`; rename so `sut` is the system under test; (f) `walk-tree.ts` `walkResolved(…, lossyOnly:
boolean)` (301) → a `ByteChannel = 'none' | 'lossy' | 'all'` field on the walk config;
(g) `commit.ts:412` `componentKey` fabricates an `IndexPath` with `path: ''`: export
`keyOfLossyBytes(bytes)` from `index-path-key.ts` and call it; (h) `carry-extensions.ts:88`
`uniqueByKey`: drop the `!byKey.has(key)` guard (an equal key means equal bytes, and `Map.set` keeps
the first insertion position), per the equivalent-mutant policy; (i) cache-tree cost per DC10.

### D13. Revision 2 pinned behaviour

Harness as in §D1 (git 2.55.0, scrubbed `GIT_*`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`,
`mktemp -d`), tsgit = esbuild bundle of `src/` at `be0d7832`. **Every git row is macOS-specific**
(APFS, case-insensitive, `core.ignorecase=true`) unless marked. Linux rows are **source-read**
(git 2.55 `entry.c`, `symlinks.c`, `parallel-checkout.c`, `utf8.c`, `builtin/mv.c`).

#### D13.1 Lossy entries on disk

Fixture: `z` and the literal `\xef\xbf\xbd.txt` (U, content `u`) are real files; the lossy
`\xff.txt` (L) and `d/\xff` are staged with `update-index -z --index-info` and committed.

| # | Command | git 2.55 macOS | tsgit `be0d7832` |
|---|---|---|---|
| S0 | `printf x > $'\xff.txt'` | `Illegal byte sequence` (EILSEQ): APFS refuses the name. `lstat` of it gives ENOENT (S4 message) | — |
| S1 | `status --porcelain=v2` | `1 .D` for `d/\xff` and `\xff.txt`; `diff-files`: `D` both | T1: `d/\xff` deleted; `\xff.txt` **`unstaged: modified`**, compared with U's file |
| S1b | `reset --hard` | `error: unable to create file d/�: Illegal byte sequence` (and `�.txt`), `fatal: Could not reset index file to revision 'HEAD'.`, exit 128; `d/` left as an empty directory | T2: exit 0; writes L's blob to `d/�` **and to `�.txt`** (U overwritten) |
| S1c | `checkout -f HEAD`; `checkout-index -a -f`; `read-tree -u --reset HEAD` | same two errors; exit 1, 1, 128 | — |
| S13 | `switch side` (side adds `n\xfe`) | `error: unable to create file n�`, `Switched to branch 'side'`, **exit 0**; index holds `6efe` | — |
| S14 | fast-forward `merge` adding a lossy path | error line, exit 1 | — |
| S15 | `sparse-checkout set --no-cone z` then `disable` | `disable`: errors, `fatal: error while refreshing working directory`, exit 128 | — |
| S16 | `update-index --refresh` | `needs update` for both, exit 1 | — |
| S2/S3 | `add -A`; `add -u` | both lossy entries removed (deletion staged), exit 0 | T3: `add --all` removes both (matches) |
| S4 | `add --renormalize .` | `fatal: unable to stat 'd/�': No such file or directory`, exit 128, index unchanged | `PATHSPEC_NO_MATCH` `d/�`, index unchanged |
| S5 | U modified; `add '*.txt'` | U restaged, **L removed** | T4: L kept |
| S5b | U modified; `add $'\xef\xbf\xbd.txt'` | U restaged, L kept | — |
| S6 | `rm --cached $'\xef\xbf\xbd.txt'` | only U removed | both removed (code review, VERIFIED) |
| S7 | `rm --cached '*.txt'` | both removed | T6: both removed (matches) |
| S7b | `rm --cached -r d` | `d/\xff` removed | — |
| S8 | `rm $'\xff.txt'` (raw argv) | L removed from the index, exit 0, nothing unlinked | not expressible (string API) |
| S8b | `rm '*.txt'` | both entries removed, U unlinked, exit 0 | T7: `RM_STAGED_CHANGES` (HEAD map keyed by view, `rm.ts:205`), nothing removed |
| S8c | `rm -r d` | `d/\xff` removed, exit 0 | — |
| S9 | `mv $'\xff.txt' y` | `fatal: bad source, source=\xff.txt, destination=y`, exit 128 | — |
| S9c | `mkdir d; mv d e` | `fatal: bad source, source=d/\xff, destination=e/\xff`, exit 128 | — |
| M1 | `d/y` on disk + `d/\xff`; `mv d e` / `mv -k d e` | `bad source, source=d/\xff`, exit 128 / exit 0: index `d/\xff`, `e/y`; disk `e/y` | — |
| M2 | `\xef\xbf\xbd/x` on disk + `\xff/x`; `mv $'\xef\xbf\xbd' dst` | exit 0: index `dst/x`, `\xff/x` | moves both; the security repro cuts a lossy path to `.git/p` (security review, VERIFIED) |
| S10 | `z` modified; `stash push` | stash saved; its worktree tree lists `z`, `\xef\xbf\xbd.txt` only (lossy recorded deleted); the internal reset then fails as S1b, exit 1 | T8: saved; its reset writes L's blob to `d/�` and `�.txt` |
| S17 | stage a change to L; `stash push`; `stash apply` | modify/delete conflict on `\xff.txt` (the stash's worktree tree deleted it) | — |
| S11 | `clean -n -d` | nothing | — |
| S12 | U modified; `checkout HEAD -- $'\xef\xbf\xbd.txt'` | exit 0, L kept | deletes staged L or refuses `CHECKOUT_OVERWRITE_DIRTY` (code review, VERIFIED) |
| S12b | `checkout HEAD -- '*.txt'`; `restore --source=HEAD -- '*.txt'`; `checkout -- '*.txt'` | `error: unable to create file �.txt: Illegal byte sequence`, exit 255; U restored | `checkout HEAD -- '*.txt'`: exit 0, writes L's blob to `�.txt` |

Linux (source-read): `write_entry` opens the raw bytes; ext4/xfs accept every byte but `/` and NUL, so
git creates `\xff.txt`. Every row then behaves as for an ordinary name: status clean, `add -A` keeps
the entries, `reset --hard` exits 0.

#### D13.2 Leading symlink (ADR-974)

Fixture: tree `A` → `<tmp>/outside` (120000) and `a/payload`; empty worktree.

| # | Command | git 2.55 macOS (`core.ignorecase=true`) |
|---|---|---|
| R1 | `reset --hard` | exit 0; worktree `a/` (real directory) + `a/payload`; `<tmp>/outside` empty; `status`: ` D A` |
| R2 | `-c checkout.workers=4 -c checkout.thresholdForParallelism=0 reset --hard` | identical to R1 |
| R3 | `clone` | identical to R1 |
| R4 | worktree symlink `a` → `<tmp>/outside`, tree `a/payload` only; `checkout -f HEAD` | symlink replaced by a directory holding `payload`; outside empty (Linux: same `create_directories` path, source-read) |

Linux (source-read): `A` and `a` are distinct names; the symlink `A` and directory `a/payload` coexist.
tsgit: the A/a fixture writes `payload` into the symlink target in 1 run of 10 on `main` and 1-2 of 10
on this branch (security review, VERIFIED, pre-existing).

git's mechanism (source-read):

- `entry.c:19-58` `create_directories`: walks the leading components one at a time;
  `has_dirs_only_path` (`symlinks.c`, an `lstat` cache that never follows a link) accepts a real
  directory; otherwise `mkdir` one level; on `EEXIST` with `force`, `unlink` the occupant (a symlink)
  and `mkdir` again. Never a recursive `mkdir`.
- `checkout_entry_ca` runs `create_directories` in the main process, in index order, **before**
  `enqueue_checkout` (`entry.c:581-591`).
- `parallel-checkout.c:98`: only regular files are parallel-eligible; symlinks are written by the
  main process in index order.
- `parallel-checkout.c:340-375`: a worker re-checks the leading directories with
  `has_dirs_only_path` and opens with `O_CREAT | O_EXCL`. A mismatch marks the item
  `PC_ITEM_COLLIDED`; collided items are retried sequentially through `checkout_entry_ca` after the
  workers finish (`:200-235`).

#### D13.3 HFS alias on raw bytes

`update-index -z --add --index-info`; git prints `Ignoring path` for a refused name. tsgit verdict =
`verifyPath(decodePreservingBom(bytes), mode)` at `be0d7832`. `core.protectHFS` defaults to true on
macOS only (source-read: `config.mak.uname`); tsgit applies the HFS rules on every platform today.

| Name bytes | Mode | git `protectHFS=true` | git `false` | tsgit |
|---|---|---|---|---|
| `.git\xff/x` | 100644 | refused | accepted | accepted |
| `.git\xed\xa0\x80/x` (surrogate) | 100644 | refused | accepted | accepted |
| `.git\xc0\xaf` (overlong) | 100644 | refused | accepted | accepted |
| `.git\xc3/x` (truncated) | 100644 | refused | accepted | accepted |
| `.git\xf4\x90\x80\x80/x` (> U+10FFFF) | 100644 | refused | accepted | — |
| `.g\xef\xbb\xbfit\xff/x` | 100644 | refused | accepted | accepted |
| `.GiT\xe2\x80\x8c\xff/x` | 100644 | refused | accepted | — |
| `.git\xef\xbf\xbe/x` (U+FFFE, **valid UTF-8**) | 100644 | refused | accepted | accepted |
| `.git\xef\xbf\xbf/x` (U+FFFF, **valid UTF-8**) | 100644 | refused | accepted | accepted |
| `.git\xef\xbf\xbd/x` (literal U+FFFD) | 100644 | accepted | accepted | accepted |
| `.g\xffit/x` | 100644 | accepted | accepted | accepted |
| `.git\xe2\x80\x8c/x` (control) | 100644 | refused | accepted | `dotgit-hfs-alias` |
| `.gitmodules\xff` | 120000 | refused | accepted | accepted |
| `.gitmodules\xef\xbf\xbe` | 120000 | refused | accepted | accepted |
| `.gitmodules\xff` | 100644 | accepted | accepted | accepted |
| `a/.git\xff/x`; `.git\xff` | 100644 | refused | accepted | — |

Source (`utf8.c:122-185` `pick_one_utf8_char`, `:703-773` `next_hfs_char` / `is_hfs_dot_generic`): a
sequence the picker rejects (C0/C1 lead, E0 overlong, ED A0-BF, EF BF BE/BF, F0 overlong, F4 90+,
F5-FF, truncated, stray continuation) returns 0, which `is_hfs_dot_generic` reads as end of name. So
`.git` + rejected sequence is `.git`; a rejected sequence *inside* the needle (`.g\xffit`) is not.
The U+FFFE/U+FFFF rows are a pre-existing gap on `main` (valid UTF-8, no `pathBytes`).

#### D13.4 Three-way merge over a lossy name

`main` and `side` each change a different ASCII file; both carry the untouched lossy `\xff.txt`.

| # | Command | git 2.55 | tsgit `be0d7832` |
|---|---|---|---|
| T9 | `merge side` (true merge) | exit 0; merge tree names `a`, `b`, `ff2e747874` | `merge.run` ok; merge tree names `a`, `b`, **`efbfbd2e747874`** (history rewrite). Source-read: the merged tree's U+FFFD name is valid UTF-8, so `materializeTree` writes L's blob to `�.txt` |

### D14. ADR-973: lossy entries are absent on disk

**Rule.** A lossy entry behaves, for every reader, exactly like a tracked entry whose `lstat`
returned `FILE_NOT_FOUND`: each route takes its existing missing-file branch, reached by the
`isLossy` test with no fs call. For every writer the write or unlink is skipped, and so is the
creation of its leading directories. This is the macOS outcome (S0: `lstat` → ENOENT) on every
platform; it differs from Linux git, which can write the raw name (ADR-973 consequence).

| Route | "Absent" means | git (macOS) | tsgit after |
|---|---|---|---|
| status / diff (`compareAndRefresh`) | unstaged `deleted` | S1 `.D` | same (Part 16) |
| stat refresh, racy smudge | entry carried unchanged, never smudged | S16: not refreshed | same (Part 16) |
| `add --all` / `add -u` / `add <glob or dir>` | deletion staged | S2, S3, S5 | same; the glob case needs §D15 (Part 18) |
| `add <literal>` | never matches | S5b | §D15 |
| `add --renormalize` | missing-file refusal, index unchanged | S4 (exit 128) | `PATHSPEC_NO_MATCH`, index unchanged (tsgit's existing missing-file code) |
| rm safety valve | no local modification | S8b | same (Parts 16, 18) |
| rm unlink | skipped | S8 | same (Part 17) |
| clean / clean-work-tree check | tracked and absent: work tree reads dirty | S1: `diff-files` reports `D`, the input of git's clean-tree check | same (Part 16) |
| `find-would-overwrite` | a local deletion | `D` | same (Part 16) |
| sparse partition | `present: false` | — | same (Part 16) |
| stash push worktree tree | recorded deleted | S10 | same (Part 16) |
| mv directory member | `bad source` / skipped by `-k` | M1, S9c | same (Part 19) |
| checkout / switch / reset `--hard` / read-tree rebuild / materialize / stash restore / sparse widen / `checkout -- <paths>` (all through `applyChangeset`) | write skipped; the index entry keeps its bytes with zero stat | S1b, S1c, S12b, S13 (errors) | skipped, no error (DC6) (Part 17) |
| `applyChangeset` delete | skipped | — | Part 17 |
| leading directories of a skipped write | not created | `d/` created empty before `open` fails (S1b) | not created: divergence on disk only, invisible to every git command (an empty directory is never listed) |
| merge engine | see §D19 | T9 | DC8 |

Corollary: the S1b/T2 corruption (L's blob in U's file) and the security MEDIUM "L and U written to
one on-disk name" (`apply-changeset.ts:314`) close with Part 17; the lossy-pair route of the
symlink race (§D18) closes with it.

### D15. String pathspecs against lossy entries

A pathspec is a string; a lossy entry's bytes are not. git matches pathspecs bytewise (`wildmatch`,
literal `memcmp`), pinned S5-S8c and S12-S12b: a literal never names a lossy entry (S6, S12), while a
glob (`*.txt`, S5, S7, S12b) and a directory prefix (`d`, S7b, S8c) reach it.

**Matching view.** `matchingPathOf(entry)` is `entry.path` for a UTF-8 entry (zero cost) and, for
a lossy entry, `pathBytes` decoded with each byte of an invalid sequence mapped to the lone
surrogate `U+DC00 + byte` (bytes of an invalid sequence are always ≥ 0x80, so `U+DC80`-`U+DCFF`).
Valid sequences decode as usual; ASCII keeps its position (§D2). Matching the compiled pathspec
against this view gives git's answers:

- a literal compiled from a well-formed string contains no lone surrogate, so it never equals a
  lossy entry's view (S6, S12, S5b);
- `*` and `**` match any code units (S5, S7, S12b);
- `?` matches one code unit, which is one byte for an invalid sequence, as git's `?` matches one
  byte; for a *valid* multibyte character git's `?` matches one byte and tsgit's one character, a
  pre-existing gap for every non-ASCII name (§Out of scope);
- a directory prefix matches through the ASCII `/` (S7b).

Every match of a pathspec against an index or tree entry goes through
`matchesIndexPath(spec, entry)`: `rm.ts:95`, `checkout.ts:334`, `add.ts:534`/`:616`, and the sparse
matcher in `apply-sparse-checkout.ts:60`. The resulting selections are `Set<IndexPathKey>`, never
`Set<FilePath>`, so a restore scoped to U never drops or rewrites L (S12). Display-only matchers
(`snapshot/*`, `grep.ts:204`, `fs-workdir-enumerator.ts`) keep the view (§Out of scope).

### D16. mv: byte membership and re-validation

- Membership: a directory source `s` selects entries whose bytes start with `encode(s)` + `0x2f`.
  With that, the existing cut `pathBytes.subarray(encode(s).length)` is exact, and a lossy `\xff/x`
  is never a member of `�` (M2).
- Defence in depth: every re-pathed entry passes `validateIndexPath` with its bytes before it
  enters the map (the security repro produced `.git/p` and tsgit then refused its own index).
- On-disk check: git checks every member with `lstat` (`builtin/mv.c`, source-read) and a lossy
  member is absent by §D14, so `mv d e` refuses `bad source` naming `d/\xff` and `mv -k d e` moves
  the rest, leaving the lossy entry at its old path (M1). The disk rename moves directory `d` as
  a whole, as git does.

### D17. HFS alias on raw bytes

`verifyPath` keeps its string shape and gains the component bytes for the HFS step only:

```ts
// verify-path.ts — the HFS candidate is the component cut where git's picker stops
const hfsCandidate = (component: string, componentBytes?: Uint8Array): string =>
  componentBytes === undefined
    ? component.slice(0, firstNoncharacter(component))       // U+FFFE / U+FFFF end the name
    : decodePreservingBom(componentBytes.subarray(0, gitPickerValidPrefix(componentBytes)));
```

- `gitPickerValidPrefix(bytes)` returns the offset of the first sequence `pick_one_utf8_char`
  rejects (rules in §D13.3), else `bytes.length`. It is stricter than WHATWG on exactly
  U+FFFE/U+FFFF, the only two rejections a well-formed JS string can encode, hence the string arm.
- The candidate then goes through today's ignorable-code-point strip and comparison. The NTFS and
  ASCII checks keep running on the view (ASCII positions are equal in both, §D2).
- `isObviouslyNotAnAlias` stays valid: every target still begins with `.` or `g`.
- Fast path: the bytes arm runs only for a component that starts like an alias and carries a
  non-ASCII byte; UTF-8 paths without U+FFFE/U+FFFF pay one `indexOf` per such component.

### D18. ADR-974: no write through a leading symlink

#### D18.1 Root cause

`applyWriteWave` pools `groupByCaseFoldedPath` groups. A symlink `A` and `a/payload` are different
groups (`a` ≠ `a/payload` after folding). Task 2 scans `a` → `missing`
(`unlinkSymlinkedLeadingComponent` returns, `symlinked-leading-path.ts:117-129`); task 1 creates the
symlink; task 2's `fs.write` runs the port's recursive parent creation, which follows `a` → outside.
A sequential run is already git-faithful: the scan of `a` sees the symlink, unlinks it and the
write recreates a directory, which is R1. Only concurrency breaks the invariant.

#### D18.2 Mechanism (git's shape)

```
applyWriteWave(writes):
  if no write is a symlink (120000):                 # no task can create a symlink
    pooled groups, as today                          # a pre-existing link is unlinked before any write
  else:
    phase 1 — sequential, index byte order:
      symlink / gitlink entry → writeWorkingTreeEntry (scanner unlinks leading links, invalidates memo)
      regular entry           → scanner.ensureLeadingDirectories(path):
                                  per leading prefix, lstat (no follow):
                                    directory → next
                                    missing   → fs.mkdir(prefix)        # parent proven a real dir
                                    symlink / other → fs.rm(prefix); fs.mkdir(prefix)
    phase 2 — pooled regular-file groups (only regular writes: none creates a symlink):
      each write re-runs unlinkSymlinkedLeadingComponent (git's worker re-check), then writes
```

- Phase 1 is `create_directories` + git's sequential symlink writes. Phase 2 tasks cannot create
  links, so after phase 1 nothing inside tsgit can turn a leading directory into a symlink. The
  phase 2 re-check covers a link that a phase-1 symlink write put over a directory created earlier
  in phase 1 (index order `A/payload` < `a`): it is unlinked and the directory recreated, which is
  git's collided-item retry, with the same final state (regular file wins, `status` ` D a`).
- `PrefixShape` gains `directory` vs `other` (a regular file at a leading prefix needs the
  unlink + mkdir, not a write into it).
- **Memo keys are spellings, the disk folds them.** On a case-insensitive filesystem `A` and `a` are
  one name under two memo keys, so `invalidate('a')` after a symlink write leaves `A`'s
  `directory` verdict stale. In index order every path under one spelling is contiguous, so within
  phase 1 a stale key is not revisited; phase 2 is where it bites (`A/payload` < link `a`: phase 2's
  re-check would trust `A` = directory and write through the link). Hence the memo is **cleared at
  the phase 1 → phase 2 boundary**. Within phase 2 no task creates a link, so the memo stays valid.
  Every phase-1 symlink write also clears the memo: rare, cheap, and it removes the reliance on
  index contiguity across filesystem folds (Unicode normalisation included).
- Port contract unchanged: node, memory and browser adapters all reach this through `lstat`,
  `mkdir`, `rm`, `symlink`, `write`. An adapter without symlinks never takes phase 1's link arms.
- The filter-process / unloadable-source path (`applyGroup` on the sorted list) is already
  sequential; it uses the same `ensureLeadingDirectories` so both paths share one behaviour.
- Residual (no symlink, pre-existing, not ADR-974): regular `a` and regular `A/y` in different pool
  groups on a case-insensitive filesystem can fail nondeterministically (`EEXIST`/`ENOTDIR`); never
  an escape.

#### D18.3 Deterministic test

`test/unit/application/primitives/support/interleaving-fs.ts` wraps the memory `FileSystem`:

- **case folding**: every path is lower-cased before delegating, so `A` and `a` are one entry on
  every platform;
- **gate 1**: `symlink(target, p)` proceeds once an `lstat` of a path folding to `p` has resolved,
  or, after one macrotask, when it is the only fs operation in flight. The second arm prevents a
  deadlock on the fix, where phase 1 writes the link alone before anything scans `a`; on today's
  code the pooled payload task always scans `a` within microtasks, so the first arm fires;
- **gate 2**: a `write`/`writeStream` whose leading prefix folds to a pending symlink's path waits
  for that symlink to finish;
- **recorder**: at every `write`, `writeStream` and `mkdir`, it `lstat`s each leading prefix
  through the inner fs and records any `isSymbolicLink`.

On today's code the gates force scan → symlink → write, and the recorder flags the write. On the
fix, phase 1 runs the link and the directory creation in index order, gate 2 never holds a phase-2
write (the link is done), and the recorder stays empty. The second order (`A/payload` < `a`) is
also the memo case: phase 1 caches `A` as a directory, the link `a` then replaces that (still
empty) directory, and only the boundary clear makes phase 2 re-`lstat` `A` instead of writing
through the link. A mutant that drops the boundary clear must fail that test. Tests run both name orders
(`A` link + `a/payload`; `a` link + `A/payload`) and assert: recorder empty; final memory state has a
real directory holding `payload` and no symlink (R1). Interop R1/R2 run on a real case-insensitive
filesystem only (probe-gated); R4 runs everywhere.

### D19. Merge engine over lossy names

Source-read: `applyMergeToWorktree` (`apply-merge-to-worktree.ts:445`) and `mergeTreesToTree` (511)
flatten every side with `flattenTree` (string-keyed `FlatTree`), and a clean merge rebuilds the
**whole** tree through `synthesiseMergedTree` → `synthesizeTreeFromIndex` from those string paths.
A lossy name is therefore emitted as its U+FFFD view even when the merge never touched it (T9), and
`materializeTree` then sees a valid `�.txt` and writes L's blob there, which ADR-973 forbids. The
same engine serves `merge`, `stash apply`, `cherry-pick`/`revert` (`internal/replay-sequence.ts`)
and `rebase --rebase-merges` (`internal/rebase-merges-steps.ts`). DC3 placed the merge engine out
of scope on the premise that untouched lossy entries survive; T9 falsifies that premise. DC8.

## Decision candidates

DC1-DC5 (first draft) were ratified as ADR-968 … ADR-972 and are kept below as history. Revision 2
opens DC6-DC11 only; ADR-973 and ADR-974 already decide the policies they implement.

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| DC6 | Outcome of a command whose `applyChangeset` skipped a lossy write (reset `--hard`, checkout/switch, `checkout -- <paths>`, stash restore, sparse widen) | **A** succeed; nothing extra in the result; `status` reports the entries ` D`. **B** succeed and return a structured `absent: ReadonlyArray<IndexPath>` (raw bytes) on `ApplyChangesetResult` and each command result: an additive public type. **C** throw a typed error after writing the rest, as macOS git exits non-zero (S1b 128, S1c 1, S12b 255; S13 `switch` exits 0) | **A** | ADR-973 already accepts "without git's error line". Linux git exits 0 on the same commands, and macOS git is not even consistent (S13). Status already exposes the state as data (ADR-249). B is additive and can come later (YAGNI). C ties tsgit to one platform's failure and leaves half-applied state, as git does |
| DC7 | When the write wave runs the sequential leading-directory phase (§D18) | **A** only when the changeset writes at least one symlink. **B** always. **C** keep a fully pooled wave and group each write with any symlink whose folded path is one of its leading prefixes | **A** | Without a symlink write, no tsgit task can create a link, and the scanner unlinks a pre-existing one before writing, so today's pool is safe. B adds a sequential `lstat`/`mkdir` pass per distinct directory to every checkout (hot path). C depends on reproducing the filesystem's fold (APFS case and normalisation, NTFS); one missed fold class reopens the escape |
| DC8 | Merge engine over lossy names (§D19, T9) | **A** carry bytes through `FlatTree`, merge outcomes and tree synthesis (git-faithful; `FlatTree` has 37 consumer files). **B** refuse a merge-engine run (merge, stash apply, cherry-pick/revert, rebase-merges) whose base/ours/theirs holds a lossy name: a typed error before any ref, index or worktree write; needs a divergence ADR; A goes to the backlog. **C** document only; history keeps being rewritten | **B** now, A on the backlog | B stops a silent history rewrite and an ADR-973 violation with one check on the flattened sides. A is the faithful end state, but it reaches 37 files and the rename/attribute machinery. C leaves a proven data-loss route open. Your standing "fold gaps" preference argues for A in this run; B is the smaller safe step |
| DC9 | Which `validateIndexPath` callers pass bytes to the HFS check (§D17) | **A** every caller that holds an entry, parse included. **B** write-side only (commit, synthesize, checkout, mv); parse keeps the view so tsgit can still read an index Linux git wrote with `.git\xff/x`. **C** gate all HFS rules on the platform like git's `core.protectHFS` default (Darwin only, `config.mak.uname:157`) | **A** | tsgit already applies the HFS rules on every platform and validates at parse (`.g‌it/x` is refused at parse today). A keeps one rule; B creates two verdicts for one path; C changes every existing HFS verdict and belongs in its own ADR |
| DC10 | Cache-tree invalidation cost (perf review: `invalidateCacheTree` +13-27% on 10k changed UTF-8 paths, 40-110 ns/path, under 0.1% of a 100k-entry index write) | **A** accept. **B** precompute lighter component projections (gain unmeasured) | **A** | The cost is per *changed* path and invisible at command scale; B is an unproven optimisation |
| DC11 | Pathspec matching for lossy entries (§D15) | **A** surrogate-escape matching view (`U+DC00 + byte` per invalid byte). **B** match the U+FFFD view and exclude lossy entries from literal matches only. **C** a byte-level matcher (compile pathspecs to bytes) | **A** | A gives git's answer for literals, `*`, `**`, directory prefixes, and `?` on invalid bytes, with zero cost for UTF-8 entries. B is wrong for `?` and classes (`\xe2\x80` is one U+FFFD for two bytes) and for globs carrying U+FFFD. C is the exact answer also for valid multibyte `?`, but it rewrites the pathspec engine for a pre-existing, separate gap |

History (first draft, ratified):

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

- **Revision 2 tests** (each part lists its own; the shared rules):
  - every §D13 row a part closes becomes an interop row in `index-path-bytes-interop.test.ts`;
    rows that depend on APFS (S0-S17 git side, R1-R3) assert the tsgit outcome on every platform
    and compare with git only where the probe says the filesystem refuses non-UTF-8 names / folds
    case;
  - ADR-973 unit tests use an fs double that records every call and assert no call names a lossy
    entry's view;
  - ADR-974 uses the §D18.3 interleaving double: deterministic, no repeat loop;
  - property siblings: `matching-path.properties.test.ts` (Part 18), `verify-path.properties.test.ts`
    (Part 21), the commit lossy-directory property (Part 24a).
- **Review test gaps folded into Part 24**: commit lossy directory with two children
  (`commit.ts:413`); zero-stat lossy leaf rebuild (`build-index-from-tree.ts:99`); public `walkTree`
  omits `pathBytes` (`walk-tree.ts:285`); rm of a lossy entry by key (`rm.ts:109`); `sut` naming in
  `index-path-bytes-interop.test.ts:190` and `:203`. Suspected equivalent mutants from the tests
  review (`walk-tree.ts:242`, `encoding.ts:100` `includes` fast path, `carry-extensions.ts:88`) go
  through the mutation triage in `.claude/workflow/mutation.md`; `carry-extensions.ts:88` is removed
  outright (Part 24h).

## Out of scope

- **Working-tree I/O of non-UTF-8 names**: the `FileSystem` port is string-pathed, so a checkout writes
  the U+FFFD name and status cannot stat a raw-byte file. It needs a byte-path port, which is its own
  design. Today's behaviour is unchanged. **[revision 2]** ADR-973 replaces "unchanged": lossy entries
  are absent on disk (§D14). Materialising the raw name, as Linux git does, still needs the byte port.
- **Pathspec addressing of non-UTF-8 entries** (`rm`, `add`, `checkout -- <path>` with a raw-byte
  name): a JS string cannot express the bytes. Directory and glob pathspecs still match through the
  U+FFFD view. **[revision 2]** Literals now never match a lossy entry and globs match through the
  §D15 view. A *literal* naming the raw bytes is still not expressible.
- **Merge engine** (`three-way-tree`, `mergedBlobEntries`, `conflictsToIndexEntries`, rename detection,
  `merge.ts:1902`): string-pathed end to end. A lossy path a merge *touches* still comes out as U+FFFD
  (DC3-C). Untouched lossy entries survive through §D5. **[falsified, T9]**: untouched entries do
  not survive a three-way merge; DC8 decides the fix.
- **`?` and character classes on valid non-ASCII names** (git matches bytes, tsgit matches UTF-16
  units): pre-existing for every non-ASCII path, not specific to lossy entries (§D15).
- **Case-fold write collisions without symlinks** (regular `a` and regular `A/y` in separate pool
  groups on a case-insensitive filesystem): a pre-existing nondeterministic failure, never an escape
  (§D18.2).
- **tsgit `fsck` on `.git\xff/x` trees** (git `fsck` warns `hasDotgit`, tsgit exits 0; security
  review): pre-existing, separate surface.
- **rm of an untracked file at a lossy entry's view** (security review, OUT-OF-SCOPE note): closed by
  Part 17, since `rm` no longer unlinks for a lossy entry.
- **Snapshot rows / display surfaces** (`IndexEntryRow`, `grep`, `blame`, `rev-parse :path`, archive,
  diff/patch headers): they read the decoded view, as `TreeEntry.name` does today (ADR-249).
- **Cache-tree decode switch to `decodePreservingBom`**: not needed. Matching already keys on
  `nameBytes`, and a change would churn #317's tests for no observable gain.
- ~~**HFS alias check on invalid UTF-8**~~: pinned in §D13.3, in scope as Part 21.
- **tsgit refusing unsafe paths at parse** (git verifies at write, not read): an existing divergence,
  untouched.
