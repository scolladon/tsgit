---
subjects:
  - test/integration
  - .github/workflows/ci.yml
---
# 1120 — the interop suites target one git version

- **Status:** accepted
- **Date:** 2026-10-29
- **Design:** docs/design/fsck-pack-entry-crc-git-256.md (CI pin, D-CI4) · **Supersedes/Refines:** refines ADR-226

## Context

Issue #311 asked whether the suites should keep a git 2.55 lane while runner images still ship
2.55. Of the 369 rows that diverge between 2.55.0 and 2.56.0, most pin an exit status or a message
that only one version produces, so a second lane needs a second expectation per such row.

## Options considered

1. **One pinned version, no 2.55 lane** — pros: one expectation set, every row reads as a fact
   about the pinned git / cons: a developer on 2.55 sees red locally until they switch.
2. **A nightly 2.55 lane with its own expectations** — pros: coverage of the older runner images
   / cons: every version-sensitive row doubles, and the lane rots the day 2.55 leaves the images.

## Decision

**Adopted-as-recommended (no user judgment): option 1.** The interop suites pin git 2.56.x only.
The pinned version is the constant the setup-git action carries; a developer runs the suites with
a matching local git.

## Consequences

- The contributing notes name the pinned version and how to bump it.
- Moving to the next minor is a deliberate PR that re-pins the diverging rows, never a lane.
