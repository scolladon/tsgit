# 510 — Persistent per-pack FileHandles owned by the pack registry

- **Status:** accepted
- **Date:** 2026-07-27
- **Design:** docs/design/close-isogit-perf-gap.md · **Supersedes/Refines:** none

## Context

Each delta-chain step calls `readSlice`, which performs containment-check + open + zero-filled alloc + read + full copy + close per call — a 43-deep OFS chain issues 43 sequential FD lifecycles, keeping cold delta-chain `readBlob` at ~4× git's cost. Jointly, the spike observed consumer processes that should exit without an explicit `dispose()`; any persistent-handle design must not keep the event loop alive. Idle Node `fs.FileHandle`s do not ref the libuv loop (only pending requests, sockets, watchers, and un-`unref()`'d timers do).

## Options considered

1. **Persistent per-pack FileHandle owned by the registry (recommended)** — pros: removes the per-step open/close via the existing `FileHandle` port; disposed with the repo; exit-without-dispose holds because idle fds don't ref the loop / cons: fds live until dispose or process exit.
2. **Windowed per-pack byte cache (mmap-window analogue)** — pros: also removes syscalls / cons: memory-bounding complexity on multi-GB packs.
3. **Persistent handles + (packPath, offset) intermediate base cache** — pros: sibling chains also benefit / cons: more surface; the target-id delta-cache read already covers the warm case.

## Decision

**Option 1 (user-ratified).** The pack registry owns one lazily-opened `FileHandle` per pack, used by the chain walk for all slice reads, closed by `dispose()`. Any future idle-close timer must itself be `unref()`'d. `readSlice`'s zero-fill alloc and full copy are trimmed alongside (allocate exactly `bytesRead`, no double copy).

## Consequences

Cold chain walks pay one open per pack, not per step. A process that never calls `dispose()` still exits (regression-tested via a child process). Commits the `FileHandle` port to being implemented by all adapters that register packs; fd lifetime is bounded by repo lifetime.
