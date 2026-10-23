---
subjects:
  - src/application/commands/add.ts
---
# 1050 — A gitlink whose `<path>/.git` leads to no repository refuses `NOT_A_REPOSITORY`

- **Status:** accepted
- **Date:** 2026-10-23
- **Design:** docs/design/pathspec-glob-dialect.md · **Supersedes/Refines:** refines ADR-1049

## Context

A broken gitfile (design row GL20) or a corrupt HEAD (GL21) makes git `add` die with exit 128 and
the index unchanged. tsgit today succeeds and leaves the entry alone.

## Options considered

1. **Refuse with the existing `NOT_A_REPOSITORY { path }`** before any blob write, `path` being
   git's `<path>/<gitdir as written>`; the gitlink step runs before the walked entries are
   staged, so a refusal leaves zero loose objects as ADR-1035 requires. Pros: matches git's
   outcome with no new union member. Designer's recommendation.
2. **Leave the entry unchanged and succeed** — a refusal-condition mismatch.
3. **A new member `SUBMODULE_NOT_A_REPOSITORY { path }`** — about 30 B gzip for a distinction
   `path` already carries.

## Decision

**Adopted as recommended (no user judgment) — option 1.**

## Consequences

- The error table documents the gitlink case under `NOT_A_REPOSITORY`.
- Both rows are cross-tool interop tests, as are the shapes the review round added: a `commondir`
  leading nowhere or to a directory without `objects/` and `refs/`, a `.git` symlink to a directory
  with no HEAD, and a gitdir whose `objects/` is missing — each refused with the path git prints.
