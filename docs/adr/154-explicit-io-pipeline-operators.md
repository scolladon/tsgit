# ADR-154: Explicit-I/O pipeline operators, not async-getter properties

## Status

Accepted (at `1c35bc3`)

## Context

isomorphic-git models entry data access as async getter methods:
`entry.type()`, `entry.mode()`, `entry.oid()`, `entry.content()`. All four
look identical at the call site. Only some trigger I/O:

- `entry.type()`, `entry.mode()` — usually cached, sync-ish.
- `entry.oid()` on a tree entry — cached after first call.
- `entry.oid()` on a **workdir** entry — silently hashes the file from disk.
- `entry.content()` — pulls the blob.

Result: perf cliffs hidden behind property access. Reading isomorphic-git
walker code, you cannot see which calls do I/O without consulting docs (or
reading the implementation). The user has no concurrency knob; everything
is serial unless they hand-roll batching.

## Decision

Two-tier I/O surface, both explicit:

1. **Entry methods that name their I/O.** Sync properties for data already
   in memory (`entry.oid`, `entry.mode`, `entry.path`). Async methods with
   I/O-suggestive names (`entry.hash()`, `entry.read()`, `entry.readLink()`,
   `entry.verify()`). One async call per entry per method.

2. **Pipeline operators for batched I/O.** `hashWorkdir({concurrency: 16})`,
   `loadBlob('head', {concurrency: 8, maxInflightBytes: 64 * 1024 * 1024})`,
   `verify('workdir', {onRace: 'emit'})`. Stages compose via `pipe()`,
   visible in the pipeline graph, concurrency-bounded, cancellable.

A code review reading a snapshot+join pipeline can see every byte that gets
hashed or read. No surprises.

## Consequences

### Positive

- I/O cost is visible in code. No hidden perf cliffs.
- Batching + concurrency knobs available without hand-rolling.
- Pipeline operators compose with existing `src/operators/` (pipe, filter,
  map, take).
- This is the core anti-iso-git decision the spike is built around.

### Negative

- Power users used to `entry.oid()` shorthand on workdir must rewrite to
  `await entry.hash()` or `hashWorkdir()`. Migration recipe in docs.
- Two ways to do I/O per entry (entry method vs. pipeline stage) — could
  confuse newcomers. Mitigated: docs lead with pipeline stages as the
  recommended path; per-entry methods are the escape hatch.

### Neutral

- Domain rows (`TreeEntryRow`, `IndexEntryRow`, `WorkdirEntryRow`) carry NO
  I/O methods — pure data. Application entries (`TreeEntry`, etc.) extend
  the row with methods. Domain layering preserved (see spike §4.3, §10).
