---
subjects:
  - src/application/commands/rev-parse.ts
  - src/application/commands/internal/resolve-rev.ts
  - src/application/commands/grep.ts
---
# 1178 — a blob rev keeps the path it named, for attribute lookup

- **Status:** accepted
- **Date:** 2026-11-12
- **Design:** docs/design/grep-diff-attribute-binary.md · **Supersedes/Refines:** refines ADR-1175

## Context

git keeps the path a rev names (`get_oid_with_context`'s `oc.path`). Pinned against git 2.56:
`HEAD:f1`, `:f1`, `:0:f1`, `HEAD^{tree}:f1`, `HEAD:./f1` and `HEAD~0:f1` honour `f1 binary`;
an oid, `<oid>^{blob}` or a tag of a blob keep the content sniff.

## Decision

**adopted-as-recommended (no user judgment)** — ADR-226, and no trade-off between the
mechanics. `rev-parse.ts` exports `resolveRevisionWithPath`, returning `{ id, named? }` with
`named = { path, fromIndex }` taken from the `tree-path` and `index-stage` branches the
resolver actually used; `resolveRevision` keeps its signature. `resolveReference` forwards
`named`.

Rejected: re-parsing the rev inside `grep` (duplicates the whole-name split rule) and giving
no blob target an attribute (wrong on seven pinned rows).

## Consequences

### Positive

- The path grep uses is the one the resolver used; no second parser.

### Negative

- `rev-parse.ts` gains one export.
