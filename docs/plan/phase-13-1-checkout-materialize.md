# Phase 13.1 — Implementation plan

Derived from `docs/design/phase-13-1-checkout-materialize.md` +
ADR-018 / 019 / 020. Each step is its own TDD red → green → refactor
cycle ending in `npm run validate` green before commit.

## Step order

### 1. Reuse existing error codes (no domain change)

Inspection of `src/domain/commands/error.ts` shows the codes we need
already exist:

- `CHECKOUT_OVERWRITE_DIRTY` (`paths: ReadonlyArray<FilePath>`) —
  used for both tracked-dirty AND untracked-collision in v1; one
  error per checkout aggregates every offending path.
- `PATHSPEC_NO_MATCH` (`pattern: string`) — for path-restore misses.

Step skipped. Design doc and ADRs reference these existing codes.

### 2. `compute-changeset` primitive (PURE)

Signature:

```ts
interface ChangesetEntry {
  readonly kind: 'add' | 'update' | 'delete' | 'noop';
  readonly path: FilePath;
  readonly mode: FileMode;             // target mode (for delete: index mode)
  readonly id: ObjectId | undefined;   // target oid (for delete: undefined)
  readonly previousId: ObjectId | undefined; // index oid (for add: undefined)
  readonly previousMode: FileMode | undefined;
}

interface Changeset {
  readonly entries: ReadonlyArray<ChangesetEntry>;
  readonly stats: { add: number; update: number; delete: number; noop: number };
}

export const computeChangeset = (
  currentIndex: GitIndex,
  targetTree: ReadonlyArray<{ path: FilePath; id: ObjectId; mode: FileMode }>,
): Changeset;
```

Pure: no FS, no ctx. Easy to table-test.

Files:
- `src/application/primitives/compute-changeset.ts`
- `test/unit/application/primitives/compute-changeset.test.ts`

Tests cover every kind tuple: add/update/delete/noop × regular/exec/
symlink/gitlink. Mode-only changes are `update` (no oid change).

Commit: `feat(primitives): computeChangeset`.

### 3. `apply-changeset` primitive (IMPURE)

Signature:

```ts
interface ApplyChangesetOpts {
  readonly changeset: Changeset;
  readonly force: boolean;
  readonly workdir: string;            // ctx.layout.workdir
}

interface ApplyChangesetResult {
  readonly writtenEntries: ReadonlyArray<IndexEntry>;  // ready to commit to index
  readonly stats: { written: number; deleted: number };
}

export const applyChangeset = async (
  ctx: Context,
  opts: ApplyChangesetOpts,
): Promise<ApplyChangesetResult>;
```

Internally:
- Run the dirty-tree guard (§3.3 of design) — collect dirty paths,
  collect untracked-collision paths, throw if either non-empty
  unless `force`.
- For each entry (add/update/delete) emit per-path progress.
- For each delete: `fs.rm(path)`; opportunistic `fs.rm` on parent
  dirs that become empty.
- For each add/update: write file/symlink/gitlink-dir per FileMode
  semantics; `lstat` the result; build an `IndexEntry`.
- Return new index entries (caller commits them).

Files:
- `src/application/primitives/apply-changeset.ts`
- `test/unit/application/primitives/apply-changeset.test.ts`

Tests use the memory adapter. Cover regular/exec/symlink/gitlink
writes, deletes, dirty-tree rejection, untracked-collision
rejection, `force` overrides, and per-path progress ticks.

Commit: `feat(primitives): applyChangeset`.

### 4. `materialize-tree` primitive (composes 2 + 3)

Signature:

```ts
interface MaterializeTreeOpts {
  readonly targetTree: ObjectId;
  readonly currentIndex: GitIndex;
  readonly force?: boolean;
  readonly paths?: ReadonlySet<FilePath>;
}

interface MaterializeTreeResult {
  readonly newIndexEntries: ReadonlyArray<IndexEntry>;
  readonly written: number;
  readonly deleted: number;
}

export const materializeTree = async (
  ctx: Context,
  opts: MaterializeTreeOpts,
): Promise<MaterializeTreeResult>;
```

1. Walk `targetTree` via existing `walkTree` primitive into a flat
   list of `{ path, id, mode }`.
2. If `paths` provided, filter target list to those paths AND
   filter current index to those paths.
3. `computeChangeset(index, targetList)`.
4. `applyChangeset(ctx, { changeset, force, workdir })`.
5. Return result.

Files:
- `src/application/primitives/materialize-tree.ts`
- `test/unit/application/primitives/materialize-tree.test.ts`

Tests integrate the two prior steps end-to-end on the memory adapter
with a hand-assembled tree + index.

