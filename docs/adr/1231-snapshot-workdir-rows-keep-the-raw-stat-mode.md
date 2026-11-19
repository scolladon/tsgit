---
subjects:
  - src/application/primitives/snapshot/workdir-entry.ts
  - src/adapters/snapshot-resolvers/fs-workdir-enumerator.ts
---
<!-- cspell:ignore filemode -->
# 1231 — Snapshot workdir rows keep the raw stat mode

- **Status:** accepted
- **Date:** 2026-11-19
- **Design:** docs/design/core-filemode-false.md (D-D) · **Supersedes/Refines:** refines ADR-249

## Context

`WorkdirEntryRow.mode` and `WorkdirStat.mode` mirror the disk so the snapshot's race detection
covers chmod-only changes. They carry no index entry to act as git's donor and no git verdict.

## Options considered

1. **Keep the raw stat mode, unchanged** (recommended).
2. Apply the `core.fileMode` policy with no donor (`ignored` gives `100644` always).

## Decision

Option 1, **adopted-as-recommended (no user judgment)** — no trade-off: option 2 would hide chmod
races from `verify()` and report a mode git never computes for a row without an index entry.

## Consequences

Snapshot rows still show the exec bit under `core.fileMode = false`; the git-equivalent verdicts
(`status`, `add`) come from the comparison seam, which applies the policy.
