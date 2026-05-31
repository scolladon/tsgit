# ADR-224: `revert --abort` writes the git-faithful `reset: moving to <oid>` reflog

## Status

Accepted (at `d2061c41`)

## Context

Aborting an in-progress sequencer operation hard-resets the working tree, index,
and branch to the pre-sequence `HEAD`. The reflog entry that move records is
user-visible (`git reflog`, recovery flows).

Verified git 2.54 behaviour (signing off): **both** `git cherry-pick --abort`
and `git revert --abort` write the reflog message **`reset: moving to <full-oid>`**
— the same message `git reset --hard <oid>` produces, because abort *is* a reset
internally. git does **not** write a bespoke `cherry-pick: aborted` /
`revert: aborted` line.

The shipped tsgit `cherryPickAbort` (22.1), however, passes an explicit
`reflogMessage: 'cherry-pick: aborted'` to `updateRef`. That is a **divergence**
from real git; it is not pinned by the cherry-pick interop suite (which asserts
tree/HEAD readback, not the abort reflog string), so it shipped unnoticed.

For `revert.abort` we must choose:

- **A — git-faithful `reset: moving to <oid>`:** match real git exactly.
  Honours the project's non-negotiable "be git-faithful unless an ADR diverges".
  Leaves cherry-pick's existing divergence as a separate, optional follow-up.
- **B — mirror cherry-pick's `revert: aborted`:** stay internally symmetric with
  the shipped (non-faithful) cherry-pick abort, at the cost of also diverging
  from git.

## Decision

Adopt **A**. `revert.abort` writes the git-faithful reflog
**`reset: moving to <full-oid>`** for the branch update after the hard reset.

The cherry-pick divergence is **not** changed in this PR (out of scope —
behaviour-preserving boundary); it is logged as a `docs/BACKLOG.md` follow-up to
align `cherry-pick --abort` to the same faithful message in a dedicated change.

## Consequences

### Positive

- `revert --abort` is byte-faithful to git; a reflog-parity interop assertion is
  possible.
- Sets the correct precedent; the divergent cherry-pick line gets a tracked
  follow-up instead of being silently propagated.

### Negative

- `revert.abort` and `cherryPick.abort` emit different reflog strings until the
  follow-up lands — a transient asymmetry between the two commands.

### Neutral

- The abort reset path is otherwise identical to cherry-pick's
  (`hardResetWorktreeToCommit` + `updateRef`); only the `reflogMessage` argument
  differs.
