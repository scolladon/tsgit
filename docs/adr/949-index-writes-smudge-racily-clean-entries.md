---
subjects:
  - src/application/primitives/internal/index-lock.ts
  - src/application/primitives/internal/smudge-racily-clean.ts
---
# 949 — Index writes smudge racily-clean entries as git's `do_write_index` does

- **Status:** accepted
- **Date:** 2026-10-12
- **Design:** docs/design/alternates-object-lookup.md · **Supersedes/Refines:** refines ADR-226

## Context

The stat cache (`add`, `status`) trusts an index entry whose stat matches the working file, unless
the entry is racy: its mtime is not older than the index file's own mtime. That read-side guard is
not enough on its own. A file rewritten with the same size in the same timestamp tick as the index
write keeps an identical stat. If a later command then rewrites the index in a later tick and carries
the entry over, the entry is no longer racy against the new index. `add` restages the old blob and
`status` reports the path clean.

Reproduced on the memory filesystem with a fixed clock, and on a real HFS+ volume (1-second
timestamps) through the Node adapter: `add`, `commit`, same-size rewrite, `rm` in the next second,
`add` → the old content stays staged. Canonical git 2.55 stages the new content in both shapes:
`rm`'s index write sets the entry's cached size to 0 (`git ls-files --debug` shows `size: 0`).

git (`read-cache.c`, v2.55.0):

- `do_write_index` (2902–2903): `if (!ce_uptodate(ce) && is_racy_timestamp(istate, ce))
  ce_smudge_racily_clean_entry(istate, ce);`
- `is_racy_stat` (355–368): racy when `istate->timestamp` — the mtime of the index file as read — is
  not older than the entry's mtime. `is_racy_timestamp` excludes gitlinks.
- `ce_smudge_racily_clean_entry` (2560–2607): `lstat`; if `ce_match_stat_basic` reports any change,
  leave the entry; otherwise if `ce_modified_check_fs` finds different content, set `sd_size = 0`.
- `CE_UPTODATE` is set by `fill_stat_cache_info` (201) on every entry built from a fresh stat, so
  entries this process just hashed are never re-checked.

## Options considered

1. **Smudge in the index-lock commit, approximating `CE_UPTODATE`** — an entry is "not up to date"
   when it is carried over unchanged (same path, id and stat data) from the index as read
   (recommended).
2. **Explicit up-to-date marker** set by every writer on the entries it builds from a fresh stat —
   git's exact model, at the cost of plumbing through every index writer.
3. **Pin the clock in the flaky test only** — leaves the product wrong.

## Decision

**User-ratified — option 1.** Before the index-lock commit serialises the new entries:

- `istate->timestamp` is the mtime of `.git/index` as read: one `lstat` under the lock. No index file
  (the first write) means nothing was read and nothing is racy.
- An entry is checked when it is not a gitlink, is racy against that mtime, and is carried over
  unchanged from the index as read.
- A checked entry whose working file still matches its stat (same mode, mtime, ctime, uid, gid, ino,
  size) has its content compared through the same attribute and clean-filter pipeline `status` uses.
  Different content sets the entry's file size to 0; anything else leaves the entry as is.

## Consequences

- Cost matches git's: one index `lstat` per write, whose result also validates the per-session
  cache of the index as read; an O(N) scan of that index only when some new entry is racy; an
  `lstat` per racy carried-over entry and a hash only when its stat still matches. Measured on the
  medium bench fixture: `add` of one file +1 filesystem call, wall time within noise; `status`,
  which writes no index, unchanged.
- Divergence, recorded here: an entry this process re-hashed and found unchanged (a racy `add` of
  an unmodified file) keeps its stat and id, so it reads as carried over and is hashed a second time
  at write, where git skips it as up to date. The written index is identical; only the extra hash
  differs.
- A corrupt index as read carries no entries over, so nothing is smudged; git refuses to read such
  an index before any write.
