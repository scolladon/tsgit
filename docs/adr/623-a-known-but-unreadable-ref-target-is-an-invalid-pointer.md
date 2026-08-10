# 623 — A known-but-unreadable ref target is an invalid pointer, not a missing object

- **Status:** accepted (ratified — closes a pre-existing divergence surfaced by this entry)
- **Date:** 2026-08-10
- **Design:** docs/design/rev-index-bitmap-read-support.md (composition matrix) · **Refines:** ADR-226, ADR-575, ADR-579, ADR-585

## Context

The composition rows of this entry's `fsck` interop suite could not assert exit-integer
equality with git, and the cause turned out to predate the entry entirely. Measured against
git 2.55.0, with every other factor held constant:

| ref (or reflog) target | git exit |
|---|---|
| an oid that never existed | **2** |
| an oid whose **loose** object was deleted | **2** |
| an oid **listed in a pack index whose `.pack` is absent** | **10** = 2\|8 |
| an oid **listed in a pack index whose `.pack` will not open** | **14** = 2\|4\|8 |
| an orphaned `.idx` or `.pack` that nothing points into | **0** |

Two intermediate hypotheses were measured and **falsified**, and are recorded so they are not
re-proposed: the extra bit is *not* reflog-entry validation (a reflog naming a never-existing
oid scores 2, and removing all reflogs does not clear it), and it is *not* a broken pack pair
as such (an orphaned `.idx` or `.pack` in an otherwise healthy repository scores 0).

The rule the evidence supports is narrower: git distinguishes **absent** from **known but
unreadable**. An oid a pack index lists is one the object database knows; failing to read it
is a pointer *validity* fault, not a missing-object fault. tsgit's refs pass sees only
`universe.has(oid) === false` and takes the missing-object path for both, so it emits bit 2
alone where git emits bit 2 **and** bit 8.

## Options considered

1. **Distinguish the two conditions** — the refs pass learns which oids are index-listed but
   unreadable, and reports those as an invalid pointer / bit 8 / plus the existing bit 2.
2. **Pin the divergence and carve it out of the requirement** — cheap and honest, but ships a
   known exit-integer divergence in a family the design had already committed to matching.
3. **Defer to a separate entry** — leaves the entry's own requirement unmet.

## Decision

Option 1. A ref or reflog target that is **absent from every source** stays a missing-object
fault (bit 2 alone, unchanged). A target that is **listed by a pack index tsgit could parse
but whose pack it could not read** additionally reports as an invalid pointer and contributes
exit bit 8.

The distinction is drawn from data the registry already holds — the scan's per-pack health and
index faults — so no new probing and no extra syscall is introduced. Crucially it must **not**
be drawn by attempting the read: `universe` membership stays the fast path, and the
known-but-unreadable set is consulted only for oids that already missed.

An orphaned `.idx` or `.pack` that nothing references stays silent (exit 0), which the existing
scan-time exclusion already gives for free.

## Consequences

Closes the entry's own requirement that the exit integer match git on every pinned composition
row, so those rows assert equality rather than documenting a divergence. The change is
observable only in repositories that already have an unreadable pack, so no healthy repository
changes its exit integer — the healthy-control rows are the regression guard.

Bit 2's term is unchanged in every case; bit 8 is strictly additive. This is deliberately
narrower than "any unreadable object": a deleted **loose** object scores 2 under git, so the
known-but-unreadable set is sourced from pack indexes only.
