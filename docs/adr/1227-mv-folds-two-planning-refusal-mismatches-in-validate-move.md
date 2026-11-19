---
subjects:
  - src/application/commands/mv.ts
---
# 1227 — mv folds two planning refusal mismatches in validateMove

- **Status:** accepted
- **Date:** 2026-11-19
- **Design:** docs/design/mv-directory-one-rename.md (N6) · **Supersedes/Refines:** applies ADR-226 and DOCTRINE D-3

## Context

Two pinned refusal mismatches sit in `validateMove`, which this change edits (git 2.56.0, 2/2):

- An existing destination reached through a symbolic link (`mv f inner/keep`, `inner -> sub`): git
  refuses `destination exists`; with `-f` it moves through the link and drops the link's own index
  entry. tsgit refuses `MV_DESTINATION_DIRECTORY_MISSING` in both cases.
- An absent, untracked source (`mv ghost x`): git refuses `bad source`; tsgit refuses
  `MV_SOURCE_NOT_TRACKED`, because it classifies the source before checking it exists on disk.

## Options considered

1. **Fold both into this change**, each with its own unit and interop rows.
2. Record them in `docs/known-divergences.md`.
3. File backlog entries.

## Decision

**adopted-as-recommended (no user judgment)** — DOCTRINE D-3: a pinned refusal mismatch in a
function the change edits is folded and marked breaking.

## Consequences

The changed codes ride the run's breaking marking (ADR-1222). The forced move through a link
follows git's index replacement of the link entry, pinned before implementation.
