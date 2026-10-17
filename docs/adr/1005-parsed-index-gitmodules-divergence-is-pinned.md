---
subjects:
  - src/domain/git-index/index-parser.ts
  - test/integration/gitmodules-symlink-alias-interop.test.ts
---
# 1005 — The parsed-index refusal of a `.gitmodules` symlink alias is pinned as a divergence

- **Status:** accepted
- **Date:** 2026-10-17
- **Design:** docs/design/gitmodules-backslash-alias.md · **Supersedes/Refines:** applies ADR-978

## Context

git reads an index that already holds a symlink `x\gitmod~1` without error (`ls-files`,
`status`, `write-tree` exit 0); tsgit refuses it at `parseIndex`, the read-side posture
ADR-978 records.

## Options considered

1. An interop row asserting the divergence, citing ADR-978 (recommended).
2. Unit tests only.
3. A new divergence ADR.

## Decision

**User-chosen** — option 1. **Adopted-as-recommended** — the interop matrix lives in a new
`gitmodules-symlink-alias-interop.test.ts` (about 40 rows across three arms) rather than the
containment file's two-row block.

## Consequences

- The divergence is named and pinned; a future change to the read posture breaks the row.
