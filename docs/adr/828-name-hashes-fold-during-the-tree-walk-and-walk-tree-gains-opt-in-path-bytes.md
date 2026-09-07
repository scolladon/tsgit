---
subjects:
  - src/application/primitives/walk-tree.ts
  - src/domain/storage/pack-name-hash.ts
---
# 828 — Name hashes fold during the tree walk, and walkTree gains opt-in path bytes

- **Status:** accepted
- **Date:** 2026-09-07
- **Design:** docs/design/name-hash-delta-ordering.md (DC-3)

## Context

Git's name hash is a fold over the path's bytes. tsgit's tree entries carry `nameBytes` as the
authoritative value and `name` as a derived view whose docblock says it is "never read to make
a decision" — a decoded name is lossy, because an invalid-UTF-8 name decodes to U+FFFD and two
distinct names can collide there.

`walkTree` yields `{ path, id, mode }` where `path` is a decoded string built by concatenation.
So the walker that visits every object gc needs to hash exposes only the lossy view. Hashing
that view would make tsgit's hash disagree with git's for exactly the names the 30.3 tree-bytes
work exists to handle.

A survey of `walkTree`'s fourteen consumers found none reading `nameBytes` through the walker.
The byte-level consumers that exist — `resolve-tree-path`, `walk-submodules`'s `.gitmodules`
lookup, fsck, archive — operate on `tree.entries` directly and are not walks. So the gap is
latent rather than blocking: nothing needs byte-exact paths from `walkTree` today, and nothing
*can* get them.

## Options considered

1. **`walkTree` folds per frame through an optional `PathHasher` and yields `nameHash`** — pros: byte-exact over `nameBytes`; folds in O(1) per entry and never materialises a full path; opt-in, so the other consumers pay nothing / cons: a generic walker learns to fold a pack-specific concern, and the byte gap in its surface stays open.
2. **The closure engine re-encodes the decoded `path` and hashes that** — pros: no walker change / cons: lossy by construction, contrary to the rule that tree-name decisions are made on bytes; two invalid-UTF-8 names collide and neither matches git.
3. **`walkTree` always yields `pathBytes`** — pros: byte-exact and closes the surface gap for everyone / cons: allocates a full path per entry for all fourteen consumers to serve one, and makes the packer allocate every path it hashes — the per-object path residency this design exists to avoid.

## Decision

**User-ratified.** Both halves of a split that options 1 and 3 conflated:

- The hash folds per frame through an optional `PathHasher`, as in option 1. The packer never
  materialises a path; the fold is byte-exact over `nameBytes`; consumers that pass no hasher
  are unaffected.
- Separately and additively, `walkTree` gains an opt-in `pathBytes` option, defaulting off, that
  yields the entry's full path as bytes. This closes the latent gap in the walker's surface for
  any future consumer that must decide on bytes, without putting an allocation on the packer's
  path or on any consumer that does not ask for it.

The packer uses the fold, not `pathBytes`. The two are independent capabilities that happen to
share a motivation.

## Consequences

The hash is correct for every name git can store, including names no decoder round-trips, and
the packer's residency is unchanged — this is the one design choice here that costs nothing on
the hot path.

`walkTree` acquires two options rather than one, and both need their own pins. The `pathBytes`
option ships without a caller, which is scope this entry did not need: it is justified as
closing a documented correctness gap in a public walker rather than as speculative generality,
and if no consumer adopts it the cost is a tested, unused option.

The `PathHasher` seam keeps the pack-specific constant in the domain and gives the walker only
the fold interface, so a second hash version (ADR-829) would be a new hasher rather than a
walker change.
