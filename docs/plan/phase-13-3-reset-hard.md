# Phase 13.3 — Implementation plan

Derived from `docs/design/phase-13-3-reset-hard.md` + ADR-023. The
work is composition — no new primitives. One commit wires `reset
--hard` into the existing `materializeTree` + index-lock plumbing.

## Step order

### 1. Wire `reset --hard` to call `materializeTree`

Refactor `src/application/commands/reset.ts`:

1. Add a `hardResetFromCommit` helper that mirrors
   `rebuildIndexFromCommit`'s shape but uses `materializeTree`
   instead of `buildIndexFromTree`.
2. Dispatch on `mode` in the `reset` function:
   - `'soft'`  → HEAD-only path (unchanged).
   - `'mixed'` → `rebuildIndexFromCommit` (Phase 13.2).
   - `'hard'`  → `hardResetFromCommit` (new).
3. Both `mixed` and `hard` share the same shape:
   - `readObject` + assert commit type
   - `acquireIndexLock` BEFORE reading the index
   - `try { readIndex → <primitive> → lock.commit } finally { lock.release() }`

Hard's `<primitive>` is `materializeTree(ctx, { targetTree, currentIndex, force: true })`,
and the commit uses `result.newIndexEntries` (per ADR-023).

Module changes:

- `src/application/commands/reset.ts` — extend
- `test/unit/application/commands/reset.test.ts` — extend

New tests (per design §5.1):

- **Given a hard reset to parent, When reset, Then working tree
  AND index match parent's tree** — `b.txt` is gone from both
  on-disk AND from the index; `a.txt` content equals parent's.
- **Given a hard reset over a locally-modified file, When reset,
  Then the file is overwritten** — proves `force: true` is wired
  through; without it the dirty-tree guard would throw
  `CHECKOUT_OVERWRITE_DIRTY`.
- **Given a hard reset to current HEAD, When reset, Then no-op
  (index and working tree unchanged)** — proves we don't
  spuriously rewrite identical files.
- **Given a corrupted index that makes readIndex throw mid-hard-
  reset, When reset, Then the lock is released so a follow-up
  reset can succeed** — mirrors Phase 13.2's mutation-kill test
  for the `finally` block.

Commit: `feat(reset): hard mode materialises working tree and index`.

### 2. Tick BACKLOG + docs

- `docs/BACKLOG.md` §13.3 `[ ]` → `[x]` with accepted-on summary.
- `README.md` — add the 13.3 row in the phase table; remove the
  Phase 12.1 caveat that says hard reset is "HEAD only".
- `MIGRATION.md` — extend the existing `repo.reset` example with
  the `mode: 'hard'` case.

Commit: `docs(backlog): tick §13.3 — reset --hard materialises`.

## TDD discipline

Each step ends in:

1. `npm run check:types`
2. `npm run check`
3. `npm run test:unit -- <touched files>`
4. `npm run validate` (full gate)

Atomic commits per logical change. If a review pass surfaces an
issue, fix on the same branch — no rebasing public history.

## Risk gates

| Step | Likely failure mode | Mitigation |
|---|---|---|
| 1 | Calling materializeTree with `force: false` — dirty-tree guard fires on user's local mods | Explicit test: dirty `a.txt`, hard reset to parent, expect content overwritten (proves `force: true` wired) |
| 1 | Index lock not in `finally` | Pattern copied verbatim from `rebuildIndexFromCommit` (Phase 13.2); same `try/finally` structure |
| 1 | HEAD moves before index commit | The mode-dispatch happens BEFORE the existing HEAD-update block; same ordering as `mixed` |
| 1 | `materializeTree`'s `newIndexEntries` order divergence from index format | `materializeTree`'s `mergeNewIndexEntries` already sorts (see Phase 13.1) |
| 1 | Untracked-file collision behaviour drifts | `force: true` skips the untracked-collision guard; matches canonical `git reset --hard` |
| 1 | Bare repo reaches lock acquire | `assertNotBare(ctx, 'reset --hard')` already runs at step 1 of `reset`, before any composition path |
| 2 | BACKLOG line drifts from PR | Tick lives inside this PR's commits (per CLAUDE.md workflow §8) |

## Self-review log

### Pass 1 → Pass 2

- Originally proposed extracting a shared `materialiseFromCommit`
  helper that takes the primitive (`buildIndexFromTree` vs
  `materializeTree`) as a parameter. Killed: ADR-023 documents
  why the two primitives are NOT interchangeable, and a shared
  helper invites someone to "fix" the asymmetry. Two separate
  helpers keep the intent explicit.
- Step 2 (docs) now explicitly removes the README caveat that
  said `reset --hard` is HEAD-only — that prose invalidates with
  this PR.

### Pass 2 → Pass 3

- Added "hard reset to current HEAD = no-op" to step 1 tests.
  Without it, a mutant that swaps `materializeTree`'s `force`
  parameter or breaks the changeset's noop classification could
  pass other tests. The no-op test pins the expected behaviour.
- Step 1's risk table grew "Untracked-file collision behaviour" —
  pass-2 reviewers will ask, and the answer (force: true + reuse
  Phase 13.1's semantics) is one sentence so it belongs here.

### Pass 3 → Pass 4 (final pass)

- Step 1 tests pin BOTH the index path (`readIndex(ctx)` post-reset)
  AND the working-tree path (`fs.read` / `fs.exists` post-reset).
  Without both, a mutant could degrade one side silently.
- Added "Index lock not in `finally`" to step 1's risk table —
  this is the exact mutant Phase 13.2 had to kill with a
  corrupted-index test. Step 1 inherits the same test.
