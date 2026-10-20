---
subjects:
  - src/application/primitives/object-resolver.ts
  - src/application/primitives/read-object.ts
  - src/application/commands/internal/fsck/object-cache.ts
  - src/domain/storage/delta.ts
supersedes:
  - adr: "771"
    scope: "the reader cap at git's default depth and the writer clamp at 50 that served it"
---
# 1019 — Readers accept any delta depth; two guards terminate the walk

- **Status:** accepted
- **Date:** 2026-10-20
- **Design:** docs/design/lift-delta-chain-read-cap.md (DC-1, §2) · **Supersedes/Refines:** supersedes ADR-771 (reader cap and the writer clamp that served it) · refines ADR-786 (closes the index-but-cannot-read gap it recorded)

## Context

`MAX_DELTA_CHAIN_DEPTH = 50` binds tsgit's three delta-chain readers — the object resolver,
`readObjectMetadata`'s header walk and fsck's stored-type walk. The constant is git's *writer*
default (`pack.depth`); git's read path has no cap. Pinned against git 2.56 and 2.55 (design §1):
`git fast-import --depth` accepts up to 8 191 and wrote a 4 999-deep chain that `cat-file` reads
and `fsck --full` passes; the issue's own repro (`fast-import --depth=100`) reads in git and
refuses in tsgit with `DELTA_CHAIN_TOO_DEEP: delta chain too deep: 51`. A downstream CI repo
fails every read (sfdx-git-delta#1507). The cap is also the only thing that terminates two
malformed shapes: a zero-distance OFS_DELTA (git refuses it as an unreadable object) and a
REF_DELTA cycle (git never terminates — full CPU, growing RSS). With the cap removed and no
guard, tsgit loops on the first shape until heap exhaustion.

## Options considered

1. **No cap; termination by two structural guards** (recommended) — G1 refuses an OFS_DELTA of
   distance 0; G2 refuses a REF_DELTA hop to a base id already visited in this walk. Pros: every
   pack git reads, tsgit reads; every walk terminates (design §2: an OFS run strictly lowers the
   offset, so an infinite walk repeats a REF base id); OFS-only chains allocate nothing. Cons: a
   REF cycle's refusal is a divergence by necessity (ADR-1021).
2. **Hard bound at 8 191 on top of the guards** — pros: defence in depth at fast-import's maximum /
   cons: refuses a well-formed pack `index-pack` accepts (ADR-786 pinned 1 000 with no ceiling), a
   knowing divergence that buys nothing G2 does not already give.
3. **Keep 50, add a knob** (the issue's suggestion) — pros: smallest diff / cons: keeps the defect
   as the default; git has no such key, and a tsgit-only option whose only use is to undo a
   refusal git never makes is the shape ADR-226 forbids.

## Decision

**User-ratified: option 1.** No reader applies a depth cap. All three walkers apply the same two
guards and give the same answer for the same pack: G1 refuses a zero-distance OFS_DELTA
(ADR-1022), G2 refuses a REF_DELTA hop to a base id this walk already hopped through (ADR-1020,
ADR-1021). `MAX_DELTA_CHAIN_DEPTH`, `assertChainDepthWithinCap` and every depth assertion are
deleted.

Superseded from ADR-771: the reader cap at git's default depth and the writer clamp at 50 that
served it — readers accept any depth; the writer's ceiling is re-decided by ADR-1023.

Carried forward from ADR-771: the two header walkers and the resolver agree on one answer, and a
pack tsgit writes at the default depth is pinned against `git fsck` and `git index-pack --strict`.

## Consequences

Every pack git reads, tsgit reads (R1), pinned by interop at the issue's depth and past git's
`pack-objects` ceiling. ADR-786's "index but cannot read" gap closes. A legitimately deep chain
can still be aborted at every level through `checkAborted`. REF recursion costs heap, not stack:
measured at 100 000 REF hops without `RangeError`, because each hop awaits. The guards are the
only terminators, so each gets its own isolated test per walker; ADR-471's "tsgit refuses
deeper" rationale is restated by ADR-1026.
