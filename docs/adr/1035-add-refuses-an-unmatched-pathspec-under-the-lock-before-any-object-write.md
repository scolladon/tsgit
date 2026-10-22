---
subjects:
  - src/application/commands/add.ts
  - src/application/commands/internal/resolve-pathspec.ts
---
# 1035 — `add` refuses an unmatched pathspec under the lock, before any object write

- **Status:** accepted
- **Date:** 2026-10-22
- **Design:** docs/design/pathspec-glob-dialect.md · **Supersedes/Refines:** refines ADR-226 (prime directive); none superseded

## Context

git's `add` dies `pathspec '<spelling>' did not match any files` (exit 128) for the first positive
pathspec its directory walk and index did not mark as seen, before `add_files_to_cache` and the
index write: the index is unchanged and the object store holds zero loose objects (B1, B2, B9,
B12). tsgit's `addByPathspec` hashes and writes every walked leaf first and refuses only
literals, after the walk; an unmatched glob is a silent no-op and a refused literal leaves loose
blobs. `resolvePathspec`'s `hasGlob` exists to relax the whole-call check — the behaviour to
replace. Under `--renormalize` git runs no directory walk: only index entries count (RN1, RN2).

## Options considered

1. **Index-seen first, buffered walk only when needed** (designer's recommendation) — under the
   lock: mark every positive entry seen from the index; when all are seen, stream the staging walk
   as today; otherwise run the one walk without hashing, buffering paths and stats, mark seen,
   refuse, then stage from the buffer. Pros: zero loose objects; no cost when the index already
   sees every pathspec; one `readdir` pass. Cons: a buffer on the unmatched-candidate path.
2. **Refuse after the staging walk, before the index commit** — leaves loose blobs; B1/B2 pin
   `loose = 0`.
3. **Always buffer the walk** — pays the walk/hash overlap on every glob `add`.

## Decision

**Adopted-as-recommended (no user judgment) — option 1.** `resolvePathspec` exposes the positive
entries in argument order with their raw spellings; `add` (walk and `--renormalize`) refuses
`PATHSPEC_NO_MATCH` for the first positive entry nothing marked seen, after the index lock and
read and before the first blob write. Seen sources: index entries by match level, then the
non-ignored walk leaves for entries still unseen, then the on-disk escape of ADR-1036. The
whole-tree positive (`.`) is never refused by `add`, as today. The pure-literal fast path keeps
`enforceLiteralMustMatch`.

## Consequences

- B1, B2, B2b, B4, B9, B10b, B12, RN1 and RN2 become interop rows asserting the index and the
  loose-object count.
- `hasGlob` keeps only its dispatch role; the relaxation it carried is gone.
- The staging walk runs unchanged for every call the index already satisfies (B6–B8).
