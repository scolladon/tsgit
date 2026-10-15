---
subjects:
  - src/application/primitives/apply-changeset.ts
  - src/application/primitives/internal/write-working-tree-file.ts
---
# 974 — Checkout never writes through a leading symlink

- **Status:** accepted
- **Date:** 2026-10-15
- **Design:** docs/design/index-entry-path-bytes.md · **Supersedes/Refines:** refines ADR-226

## Context

A tree holding a symlink and an `X/payload` whose names are distinct bytes but one on-disk name
(`A`/`a` on a case-insensitive filesystem, or two names with one decoded view) puts the two writes in
different pool groups. The leading-path scan sees the parent missing, the other task creates the
symlink, and the recursive parent creation follows it: `payload` lands outside the worktree (main
reproduces 1 run in 10). git creates leading directories one component at a time and never follows a
symlink there.

## Options considered

1. **Fix in this change**, git-faithfully, with its own tests (user choice).
2. A separate change next.
3. Backlog only.

## Decision

**User-ratified — option 1.** A working-tree write never follows a symlink in its leading path,
whatever the order the pool runs writes in. The mechanism is set in the design.

## Consequences

- No checkout, reset or materialisation can write outside the worktree through a leading symlink.
- Pre-existing on `main`; fixed here because this change makes the lossy-pair route reachable.
