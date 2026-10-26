---
subjects:
  - src/application/commands/stash.ts
---
# 1092 — `stash push` opens with git's index refresh-and-write step

- **Status:** accepted
- **Date:** 2026-10-26
- **Design:** docs/design/forced-checkout-same-commit.md (DC5, F12, F13) · **Supersedes/Refines:** refines ADR-1091

## Context

git's `stash push` opens with `refresh_and_write_cache`. That step refreshes stat-dirty, content-clean entries and
writes the index. On an unmerged index it fails: it prints `<path>: needs merge` and `error: could not write index`,
exits 1 and writes nothing. The F12 refusal is that failure mode.

## Options considered

1. **Implement the whole step: refusal, stat refresh and index write.**
2. **Implement the refusal only.**

## Decision

**Adopted as recommended (no user judgment): option 1.** If tsgit skipped the refresh, its stale-only reset
(ADR-1087) would rewrite a touched file that git had already refreshed.

## Consequences

- Each push pays one N-`lstat` scan and one index write, as git does.
