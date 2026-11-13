---
subjects:
  - src/application/primitives/internal/peel.ts
  - src/application/commands/grep.ts
---
# 1179 — the searchable kind tells a commit's tree from a tree object

- **Status:** accepted
- **Date:** 2026-11-12
- **Design:** docs/design/grep-diff-attribute-binary.md · **Supersedes/Refines:** refines ADR-1173

## Context

Pinned against git 2.56: a rev that dereferences to a commit (tags followed) consults
attributes; a tree object (`HEAD^{tree}`, a tree oid, a tag of a tree, `HEAD:`, `HEAD:sub`)
reads none, though git's `default` driver (`diff.default.binary`) still applies to it.
`peelToTreeOrBlob` already branches on exactly that.

## Decision

**adopted-as-recommended (no user judgment)** — ADR-1173 (the peel policy lives in
`peel.ts`). `SearchableKind` widens to `'commit-tree' | 'tree' | 'blob'`.

Rejected: a separate `viaCommit` flag (two fields that can contradict) and type inspection in
`grep.ts` (duplicates the walk policy ADR-1173 placed in `peel.ts`).

## Consequences

### Positive

- One discriminant; grep picks the attribute reader by kind.

### Neutral

- `peelToTreeOrBlob` is internal; only `grep.ts` and its tests consume it.
