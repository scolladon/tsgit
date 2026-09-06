---
subjects:
  - src/ports/file-system.ts
  - test/integration/win-only/node-fs-windows-rename-refusals.test.ts
---
# 822 — Windows ancestor-fault rename reports are documented in their Windows shape

- **Status:** accepted
- **Date:** 2026-09-06
- **Design:** docs/design/memory-write-exclusive-directory.md (DC-N) · **Supersedes/Refines:** refines ADR-811 and ADR-813

## Context

Two `rename` arrangements with a regular file on an ancestor segment report differently on
Windows than on POSIX. A file at the destination's grandparent yields `NOT_A_DIRECTORY` carrying
the destination on POSIX and carrying the source on Windows; a file at the source's parent yields
`NOT_A_DIRECTORY` on POSIX and `FILE_NOT_FOUND` on Windows. Both come from which resolution step
fails first, not from a considered rule. The port's `rename` JSDoc states the POSIX anchoring
flatly, which is false on Windows. The design already ratified, for this family, that each adapter
keeps its own ancestor report.

## Options considered

1. **Document both shapes, pin them in the Windows-only integration file, and correct the port
   JSDoc** (designer's recommendation) — pros: the port text becomes true everywhere and drift
   becomes visible / cons: two platform shapes stay on record.
2. **Normalise them to the POSIX shape inside the adapter** — pros: one shape / cons: a second
   Windows emulation on arrangements no command reaches, for a cosmetic gain.
3. **Leave them undocumented** — cons: a false sentence stays on a public port.

## Decision

**Adopted-as-recommended (no user judgment): option 1.** The `rename` JSDoc describes the
ancestor-fault path as adapter- and platform-chosen, naming the POSIX and Windows shapes of the node
adapter; the Windows-only integration file pins both rows in their Windows shape, with every path
expectation built by `node:path`.

## Consequences

No adapter behaviour changes. A future change to either shape turns a pinned row red instead of
drifting silently. The port keeps the rule that it tells the truth about every platform it runs on.
