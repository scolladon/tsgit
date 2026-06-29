# 432 — notes uses git's full faithful fanout (byte-for-byte at all N)

- **Status:** accepted
- **Date:** 2026-06-28
- **Design:** docs/design/notes.md · **Relates:** ADR-226 (git-faithfulness prime directive), ADR-249 (structured data only)
- **Decision class:** D-faithfulness (user judgment)

## Context

A notes ref points to a commit whose tree maps each annotated object's OID → a note blob.
git keeps that tree **flat** (full-40-hex entry names) until a point, then reorganizes it into a
recursive **one-byte fanout** (`XX/` directory + 38-hex leaf). Probing real git 2.54.0, the
flat→fanned flip is **distribution-dependent and sticky**: it landed at N=80 for one input set
and N=99 for another, and removing notes back below the flip does **not** collapse it. The
notes-commit SHA therefore depends on the exact tree layout, which depends on git's fanout
algorithm and the operation history.

This is git's in-memory 16-way nibble-trie + `determine_fanout` heuristic (`notes.c`): the
fanout deepens by one byte at an even trie level only when **all 16 nibble-slots are populated
branches** (every nibble bucket holds ≥2 colliding notes) — a coupon-collector condition that
explains the distribution-dependent N≈80–99 flip, and the stickiness (untouched sibling subtrees
stay lazy placeholders that keep re-satisfying the test on rewrite).

How faithful do we go on **write**?

## Options considered

1. **Full faithful fanout port** *(user choice)* — replicate git's nibble-trie, insert/split,
   removal-consolidate, lazy-subtree load, and `determine_fanout` exactly; byte-for-byte
   identical notes-commit SHAs at **all N** and across add/remove/force sequences. Largest
   effort; the risk is subtle SHA drift, mitigated by exhaustive twin-tool interop fuzzing.
2. **Flat write + read-any, refuse over a cap** — byte-faithful only below a conservative cap;
   refuse a write that would cross git's flip. Shippable but caps the feature and diverges
   (by refusal) from git on large notes refs.
3. **Flat-only, cannot read fanned trees** — rejected: cannot interoperate with real-world
   large notes refs git produced.

## Decision

**Option 1 — full faithful fanout, ratified by the user.** tsgit reimplements git's notes
fanout behaviour so the notes tree, commit, and ref are byte-for-byte identical to canonical git
at every N and for every operation sequence, both reading and writing.

**Licensing boundary (hard constraint):** tsgit is MIT, git is GPL-2.0. The implementation is an
**original TypeScript reimplementation of the observed behaviour** — git's `notes.c` was read
only to understand the algorithm; no source is copied. Behaviour/algorithms are not
copyrightable; the specific C expression is. The faithfulness is pinned by interop tests against
the real `git` binary, not by code lineage.

**Safety net:** a twin git/tsgit interop test drives the **same operation sequence** in both
tools (order matters — fanout is history-dependent) and asserts equal notes-commit / tree / blob
OIDs across: the flat region, the flip region (N≈70–110, per input), deep multi-level fanout
(hundreds), add→remove→add stickiness, force-overwrite, and a preserved non-note tree entry.

## Consequences

### Positive
- No divergence and no refusal: the prime directive (ADR-226) holds for notes at all scales;
  tsgit reads and writes notes refs interchangeably with git.

### Negative
- Substantial implementation: the nibble-trie, lazy subtree loading, the `determine_fanout`
  heuristic, removal consolidation, and bottom-up fanned-tree writing — each pinned by interop.
- History-dependence means tests must replay operation sequences, not just assert on a final set.

### Neutral
- Note content is still stored verbatim (ADR-431); this ADR concerns only tree *shape* fidelity.
