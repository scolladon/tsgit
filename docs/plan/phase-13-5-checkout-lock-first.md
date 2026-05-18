# Phase 13.5 — Implementation plan

Derived from `docs/design/phase-13-5-checkout-lock-first.md`. One
commit refactors `checkout.ts` to lock-first ordering. No new ADRs
(the pattern was decided in Phase 13.2's post-review hardening).

## Step order

### 1. Refactor `checkout.ts` to lock-first ordering

Two functions change:

- `switchBranch`: keep `readTree(ctx, oid)` outside the lock (git
  objects are immutable). Acquire `acquireIndexLock` BEFORE
  `readIndex`. Move materialise + conditional commit inside the
  try block. Release in finally.
- `pathRestore`: split into two branches by `source`:
  - `source === 'index'` (the default): unchanged — no lock, no
    commit. Lock-free path-restore-from-index is the desired
    behaviour.
  - `source !== 'index'`: acquire lock first, read index, materialise,
    commit if changes, release in finally.

HEAD update (`writeUtf8` for detached, `writeSymbolicRef` for
attached) stays OUTSIDE the lock — independent atomic primitives.

Files:

- `src/application/commands/checkout.ts` (rewrite the two helpers)
- `test/unit/application/commands/checkout.test.ts` (extend)

New tests (per design §6.1):

- **Given an index.lock already on disk, When switch checkout to a
  branch, Then throws RESOURCE_LOCKED with resource='index'** —
  pins lock-first for switch mode.
- **Given an index.lock already on disk, When path-restore from
  HEAD, Then throws RESOURCE_LOCKED** — pins lock-first for the
  source !== 'index' branch.
- **Given an index.lock already on disk, When path-restore from
  the default (index) source, Then succeeds (no lock acquired)** —
  proves we did NOT regress to "always acquire".

All existing checkout tests must continue to pass.

Commit: `fix(checkout): acquire index lock before readIndex (TOCTOU close)`.

### 2. Tick BACKLOG + docs

- `docs/BACKLOG.md` §13.5 `[ ]` → `[x]`.
- `README.md` — add the 13.5 row in the phase table.
- `MIGRATION.md` — no caller-visible change, nothing to update.

Commit: `docs(backlog): tick §13.5 — checkout lock-first ordering`.

## TDD discipline

Each step ends in:

1. `npm run check:types`
2. `npm run check`
3. `npm run test:unit -- <touched files>`
4. `npm run validate` (full gate)

## Risk gates

| Step | Likely failure mode | Mitigation |
|---|---|---|
| 1 | `readTree` moved inside lock and serialises tree reads against other index operations | Keep `readTree` outside (immutable git objects don't need lock); design §3.1 + §8 Q1 cite this |
| 1 | `source === 'index'` accidentally starts acquiring the lock | Explicit test that pre-locks `.git/index.lock` and asserts the source-index path STILL succeeds |
| 1 | Lock not released on materialise throw | Pattern copied verbatim from Phase 13.2/13.3 `try/finally` |
| 1 | HEAD updated even when materialise threw before commit | Move-HEAD happens AFTER the `finally` block; if the lock-wrapped block throws, the function returns early — HEAD untouched |
| 1 | Backwards-compat regression: pre-13.5 callers see different observable behaviour | Existing 11 checkout tests stay green; that's the gate |
| 2 | BACKLOG tick drifts from the PR | Tick lives inside this PR's commits (CLAUDE.md workflow §8) |

## Self-review log

### Pass 1 → Pass 2

- Originally planned to also extract a `commitIndexIfChanged` helper
  shared between switchBranch and pathRestore. Killed: the two
  call-sites' conditional commit logic is already trivial
  (single-line `if (writes > 0) await lock.commit(...)`), and
  extracting it adds a layer for no payoff. Inline both.
- Step 2 (docs) reduced — MIGRATION.md needs no update because
  observable behaviour is unchanged.

### Pass 2 → Pass 3

- Risk-table row added for "HEAD updated even when materialise
  threw" — without an explicit risk note, a future contributor
  could move the HEAD update inside the try block "for symmetry"
  and break crash recovery.
- Step 1 risk gate explicitly notes the `source === 'index'`
  no-lock invariant — pass-3 reviewer of Phase 13.3 was the one
  who flagged the cross-phase lock-pattern asymmetry, so being
  loud about NOT regressing this branch is worth the extra line.
