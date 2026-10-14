---
subjects:
  - src/application/commands/status.ts
  - src/application/primitives/internal/index-lock.ts
---
# 958 — `status` is an occasional index writer under the optional lock

- **Status:** accepted
- **Date:** 2026-10-14
- **Design:** docs/design/status-refresh-index-extensions.md · **Supersedes/Refines:** refines ADR-226; refined by ADR-959, ADR-960, ADR-961, ADR-967

## Context

git's `status` refreshes stale stat data and writes the index back under an *optional* lock. tsgit's
`status` never wrote, so an entry whose stat data no longer matched (a tar-restored checkout moves every
inode and ctime) stayed stat-invalid forever, and every `status` re-read, clean-filtered and hashed every
file: 450 ms and 20 005 reads per call on the generated medium fixture, against 145 ms when settled.
The nightly `status` row measured exactly that state.

## Options considered

1. **Occasional writer, as git** — refresh, write under the optional lock, degrade to a read-only
   status when the lock cannot be had, `refresh?: boolean` as the structured `--no-optional-locks`.
2. **Read-only `status`** — keep today's behaviour. Cons: diverges from git's default and keeps the
   O(repo) re-hash on every stat-invalid tree.

## Decision

**User-ratified on 2026-09-10 — option 1, recorded here.** `status` becomes an occasional writer, as
git is by default. It takes git's optional `index.lock`, refreshes, writes only when the index needs
it, and never throws for a lock it could not take. `StatusOptions.refresh?: boolean` (default `true`)
is the structured `--no-optional-locks`: `false` never writes. The write goes through the index-lock
commit path, so the session index cache is invalidated. The per-file attribute cost is memoised once
per call.

The 2026-09-10 wording placed the lock before the read, triggered the write only on moved stat data,
named three degrade codes, and memoised a "no `.gitattributes` anywhere" verdict. Pinning against git
2.55 refined each clause; the refinements are user-ratified in ADR-959 (lock position), ADR-960 (write
trigger), ADR-961 (degradation) and ADR-967 (the memo's realisation).

## Consequences

- A `status` on a stat-invalid tree pays the hash once; later calls are stat-clean.
- The nightly `status` row changes meaning from "stat-invalid, every call re-hashes" to "settled,
  stat-valid"; the stat-invalid figure moves to its own bench row (`refresh: false`).
- Internal `status` consumers (`describe --dirty`, submodule cleanliness) refresh too, as git's do.
