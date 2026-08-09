# 603 — Full read support for both pack auxiliary artefacts

- **Status:** accepted (ratified — deviates from the design's recommendation)
- **Date:** 2026-08-09
- **Design:** docs/design/rev-index-bitmap-read-support.md (DC-1) · **Refines:** ADR-572, ADR-586

## Context

The design's consumer census concluded that `.bitmap` has no consumer in tsgit and
recommended a verify-and-report-only scope: parse and hash both artefacts solely to
produce `fsck` findings, leaving the read path untouched. That census was incomplete —
`enumeratePushObjects` and `enumerateBundleObjects` are reachability closures, which is
precisely what a pack bitmap encodes. The scope question is therefore not "is there a
consumer" but "how much of the enabled capability do we build now".

## Options considered

1. **Verify-and-report only** (designer's recommendation) — pays the whole faithfulness
   debt (two `fsck` exit bits) and nothing else / leaves a real acceleration and two
   enabled commands unbuilt.
2. **Verify-and-report + `.rev` acceleration** — adds the one consumer the census found /
   still ships no bitmap capability.
3. **Full read support** — both `fsck` arms, the `.rev` accelerator, an EWAH parser, and
   real bitmap consumers / substantially larger, and imports the EWAH allocation hazard.

## Decision

Option 3. Both artefacts are parsed, verified and **consumed**. The entry ships: the
`.rev` `fsck` pass (exit bit 64), the `.bitmap` `fsck` pass (exit bit 128), the live
`.rev` accelerator, an EWAH bitmap parser, and bitmap-backed reachability feeding two
new commands (ADR-613, ADR-614).

Nothing in this entry is deferred to a follow-up. Where a capability is excluded it is
excluded **permanently and with a stated reason** (ADR-614's exclusions), never
postponed.

## Consequences

Commits us to the EWAH allocation mitigations (ADR-611) becoming binding rather than
theoretical, and to two new Tier-1 command surfaces with their full surface tax. The
design doc's consumer census (§D1) and Out-of-scope section are superseded by the
revision authored against this ADR range.
