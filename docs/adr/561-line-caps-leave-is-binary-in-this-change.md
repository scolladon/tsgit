# 561 — The line caps leave `isBinary` too, in this change

- **Status:** accepted
- **Date:** 2026-07-30
- **Design:** docs/design/whitespace-drop-fast-path.md · **Supersedes/Refines:** none

## Context

The last divergence the pinning uncovered is not the drop pass's at all: tsgit reports
`- -` (binary) on `--numstat` for over-cap files where git reports real counts — **on the
plain path, with no whitespace flag involved**. A 70 000-byte line and a 100 001-line file
are text to git, which renders the full hunk and counts the lines. The divergence belongs
to `isBinary`, whose line-length and line-count caps have no counterpart in git's
NUL-in-the-first-8000-bytes heuristic.

## Options considered

1. **Leave it; name it in the design's out-of-scope section, no ticket** — cons: a pinned
   divergence with no owner, which this repository's history argues against.
2. **Fix it here** by taking the line caps out of `isBinary` as well.
3. **File a backlog item** (designer's recommendation) — cons: deviates from the standing
   no-follow-ups default, which is why it was raised as a warn-and-ask rather than
   actioned silently.

## Decision

**Option 2**, ratified by the user in explicit preference to the recommendation, after
the blast radius was stated: `isBinary` also decides `three-way-content`'s merge refusal,
`grep`'s binary skip, `patch-id`, `range-diff` and the `Binary files … differ` patch
surface, and the fix does not complete on its own.

## Consequences

Every `isBinary` consumer named above is in scope for verification, and each needs its
faithfulness checked against real git rather than assumed unchanged — removing a cap that
currently forces "binary" makes previously-unreachable text paths reachable in all five.
The fix also does not finish at `isBinary`: a 100 001-line file would then reach
`diffLines`, exceed `MAX_DIFF_LINES = 50 000` and degrade to `wholeFileFallback` anyway,
so faithful counts require that cap re-examined in the same change — the same cap ADR-560
retires as the arm-disagreement cause, from the other side. `MAX_DIFF_LINES` therefore has
two independent reasons to move in this PR and must be settled once, coherently, not
twice. The design revision determines whether the remaining caps keep any role at all;
if the honest answer is that git's NUL-only heuristic is the whole rule, the design says
so and the caps go, with the memory consequence stated — ADR-558 has already removed the
predicate's dependence on them, so the question is confined to the diff path.
