# Phase 13.3 — `reset --hard`

## 1. Goal

Make `repo.reset({ mode: 'hard', target })` actually rewrite the
working tree AND the index to match the target commit's tree —
finishing what Phase 13.1 (`materializeTree`) and Phase 13.2
(`buildIndexFromTree`) set up. Today `mode: 'hard'` only moves
HEAD; the README acknowledges the gap.

BACKLOG §13.3 acceptance:

> `reset --hard`: invoke 13.1's materialize routine.

So the work is **composition**, not new primitives. We already have:

- `materializeTree(ctx, { targetTree, currentIndex, force })` —
  writes / deletes / chmods every file in the working tree, with
  per-path progress (Phase 13.1, ADR-018).
- `buildIndexFromTree` — projects a target tree onto an
  IndexEntry list (Phase 13.2, ADR-021).

For `reset --hard`, `materializeTree` is the right primitive: the
working tree gets rewritten, and the primitive's `newIndexEntries`
output carries **post-write lstat fields** (the canonically correct
stat cache for the freshly-written files). `buildIndexFromTree`'s
donor strategy is irrelevant here — every path's content has just
been rewritten, so donor stats would be stale.

## 2. Surface

### 2.1 Existing (preserved)

```ts
export type ResetMode = 'soft' | 'mixed' | 'hard';

export interface ResetOptions {
  readonly mode: ResetMode;
  readonly target: string;
}

export interface ResetResult {
  readonly mode: ResetMode;
  readonly id: ObjectId;
  readonly branch: RefName | undefined;
}
```

No public shape change. `mode: 'hard'` was already exported; only
the side effect changes. No new option (canonical `git reset --hard`
already implies force; there is no softer variant to add).

### 2.2 No new primitive

Phase 13.3 is wiring only. The existing primitives compose cleanly.

## 3. Behaviour

### 3.1 The reset --hard flow

1. `assertRepository`, `assertNotBare(ctx, 'reset --hard')`,
   `assertNoPendingOperation` — already there. Bare repos cannot
   have a working tree, so hard reset still rejects them.
2. Resolve `target` to an `ObjectId` — already there.
3. `readObject` → assert type === `'commit'`. Same guard as Phase
   13.2's mixed path.
4. **Acquire `index.lock`** BEFORE touching the working tree or
   reading the index. Holding the lock across the working-tree
   materialise keeps a concurrent writer (another reset, add, rm,
   commit) from racing the index between materialise and commit.
   This matches Phase 13.2's tightened ordering (post-pass-1 of
   the reset --mixed reviews).
5. **Inside the lock:**
   - `readIndex(ctx)` — the donor side of the diff.
   - `materializeTree(ctx, { targetTree, currentIndex, force: true })`
     — writes / deletes / chmods every file. `force: true` is
     mandatory: hard reset is the explicit-overwrite operation, and
     the dirty-tree guard would refuse to clobber local changes the
     user is asking us to discard. Returns
     `{ newIndexEntries, written, deleted }`.
   - `lock.commit(newIndexEntries)` — atomic temp-write + rename
     over `.git/index`.
6. **Release the lock in `finally`** — idempotent post-commit per
   `acquireIndexLock`'s contract; the `finally` only fires for
   throws between acquire and commit.
7. **Move HEAD** — existing soft-path logic (`updateRef` for a
   symbolic HEAD, raw `writeUtf8` for detached HEAD).
8. Return `{ mode: 'hard', id, branch }`.

### 3.2 Untracked files

Untracked files (present in working tree, absent from current index):

- **Path in target tree** → `materializeTree` writes the target
  content (with `force: true`, the untracked-collision guard is
  skipped, matching canonical `git reset --hard`).
- **Path NOT in target tree** → left alone. `materializeTree` only
  touches paths that appear in the target tree or the current
  index; untracked files outside that set survive the reset, which
  also matches canonical git.

This is the natural fallout from reusing `materializeTree` —
nothing special to add.

### 3.3 Soft + mixed paths

`mode: 'soft'` and `mode: 'mixed'` keep their existing behaviour
unchanged. Only `'hard'` gains side effects.

### 3.4 Pathspec scoping

Same answer as Phase 13.2 — pathspec for `reset --hard <commit> --
<pathspec>` is deferred to Phase 14.2 alongside the other pathspec
work. No `paths` option in this PR. (ADR-022 covers the reasoning
for `--mixed`; the same logic applies here.)

### 3.5 Atomicity model

Same as Phase 13.1 §4 + Phase 13.2 §4:

- **Working tree**: per-file (no cross-file rollback). A crash
  during materialise leaves a partially-written working tree;
  HEAD + index still reflect the **pre-reset** state, so the user
  can re-run `reset --hard` to converge.
- **Index commit**: atomic via `acquireIndexLock` (temp + rename).
- **HEAD update**: atomic, via the existing primitive.

**Ordering**: working tree → index → HEAD. The lock is acquired
**before** the working-tree write, so a concurrent index writer is
serialised. The HEAD move is **after** the index commit, so a
crash between the two leaves the index ahead of HEAD (same
recoverable hazard as canonical git).

