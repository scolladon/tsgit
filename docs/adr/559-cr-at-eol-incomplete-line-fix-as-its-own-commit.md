# 559 — The incomplete-line CR divergence is fixed as its own ordered commit

- **Status:** accepted
- **Date:** 2026-07-30
- **Design:** docs/design/whitespace-drop-fast-path.md · **Supersedes/Refines:** none

## Context

Pinning the terminator rule uncovered a third divergence in the same family, in the
opposite direction. For `x y\r` → `x y`, git under `--ignore-cr-at-eol` **keeps** the file
and tsgit **drops** it: git's `--ignore-cr-at-eol` ignores a CR only immediately before a
real newline, so a CR ending an *incomplete* final line is significant. Under `-w`, `-b`
and `--ignore-space-at-eol` the same CR *is* dropped by both tools, because there it is
ordinary trailing whitespace. tsgit's `applyCrRule` / `digestContentEnd` strip a trailing
CR regardless of termination — stricter than git under the three whitespace modes (no
observable difference) and **looser** under `--ignore-cr-at-eol` alone (an observable
wrong drop). It was not in scope when ADR-554 fixed the fix ordering.

## Options considered

1. **Fix it in this PR as its own ordered commit with its own ADR and interop row**
   (designer's recommendation).
2. **Fold it into the terminator-fix commit** — same two functions, same eol-boundary
   family. Defensible purely on locality.
3. **File it; this PR ships the other fixes only.**

## Decision

Adopted-as-recommended (no user judgment): **option 1**. Approximately four lines of
`src`, with its fixture already pinned.

## Consequences

Option 3 is hard to justify against the standing no-follow-ups default for a four-line
fix whose fixture already exists. Option 1 over option 2 because ADR-554's whole argument
is that each verdict change must be its own visibly-flipping diff — folding a second rule
into the terminator commit is exactly the merge that argument rejects, and the two rules
are independent (one concerns the terminator, the other a CR before it). The commit is
sequenced immediately after the terminator fix purely because it touches the two
functions that fix just changed and therefore rebases cheapest there; it carries no
dependency on the cap work and could be swapped with it at the cost of rebase noise only.
