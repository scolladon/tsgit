# ADR-159: Inner-join as a separate function, not overloaded mode

## Status

Accepted (at `1c35bc3`)

## Context

Spike v2 modelled the inner/outer distinction as a `mode` option on `join`:

```typescript
declare function join<S>(sources: S, opts?: { mode?: 'outer' } & ...): AsyncIterable<OuterJoinRow<S>>
declare function join<S>(sources: S, opts:  { mode:  'inner' } & ...): AsyncIterable<InnerJoinRow<S>>
```

Review pass 2 (architect H1) caught the trap: TypeScript overload resolution
discriminates on **literal** types. The overload works when `mode` is supplied
as a literal:

```typescript
join(sources, { mode: 'inner' })  // ✅ narrows to InnerJoinRow<S>
```

But silently breaks when supplied via a variable:

```typescript
const opts = { mode: 'inner' }    // mode widens to `string`
join(sources, opts)               // ❌ falls into outer overload; slots all optional
```

Documenting "always pass options as literals" hides a foot-gun behind a
convention. Inner-join callers care about all-slots-required semantics —
silently getting all-optional rows defeats the purpose.

## Decision

Two distinct functions, one purpose each:

```typescript
declare function join<S>(sources: S, opts?: JoinOptions): AsyncIterable<OuterJoinRow<S>>
declare function innerJoin<S>(sources: S, opts?: JoinOptions): AsyncIterable<InnerJoinRow<S>>
```

No `mode` parameter. Narrowing works regardless of how options are passed.

## Consequences

### Positive

- No literal-type trap. `innerJoin(sources, opts)` types correctly whether
  `opts` is a literal or a variable.
- The function name signals the operation; imports tell you which join you got.
- Smaller per-function type signature; no overload resolution to read.
- Compose with `pipe()` like any operator; no special treatment.

### Negative

- Two exports instead of one. Trivial.
- Future left/right outer joins would also be separate functions (`leftJoin`,
  `rightJoin`). Easy to follow; no pattern divergence.

### Neutral

- Inner-join is rarer than outer in real workloads (`status`, `diff`, `untracked`
  all want outer). Promoting outer to the bare name signals the default.
