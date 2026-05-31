# ADR-223: git-faithful empty-revert semantics (markerless stop, no `--allow-empty`)

## Status

Accepted (at `d2061c41`)

## Context

`git revert` undoes a commit by applying its reverse patch as a 3-way merge.
When that reverse merge leaves the tree unchanged (`mergedTree === oursTree`) —
e.g. reverting an already-reverted commit, or resolving a conflict back to the
current `HEAD` — the revert is **empty**. Unlike `git cherry-pick`, `git revert`
has **no `--allow-empty` flag**, so it cannot mint an empty commit on request.

The shipped `cherry-pick` (22.1) handles its empty case by writing
`CHERRY_PICK_HEAD` + `MERGE_MSG` and returning `kind:'empty'` (an empty *stop*
the user resolves with `--allow-empty`). The temptation is to reuse that shape.

But the verified git 2.54 behaviour for revert is different, and varies by
situation (probed with signing off):

- **single** start-empty (clean, no prior conflict): exit 1, *"nothing to commit,
  working tree clean"*, **no** `REVERT_HEAD`, **no** sequencer — a markerless
  no-op.
- **multi** start-empty (clean, mid-sequence): **stops at** the empty commit with
  the sequencer persisted (todo[0]=empty), **no** `REVERT_HEAD`, tree clean.
- empty stop → `git revert --continue`: re-attempts, still empty → **drops** the
  commit and proceeds.
- empty stop → `git revert --skip`: drops it and proceeds.
- conflict resolved **to** empty → `git revert --continue`: exit 1, *"nothing to
  commit"*, **keeps** `REVERT_HEAD` (awaits `--skip` or `git commit --allow-empty`).
- keep an empty anyway: `git commit --allow-empty`.

So a revert's empty case is shaped like cherry-pick's **merge-commit stop**
(markerless, sequencer-in-multi only), *not* like cherry-pick's empty stop.

Three options were weighed:

- **A — git-faithful stop:** model the above exactly. `kind:'empty'` with no
  `REVERT_HEAD`; single writes no state, multi persists the sequencer;
  `continue` drops the acknowledged leading empty (`onEmpty:'drop'` at `i===0`),
  `skip` drops it, `repo.commit({allowEmpty:true})` keeps it.
- **B — simplified always-drop:** silently skip empty reverts (never stop, never
  surface them). Simpler, but the caller never learns a revert was redundant and
  the behaviour diverges from git's default stop.
- **C — cherry-pick-style marker:** write `REVERT_HEAD` on empty for internal
  symmetry. Diverges from git (a real start-empty revert leaves no marker).

## Decision

Adopt **A — git-faithful stop**. An empty revert stops as `kind:'empty'`:

- no `REVERT_HEAD` / `MERGE_MSG` is written for a start-empty;
- a single revert leaves no state; a multi/range revert persists the sequencer
  with the empty commit at `todo[0]`;
- `revert.continue` drops the acknowledged leading empty and resumes
  (`runSequence` gains an `onEmpty: 'stop' | 'drop'` mode; `run` uses `'stop'`,
  the source-absent `continue` uses `'drop'` at `i===0` only);
- `revert.skip` drops it (existing behaviour);
- a conflict resolved to empty re-stops via `continue` **keeping** `REVERT_HEAD`;
- the escape hatch to keep an empty revert is `repo.commit({ allowEmpty:true })`,
  which clears `REVERT_HEAD` — matching git's `git commit --allow-empty` hint.

No `allowEmpty` / `recordOrigin` option is exposed on `revert.run` / `continue`.

## Consequences

### Positive

- Byte- and behaviour-faithful to `git revert` across all empty sub-cases; the
  interop suite can pin tsgit ⇄ git resumption through an empty stop.
- The caller observes redundant reverts (`kind:'empty'`) instead of silent drops.
- Reuses the cherry-pick merge-stop machinery (markerless sequencer stop); the
  only new concept is the `onEmpty` mode.

### Negative

- `revert`'s empty handling deliberately differs from `cherry-pick`'s (no marker
  on start-empty), so the two sequencer commands are not symmetric here — a
  reviewer must read this ADR to see why.

### Neutral

- The `onEmpty:'drop'` rule drops one leading empty per `continue`; multiple
  consecutive empties each require their own acknowledgment (a `continue` per
  empty), matching git's per-commit stop.
