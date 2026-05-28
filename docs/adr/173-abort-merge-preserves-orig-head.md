# ADR-173: `abortMerge` preserves `ORIG_HEAD` on disk

## Status

Accepted (at `f6678401f5a103a69747c81239b1d8e42a0d1fff`)

## Context

A conflicting merge writes three state files: `MERGE_HEAD`,
`MERGE_MSG`, `ORIG_HEAD`. `abortMerge` undoes the merge — but
should it also delete `ORIG_HEAD`?

Two views:

- **Symmetric cleanup**: `ORIG_HEAD` was written by `merge`, so
  `abortMerge` should clean it up. Leaving it behind is "litter".
- **Recoverable marker**: `ORIG_HEAD` is canonical git's
  cross-operation rolling pointer to "the commit you most recently
  moved away from". It's shared by `merge`, `reset`, `rebase`, and
  other history rewriters. Deleting it on abort would diverge from
  canonical git's behaviour and remove a recovery affordance.

Canonical git's `merge --abort` does NOT delete `ORIG_HEAD`. The
existing `clearMergeState` helper in
`src/application/commands/internal/merge-state.ts` already encodes
this — it iterates `[MERGE_HEAD, MERGE_MSG]` only.

## Decision

`abortMerge` calls `clearMergeState(ctx)`. `ORIG_HEAD` is preserved
on disk. The branch ref is updated to `ORIG_HEAD`'s value, so the
post-abort state is "HEAD points at the same commit `ORIG_HEAD` points
at" — which is the canonical "I can `reset --hard ORIG_HEAD` later if
I changed my mind" affordance, intact.

## Consequences

### Positive

- **Matches canonical git.** Users with `git merge --abort` muscle
  memory get the same behaviour. A subsequent `reset --hard
  ORIG_HEAD` (which Phase 13.3 ships) reaches the same commit it
  would in canonical git.
- **Recovery affordance preserved.** Even after an abort, the user
  can inspect `ORIG_HEAD` to see "where I was before the merge",
  e.g. via `cat .git/ORIG_HEAD` or `repo.primitives.resolveRef('ORIG_HEAD')`.
- **`clearMergeState` semantics unchanged.** No new helper, no
  behaviour drift in the existing merge → commit flow.

### Negative

- **`ORIG_HEAD` persists across operations and can become stale.**
  A user who runs `merge`, aborts, then `reset --hard` somewhere
  unrelated will overwrite `ORIG_HEAD` again. This is canonical
  git's behaviour — `ORIG_HEAD` is a "last destructive move"
  rolling pointer, not a per-merge artefact. Documented in
  `docs/use/merge.md` and `docs/understand/refs.md`.

### Neutral

- A future user-facing API to inspect `ORIG_HEAD` (`repo.origHead()`)
  could be added cheaply once Phase 22 brings more state-machine
  commands. Out of scope for 20.4.

## Alternatives considered

- **Delete `ORIG_HEAD` in `abortMerge`.** Rejected. Diverges from
  canonical git and removes a recovery affordance for no gain.
- **Extend `clearMergeState` with an optional flag to also clear
  `ORIG_HEAD`.** Rejected. The flag would only ever be `false` for
  abort and never used by commit (which already doesn't clear
  `ORIG_HEAD`). Adding the parameter for one defaulted use is
  noise.
