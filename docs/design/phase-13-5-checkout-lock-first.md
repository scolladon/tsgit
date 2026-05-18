# Phase 13.5 — Tighten `checkout` to lock-first ordering

## 1. Goal

Close the known TOCTOU window between `readIndex` and
`acquireIndexLock` in `checkout`. The fix adopts the lock-first
ordering Phase 13.2 (`reset --mixed`) and Phase 13.3 (`reset
--hard`) already use:

```
acquire lock → readIndex → materialize → commit → release in finally
```

No new ADR — the lock-first decision was already made in Phase 13.2's
post-review hardening; this PR just converges checkout onto the
same shape.

BACKLOG §13.5 acceptance:

> `checkout` acquires the index lock BEFORE reading the index,
> matching `hardResetFromCommit` / `rebuildIndexFromCommit`. Add a
> pre-locked-index test asserting `RESOURCE_LOCKED`, mirroring
> Phase 13.3's test for the same behaviour.

## 2. Surface

No change. The fix is internal — `repo.checkout(...)` keeps its
existing public API.

## 3. Behaviour

### 3.1 Switch mode (`{ target }`)

Today (TOCTOU window):

```ts
const target = await readTree(ctx, oid);
const currentIndex = await readIndex(ctx);          // [A]
const materializeResult = await materializeTree(...);
if (writes > 0) {
  const lock = await acquireIndexLock(ctx);         // [B]
  try { await lock.commit(...) } finally { lock.release() }
}
```

Between `[A]` and `[B]`, a concurrent writer (another reset, add,
rm, commit) can rewrite the index. `materializeTree`'s donor-merge
in `mergeNewIndexEntries` uses stale donor stats; the commit then
overwrites the concurrent writer's index with the stale view.

After the fix:

```ts
const target = await readTree(ctx, oid);            // OK outside lock
                                                    // (objects are immutable)
const lock = await acquireIndexLock(ctx);
try {
  const currentIndex = await readIndex(ctx);
  const materializeResult = await materializeTree(...);
  if (writes > 0) await lock.commit(...);
} finally {
  await lock.release();
}
```

Notes:

- `readTree(ctx, oid)` stays OUTSIDE the lock — git objects are
  content-addressed and immutable, so reading them needs no lock.
- The lock now wraps the entire read-materialise-commit transaction
  for switch mode.
- For switch with no actual changes (e.g., already on target), the
  `lock.commit(...)` call is skipped but the lock is still
  acquired+released. The cost is one extra round-trip to the FS;
  canonical git does the same and the safety win is worth it.

### 3.2 Path-restore mode (`{ paths, source }`)

Two sub-cases:

- `source === 'index'`: we DO NOT commit the index. The lock is
  not needed. Path-restore-from-index reads the index as a snapshot
  and writes the working tree; if a concurrent writer mutates the
  index mid-flight, the operation still acts on the snapshot we
  read — well-defined, no corruption.
- `source !== 'index'` (i.e., `'HEAD'` or an `ObjectId`): we
  commit the index. Lock-first applies here, same as switch.

After the fix:

```ts
const targetTree = await resolvePathSource(ctx, source);
const pathSet = new Set(opts.paths.map((p) => p as FilePath));

if (source === 'index') {
  // No commit; no lock.
  const currentIndex = await readIndex(ctx);
  const materializeResult = await materializeTree(ctx, {
    targetTree, currentIndex, force: true, paths: pathSet,
  });
  ...
} else {
  const lock = await acquireIndexLock(ctx);
  try {
    const currentIndex = await readIndex(ctx);
    const materializeResult = await materializeTree(ctx, {
      targetTree, currentIndex, force: true, paths: pathSet,
    });
    if (writes > 0) await lock.commit(...);
  } finally {
    await lock.release();
  }
  ...
}
```

This adds a small branch but keeps the `source === 'index'` happy
path lock-free (which is the most common path-restore use case).

### 3.3 HEAD update

