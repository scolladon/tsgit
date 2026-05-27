# ADR-165: Phase 20.2 ships as one bundled PR

## Status

Accepted (at `7d04c08`)

## Context

Phase 20.2 covers three independent primitives — `hashBlob`,
`isIgnored`, and `updateIndex` CRUD verbs. Each could ship as its
own PR (20.2a / 20.2b / 20.2c) for smaller diffs; or all three
could ship together. Splitting reduces per-PR review surface;
bundling reduces workflow overhead (one design doc, one plan, one
review cycle, one docs refresh, one BACKLOG flip).

The three primitives share:

- The same backlog item (`20.2`).
- The same design conversation (the workflow's Step 2 self-review).
- The same downstream consumers in Phase 21 (`stash`, `mv`) — none
  ships until all three primitives land.
- The same docs section (`docs/use/api-primitives.md` — one
  "Phase 20.2" hunk in one PR is less rebase-prone than three
  back-to-back hunks).

Project memory `feedback_branch_workflow.md` notes the preference
for bundled atomic commits inside one branch over micro-PRs. The
8-step workflow in `CLAUDE.md` is built around a single branch
covering one logical unit; splitting 20.2 triples that overhead.

## Decision

Bundle all three primitives in a single PR on
`feat/phase-20-2-standalone-primitives`. Each primitive lands as
its own atomic commit inside the PR (so the implementation history
remains reviewable at the per-primitive granularity). The PR
remains squash-merged on green.

## Consequences

### Positive

- One workflow iteration covers all three primitives.
- One BACKLOG entry flips from `[~]` → `[x]` in one PR's own
  commits (no follow-up flip).
- Atomic per-primitive commits inside the branch keep `git log
  --first-parent` readable post-squash-merge.
- Reviewers see the full Phase 20.2 surface in one place — easier
  to spot inconsistencies across the three primitives.

### Negative

- Larger diff in one PR (estimated ~12 new files + ~6 touched).
  Mitigated by the per-primitive commits — reviewers can step
  through commit-by-commit.
- If one primitive's review surfaces a blocker, the other two wait
  in the same PR. Mitigated by the design pass that explicitly
  decoupled the three at the file level (no shared internals other
  than `serializeAndHash`).

### Neutral

- The squash-merge collapses the per-primitive commits in `main`.
  Atomic granularity survives on the branch ref until cleanup.

## Alternatives considered

- **Split into three PRs (20.2a / 20.2b / 20.2c)** — rejected:
  triples workflow overhead (three branches, three design+plan
  drafts, three review cycles, three doc refreshes) for a phase
  whose three slices share design context. Memory
  `feedback_branch_workflow.md` already documents the bundled
  preference.
- **Just `hashBlob` for now, defer the others** — rejected:
  Phase 21 dependents (`stash`, `mv`) need all three. Deferring
  pushes the dependency chain back without saving net work.
