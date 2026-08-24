---
subjects:
  - src/repository/resolve-layout.ts
  - src/repository/find-layout.ts
  - src/application/primitives/path-layout.ts
---
# 709 — the `commonDir` argument models the `commondir` file, not the env split

- **Status:** accepted
- **Date:** 2026-08-24
- **Design:** docs/design/common-dir-open-option.md (candidate D1) · **Refines:** ADR-294

## Context

Measured on git 2.55.0: `GIT_COMMON_DIR` moves the object database, `config`, `shallow`,
`info/*` and `hooks/` — but **not** the ref store, which keeps following the on-disk
`<gitDir>/commondir` file alone. git's own `rev-parse --git-path refs/…` and `git branch`
disagree with each other under the variable. The `commondir` **file**, by contrast, is
honoured uniformly by every subsystem. The new `openRepository({ commonDir })` argument
has to pick which of git's two behaviours it models.

## Options considered

1. **Uniform** — the argument sets the layout's single `commonDir` coordinate and every
   consumer follows it, refs included (the `commondir`-file behaviour; design
   recommendation) — pros: self-consistent, matches tsgit's one-field/one-accessor
   architecture / cons: not byte-faithful to the env variable's ref placement.
2. **Replicate the env split** — refs keep resolving against the file-derived common dir
   while objects/config/hooks follow the argument — pros: byte-faithful to the env var /
   cons: ships git's internal inconsistency; a commit's objects and its branch ref land in
   different trees — the corruption class ADR-294 exists to prevent.
3. **Refuse when a `commondir` file is also present** — pros: the two channels can never
   disagree / cons: forbids the linked-worktree case, the most useful one.

## Decision

**Option 1 — ratified by the user, as recommended.**

The argument behaves like the `commondir` file: one common-dir coordinate, followed
uniformly by objects, refs, reflogs, `packed-refs`, `config`, `shallow`, `info/*`,
`hooks/` and `worktrees/`. The env variable's objects-here/refs-there split is treated as
an internal inconsistency of an env-string API, not a contract to port.

## Consequences

- The ref-placement interop pin must use a **real linked worktree** (whose split comes
  from a `commondir` file) as the git peer — `GIT_COMMON_DIR=… git` would fail the
  assertion, since git leaves refs in the gitdir under the env var.
- `GIT_COMMON_DIR=… git` remains the interop peer for exactly the surfaces git routes
  through the variable (objects, config, shallow, info, hooks).
- Replicating the env split is explicitly out of scope; any future request for it is a
  new decision, not a bug against this one.
