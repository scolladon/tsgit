# ADR-087: `cat-file --batch` exposes both a streaming primitive and a collected Tier-1 command

## Status

Accepted (at `cfacf2b`)

## Context

Phase 17.6 of the backlog calls for a `git-cat-file --batch` equivalent
"on the primitive layer for high-throughput readers." Two surface
shapes were considered:

- **Streaming-only (Tier 2):** a primitive
  `catFileBatch(ctx, ids): AsyncIterable<…>`. Composes with the
  `operators/` toolkit, no buffering, mirrors `walkCommits` /
  `walkTree`. Callers who want an array drain it themselves.
- **Handle-style (open/close):** `openCatFileBatch(ctx)` returns
  `{ request(id), close() }`. Closer to git's stdin/stdout protocol,
  ad-hoc submission, but introduces explicit lifecycle and a stateful
  resource — out of step with the rest of the library, which is
  context-bound and disposed via `repo.dispose()`.
- **Both:** keep the streaming iterable as the Tier-2 primitive and
  add a Tier-1 command that collects it into a `ReadonlyArray`.

The streaming form is what high-throughput readers need (no
materialisation cost, back-pressure-friendly). The collected form is
what most application code reaches for, and matches every other Tier-1
command (`submodules`, `log`, `reflog`) which returns
`{ kind, entries }`.

## Decision

Ship both.

- Tier 2 — `catFileBatch(ctx, ids: AsyncIterable<ObjectId> |
  Iterable<ObjectId>): AsyncIterable<CatFileBatchEntry>`. Pure
  stream-to-stream. No buffering. Sequential, input-ordered yields
  (ADR-090). The handle is reachable as
  `repo.primitives.catFileBatch`.
- Tier 1 — `repo.catFile({ ids })` accepts `ReadonlyArray<ObjectId |
  string>`, coerces strings to `ObjectId` via `ObjectId.from` at the
  boundary, drains the primitive, and returns `{ kind: 'batch',
  entries }`. Same collected shape as the other v2 commands.

No stateful "handle" object. A caller who genuinely wants ad-hoc
submission can construct their own `AsyncIterable` (e.g. a queue
fronted by `Promise.withResolvers`) and feed it to the primitive —
that is the canonical TypeScript way to do open-ended streaming.

## Consequences

### Positive

- Streaming substrate is the load-bearing surface — high-throughput
  consumers (indexers, batch processors) get zero-buffering reads.
- The collected Tier-1 form is shape-consistent with `submodules`,
  `log`, `reflog`, etc., so callers don't have to reach for the
  primitive just to drain an iterator.
- No new lifecycle primitive (`open/close`) is introduced. Context
  disposal already governs resource cleanup.
- Strings are accepted on the Tier-1 boundary only — primitives stay
  branded.

### Negative

- Two surface entries (one command, one primitive) means two doc
  entries and two test files. Justified by the dual user need.

### Neutral

- No "handle" object means a caller who wants to stream ids over time
  must wire their own queue. Acceptable: that pattern is small,
  idiomatic, and not something this library should encapsulate
  speculatively.
