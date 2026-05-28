# ADR-174: `continueMerge` delegates to `commit`

## Status

Accepted (at `f6678401f5a103a69747c81239b1d8e42a0d1fff`)

## Context

`continueMerge` finalises a conflicting merge once the user has
staged the resolutions. The same end state — "create a commit with
parents `[HEAD, MERGE_HEAD]` from the current index, using
`MERGE_MSG` as the default message, then clear merge state" — is
already exactly what `commit` does today when `MERGE_HEAD` exists.

Two implementation paths:

- **A: full reimplementation.** Build a parallel command that
  duplicates `commit`'s flow: read config / user, build tree from
  index, reject unmerged entries, run hooks, call `createCommit`,
  update ref, clear merge state.
- **B: thin wrapper.** Call `commit(ctx, ...)` from `continueMerge`
  after a precondition check.

## Decision

`continueMerge` is a thin precondition checker that delegates to
`commit`:

```typescript
export const continueMerge = async (
  ctx: Context,
  opts: ContinueMergeOptions = {},
): Promise<ContinueMergeResult> => {
  await assertRepository(ctx);
  await assertNotBare(ctx, 'merge --continue');
  const mergeHead = await readMergeHead(ctx);
  if (mergeHead === undefined) throw noOperationInProgress('merge');
  return commit(ctx, buildCommitOptions(opts));
};
```

`buildCommitOptions` conditionally spreads `author`, `committer`,
`noVerify` to honour `exactOptionalPropertyTypes`.

## Consequences

### Positive

- **No duplication.** The merge-resolution code path inside `commit`
  is exercised by both `commit` (when called directly on a resolved
  merge) and `continueMerge`. One implementation, one set of bugs.
- **Hooks, config, tree synthesis, reflog message all "just work."**
  `commit` already does these correctly; `continueMerge` inherits.
- **MERGE_MSG fallback for free.** `commit`'s `resolveCommitMessage`
  already falls through to `readMergeMsg` when the user-supplied
  message is empty and `MERGE_HEAD` is present.
- **Tier-1 surface stays narrow.** `continueMerge` is 10 lines of
  glue, not 100 lines of parallel commit logic.

### Negative

- **`continueMerge` is conceptually a no-op when called without
  any options:** it's `commit({ message: '' })` plus a precondition.
  A reader might ask "why does this exist if `commit` would have
  worked?" The answer is the precondition — `commit` *tolerates*
  the absence of `MERGE_HEAD` (then it just makes a regular commit);
  `continueMerge` *requires* it. Documented at the surface.
- **Coupling.** A future change to `commit`'s merge-resolution path
  silently affects `continueMerge`. Mitigation: `continueMerge`'s
  unit tests assert the load-bearing properties (two parents,
  MERGE_MSG fallback, hook invocation, merge-state cleanup) — a
  regression in `commit` that breaks those properties fails both
  test files.

### Neutral

- The "delegate" pattern matches `commit`'s own decision (commit
  reads `MERGE_HEAD` rather than duplicating logic from `merge`).
  Same architecture choice, two layers.

## Alternatives considered

- **A (full reimplementation).** Rejected. ~100 lines of duplication
  for no behaviour difference; doubles the maintenance surface for
  every future `commit` change.
- **Extract a shared `createMergeCommit(ctx, opts, mergeHead)` helper
  that both `commit` and `continueMerge` call.** Rejected for v1.
  The merge-resolution path inside `commit` is interleaved with
  the normal commit path (shared author resolution, shared tree
  synthesis, shared hook invocation). Extracting a useful helper
  would mean restructuring `commit.ts` itself — too much scope
  drift for one phase. Deferred to a follow-up refactor.
