---
subjects:
  - src/application/primitives/reftable-ref-store.ts
  - src/domain/refs/per-worktree-ref.ts
---
# 1165 — the reftable store selects the stack by prefix and keys records by the full name

- **Status:** accepted
- **Date:** 2026-11-08
- **Design:** docs/design/fsck-worktree-private-refs.md · **Supersedes/Refines:** refines ADR-1164

## Context

ADR-1164 was ruled on files-backend rows and states the rule as "a write of `<name>` in the
store the prefix selects". The design revision pinned the reftable backend too (rows W37–W44,
git 2.56.0 with `--ref-format=reftable` and a linked worktree): git's reftable backend picks
the stack the prefix names — `main-worktree/refs/bisect/x` lands in the main stack,
`worktrees/wt/HEAD` in the linked worktree's — but keys every ref and log record it writes by
the full prefixed name, moves `refs/heads/main` through `main-worktree/HEAD` without a lock
refusal and without a coupled HEAD log record, and refuses deletes through a prefix as the
files backend does. tsgit's reftable store writes a stray `main-worktree/HEAD` record into the
main stack without moving `refs/heads/main`, and sends `worktrees/wt/…` records to the main
stack.

## Options considered

1. **Copy git: stack by prefix, bare-name reads and chain walk, records keyed by the full
   name, no lock refusal, no coupled HEAD entry when a hop's bare name is HEAD** — pros: the
   records are git's bytes, which is the oracle / cons: the rule reads differently from the
   files backend's. The designer's recommendation.
2. **Follow ADR-1164's letter and key records by the bare name** — cons: diverges from
   git's records and would need its own ADR.
3. **Leave the reftable store as it is** — cons: rows W37, W38 and W40–W42 stay red.

## Decision

**Adopted-as-recommended (no user judgment) — basis ADR-226 (the prime directive), pinned
by W37–W44: option 1.** On the reftable backend a prefixed per-worktree name selects the stack
(`parseWorktreeRef`), reads and the symref chain walk use the bare name against that stack,
and every record written carries the full prefixed name as git writes it. ADR-1164's "write
of `<name>`" is read as "a write in the selected store", which is what the files backend's
paths and the reftable backend's records both do.

## Consequences

- The reftable store gains stack selection by prefix; its records match git's byte for byte
  on the W37–W44 rows.
- No `REF_LOCKED` refusal and no coupled HEAD log record on reftable, as git has none there.
