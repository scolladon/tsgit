---
subjects:
  - src/application/commands/internal/misspelt-revision.ts
---
# 939 — The misspelt-revision filename probe follows `..` outside the worktree, as git does

- **Status:** accepted
- **Date:** 2026-10-03
- **Design:** docs/design/alternates-object-lookup.md · **Supersedes/Refines:** refines ADR-625 (read containment), ADR-226

## Context

When a revision argument does not resolve, git's `setup_revisions` readers decide whether it is a
filename before refusing: `check_filename` / `verify_filename` `lstat()` the argument relative to the
current directory. The path is not normalised against the worktree root first, so `..` segments walk
outside it. Live (git 2.55): with `$PARENT/outside` present, `rev-parse dg:a/../../outside` is taken
as a filename (2 warnings, exit 0, the argument echoed); with it absent, 3 warnings then fatal.
tsgit's adapters confine every path to the repository root (ADR-625), so the probe answered "absent"
for any `..` escape: one warning fewer and a refusal where git succeeds.

## Options considered

1. **Read-only existence probe outside the root, in this probe only.**
2. **Keep confinement, record a divergence.**
3. **Caller-supplied path-existence hook on the context** (confined when absent).

## Decision

**User-ratified — option 1.** The misspelt-revision probe performs git's existence check exactly,
following `..` outside the worktree. This is a deliberate, narrowly scoped exception to ADR-625's read
containment: only this probe, only an `lstat`-equivalent existence answer (no content is read, nothing
is written), and only for the argument git itself would `lstat`.

## Consequences

- The probe goes through a capability scoped to existence checks, declared on the write-surface /
  containment audit and signed off by the security review.
- The browser and memory adapters, which have no outside filesystem, answer "absent" — git's answer
  for a path that does not exist.
- Interop rows pin the outcome against git (outside path present → filename, 2 warnings; absent →
  3 warnings then refusal).
