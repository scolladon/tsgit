---
subjects:
  - src/application/commands/status.ts
  - src/application/primitives/internal/is-entry-stat-clean.ts
---
# 960 — `status` writes when an entry was refreshed or any entry is racy

- **Status:** accepted
- **Date:** 2026-10-14
- **Design:** docs/design/status-refresh-index-extensions.md · **Supersedes/Refines:** refines ADR-958

## Context

The 2026-09-10 ruling wrote only "when an entry moved". git's `repo_update_index_if_able` writes on
`cache_changed || has_racy_timestamp`: a racy-only index (an entry modified in the same second as the
index file) is rewritten even when nothing was refreshed, which makes its entries non-racy so the next
`status` can trust them. The default build compares at whole-second granularity (no `USE_NSEC`): an entry
in the same second as the index is racy even when its nanoseconds are smaller (pins Q2 and Q4).

## Options considered

1. **Refreshed or racy, second granularity** — git's trigger (recommended).
2. **Only moved stat data** — just-added entries stay racy, and every `status` re-hashes them.
3. **Refreshed or racy, nanosecond `isRacy`** — disagrees with pin Q4.

## Decision

**User-ratified — option 1.** `status` writes iff at least one entry was refreshed or
`hasRacyTimestamp(entries, indexMtime)` holds — some non-gitlink entry's mtime seconds are at or after
the index file's mtime seconds. No index file means nothing is racy and nothing is written.

## Consequences

- On second-resolution adapters (memory, browser) `status` rewrites on each call within the second the
  index was written, as git does on such a filesystem; unit tests asserting "no write" advance the clock.
- The interop row for the racy trigger uses an entry whose nanoseconds are at or after the index's, so it
  holds under either git build.
