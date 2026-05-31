# ADR-227: detached `reset` routes its `HEAD` write through `updateRef`

## Status

Accepted (at `9de7605e`)

## Context

ADR-225 made a no-op ref update skip the **direct ref's** reflog while still
logging the coupled `HEAD`, gated centrally in `updateRef`. Its "Neutral" section
flagged two divergences the audit left open, both now closed here (the second is a
pure message fix, not an architectural choice):

1. **Detached `reset --hard HEAD` (no-move)** writes a spurious `reset: moving to
   HEAD` `HEAD` reflog entry. `reset`'s symbolic path goes through `updateRef` and
   inherited 22.2b's gate, but its **detached** path writes `.git/HEAD` with a plain
   `writeUtf8` and then calls `recordRefUpdate(HEAD, …)` **directly** — bypassing the
   central gate. Real git writes **nothing** in this case: a detached `HEAD` is a
   single **direct** ref under *needs-commit* semantics, so when `old == new` neither
   the ref nor its reflog changes.

The fix must make the detached no-move write skip the reflog while a detached move
still records `reset: moving to <target>`. Two placements:

- **A — local caller gate.** Keep the `writeUtf8`, wrap the direct
  `recordRefUpdate` in `if (head.id !== id)`. This is the backlog's literal
  "caller-level gate" and the minimal diff. But the no-move skip rule now lives in
  **two** places — `updateRef`'s central `oldId !== newId` gate *and* this local
  copy — inviting drift, and the detached write keeps its non-atomic `writeUtf8`.
- **B — route through `updateRef`.** Replace the detached `writeUtf8` +
  `recordRefUpdate` with `updateRef(ctx, 'HEAD' as RefName, id, { reflogMessage })`.
  The detached write then flows through the **single** canonical ref-writer and
  inherits the central gate, so exactly one place owns the no-move rule.

B's feasibility was verified: `validateRefName('HEAD')` passes, `looseRefPath(gitDir,
'HEAD')` resolves to `.git/HEAD`, `atomicWriteRef` writes `HEAD.lock` → rename
`HEAD` (git's own HEAD-update mechanism, byte-identical `${id}\n` content), and
`logCoupledHead` re-reads `HEAD`, finds it **direct** (still detached), and
early-returns — so there is no double-log; exactly one potential reflog entry,
gated on a real move.

## Decision

Adopt **B**: the detached `reset` path writes `HEAD` via `updateRef(ctx, 'HEAD' as
RefName, id, { reflogMessage })`, dropping the direct `writeUtf8` + `recordRefUpdate`
(and the now-unused `recordRefUpdate` import in `reset.ts`). The no-move skip is
owned solely by `updateRef`'s `oldId !== newId` gate; the gate is oid-based, so
`reset --hard <oid-equal-to-current>` is skipped just like `reset --hard HEAD`.

This deviates from the backlog's literal "caller-level gate" wording and ADR-225's
option-A leaning. The deviation is deliberate: DRY (one no-move gate, not two) and a
git-faithful atomic HEAD write outweigh the larger-than-minimal diff, and the write
mechanism change is observably equivalent (both leave `.git/HEAD` = `${id}\n`).

The companion merge-abort message fix (`merge: aborted` → `reset: moving to HEAD`)
is verified faithfulness with no fork and needs no separate decision.

## Consequences

### Positive

- One canonical place encodes the no-move reflog skip (`updateRef`); the detached
  path can no longer drift from the symbolic path.
- The detached `HEAD` write gains git-faithful lock-file atomicity (`HEAD.lock` →
  rename) for free, replacing a non-atomic `writeUtf8`.
- Detached no-move `reset` becomes byte-faithful (no `HEAD` reflog entry); detached
  move is unchanged. Pinned by `reset-interop` against real git.

### Negative

- The detached write mechanism changes (`writeUtf8` → `atomicWriteRef`). Mitigated:
  observably identical final `.git/HEAD`; the lock-file is the same transient git
  itself uses; covered by the existing detached-move unit test + new interop pins.
- `updateRef` is now also invoked with `name = 'HEAD'` (HEAD-as-written-ref, not a
  branch). Mitigated: `looseRefPath`/`validateRefName`/`logCoupledHead` all handle
  it correctly, verified above and unit-pinned.

### Neutral

- Further collapsing the symbolic/detached branches into one `updateRef` call (they
  differ only in ref name + returned `branch`) is a behaviour-preserving tidy left
  to the architecture-refactor pass, not forced here.
