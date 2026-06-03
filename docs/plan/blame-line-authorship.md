# Plan — `blame` (line-by-line authorship)

Implements `docs/design/blame-line-authorship.md` (ADRs 257–258). TDD per slice,
one atomic commit per slice, `npm run validate` green before each commit. Source
carries no phase/ADR refs.

## Module map

```
src/domain/blame/
  types.ts              # BlameEntry (pure scoreboard entry)
  split-blame.ts        # splitAgainstParent(entries, lineDiff) — pure core
  priority-queue.ts     # date-ordered origin queue (enqueue/precedes)
  index.ts              # barrel
src/application/commands/
  blame.ts              # Tier-1 orchestration + public types
src/application/commands/index.ts   # re-export
src/repository.ts                   # repo.blame binding + Repository type
test/unit/domain/blame/
  split-blame.test.ts
  split-blame.properties.test.ts
  arbitraries.ts
  priority-queue.test.ts
test/unit/application/commands/blame.test.ts
test/integration/blame-interop.test.ts
```

---

## Slice 1 — `domain/blame` pure core: `splitAgainstParent`

**Types** (`types.ts`):

```ts
export interface BlameEntry {
  readonly finalStart: number;   // 0-based line in the queried file
  readonly count: number;        // run length
  readonly sourceStart: number;  // 0-based line in the suspect blob
}
```

**Function** (`split-blame.ts`):

```ts
export const splitAgainstParent = (
  entries: ReadonlyArray<BlameEntry>,
  lineDiff: LineDiff,             // diffLines(parentBlob, childBlob): ours=parent, theirs=child
): { readonly passed: ReadonlyArray<BlameEntry>; readonly kept: ReadonlyArray<BlameEntry> }
```

Algorithm: build a child-line → parent-line map from `common` hunks
(`theirs` index → `ours` index, equal length). Walk each entry's child range
`[sourceStart, sourceStart + count)`; maximal sub-runs that map to consecutive
parent lines become `passed` entries (`sourceStart` = parent line, `finalStart`
shifted by the same offset, preserving `finalStart`/`count` invariants); child
lines not in any `common` hunk (`theirs-only`) become `kept` entries (unchanged
`sourceStart`/`finalStart`). Adjacent passed lines with contiguous parent
numbering coalesce into one entry; a discontinuity splits.

**Red** (`split-blame.test.ts`) — write first, run `npx vitest run`, must fail
(module absent). GWT/AAA, `sut`:
- Given all-`common` diff, When split, Then everything passed, nothing kept,
  `sourceStart` shifted by the hunk offset.
- Given a diff with a leading `theirs-only` hunk (lines added by child), When
  split, Then those lines are kept; trailing common lines passed.
- Given an entry spanning a common→theirs-only boundary, When split, Then it
  splits into one passed + one kept entry, `finalStart` preserved on each.
- Given a parent insertion (`ours-only`) shifting later common lines, When split,
  Then passed `sourceStart` reflects the parent numbering (offset ≠ 0).
- Given multiple entries, When split, Then each is processed independently.
- Given empty `entries`, When split, Then `{ passed: [], kept: [] }`.
- Given a `degraded` diff (no common hunk), When split, Then all kept, none
  passed.

**Green**: implement. **Refactor**: extract the child→parent map builder; keep
functions <20 lines, early returns.

`npm run validate` → commit `feat(blame): pure splitAgainstParent core`.

---

## Slice 2 — property tests for the pure core

`arbitraries.ts`: a generator producing `(parentLines, childLines)` pairs and the
real `diffLines` over them, plus a partition of the child lines into `BlameEntry`
runs. `split-blame.properties.test.ts` (`numRuns` 100):

- **Conservation**: `Σ passed.count + Σ kept.count === Σ entries.count` (no line
  lost or duplicated).
- **Final-range partition**: the union of all output entries' final ranges equals
  the input entries' final ranges (every final line accounted for exactly once).
