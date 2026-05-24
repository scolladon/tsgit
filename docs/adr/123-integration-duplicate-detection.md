# ADR-123: Integration-test duplicate detection by `(surface, bucket)` pair

## Status

Accepted (at `9b109c1fecccf317fc4b017127fe6bedf849b26c`)

## Context

19.4's first goal is "kill duplicates" — but "duplicate" needs a definition the audit can mechanise. Three candidate keys:

1. **Surface alone.** Any two files claiming the same surface (`clone`) are duplicates. Pro: simplest. Con: false-positives on intentional partitioning — `clone-http-backend.test.ts` and a future `clone-byte-roundtrip.test.ts` would both claim `clone` for different proofs.
2. **Bucket alone.** Any two files claiming the same bucket (`real-http`) are duplicates. Pro: surfaces over-density in a bucket. Con: meaningless — the whole `network/` directory shares a bucket; flagging that is noise.
3. **`(surface, bucket)` pair.** Two files claiming both same surface AND same bucket are duplicates. Each file's bucket is its justification ([ADR-122](122-integration-bucket-taxonomy.md)); two files with the same justification for the same surface are redundant by construction.

Platform-only files complicate option 3: `posix-only/node-fs-symlinks.test.ts` and a hypothetical `win-only/node-fs-junctions.test.ts` may both claim `(nodeFs.links, platform-only)` — and that's *desired*, because the OSes need separate test files.

## Decision

Two files are duplicates iff they share both `surface` and `bucket`, **with one exemption**: if at least one of the files lives in a platform-only directory (`posix-only/` or `win-only/`) AND the bucket is `platform-only`, the overlap is exempted.

The exemption is narrow on purpose. `(clone, real-http)` cannot be exempted by moving one file under `posix-only/` because the bucket isn't `platform-only`. Splitting the proof requires splitting the surface (e.g. `clone` vs `clone.partial`) — which is the intent.

## Consequences

### Positive

- **Real duplicates surface as findings.** If two contributors land integration tests for the same `(surface, bucket)` pair in parallel, the audit flags the overlap at land time, not three sprints later when someone notices.
- **Intentional partitioning is not a finding.** POSIX and Windows split the `platform-only` bucket cleanly; the exemption respects that without bypassing duplicate detection for other buckets.
- **The fix path is mechanical.** "Same surface, same bucket" → either merge the files or rebucket one. "Same surface, different buckets" → not a duplicate; the buckets prove different things. The audit's finding payload already includes both files and both keys, so the reviewer sees the resolution.

### Negative

- **Two files with `(clone, real-http)` will both be flagged even if they cover orthogonal scenarios.** Mitigation: split the surface (`clone` vs `clone.partial`, `clone.shallow`, etc.). The existing `clone.partial` / `fetch.shallow` precedent shows this is workable.
- **The platform-only exemption is asymmetric.** A file in `posix-only/` claiming `(x, real-fs)` and a file at root claiming `(x, real-fs)` would NOT be exempted (bucket isn't `platform-only`). That's intentional — the asymmetry catches the easy mis-bucketing case where someone tucks a real-fs test into `posix-only/` to dodge the duplicate check.

### Neutral

- **The pair is symmetric.** `(clone, real-http)` on file A and file B → both files appear in the finding's `paths` array, sorted. The audit doesn't pick a "primary"; the reviewer decides which to keep.
