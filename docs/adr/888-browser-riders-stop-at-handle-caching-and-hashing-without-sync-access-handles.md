---
subjects:
  - src/adapters/browser/browser-file-system.ts
  - src/adapters/browser/browser-hash-service.ts
---
# 888 — Browser riders stop at handle caching and hashing, without sync access handles

- **Status:** accepted
- **Date:** 2026-09-22
- **Design:** docs/design/node-io-cold-read-pipeline.md (D9, DC-8) · **Supersedes/Refines:** none

## Context

The browser adapter's `walkToParent` re-resolves every path segment from the root on each call,
and `readSlice` re-resolves the path and calls `getFile()` per slice, so a depth-10 delta chain
is 50 directory round-trips. The hash service renders hex one byte at a time through
`toString(16).padStart` and copies twice in its streaming hasher. The Origin Private File System
also offers `createSyncAccessHandle`, which exists only in dedicated workers and takes an
exclusive lock per file, so a second tab or a second reader fails while it is held.

## Options considered

1. **Directory-handle LRU keyed by parent path, a hex lookup table, a single-copy streaming
   hasher; no sync access handles** — pros: pure call-count and CPU work, testable in
   Playwright / cons: the per-slice `getFile()` remains. *Recommended by the design.*
2. **Option 1 plus a memoised sync access handle per pack in dedicated workers** — cons: a new
   exclusive-lock failure surface that needs its own record and a real-browser host this slice
   does not have.
3. **Defer every browser item** — cons: the measured 50-round-trip chain stays.

## Decision

**Option 1 — adopted-as-recommended (no user judgment).** The browser adapter memoises directory
handles in an LRU keyed by parent path (the `parentRealpathCache` shape), the hash service uses a
precomputed hex table and copies once, and `createSyncAccessHandle` is not used.

## Consequences

- The pack window cache (ADR-882) is where the browser's per-slice cost is recovered; the handle
  cache removes the walk per call.
- Sync access handles remain available as a future decision with their own locking model.
