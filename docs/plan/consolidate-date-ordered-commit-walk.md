# Plan — consolidate the date-ordered commit walk (ADR-275)

Behaviour-preserving consolidation. The existing suites are the oracle — they
stay green and **unmodified** throughout. Two atomic slices.

## Slice 1 — Extract the internal `commit-date-walk` core; `walkCommitsByDate` becomes a wrapper

**Goal:** one generic date-walk loop, parameterised by an internal `firstParent`
flag; the public primitive keeps its seed-validation contract and delegates.

**New file** `src/application/primitives/internal/commit-date-walk.ts`:

- `selectParents(commit: Commit, firstParent: boolean): ReadonlyArray<ObjectId>`
  — `firstParent ? commit.data.parents.slice(0, 1) : commit.data.parents`. The
  single source of truth for which parents the walk follows.
- `interface CommitDateWalkOptions { from; until?; shallow?; firstParent?;
  ignoreMissing?; verifyHash? }`.
- `async function* commitDateWalk(ctx, options): AsyncIterable<Commit>` — the
  body of today's `walkCommitsByDate` **minus** `assertValidSeeds`, with the
  parent step using `selectParents(commit, options.firstParent ?? false)`. Keeps
  the `ctx.signal?.aborted` check, `seen`-gated enqueue, `until`/`shallow`
  handling, and the shared `readCommit` reader.

**Rewire** `walk-commits-by-date.ts` to a thin wrapper:

```ts
export async function* walkCommitsByDate(ctx, options: WalkCommitsByDateOptions) {
  assertValidSeeds(options.from);
  yield* commitDateWalk(ctx, options);
}
```

`WalkCommitsByDateOptions` unchanged (no `firstParent`). The dead `DateWalk`
type, `makeReader`, `enqueueSeeds`, `enqueueParents`, `enqueueCommit` move into
the core (or are deleted if subsumed).

**TDD:**

1. **Red** — add `test/unit/application/primitives/internal/commit-date-walk.test.ts`
   targeting the capability the public primitive's suite cannot reach:
   - `Given a merge commit, When firstParent is true, Then only the
     first-parent chain is yielded` (newest-date-first), and the all-parents
     control case.
   - `selectParents` first-parent slice vs all-parents (isolated), incl. a
     no-parent root → `[]`.
   Run `npx vitest run test/unit/application/primitives/internal/commit-date-walk.test.ts`
   → fails (module missing).
2. **Green** — create the core, rewire the wrapper. Re-run the new test +
   `walk-commits-by-date.test.ts` + `history-interop` + `log-interop` → all green
   (the wrapper's behaviour is identical).
3. **Refactor** — dedupe any plumbing; ensure the core imports only `domain/*` +
   `ports/context` + `read-commit` + `read-object` (sibling-internal shape).

`npm run validate`; commit `refactor(primitives): extract commit-date-walk core
from walkCommitsByDate`.

## Slice 2 — Fold `describe.selectNearest` onto the core

**Goal:** `describe` consumes `commitDateWalk` with `firstParent`, layering its
candidate/reach/depth/cap policy in a single pass; the bespoke walk machinery is
deleted.

**Edit** `describe.ts`:

- Replace `selectNearest`'s manual queue loop with
  `for await (const commit of commitDateWalk(ctx, { from: [target],
  firstParent: plan.firstParent }))`.
- Collapse the cap's two phases into one pass: choose `best` the moment the cap
  is hit (candidate set is final there), then stream remaining commits straight
  into winner-depth finishing (see design pseudocode). Post-loop fallback sort
  for the `≤ cap` path.
- `propagateReach(commit)` iterates `selectParents(commit, plan.firstParent)`,
  spreading `reach.get(oid)` to each parent. `bumpBestDepth(best, oid)` ==
  `incrementUnreached([best], reach.get(oid))`.
- **Delete:** `finishDepth`, `makeCommitReader`, `toWalkCommit`, `WalkCommit`,
  `WalkState`, the manual `enqueue`/`shift`/`seen` plumbing, and the now-unused
  `enqueue`/`QueueEntry` import. **Keep:** `candidates`, `reach`, `reachSet`,
  `incrementUnreached`, `compareCandidates`, the cap, the sort, `computeDirty`
  (and its unrelated `// Stryker disable`).

**TDD (refactor slice — existing tests are the safety net):**

1. **Green-before** — run `describe.test.ts` + `describe-interop.test.ts` +
   parity `describe.scenario` → confirm green pre-refactor.
2. **Refactor** — apply the fold.
3. **Green-after** — re-run the same suites unchanged → still green (byte-for-byte
   identical `DescribeResult`; faithfulness pinned by the unchanged interop
   goldens, incl. the first-parent and candidate-cap cases).

`npm run validate`; commit `refactor(describe): fold the date-ordered walk onto
the shared commit-date-walk core`.

## Sequencing & checks

- Slice 1 before Slice 2 (the core must exist for describe to consume it).
- No barrel / `api.json` change (core is internal; public `WalkCommitsByDateOptions`
  unchanged) — `check:doc-typedoc` stays clean.
- After both slices: Step 6 reviews (ts / security / tests) → Step 7 architecture
  pass (re-examine whether `walkCommits` shares anything now; expected no-op) →
  Step 8 mutation (0 killable; expect suppression reduction on `describe.ts`).
- Docs (Step 9): flip backlog 23.4l → `[x]` with the resolution summary; note in
  the relevant internals/primitives doc that `commit-date-walk` is the shared
  date-walk core (if such a doc enumerates internal primitives).
