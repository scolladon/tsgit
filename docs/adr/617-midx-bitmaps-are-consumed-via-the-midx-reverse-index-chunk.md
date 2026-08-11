# 617 — Midx bitmaps are consumed, via the midx reverse-index chunk

- **Status:** accepted (ratified — deviates from the design's recommendation)
- **Date:** 2026-08-09
- **Design:** docs/design/rev-index-bitmap-read-support.md (Pin F, Pin K) · **Refines:** ADR-592, ADR-605, ADR-612

## Context

A multi-pack-index can carry its own bitmap, and git prefers it over per-pack bitmaps when
present. Its bits are **midx pseudo-pack positions**, not pack positions, so consuming it
requires the midx's own reverse-index chunk — which is a chunk **inside** the midx, not a
sibling file. The 28.2 parser walks past that chunk without reading it, and the midx design
recorded the gap as a blind spot. Discovery is by the midx's **stored** trailer bytes: a
midx whose trailer is wrong hides its bitmap entirely (design Pin K rows X7/X10).

## Options considered

1. **`fsck`-verified only; consume per-pack bitmaps** — a working accelerator on the common
   case without a position-mapping layer / leaves git's preferred path unused.
2. **Consume midx bitmaps too** — matches git's preference order and closes the blind spot
   by *using* the chunk / adds a whole position-mapping layer.

## Decision

Option 2. The midx reverse-index chunk is read, pseudo-pack positions are mapped, and a
midx bitmap is consumed when present — matching git's own preference for it over per-pack
bitmaps.

Discovery composes the artefact name from the midx's **stored** trailer bytes rendered as
hex, never from a recomputed digest. That single rule reproduces both pinned oddities with
no special case: a renamed bitmap is simply not found, and a midx with a corrupted trailer
names a file that does not exist — so its bitmap is hidden, the midx bit fires and the
bitmap bit does not.

This closes the 28.2 design's blind spot about the two midx chunks by consuming one of
them, rather than by documenting that it is skipped.

## Consequences

Adds a position-mapping layer between midx pseudo-pack positions and object ids, and makes
the midx bitmap's *discoverability* transitively dependent on the midx trailer's
correctness — a bitmap can be hidden by a fault in a different file. The interop row for
that composition is the one most likely to look like a test bug when it fails, and it is
pinned deliberately. Per ADR-612 this path is ungated by `core.multiPackIndex`, so the
divergence that ADR accepts now reaches the read path, not only `fsck`.
