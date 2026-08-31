---
subjects:
  - src/domain/storage/delta-encode.ts
---
# 777 — A delta is accepted only when it is smaller deflated

- **Status:** accepted
- **Date:** 2026-08-31
- **Design:** docs/design/delta-writing-packer.md (DC-11)

## Context

A window search finds the smallest delta against the candidates it tried. That is not the
same question as whether storing the delta is smaller on disk: both the delta and the full
content are deflated before they are written, and deflate does not preserve the ordering of
uncompressed sizes. A delta can be smaller uncompressed and larger compressed.

The whole purpose of this change is that packs stop being larger than they need to be. An
acceptance rule that can emit a larger entry reproduces that failure in miniature.

## Options considered

1. **Exact** — deflate the winning delta and the full content, accept only when the delta plus its header overhead is strictly smaller (chosen) — pros: makes "the pack never grows" a guarantee / cons: one extra deflate per object that already won a search.
2. **Uncompressed-size proxy with a margin** — pros: one deflate / cons: can be wrong in either direction, including emitting an entry larger on disk than the base.
3. **Always emit whatever the search found** — pros: fastest / cons: no size guarantee at all.

## Decision

**User-ratified.** After the window picks a winner, both the delta and the full content are
deflated and compared including entry-header overhead. The delta is emitted only when it is
strictly smaller. Ties go to the base entry, which keeps chains shorter for no size cost.

## Consequences

A deltified pack is provably never larger than the same pack written delta-free, per entry
and therefore in total. The cost is one additional deflate confined to objects that already
survived a window search — a minority of any corpus — and it is paid on the gc path, not on
any read path.
