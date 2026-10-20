---
subjects:
  - src/domain/storage/delta-policy.ts
---
# 1023 — The writer clamps pack.depth at git's 4095 ceiling

- **Status:** accepted
- **Date:** 2026-10-20
- **Design:** docs/design/lift-delta-chain-read-cap.md (DC-5, §4) · **Supersedes/Refines:** refines ADR-1019; closes the divergence ADR-771 recorded

## Context

`resolveDeltaPolicy` clamps a configured `pack.depth` to `min(depth, 50)`. ADR-771 chose 50 so
the writer never wrote a chain its own readers refused, and recorded the clamp above 50 as a
knowing divergence: git honours `pack.depth` up to 4 095 and above that clamps with
`warning: delta chain depth <n> is too deep, forcing 4095` at exit 0 (pinned in
`docs/design/delta-writing-packer.md` §1c). With the readers uncapped (ADR-1019), the reason for
50 is gone and the only remaining clamp is git's own.

## Options considered

1. **Clamp at 4 095, silently** (recommended) — pros: git's own `pack-objects` ceiling; closes
   ADR-771's divergence; silent as the 50 clamp already is, since ADR-249 leaves no channel for
   rendered diagnostics / cons: a caller setting a depth above 4 095 learns of the clamp only by
   measuring the pack, exactly as with git's warning absent.
2. **Leave at 50** — pros: no writer change / cons: keeps a divergence that no longer protects
   anything; a caller setting `pack.depth` above 50 gets weaker compression than git with no
   other observable difference.

## Decision

**User-ratified: option 1.** `resolveDeltaPolicy` clamps `maxDepth` to a named constant equal to
4 095. `DEFAULT_PACK_DEPTH = 50` stays: it is git's documented default and unchanged under both
options. `MAX_DELTA_CHAIN_DEPTH` then has no reader and is deleted.

## Consequences

A pack written at `pack.depth = 100` carries chains between 51 and 100, pinned against
`git fsck --full` and `git index-pack --strict`. The boundary is pinned at 250 → 250,
4 095 → 4 095 and 4 096 → 4 095. This part is hotfix-optional: it is safe only once the readers
accept the depth it writes.
