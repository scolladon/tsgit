---
subjects:
  - src/ports/command-runner.ts
  - src/adapters/node
  - src/application/primitives/internal/run-filter-process.ts
---
# 938 — The command runner gains an optional duplex spawn for long-running filters

- **Status:** accepted
- **Date:** 2026-10-02
- **Design:** docs/design/alternates-object-lookup.md · **Supersedes/Refines:** refines ADR-226, ADR-302

## Context

git starts one long-running `filter.<driver>.process` per driver for a whole command and talks
to it over the v2 filter protocol (pinned: one start for two checked-out files). tsgit's
`CommandRunner.run` is one-shot — all of stdin is written up front and stdout is read at exit —
so tsgit starts one process per path, and a stateful filter observes N starts instead of one.

## Options considered

1. **Optional duplex `spawn(request) → { write, output: AsyncIterable<Uint8Array>, close }` on `CommandRunner`, plus a per-command filter-process pool keyed by driver** (recommended).
2. **Batch every path for a driver into one `run()`** — no port change, but all content in memory and per-file failure ordering differs from git.
3. **Defer and record the divergence.**

## Decision

**User-ratified — option 1.** `CommandRunner` gains an optional `spawn`; the Node adapter
implements it with `child_process.spawn`; memory and browser omit it (a required process driver
with no runner refuses, as git refuses a driver it cannot start). A per-command pool keyed by the
driver's command performs the handshake once, serves every path in git's order, and is closed when
the command finishes.

## Consequences

- One process per driver per command, as git; per-file failures surface at the same file as git.
- The pool's lifetime is bound to the command; an abort closes it.
