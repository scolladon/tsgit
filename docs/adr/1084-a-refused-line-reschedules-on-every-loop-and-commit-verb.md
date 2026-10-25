---
subjects:
  - src/application/commands/rebase.ts
  - src/application/commands/internal/rebase-state.ts
---
# 1084 — A refused line reschedules on every loop and commit verb

- **Status:** accepted
- **Date:** 2026-10-25
- **Design:** docs/design/forced-checkout-displace-occupant.md (DC10, DC11, P11) · **Supersedes/Refines:** refines ADR-1083

## Context

ADR-1083 names the interactive continue's pick. The design's A.5 R rows show the same refusal on
every replay loop and every commit verb. Three of them leave tsgit worse off than that row: no
state with HEAD stranded, or a pick replayed twice. A reschedule now keeps `author-script`, so the
existing detection, which keys on its absence, no longer tells a reschedule from a stop.

## Options considered

- **Reach:** (a) every loop and commit verb, meld members and fast-forwards included; (b) everything
  except squash and fixup; (c) only the interactive continue's pick.
- **Detection:** (a) `message` absent; (b) `stopped-sha` absent; (c) the last `done` line equals the
  first todo line.

## Decision

**Adopted as recommended (no user judgment): reach (a), detection (a).** Every case runs through the
same refusal path and writer, and the fold rule covers each one. `readRebaseState` already reads
`message` unconditionally, so the detection guard and that read cannot drift apart.

## Consequences

- A meld retry reads its group back from `current-fixups`.
