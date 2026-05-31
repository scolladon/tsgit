# ADR-225: a no-op ref update skips the direct-ref reflog, keeps the coupled HEAD log

## Status

Accepted (at `ff557417`)

## Context

`cherry-pick --abort` / `revert --abort` hard-reset the branch to the pre-sequence
`HEAD`. In a **lone conflict** the branch never moved, so the abort resets it to
the oid it already points at (`oldId === newId`). tsgit's `updateRef` records a
reflog entry unconditionally, so both abort paths emit a spurious
`reset: moving to <oid>` **branch** entry where git writes none.

Verified git 2.x behaviour (scrubbed `GIT_*`, signing off) for the no-move case is
**asymmetric**, because git's ref backend splits a symbolic-`HEAD` update into two
updates with different reflog rules:

- the underlying `refs/heads/<branch>` ref uses *needs-commit* semantics — when
  `old == new`, **no reflog entry** is written;
- the `HEAD` symref-split is *log-only* — it records `reset: moving to <oid>`
  **unconditionally**, even on a no-move.

So the faithful rule is *not* "skip the reflog when `old == new`" — it is "skip the
**direct ref's** reflog, but always log the coupled `HEAD`". The same no-op is
reachable from other `updateRef` callers (`merge --abort` is always no-move;
`reset --hard HEAD`; an up-to-date `fetch`/`push` tracking-ref update).

Where to place the skip:

- **A — central in `updateRef`:** gate the direct-ref `recordRefUpdate` on
  `oldId !== newId`; leave `logCoupledHead` unconditional. One behaviour-preserving
  change fixes both abort paths and every audited sibling; move cases stay
  byte-identical.
- **B — abort-paths only:** guard inside `cherryPickAbort` / `revertAbort` (skip
  the `updateRef` call when `target === current`). Matches the backlog's literal
  "touches both abort paths", but duplicates the move-check and leaves the same
  divergence latent in `merge --abort` / `reset` / `fetch` / `push`.
- **C — inside `recordRefUpdate`** (the single reflog writer), `if (oldId === newId) return`:
  infeasible. The writer cannot distinguish the `HEAD` symref-split log-only
  "keep" from a direct-`HEAD` needs-commit "skip"; a blanket skip would wrongly
  drop the `HEAD` `reset: moving to` entry that git *does* write.

## Decision

Adopt **A**. In `updateRef`, gate the direct ref's `recordRefUpdate` on
`oldId !== newId`; keep `logCoupledHead` unconditional. `atomicWriteRef` stays
unconditional — rewriting the loose ref with byte-identical content on a no-move is
observably indistinguishable from git, and the one observable edge
(re-materialising a packed-only ref as loose) is unreachable on the abort paths.

C is rejected as incorrect; B is rejected for duplicating the check and leaving
audited siblings divergent.

## Consequences

### Positive

- Both abort paths become byte-faithful in the no-move case: branch reflog
  unchanged, `HEAD` records `reset: moving to <oid>`. Pinned by interop against
  real git.
- `merge --abort`, symbolic `reset --hard HEAD`, and up-to-date `fetch`/`push` are
  fixed by the same change — the "audit other callers" clause is satisfied at the
  source, not per-caller.
- The fix is invisible to every move case (`old != new`): no regression surface.

### Negative

- Behaviour of a public primitive (`updateRef`) changes for the no-move case.
  Mitigated: the change only *removes* a non-faithful entry; all existing move
  behaviour is preserved, and the new asymmetry is unit- and interop-pinned.

### Neutral

- Two no-op divergences the audit surfaced are out of scope and tracked as backlog
  follow-ups: detached `reset --hard HEAD` (a different writer —
  `recordRefUpdate(HEAD, …)` direct — needing its own caller-level gate), and the
  `merge --abort` `HEAD` message text (`merge: aborted` vs git's
  `reset: moving to <oid>`).
