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

Option 1, **bounded by pack size**. `buildOffsetTable` gathers
`sortedOffsets[p] = entryOffsets(index)[revIndexPositionAt(rev, p)]` in O(n) instead of
sorting — but only for a pack carrying at least `REV_INDEX_MIN_OBJECTS` objects. Below the
threshold the artefact is never opened at all. Absent, unreadable or refused `.rev` falls
back to the sort, as does every gated-out pack — the fallback is the correct answer, so no
result ever depends on the artefact's presence.

The perf claim is **measured, not asserted**: an absolute wall-clock bench (main versus
branch), covering both a many-object and a many-small-packs shape. A measured regression is
a defect to fix in this PR, not a reason to defer the arm.

The regression this ADR anticipated was real, and the threshold is what that rule produced.
Two fixes landed before it and both moved the crossover: the loader dropped its pre-read
`stat` in favour of one bounded read (the per-pack cost is fixed, so halving it mattered
most exactly where the accelerator was losing), and the fallback stopped sorting through a
JS comparator callback — `TypedArray.prototype.sort` is numeric by definition, the same job
canonical git does with a radix sort. The second was decisive: it made the sort arm fast
enough to beat the gather outright on a 3,000-object pack, which had been the accelerator's
win case. Measured per pack, `.rev` present versus deleted:

|   objects | `.rev` | sort  | winner        |
|----------:|-------:|------:|---------------|
|     3,000 |  0.494 | 0.416 | sort  +18.8%  |
|    10,000 |  0.648 | 0.820 | `.rev` +20.9% |
|    20,000 |  0.933 | 1.472 | `.rev` +36.6% |
|    40,000 |  1.412 | 2.913 | `.rev` +51.5% |

With the gate in place a present `.rev` costs nothing below the threshold: the
3,000-object pack measures 0.449 ms with the artefact against 0.466 ms without, and 64
small packs measure 10.66 ms against 10.74 ms — indistinguishable, where ungated they were
51.6% apart. `pack-offset-table.bench.ts` pins both shapes, artefact present and deleted.

The crossover moves with a machine's I/O-to-CPU ratio, so the constant is tuned rather than
derived. Being slightly wrong is cheap by construction: a value near the crossover is a
value where the two arms cost the same. It is the far side that this decision is about.

## Consequences

Introduces the read-path degradation arm the design's §D6 says would otherwise not exist:
a per-artefact positive allow-list over `TsgitError.data.code`, never a bare `catch`.
Pairs with ADR-606, which settles whether the loaded body is trusted.
