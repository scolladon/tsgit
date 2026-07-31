# 558 — An incremental O(1) digest fold replaces per-line buffering and the caps

- **Status:** accepted
- **Date:** 2026-07-30
- **Design:** docs/design/whitespace-drop-fast-path.md · **Supersedes/Refines:** refines ADR-551 and ADR-552

## Context

git has no line-length cap and no line-count cap: a 70 000-byte line and a 100 001-line
file are plain text to it, and its only text/binary heuristic on this path is
NUL-in-the-first-8000-bytes. tsgit's `MAX_LINE_BYTES = 65 536` and `MAX_LINES = 100 000`
mark such a side binary, and a binary side is never dropped — a pinned prime-directive
divergence. `MAX_LINE_BYTES` is however a genuine denial-of-service bound: on the
streaming arm it is the only thing stopping an unbounded single line being buffered
whole, times 32 concurrent pairs times two sides. Faithfulness requires the caps stop
deciding the verdict; the question is what protects memory afterwards.

## Options considered

1. **Verdict-free caps + a streaming-arm-only bound**, tripping into an `overflow` step
   that escalates to a materialised comparison (designer's recommendation) — pros:
   smallest change, keeps ADR-551's scanner exactly as specified; worst case equals git's
   own memory posture / cons: keeps a cap, an escalation path and a second code route.
2. **Delete the cap from the predicate outright** — cons: a genuine security regression;
   32 concurrent pairs × 2 sides × an unbounded line, where a minified bundle is the
   ordinary case, not the adversarial one.
3. **Make the in-line digest fold incremental** (tentative/committed hash pair) so no
   line is ever buffered — pros: O(1) memory on **both** arms, no cap anywhere, no
   escalation path, no second route; the strongest available answer to both the
   faithfulness and the memory question at once / cons: rewrites the four digest folders
   ADR-551 specified as moving verbatim and deletes `takeLine`, reopening that decision
   one commit after it was taken.

## Decision

**Option 3**, ratified by the user in explicit preference to the recommendation, and with
the reopening of ADR-551 understood and accepted. No line is buffered on either arm; the
caps stop deciding the verdict and no replacement bound is needed, because there is
nothing left to bound.

## Consequences

This **refines ADR-551**, whose "the bodies … move verbatim apart from `await`/`Promise`
removal" clause no longer holds for the digest folders or `takeLine`. ADR-551's actual
decision — one synchronous chunk-fed scanner, in `src/domain/diff/`, driving both arms —
stands unchanged and is in fact strengthened: the scanner becomes O(1) in memory as well
as single-sourced. It also **refines ADR-552**: several of the five hand-proven
equivalent-mutant dispositions lose their subject when the constructs holding them are
deleted, which converts part of that decision into its own option B ("delete the
constructs that needed them") by consequence rather than by choice. ADR-552's standing
requirement is unchanged and now binds harder — **no proof is carried forward
unexamined**; the disposition table is re-derived against the incremental fold in the
design revision, and a proof whose construct no longer exists is deleted rather than
re-anchored. Because the rewrite changes the scanner ADR-551 describes, it lands **inside**
the scanner part rather than after it; building the scanner twice would be waste.
`line-diff.ts`'s own use of the caps — the actual diff, not the drop pass — is a
legitimately separate question, settled by ADR-561.
