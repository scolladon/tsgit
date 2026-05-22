# ADR-081: Lazy-fetch is wired through a `PromisorRemote` port on `Context`

## Status

Accepted (at `aef8dc2`)

## Context

Automatic lazy-fetch (ADR-079) must trigger from `readObject`, a Tier-2
primitive. The fetch machinery — ref discovery, the retrying transport
pipeline (`withDefaults`) — lives in the command tier
(`src/application/commands/`). The `primitives-cannot-import-commands`
dependency-cruiser rule forbids a primitive importing the command tier, so
`readObject` cannot call a `fetchMissing` command directly.

Options:

- **Move the fetch machinery down to the primitive tier.** Relocating
  `discoverRefs` and `withDefaults` touches `clone`, `fetch`, and `push` — a
  wide, risky refactor outside 17.4's remit.
- **Inline a minimal discovery + retry in a `fetch-missing` primitive.**
  Duplicates protocol plumbing the command tier already owns — a DRY
  violation.
- **Invert the dependency with a port.** The primitive depends on an
  *interface*; the command tier provides the *implementation*; the facade
  injects it. This is exactly how `hooks?: HookRunner` already works —
  `runHook` is a primitive, `HookRunner` is a port, the Node adapter / facade
  supplies the implementation.

## Decision

Add a `PromisorRemote` port (`src/ports/promisor.ts`) and an optional
`Context.promisor?: PromisorRemote` field. `readObject` calls
`ctx.promisor?.fetch(...)` on a miss. The implementation
(`createPromisorRemote`) lives in the `fetch-missing` command and is wired
onto the `Context` by `openRepository`.

`openRepository` builds the frozen `Context`, then assigns the promisor
implementation, which closes over that same `Context` via a late-bound
binding — sound because `ctx.promisor.fetch` is only ever invoked after
`openRepository` has returned.

The port is wired unconditionally (partial and non-partial repos alike); the
implementation self-gates on `extensions.partialClone` config and reports
`attempted: false` on a non-partial repo, so `readObject` falls through to its
normal `OBJECT_NOT_FOUND`.

## Consequences

### Positive

- Respects the hexagonal layering: the dependency points inward (primitive →
  port), the command tier satisfies the port, the facade injects it. No
  dependency-rule violation, no downward refactor.
- Mirrors the established `HookRunner` pattern — a reviewer already knows the
  shape.
- `readObject` stays decoupled from *how* a fetch happens; the port could be
  re-implemented (a different transport, a test double) without touching the
  primitive.

### Negative

- The `Context` grows another optional capability field. Consistent with the
  existing `config?`, `logger?`, `hooks?` optionals, but the aggregate keeps
  widening.
- The late-bound closure (port implementation capturing a `Context` that
  itself holds the port) is a small two-step construction wrinkle in
  `openRepository`.

### Neutral

- A `PromisorRemote` implemented in the command tier rather than an adapter is
  slightly unusual for a "port", but the port models an application-level
  capability (a fetch use-case), not a platform service — dependency
  inversion, not platform abstraction.
</content>
