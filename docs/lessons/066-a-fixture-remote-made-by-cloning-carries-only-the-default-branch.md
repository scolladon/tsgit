---
subjects:
  - test/integration/**
phases: [planning, implementation, review]
kind: gotcha
trigger: an interop fixture builds a second remote with `git clone` and a row expects that remote to carry a branch other than the default one
evidence:
  - test/integration/checkout-remote-branch-dwim-interop.test.ts
  - docs/design/checkout-remote-branch-dwim.md
source: { run: checkout-remote-branch-dwim, phase: implementation, date: 2026-11-27 }
status: active
supersedes: []
last-verified: 2026-11-27
---
# 066 — A fixture remote made by cloning carries only the default branch

## Context

The remote-branch guess needs rows where two remotes carry `feat`. The plan built the second
remote, `otherUp`, as `git clone up`, and fetched it into the base as `other`. A clone checks
out the default branch only: `feat` exists there as `refs/remotes/origin/feat`, not as a branch,
so fetching `other` produced no `refs/remotes/other/feat`. Six rows written to prove two-remote
behaviour (the default remote's choice, the ambiguity refusal, the tracking ambiguity that
strands a branch) passed for four parts while only one remote matched. A later part's guard row
failed, and only then was the fixture fixed with `git branch feat origin/feat` in the clone.

## Lesson

A row passing is not evidence that its fixture holds the state the row's title claims. A
cloned fixture repository carries remote-tracking refs, not branches, for everything except its
default branch, and a remote pointed at it fetches only its branches.

## How to apply

After building an interop base, assert the refs the rows depend on exist, in both copies, before the first row runs.
When a remote must carry a branch, create the branch in the source repository before fetching (`git branch <name> origin/<name>` in a clone).
A row about "two remotes" asserts that both matched (git's advice lists them), not only the outcome.

## Evidence

`test/integration/checkout-remote-branch-dwim-interop.test.ts` — the `beforeAll` that builds
`otherUp`, with the `git branch feat origin/feat` step the fixture needed, and the ambiguity
rows that now compare tsgit's remotes with git's `hint:` lines.
`docs/design/checkout-remote-branch-dwim.md` — the fixture description ("+other … holding `feat`
and `only-other`") the clone did not meet.
