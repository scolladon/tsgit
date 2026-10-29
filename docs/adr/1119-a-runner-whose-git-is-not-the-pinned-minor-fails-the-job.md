---
subjects:
  - .github/actions/setup-git
---
# 1119 — a runner whose git is not the pinned minor fails the job

- **Status:** accepted
- **Date:** 2026-10-29
- **Design:** docs/design/fsck-pack-entry-crc-git-256.md (CI pin, D-CI3) · **Supersedes/Refines:** refines ADR-1117

## Context

Once git is provisioned (ADR-1117, ADR-1118), the runner may still resolve to another minor: the
PPA moving to 2.57, an image bump on macOS or Windows, or a stale apt cache. Issue #311 is what a
silent version change looks like: 369 rows red with no code change.

## Options considered

1. **Fail the job, printing the found version** — pros: one pinned version, one expectation set;
   a drift is a loud, attributable failure / cons: an unrelated PR goes red on the day the channel
   moves.
2. **Warn and continue** — pros: no red from a channel move / cons: the suites then run against
   an unpinned oracle and a red row cannot be told from a drift.

## Decision

**Adopted-as-recommended (no user judgment): option 1.** The setup-git action parses
`git --version` into `major.minor`; when it differs from the pinned constant the step fails with
`::error::expected git <pin>.x, found <version>`. Every run echoes the resolved version into the
job log.

## Consequences

- A channel move blocks merges until the pin is bumped and the rows re-pinned, in one PR.
