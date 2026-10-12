---
subjects:
  - src/application/primitives/internal/blob-source.ts
  - src/application/primitives/stream-blob.ts
---
# 928 — Streamed blob open follows git's per-source stream order

- **Status:** accepted
- **Date:** 2026-10-01
- **Design:** docs/design/alternates-object-lookup.md (DC-16, Pin M5) · **Supersedes/Refines:** refines ADR-509, ADR-226

## Context

git's stream open (`odb.c:istream_source`) gives a pack arm only to a non-delta object above
`core.bigFileThreshold`; any other object falls through every later source — preparing their
pack stores, midx included — before the in-core read serves it. With a corrupt alternate midx,
`git cat-file blob B` therefore dies (exit 128) even when B is packed in the primary (Pin M5).
tsgit's `openBlobSource` resolves per source and would serve B.

## Options considered

1. **Keep tsgit's per-source order, record a divergence** (designer recommendation).
2. **Reproduce git's stream order, fall-through and refusal included** — pros: faithful to refusal conditions (ADR-226).

## Decision

**User-ratified — option 2.** `openBlobSource` reproduces git's stream-open order across
sources, including the fall-through over every later source before the in-core read, so the
same corrupt-alternate faults refuse the same reads. Loose-before-pack precedence within the
in-core read (ADR-509) is unchanged.

## Consequences

- A repository without alternates has one source; the fall-through costs nothing there.
- Interop pin M5 asserts the refusal for `cat-file blob` and its success for `cat-file -t`.
