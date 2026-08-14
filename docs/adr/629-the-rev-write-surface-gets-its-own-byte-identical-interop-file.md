# 629 — The rev write surface gets its own byte-identical interop file

- **Status:** accepted — **adopted-as-recommended (no user judgment)**
- **Date:** 2026-08-13
- **Design:** docs/design/rev-on-idx-write.md (DC-6) · **Refines:** ADR-140

## Context

The `.rev` faithfulness pins need an interop home: a new file, folding into
`packfile-interop.test.ts`, or extending `rev-bitmap-fsck-interop.test.ts`.

## Decision

A new `test/integration/rev-write-interop.test.ts` declaring
`interopSurface: packRevIndex`. The `.rev` is a **byte-identical** contract — git
regenerates it as a pure function of the pack (Pin C) — while the `packfile` surface is
`equivalent-under-readback`; folding them into one surface name would conflate the two
kinds inside the write-surface audit. The read/`fsck` interop file's fixtures are all
mutation rows, the wrong vocabulary for a write pin.

## Consequences

One `@writes` surface ⇒ one interop file naming it; the audit allowlist stays empty.
The file reuses `interop-helpers.ts` and `rev-bitmap-fixture-helpers.ts` rather than
introducing a third fixture vocabulary.
