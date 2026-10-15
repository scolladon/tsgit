---
subjects:
  - src/domain/path/verify-path.ts
---
# 978 — The HFS alias check reads raw path bytes

- **Status:** accepted
- **Date:** 2026-10-15
- **Design:** docs/design/index-entry-path-bytes.md · **Supersedes/Refines:** refines ADR-763

## Context

git's HFS `.git`/`.gitmodules` alias check stops a name at the first sequence its UTF-8 reader rejects, so `.git\xff/x` is refused; tsgit checks the decoded view and accepts it (design §D17).

## Options considered

1. **Every caller that holds an entry passes its bytes**, parse included (recommended).
2. Write-side callers only.
3. Gate all HFS rules on the platform, as git's `core.protectHFS` default does.

## Decision

**Adopted-as-recommended (no user judgment) — option 1.** One verdict per path, matching tsgit's existing everywhere-HFS rule.

## Consequences

- tsgit refuses the same HFS aliases git refuses, including U+FFFE/U+FFFF tails (pre-existing gap).
- An index another git wrote with such a name is refused at read, as tsgit already does for other HFS aliases.
