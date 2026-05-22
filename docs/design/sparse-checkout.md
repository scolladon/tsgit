# Sparse Checkout — Design (Phase 17.3)

> Status: Implemented (v2.0). Backlog item **17.3** — "Sparse checkout
> (`.git/info/sparse-checkout` patterns, partial materialization)". ADRs
> 069–074.
>
> Implementation note: `apply-sparse-checkout.ts` ships in
> `src/application/commands/internal/` (not `src/application/primitives/` as
> §7.4 / §13 originally drafted) — it depends on `acquireIndexLock`, a
> command-internal helper, and a primitive may not import from `commands/`.

## 1. Goal & scope

Sparse checkout lets a repository materialise only a **subset** of its tracked
files into the working tree while the index still records the *whole* tree.
The excluded files are not deleted from history — they are simply absent from
disk, marked in the index by a per-entry **skip-worktree** bit.

Phase 17.3 delivers:

1. **Index v3 / skip-worktree** — the index entry format gains the extended
   flags field so a skip-worktree (and intent-to-add) bit can be parsed and
   written. Without this the feature cannot exist git-faithfully.
2. **The sparse pattern engine** — `.git/info/sparse-checkout` parsing in both
   **cone** and **non-cone** modes, plus serialization.
3. **`core.sparseCheckout` / `core.sparseCheckoutCone`** — read from and
   written to `.git/config`.
4. **`repo.sparseCheckout(...)`** — a tier-1 command with git-parity
   subcommands: `list`, `set`, `add`, `reapply`, `disable`.
5. **`checkout` integration** — a branch switch in a sparse repo materialises
   only in-pattern files; out-of-pattern entries get the skip-worktree bit.
6. **`status` / `add --all` integration** — both become skip-worktree aware so
   the feature does not produce phantom "deleted" entries or stage phantom
   removals.

### Explicitly out of scope of 17.3 itself

- **`reset --hard` / `reset --mixed` / `merge` sparse-awareness** was deferred
  by 17.3 ([ADR-073](../adr/073-sparse-integration-scope.md)) and **delivered
  in 17.3a** — these commands now honour sparse patterns. See
  `docs/design/sparse-reset-merge.md` and ADRs 075–076.
- **The sparse-index optimization** — git's `.git/index` "sparse directory"
  entries that collapse an excluded subtree to a single tree entry. tsgit's
  index always holds one entry per file. Cone mode still gives the *visible*
  sparse-checkout behaviour; only the index-size optimization is absent.
- **Index v4** — path-prefix compression. tsgit reads/writes v2 and v3 only;
  v4 is rejected at parse time exactly as today.
- **`git sparse-checkout init`** — git deprecated it in favour of `set`. Not
  surfaced.
- Per-file `add <explicit-path>` / `rm` interaction with skip-worktree entries
  beyond `add --all`. Out of pattern paths are absent from disk, so an explicit
  `add` of one already fails naturally; refining that is not in 17.3.

## 2. Background — how git sparse checkout works

The mechanism has three moving parts:

- **The pattern file** `.git/info/sparse-checkout` — one pattern per line,
  `.gitignore` syntax. A path is "in the sparse set" when the patterns select
  it. There are two pattern *modes*:
  - **non-cone** — arbitrary `.gitignore`-style patterns, last-match-wins.
  - **cone** (`core.sparseCheckoutCone=true`, the modern git default) — the
    file is restricted to a directory-prefix shape git generates from a list
    of directories. Matching becomes an O(1) directory-membership test instead
    of a per-pattern regex sweep.
- **`core.sparseCheckout`** — the boolean gate. False/absent ⇒ the repo
  behaves exactly as a normal (non-sparse) repo.
- **The skip-worktree bit** — a bit on each *index entry*. The index keeps
  **every** tracked path; the bit records "this path is intentionally absent
  from the working tree". `status`, `add`, `commit` treat a skip-worktree
  entry as present-and-unchanged so the absence does not read as a deletion.

Applying patterns = for every index entry, decide in/out; materialise the
file and clear the bit for in-pattern paths, delete the file and set the bit
for out-of-pattern paths.

> **Rejected alternative.** An "easier v1" would drop out-of-pattern entries
> from the index entirely instead of carrying a skip-worktree bit. That is
> *not* git-faithful and is actively dangerous: the very next `commit` would
> serialise a tree missing those paths — silent history-wide data loss — and
> `disable` could never restore them. The skip-worktree bit, hence index v3,
> is mandatory ([ADR-069](../adr/069-skip-worktree-index-v3.md)).

## 3. Index v3 — skip-worktree extended flags

### 3.1 On-disk format

A v2 index entry is a 62-byte fixed header (`ENTRY_HEADER_SIZE`) — 40 bytes of
stat data, a 20-byte SHA-1, a 16-bit `flags` field — followed by the
NUL-terminated path, padded with NULs to an 8-byte boundary.

The 16-bit `flags` field:

| bits     | meaning            |
|----------|--------------------|
| `0x8000` | assume-valid       |
| `0x4000` | **extended**       |
| `0x3000` | stage (0–3)        |
| `0x0FFF` | name length        |

In a **v3** index, an entry with the `extended` (`0x4000`) bit set carries an
**additional 16-bit extended-flags field** immediately after the 62-byte
header (so the header is effectively 64 bytes for that entry):

| bits     | meaning            |
|----------|--------------------|
| `0x8000` | reserved (must be 0) |
| `0x4000` | **skip-worktree**  |
| `0x2000` | **intent-to-add**  |
| others   | reserved           |

