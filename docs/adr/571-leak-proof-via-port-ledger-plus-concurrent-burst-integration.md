# 571 — Leak proof via port-level ledger plus a concurrent-burst integration scenario

- **Status:** accepted
- **Date:** 2026-08-01
- **Design:** docs/design/pack-registry-single-flight.md · **Supersedes/Refines:** none

## Context

The fix needs a test seam that proves "exactly one scan, zero outstanding handles after
`dispose()`" under a concurrent burst — the workload the Node 26 crash report describes.
The existing closest analogue, `test/integration/dispose-free-exit.test.ts`, asserts
`ACTIVE_HANDLES_DELTA=0` for a **sequential** workload and passes today: the current
suite is structurally blind to this bug.

## Options considered

1. **Unit-only** — a `ctx.fs` wrapper ledger counting `openWithNoFollow`/`close` plus a
   gated `readdir`, over the memory adapter — proves the memo logic but never touches a
   real file descriptor.
2. **Option 1 + a concurrent-burst scenario in `dispose-free-exit.test.ts`** asserting
   `ACTIVE_HANDLES_DELTA=0` against real Node fds (designer's recommendation) — the
   one-line delta between the existing sequential scenario and a burst is exactly the
   regression; reuses the file's whole apparatus (built entry point, mkdtemp repo,
   `git gc`, baseline-delta measurement).
3. **Option 1 + an `lsof`/`process.report` fd-counting integration test** —
   platform-fragile where `process._getActiveHandles()` is already in use.

## Decision

Adopted-as-recommended (no user judgment): **option 2**.

## Consequences

The unit ledger (shared `handle-ledger.ts` fixture, replacing five hand-rolled copies)
makes every lifecycle-matrix row observable through the `FileSystem` port — no fs module
mocking. The integration scenario pins the consumer-visible guarantee on real
descriptors; its `@proves` header gains the new scenario so the test-pyramid detector
keeps passing, and no new tier entry is needed because no new file is created.
