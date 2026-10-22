---
subjects:
  - src/application/commands/add.ts
---
# 1045 — An unseen literal naming an unignored path on disk is not refused

- **Status:** accepted
- **Date:** 2026-10-22
- **Design:** docs/design/pathspec-glob-dialect.md · **Supersedes/Refines:** supersedes ADR-1036 (escape scope); refines ADR-1035

## Context

ADR-1036 limited git's `file_exists` escape to wildcard pathspecs, on the premise that an unseen
literal naming something on disk is always the ignored-paths case git reports with its advice and
exit 1 (out of scope). The review pinned a shape that premise misses: an empty directory. Against
git 2.55, `git add e` with an empty directory `e` exits 0 and stages nothing, and `git add e 'k*'`
exits 0 and stages `k`; tsgit refused both with `PATHSPEC_NO_MATCH 'e'`, staging nothing — a
refusal-condition and index-state divergence. git's own check is
`(magic & PATHSPEC_GLOB) || !file_exists(path)`, where `PATHSPEC_GLOB` is the `:(glob)` magic, so
the escape covers every pathspec whose spelled path exists. A literal naming an ignored path is
the one shape where git still fails: it collects the ignored matches, prints the advice and exits 1
(the index may still take the other pathspecs' matches). That report is not built yet.

## Options considered

1. **Escape every pathspec whose spelled path exists, literal or wildcard** — git's exact check.
   Pros: the empty directory matches git. Cons: an ignored literal turns from a wrong-coded
   refusal into a silent success until the ignored-paths report exists, hiding git's exit 1.
2. **Escape literals only when the path is not ignored** (review recommendation, adopted) — the
   empty directory matches git (exit 0); an ignored literal keeps refusing `PATHSPEC_NO_MATCH`
   until the report lands, so git's failure stays visible. Cons: the interim refusal still carries
   the wrong code, and a literal of other pathspecs beside an ignored literal still refuses the
   whole call where git stages the rest.
3. **Keep the wildcard-only escape** — the empty-directory divergence stays.

## Decision

**Adopted on review evidence (no user judgment) — option 2.** `add`'s walk refusal accepts an
unseen pathspec whose spelled path exists on disk when it is a wildcard, or a literal whose path
ignore rules do not hide; a trailing-slash literal exists only as a directory. A literal naming an
ignored path, file or directory, is still refused.

Superseded from ADR-1036: the escape applying to wildcard pathspecs only, and the premise that an
unseen on-disk literal is always the ignored-paths advice case.

Carried forward from ADR-1036: the `file_exists` escape itself for wildcards, probed with one
`lstat` on the refusal path only; the ignored-literal advice (exit 1, the paths listed, the rest
still staged) stays a pinned follow-up and is the only remaining divergence on this guard.

## Consequences

- The empty-directory rows are cross-tool interop tests; the ignored-literal rows keep their
  refusal until the advice report lands and then re-pin to it.
- `add --renormalize` already applied the escape to literals (its pinned rows RN4/RN5); the walk
  route now agrees except for the ignored-literal interim.
