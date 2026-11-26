---
subjects:
  - src/application/primitives/internal/occupant-clash.ts
  - src/application/primitives/apply-changeset.ts
  - src/application/primitives/find-would-overwrite.ts
  - src/application/commands/merge.ts
---
# 1274 — An overwrite pre-flight reads an occupant under an excluded directory as ignored

- **Status:** accepted
- **Date:** 2026-11-26
- **Design:** docs/design/is-ignored-leading-directory.md (Matrices B, C, D and F, §3, §7) · **Supersedes/Refines:** serves ADR-1271; applies DOCTRINE(D-2), DOCTRINE(D-4) and DOCTRINE(D-6)

## Context

The backlog entry said only the public per-path primitive answered wrongly. It is not so: the
per-path probe behind every overwrite pre-flight asks the same full-path predicate. git's
`check_ok_to_remove` (`unpack-trees.c`) asks `is_excluded`, which runs the leading-directory
walk of ADR-1271.

Pinned against git 2.56.1, both `core.ignorecase` values, with a rule on the leading directory
only (`ab/`, `ab`, or `ab/` then `!ab/c`):

| Command | git | tsgit on main |
|---|---|---|
| `checkout` over an untracked `ab/c` (rows T1, T2, T4) | switches and overwrites | `CHECKOUT_OVERWRITE_DIRTY` |
| `merge` (fast-forward and true), `cherry-pick`, `revert`, `rebase` start (rows U1, U4) | exit 0, overwrites | `WORKING_TREE_DIRTY` |
| `stash apply` (rows U1, U4) | exit 0, overwrites | `STASH_APPLY_WOULD_OVERWRITE` |
| `rebase --abort` (rows Y1, Y4) | exit 0, overwrites | `WORKING_TREE_DIRTY` |
| an ignored file where a leading directory is due (row Z1, `checkout` and `merge`) | exit 0, replaces the file | refuses |
| a directory that becomes a file (rows T5, V1) | exit 0, deletes `ab/c` and `ab/sub/d` with the directory | refuses, keeps everything |

The rows with no rule and the rows with a rule on the full path agree on main.

## Options considered

1. **Fold it here: the probe takes the rule through the shared predicate, every pre-flight
   returns git's outcome, the deletion included, and the change ships as a plain `fix`**
   (recommended).
2. Fix `isIgnored` only and schedule the pre-flights.
3. Fold the overwrite but keep the ignored contents of a directory that becomes a file.

## Decision

**Adopted-as-recommended (no user judgment)** — DOCTRINE(D-2): the second half sits in the
shared predicate, and a fix that leaves these rows red is not a fix. DOCTRINE(D-4): git's
deletion is copied. DOCTRINE(D-6): calls that threw now return, no call that returned starts
throwing and no signature changes, so the commit carries no `!`. Option 1.

Each consumer gets its own interop rows. `merge.abort` and `rebase.skip` reach the same probe
by the code and were not run against git during design; their interop rows are the pin.

Refused: option 2 is the half-fix D-2 rules out. Option 3 keeps files git deletes.

## Consequences

### Positive

- `checkout`, `merge`, `cherry-pick`, `revert`, `rebase` and `stash apply` stop refusing a
  switch, merge or apply that git performs.

### Negative

- An untracked file under an excluded directory is now overwritten, or deleted with a
  directory that becomes a file, where tsgit refused. git loses the same data.
