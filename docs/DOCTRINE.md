# Doctrine

Rulings the user made against or beyond a design's recommendation, stated as rules the next
design can apply without reopening the conversation. Each entry cites the ADR that records it.

## D-1 — A pinned same-cut row folds its read side into the run that pinned it

- **Trigger:** a design recommends shipping a pinned backlog item from the same release-order cut separately because its locus is a shared primitive with unpinned routes, while the read-side fix is small and its rows are already pinned.
- **Rule:** fold the pinned read side into the current change with its interop rows; leave the unpinned write routes out until pinned; never park a pinned row behind "needs its own pins" when the pins exist.
- **Evidence:** ADR-1158
- **Counter-cases:** none
