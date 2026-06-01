# ADR-232: extract `abortSequencerReset` for cherry-pick + revert; rebase abort diverges

## Status

Accepted (at `06489642`)

## Context

22.2b item 2 deferred extracting a shared abort-reset helper until a **third**
`*-abort` consumer existed, to avoid a speculative two-consumer abstraction.
`cherryPickAbort` and `revertAbort` share a byte-identical body modulo the
`clear<Op>Head` call:

```
target = seqHead ?? resolveRef(branch)
hardResetWorktreeToCommit(target)
updateRef(branch, target, { reflogMessage: `reset: moving to ${target}` })
clear<Op>Head(); clearMergeMsg(); clearSequencer()
return { head: target, branch }
```

Landing `rebase` completes the family (three abort commands now exist). The
backlog's premise was that rebase would be the third consumer of this exact
shape. Research shows it is **not**: `git rebase --abort` reattaches `HEAD` (a
symbolic-ref write, since HEAD was detached during the replay) with a
`rebase (abort): returning to <head-name>` reflog and clears `.git/rebase-merge/`;
it does **not** move the branch ref (`refs/heads/<b>` stays at orig-head — the
replay never touched it, ADR-228) and never touches `.git/sequencer/`.

## Decision

In the architecture-refactor pass, extract the cherry-pick/revert common body
into `abortSequencerReset(ctx, { branch, target, clearHead })`
(behaviour-preserving): hard-reset to `target`, `updateRef(branch, target,
{ reflogMessage: reset: moving to <target> })`, run the op-specific `clearHead`,
`clearMergeMsg`, `clearSequencer`, return `{ head: target, branch }`.

`rebaseAbort` **does not** route through this helper. It reuses only the
already-shared `hardResetWorktreeToCommit` atom, then performs its faithfully
different ref mechanic (HEAD reattach + `rebase (abort)` reflog + rebase-merge
teardown). The divergence is intentional and recorded here so it is not mistaken
for an inconsistency.

## Consequences

### Positive

- De-duplicates the two identical cherry-pick/revert abort bodies (the
  duplication 22.2b flagged), now that the family is complete.
- Documents why rebase's abort is shaped differently, preventing a future
  "unify all three aborts" refactor that would break faithfulness.

### Negative

- The helper covers two of three family members, not all three — the name
  `abortSequencerReset` reflects the sequencer-backed pair, not rebase.

### Neutral

- If a later command reuses rebase's HEAD-reattach abort shape, that becomes its
  own rule-of-three for a second helper.
