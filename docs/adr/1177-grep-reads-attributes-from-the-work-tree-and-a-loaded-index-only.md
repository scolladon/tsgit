---
subjects:
  - src/application/commands/grep.ts
  - src/application/commands/internal/grep-binary-override.ts
---
# 1177 — grep reads attributes from the work tree, and from the index only when the target loaded it

- **Status:** accepted
- **Date:** 2026-11-12
- **Design:** docs/design/grep-diff-attribute-binary.md · **Supersedes/Refines:** refines ADR-226

## Context

`grep` must consult the `diff` attribute, so each target needs an attribute source. Pinned
against git 2.56: git never reads the grepped rev's tree; it reads `info/attributes`, the
work-tree `.gitattributes` and `core.attributesFile`, and falls back to the index copy only
when the target loaded the index (`--cached`, the work tree, a `:path` / `:N:path` rev). A
bare repository reads neither the work tree nor the index. `git grep NEEDLE HEAD` gives text
while `git grep NEEDLE HEAD :f1` gives binary on the same repo.

## Decision

**adopted-as-recommended (no user judgment)** — ADR-226: the pins decide it. The index
fallback (`buildCheckinAttributeProvider`) applies to the `'index'` target, the work tree and
an index-reading blob rev; every other rev target, and any repository without a work tree,
uses `buildAttributeProvider(ctx)`. The rev's own tree is never read.

Rejected: the check-in provider for every target (wrong on a staged `.gitattributes` whose
work-tree copy is deleted) and reading the rev's tree (refuted by every source pin).

## Consequences

### Positive

- Every pinned source row matches git, including the load-order rows.

### Negative

- `attr.tree` / `--attr-source` / `GIT_ATTR_SOURCE` stay unimplemented (ledger row 31.9).

### Neutral

- The provider is built lazily, so no attribute is read before the rev and pathspec resolve.
