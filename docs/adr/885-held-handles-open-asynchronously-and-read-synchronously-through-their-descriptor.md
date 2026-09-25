---
subjects:
  - src/adapters/node/node-file-system.ts
---
# 885 — Held handles open asynchronously and read synchronously through their descriptor

- **Status:** accepted
- **Date:** 2026-09-22
- **Design:** docs/design/node-io-cold-read-pipeline.md (D3, DC-5) · **Supersedes/Refines:** refines ADR-879

## Context

A pack or HEAD is opened once through `openWithNoFollow(_, 'read')` and then read many times;
the delta-chain read is 44 `FileHandle.read` calls for a 43-deep leaf. The perf review's measured
patch kept the `fs.promises` open and moved only the reads to `fs.readSync` on the handle's
descriptor. A fully synchronous `openSync` would save one hop per open but returns a raw
descriptor with no garbage-collection close, and this repository has already paid once for a
`FileHandle` leak class.

## Options considered

1. **Async `open`, sync `read` and `fstat` through `handle.fd`** — pros: the measured shape;
   keeps `FileHandle`'s GC-close safety net / cons: one async hop per open remains. *Recommended
   by the design.*
2. **Fully sync raw descriptor wrapped in the port `FileHandle`** — pros: one hop fewer per open
   / cons: a forgotten `close` becomes a silent descriptor leak.
3. **Async everything on handles** — cons: the 44 `pread` calls stay 10 µs each.

## Decision

**Option 1 — adopted-as-recommended (no user judgment).** Read handles keep the asynchronous
`fs.promises` open; their `read` and `stat` use `readSync` and `fstatSync` on `handle.fd` under
the turn budget. Write handles stay fully asynchronous. A `close` cannot race a sync read because
the read completes within one JS turn and `RegisteredPack.close` already drains its in-flight set.

## Consequences

- The pack header, size and every window load (ADR-882) go through the held handle, so a pack is
  opened once instead of three times.
- The descriptor-leak safety net is unchanged; a fully synchronous open needs its own record if
  a measurement ever justifies it.