- **Identity**: an all-equal `(x, x)` diff passes every entry, keeps none, with
  `sourceStart` unchanged.
- **Annihilator**: a disjoint `(x, y)` with no shared line keeps every entry,
  passes none.

`npm run validate` → commit `test(blame): property tests for splitAgainstParent`.

---

## Slice 3 — `domain/blame/priority-queue` (date-ordered origins)

Pure origin queue mirroring `describe`'s `enqueue`/`precedes` (date desc, oid
asc tie-break), generalized to carry an opaque payload:

```ts
export interface QueueEntry<T> { readonly oid: ObjectId; readonly date: number; readonly value: T }
export const enqueue = <T>(queue: QueueEntry<T>[], entry: QueueEntry<T>): void
export const precedes = (a: { date: number; oid: ObjectId }, b: { date: number; oid: ObjectId }): boolean
```

**Red** (`priority-queue.test.ts`): newest-date-first ordering; equal-date oid
tie-break (ascending); stable insertion at the correct position; single-element
and empty cases.

**Green** + **Refactor**. `npm run validate` → commit
`feat(blame): date-ordered priority queue`.

---

## Slice 4 — command `blame`: linear history core

`application/commands/blame.ts` — public types (`BlameOptions`, `BlameResult`,
`BlameLine`) per ADR-257, plus the orchestration for the **single-parent** path
(merges/renames/range in later slices).

Driver (see design §4):
- `assertRepository`; resolve `opts.rev ?? 'HEAD'` via `resolveCommitIsh`;
  `FilePath.from(path)`.
- Resolve the path's blob in the start commit's flattened tree; `pathNotInTree`
  if absent. Seed one entry covering all `N` lines.
- Maintain a `Map<originKey, OriginState>` (commit, path, accumulated entries) +
  the priority queue; pop newest, read the commit, read its blob, diff against
  its single parent (`diffLines(parentBlob, childBlob)`), `splitAgainstParent`,
  pass `kept`-remaining to finalization, enqueue/merge passed entries on the
  parent origin, re-enqueue on late arrival.
- Finalize: build `BlameLine`s with `author`/`committer`/`summary`
  (`subjectLine(message)`)/`boundary` (`parents.length === 0`)/`sourcePath`/
  `previous` (first parent holding the file) and `content` from the suspect's
  split lines; `finalLine`/`sourceLine` 1-based.
- Sort finalized by `finalLine`; return `{ path, lines }`.

Cache commit reads and per-(commit,path) blob reads.

**Red** (`blame.test.ts`, memory adapter — build commits with
`createMemoryContext` + `init`/`add`/`commit` and an explicit
`ident(timestamp)`, the `describe.test.ts` fixture pattern, for deterministic
dates): linear two-commit history (modify line 2, append line 4) → correct
per-line commit, original vs final numbering; prepend shift → surviving lines
keep `sourceLine`, gain new `finalLine`; root commit `boundary: true`, no
`previous`; non-root has `previous`; empty file → `lines: []`; missing path →
`PATH_NOT_IN_TREE` (assert `.data.code` + path); path naming a tree → refusal.

**Green** + **Refactor** (extract the walk driver to
`commands/internal/blame-walk.ts` if `blame.ts` exceeds the file/function size
budget; keep the pure pieces in `domain/blame`).

`npm run validate` → commit `feat(blame): line authorship over linear history`.

---

## Slice 5 — merge handling (all-parents attribution)

Generalize the single-parent pass to iterate **all** parents in order: thread
`remaining` through each parent (`passed` → that parent origin, `kept` continues
to the next parent); whatever survives all parents finalizes to the merge. First
parent that holds the file sets `previous`.

