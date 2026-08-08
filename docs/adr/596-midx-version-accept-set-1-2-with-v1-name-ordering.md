# 596 — Midx version accept-set {1, 2}, with v1-only name ordering

- **Status:** accepted (adopted-as-recommended, no user judgment)
- **Date:** 2026-08-08
- **Design:** docs/design/midx-read-support.md (DC-5, Pin D)

## Context

git 2.55.0 recognises midx versions 1 and 2 on read and refuses everything else; it
writes 1 by default (`midx.version` unset) while the packfile-format manual page in
the same build already documents 2 as the write default — the doc is ahead of the
binary. Pin D7/D8 isolates the entire v1↔v2 delta: v1 requires `PNAM` lexicographic
order (`fatal: … pack names out of order`), v2 accepts the same bytes unordered.

## Options considered

1. **Accept `{1, 2}`, enforce `PNAM` ordering for v1 only** — git exactly.
2. **Accept `{1, 2}`, never enforce ordering** — accepts a v1 file git refuses; a
   divergence with no upside.
3. **Accept `{1}` only** — refuses files git writes under `midx.version=2`, betting
   against upstream's documented direction.

## Decision

Adopted as recommended: **option 1**, git exactly. The ordering check is one
comparison in a loop that already runs.

## Consequences

`parseMultiPackIndex` refuses versions outside `{1, 2}` (`check: 'version'`, Tier A
per ADR-593) and applies the lexicographic gate only when `version === 1`
(`check: 'pack-names'`). The D7/D8 pair is two unit rows sharing one fixture.
