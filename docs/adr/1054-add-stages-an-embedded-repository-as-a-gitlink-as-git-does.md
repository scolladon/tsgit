---
subjects:
  - src/application/commands/add.ts
  - src/application/primitives/walk-working-tree.ts
supersedes:
  - adr: "031"
    scope: "an embedded repository is skipped by the walk and never becomes a gitlink"
---
# 1054 — `add` stages an embedded repository as a gitlink, as git does

- **Status:** accepted
- **Date:** 2026-10-23
- **Design:** docs/design/pathspec-glob-dialect.md · **Supersedes/Refines:** supersedes ADR-031 (the embedded-repository scope); refines ADR-1049

## Context

ADR-031 chose, when gitlinks were out of scope, to treat a directory holding a `.git` as opaque:
skipped by the walk, never staged. git's default is different (design rows EM1–EM82, git 2.55):
`git add .`, `add sub`, `add sub/`, a glob or `-A` stage an untracked directory holding a
repository as a `160000` gitlink at that repository's HEAD, printing only a hint; a tracked file
replaced on disk by such a directory becomes a type change to a gitlink; a `.git` that leads to no
repository makes the directory plain, and its files are staged; a repository whose HEAD does not
resolve is refused. `add` now stages gitlinks (ADR-1049), so the premise of the skip is gone, and
the mutation run exposed the gap: the gitlink candidate filter's mode check was observable only
through the type change.

## Options considered

1. **Match git: stage the embedded repository as a gitlink, type-change a tracked file, treat a
   broken `.git` as a plain directory, refuse an unresolvable HEAD** — the designer's
   recommendation.
2. **Keep ADR-031's skip and record the divergence** — leaves a wrong-result in `add` (the
   user's files vanish from the index where git stages a gitlink) and an unkillable mutant.
3. **Stage the gitlink but keep skipping a broken `.git`** — diverges on EM31–EM36.

## Decision

**Ratified by the user — option 1.** An untracked directory holding a repository (a `.git`
directory or gitfile that leads to a repository, by git's non-bare test) is staged as a `160000`
gitlink at that repository's HEAD and reported in `added`; the directory matches a pathspec as
`<dir>/`; nothing beneath it is staged, a literal naming a path inside it stages nothing and is not
refused; a directory with index entries beneath it is walked as before. A tracked file or symlink
replaced by such a directory becomes a type change to a gitlink, ignored or not. A `.git` that
leads to no repository makes the directory ordinary. A selected repository whose HEAD does not
resolve is refused (ADR-1057), after the unmatched-pathspec and tracked-gitlink refusals, naming the
first such directory in path order. Ignore rules prune before the probe, so an ignored repository
goes to the ignored report (ADR-1046). `--renormalize`, `rm` and `checkout` are unchanged.

Superseded from ADR-031: the embedded-repository scope — the walk treating a directory holding a
`.git` as opaque and `add` never creating a gitlink for it.

Carried forward from ADR-031: the symlink rule — the walk never follows a symlink; a symlink leaf
is staged as `120000` with the link target as content (how a `.git` symlink is classified without
being walked through is ADR-1055).

## Consequences

- Every EM row is a cross-tool interop test; the walk gains an opt-in hook (ADR-1059) so `status`,
  `stash` and the public primitive change only where a later decision says so.
- The "adding embedded git repository" hint has no structured analogue (ADR-1056).
