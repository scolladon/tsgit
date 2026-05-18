# Phase 13.2 — Implementation plan

Derived from `docs/design/phase-13-2-reset-mixed.md` + ADR-021
(stat-cache donor) + ADR-022 (pathspec deferred to 14.2). Each step
is its own TDD red → green → refactor cycle ending in
`npm run validate` green before commit.

## Step order

### 1. `buildIndexFromTree` primitive (PURE w.r.t. working tree)

Signature:

```ts
// src/application/primitives/build-index-from-tree.ts
export interface BuildIndexFromTreeOpts {
  readonly targetTree: ObjectId;
  readonly currentIndex: GitIndex;
}

export const buildIndexFromTree = async (
  ctx: Context,
  opts: BuildIndexFromTreeOpts,
): Promise<ReadonlyArray<IndexEntry>>;
```

Internals:

1. Build the donor map from `currentIndex` — `path → IndexEntry`,
   filtered to `flags.stage === 0`.
2. Walk the target tree via existing `walkTree(ctx, targetTree)`.
   Skip `FILE_MODE.DIRECTORY` (gitlink, symlink, regular, executable
   are kept).
3. For each `{ path, id, mode }`:
   - If donor has same `path` + `id` + `mode` → clone the donor's
     entry (preserve stat cache); force `flags.stage = 0`.
   - Else → emit a new entry with zero stat fields and `flags.stage
     = 0`, `flags.assumeValid = false`, `flags.extended = false`.
