---
subjects:
  - src/application/commands/internal/working-tree.ts
---
# 1052 — `rm` removes a `\`-named working-tree file under the same host gate

- **Status:** accepted
- **Date:** 2026-10-23
- **Design:** docs/design/pathspec-glob-dialect.md · **Supersedes/Refines:** refines ADR-1051

## Context

With the walk admitting a `\`-named entry (ADR-1051), `rm` of that file on POSIX still refuses
through `removeFile`'s path validation, where git removes it (design rows W8, W9). The refusal is
atomic — index and file unchanged — so it is a refusal-condition mismatch, not data loss.

## Options considered

1. **Extend the host gate to `removeFile`**, the only writer these rows reach. Designer's
   recommendation.
2. **Leave `rm` as a pinned follow-up** — the fallback if the security review rejects option 1.
3. **Gate `validateWorkingTreePath` itself for every caller** (`mv`, `materializeFile`, the
   intake) — widens the change to paths nothing here pinned.

## Decision

**Adopted as recommended (no user judgment) — option 1.**

## Consequences

- `mv` and `materializeFile` keep their validation; a `\`-named target there stays as it is until
  a pin says otherwise.
