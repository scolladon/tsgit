# Doctrine

Rulings the user made against or beyond a design's recommendation, stated as rules the next
design can apply without reopening the conversation. Each entry cites the ADR that records it.

## D-1 — A pinned same-cut row folds its read side into the run that pinned it

- **Trigger:** a design recommends shipping a pinned backlog item from the same release-order cut separately because its locus is a shared primitive with unpinned routes, while the read-side fix is small and its rows are already pinned.
- **Rule:** fold the pinned read side into the current change with its interop rows; leave the unpinned write routes out until pinned; never park a pinned row behind "needs its own pins" when the pins exist.
- **Evidence:** ADR-1164
- **Counter-cases:** none

## D-2 — A faithfulness fix is folded whole even when its second half reaches past the command under change

- **Trigger:** a pinned git divergence has one half inside the command's perimeter and one half in a shared primitive every consumer uses (the loose-ref listing, for one), and folding only the inner half leaves the pinned row red.
- **Rule:** fold both halves in the same change, cover the shared half with its own unit rows and an interop pin per affected consumer; a half-fix that leaves the row red is not a fix.
- **Evidence:** ADR-1160
- **Counter-cases:** none
