---
subjects:
  - src/application/commands/name-rev.ts
  - src/domain/name-rev/cutoff.ts
---
# 841 — name-rev's generation cutoff replaces the date cutoff when the target has one

- **Status:** accepted
- **Date:** 2026-09-10
- **Design:** docs/design/closure-history-walks.md (DC-6) · **Supersedes/Refines:** refines ADR-461, ADR-462, ADR-463

## Context

The brief asks for git's `min_generation` cutoff in name-rev "alongside its date cutoff". git's
`commit_is_before_cutoff` (`builtin/name-rev.c`) does not combine them: when the target has a
generation number the generation test is used **instead of** the date test, and the date test
applies only when no generation is known. "Alongside" would prune, on skewed clocks, commits git
visits, and could name them differently.

## Options considered

1. **git's rule — generation replaces the date test when the target has a generation** (recommended, chosen) — pros: the faithful mechanism; no graph means today's date-slop behaviour byte for byte / cons: none.
2. **The brief's wording — prune when either test says so** — cons: not git's mechanism; diverges on skewed clocks.

## Decision

**Adopted-as-recommended (no user judgment).** The pure cutoff helper carries both the slop-adjusted
date and the target's generation; a commit is before the cutoff when the target's generation is
finite and the commit's generation is below it, otherwise when its committer date is below the
adjusted date. The slop rule is unchanged.

## Consequences

No graph: the date branch, identical to today. With a graph: git's own pruning, which differs from
the date heuristic exactly where git's does. A parent outside the graph while the target is inside
has an infinite generation and is traversed, as in git. The visited set changes; the returned name
never does, because a commit with a generation below the target's cannot be the target's descendant.
