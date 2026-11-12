---
subjects:
  - src/application/commands/grep.ts
---
# 1171 — a blob-target grep result is an optional `blob` field beside `paths`

- **Status:** accepted
- **Date:** 2026-11-12
- **Design:** docs/design/grep-blob-target.md · **Supersedes/Refines:** refines ADR-249

## Context

`git grep <pat> <rev>` greps a blob when `<rev>` resolves to one, and labels each hit with the
rev as typed (`HEAD:f1:1:…`), with no in-tree path. `GrepResult.paths` carries a `FilePath`
per entry, which a blob target does not have. ADR-249 forbids returning git's rendered label.

## Decision

**Ratified by the user.** `GrepResult` gains `blob?: GrepBlobResult` (`{ hits, binaryMatch }`);
`GrepPathResult` extends `GrepBlobResult` with `path`. A blob target returns `paths: []` and
`blob` when the blob matched, no `blob` when it did not. The caller rebuilds git's label from
the rev it passed.

Rejected: an optional `GrepPathResult.path` (widens a field every consumer reads; breaking) and
a discriminated `GrepResult` union (type-honest, but forces a major for a bug fix).

## Consequences

### Positive

- Additive: existing callers compile and behave unchanged; the fix ships as a minor/patch.

### Negative

- A caller must check two fields to see every match.

### Neutral

- The label rule (`rev` for a blob, `rev:path` for a tree) is documented in `docs/use/commands/grep.md`.