An entry with neither bit set never gets the extended field, even inside a v3
index. The index *header* version is the **minimum** that can represent its
entries: v2 when no entry needs extended flags, v3 when at least one does.
git writes the minimum; tsgit matches that.

### 3.2 Domain type changes — `src/domain/git-index/index-entry.ts`

`IndexEntryFlags` today is `{ assumeValid, extended, stage }`. The `extended`
field is a *serialization artefact*, not domain state — its value is fully
determined by `skipWorktree || intentToAdd`. Keeping it as a stored field
invites an invariant bug (a flags record where `extended` disagrees with the
bits). It is **removed**; the parser computes it locally to decide whether to
read the extra field, the writer computes it locally to decide whether to emit
it.

```ts
export interface IndexEntryFlags {
  readonly assumeValid: boolean;
  readonly stage: 0 | 1 | 2 | 3;
  readonly skipWorktree: boolean;
  readonly intentToAdd: boolean;
}

/** The common case — a freshly staged, materialised, stage-0 entry. */
export const STAGE0_FLAGS: IndexEntryFlags = {
  assumeValid: false,
  stage: 0,
  skipWorktree: false,
  intentToAdd: false,
};
```

`GitIndex.version` widens from the literal `2` to `2 | 3`.

`intent-to-add` is modelled — not because tsgit ever *sets* it (there is no
`git add -N`), but so that reading a git-written v3 index that contains
intent-to-add entries and writing it back **round-trips faithfully** instead
of silently dropping the bit. Committing an intent-to-add entry stays an
exotic, unsupported edge (its hash is zero); 17.3 only guarantees the bit
survives a read/write cycle.

`STAGE0_FLAGS` is exported through the `git-index` barrel and replaces every
current `{ assumeValid: false, extended: false, stage: 0 }` literal — the
compiler enumerates the construction sites the moment `IndexEntryFlags`
changes shape, so the migration is mechanical and exhaustive. The handful of
**non-stage-0** sites (conflict entries built at stage 1/2/3 by
`conflictsToIndexEntries`) spread `STAGE0_FLAGS` with a `stage` override:
`{ ...STAGE0_FLAGS, stage: 2 }`.

### 3.3 Parser — `index-parser.ts`

- Accept `version === 2 || version === 3` (today: only `2`). Any other value
  still throws `INVALID_INDEX_HEADER`.
- `parseFlags(raw, offset, version)`:
  - `assumeValid = (raw & 0x8000) !== 0`, `stage = (raw >>> 12) & 0x3`.
  - `extended = (raw & 0x4000) !== 0`.
  - `extended && version < 3` → `INVALID_INDEX_ENTRY` ("extended flag requires
    index v3") — the current v2-only guard, narrowed.
  - `extended` → read the 16-bit field at `offset + 62`;
    `skipWorktree = (ext & 0x4000) !== 0`, `intentToAdd = (ext & 0x2000) !== 0`.
  - not `extended` → `skipWorktree = false`, `intentToAdd = false`.
- The per-entry truncation guard — today `offset + 62 > limit` — is widened to
  `offset + 62 + (extended ? 2 : 0) > limit`, checked **after** the flags word
  is read and **before** the extended-flags field, so an extended entry near
  EOF cannot read past the buffer.
- Entry cursor: the post-header offset is `entryStart + 62 + (extended ? 2 :
  0)`; the NUL scan, name slice and `(len + 7) & ~7` padding are unchanged
  beyond that shifted base.
- `parseIndex` returns `version` verbatim (`2 | 3`) instead of the hardcoded
  `2`.

### 3.4 Writer — `index-writer.ts`

- `serializeIndex` **derives** the on-disk version from the entries:
  `chooseVersion(entries) = entries.some(e => e.flags.skipWorktree ||
  e.flags.intentToAdd) ? 3 : 2`. The `GitIndex.version` field passed in is
  informational and ignored — a caller that hands `{ version: 2 }` with a
  skip-worktree entry still gets a correct v3 file (v2 cannot represent it).
  This keeps `acquireIndexLock.commit` (which builds a `GitIndex` literal)
  unchanged.
- Per entry: `extended = flags.skipWorktree || flags.intentToAdd`.
  - `entryLength = 62 + (extended ? 2 : 0) + pathBytes.length`;
    `paddedLength = (entryLength + 8) & ~7` (unchanged formula, shifted base).
  - `flags16 = (assumeValid ? 0x8000 : 0) | (extended ? 0x4000 : 0) | (stage
    << 12) | min(nameLen, 0xFFF)`.
  - when `extended`: write `ext16 = (skipWorktree ? 0x4000 : 0) | (intentToAdd
    ? 0x2000 : 0)` at `offset + 62`; the path starts at `offset + 64`.
- A repo that never touches sparse checkout has no skip-worktree entry, so
  `chooseVersion` returns `2` and every index tsgit writes is **byte-identical
  to today** — zero regression risk for the existing corpus.

## 4. The sparse domain module — `src/domain/sparse/`

Pure, platform-free. Parsing, matching, serialization. No I/O.

### 4.1 Types — `sparse-pattern.ts`

```ts
/** A single non-cone pattern, parsed and compiled. */
export interface SparseRule {
  readonly source: string;       // original line, for `list` output
  readonly negated: boolean;     // leading `!`
  readonly regex: RegExp;        // compiled, see §4.3
}

export type SparseSpec =
  | { readonly mode: 'cone';
      readonly recursive: ReadonlySet<string>;   // fully-included dirs
      readonly parents: ReadonlySet<string>; }   // navigable-only dirs
  | { readonly mode: 'no-cone';
      readonly rules: ReadonlyArray<SparseRule> };

/** `true` ⇒ the path is in the sparse set (materialise it). */
export type SparseMatcher = (path: FilePath) => boolean;
```

### 4.2 Cone mode — `cone.ts`

A **cone** is a set of directories. Two roles:

- **recursive** dirs `R` — the directories the user asked for; *every*
  descendant file is included.
- **parent** dirs `P` — proper ancestors of recursive dirs that are not
  themselves recursive; only their *direct* files are included so the user can
  navigate down to a recursive dir. The repository root is always an implicit
  parent.

`coneMatcher(spec)` — for file `p`, let `d = dirname(p)` (`''` for a root
file):

```
included(p)  ⟺  d === ''                      // root files always in
              ∨  d ∈ P                         // direct child of a parent dir
              ∨  d ∈ R ∨ ∃ ancestor a of d, a ∈ R   // under a recursive dir
```

`buildConeSpec(dirs)` — from the user's directory list `D` (normalised: POSIX
separators, no leading/trailing slash, deduped; `.`/`..`/empty segments and
glob metacharacters `*`/`?` rejected with `invalidOption` — a cone input is a
*directory*, not a pattern):

