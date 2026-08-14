# 626 — writePackArtifacts owns assembly and the gate

- **Status:** accepted — **adopted-as-recommended (no user judgment)**
- **Date:** 2026-08-13
- **Design:** docs/design/rev-on-idx-write.md (DC-3)

## Context

The `pack.writeReverseIndex` gate and the `.rev` byte assembly have to live somewhere:
inside `writePackArtifacts` (which then absorbs `buildIdx`/`buildRev` and the config
read), at each call site, or as a minimal positional parameter addition.

## Decision

`writePackArtifacts` absorbs artefact assembly and the config gate, taking an options
object. A future third caller cannot forget the gate; the change retires the existing
`promisor: boolean` positional-parameter smell instead of adding a second boolean; and
callers receive `indexBytes` back rather than recomputing it.

## Consequences

Both existing call sites (`fetch-pack.ts`, `pack-objects.ts`) are refactored to the
options signature in the same change. The gate is unreachable from outside the
assembler, so per-call-site drift is structurally impossible.
