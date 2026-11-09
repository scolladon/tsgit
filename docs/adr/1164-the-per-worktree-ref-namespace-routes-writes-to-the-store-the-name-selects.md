---
subjects:
  - src/application/primitives/ref-store.ts
  - src/application/primitives/internal/ref-write-chain.ts
  - src/application/primitives/path-layout.ts
  - src/application/primitives/reftable-ref-store.ts
  - src/application/primitives/update-ref.ts
supersedes:
  - adr: "1158"
    scope: "the write routes stay out of this change until pinned"
  - adr: "1163"
    scope: "write-route readers read at today's location through resolveDirectForWrite"
---
# 1164 — the per-worktree ref namespace routes writes to the store the name selects

- **Status:** accepted
- **Date:** 2026-11-08
- **Design:** docs/design/fsck-worktree-private-refs.md · **Supersedes/Refines:** supersedes ADR-1158 (write-side scope) and ADR-1163

## Context

ADR-1158 folded the read side of git's `parse_worktree_ref` rule and left the write routes
out "until pinned"; ADR-1163 guarded them with a second locator so every write stayed
byte-identical to before. The impact triage of this run pinned the write side on git 2.56.0
over nine rows (`update-ref` through `main-worktree/HEAD`, `main-worktree/refs/bisect/x`,
`worktrees/wt/refs/bisect/y` and `worktrees/wt/HEAD`, from the main and the linked working
directory, with the main HEAD on a branch and detached). git selects the store the prefix
names and writes the bare name there: `main-worktree/HEAD` from the linked worktree follows
the main HEAD and moves `refs/heads/main`, `main-worktree/refs/bisect/x` writes
`<common>/refs/bisect/x`, and `<common>/main-worktree/` is never created. git refuses with
exit 128 (`cannot lock ref '…': Unable to create '<…>/HEAD.lock': File exists`) when the
prefixed name reaches the HEAD of the worktree it runs in while that HEAD is on a branch,
because the transaction's own HEAD update locks the same file; the detached-HEAD shape
succeeds. tsgit at dcd9a1d9 writes the path the name spells — a stray
`<common>/main-worktree/HEAD` or `<common>/main-worktree/refs/bisect/x` that git never reads
and tsgit's own `resolveRef` does not read back — and accepts both refused shapes: six of the
nine rows differ. No tsgit command writes a prefixed name, so only direct `updateRef` and
`deleteRef` callers meet it.

## Options considered

1. **File the pinned gap as a backlog row and keep ADR-1158/1163** — pros: the change ships
   as reviewed and validated / cons: a silent write to a stray file is a data divergence
   that ADR-1158's "until pinned" clause no longer shields, now that the rows exist. The
   impact triage's recommendation.
2. **Fold the write side into this run** — writes through `main-worktree/<per-worktree
   name>` and `worktrees/<id>/<per-worktree name>` select the store and the bare name exactly
   as reads do, `main-worktree/HEAD` dereferences like the main store's `HEAD`, the HEAD-lock
   collision shape is refused as git refuses it, and the two-locator guard of ADR-1163 is
   retired or reduced to whatever the design still needs — pros: the namespace behaves the
   same way on both sides, as doctrine D-2 asks of a faithfulness fix / cons: a design
   revision, new rows, and the review and mutation cycles again on the new delta.
3. **Refuse prefixed names on writes** — not an option: git accepts seven of the nine rows.

## Decision

**Ratified by the user against the impact triage's recommendation: option 2.** On every
backend, a write to `main-worktree/<name>` or `worktrees/<id>/<name>` with a per-worktree
`<name>` is a write of `<name>` in the store the prefix selects, with that store's `HEAD`
dereference rule; a prefixed name whose bare form is `HEAD` of the worktree the command runs
in is refused when that HEAD points at a branch, with git's lock-collision shape, and
succeeds when it is detached. The design revision pins the remaining shapes (`deleteRef`,
transactions holding both the prefixed and the bare name, the reflog each write appends to,
the reftable store) before any part lands; the write-route readers ADR-1163 inventoried take
the same mapping as the writers.

Superseded from ADR-1158: the clause keeping the write routes out of this change.

Carried forward from ADR-1158: the read-side rule — `parse_worktree_ref` on reads, with the
shared lookup for a `<name>` that is not per-worktree — unchanged.

Superseded from ADR-1163: the two-locator guard and `resolveDirectForWrite` reading at
today's `writeLocation`.

Carried forward from ADR-1163: the inventory of write-route readers (`checkExpected`,
`refIsPresent`, `walkSymbolicChain`, `resolveWithoutDeref`, `readReferentValue`) as the
places the mapping must reach, and the fake-store test that proves which locator each reader
consumes.

## Consequences

- The design doc gains the write-side requirement and its rows; `docs/use/commands/rev-parse.md`
  stops stating that writes through these names are unchanged.
- Backlog row 32.56, drafted by the impact triage for this gap, is not filed: the gap closes
  in this change.
- Doctrine D-1 holds as written: the write routes were out "until pinned", and this run
  pinned them; D-2 covers the fold itself.