```
R = D
P = (⋃_{d ∈ R} properAncestors(d)) \ R
```

`properAncestors(d)` yields the **non-empty** proper ancestor directory paths
of `d` — `properAncestors('a/b/c') = {'a/b', 'a'}`. The repository root
(`''`) is deliberately excluded; `coneMatcher` handles root files via the
`d === ''` arm, so `P` never contains the empty string and `serializeCone`
never emits a `//` line.

`serializeCone(spec)` emits git's exact cone-file shape — the header pair, then
every dir in `sort(P ∪ R)` (path-sorted ⇒ a parent always precedes its
children):

```
/*
!/*/
/<parent>/          ⎫ for each d ∈ P
!/<parent>/*/       ⎭
/<recursive>/         for each d ∈ R
```

Example — `set src/app docs` (cone): `R = {src/app, docs}`,
`P = {src}`:

```
/*
!/*/
/docs/
/src/
!/src/*/
/src/app/
```

`parseCone(text)` recognises this grammar back into `{ R, P }`: skip the
`/*` + `!/*/` header; a `/<d>/` line followed by `!/<d>/*/` ⇒ `d ∈ P`; a
`/<d>/` line **not** so followed ⇒ `d ∈ R`. Any line outside the grammar ⇒
return `undefined` ("not a cone file") and the caller falls back to non-cone
matching of the same text ([ADR-070](../adr/070-cone-and-non-cone.md)) — this
is exactly git's behaviour when a hand-edited cone file stops being
cone-shaped.

### 4.3 Non-cone mode — `non-cone.ts`

Non-cone patterns are `.gitignore` syntax: leading `!` negates, leading `/`
anchors, trailing `/` is directory-only, `#`/blank lines are skipped. The line
tokenisation is **shared** with `parseGitignore` — `domain/ignore/parse-gitignore.ts`
exposes a new pure helper `tokenizeIgnoreLine(rawLine): { negated, anchored,
directoryOnly, cleanPattern } | undefined` (the comment/blank/escape handling
already inside it, extracted) so the two parsers do not duplicate it.

`compileSparseRule` turns a tokenised line into a `SparseRule`. The compiled
regex must answer "does this pattern *cover* file `p`" — covering includes
**recursive subtree** inclusion: `/src/` covers `src/main.c`. The rule:

- A pattern is **recursive** when `directoryOnly` is true *or* its final path
  segment contains no glob metacharacter (`*` / `?`). Recursive ⇒ compile with
  a `(/.*)?` descendant suffix; non-recursive ⇒ a plain `$`.
- Reuses `compileGlob` (`domain/pathspec`) for the body; `compileGlob` already
  supports the `withDirSuffix` option that appends `(/.*)?$`.

| pattern   | recursive? | covers                                        |
|-----------|------------|------------------------------------------------|
| `/src/`   | yes (dir)  | `src` and every descendant                     |
| `/src`    | yes (no wildcard) | `src` and every descendant              |
| `*.ts`    | no (`*`)   | any `*.ts` file at any depth                   |
| `/src/*`  | no (`*`)   | direct children of `src` only                  |
| `build`   | yes        | any `build/` subtree at any depth              |

`nonConeMatcher(rules)` — for file `p`, walk the rules in file order; each rule
whose regex matches `p` sets `result = !negated`; the default is `false`
(not in the sparse set). Last-match-wins, exactly git/`.gitignore`.

> A pattern like `/src/*` that names a wildcard last segment covers only
> direct children, never the subtree — a deliberate, documented choice
> ([ADR-070](../adr/070-cone-and-non-cone.md)). Users wanting the subtree
> write `/src/` or `/src`. Cone mode (the default) sidesteps the question
> entirely.

### 4.4 `parseSparseCheckout(text, coneRequested)` & `buildSparseMatcher(spec)`

`parse-sparse-checkout.ts` is the single entry point. It returns
`{ readonly spec: SparseSpec; readonly degraded: boolean }` — `degraded`
lives on the *parse result*, not on `SparseSpec` itself:

