---
subjects:
  - src/repository/resolve-layout.ts
  - src/repository/find-layout.ts
---
# 711 — the `commonDir` argument overrides the `commondir` file

- **Status:** accepted
- **Date:** 2026-08-24
- **Design:** docs/design/common-dir-open-option.md (candidate D3)

## Context

A linked worktree's gitdir carries an on-disk `commondir` file. When the caller also
supplies `commonDir`, one of them must win. Measured on git 2.55.0: the environment
variable beats the file, on both the discovery and explicit-`GIT_DIR` routes.

## Options considered

1. **The argument wins outright** (design recommendation) — pros: pinned git precedence;
   the rule every other explicit layout argument follows ("argument tier beats config
   tier") / cons: none identified.
2. **The file wins** — cons: makes the option unusable in the shape that most needs it,
   re-pointing a linked worktree at a relocated common dir.
3. **Refuse when both are present and disagree** — cons: turns a legitimate override into
   an error.

## Decision

**Option 1 — adopted-as-recommended (no user judgment).**

A caller-supplied `commonDir` replaces the file-derived value on both routes, before
candidate validation (ADR-715).

## Consequences

- The interop precedence pin builds a linked worktree whose file names one directory and
  opens it with an argument naming another; the argument's directory must be the one used.
- The file remains the source of truth whenever the argument is absent — no behaviour
  change for existing callers (design R9).