**Red**: the design §1.3 merge scenario — `side` changes line 2, `main` changes
line 3, merge resolves to both; assert line 2 → side, line 3 → main, the merge
commit blames **no** line. A line-added-only-in-merge case (differs from all
parents → blamed to the merge). A **clock-skew** case (a parent committed with a
*newer* timestamp than its child) exercising the origin re-enqueue path (design
§4.1) — assert no line is dropped and attribution still matches git's date-order
heuristic.

**Green** + **Refactor**. `npm run validate` → commit
`feat(blame): all-parents merge attribution`.

---

## Slice 6 — whole-file rename following

When the path is absent in a parent's tree, run
`diffTrees(parentTree, childTree, { recursive: true, detectRenames: true })`,
find the `rename` whose `newPath === currentPath`, and continue under `oldPath`
(the parent origin's path becomes `oldPath`, `sourcePath` on finalized lines
reflects the originating name). Reuses the exact-content detector (design §6
boundary: rename-with-edit not followed).

**Red**: `git mv`-style pure rename (c1 → c2 edits → c3 renames); blame the new
name → surviving lines attributed to c1/c2 with `sourcePath` = the old name;
`previous.path` reflects the pre-rename name across the rename boundary.

**Green** + **Refactor**. `npm run validate` → commit
`feat(blame): follow whole-file renames`.

---

## Slice 7 — `-L` range selector

Add `BlameOptions.range = { start, end }` (1-based inclusive). After finalization
+ sort, filter `lines` to `start ≤ finalLine ≤ end`. Validate: `start ≥ 1`,
`end ≤ N`, `start ≤ end`, integers → else `invalidOption('-L', <reason>)`.

**Red**: range over a multi-commit file returns only in-range lines (correct
`finalLine`s, authorship preserved); inverted range refuses; out-of-range
(`end > N`, `start < 1`) refuses; `start === end` single line; full-file range
≡ no range. Assert `.data.code === 'INVALID_OPTION'` + reason.

**Green** + **Refactor**. `npm run validate` → commit
`feat(blame): -L line-range selector`.

---

## Slice 8 — facade + barrel wiring

- `commands/index.ts`: export `BlameOptions`, `BlameResult`, `BlameLine`, `blame`.
- `repository.ts`: add `readonly blame: BindCtx<typeof commands.blame>` to
  `Repository`; bind `blame: ((path, blameOpts) => { guard(); return
  commands.blame(ctx, path, blameOpts); })`.
- Regenerate `reports/api.json` (the `check:doc-typedoc` generator writes it) and
  commit it — the prepush gate requires the committed report when a public export
  is added; the large typedoc-id diff is expected.

**Red**: a repository/api-surface unit test asserting `repo.blame` is bound and
returns the expected shape on a small in-memory repo (mirror existing
`repository` unit tests).

**Green** + **Refactor**. `npm run validate` → commit
`feat(blame): expose repo.blame on the facade`.

---

## Slice 9 — cross-tool interop

`test/integration/blame-interop.test.ts` (mirror `describe-interop`): build repos
with real `git` (scrubbed `GIT_*`, signing off, deterministic dates) in a shared
`beforeAll`; reconstruct `git blame --porcelain` from the structured
`BlameResult` (group consecutive same-`commit` lines; emit the metadata block on
first occurrence; `<commit> <sourceLine> <finalLine> <count>`; `previous`,
`filename` = `sourcePath`, `boundary`, identities); assert byte-equal to real
`git blame <rev> --porcelain`. Cases: linear, prepend-shift, non-trivial merge,
pure rename, `-L` range. `GIT_AVAILABLE`-gated like the other interop suites.

`npm run validate` → commit `test(blame): cross-tool porcelain interop`.

---

## Validation checkpoints

- Every slice: `npm run validate` green before commit; never `--no-verify`; no
  ignore directives.
- After slice 9: full review ×3 (typescript / security / tests) → architecture
  refactor + scoped re-review → mutation (0 killable) → docs + backlog flip + PR.
- Coverage 100% on touched domain/command files; property + interop additive to
  example tests, never replacing them.
