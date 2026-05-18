# Phase 13.6 — Implementation plan

Derived from `docs/design/phase-13-6-source-index-synthesis.md`.
No new ADRs (no user-influenced design choices; the synthesis
algorithm is mechanical).

## Step order

### 1. `synthesizeTreeFromIndex` primitive

Signature:

```ts
// src/application/primitives/synthesize-tree-from-index.ts
export const synthesizeTreeFromIndex = async (
  ctx: Context,
  index: GitIndex,
): Promise<ObjectId>;
```

Algorithm (recursive group-by-prefix, see design §3.1):

1. Filter to stage-0 entries.
2. Recursively walk: at each level, split entries into
   `filesAtThisLevel` (no `/` in remaining path) and
   `byPrefix` (group by first segment).
3. For each prefix, recurse to get the subtree id; append a
   directory entry to this level's tree.
4. Append every file at this level.
5. `writeTree(ctx, entries)` — git's canonical sort handles
   ordering at the tree-format layer.

Files:

- `src/application/primitives/synthesize-tree-from-index.ts` (NEW)
- `src/application/primitives/index.ts` (extend barrel)
- `test/unit/application/primitives/synthesize-tree-from-index.test.ts` (NEW)
- `test/unit/application/primitives/index.test.ts` (extend barrel
  assertion)

Tests (per design §5.1):

- Empty index → empty-tree id (equals `writeTree(ctx, [])`).
- Single root-level file → one-entry tree.
- Nested paths `a.txt`, `dir/b.txt`, `dir/sub/c.txt` → 3-level
  nested tree, verified by walking the result.
- Stage-2 entries filtered out.
- Round-trip: seed a commit, read its index via `readIndex`,
  synthesise → assert the resulting tree id equals the commit's
  `data.tree`.

Commit: `feat(primitives): synthesizeTreeFromIndex`.

### 2. Wire `synthesizeTreeFromIndex` into `checkout.ts`

Replace the `source === 'index'` placeholder in
`resolvePathSource`:

```ts
// Before:
if (source === 'index') {
  // Placeholder for source === 'index': resolve to HEAD's tree.
  const head = await resolveRef(ctx, 'HEAD' as RefName);
  const headTree = await readTree(ctx, head);
  return headTree.id;
}

// After:
if (source === 'index') {
  const index = await readIndex(ctx);
  return synthesizeTreeFromIndex(ctx, index);
}
```

Drop the cross-link comment to BACKLOG §13.6 — the placeholder
is gone.

Files:

- `src/application/commands/checkout.ts` (one-block edit)
- `test/unit/application/commands/checkout.test.ts` (extend)

New test (per design §5.2):

- **Given a divergent index, When `checkout({ paths, source:
  'index' })`, Then disk content matches the staged content,
  not HEAD**. The acceptance test from the BACKLOG.

Commit: `feat(checkout): path-restore source 'index' uses staged content`.

### 3. Tick BACKLOG + docs

- `docs/BACKLOG.md` §13.6 `[ ]` → `[x]`.
- `README.md` — add 13.6 row in the phase table.
- `MIGRATION.md` — extend the existing checkout example to note
  that `source: 'index'` now restores from staged content.

Commit: `docs(backlog): tick §13.6 — checkout source 'index' uses staged content`.

## TDD discipline

Each step ends in:

1. `npm run check:types`
2. `npm run check` (biome)
3. `npm run test:unit -- <touched files>`
4. `npm run validate` (full gate)

## Risk gates

| Step | Likely failure mode | Mitigation |
|---|---|---|
| 1 | Recursive group-by-prefix mis-sorts entries between levels | `writeTree` calls `serializeTreeContent` → `sortTreeEntries` internally; we trust git's canonical sort |
| 1 | Empty input edge case throws | Explicit "empty index → empty tree" test |
| 1 | Stage-1/2/3 leak into the synthesised tree | Explicit stage-2-filter test |
| 1 | Round-trip diverges from canonical commit tree | Round-trip test (commit → readIndex → synthesise → equal commit.data.tree) — strongest mutation kill |
| 2 | Backwards-compat regression in path-restore from HEAD/ObjectId | They go through a different branch of `resolvePathSource`; existing tests stay green |
| 2 | `materializePathRestoreLockless` reads the index AGAIN via `materializeTree` | Acceptable (no lock held); documented in design §3.5 |
| 3 | BACKLOG line drifts | Tick in this PR's commits |

## Self-review log

### Pass 1 → Pass 2

- Step 1 originally proposed a single-pass FlatTree → nested Tree
  flatten via a helper that lives in `domain/merge` (since
  `FlatTree` lives there). Killed: tying the synthesis to the
  merge subsystem creates the wrong coupling. The synthesis is
  a `primitive` (Tier 2), not a domain operation; its job is
  recursive tree construction with side effects (object writes).
- Step 2 originally proposed plumbing the already-read index
  from `pathRestore` through `resolvePathSource`. Deferred per
  design §3.5 — would change `resolvePathSource`'s signature
  for marginal cost-savings.

### Pass 2 → Pass 3

- Added the round-trip test explicitly as the "strongest
  mutation kill". A flat tree is easy to corrupt subtly (lose
  a path, change a mode, mis-order); only a round-trip against
  a canonical commit catches that universally.
- Step 1 risk gate added for empty-index edge case — Stryker
  often mutates length checks.
- Step 2 risk gate added explicitly for the second `readIndex`
  call in `materializePathRestoreLockless` — pass-3 reviewers
  will ask why we don't plumb the index through; the answer
  lives in design §3.5 and now also here.
