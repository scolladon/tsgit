---
subjects:
  - src/application/commands/maintenance.ts
  - src/domain/storage/cruft-pack.ts
supersedes:
  - adr: "724"
    scope: "the gc task's prune-loose semantics (replaced by the cruft-pack lifecycle)"
---
# 731 — gc uses cruft packs

- **Status:** accepted
- **Date:** 2026-08-26
- **Design:** docs/design/perf-remediation-2026-08.md (DC-17) · **Supersedes/Refines:** supersedes ADR-724 (prune semantics only; the command, the commit-graph task and the surface gates stand)

## Context

The gc-lite expansion pinned that git 2.55's default `gc` neither leaves unreachable
objects loose nor deletes them: it writes a **cruft pack** — a pack of the unreachable
objects with an `.mtimes` sidecar — and drops those objects only once they age past the
default two-week expiry. tsgit had no cruft-pack support, so ADR-724's "prune the packed
loose objects" wording could not be git-faithful for unreachable objects.

## Options considered

1. **Reachable-only/additive** (designer recommendation) — pros: safe subset / cons: discharges the midx/`.rev` lifecycle constraints vacuously; diverges from default gc for unreachable objects.
2. **Consolidate à la `repack -A -d`, cruft off** — cons: with a delta-free `buildPack` the repository inflates; still not default-gc behaviour.
3. **Full cruft-pack parity** (chosen) — read + write the cruft pack and its `.mtimes` sidecar, honour the expiry lifecycle. Pros: true default-gc behaviour / cons: by far the largest lift.

## Decision

**User-ratified.** The `maintenance` gc task implements git's default cruft-pack
lifecycle: reachable loose objects pack normally; unreachable objects go to a cruft pack
with an `.mtimes` sidecar in git's documented format; cruft objects older than the
expiry (default two weeks, config-honoured) are dropped on the next gc. Pack-internal
byte layout is not a faithfulness surface (git itself varies it by version and thread
count); the pinned surfaces are which objects live in which file class, the `.mtimes`
sidecar format, file naming, refusal conditions, and the expiry arithmetic — all
interop-pinned against git 2.55.0. The delta-free packer is a documented size trade,
not a correctness divergence.

Superseded from ADR-724: the "prune the packed loose objects" semantics.
Carried forward from ADR-724: the `maintenance` command itself, explicit-only
invocation, the commit-graph task, the structured result shape, the midx-expiry and
`.rev`-sibling constraints (now discharged for real, not vacuously), and the full
Tier-1 surface gate set.

## Consequences

A new domain format (cruft `.mtimes` read + write) with round-trip property tests; the
"tsgit never prunes loose objects" invariant is rewritten where documented; the
maintenance interop suite gains cruft-lifecycle pins (creation, expiry boundary,
`--prune=never` equivalence). The expiry-time source must be injectable for
deterministic tests.
