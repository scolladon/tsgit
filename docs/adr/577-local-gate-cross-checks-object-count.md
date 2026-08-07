# 577 — The local gate cross-checks objectCount against the idx

- **Status:** accepted (adopted-as-recommended, no user judgment)
- **Date:** 2026-08-07
- **Design:** docs/design/pack-v3-read-compliance.md · **Supersedes/Refines:** refines ADR-572

## Context

Git's `open_packed_git_1` validates, in order: length, signature, version, then the
header's object count against the `.idx`'s count, then (lazily) the trailing checksum
agreement. The 12-byte probe ADR-572 introduces already contains the count, and
`PackIndex.objectCount` is already parsed.

## Options considered

1. **Header only** (signature + version) — the minimum the brief scopes.
2. **+ count comparison** (designer's recommendation) — git's very next check at the same
   site; a comparison, not I/O; a pack/idx count disagreement is exactly the corruption
   that later makes `nextOffsetForEntry` mis-bound an entry.
3. **+ count + trailer checksum** — needs one more digest-length read plus exposing the
   idx's recorded pack checksum; never reported as a gap; a clean follow-on.

## Decision

Adopted as recommended: the gate validates signature, version, and that the header's
`objectCount` equals the paired index's `objectCount`. A mismatch is a skippable pack
fault under ADR-575. The trailer-checksum comparison stays out of scope.

## Consequences

One more free faithfulness property with zero I/O cost. The count-mismatch case gets its
own isolated unit test (guard-clause isolation rule) so its mutant dies independently.
