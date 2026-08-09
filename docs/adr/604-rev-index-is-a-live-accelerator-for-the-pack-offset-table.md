# 604 — The reverse index is a live accelerator for the pack offset table

- **Status:** accepted (ratified — deviates from the design's recommendation)
- **Date:** 2026-08-09
- **Design:** docs/design/rev-index-bitmap-read-support.md (DC-2, §D7)

## Context

`buildOffsetTable` sorts every pack's entry offsets to build, in memory, exactly what a
`.rev` file already holds on disk. The sorted array feeds `nextOffsetForEntry`, which
decides where a packed entry's compressed data ends — consulted on every packed object
read. `git repack` writes `.rev` by default, so the file is present in essentially every
repository git has maintained. The design priced the swap honestly as O(n log n) → O(n)
bought with one extra file read per pack, and warned it could be a net loss on
repositories with many small packs.

## Options considered

1. **Live** — `buildOffsetTable` consumes a usable `.rev` / adds a correctness surface and
   an unproven perf claim.
2. **Dark** (designer's recommendation) — the parser ships, used only by the `fsck` pass /
   leaves the one real consumer unserved.
3. **Live behind an opt-in flag** — keeps the exposure while guaranteeing the fast path is
   under-exercised.

## Decision

Option 1. When a usable `.rev` is present, `buildOffsetTable` gathers
`sortedOffsets[p] = entryOffsets(index)[revIndexPositionAt(rev, p)]` in O(n) instead of
sorting. Absent, unreadable or refused `.rev` falls back to the existing sort — the
fallback is the correct answer, so no result ever depends on the artefact's presence.

The perf claim is **measured, not asserted**: an absolute wall-clock bench (main versus
branch) sourced from the CI nightly artefact, covering both a many-object and a
many-small-packs shape. A measured regression is a defect to fix in this PR, not a
reason to defer the arm.

## Consequences

Introduces the read-path degradation arm the design's §D6 says would otherwise not exist:
a per-artefact positive allow-list over `TsgitError.data.code`, never a bare `catch`.
Pairs with ADR-606, which settles whether the loaded body is trusted.
