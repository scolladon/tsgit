---
subjects:
  - src/application/commands/grep.ts
---
# 1175 — grep keeps the `{ treeish }` target key for a blob rev

- **Status:** accepted
- **Date:** 2026-11-12
- **Design:** docs/design/grep-blob-target.md · **Supersedes/Refines:** —

## Context

`GrepOptions.target`'s `{ treeish }` now also accepts a rev that resolves to a blob.

## Decision

**Ratified by the user.** Keep `{ treeish }` and widen its JSDoc to "a committed tree, or a blob
when the rev resolves to one". git's synopsis says `<tree>…` while it greps blobs.

Rejected: adding `{ rev }` beside it (two spellings, no new capability) and renaming to
`{ rev }` (breaking).

## Consequences

### Positive

- No API break.

### Negative

- The key name under-describes what it accepts.

### Neutral

- The JSDoc carries the blob case.
