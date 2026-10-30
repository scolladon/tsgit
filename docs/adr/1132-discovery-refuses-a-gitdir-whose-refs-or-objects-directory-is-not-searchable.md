---
subjects:
  - src/repository/find-layout.ts
  - src/ports
---
# 1132 — discovery refuses a gitdir whose refs or objects directory is not searchable

- **Status:** accepted
- **Date:** 2026-10-30
- **Design:** docs/design/fsck-broken-ref-chain-unreadable.md (DC-3) · **Plan:** docs/plan/fsck-broken-ref-chain-unreadable.md · **Supersedes/Refines:** refines ADR-226

## Context

git 2.56.0 refuses `not a git repository` (exit 128) when `refs/` is mode 000 or 0400 or `objects/` is mode
000, and accepts `refs/` at 0300 or 0100. tsgit opens all of them.

## Options considered

1. **An optional `LayoutProbe.isSearchable?`, checked for `refs/` and `objects/`** (planner's recommendation).
2. **`refs/` only** — cons: leaves the `objects/` gap proven and open.

## Decision

**Ratified by the user: option 1.** Discovery refuses a candidate gitdir whose `refs/` or `objects/` is not
searchable, as git does. The probe is optional on the port; an adapter without it keeps today's behaviour.

## Consequences

- The Node adapter implements the probe; memory and browser adapters do not need it.