## 4. Module layout

```
src/application/
├── commands/
│   └── reset.ts                              # extended: dispatch 'hard' to new helper
test/unit/application/
└── commands/reset.test.ts                    # extended: hard-mode assertions
```

No new files. The wiring change is small (≈ 20 lines in `reset.ts`).

## 5. Testing strategy

### 5.1 Unit — `reset.test.ts` (extended)

Re-use the existing `seedTwoCommits` helper plus new ones:

- **Given a hard reset to parent, When reset, Then both the index
  and the working tree match parent's tree**: after the reset,
  `readIndex(ctx)` has only `a.txt`, AND `b.txt` is gone from the
  working tree, AND `a.txt` content matches parent.
- **Given a hard reset that overwrites a dirty working-tree file,
  When reset, Then the file is overwritten (no
  CHECKOUT_OVERWRITE_DIRTY)**: dirty `a.txt`, hard reset to parent,
  assert `a.txt` content equals parent's. Proves `force: true` is
  wired through.
- **Given a hard reset to current HEAD, When reset, Then index +
  working tree are byte-identical to before**: prove the no-op
  case doesn't spuriously rewrite files.
- **Given hard reset on a bare repo, When reset, Then throws
  BARE_REPOSITORY** — preserved test, plus the operation-string
  assertion already added in Phase 13.2.
- **Given a corrupted index that makes readIndex throw mid-hard-
  reset, When reset, Then the lock is released so a follow-up
  reset can succeed**: mirrors the Phase 13.2 mutation-kill test
  for the `finally` block.

### 5.2 Mutation

Stryker on `src/application/commands/reset.ts`. Target: 0 new
survivors (or documented as `// equivalent-mutant`).

### 5.3 Integration

No new integration test in this phase. The unit tests + memory
adapter cover the surface; if a real-fs integration test is
needed later, it would naturally land alongside Phase 13.x
finalisation.

## 6. Out of scope (recorded)

- Pathspec scoping (deferred to Phase 14.2).
- `reset --merge` / `reset --keep`. Not part of v1 surface.
- Reflog entries for HEAD move. Deferred to Phase 17.1.
- Recursive submodule materialisation. Gitlinks become empty
  placeholder dirs only (matches Phase 13.1).

## 7. Open questions

- **Q1: Should `reset --hard` use `materializeTree`'s post-write
  index entries, or `buildIndexFromTree`'s donor-strategy
  entries?** → `materializeTree`'s. See ADR-023. Donor stats are
  stale after a working-tree rewrite; the fresh lstat-derived
  fields are correct.
- **Q2: Lock ordering.** Lock-around-everything (Phase 13.2's
  pattern) vs lock-around-commit-only (Phase 13.1's checkout
  pattern). Phase 13.3 follows the Phase 13.2 pattern — the
  TOCTOU window the post-pass-1 review closed in 13.2 is the
  same risk here. Phase 13.1's checkout has an open TOCTOU that
  a follow-up pass can address; this PR doesn't widen the
  surface, it adopts the safer pattern.
- **Q3: Progress event name.** `materializeTree` emits
  `'checkout:materialize'` as the op name (hardcoded in
  `apply-changeset.ts`). Reusing it from `reset --hard` is
  semantically reasonable — the operation IS a materialise.
  Parameterising the op name is YAGNI for this phase.

## 8. Self-review log

### Pass 1 → Pass 2

- Originally proposed running `materializeTree` first then
  acquiring the lock just for the commit (matching the Phase 13.1
  checkout pattern). Killed: that pattern has a TOCTOU window the
  reviewer flagged in Phase 13.2 and that we just closed. Phase
  13.3 should adopt the safer pattern. Updated §3.1 to acquire
  the lock first.
- Added §3.2 explicitly stating untracked-file handling —
  reviewers will ask. The behaviour is "fallout from reuse" but
  silent fallout invites pass-2 findings.

### Pass 2 → Pass 3

- Originally proposed an explicit `BUILD_INDEX` substep using
  `buildIndexFromTree` to populate the index. Killed: that gives
  the wrong stat cache (donor stats are stale after a working-
  tree rewrite). Re-routed to `materializeTree`'s `newIndexEntries`
  output. Captured the rationale as ADR-023 so a future reader
  doesn't try to "harmonise" the mixed and hard paths.
- Clarified Q2's lock-ordering trade-off explicitly. The
  inconsistency with Phase 13.1's checkout is intentional — this
  PR doesn't touch checkout, but a follow-up should.

### Pass 3 → Pass 4 (final pass)

- §3.4 added — pathspec deferral was implicit but reviewers want
  it stated, mirroring Phase 13.2's §3.6.
- §5.1's "corrupted-index mid-reset" test inherits the lock-
  release mutation kill from Phase 13.2. Without that test, the
  `finally { await lock.release() }` block has the same surviving
  mutant we just killed.
- §3.1 step 4 reorder note: the bare-repo guard at step 1 still
  runs BEFORE the lock acquire, so a bare repo never reaches the
  lock acquisition — no lock-leak risk.