Commit: `feat(primitives): materializeTree`.

### 5. Rewrite `checkout` command

Extend `CheckoutOptions` per ADR-020. Dispatch:

- `paths` present + `target` present → `INVALID_OPTION`
- `paths` present + empty → `INVALID_OPTION`
- `target` absent + `paths` absent → `INVALID_OPTION`
- `paths` present → path-restore branch (does not touch HEAD)
- `target` present → switch branch (existing HEAD move + new
  materialize step)

Switch branch flow:

1. Resolve target → oid + branch ref.
2. Read current index.
3. Read target commit's tree.
4. `materializeTree(ctx, { targetTree, currentIndex, force })`.
5. Acquire `index.lock`, commit new entries, release.
6. Move HEAD (existing logic).
7. Return `{ branch, id, detached, changedPaths }`.

Path-restore flow:

1. Resolve source (default `'index'`, else `HEAD` or ObjectId).
2. Build a "target tree" subset from the resolved source.
3. Read current index.
4. `materializeTree(ctx, { targetTree: <source>, currentIndex, force: true, paths: Set(paths) })`.
5. If source !== 'index', commit touched index entries; else skip
   the index commit.
6. HEAD untouched.
7. Return result.

Files:
- `src/application/commands/checkout.ts` (rewrite)
- `src/repository.ts` (export new types)
- `test/unit/application/commands/checkout.test.ts` (extend)
- `test/unit/repository/repository.test.ts` (signature smoke if needed)

Commit: `feat(checkout): materialize working tree on switch + path-restore`.

### 6. Integration test

End-to-end against `test/fixtures/clone-source/source.git` plus a
synthetic worktree. For each of the 5 commits in the fixture chain:
- Clone (already known to work).
- `repo.checkout({ target: <branch | oid> })`.
- For every file in the target tree: compare on-disk bytes to
  `git cat-file blob <oid>` from the reference repo.
- `repo.status()` reports `clean: true`.

Files:
- `test/integration/checkout-materialize.test.ts`

Skip on Stryker / missing git binary (same gates as the existing
clone integration test).

Commit: `test(integration): checkout materialise against fixture`.

### 7. Docs

- `docs/BACKLOG.md` §13.1 `[ ]` → `[x]`.
- `README.md` phase table row, "Working-tree materialization
  (`checkout`) lands in Phase 13.1 — …" line.
- `MIGRATION.md` `repo.checkout` example showing new `paths` mode +
  result fields.

Commit: `docs(backlog): tick §13.1 — checkout materialise`.

## TDD discipline

Each step ends in:

1. `npm run check:types`
2. `npm run check` (biome)
3. `npm run test:unit -- <touched files>`
4. `npm run validate` (full gate)

Commits are atomic per step. If a step's review surfaces an issue,
fix it in a follow-up commit on the same branch — no rebasing
public history.

## Risk gates

| Step | Likely failure mode | Mitigation |
|---|---|---|
| 1 | New discriminants miss the right narrowing site | Run `tsc` after the add; types catch the omission |
| 2 | Mode-only updates classified as noop | Explicit test for `mode A → mode B, same oid` → `update` |
| 3 | Memory adapter doesn't record exec bit | Verify `chmod` is recorded in `lstat().mode`; if not, assert via the test double's internal state |
| 3 | rm on non-empty dirs throws | Use `rmRecursive` with care, or skip parent-dir cleanup when contents remain |
| 4 | `walkTree` enumerates in an order that desyncs from index entries | Sort both sides by path before computing diff |
| 5 | Backwards-compat regression: `{ target }` callers break | The existing 5 tests in checkout.test.ts stay green; that is the gate |
| 6 | Real fixture has CRLF or executable bits on platforms where memory adapter doesn't model them | Skip the integration test on Windows (already established gate) |

## Self-review log

### Pass 1 → Pass 2

- Originally proposed writing the integration test first. Re-ordered:
  primitives first (with memory-adapter tests), then the integration
  test as the final assurance against a real fixture. Otherwise
  failing primitives surface as integration-test errors that are
  harder to diagnose.
- Split apply-changeset out of materialize-tree so the impure FS
  side is testable without re-deriving the changeset every test.

### Pass 2 → Pass 3

- Added the `INVALID_OPTION` validation tests at step 5; without
  them the runtime guards have no coverage and Stryker will surface
  surviving mutants.
- Added "sort both sides by path" to step 4's risk-gates — the
  changeset's correctness relies on aligned iteration order.
- Pushed the index commit into the command layer (step 5), not into
  `materializeTree`. Rationale: path-restore with `source === 'index'`
  must NOT commit the index, but the primitive doesn't know that
  context. Caller decides.