4. Sort by path ascending (byte-order, same comparator as
   `materialize-tree.ts`'s merge).
5. Return.

Files:

- `src/application/primitives/build-index-from-tree.ts` (NEW)
- `src/application/primitives/index.ts` (extend barrel)
- `test/unit/application/primitives/build-index-from-tree.test.ts` (NEW)
- `test/unit/application/primitives/index.test.ts` (extend barrel
  assertion)

Tests cover (each Given/When/Then, AAA body, sut variable):

- Empty target tree → empty array.
- Single regular file → one entry, zero stats (no donor).
- Single regular file with matching donor → entry has donor's stats
  preserved.
- Mode change (regular → executable, same id) → no donor match →
  zero stats.
- Id change (same path + mode, different id) → no donor match →
  zero stats.
- Donor with stage > 0 → ignored, treated as no donor.
- Donor in prior index without a matching tree entry → dropped from
  result.
- Nested tree → flat list of leaves, no `DIRECTORY` rows.
- Sort order assertion (give a tree whose `walkTree` order differs
  from sorted output and confirm result is sorted).

Commit: `feat(primitives): buildIndexFromTree`.

### 2. Wire `reset --mixed` to call the primitive

Refactor `src/application/commands/reset.ts`:

1. Resolve target oid (existing).
2. Read HEAD raw (existing).
3. **If `mode === 'mixed'`**:
   - `readObject(ctx, target oid)` → commit object; extract `treeId`.
   - `readIndex(ctx)` → `currentIndex`.
   - `buildIndexFromTree(ctx, { targetTree: treeId, currentIndex })`.
   - `acquireIndexLock(ctx)` → `commit(entries)` → `release` (in
     `finally`, same pattern as Phase 13.1's checkout).
4. Move HEAD (existing — soft path is reused for all modes).
5. Return result.

Files:

- `src/application/commands/reset.ts` (extend)
- `test/unit/application/commands/reset.test.ts` (extend)

New tests:

- **Given two commits with different files, When mixed reset to
  parent, Then index matches parent's tree** — after the reset,
  `readIndex(ctx)` returns one entry (the commit-1 file), zero
  entries for the commit-2 file.
- **Given mixed reset to parent, When reset, Then working tree
  unchanged** — both files still exist on disk with the post-
  commit-2 content.
- **Given mixed reset to current HEAD, When reset, Then stat-cache
  preserved** — donor index entry's stat fields equal the pre-reset
  entry's stat fields (no fresh zeros).
- **Given mixed reset on a bare repo, When reset, Then succeeds** —
  no `BARE_REPOSITORY` thrown for mixed mode.

Commit: `feat(reset): mixed mode rebuilds index from target tree`.

### 3. Tick BACKLOG + docs refresh

- `docs/BACKLOG.md` §13.2 `[ ]` → `[x]` with accepted-on summary.
- `README.md`: add the 13.2 row in the phase table; update the
  Phase 12.1 caveat ("To materialise the working tree, run
  `repo.checkout({ target })` …") to mention that `reset --mixed`
  now rebuilds the index too.
- `MIGRATION.md`: add the new mixed-reset example.
- `cspell.json`: vocab if any new words show up.

Commit: `docs(backlog): tick §13.2 — reset --mixed rebuilds index`.

## TDD discipline

Each step ends in:

1. `npm run check:types`
2. `npm run check` (biome)
3. `npm run test:unit -- <touched files>`
4. `npm run validate` (full gate)

Commits are atomic per step. If a step's review surfaces an issue,
fix it as a follow-up commit on the same branch — no rebasing
public history.

## Risk gates

| Step | Likely failure mode | Mitigation |
|---|---|---|
| 1 | Donor match too loose (id-only) | Explicit test for mode-flip-same-id → no donor |
| 1 | Stage-> 0 leak from a stage-1/2/3 donor | Explicit test for unmerged donor → ignored |
| 1 | `walkTree` emits `DIRECTORY` rows and we leak them into the index | Explicit test asserting no DIRECTORY entries; rely on existing `walkTree`'s `mode !== DIRECTORY` filter |
| 1 | Sort order off (lexicographic vs byte) | Sort with same comparator as `materialize-tree.ts` for consistency |
| 2 | Lock not released on throw | Use `try/finally` exactly like Phase 13.1's checkout |
| 2 | HEAD moves before index commit (wrong order for crash recovery) | Index commit BEFORE HEAD update (matches §4 of design) |
| 2 | Bare-repo guard mistakenly added | No `assertNotBare` call for mixed mode |
| 2 | Backwards-compat regression: existing 7 reset tests fail | They all hit `soft` / `hard` paths or the resolve-target paths — unchanged behaviour, gate stays green |
| 3 | BACKLOG line drifts from PR | Tick lives inside this PR's commits (per CLAUDE.md workflow §8) |

## Self-review log

### Pass 1 → Pass 2

- Originally bundled the primitive + the wiring into one commit.
  Split: primitive ships standalone (testable in isolation), then
  one commit wires it in. Easier to review, easier to revert.
- Originally proposed reading the working tree to populate stat
  fields. Killed at design time (ADR-021); reflected in step 1 now
  — the primitive takes only `ctx` for object reads, no working-
  tree I/O.
- Step 3 (docs) gained an explicit README caveat update because
  Phase 13.1's caveat is in the same paragraph that 13.2 now
  invalidates.

### Pass 2 → Pass 3

- Added "stage > 0 donor → ignored" to step 1 risk gates and tests.
  Mutation testing on Phase 13.1 surfaced exactly this kind of
  guard as a high-survival mutant; cover it explicitly here.
- Added "no DIRECTORY rows" to step 1 risk gates. The existing
  `walkTree` already filters internally, but our `buildIndexFromTree`
  should not depend on that — an explicit per-entry mode check
  protects against a future `walkTree` change.
- Clarified step 2: the index commit MUST happen before the HEAD
  move. Phase 13.1 already established this ordering; 13.2 needs
  the same.

### Pass 3 → Pass 4 (final pass)

- Step 1's test list now exercises both "donor present but stale"
  (id differs) and "donor present but wrong mode". Catches the
  most plausible mutation — collapsing the donor predicate to
  just `id === id`.
- Step 2 explicitly notes the existing soft-mode HEAD-move path
  is reused. No code duplication; no new HEAD-write call sites.
