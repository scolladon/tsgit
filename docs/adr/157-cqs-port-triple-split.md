# ADR-157: CQS port-triple split for write-event tracking

## Status

Accepted (at `1c35bc3`)

## Context

ADR-150 introduces generation-tracking for cache invalidation. The original
spike v2 design used a single port:

```typescript
interface WriteEventBus {
  emit(scope: WriteScope): void                       // writer side
  subscribe(listener: (scope: WriteScope) => void): Disposable  // reader side
}
```

Problem (review pass 2 H3): every write-boundary primitive (`updateIndex`,
`recordRefUpdate`, `writeObject`, …) must depend on `WriteEventBus` to call
`emit()`. By the same import, they also have access to `subscribe()` — which
is a *read* concern (the cache adapter subscribes to know when to invalidate).

The split is a CQS violation. Write primitives can accidentally `bus.subscribe(...)`
and smuggle read concerns into write code; the type system doesn't catch it.

## Decision

Three separate port interfaces, each strictly one responsibility:

```typescript
// Command side — write primitives depend on this ONLY.
interface WriteEventEmitter {
  emit(scope: WriteScope): void
}

// Subscribe side — cache adapters depend on this ONLY.
interface WriteEventStream {
  subscribe(listener: (scope: WriteScope) => void): Disposable
}

// Query side — read primitives depend on this ONLY.
interface GenerationView {
  current(scope: WriteScope): number
}
```

A single concrete adapter (`InMemoryWriteEventBus`) implements all three;
DI registers it three times under three port keys. A primitive that needs
to do both must declare both deps — the compiler shows the mistake at the
type signature.

## Consequences

### Positive

- Strict CQS. Write primitives can't subscribe; cache adapters can't emit.
- Compiler catches accidental coupling. A reviewer doesn't have to scan
  for `subscribe()` calls in writer code.
- Each port is single-responsibility, single-method (or single-purpose).
  Easy to mock, easy to test.
- Same concrete adapter implements all three — no runtime overhead, no
  duplicate state.

### Negative

- Three interfaces instead of one. Boilerplate cost is small (one interface
  declaration per).
- DI wiring requires three port registrations. Mitigated by a single helper
  function `wireWriteEventBus(adapter)` that registers all three.

### Neutral

- Same pattern applies to future event-driven coordination (e.g., a
  `ConfigChangeEmitter` / `ConfigChangeStream` split if config-reload
  invalidation lands).
