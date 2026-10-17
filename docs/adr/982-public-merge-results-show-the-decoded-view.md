---
subjects:
  - src/application/commands/merge.ts
---
<!-- cspell:ignore FFFD -->
# 982 — Public merge results show the decoded view

- **Status:** accepted
- **Date:** 2026-10-16
- **Design:** docs/design/index-entry-path-bytes.md · **Supersedes/Refines:** refines ADR-968

## Context

Merge, rebase, stash and cherry-pick results name conflicted and changed paths as strings. A lossy
path's escaped key is internal (ADR-981).

## Options considered

1. **The U+FFFD view**; raw bytes stay readable through `readIndex` (recommended).
2. Add `pathBytes?` to every conflict descriptor.
3. Expose the escaped string.

## Decision

**Adopted-as-recommended (no user judgment) — option 1.** Same rule as `IndexEntry.path`: the
public string is the decoded view.

## Consequences

- No new public fields on merge results; bytes can be added later if a consumer needs them.
- Lone surrogates never reach a public result.