- `coneRequested === true` → try `parseCone`; on success `{ spec: <cone>,
  degraded: false }`; on failure (the file is not cone-shaped) fall back to
  non-cone parsing → `{ spec: <no-cone>, degraded: true }` so the caller can
  log a one-line warning.
- `coneRequested === false` → non-cone parse → `{ spec: <no-cone>, degraded:
  false }`.

`buildSparseMatcher(spec): SparseMatcher` dispatches to `coneMatcher` /
`nonConeMatcher`.

## 5. Errors — `src/domain/commands/error.ts`

One new `CommandError` variant — the pattern file is read with a size cap
(`MAX_SPARSE_PATTERN_FILE_BYTES = 1 MiB`, mirroring `MAX_GITIGNORE_BYTES`):

```ts
| { readonly code: 'SPARSE_PATTERN_FILE_TOO_LARGE';
    readonly path: FilePath; readonly size: number; readonly limit: number }
```

Factory `sparsePatternFileTooLarge(path, size, limit)`; `extractDetail` arm in
`domain/error.ts`. Bad command input (an absolute or `..`-bearing cone
directory, an over-long pattern, mixing `set` with no patterns) reuses the
existing `invalidOption(option, reason)`. A per-pattern budget — 256 UTF-8
bytes, max 2048 patterns — mirrors the Phase 14.2 pathspec budget and throws
`invalidOption`.

## 6. Config — read and write

### 6.1 `config-read.ts` — two new `core` keys

`ParsedConfig.core` gains `sparseCheckout?: boolean` and
`sparseCheckoutCone?: boolean`. `mergeCore` parses the lowercased keys
`sparsecheckout` / `sparsecheckoutcone` via the existing `parseGitBoolean`;
`finalizeCore` adds the two `!== undefined` arms. Mechanical — the exact shape
of the `bare` field already there.

### 6.2 A minimal config writer — `update-config.ts` (NEW primitive)

tsgit has **no** general `.git/config` writer today (`bootstrap` renders the
whole file once at init). Sparse checkout must flip `core.sparseCheckout` /
`core.sparseCheckoutCone`, so a writer is required. A *full* INI
read-modify-render risks dropping comments and reformatting unrelated
sections; instead the writer does **targeted line surgery** on the `[core]`
section ([ADR-074](../adr/074-minimal-config-writer.md)).

The pure core — exported for unit tests:

```ts
/** Set `key` under `[core]` to `value`, preserving everything else. */
export const setCoreConfigEntry = (text: string, key: string, value: string): string;
```

Algorithm: split into lines; find the `[core]` header (a `[core]` /
`[core ""]` header, not a subsection); within that section find an existing
`key =` line (case-insensitive key) and replace its value, else insert a
`\t<key> = <value>` line right after the header; if there is no `[core]`
section at all, append `[core]\n\t<key> = <value>\n`. Other sections,
comments, blank lines, and key order are untouched.

The primitive `updateCoreConfig(ctx, entries: Record<string, string>)` reads
`${gitDir}/config` (empty string if absent), folds `setCoreConfigEntry` over
the entries, writes the result, and **invalidates the `readConfig` cache** for
the context (`__resetConfigCacheForTests` is generalised to a public
`invalidateConfigCache(ctx)` — the cache is per-`Context`, so a config write
must drop the stale entry). Booleans are written as the strings `true` /
`false`.

## 7. Sparse-checkout primitives

### 7.1 `path-layout.ts`

```ts
export const sparseCheckoutPath = (gitDir: string): string =>
  `${gitDir}/info/sparse-checkout`;
```

### 7.2 `read-sparse-checkout.ts` (NEW)

- `readSparsePatternText(ctx): Promise<string | undefined>` — read
  `.git/info/sparse-checkout`, bounded by `MAX_SPARSE_PATTERN_FILE_BYTES`
  (the byte length is checked before decode; over-cap throws
  `SPARSE_PATTERN_FILE_TOO_LARGE`). Absent file ⇒ `undefined`.
- `loadSparseMatcher(ctx): Promise<SparseMatcher | undefined>` — the gate
  every consumer uses. Reads `core.sparseCheckout`; falsy/absent ⇒ `undefined`
  (sparse inactive — callers behave exactly as today). Truthy ⇒ read
  `core.sparseCheckoutCone`, read the pattern text (absent ⇒ treated as empty
  patterns — the mode's matcher then decides: a non-cone empty file selects
  nothing, a cone empty file still selects root files via the implicit cone),
  `parseSparseCheckout` + `buildSparseMatcher`. A `degraded` cone file logs
  one `ctx.logger` warning.

### 7.3 `write-sparse-checkout.ts` (NEW)

`writeSparsePatternText(ctx, text)` — `mkdir ${gitDir}/info` defensively, then
`writeUtf8` the file. Pure-ish: the command computes the text (via
`serializeCone` or the raw non-cone lines joined by `\n`).

### 7.4 `apply-sparse-checkout.ts` (NEW) — the engine

`applySparseCheckout(ctx, opts)` re-shapes the **working tree** to match a
matcher, operating on the *current index* (which already represents the whole
tree). Used by the command's `set` / `add` / `reapply` / `disable`.

