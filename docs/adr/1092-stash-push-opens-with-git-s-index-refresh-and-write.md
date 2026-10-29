---
subjects:
  - src/application/commands/stash.ts
---
# 1092 — `stash push` opens with git's index refresh-and-write step

> Amended for git 2.56: see ADR-1109. git exits 128 on the unmerged-index refusal; 1 is reserved for a conflict.

- **Status:** accepted
- **Date:** 2026-10-26
- **Design:** docs/design/forced-checkout-same-commit.md (DC5, F12, F13) · **Supersedes/Refines:** refines ADR-1091

## Context

git's `stash push` opens with `refresh_and_write_cache`. That step refreshes stat-dirty, content-clean entries and
writes the index. On an unmerged index it first refreshes the stage-0 entries and rewrites the index, then fails: it prints
`<path>: needs merge` and `error: could not write index` and exits 128. No object, ref or reflog is written. The F12
refusal is that failure mode.

## Options considered

1. **Implement the whole step: refusal, stat refresh and index write.**
2. **Implement the refusal only.**

## Decision

**Adopted as recommended (no user judgment): option 1.** If tsgit skipped the refresh, its stale-only reset
(ADR-1087) would rewrite a touched file that git had already refreshed.

## Consequences

- Each push pays one N-`lstat` scan and one index write, as git does.
