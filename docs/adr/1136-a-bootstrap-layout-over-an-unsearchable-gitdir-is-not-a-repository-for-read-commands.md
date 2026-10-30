---
subjects:
  - src/application/primitives/internal/repo-state.ts
  - src/repository/resolve-layout.ts
---
# 1136 — a bootstrap layout over an unsearchable gitdir is not a repository for read commands

- **Status:** accepted
- **Date:** 2026-10-30
- **Design:** docs/design/fsck-broken-ref-chain-unreadable.md · **Plan:** docs/plan/fsck-broken-ref-chain-unreadable.md (Part 15) · **Supersedes/Refines:** refines ADR-716 and ADR-1132

## Context

Probed on git 2.56.0 in scrubbed throwaways: a standalone repository whose `.git/refs` is mode 000
or 0400 refuses `git status` with `fatal: not a git repository`, exit 128. Under ADR-1132 tsgit's
discovery skips that gitdir, so `openRepository` falls into the found-nothing bootstrap (ADR-716),
which stays lenient so `init` and `clone` can bootstrap. `status` and `log` then throw
`PERMISSION_DENIED` on `.git/refs/heads/main`, where a plain directory with no repository already
refuses `NOT_A_REPOSITORY`.

## Options considered

1. **Read commands refuse `NOT_A_REPOSITORY`; `openRepository` stays lenient** — pros: git's refusal,
   ADR-716 untouched for `init`/`clone` / cons: the repository-existence guard gains a check.
2. **`openRepository` refuses up front when `<cwd>/.git` exists but is unusable** — cons: changes
   ADR-716's "the bootstrap reads nothing" rule and affects `init`/`clone` there.
3. **Defer** — cons: a proven divergence on a surface this change rewrites.

## Decision

**Ratified by the user: option 1.** The repository-existence guard every read command runs
(`assertRepository` and its operational twins) refuses `NOT_A_REPOSITORY` for a found-nothing
bootstrap layout whose `refs/` or `objects/` is not searchable, exactly as it already refuses a
directory with no usable `HEAD`. A layout discovery accepted is never re-checked, since discovery
already applied ADR-1132; the check costs nothing on that path. `openRepository`, `init` and
`clone` are unchanged.

## Consequences

- A caller sees the same `NOT_A_REPOSITORY` for an unsearchable standalone gitdir as for no
  repository at all.
- The bootstrap layout carries a marker the guard reads, so no extra I/O lands on discovered
  layouts.