```ts
export interface ApplySparseCheckoutOpts {
  /** `undefined` ⇒ "include everything" (the `disable` path). */
  readonly matcher: SparseMatcher | undefined;
  /** Overwrite locally-modified files that the matcher would now exclude. */
  readonly force?: boolean;
}
export interface ApplySparseCheckoutResult {
  readonly materialized: number;          // files written into the worktree
  readonly removed: number;               // files deleted from the worktree
  readonly retained: ReadonlyArray<FilePath>;  // dirty excludees left in place
}
```

Flow (under `acquireIndexLock`, lock-first — read index inside the lock):

1. `readIndex`; partition stage-0 entries by `matcher(path)` (matcher absent ⇒
   all included).
2. **Dirty pre-scan.** For each *to-be-excluded* entry whose file is currently
   present, hash-compare the file against the entry's `id` (the shared
   `isWorkingTreeDirty` helper, §9). A dirty file with `force` falsy ⇒
   **retained**: it is *not* deleted and its entry keeps `skipWorktree: false`
   ([ADR-072](../adr/072-sparse-dirty-file-policy.md)). Clean, or `force` ⇒
   removable.
3. Build a `Changeset`: `delete` for each removable-excluded present file;
   `add` for each included entry whose file is absent; `noop` otherwise. Call
   `applyChangeset` with `force: true` (dirtiness already adjudicated in step
   2 — the changeset only ever deletes clean/forced files).
4. Assemble the new index entry list:
   - included entries → `skipWorktree: false` **always** (the bit is cleared
     even if a stale prior entry had it set); a written one carries the fresh
     post-write stat from `applyChangeset`, an untouched one keeps its prior
     stat fields.
   - removable-excluded entries → `skipWorktree: true`, stat fields zeroed
     (the file is gone; `status` skips them so staleness is moot), `id` /
     `mode` preserved.
   - retained entries → unchanged (`skipWorktree: false`).
5. `lock.commit(newEntries)` — serialised v3 iff any entry ended up
   skip-worktree.

`disable` passes `matcher: undefined`: every entry is "included", every absent
file is re-materialised, every skip-worktree bit clears, the index serialises
back to v2.

## 8. `materializeTree` — the sparse predicate (the `checkout` path)

A branch switch builds the working tree from a *target tree*, not the current
index, so it cannot use `applySparseCheckout`. Instead `materializeTree` gains
an optional predicate:

```ts
export interface MaterializeTreeOpts {
  // …existing fields…
  /** Branch-switch sparse filter. Honoured only when `paths` is undefined. */
  readonly sparse?: SparseMatcher;
}
```

When `sparse` is supplied (and `paths` is not):

- The collected target entries split into `inSparse` / `excluded`.
- The index fed to `computeChangeset` is `currentIndex` **with its
  skip-worktree entries dropped** — a path that was excluded before (absent on
  disk) must not be diffed as an already-present file. With that filtered
  index, `computeChangeset(filteredIndex, inSparse)` classifies each path
  correctly with no special-casing:
  - skip-worktree-before, in-pattern-now → not in filtered index, in
    `inSparse` → **`add`** → the absent file is written. (This is why the
    filter is cleaner than a `noop`→`update` upgrade — the path simply never
    looks like a no-op.)
  - skip-worktree-before, still excluded → in neither side → absent from the
    changeset → no work, no count.
  - materialised-before, in-pattern-now → normal `add`/`update`/`noop`.
  - materialised-before, excluded-now → in filtered index, not in `inSparse` →
    **`delete`** → the file is removed.
- `newIndexEntries` = the merged in-pattern entries (as today, but built from
  `inSparse`) **plus** one synthesised `skipWorktree: true` entry per
  `excluded` target path (`id` / `mode` from the tree, zeroed stat); the merged
  list is re-sorted by path.

`checkout`'s `switchBranch` calls `loadSparseMatcher(ctx)` once; when defined,
it threads `sparse` into the `materializeTree` call. When `undefined`, the
call is byte-for-byte what it is today.

A branch switch that would put a **dirty** file out of pattern hits
`checkout`'s existing whole-operation dirty guard — `applyChangeset` collects
the `delete`'s dirty path and throws `CHECKOUT_OVERWRITE_DIRTY` (unless the
caller passed `force`). This deliberately differs from `applySparseCheckout`'s
*retain* policy ([ADR-072](../adr/072-sparse-dirty-file-policy.md)): each
command keeps the dirty semantics it already had — `checkout` refuses the
whole operation, the `sparseCheckout` command retains and continues.

## 9. Shared dirty-check helper

`apply-changeset.ts` already hashes a working-tree file and compares it to an
expected id (`blobMatches` / `isTrackedDirty`, file-private). `status.ts`
re-implements the same compare (`isModified`). `applySparseCheckout` needs it
too. `isTrackedDirty` is **promoted** to an exported helper
`isWorkingTreeDirty(ctx, absPath, expectedId): Promise<boolean>` from
`apply-changeset.ts` and reused by `applySparseCheckout`. (Folding `status`'s
copy in is a tidy-up noted for the refactor pass, not a 17.3 requirement.)

## 10. The `sparseCheckout` command — `src/application/commands/sparse-checkout.ts`

One tier-1 command, discriminated `action`, mirroring `reflog` / `branch`.

```ts
export type SparseCheckoutAction =
  | { readonly action: 'list' }
  | { readonly action: 'set'; readonly patterns: ReadonlyArray<string>;
      readonly cone?: boolean; readonly force?: boolean }
  | { readonly action: 'add'; readonly patterns: ReadonlyArray<string>;
      readonly force?: boolean }
  | { readonly action: 'reapply'; readonly force?: boolean }
  | { readonly action: 'disable'; readonly force?: boolean };

export type SparseCheckoutResult =
  | { readonly kind: 'list'; readonly cone: boolean;
      readonly patterns: ReadonlyArray<string> }
  | { readonly kind: 'applied'; readonly cone: boolean;
      readonly materialized: number; readonly removed: number;
      readonly retained: ReadonlyArray<FilePath> };
```

