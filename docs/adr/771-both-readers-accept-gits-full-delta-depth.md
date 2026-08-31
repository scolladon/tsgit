---
subjects:
  - src/application/commands/internal/fsck/object-cache.ts
  - src/application/primitives/object-resolver.ts
---
# 771 — Both delta-chain readers accept git's full depth

- **Status:** accepted
- **Date:** 2026-08-31
- **Design:** docs/design/delta-writing-packer.md (DC-5, section 9)

## Context

tsgit has two delta-chain walkers and they disagree by one hop. The resolver's
`collectDeltaChain` admits a chain of `MAX_DELTA_CHAIN_DEPTH` hops; fsck's `walkDeltaChain`
loops `depth < MAX_DELTA_CHAIN_DEPTH` and refuses at exactly that depth. The constant is set
to git's default `pack.depth`. Nothing had ever written a chain that long, so the
disagreement was latent. A writer honouring `pack.depth = 50` activates it immediately —
measured against git 2.55.0, a text-churn fixture saturates the default cap at exactly 50.

## Options considered

1. **Clamp the writer to 49** — pros: touches no refusal surface; one delta level is an immeasurable size difference / cons: leaves a real reader defect in place and encodes an off-by-one as policy.
2. **Align both readers on git's depth, clamp the writer to 50** (chosen) — pros: fixes the defect at its cause; the writer honours the configured value literally / cons: widens what fsck accepts, which is a faithfulness-relevant change needing its own pin.
3. **Clamp to 49 and file the collision separately** — pros: smallest change now / cons: splits one defect across two changes.

## Decision

**User-ratified.** `walkDeltaChain` becomes `depth <= MAX_DELTA_CHAIN_DEPTH`, so both
readers accept a chain of exactly git's default depth and refuse only beyond it.

The writer clamps to `min(pack.depth, MAX_DELTA_CHAIN_DEPTH)` — that is, to 50. At the
default `pack.depth = 50` this is the configured value unchanged, which is the case that
matters. Above it the clamp binds, and **that is a divergence from git**, recorded here
rather than left implicit: git accepts `pack.depth` up to 4095 and will write chains that
deep, while tsgit will not write a chain its own readers refuse. Raising the ceiling would
mean raising `MAX_DELTA_CHAIN_DEPTH`, which another decision record pins to git's default
`pack.depth` and which also governs what `fsck` accepts — a wider change than a packer, and
not one this record makes. The divergence is silent by construction: it can only ever produce
*less* compression than git at the same setting, never an error, never an unreadable pack, and
never a difference in the objects stored. The widened fsck acceptance is
pinned against real git rather than asserted: a pack written at the cap must pass
`git fsck` and `git index-pack --strict`, and tsgit's fsck must agree with git on the same
pack.

## Consequences

The two readers stop disagreeing, and a pack written at the default depth is readable by
every tsgit path. A `pack.depth` above 50 is honoured only up to 50; a caller who sets one and
measures the result sees weaker compression than git would give, with no other observable
difference. fsck accepts one chain length it previously refused; that widening is a
deliberate correction, pinned by interop, not a side effect.