HEAD update stays OUTSIDE the lock, as in Phase 13.2/13.3. The
index lock and the HEAD lock are independent (HEAD writes use
their own atomic temp+rename).

## 4. Atomicity model

Same as Phase 13.2/13.3 §4:

- Index commit: atomic temp + rename via `acquireIndexLock.commit`.
- HEAD update: atomic via existing primitive.
- Crash between index commit and HEAD update: index ahead of HEAD,
  user re-runs checkout — recoverable.

The new invariant under this PR: `index.lock` is acquired BEFORE
any operation that reads or writes the index, for both switch and
path-restore-with-non-index source. Path-restore-from-index keeps
its lock-free shape because it doesn't write the index.

## 5. Module layout

```
src/application/
└── commands/
    └── checkout.ts                     # restructure switchBranch + pathRestore
test/unit/application/
└── commands/checkout.test.ts           # extend with lock-first tests
```

No new files. The wiring change is small (~25 lines net diff).

## 6. Testing strategy

### 6.1 Unit — `checkout.test.ts`

- **Given an index.lock already on disk, When switch checkout,
  Then throws RESOURCE_LOCKED**: pre-create `.git/index.lock` via
  `writeExclusive`, run `checkout({ target: 'feature' })`, expect
  the error code AND `resource: 'index'`. Pins the lock-first
  ordering.
- **Given an index.lock already on disk, When path-restore from
  HEAD, Then throws RESOURCE_LOCKED**: same fixture, but path-
  restore with `source: 'HEAD'`. Pins lock-first for the non-index
  source branch.
- **Given an index.lock already on disk, When path-restore from
  the index (default), Then succeeds (no lock acquired)**: same
  fixture, but `repo.checkout({ paths: [...] })` (default source =
  'index'). Pins that we did NOT regress to "always acquire".

All existing checkout tests must continue to pass — the refactor
must not change observable behaviour for any clean-state checkout.

### 6.2 Mutation

Stryker on `src/application/commands/checkout.ts`. Target:
- No NEW survivors introduced by this PR.
- Pre-existing Phase 13.1 survivors stay out of scope (per the
  established project policy of "broad mutant chase after v2").

## 7. Out of scope

- Other commands' lock ordering (e.g., `merge`, `rm` — those will
  be audited separately when they grow lock-acquiring paths).
- The `source === 'index'` lock-free choice is deliberate; making
  it always-acquire would be needless serialisation for the common
  case. Captured as a design note here rather than as a separate
  ADR.

## 8. Open questions

- **Q1: Should `readTree` move inside the lock?** No. Git objects
  are immutable and content-addressed; reading them is safe under
  any concurrency model. Keeping `readTree` outside the lock
  avoids needlessly serialising tree reads against other index
  operations.
- **Q2: Should we still skip the commit when `writes === 0 &&
  deleted === 0`?** Yes. The `lock.commit(...)` call is itself an
  fsync + rename round-trip; skipping it for no-op checkouts is a
  cheap win and matches canonical git's behaviour.

## 9. Self-review log

### Pass 1 → Pass 2

- Originally proposed always-acquiring the lock for path-restore
  regardless of source. Killed: source === 'index' never commits,
  so the lock would be pure overhead. Split into two branches
  matching the actual commit behaviour.
- Added Q1 explicitly because reviewers will ask why `readTree`
  isn't moved inside the lock too.

### Pass 2 → Pass 3

- §3.1 clarified that the "no-op checkout" case still acquires
  the lock. Reviewers might think we'd skip — explicit note
  prevents that question.
- §6.1 added the source==='index' "no lock acquired" test
  explicitly. Without it, a future refactor could accidentally
  introduce always-acquire and we'd regress the path-restore-from-
  index UX.
- §7 explicitly notes other commands are out of scope. The lock-
  first pattern likely belongs in `add`, `rm`, `commit` too, but
  those are separate audits with their own concurrency questions.