Every action runs `assertRepository`, `assertNotBare`,
`assertNoPendingOperation` first (sparse checkout needs a worktree and a quiet
repo).

**Persistence ordering.** A mutating action computes its matcher in memory,
runs `applySparseCheckout` **first**, and only **after** a successful apply
persists the pattern file and config. A failed apply (e.g. `RESOURCE_LOCKED`)
thus leaves `.git` exactly as it was — no half-state where the patterns are
recorded but the working tree was never reshaped. `disable` is the mirror
image: apply (re-materialise everything) succeeds first, then
`core.sparseCheckout` flips to `false`.

- **`list`** — `core.sparseCheckout` falsy ⇒ `{ kind: 'list', cone: false,
  patterns: [] }`. Else parse the file: cone ⇒ `patterns = sort([...recursive])`
  (the directory list git's `list` prints in cone mode); non-cone ⇒ the raw
  pattern lines verbatim.
- **`set`** — `patterns` empty ⇒ `invalidOption`. The mode is `opts.cone ??
  current core.sparseCheckoutCone ?? true` (cone is git's modern default for a
  fresh enable). Cone mode: `patterns` are directories → `buildConeSpec` →
  `serializeCone`. Non-cone: `patterns` are raw patterns, validated against the
  budget — the on-disk file text is the patterns, one per line. The spec → `buildSparseMatcher` → `applySparseCheckout(ctx, {
  matcher, force })`; on success `writeSparsePatternText` then
  `updateCoreConfig` (`sparseCheckout = true`, `sparseCheckoutCone = mode ===
  'cone'`).
- **`add`** — `core.sparseCheckout` must already be true (git requires
  sparse-checkout enabled for `add`) — falsy ⇒ `invalidOption`. Read the
  existing file + cone config; build the combined spec (cone: extra
  directories folded into `R`; non-cone: extra lines appended);
  `applySparseCheckout` with the combined matcher; on success
  `writeSparsePatternText` of the combined file.
- **`reapply`** — `core.sparseCheckout` falsy ⇒ `invalidOption`. Re-build the
  matcher from the on-disk file (`loadSparseMatcher`), `applySparseCheckout`.
  No file/config change.
- **`disable`** — `applySparseCheckout(ctx, { matcher: undefined, force })`
  first (re-materialise everything, clear every bit); on success
  `updateCoreConfig(sparseCheckout = false)`. The pattern file is **kept** on
  disk (git keeps it), so a later `set` with no patterns can reuse it via
  `reapply`.

`set`/`add`/`reapply`/`disable` return `{ kind: 'applied', … }` carrying the
`ApplySparseCheckoutResult` counts. A non-empty `retained` is the caller's
signal that dirty files blocked their own exclusion.

## 11. `checkout` / `status` / `add --all` integration

### 11.1 `checkout`

`switchBranch` calls `loadSparseMatcher(ctx)` after resolving the target tree;
a defined matcher is passed as `materializeTree`'s `sparse` option (§8).
Path-restore mode (`checkout({ paths })`) is unchanged — restoring an explicit
path is an explicit request and is not sparse-filtered, matching git (`git
checkout -- <path>` on a skip-worktree path materialises it).

### 11.2 `status`

`classifyEntry` is skipped for any index entry with `skipWorktree: true` — a
skip-worktree file is *expected* absent; reporting it `deleted` would make a
sparse repo permanently "dirty". One guard at the top of `classifyEntry`:
`if (entry.flags.skipWorktree) return undefined;`. The entry **stays in**
`indexByPath` so pass 2's `!indexByPath.has(path)` untracked test still treats
the path as tracked (a user who manually re-creates an excluded file does not
get a spurious `untracked`). The untracked walk otherwise needs no change —
excluded directories are simply not on disk.

### 11.3 `add --all`

`addAll`'s post-walk removal pass marks any index entry not seen on disk as
`removed`. A skip-worktree entry is *legitimately* absent; staging its removal
would silently un-sparse it into a deletion. The fix: `if
(existingEntry.flags.skipWorktree) continue;` before `newEntries.delete(path)`
— the entry is preserved untouched. (`processWalkEntry` never sees these paths
— they are absent — so no other change is needed.)

`commit` needs **no** change: it builds the tree from the index, and
skip-worktree entries retain their `id` / `mode`, so the committed tree always
contains the full set of paths. This is the load-bearing reason the index must
keep every entry (§2).

## 12. Facade — `repository.ts`

`Repository` gains `readonly sparseCheckout: BindCtx<typeof
commands.sparseCheckout>`; the bound closure is added next to `reflog` with the
standard `guard()` prologue. The command is re-exported from
`application/commands/index.ts`; no `OpenRepositoryOptions` change — sparse
state lives entirely in `.git`.

## 13. Module / file layout

```
src/domain/git-index/
  index-entry.ts        MOD  — IndexEntryFlags reshape, STAGE0_FLAGS, version 2|3
  index-parser.ts       MOD  — v3 entries, extended flags
  index-writer.ts       MOD  — v3 selection, extended flags
  index.ts              MOD  — export STAGE0_FLAGS

src/domain/ignore/
  parse-gitignore.ts    MOD  — extract + export tokenizeIgnoreLine
  index.ts              MOD  — export tokenizeIgnoreLine

src/domain/sparse/      NEW
  sparse-pattern.ts     NEW  — SparseRule / SparseSpec / SparseMatcher types
  cone.ts               NEW  — buildConeSpec / coneMatcher / serializeCone / parseCone
  non-cone.ts           NEW  — compileSparseRule / nonConeMatcher
  parse-sparse-checkout.ts NEW — parseSparseCheckout + buildSparseMatcher
  index.ts              NEW  — barrel

src/domain/commands/error.ts   MOD  — SPARSE_PATTERN_FILE_TOO_LARGE + factory
src/domain/error.ts            MOD  — extractDetail arm
src/domain/index.ts            MOD  — re-export domain/sparse

src/application/primitives/
  path-layout.ts        MOD  — sparseCheckoutPath
  config-read.ts        MOD  — sparseCheckout / sparseCheckoutCone keys, invalidateConfigCache
  update-config.ts      NEW  — setCoreConfigEntry + updateCoreConfig
  read-sparse-checkout.ts  NEW — readSparsePatternText + loadSparseMatcher
  write-sparse-checkout.ts NEW — writeSparsePatternText
  apply-sparse-checkout.ts NEW — applySparseCheckout
  apply-changeset.ts    MOD  — export isWorkingTreeDirty
  materialize-tree.ts   MOD  — sparse predicate
  index.ts              MOD  — barrel exports for the new primitives

src/application/commands/
  sparse-checkout.ts    NEW  — the command
  checkout.ts           MOD  — loadSparseMatcher → materializeTree.sparse
  status.ts             MOD  — skip skip-worktree entries
  add.ts                MOD  — skip skip-worktree entries in removal pass
  index.ts              MOD  — export sparseCheckout

src/repository.ts       MOD  — bind repo.sparseCheckout

docs/adr/069..074       NEW
docs/plan/sparse-checkout.md  NEW
README.md RUNBOOK.md CONTRIBUTING.md DESIGN.md docs/BACKLOG.md   docs refresh
```

### Implementation slices (the plan derives its ordering from this)

1. **Index v3** — `index-entry.ts` / `index-parser.ts` / `index-writer.ts` +
   every `STAGE0_FLAGS` call-site migration. Self-contained; lands first.
2. **Sparse domain** — `domain/sparse/*`, `tokenizeIgnoreLine` extraction.
   Pure, parallelisable with slice 1.
3. **Config** — `config-read` keys, `update-config.ts`. Depends on nothing in
   1–2; parallelisable.
4. **Sparse primitives** — `path-layout`, `read/write-sparse-checkout`,
   `apply-sparse-checkout`, `isWorkingTreeDirty` export. Depends on 1+2+3.
5. **`materializeTree` sparse predicate.** Depends on 1+2.
6. **Command** — `sparse-checkout.ts`. Depends on 4.
7. **Integration** — `checkout` / `status` / `add`. Depends on 4+5.
8. **Facade + docs.** Depends on 6+7.

Each slice is one or more atomic conventional commits.

## 14. Testing strategy

Per `CLAUDE.md`: 100% line/branch/function/statement coverage, 0 surviving
mutants, Given/When/Then titles, AAA bodies, `sut`.

### Unit

- **Index v3** — parse a v3 fixture with a skip-worktree entry; round-trip
  (parse → serialize → parse) is identity; `chooseVersion` returns 2 with no
  extended entry, 3 with one; an `extended` bit in a v2-header index throws
  `INVALID_INDEX_ENTRY`; padding is correct for an extended entry (a
  `+1`-length path proves the 8-byte boundary); `intentToAdd` round-trips.
- **Cone** — `buildConeSpec` derives `R` / `P` (nested dirs, siblings, a dir
  that is both asked-for and an ancestor); `coneMatcher` in/out for root file,
  parent-dir direct file, parent-dir *sub*directory file (excluded),
  recursive-subtree file; `serializeCone` byte-exact against a git-written
  fixture; `parseCone` round-trips and returns `undefined` on a non-cone line.
- **Non-cone** — `compileSparseRule` recursive vs non-recursive per the §4.3
  table; `nonConeMatcher` last-match-wins, negation, the `/src/*`-direct-only
  case; `tokenizeIgnoreLine` comment/blank/escape/`!`//`/` arms.
- **`setCoreConfigEntry`** — replace an existing key; insert under an existing
  `[core]`; create `[core]` when absent; leave other sections, comments and
  key order intact; case-insensitive key match.
- **`applySparseCheckout`** — narrow (file removed, bit set); widen (file
  written, bit cleared); dirty excludee retained without `force`, removed with
  `force`; `matcher: undefined` re-materialises all; counts (`materialized` /
  `removed` / `retained`) exact via try/catch + `.data`-style direct
  assertions.
- **`materializeTree` sparse** — excluded target path yields a skip-worktree
  index entry and no file; a skip-worktree→included `noop` upgrades to a write;
  no-sparse call is unchanged.
- **`loadSparseMatcher`** — `core.sparseCheckout` falsy ⇒ `undefined`; cone vs
  non-cone dispatch; absent file ⇒ includes-nothing matcher; degraded cone
  file logs a warning.
- **`sparseCheckout` command** — every action; `set` cone vs non-cone; `add`
  before enable throws; `list` output shape per mode; `disable` keeps the
  file.
- **error** — `sparsePatternFileTooLarge` boundary (`limit + 1`);
  `extractDetail` arm.

### Integration (`test/integration/`)

- A full sparse lifecycle on the memory adapter: seed a multi-directory repo,
  `sparseCheckout set` (cone) → only in-cone files on disk, index has every
  entry, excluded entries are skip-worktree; `status` clean; `commit` after an
  in-cone edit produces a tree still containing the excluded paths; `checkout`
  to another branch keeps the cone; `reapply`; `disable` restores everything;
  `add --all` after `disable` does not phantom-remove.
- Non-cone lifecycle with `*.ts` / `!` patterns.
- A dirty excludee is retained across `set`; `force` overrides.
- **Interop** — an index written by tsgit with a skip-worktree entry is read
  back by canonical `git` (`git ls-files -t` shows the `S` flag); a
  `.git/info/sparse-checkout` written by tsgit is accepted by `git
  sparse-checkout reapply`.

### Mutation

Guard clauses get isolated per-condition tests — the `extended` /
`skipWorktree` / `intentToAdd` bit masks, the `chooseVersion` predicate, the
`coneMatcher` three-way `∨`, the dirty-pre-scan `force` branch, the
`skipWorktree` skips in `status` / `add`. The 1 MiB cap and the 256-byte /
2048-pattern budgets are pinned with boundary-length inputs.

## 15. Key design decisions → ADRs

| ADR | Decision |
|-----|----------|
| [069](../adr/069-skip-worktree-index-v3.md) | Sparse checkout is built on the **skip-worktree bit** via **index v3** extended flags. `IndexEntryFlags` drops the derived `extended` field and gains `skipWorktree` + `intentToAdd`; `serializeIndex` picks the minimum on-disk version. The "drop entries from the index" shortcut is rejected as non-faithful and data-loss-prone. |
| [070](../adr/070-cone-and-non-cone.md) | Both **cone and non-cone** modes ship. Cone is an O(1) directory-membership test; non-cone is a `.gitignore`-style last-match-wins matcher. A non-cone-shaped cone file degrades to non-cone matching, as git does. `/dir/*`-style wildcard-last patterns cover direct children only. |
| [071](../adr/071-sparse-command-shape.md) | `repo.sparseCheckout` exposes the **full git-parity** subcommand set — `list` / `set` / `add` / `reapply` / `disable` — as one discriminated-`action` tier-1 command. `set`/`add` inputs and `list` output are directories in cone mode, raw patterns in non-cone. |
| [072](../adr/072-sparse-dirty-file-policy.md) | When narrowing would delete a file with **uncommitted local modifications**, the file is **retained** (left on disk, skip-worktree *not* set) and surfaced in `result.retained`; `force: true` overrides. Faithful to git; never silently discards work. |
| [073](../adr/073-sparse-integration-scope.md) | 17.3 integrates sparse into **`checkout` / `status` / `add --all`**; **`reset` / `merge`** sparse-awareness was deferred to follow-up **17.3a** — since **delivered** (ADRs 075–076). `materializeTree` carried the `sparse` predicate so the follow-up was a wiring change, not a redesign. |
| [074](../adr/074-minimal-config-writer.md) | `.git/config` writes use **targeted `[core]` line surgery**, not a full INI re-render — preserving comments, ordering and unrelated sections. A general config writer is explicitly *not* built in 17.3. |

## 16. Risks & mitigations

- **Index format regression.** Every existing index is v2 and stays v2 —
  `chooseVersion` returns 2 unless an entry is skip-worktree, so
  `serializeIndex` output is byte-identical for the whole non-sparse corpus.
  The parser only *adds* v3 acceptance; v2 parsing is untouched. Round-trip
  and interop tests pin both.
- **Silent un-sparse via `reset --hard`.** Resolved in 17.3a — `reset` and
  `merge` are now sparse-aware (ADRs 075–076,
  `docs/design/sparse-reset-merge.md`).
- **Hand-edited cone file.** A user editing `.git/info/sparse-checkout` into a
  non-cone shape is handled by the cone→non-cone fallback (ADR-070) with a
  logged warning — never a crash, never a wrong materialization that looks
  right.
- **Dirty-file data loss.** The dirty pre-scan (ADR-072) means narrowing never
  deletes modified content without `force`. The pre-scan reuses the same
  hash-compare the `checkout` dirty guard already trusts.
- **Config-cache staleness after a write.** `updateCoreConfig` invalidates the
  per-`Context` `readConfig` cache; a later `loadSparseMatcher` in the same
  process re-reads. Without this a `set` followed by a `checkout` on the same
  `Repository` would miss the new gate.
- **Pattern-file / pattern DoS.** The 1 MiB file cap and the 256-byte /
  2048-pattern budgets bound parse cost and compiled-regex memory.
- **Concurrent `sparseCheckout` invocations.** The index lock serialises the
  working-tree apply, but `updateCoreConfig` is *not* lock-protected (tsgit has
  no `config.lock`; `bootstrap` writes config unlocked too) — two racing calls
  resolve last-writer-wins on `.git/config`. The pattern file write has the
  same window. A documented edge; a `config.lock` is a follow-up, not 17.3.
- **Breaking `IndexEntryFlags` / `GitIndex.version`.** A type-shape change to a
  domain export; 17.x targets v2.0, so a breaking domain change is in-window.
  No runtime migration — old indexes parse unchanged.
