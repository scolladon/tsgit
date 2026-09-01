---
subjects:
  - src/application/primitives/internal/index-pack.ts
  - src/ports/file-system.ts
---
# 782 — Pass 2 reads at arbitrary offsets through `readSlice`

- **Status:** accepted — **adopted-as-recommended (no user judgment)**
- **Date:** 2026-09-01
- **Design:** docs/design/streaming-index-pass.md (DC-4) · **Supersedes/Refines:** none

## Context

Pass 2 re-reads bases and delta payloads at offsets that jump backwards through the quarantined
pack, where pass 1 only ever moved forward. That is a random-access read pattern against a file
the receive path has already written to disk.

## Options considered

1. **`ctx.fs.readSlice`** (recommended) through the existing `PackByteSource` seam — one
   open/read/close per window fetch on Node.
2. **Hold one `openWithNoFollow(path, 'read')` `FileHandle`** for the whole pass — fewer
   syscalls.
3. Add an optional `FileSystem` capability for scoped random reads, with option 1 as fallback.

## Decision

**Option 1.** Pass 2 reads through `readSlice`, reusing the byte-source seam and its window
ladder.

Option 2 is not portable: `browser-file-system.ts` throws `UNSUPPORTED_OPERATION` for
`openWithNoFollow`, so it would break clone and fetch in the browser unless paired with a
`readSlice` fallback anyway — two code paths for one job. It also re-opens the `FileHandle` GC
leak class this repository has already paid for once, and the port's own documentation warns
that holding handles across async boundaries can leak descriptors on Node. Option 3 is the
honest escape hatch if a measured syscall profile ever demands it, but it is a port change
across three adapters plus the memory fake for a cost nobody has measured.

## Consequences

The indexer stays adapter-neutral, and the memory and browser adapters need no new capability.
The window ladder must learn to grow for a *backward* anchor, which it only ever exercises
forward today; that is a behaviour the pass-2 read-pattern tests pin. If profiling later shows
syscall overhead dominating pass 2, option 3 remains available without changing any caller.
