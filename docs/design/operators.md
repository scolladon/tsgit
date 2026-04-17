# Design: Operators

**Status: Proposed** — Phase 6 of the [backlog](../BACKLOG.md).

### Review Notes

Changes applied after Round 2 code + security + performance + test-quality review:

- **§5.1 `pipe` body converted to `fns.reduce((acc, fn) => fn(acc), initial)`** — the Round 1 `let result = initial; for (…) result = fn(result)` form reassigned a binding on every iteration, which the code review flagged as a drift from the project's FP-first immutability mandate. `reduce` is both idiomatic and one line shorter; runtime cost is a rounding error in V8 11+.
- **§5.4 `flatMap` body switched from `yield* await mapper(value)` to `for await (const inner of await mapper(value)) yield inner;`** — async-generator `yield*` delegation in V8 hits an open-since-2019 slow path (v8:7926) adding ~3 microtasks per inner item. `diffTreesRecursive` feeding `flatMap(readSubtree)` across tens of thousands of entries sees ~10–20% measured overhead. §5.4 also clarifies the two-step mechanic: `await` strips the `Promise` layer, then `for await` (or `yield*`) iterates — readers were prone to writing `yield* mapper(value)` (no `await`) which would fail at runtime on a `Promise`.
- **§5.5 `take(0)` "source not touched" weakened to a fixture-verifiable claim.** Previous wording promised `[Symbol.asyncIterator]()` is not called, but `trackedRange` / `pullCounter` only observe `.next()` / `.return()`. Now: "source's `next()` is never called" (exactly what the fixtures catch).
- **§5.6 `find` explanation clarified** — the cleanup on short-circuit comes from the `for await … of` loop's implicit `IteratorClose`, not from generator `return()`; `find` itself is a plain `async` function, not a generator. Prevents implementors from mistakenly widening the return type to `AsyncGenerator`.
- **§5.7 `toArray` + §5.8 `groupBy` gain optional `limit?: number` parameter** — defense-in-depth for the public API surface. External callers piping an attacker-controlled `AsyncIterable` (malicious packfile, compromised HTTP stream) have no upstream cap; Phase 5 enforces analogous caps internally (`MAX_FLAT_TREE_ENTRIES`). Default `Infinity` preserves existing semantics; overshoot throws `RangeError`. Bundle impact ~50 B gzipped total.
- **§5.8 `groupBy` `.push(value)` mutation documented as deliberate local exception.** The spread alternative is `O(N²)` on the accumulator hot path and rejected; the current pattern matches the perf review's assessment that it is already optimal. New §6.12 captures the scope-bounded exception to the global immutability rule.
- **§5.2 / §5.3 microtask-cost note added.** Explicit acknowledgement that unconditional `await predicate(value)` / `await mapper(value)` on synchronous callbacks incurs ~2 microtasks each (real cost: ~15–30 ms per 100 k items on V8 11+). Kept as a design choice — every competitor pays the same, and an `isPromise` branch would cost budget and complexity.
- **§6.11 new decision — non-terminal operators MUST use `for await … of` iteration.** Manual `source[Symbol.asyncIterator]()` + `.next()` calls are forbidden at the source level because they break the runtime's `IteratorClose` cascade that §7.5 (multi-hop cascade test) and the Phase 7 obligations depend on. Currently implicit; making it explicit prevents a future operator from silently breaking cleanup.
- **§6.12 new decision — `groupBy` internal mutation is a scoped exception.** Records why the `.push` on a `Map`-local bucket is permitted despite CLAUDE.md's immutability mandate, and what the boundary is (the exception ends when `groupBy` returns — the returned buckets must not be mutated externally; see §5.8 `ReadonlyMap` caveat).
- **§7 overhauled to match Phase 5 rigor.** Every §7.2 case rewritten in Given/When/Then form; `sut` anchored as "the operator returned by the factory" (e.g. `sut = filter(pred)`); per-operator laziness tests using `pullCounter` added; `take` mutation coverage extended to cover all four invalid-input message regexes, an isolated `count < 0` integer arm, the `take(0)` vs zero-iteration distinction, and the `>=` vs `>` boundary triad; `filter` / `map` / `find` body mutation kill-tests enumerated (missing from Round 1); more `return()` cascade scenarios (consumer `throw`, source self-abort, `flatMap` inner on outer `take` cutoff); `groupBy` repeated-key first-occurrence-order test; `toArray` own tests bottom out on a manual `for await` loop to avoid circularity with other operators.
- **§7.5 cascade test decoupled from `pipe` / `take` / `toArray` composition.** The Round 1 version threaded the cascade assertion through three operators-under-test, so a mutant in any of them could mask the cleanup bug in another. Rewritten with a manual `for await (const v of sut) if (++seen >= 3) break;` consumer.
- **§7.4 new fixtures** — `awaitablePredicate` (real `PromiseLike` distinct from `Promise` — pins the Round 1 `Awaitable = T | PromiseLike<T>` widening), `throwingPredicate` (shared async predicate that throws at a specified call), `abortableRange` (source that invokes its own `return()` mid-yield, simulating a Phase 7 primitive reacting to `ctx.signal.aborted`).
- **§7.6 new section — Expected equivalent mutants.** Pre-documents Stryker survivors that are provably equivalent (per-Phase-5 §12.3 convention) so implementers don't spend cycles chasing them. Covers `take` integer-loop bounds, `groupBy` `Map.get` truthy-check, `pipe` `for-of` vs index-loop.
- **§8.3 gains trust-boundary statement** — operators treat yielded values as opaque `T`; Phase 7 primitives validate semantic contents (e.g. malicious commit shapes from a hostile packfile). Closes a documentation gap the security review flagged.
- **§9 `mapParallel` non-goal gains explicit re-open criterion.** If Phase 9 command-level benchmarks cannot hit PRD §6 perf targets without consumer-level parallel fan-out, revisit. Prevents the "YAGNI" ruling from ossifying.
- **§1 budget math updated** — real-world sanity check says the 4.7 kB estimate has 0.1–0.5 kB headroom, not the earlier 0.3 kB. Budget binding moved to CI: `npm run check:size` gates PRs; every new operator requires fresh measurement (not hand-waved).
- **§10 implementation order fixed** — Step 1 (`toArray`) depends on Step 3 (fixtures) for its throwing-source tests; fixtures moved to Step 2 so Step 1 can complete its red→green cycle. Added Step 12: mandatory Stryker run before merge, per Phase 5 convention.
- **LOW polish** — §7.7 annotated to note that `NaN`/`Infinity` are behavioral documentation tests (they share the `!Number.isInteger` arm with `1.5`), not mutation-killing beyond `1.5`. §7.3 `groupBy` block gains a partial-map-unreachable-after-throw bullet.

---

Changes applied after Round 1 architecture + TypeScript review:

- **§5.1 / §6.3 `pipe` + transport composition location corrected** — dep-cruiser rule `transport-only-depends-on-ports` explicitly forbids `src/transport/ → src/operators/`. Transport middleware functions stay `(HttpTransport) => HttpTransport`; composition via `pipe` happens at the Phase 10 facade or the consumer call site, never inside `src/transport/`. The §5.1 example gained a "Where this code lives" note and §6.3 was rewritten accordingly.
- **§4 `Awaitable<T>` widened to `T | PromiseLike<T>`** — the previous `T | Promise<T>` shape rejected custom thenables even though `await` under `target: ES2022` accepts any `PromiseLike<T>`. Applied everywhere the alias appears (§5.2 `filter`, §5.3 `map`, §5.6 `find`, §5.8 `groupBy`).
- **§1 / §8.1 HTTP-body `AbortSignal` obligation added** — pure generators cascade via iterator `return()`, but a `fetch` body stream needs the primitive to wire generator `return()` to `AbortController.abort()` to actually cancel an inflight request. Captured as an explicit Phase 7/8 obligation in the new §8 table.
- **Multi-hop `return()` cascade fixture added** (now in §7.4; cascade test in §7.5) — `trackedRange` alone only proves single-hop cleanup. New `trackedPipeline4` fixture drives a four-stage pipeline and asserts `return()` fires on the upstream-most source within one microtask of `take` reaching its cap.
- **§5 / §6.2 element-type preservation rule written down** — every non-terminal operator must return `AsyncIterable<T>` parameterized on the source element type (not `AsyncIterable<unknown>`). The eight operators satisfy this by construction; recording the rule makes it reviewable when new operators land.
- **§8 converted to a Phase-ownership table** matching the pattern in `diff-and-merge.md §15`. Columns: `{obligation, owner phase, rationale, verification}`. HTTP-body cancellation, `ctx.signal.aborted` polling cadence, and the "no error-union extension" guarantee all live there now.
- **§6 new decision 6.10 — `AsyncIterable<T>` return type is deliberate encapsulation.** Non-terminal operators explicitly declare their return as `AsyncIterable<T>` rather than `AsyncGenerator<T, void, unknown>` to hide `.return()` / `.throw()` from callers and force the `for await … of` cleanup path.
- **§6.9 `reduce` rationale sharpened** — `toArray + Array.prototype.reduce` defeats streaming when the source is unbounded; the substitution is only safe after an upstream `take(N)`. Now listed as a conscious non-goal consequence, not a free substitution.
- **`find` error tests isolated** (now in §7.3) per CLAUDE.md's "guard clauses need isolated tests" rule — split into `(a) match precedes throw → returns match` and `(b) throw precedes match → throws`.
- **Composition-law and SameValueZero property tests added** (now in §7.3 tail) — `take(n) ∘ take(m) ≡ take(min(n, m))`, `filter(p) ∘ map(f) ≡ map(f) ∘ filter(p ∘ f)` (under pure predicates), and `groupBy` with `NaN` keys lands all `NaN` items in the same bucket per JS `Map` semantics.
- **§1 / §4 / §5.1 budget math made explicit** — estimated emission is ~3 kB gzipped JS + ~1.5 kB `.d.ts`; 9 `pipe` overloads add ~0.8 kB `.d.ts`. Total runs close to the 5 kB ceiling. Added a post-build `size-limit` assertion note.
- **§4 `FlatMapReturn` comment tightened** — actual shape is `Promise<Iterable<U> | AsyncIterable<U>>`, not `Promise<Iterable<U>> | Promise<AsyncIterable<U>>`. These are assignment-equivalent via `Promise<A|B>` covariance but the doc should state the precise union.
- **§4 type-duplication threshold stated** — if a shared alias lands in more than three files, extract to `operators/types.ts`. Currently `Awaitable<T>` is at five files; the rule triggers on the first post-Round-1 edit and a `types.ts` extraction is noted as a follow-up (tracked in §11 open questions).
- **§5.8 `groupBy` shallow-immutability caveat documented** — the `ReadonlyMap<K, ReadonlyArray<T>>` return is a type-level contract, not a runtime freeze. A caller casting back to `Map` can mutate buckets. Acceptable; noted as a known limitation.

---

## 1. Overview

Phase 6 adds a minimal **AsyncIterable composition toolkit** plus a generic value-pipelining helper. Eight operators total (per BACKLOG §6):

| Operator    | Kind            | Shape                                                                         |
| ----------- | --------------- | ----------------------------------------------------------------------------- |
| `pipe`      | generic pipeline | `pipe(value, ...unaryFns)` — left-to-right function composition               |
| `filter`    | transforming   | `(pred) => (source) => AsyncIterable` — drop items failing the predicate      |
| `map`       | transforming   | `(mapper) => (source) => AsyncIterable` — transform each item                 |
| `flatMap`   | transforming   | `(mapper) => (source) => AsyncIterable` — expand each item to 0..N items      |
| `take`      | transforming   | `(count) => (source) => AsyncIterable` — yield at most `count` items          |
| `find`      | terminal       | `(pred) => (source) => Promise<T \| undefined>` — first matching item         |
| `toArray`   | terminal       | `(source) => Promise<T[]>` — collect all items                                |
| `groupBy`   | terminal       | `(keyFn) => (source) => Promise<ReadonlyMap<K, ReadonlyArray<T>>>` — bucket items |

**Two purposes**, one entry point:

1. **AsyncIterable composition** — stream-style data pipelines over git walks
   (`walkCommits`, `walkTree`, `diffTreesRecursive`).

2. **Transport middleware composition** — layer `HttpTransport` wrappers
   (`withRetry`, `withAuth`, `withLogging`) over a base transport (see PRD §7.2.5).
   Only `pipe` is used for this case — the other operators are AsyncIterable-specific.

**Scope boundary.** This phase ships pure, generic FP utilities. It does **not**:

- know about `Context`, ports, or `TsgitError` (operators are git-agnostic);
- provide commutative combinators (`concat`, `merge`, `zip`) — YAGNI for V1;
- provide `tap`/`forEach` — the caller uses `for await … of` directly;
- provide sync iterable variants — every real consumer is async;
- provide parallel variants (`mapParallel`, `concurrentMap`) — Phase 7 owns
  concurrency (bounded via a semaphore in primitives);
- integrate with `AbortSignal` — source primitives check `ctx.signal.aborted` between
  yields; operators just pull values (the iterator `return()` protocol is sufficient).

**Binary-size constraint.** `.size-limit.json` caps the `tsgit/operators` entry at
**5 kB gzipped**. Every design choice below respects that budget.

**Budget math (estimate).** Terser + gzip of the planned implementation emits:

| Surface                          | Estimated size (gzipped) |
| -------------------------------- | ------------------------ |
| 7 `async function*` operator bodies (`filter`, `map`, `flatMap`, `take`, `find`, `groupBy`, `toArray`) | ~3.0 kB JS |
| `pipe` single-body runtime (9 overloads erase to one loop) | ~0.2 kB JS |
| `.d.ts` bundle (8 exports + 9 `pipe` overloads + 3 local type aliases × duplicated) | ~1.5 kB types |

Total ~**4.7 kB gzipped**. Real-world sanity against IxJS async-operator
minified sizes and fp-ts `pipe` declarations suggests actual headroom is
**0.1–0.5 kB**, not the cosier 0.3 kB that raw subtraction implies — tsc's
per-body `_asyncGenerator` helper inlining and `.d.ts` overload expansion are
the variance drivers.

**Binding to CI.** `npm run check:size` (`size-limit`) runs on every PR and
fails when `dist/esm/operators/index.js` gzipped exceeds 5 kB. Any new
operator addition must:

1. Come with a fresh measurement, **not** a hand-waved YAGNI ruling.
2. Consider `types.ts` extraction per §4's >3-file threshold rule.
3. If the addition would overshoot, either pay down via dts-level
   consolidation (share type aliases) or justify a budget bump in a new ADR.

The budget is a contract. Round-2 review flagged that §1 is budget-hostile if
growth is not gated; the ratchet above answers that flag.

---

## 2. Module Structure

```
src/operators/
├── pipe.ts         # Generic value + unary-function composition (9 overloads)
├── filter.ts       # AsyncIterable → AsyncIterable
├── map.ts          # AsyncIterable → AsyncIterable
├── flat-map.ts     # AsyncIterable → AsyncIterable (accepts array/iterable/asyncIterable output)
├── take.ts         # AsyncIterable → AsyncIterable (early-terminating)
├── find.ts         # AsyncIterable → Promise<T | undefined>
├── to-array.ts     # AsyncIterable → Promise<T[]>
├── group-by.ts     # AsyncIterable → Promise<ReadonlyMap<K, ReadonlyArray<T>>>
└── index.ts        # Barrel export — flat re-export of all eight
```

**Test layout:**

```
test/unit/operators/
├── pipe.test.ts
├── filter.test.ts
├── map.test.ts
├── flat-map.test.ts
├── take.test.ts
├── find.test.ts
├── to-array.test.ts
├── group-by.test.ts
└── fixtures.ts     # async-generator helpers: range, throwing, tracking-return
```

All files kebab-case (ls-lint). All internal imports use the `.js` extension (ESM).

---

## 3. Dependency Boundary

Already enforced by `.dependency-cruiser.cjs` rule
[`operators-must-be-standalone`](../../.dependency-cruiser.cjs):

```
from: ^src/operators/
to:   ^src/(domain|application|ports|adapters|transport)/   → ERROR
```

Consequently `src/operators/*.ts` imports **nothing** from the rest of the codebase.
The only imports allowed are between operator files themselves (e.g. `index.ts`
re-exports siblings).

| Property                       | Guarantee                                                       |
| ------------------------------ | --------------------------------------------------------------- |
| Zero runtime dependencies      | No `node:*`, no `tsgit/*`, no external packages                 |
| Zero domain coupling           | No `ObjectId`, no `FilePath`, no `TsgitError` references        |
| Standard JS errors only        | `RangeError` / `TypeError` for bad inputs (not `TsgitError`)    |
| Works on any AsyncIterable     | Consumers outside tsgit can reuse operators against their data  |
| Tree-shakeable                 | Each file is a single-purpose default-free module with one export |

---

## 4. Shared Types

These three type aliases start **defined locally in each file that needs them**
(one or two lines duplicated — simpler than a shared `types.ts` that every file
would import for a 5 kB module). A **threshold rule** governs extraction:

> If a shared alias lands in **more than three files**, extract it to
> `src/operators/types.ts` and import it via `type` imports (erased at build).
> `Awaitable<T>` already hits five call sites (`filter`, `map`, `flatMap`, `find`,
> `groupBy`), so it will be extracted during implementation. The rule is recorded
> here so future operator additions apply it consistently.

```typescript
/**
 * Callback return that may be resolved synchronously or via any thenable.
 * Uses `PromiseLike<T>` — the exact shape `await` accepts under ES2022 —
 * so custom thenables and test doubles compose cleanly.
 */
type Awaitable<T> = T | PromiseLike<T>;

/** A unary function used by `pipe`. */
type UnaryFn<A, B> = (value: A) => B;

/**
 * `flatMap` output: caller-supplied mapper may return a sync iterable, an async
 * iterable, or a `Promise` whose resolved value is one of those.
 *
 * Note the precise shape is `Promise<Iterable<U> | AsyncIterable<U>>`, not
 * `Promise<Iterable<U>> | Promise<AsyncIterable<U>>`. They are assignment-
 * equivalent via `Promise<A|B>` covariance; we use the union-inside-Promise
 * form to reduce `.d.ts` surface.
 */
type FlatMapReturn<U> =
  | Iterable<U>
  | AsyncIterable<U>
  | Promise<Iterable<U> | AsyncIterable<U>>;
```

**Rationale for local duplication (before the threshold hits).** The aliases
occur 1–3 times per file, biome enforces `noUnusedImports`, and a shared
`types.ts` adds a cross-file import and a barrel entry that contributes nothing
at runtime but bytes through the dts bundler. Newspaper rule: the reader sees
the type next to the signature. The threshold rule above kicks in when this
stops paying for itself.

---

## 5. Operator Semantics

### 5.0 Type discipline (applies to every non-terminal operator)

**Element-type preservation.** Every non-terminal operator's curried return
must be typed as `(source: AsyncIterable<T>) => AsyncIterable<U>` **parameterized
on the source element type**, never `AsyncIterable<unknown>`. If any intermediate
stage widens to `unknown`, inference collapses for every downstream stage and the
consumer is forced to `as`-cast at the terminal.

Concretely, this rules out implementations of the form:

```typescript
// WRONG — widens element type to unknown downstream of this operator
function broken<T>(pred: (x: T) => boolean): (s: AsyncIterable<unknown>) => AsyncIterable<unknown> { … }
```

and requires:

```typescript
// CORRECT — preserves T through the pipeline
function ok<T>(pred: (x: T) => boolean): (s: AsyncIterable<T>) => AsyncIterable<T> { … }
```

The eight operators in §5.2–§5.8 satisfy this by construction. The rule is
recorded here so future additions (V2 `chunkBy`, `parallelMap`, etc.) stay
inference-safe.

**Return-type encapsulation.** All non-terminal operators declare their return
as `AsyncIterable<T>`, **not** `AsyncGenerator<T, void, unknown>` — even though
`async function*` would structurally satisfy both. This hides `.return()` and
`.throw()` from callers, forcing them onto the `for await … of` cleanup path
(which is what the dep-cruiser'd Phase 7 obligations assume). See §6.10.

---

### 5.1 `pipe` — generic value pipeline

```typescript
export function pipe<A>(a: A): A;
export function pipe<A, B>(a: A, ab: UnaryFn<A, B>): B;
export function pipe<A, B, C>(a: A, ab: UnaryFn<A, B>, bc: UnaryFn<B, C>): C;
// ... up to 9 overloads (A..J)
export function pipe<A, B, C, D, E, F, G, H, I, J>(
  a: A,
  ab: UnaryFn<A, B>,
  bc: UnaryFn<B, C>,
  cd: UnaryFn<C, D>,
  de: UnaryFn<D, E>,
  ef: UnaryFn<E, F>,
  fg: UnaryFn<F, G>,
  gh: UnaryFn<G, H>,
  hi: UnaryFn<H, I>,
  ij: UnaryFn<I, J>,
): J;
```

**Implementation** (single body under all overloads):

```typescript
export function pipe(
  initial: unknown,
  ...fns: ReadonlyArray<UnaryFn<unknown, unknown>>
): unknown {
  return fns.reduce((acc, fn) => fn(acc), initial);
}
```

**Why `reduce` over a `let`-loop.** The loop form (`let result = initial; for (…) result = fn(result)`) reassigns a binding on every iteration, which drifts from the project's FP-first / immutability mandate. `reduce` is idiomatic left-fold and runtime-equivalent in V8 11+ — modern ICs inline the reducer on monomorphic call sites. One less line and one less scalar binding to track mentally.

**Semantics.**

- Purely synchronous application of functions left to right.
- `pipe(x)` with no functions returns `x` unchanged (identity).
- Does **not** await or flatten promises — if `ab(a)` returns `Promise<B>`, then `bc` receives a `Promise<B>` (and should be typed accordingly).
- Any function throwing propagates to the caller; no further functions run.

**Why generic (not AsyncIterable-specific).**

PRD §7.2.5 uses `pipe` to stack transport middleware — the "value" is an
`HttpTransport` (not an AsyncIterable), and each middleware is
`(HttpTransport) => HttpTransport`. The same `pipe` serves both pipelines:

```typescript
// AsyncIterable pipeline — lives in consumer code or in a Phase 9 command
const commits = pipe(
  walkCommits(ctx, { from: 'main' }),
  filter(byAuthor('alice')),
  take(20),
);

// Transport middleware stack — lives in the Phase 10 facade
// (repository.ts) or in consumer code, NEVER in src/transport/.
const transport = pipe(
  fetchTransport,
  withRetry({ attempts: 3 }),
  withAuth({ token }),
  withLogging(logger),
);
```

**Where this code lives.** `.dependency-cruiser.cjs` rule
`transport-only-depends-on-ports` forbids `src/transport/ → src/operators/`.
That is intentional: transport middleware modules export plain unary functions
(`(HttpTransport) => HttpTransport`) and do **not** import `pipe`. The
composition itself happens one layer up — either in `src/repository.ts`
(the Tier 1 facade, Phase 10), which imports from both `tsgit/operators` and
`tsgit/transport`, or in user code. See §6.3 for the full rationale.

**Why 9 overloads.** Matches RxJS/fp-ts convention; covers every realistic
pipeline depth (the `log` example in PRD §7.2.1 uses 6). Beyond 9 the user nests
`pipe(pipe(a, f, g), h, i)`. A recursive `Pipe<…>` mapped type would work but
costs type-check throughput on every call site — not worth it for a generic shared
by the whole project.

**Erased generics.** The implementation is a single untyped body (`unknown`);
only the overload declarations carry types. This is idiomatic fp-ts-style
pipe; it keeps the emitted JS minimal.

---

### 5.2 `filter` — drop items failing the predicate

```typescript
export function filter<T>(
  predicate: (value: T) => Awaitable<boolean>,
): (source: AsyncIterable<T>) => AsyncIterable<T>;
```

**Implementation.**

```typescript
export function filter<T>(predicate: (value: T) => Awaitable<boolean>) {
  return async function* (source: AsyncIterable<T>): AsyncIterable<T> {
    for await (const value of source) {
      if (await predicate(value)) {
        yield value;
      }
    }
  };
}
```

**Semantics.**

- Preserves source order.
- `predicate` may be synchronous (return `boolean`) or asynchronous (return
  `Promise<boolean>` or any `PromiseLike<boolean>`). The implementation always
  `await`s — passing a sync predicate incurs two microtasks per item on V8
  (one to unwrap the non-thenable, one to resume the `async function*`).
  Measured cost ≈ **15–30 ms per 100 k items** on V8 11+. Accepted as a
  design choice: every competitor pays the same, and an `isPromise` branch
  costs ~100 B gzipped plus added complexity at every operator — not worth
  it under the 5 kB ceiling.
- If `predicate` throws, the rejection / exception propagates through the
  generator and the source's `return()` is called automatically by the JS
  runtime (try/finally inside `for await … of`).
- Zero buffering — fully lazy.

---

### 5.3 `map` — transform each item

```typescript
export function map<T, U>(
  mapper: (value: T) => Awaitable<U>,
): (source: AsyncIterable<T>) => AsyncIterable<U>;
```

**Implementation.**

```typescript
export function map<T, U>(mapper: (value: T) => Awaitable<U>) {
  return async function* (source: AsyncIterable<T>): AsyncIterable<U> {
    for await (const value of source) {
      yield await mapper(value);
    }
  };
}
```

**Semantics.**

- One-in / one-out. Preserves source order.
- Sync and async mappers both supported (same pattern as `filter`; same
  ~2-microtask-per-item cost on V8 for sync callbacks, same rationale for not
  branching).
- Mapper errors propagate and close the source.
- No index argument — YAGNI. If a caller needs indices, they `map((v, i) => …)`
  over a custom wrapper in user space; we don't pay for it in the shared path.

---

### 5.4 `flatMap` — expand each item to zero or more items

```typescript
export function flatMap<T, U>(
  mapper: (value: T) => FlatMapReturn<U>,
): (source: AsyncIterable<T>) => AsyncIterable<U>;
```

**Implementation.**

```typescript
export function flatMap<T, U>(mapper: (value: T) => FlatMapReturn<U>) {
  return async function* (source: AsyncIterable<T>): AsyncIterable<U> {
    for await (const value of source) {
      const inner = await mapper(value);
      for await (const item of inner) {
        yield item;
      }
    }
  };
}
```

**Why `for await` instead of `yield* await mapper(value)`.** Async-generator
`yield*` delegation in V8 hits an open slow path (v8:7926, 2019-present): each
inner value routes back through the delegator's own await machinery, adding
~3 microtasks per item. For `diffTreesRecursive` feeding
`flatMap(entry => readSubtreeChildren(entry))` across tens of thousands of
tree entries, the manual `for await … of inner → yield` form measurably
beats `yield*` by ~10–20% on microbenchmarks. `for await` also works for
**both** sync `Iterable<U>` and `AsyncIterable<U>` inputs — sync iterables
are valid `for await` targets (the runtime wraps `[Symbol.iterator]()`
values in a trivial `Promise.resolve` path).

**Semantics.**

- The implementation is a **two-step mechanic:** `await mapper(value)` first
  strips any `Promise` layer from the mapper's return (`Promise<Iterable<U>>`
  or `Promise<AsyncIterable<U>>` → the unwrapped iterable), then `for await`
  iterates. Writing `for await (const item of mapper(value))` directly
  **without the outer `await`** would fail at runtime when the mapper returns
  a `Promise` — `for await` does not auto-unwrap a `Promise<Iterable>`. Keep
  the two steps separate.
- Accepts `Iterable<U>`, `AsyncIterable<U>`, or a `Promise` of either. After
  the `await`, the unwrapped iterable uses whichever protocol it natively
  implements.
- Inner iterables are exhausted before the next outer item is pulled
  (sequential flatten, not merged). Order is deterministic:
  `source[0]`'s inner items precede `source[1]`'s.
- `mapper` returning a plain `T` is **rejected by the type system** —
  wrap singletons in `[value]` or use `map`. This keeps the runtime minimal
  (no `Symbol.asyncIterator` probing).

**Not included:** parallel / interleaved flatMap. Use case in PRD §7.2.1 is
commit-ordered (diffs in commit order), which would break under interleaving.
If a future need appears, add `flatMapParallel(concurrency)` in a later phase
— see §9's explicit re-open criterion.

---

### 5.5 `take` — yield at most N items

```typescript
export function take<T>(
  count: number,
): (source: AsyncIterable<T>) => AsyncIterable<T>;
```

**Implementation.**

```typescript
export function take<T>(count: number) {
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError('take(count): count must be a non-negative integer');
  }
  return async function* (source: AsyncIterable<T>): AsyncIterable<T> {
    if (count === 0) return;
    let yielded = 0;
    for await (const value of source) {
      yield value;
      yielded += 1;
      if (yielded >= count) return;
    }
  };
}
```

**Semantics.**

- `count === 0` → the returned iterable is empty; the source's `.next()` is
  **never called** (the early `return` runs before the `for await` would
  start pulling). Matches `Array.prototype.slice(0, 0)` semantics. (Note: the
  runtime may still call `[Symbol.asyncIterator]()` on the source when
  `for await` desugars — implementation-dependent. What the fixtures and
  therefore the invariant guarantee is "no values are pulled", i.e. no
  `next()` call.)
- `count >= N` where the source yields `N < count` items → returns all `N`; no error.
- **Validation at call time, not iteration time** — matches Node's built-in
  Iterator Helpers `.take(n)`. Invalid inputs (NaN, Infinity, `-1`, `1.5`)
  fail fast with `RangeError` before the pipeline is built.
- Upstream cleanup on early termination: when `take` returns after reaching
  the cap, the `for await … of` protocol triggers `source[Symbol.asyncIterator]().return()`
  automatically. This cascades up through any preceding `map`/`filter`/`flatMap`
  because they're all `async function*` — try/finally in generator bodies
  handles cleanup. **Explicit `walkCommits` tests must verify that `take(N)`
  on a 1 M-commit walk stops reading the packfile at item N.**

**Why not `drop` / `skip` too.** Not in the backlog. Callers filter by position
if needed. YAGNI.

---

### 5.6 `find` — first matching item, terminal

```typescript
export function find<T>(
  predicate: (value: T) => Awaitable<boolean>,
): (source: AsyncIterable<T>) => Promise<T | undefined>;
```

**Implementation.**

```typescript
export function find<T>(predicate: (value: T) => Awaitable<boolean>) {
  return async (source: AsyncIterable<T>): Promise<T | undefined> => {
    for await (const value of source) {
      if (await predicate(value)) {
        return value;
      }
    }
    return undefined;
  };
}
```

**Semantics.**

- Terminal: returns `Promise<T | undefined>`, not `AsyncIterable`. **`find` is
  a plain `async` arrow, not an `async function*`** — it does not yield, it
  returns. Implementors must not widen this to a generator (the §6.10
  encapsulation argument does not apply here; it's a one-shot awaitable).
- **Short-circuits on first match.** When the `for await … of` loop hits the
  inner `return value`, the loop desugars through ECMA-262
  ForIn/OfBodyEvaluation and the runtime invokes `IteratorClose` on the
  source, which calls `source[Symbol.asyncIterator]().return()`. This is the
  **`for await` cleanup protocol**, not "generator `return()`" — `find` itself
  is not a generator.
- `undefined` on no-match. Never throws a "not found" error (consistent with
  `Array.prototype.find`).
- Predicate errors propagate as rejected promise.

---

### 5.7 `toArray` — collect all items, terminal

```typescript
export function toArray<T>(source: AsyncIterable<T>, limit?: number): Promise<T[]>;
```

**Implementation.**

```typescript
export async function toArray<T>(
  source: AsyncIterable<T>,
  limit: number = Number.POSITIVE_INFINITY,
): Promise<T[]> {
  if (Number.isNaN(limit) || limit < 0) {
    throw new RangeError('toArray(limit): must be a non-negative number or Infinity');
  }
  const result: T[] = [];
  for await (const value of source) {
    if (result.length >= limit) {
      throw new RangeError(`toArray: exceeded limit of ${limit} items`);
    }
    result.push(value);
  }
  return result;
}
```

**Semantics.**

- **Not curried** — takes the source directly (and the optional `limit`). This
  is the sole exception to the curried pattern (`toArray` has no
  "configuration" worth currying). It remains `pipe`-compatible because
  `pipe(source, toArray)` applies `toArray(source)` with the default limit.
- Preserves source order.
- **`limit` is defense-in-depth for the public API.** Default `Infinity`
  preserves prior semantics; callers piping attacker-controlled sources pass
  an explicit finite limit. Overshoot throws `RangeError` **before** the
  `push`, so `result` never exceeds `limit` entries.
- Allocates `O(min(N, limit))` memory. The caller is still responsible for an
  upstream `take(N)` when they know the source is bounded and want a clean
  truncation rather than an error — the two patterns compose:
  `await toArray(take(10)(source))` never throws on size.
- `limit = 0` is valid and produces `[]` as long as the source is empty; it
  throws on the first yield (the guard fires before the first push).
- `limit` validation (`NaN` or `< 0`) throws **synchronously at call time**
  in `pipe(source, toArray)` — the throw happens inside the `async`
  body, surfacing as a rejected promise rather than an eager throw. This is
  consistent with `toArray` being an `async` function.

---

### 5.8 `groupBy` — bucket items by key, terminal

```typescript
export function groupBy<T, K>(
  keyFn: (value: T) => Awaitable<K>,
  limit?: number,
): (source: AsyncIterable<T>) => Promise<ReadonlyMap<K, ReadonlyArray<T>>>;
```

**Implementation.**

```typescript
export function groupBy<T, K>(
  keyFn: (value: T) => Awaitable<K>,
  limit: number = Number.POSITIVE_INFINITY,
) {
  if (Number.isNaN(limit) || limit < 0) {
    throw new RangeError('groupBy(limit): must be a non-negative number or Infinity');
  }
  return async (source: AsyncIterable<T>): Promise<ReadonlyMap<K, ReadonlyArray<T>>> => {
    const result = new Map<K, T[]>();
    let count = 0;
    for await (const value of source) {
      if (count >= limit) {
        throw new RangeError(`groupBy: exceeded limit of ${limit} items`);
      }
      const key = await keyFn(value);
      const bucket = result.get(key);
      if (bucket) {
        bucket.push(value);            // Deliberate local mutation — see §6.12
      } else {
        result.set(key, [value]);
      }
      count += 1;
    }
    return result as ReadonlyMap<K, ReadonlyArray<T>>;
  };
}
```

**Why validate `limit` at call time.** Same rationale as `take` (§5.5 / §6.5):
pipeline construction failure beats a lazy runtime failure; stack trace points
at the caller. `groupBy` is curried, so the throw happens at factory-call
time, before the pipeline is applied to a source. `toArray` differs (§5.7) —
it is not curried and the throw must live inside its `async` body.

**Semantics.**

- Terminal + **buffered** — returns a `Promise<ReadonlyMap<…>>`. Matches the
  semantics of ES2024 `Object.groupBy` / `Map.groupBy`.
- **Key insertion order preserved.** `Map` iteration order equals first-occurrence
  order in the source. A group's `ReadonlyArray<T>` preserves source order.
- **Repeated keys.** If the source yields `[a, b, a, b, a]` keyed by identity,
  the result has exactly two buckets (`a` first, `b` second, per first-occurrence
  order), with bucket contents `[a, a, a]` and `[b, b]` respectively — NOT
  interleaved, NOT reordered.
- Key equality follows JS `Map` semantics (`SameValueZero`). Callers using
  object keys must supply canonical references — not tsgit's problem.
- **`limit` is defense-in-depth** matching `toArray` (§5.7). Default `Infinity`.
  The check is `count >= limit` **before** `keyFn` is invoked, so a hostile
  `keyFn` cannot side-step the guard.
- Allocates `O(min(N, limit))` memory. Combine with `take` upstream for
  clean truncation.
- The internal `.push` on an existing bucket is a **deliberate scoped mutation**
  per §6.12 — the spread alternative is O(N²) on a hot accumulator path.

**Why buffered rather than run-length.**

A run-length (IxJS-style) `groupBy` that emits `{ key, values: AsyncIterable }`
per adjacent key run is strictly more expressive but introduces a classic
footgun: if the caller advances the outer iterator before consuming a group's
`values`, the group is closed or buffered in place. The runtime semantics
diverge between libraries and consumers get it wrong in practice.

Git use cases shown in PRD (§7.2.6) group bounded diff sets for code-review
tools — all buffered already. A future `windowBy` / `chunkBy` for streaming
use can land later without touching `groupBy`.

**Shallow-immutability caveat.** The declared return type is
`ReadonlyMap<K, ReadonlyArray<T>>`, but the underlying objects are a mutable
`Map` and mutable `T[]` at runtime — the cast is structural, not a runtime
freeze. A caller who casts back to `Map<K, T[]>` and mutates a bucket will
succeed. This is accepted as a known limitation:

- Freezing each bucket (`Object.freeze(bucket)`) would silence the cast
  but not change the declared type without `as const`, and it adds per-group
  runtime cost.
- All in-tree consumers (Phase 9 commands) will consume the return as
  `ReadonlyMap` and dep-cruiser rules prevent reverse imports back into
  operators.
- External consumers who defeat the type-level contract own the consequences
  — same as any TypeScript library returning `readonly` views.

---

## 6. Key Design Decisions

### 6.1 AsyncIterable-only, no Iterable union

**Decision.** Operators work on `AsyncIterable<T>` only. No
`Iterable<T> | AsyncIterable<T>` overloads.

**Why.** Every source in tsgit (walkCommits, walkTree, packfile streams,
HTTP body streams) is async. A sync-only pipeline can be trivially lifted by
wrapping the source: `async function* wrap() { yield* syncIterable; }`. The
type-surface cost of unioning sync + async is ~2× the declarations and forces
runtime branching. Not worth 5 kB of budget.

### 6.2 No Context, no AbortSignal, no tsgit error types

**Decision.** Operators receive only what they're given. They do not observe
`Context.signal`, do not throw `TsgitError`, do not import from `domain/`.

**Why.** The dependency-cruiser rule `operators-must-be-standalone` codifies
this. Cancellation is a source concern — primitives like `walkCommits` check
`ctx.signal.aborted` between yields. When the consumer breaks out of a
downstream `for await`, the iterator-`return()` protocol cascades upstream and
eventually reaches the primitive, which then releases file handles / closes
HTTP streams. Operators are transparent to this.

### 6.3 `pipe` is a generic value composer, not AsyncIterable-specific

**Decision.** `pipe` is `(value, ...unaryFns) => value`, reusable for any
unary-function chain (AsyncIterable pipelines, transport middleware, any
domain data).

**Why.** PRD §7.2.5 uses `pipe(fetchTransport, withRetry(…), withAuth(…))` —
the "source" is an `HttpTransport`, not an AsyncIterable. Forcing
`pipe` to return `AsyncIterable` would block the transport use case or require
a second identical helper with a different name. One `pipe` is enough.

**Composition boundary (dep-cruiser-enforced).** The transport use case does
**not** mean `src/transport/` imports `pipe`. Rule
`transport-only-depends-on-ports` forbids it (`transport/ ✗→ operators/`).
The split is:

| Module              | Exports                                              | Imports from  |
| ------------------- | ---------------------------------------------------- | ------------- |
| `src/transport/`    | `withRetry`, `withAuth`, `withLogging` — each a unary function `(HttpTransport) => HttpTransport` | `src/ports/` only |
| `src/repository.ts` (Phase 10 facade) | User-facing `openRepository()`; composes transport internally | Both `tsgit/operators` (for `pipe`) and `tsgit/transport` |
| User code           | Optional: custom middleware stacks                   | Both entries  |

Transport middleware modules produce plain unary functions. `pipe` composes
them at a higher layer. This keeps operators below transport in the
dep graph and the dep-cruiser rule clean.

### 6.4 All operators (except `toArray`) are curried

**Decision.** `filter(pred)` returns a function `source => AsyncIterable`.
Same for `map`, `flatMap`, `take`, `find`, `groupBy`. `toArray` is not
curried — it takes the source directly.

**Why.** Currying makes every operator a valid `pipe` argument (`pipe(src,
filter(p), take(10))`). `toArray` has no "configuration" to curry — it
would be `() => source => Promise<T[]>`, needlessly verbose. Inside `pipe`,
`toArray` works identically because `pipe(src, toArray)` applies `toArray(src)`.

### 6.5 Validation at call time for `take`

**Decision.** `take(count)` throws `RangeError` synchronously if `count`
is not a non-negative integer.

**Why.** Matches Node's Iterator Helpers `.take(n)` and RxJS `take`. Pipeline
construction failure beats a lazy runtime failure — the stack trace points
at the call site, not the first `await source[Symbol.asyncIterator]().next()`.
Invalid inputs (`NaN`, `Infinity`, `-1`, `1.5`) fail fast.

**Why `RangeError`.** Standard JS semantics: `Array.prototype.slice(−1, -2)`
silently returns empty, but numeric APIs (`String.prototype.padStart`)
throw `RangeError` for negative counts. `take` is more like the latter.

### 6.6 Standard JS errors, not `TsgitError`

**Decision.** `take` throws `RangeError`. Any other misuse of an operator
(bad callback return shape) surfaces as a native `TypeError` from the
runtime.

**Why.** Operators are generic FP utilities — they don't belong to any domain.
Coupling them to `TsgitError` would force every user outside tsgit to learn
tsgit's error union. Standard JS errors compose with every `catch`.

### 6.7 Shared-type extraction follows a >3-file threshold

**Decision.** Small type aliases (`Awaitable<T>`, `UnaryFn<A, B>`,
`FlatMapReturn<U>`) are **duplicated inline** until the same alias lands in
**more than three files**. Beyond that threshold, the alias moves to
`src/operators/types.ts` and is pulled in via `import type`.

**Why.** For 1–3 call sites, an extra module + barrel entry costs more in
review surface and `.d.ts` bytes than inline duplication. Past three, the
math flips: maintenance drift risk + cross-file review cost win over the
~40-byte savings.

**Current state.** `Awaitable<T>` hits five sites (`filter`, `map`, `flatMap`,
`find`, `groupBy`), so it crosses the threshold and lands in `types.ts`
(Step 2 in §10). `UnaryFn<A, B>` and `FlatMapReturn<U>`
stay inline unless they reach the threshold later. This is deliberate — the
rule gives us one explicit trigger point, not a blanket policy either way.

### 6.8 Terminal operators return `Promise`, not `AsyncIterable`

**Decision.** `find`, `toArray`, `groupBy` return `Promise<T>`, breaking the
"operator returns AsyncIterable" pattern.

**Why.** These are genuinely terminal — consuming the entire (or matching)
source and collapsing it to a single value. Returning an AsyncIterable of
length 1 would be an awkward idiom. Users naturally `await` terminal results.

### 6.9 No `index` / `accumulator` / other RxJS affordances

**Decision.** No `map((value, index) => …)`, no `reduce`, no `scan`, no
`tap`, no `throttle`, no `distinct`. Just the eight operators in the
backlog.

**Why.** YAGNI. The backlog was drawn from concrete Phase 7/9 consumers. Each
additional operator costs bundle budget and review surface.

**About `reduce` specifically.** A consumer needing reduction can write
`const arr = await pipe(source, toArray); return arr.reduce(fn, seed);`.
That combination is **only safe when the source is already bounded** — either
by a finite upstream (e.g. `walkCommits` to a specific `to`-ref) or an upstream
`take(N)`. Applied to an unbounded source, `toArray` materializes everything
and defeats the streaming intent PRD §7.2.1 cites as the operators' core
rationale. The substitution is a conscious non-goal consequence, not a
"free replacement" for a native lazy `reduce`. If a compelling unbounded
reduce use case emerges in Phase 9, we add a lazy `reduce` then.

---

### 6.10 `AsyncIterable<T>` return type is deliberate encapsulation

**Decision.** Non-terminal operators declare their curried return as
`(source: AsyncIterable<T>) => AsyncIterable<T>` (or `AsyncIterable<U>` for
`map` / `flatMap`), **not** `AsyncGenerator<T, void, unknown>` — even though
`async function*` structurally returns the latter.

**Why.**

- **Hides `.return()` / `.throw()`** from callers. Operators rely on the
  runtime's `for await … of` cleanup protocol; a caller who manually calls
  `.return()` on a generator can bypass nested try/finally if they're not
  careful. Narrowing the type to `AsyncIterable` closes that door.
- **Matches consumer expectations.** `walkCommits` already returns
  `AsyncIterable<Commit>`; operator outputs compose into that shape without
  any type-level friction.
- **Keeps `.d.ts` smaller.** `AsyncGenerator<T, void, unknown>` in a type
  bundle is three type arguments; `AsyncIterable<T>` is one. Over 7 operators,
  this is non-trivial for the 5 kB ceiling.

The encapsulation is intentional; implementations must annotate the return
explicitly (not rely on inference), because `async function*` would otherwise
widen to `AsyncGenerator`.

### 6.11 Non-terminal operators MUST use `for await … of` iteration

**Decision.** Non-terminal operators (`filter`, `map`, `flatMap`, `take`)
iterate their sources via `for await (const x of source)` only. Manual calls
to `source[Symbol.asyncIterator]()` followed by `.next()` / `.return()` /
`.throw()` are **forbidden** at the source-level consumption site.

**Why.** ECMA-262 13.7.5.13 (ForIn/OfBodyEvaluation) wires the runtime's
`IteratorClose` into the `for await` desugaring. When the enclosing `async
function*` body hits `return` (or an uncaught throw), the runtime walks the
active `for await … of` loops in LIFO order and invokes
`source[Symbol.asyncIterator]().return()` on each. **That's the mechanism
that makes the multi-hop cleanup cascade in §7.3 fire.** A manual iterator
loop skips this machinery: the developer would have to reimplement
cleanup-on-early-exit in a try/finally, which is easy to forget and nearly
impossible to mutation-test.

Corollary: when the implementation needs `.return()`-like cleanup for a
*downstream* resource (not the source), use a `try/finally` inside the
`async function*` body — but **do not** iterate the source manually.

This rule applies only to the source iteration site. Internal helpers (e.g.
a future `zip` operator that walks two sources in lockstep) are allowed
manual iterators because `for await` can't express lockstep. That's a
narrow exception, documented case-by-case when it arises.

### 6.12 `groupBy` internal mutation is a scoped exception

**Decision.** The `bucket.push(value)` statement inside `groupBy` mutates a
`T[]` array stored in a local `Map`. This is a **deliberate, scope-bounded
exception** to CLAUDE.md's global immutability rule.

**Why.**

- The pure alternative — `result.set(key, [...bucket, value])` — spreads the
  entire bucket on every hit, turning the accumulator into `O(N²)`. On a
  log/diff pipeline grouping 10 k items, that is ~50 ms of pure array
  reallocation vs ~2 ms with `.push`.
- The mutation is **not observable** outside the operator while it runs:
  `result` is a local `Map`; no reference escapes until the function returns;
  the returned reference is typed `ReadonlyMap<K, ReadonlyArray<T>>` (§5.8's
  shallow-immutability caveat still applies — the type is a contract, not a
  runtime freeze).

**Where the exception ends.** Once `groupBy` returns, the returned buckets
must not be mutated externally. Callers who cast back to `Map<K, T[]>` and
mutate defeat the type contract; the §5.8 caveat already documents this.
Future operators with similar accumulator patterns (e.g. a hypothetical
`countBy`, `toMap`) would inherit this exception explicitly — every new
mutation site must be documented here.

No other operator in Phase 6 mutates. `pipe` (§5.1) uses `reduce`;
`toArray` (§5.7) uses `.push` on a local `T[]` it returns as `T[]` — same
scoped-exception reasoning but with a single mutation line, not worth a
dedicated decision.

---

## 7. Testing Strategy

Coverage target: **100%** line/branch/function/statement. Mutation target:
**0** surviving non-equivalent mutants (Stryker). Follows CLAUDE.md
mutation-resistant test patterns.

### 7.1 Conventions

Every test in this phase observes:

- **Given/When/Then titles.** Required by CLAUDE.md. Example:
  `Given a source of [1,2,3] and an always-true predicate, When sut is iterated, Then it yields [1,2,3] in source order`.
- **AAA bodies.** `// Arrange` / `// Act` / `// Assert` section comments.
- **`sut` variable.** The operator under test is bound to `sut` — for
  curried operators, `sut` is the inner function returned by the factory
  (e.g. `const sut = filter(predicate);`), exercised as `sut(source)`.
  For `toArray`, `sut = toArray` directly; for `find` / `groupBy`,
  `sut = find(predicate)` / `sut = groupBy(keyFn)`.
- **Specific error assertions.** Always `expect(() => sut(-1)).toThrow()`
  patterns include `.toThrow(/non-negative integer/)` or a try/catch with
  `.message` match — never `toThrow(RangeError)` alone (Stryker
  StringLiteral mutants survive class-only checks).
- **Guard clauses get isolated tests.** Every condition in a disjunction
  gets its own test so `||` ↔ `&&` mutations can't survive.
- **No mutation of shared state across tests.** Fixtures are factory
  functions that return fresh generators per test.

### 7.2 Per-operator test shape

Each operator gets a dedicated test file (§2). Common test groups (applied
to every operator unless N/A):

- **Happy path** — non-empty source, typical callback, assert output.
- **Empty source** — no items → operator produces its empty result.
- **Identity / trivial callback** — preserves source (non-terminal only).
- **Error propagation** — callback throws → error bubbles; source `return()`
  called (spy-verified via `trackedRange`).
- **Async callback** — `PromiseLike` callback return — proven via
  `awaitablePredicate` fixture (§7.4) which uses a real `PromiseLike`
  distinct from `Promise`, pinning the `Awaitable = T | PromiseLike<T>`
  widening.
- **Laziness** — for non-terminal operators, assert no upstream pull
  happens until the returned iterable is iterated (uses `pullCounter`).
- **Consumer-break cleanup** — consumer breaks out of `for await` →
  source `return()` called (§7.5).

### 7.3 Operator-specific invariants (Given/When/Then)

**`pipe`:**

- Given no functions, When `pipe(x)` is called, Then it returns `x`
  unchanged (identity).
- Given one function `f`, When `pipe(x, f)` is called, Then it returns `f(x)`.
- Given two functions `f`, `g`, When `pipe(x, f, g)` is called, Then it
  returns `g(f(x))` — left-to-right.
- Given an async function that returns `Promise<B>`, When piped, Then the
  next function receives a `Promise<B>` unchanged (pipe never awaits).
- Given three functions where step 2 throws, When pipe is called, Then
  step 3 is never invoked (spy on step 3 confirms zero calls).
- Given nine unary functions, When pipe is called with all nine, Then the
  output equals their sequential composition applied to the seed.
- Given **ten** unary functions (beyond the 9 overloads), When pipe is called
  (with a user-side `as` cast), Then the output still equals their sequential
  composition — kills the "bound `fns.length` off-by-one" mutation on the
  reduce loop.
- Given an empty `fns` (equivalent to the identity case), When pipe is
  called via the rest-parameter path, Then the output equals the seed.
- **Type-level tests** (`expectTypeOf`): each of the 9 overloads produces
  the expected output type; inference flows from the seed through
  intermediate functions.

**`filter`:**

- Given a source `[1,2,3,4]` and predicate `x => x % 2 === 0`, When sut is
  iterated, Then it yields `[2,4]` in source order.
- Given a predicate returning `true` for all items, When sut is iterated,
  Then `toArray(sut(source))` deep-equals `toArray(source)` (identity law).
- Given a predicate returning `false` for all items, When sut is iterated,
  Then the output is `[]` (annihilation law).
- Given an async predicate that returns `Promise<true>`, When sut yields,
  Then the item is included. (Exercises the `await` — pairs with the
  microtask-observable test below.)
- Given a `PromiseLike<boolean>` predicate (via `awaitablePredicate`
  fixture), When sut is iterated, Then the item is included — proves the
  `PromiseLike` widening from Round 1.
- Given a predicate that throws on item `k`, When sut is iterated past
  item `k-1`, Then the generator throws and `trackedRange.returnCalled() === true`
  (source cleanup fired).
- Given a predicate-spy and a consumer that breaks at item 5, When sut is
  iterated, Then predicate is called exactly 5 times (laziness — no
  look-ahead).
- **Mutation kill — condition body.** Given a predicate `() => true`
  on source `[1]`, When sut is iterated, Then `[1]` is yielded. Given the
  same predicate-but-`false`, Then `[]`. This pair kills the
  `if (condition)` ↔ `if (false)` mutation and the `ConditionalExpression`
  flip.
- **Mutation kill — `await` drop.** Given a predicate returning a
  `Promise<boolean>` that resolves on the next microtask tick, When sut is
  iterated, Then items are yielded in source order (not interleaved with
  pre-resolution). Kills the mutant that removes `await`.

**`map`:**

- Given a source `[1,2,3]` and mapper `x => x * 2`, When sut is iterated,
  Then `[2,4,6]` is yielded.
- Given a source of length N, When sut is iterated, Then the output length
  equals N.
- Given `map(x => x)` (identity mapper), When sut is iterated, Then
  `toArray(sut(source))` deep-equals `toArray(source)` (functor identity).
- Given an async mapper returning `Promise<U>`, When sut yields, Then the
  resolved value is yielded (not the promise itself).
- Given a `PromiseLike<U>` mapper, Then same — via `awaitablePredicate`-shaped
  fixture adapted for mappers.
- Given a mapper that throws on item `k`, When sut is iterated past `k-1`,
  Then error bubbles and source `return()` is called.
- **Mutation kill — `await` drop.** Given a mapper returning
  `Promise<U>` whose resolution ticks a counter, When sut yields three
  items, Then the counter is 3 at completion. Mutant that drops `await`
  yields `Promise<U>` objects before the counter ticks.
- **Type-level:** `map((n: number) => n.toString())` on
  `AsyncIterable<number>` returns `AsyncIterable<string>` — not `any`,
  not `AsyncIterable<unknown>`.

**`flatMap`:**

- Given a mapper returning `Iterable<U>` (plain array), When sut is
  iterated, Then values are flattened in order.
- Given a mapper returning `AsyncIterable<U>` (e.g. a generator), When
  sut is iterated, Then values are flattened in order.
- Given a mapper returning `Promise<Iterable<U>>`, When sut is iterated,
  Then the promise resolves before iteration begins and inner values are
  flattened.
- Given a mapper returning `Promise<AsyncIterable<U>>`, Then same.
- Given a mapper returning an empty iterable for a source item, When sut
  is iterated, Then that source item contributes zero outputs and the
  next outer item is pulled normally.
- Given a two-item source `[A, B]`, When sut yields, Then all of `A`'s
  inner items are yielded before any of `B`'s (sequential flatten,
  deterministic order).
- **Mutation kill — `await` observably fires.** Given a mapper that
  returns a `Promise<[x]>` whose resolution ticks a counter, When sut
  yields one outer item, Then the counter is 1 at yield completion.
- Given a mapper whose inner iterable throws mid-yield, When the outer
  pipeline reaches that inner, Then the outer generator throws and source
  `return()` is called (inner + outer cleanup both fire).
- Given `pipe(singleItemSource, flatMap(() => innerTrackedRange(100)), take(1))`
  and iteration to completion, When the outer takes 1, Then
  `innerTrackedRange.returnCalled() === true` (inner iterator cleanup
  fires when the outer cuts).

**`take`:**

- Given `take(0)` on `pullCounter().source`, When sut is iterated to
  completion, Then `pullCount() === 0` (source's `.next()` never called).
- Given a source of length 5 and `take(3)`, When sut is iterated to
  completion, Then exactly `[0,1,2]` is yielded.
- Given a source of length 2 and `take(5)`, When sut is iterated, Then
  all 2 items are yielded and no error is thrown (no `>` vs `>=` mutation
  surviving).
- Given `take(1)` on `pullCounter().source`, When sut is iterated to
  completion, Then `pullCount() === 1` (kills `>=` ↔ `>` mutation: `>`
  would pull one extra).
- Given `take(N)` on a source of exactly `N` items, When sut is iterated,
  Then `pullCount() === N` and the source's end-of-iteration path is
  reached without an extra `next()` call.
- Given `take(3)` and a source of 100 items, When iteration cuts after 3,
  Then the source's `return()` is called (`trackedRange.returnCalled() === true`).
- **Invalid-input tests (CRITICAL mutation fortification):**
  - Given `take(-1)`, When sut is called, Then a `RangeError` is thrown
    whose `.message` matches `/non-negative integer/`.
  - Given `take(-2)` (**integer and negative — isolates the `count < 0`
    arm of `!Number.isInteger || count < 0`**), When sut is called, Then
    `RangeError` with `.message` matching `/non-negative integer/`.
  - Given `take(1.5)`, Then `RangeError` with `.message` matching
    `/non-negative integer/`.
  - Given `take(NaN)`, Then `RangeError` with `.message` matching
    `/non-negative integer/`.
  - Given `take(Infinity)`, Then `RangeError` with `.message` matching
    `/non-negative integer/`.
  - All five use try/catch + `.message` regex, **not**
    `toThrow(RangeError)` alone. See CLAUDE.md mutation patterns.
- **Property test (fast-check):** for any non-negative integer `n` and
  any finite async iterable of length `L`, `take(n)(source)` yields
  exactly `min(n, L)` items that equal the first `min(n, L)` of `source`.

**`find`:**

- Given a source `[1,2,3]` and predicate `x => x === 2`, When sut is
  awaited, Then `2` is returned.
- Given a predicate that never matches, When sut is awaited, Then
  `undefined` is returned.
- Given an empty source, When sut is awaited, Then `undefined` is returned.
- **Isolated guard tests (per CLAUDE.md):**
  - (a) Given a source where the match precedes a throwing item, When sut
    is awaited, Then the match is returned; the throwing item is never
    inspected (predicate spy count === index of match + 1).
  - (b) Given a source where a throwing predicate fires before any match,
    When sut is awaited, Then the error propagates; no value is returned.
- Given an async predicate, When sut is awaited, Then the resolved
  `boolean` determines inclusion.
- Given a match at index 2 of a 100-item `trackedRange`, When sut is
  awaited, Then `returnCalled() === true` (`for await … of` cleanup fires).

**`toArray`:**

- Given an empty source, When sut is awaited, Then `[]` is returned.
- Given a source of N items, When sut is awaited, Then an array of length
  N is returned in source order. **Expectation built manually via a
  `for await … of` loop in the test**, not via another operator — this is
  `toArray`'s verification floor; downstream operator tests may use
  `toArray` as a sink only because this floor holds.
- Given a source throwing mid-iteration, When sut is awaited, Then the
  returned promise rejects with the thrown error; the partial array is
  not observable.
- Given a source of 5 items and `limit = 3`, When sut is awaited, Then
  the returned promise rejects with `RangeError` whose `.message` matches
  `/exceeded limit of 3/`.
- Given a source of 3 items and `limit = 3`, When sut is awaited, Then
  `[0,1,2]` is returned (`>=` boundary — mutation target).
- Given a source of 3 items and `limit = 4`, When sut is awaited, Then
  `[0,1,2]` is returned (no error).
- Given an empty source and `limit = 0`, When sut is awaited, Then `[]`
  is returned.
- Given a one-item source and `limit = 0`, When sut is awaited, Then
  `RangeError` with `/exceeded limit of 0/`.
- Given `limit = -1`, When sut is awaited, Then `RangeError` with
  `/non-negative/` (one isolated test for `< 0` arm).
- Given `limit = NaN`, When sut is awaited, Then `RangeError`.

**`groupBy`:**

- Given an empty source, When sut is awaited, Then an empty `Map` is
  returned.
- Given a source `[1,1,1]` keyed by identity, When sut is awaited, Then
  the result has one entry `{1: [1,1,1]}`.
- Given a source `[1,2,3]` keyed by identity, When sut is awaited, Then
  the result has three entries each of size 1.
- Given a source `[a, b, a, b, a]` keyed by identity, When sut is
  awaited, Then the result has two entries in first-occurrence key order:
  `a` → `[a, a, a]`, `b` → `[b, b]` (NOT interleaved; NOT reordered). This
  pins the "`.push` on existing bucket" hit path **and** the insertion-order
  invariant — kills a mutant that replaces `result.get(key)` with something
  that doesn't lookup-or-create correctly.
- Given a source `[x, y]` keyed by `() => someConst`, When sut is
  awaited, Then `result.keys()` in order gives `[someConst]` (insertion
  order preserved).
- Given a source `[NaN, NaN]` keyed by identity (both map to `NaN`), When
  sut is awaited, Then `result.get(NaN)!.length === 2` (pins
  `SameValueZero` equality).
- Given a source of two items keyed to **two distinct** fresh object
  literals `{}`, When sut is awaited, Then result has two entries (each
  of size 1) — pins "`Map` uses reference equality for objects".
- Given a source of two items keyed to **the same** frozen object, When
  sut is awaited, Then result has one entry of size 2.
- Given a `keyFn` that throws on item `k`, When sut is awaited, Then
  the returned promise rejects; source `return()` is called; **the partial
  `Map` is not observable** — the rejected promise does not expose
  intermediate state (verify by scope — there is no way to read it).
- Given a source of 5 items and `limit = 3`, When sut is awaited, Then
  rejection with `RangeError` matching `/exceeded limit of 3/`.
- Given `groupBy(k, -1)` (invalid limit), When sut is **called** (factory
  invocation), Then `RangeError` thrown synchronously at construction
  time. Distinct from `toArray` whose invalid limit surfaces via rejected
  promise (see §5.8 rationale).
- Given `groupBy(k, NaN)`, When sut is called, Then `RangeError`.
- **Property test:** for any source and any `keyFn`,
  `Array.from(result.values()).flat()` is a permutation of `toArray(source)`
  (no items lost, none duplicated; length sum equals source length).

**Composition laws (cross-operator property tests):**

All run under `fast-check` in `test/unit/operators/laws.test.ts`.

- `take(n)(take(m)(source)) ≡ take(min(n, m))(source)` — pipeline-level
  invariant.
- `filter(p)(filter(q)(source)) ≡ filter(x => q(x) && p(x))(source)` —
  predicate composition.
- `map(g)(map(f)(source)) ≡ map(x => g(f(x)))(source)` — map fusion law.
- `filter(p)(map(f)(source)) ≡ map(f)(filter(x => p(f(x)))(source))` —
  filter/map commutation (requires pure `f`, `p`; arbitraries stateless).
- `toArray(flatMap(x => [x])(source)) ≡ toArray(source)` — `flatMap` of
  singleton lift is identity.
- `toArray(source).length === N` for any finite source of length N —
  catches off-by-one on the accumulator loop.
- `toArray(map(x => x)(source)) ≡ toArray(source)` — `map` functor
  identity.
- `toArray(filter(() => true)(source)) ≡ toArray(source)` — filter
  identity.
- `toArray(filter(() => false)(source)) ≡ []` — filter annihilation.
- `Array.from(groupBy(k)(source).values()).flat()` is a permutation of
  `toArray(source)` — `groupBy` preserves all items.

### 7.4 Fixtures

`test/unit/operators/fixtures.ts` exports:

```typescript
// A generator that yields 0..n-1 and records whether return() was called.
export function trackedRange(n: number): {
  source: AsyncIterable<number>;
  returnCalled: () => boolean;
};

// A generator that yields 0..n-1 but throws at item `throwAt`.
export function throwingAt(throwAt: number, n: number): AsyncIterable<number>;

// A generator that yields indices only when pulled, tracking pull count.
export function pullCounter(): {
  source: AsyncIterable<number>;
  pullCount: () => number;
};

// A four-stage tracked pipeline: each stage records whether its return()
// was called. Used to verify multi-hop cascade cleanup.
export function trackedPipeline4(n: number): {
  stage0: AsyncIterable<number>;           // upstream-most source (the "range")
  stage1: (s: AsyncIterable<number>) => AsyncIterable<number>;   // passthrough 1
  stage2: (s: AsyncIterable<number>) => AsyncIterable<number>;   // passthrough 2
  stage3: (s: AsyncIterable<number>) => AsyncIterable<number>;   // passthrough 3
  returnCalled: () => { s0: boolean; s1: boolean; s2: boolean; s3: boolean };
};

// A predicate factory returning a real PromiseLike (not a Promise).
// Pins the Round 1 Awaitable = T | PromiseLike<T> widening.
export function awaitablePredicate<T>(
  fn: (value: T) => boolean,
): (value: T) => PromiseLike<boolean>;

// A shared async predicate that throws when called with throwFor(value)
// returning true. Used across filter / find / groupBy tests.
export function throwingPredicate<T>(
  throwFor: (value: T) => boolean,
  error: Error,
): (value: T) => Promise<boolean>;

// A generator that yields 0..n-1 but self-invokes `return` on itself
// after `abortAt` yields — simulating a Phase 7 primitive reacting to
// `ctx.signal.aborted`. Used to verify downstream operators tolerate
// source self-abort cleanly.
export function abortableRange(abortAt: number, n: number): AsyncIterable<number>;
```

These fixtures are deliberately minimal and coupling-free — every test
builds its `sut` from the operator under test plus one or two fixtures,
never another operator under test (except `toArray` as a verification
sink, which is legitimized by its own floor test in §7.3).

### 7.5 Cleanup-protocol tests

The §7.3 bullets already require source `return()` on short-circuit per
operator. The scenarios below lock the broader cleanup guarantees.

**Multi-hop cascade (mandatory).** The Round 1 version composed `pipe`,
`take`, and `toArray` in the assertion — so a mutation in any of them
could mask the cleanup bug in another. Rewritten to use a manual
consumer loop so only the stage passthroughs (fixtures, not operators
under test) are exercised in the test wiring:

```typescript
// Arrange
const { stage0, stage1, stage2, stage3, returnCalled } = trackedPipeline4(1000);
const sut = stage3(stage2(stage1(stage0)));

// Act — manual consumer; no operators under test in the wiring
const seen: number[] = [];
for await (const value of sut) {
  seen.push(value);
  if (seen.length >= 3) break;
}

// Assert: exactly 3 items
expect(seen).toEqual([0, 1, 2]);

// Assert: return() fired on every upstream stage, not just the immediate one
const closed = returnCalled();
expect(closed.s0).toBe(true);  // upstream-most
expect(closed.s1).toBe(true);
expect(closed.s2).toBe(true);
expect(closed.s3).toBe(true);
```

**Consumer-`throw` cascade.** For each transforming operator (`filter`,
`map`, `flatMap`, `take`), a test shaped:

```typescript
const { source, returnCalled } = trackedRange(100);
const sut = filter(() => true)(source);

try {
  for await (const _v of sut) {
    throw new Error('consumer abort');
  }
} catch {
  // expected
}
expect(returnCalled()).toBe(true);
```

Kills mutants that omit the `for await` cleanup protocol from any operator
body (would require manual iteration — forbidden by §6.11).

**Source self-abort tolerance.** Using `abortableRange(5, 100)` (source
calls its own `return` after 5 yields), assert that each transforming
operator tolerates the early end cleanly — no throw, partial result, source
cleaned up. Models a Phase 7 primitive reacting to
`ctx.signal.aborted`.

**`flatMap` inner-iterator cleanup on outer cut.** Already covered in the
`flatMap` operator block above — the `take(1) + flatMap(() => innerTrackedRange)`
test. Listed here as a cross-reference so the cleanup story is in one place.

### 7.6 Expected equivalent mutants

Per Phase 5 §12.3 convention, document equivalent mutants ahead of the
Stryker run so implementers don't spend cycles chasing them:

| Operator  | Mutation                                                     | Why equivalent                                                                                                               |
| --------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `take`    | `yielded >= count` ↔ `yielded > count - 1`                   | Integer arithmetic equivalence; both terminate on the same iteration.                                                        |
| `groupBy` | `if (bucket)` ↔ `if (bucket !== undefined)`                  | `Map.prototype.get` returns `T[] \| undefined`; non-undefined values are always truthy (non-empty arrays / non-null objects). |
| `pipe`    | `fns.reduce((acc, fn) => fn(acc), initial)` loop-form variants | `reduce` and `for-of` compile to the same iteration order / side effects; Stryker may mutate without observable change.      |
| `toArray` | `count >= limit` ↔ `count > limit - 1`                       | Same as `take` — integer arithmetic.                                                                                         |

If Stryker flags any of these as surviving, annotate with a
`// stryker-disable-next-line equivalent-mutant -- see §7.6` comment (with
explicit rationale referencing the table) — per CLAUDE.md, ignore
directives require this justification path rather than silent suppression.

### 7.7 Mutation-resistant specifics (consolidated)

- **`take` guard tests isolated.** `-2` hits only the `count < 0` arm
  (integer); `1.5` hits only the `!Number.isInteger` arm; `NaN` and
  `Infinity` share the `!Number.isInteger` arm with `1.5` (they are
  behavioral documentation, not mutation-killing beyond `1.5`). Together
  `-2` and `1.5` kill the `||` ↔ `&&` mutation.
- **All `RangeError` assertions use `.message` regex.** `take` (5 cases),
  `toArray` (3 cases), `groupBy` (2 cases). StringLiteral mutants in
  messages survive class-only checks.
- **`pipe` overload exactness.** Direct tests at 1, 2, 5, 9 function
  chains (plus the 10-function overflow test for the loop bound). Type-
  level tests verify each overload's inferred return via `expectTypeOf`.
- **`flatMap` return-shape tests.** Four separate tests for `Iterable`,
  `AsyncIterable`, `Promise<Iterable>`, `Promise<AsyncIterable>`. The
  current `for await`-based implementation is naturally branch-free (no
  `Symbol.iterator` probe), so these tests serve as type-coverage
  documentation plus the microtask-observable `await` kill test.
- **`groupBy` `if (bucket)` / `else` branches** — both exercised by the
  repeated-key test and the first-of-key tests. Mutation to invert the
  `if` would break the "same key appends" invariant.
- **`filter` / `map` / `find` body mutations** enumerated per-operator in
  §7.3; the condition-flip and `await`-drop tests cover the surface that
  §7.4 of Round 1 omitted.

### 7.8 No property-based tests for `pipe`

`pipe`'s `reduce`-over-fns implementation is too generic for meaningful
fast-check arbitraries. Its correctness is enforced by the direct tests
in §7.3 and the overload type-tests.

---

## 8. Integration with Other Phases

### 8.1 Consumer summary

| Phase  | Module                                     | Operators used                        |
| ------ | ------------------------------------------ | ------------------------------------- |
| 7      | `walkCommits` → `AsyncIterable<Commit>`    | produced; callers use any operator    |
| 7      | `walkTree` → `AsyncIterable<TreeEntry>`    | produced; callers use any operator    |
| 7      | `diffTreesRecursive` → `AsyncIterable<…>`  | produced; callers use any operator    |
| 8      | `withRetry` / `withAuth` / `withLogging`   | none (plain unary fns; see §6.3)      |
| 9      | `log` command                              | `pipe` + `filter` + `take` + `toArray` |
| 9      | `status` command                           | `flatMap` + `filter` + `toArray`      |
| 9      | `diff` command                             | `filter` + `map` + `groupBy`          |
| 10     | `repository.ts` facade                     | `pipe` (to compose transport middleware at the facade layer — see §6.3) |

No Phase 6 changes are required for these consumers — the API is stable
by design.

### 8.2 Phase-ownership obligations

Obligations that belong to other phases but are load-bearing for Phase 6
correctness. Mirrors the `diff-and-merge.md §15` pattern.

| #  | Owner phase | Obligation                                                                                                                                                      | Rationale                                                                                                                                       | Verification                                                          |
| -- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 1  | Phase 7     | Sources check `ctx.signal?.aborted` between each `yield`                                                                                                        | Operators don't see `Context`; cancellation polling is a source responsibility.                                                                 | Phase 7 `walkCommits`/`walkTree` unit test with `AbortController`.    |
| 2  | Phase 7     | Source generators close their file handles / buffers in a `try/finally` block so iterator `return()` triggers cleanup                                           | Phase 6's multi-hop cascade test (§7.5) assumes cleanup runs on `return()`; if a primitive leaks handles, cleanup silently fails in production. | Phase 7 tests must spy on `FileSystem` close calls after `take(N)`.   |
| 3  | Phase 7/8   | Primitives that wrap an HTTP body `ReadableStream` must propagate generator `return()` to `AbortController.abort()` on the inflight request                     | `return()` alone stops reading; the connection only closes when the adapter aborts. Otherwise a `take(N)` pipeline leaks the TCP socket.        | Phase 7 integration test: open a stream, `take(1)`, assert the HTTP response's `AbortSignal` fired. |
| 4  | Phase 7     | `FlatTree` / recursive tree walkers that consume `flatMap` must tolerate inner-iterable exhaustion before the next outer pull                                   | Phase 6's `flatMap` is sequential, not interleaved — order is deterministic.                                                                    | Phase 7 `diffTreesRecursive` property test for deterministic ordering. |
| 5  | Phase 9     | `reduce`-style aggregations compose `await pipe(source, take(N), toArray)` then `Array.prototype.reduce` — never `toArray` without a bounded upstream           | Avoids unbounded materialization (see §6.9).                                                                                                    | Command-level review checklist during Phase 9.                        |
| 6  | Phase 6     | **No error-union extension.** Operators throw standard JS errors (`RangeError` for `take`). Do not contribute variants to `TsgitErrorData`.                     | Operators are domain-agnostic; coupling them to `TsgitError` would force every external consumer to learn tsgit's union.                        | Absence of `domain/error.ts` edits in Phase 6 commits; CI would flag. |

### 8.3 Non-obligation — operators never observe `Context`

Operators do **not** receive or observe `Context`. This is a hard rule, not a
simplification:

- The dep-cruiser rule `operators-must-be-standalone` forbids
  `operators → ports/` (where `Context` lives).
- Cancellation cadence is a source concern (obligation #1 above) — operators
  just pull values and cascade cleanup.
- If a future operator genuinely needed `Context` (e.g. an operator that
  reads from storage), it belongs in `application/primitives/`, not here.

### 8.4 Trust boundary — operators treat items as opaque

Operators make **no assumption about the semantic validity of yielded
values** — each item is an opaque `T` as far as the pipeline is concerned.
Concretely:

- When Phase 7's `walkCommits` wraps a malicious packfile and yields values
  typed as `Commit`, the objects may be structurally invalid (fabricated
  SHAs, mismatched headers, truncated messages). Operators do not inspect
  contents: `filter(byAuthor)` is the user's chosen predicate and fires
  whatever condition the user wrote; `map`/`flatMap` transform; `groupBy`
  keys without validating.
- **Semantic validation is the source primitive's responsibility** — the
  Phase 7 layer that reads / parses from the packfile. If hostile bytes
  can reach the operator, the Phase 7 primitive already failed its
  contract.
- This clarifies the attack surface for security review: an attacker-
  controlled source is a Phase 7 concern, not a Phase 6 concern, and
  Phase 6's defenses (`take` + `limit` params) are there to bound
  **volume**, not validate **contents**.

---

## 9. Non-Goals (explicit)

| Feature                               | Why not in V1                                                         |
| ------------------------------------- | --------------------------------------------------------------------- |
| `concat` / `merge` / `zip`            | No Phase 7–9 consumer needs them. Compose with `flatMap` if required.  |
| `tap` / `forEach`                     | `for await … of result` is the idiomatic side-effect sink.            |
| `reduce` / `scan`                     | `toArray` + `Array.prototype.reduce` for **bounded** sources only (see §6.9). |
| Sync `Iterable<T>` overloads          | Every real source is async. Wrap sync with `async function*`.         |
| Parallel variants (`mapParallel`)    | Concurrency belongs in Phase 7 (primitive-level semaphore). **Re-open criterion:** if a Phase 9 command-level benchmark cannot hit PRD §6 targets (3–5× isomorphic-git on log / status / readBlob / clone) without consumer-level parallel fan-out, revisit this decision before v1.0. |
| `AbortSignal` integration              | Source primitives check `ctx.signal.aborted`; iterator `return()`    |
|                                       | protocol cascades cancellation. No operator-level signal plumbing.     |
| Run-length `groupBy`                   | Semantic footgun in buffered consumers. Add `chunkBy` later if needed.|
| Index-aware callbacks                  | YAGNI. Not used by any Phase 7–9 consumer.                            |
| Custom `pipe` operator (`|>`)          | Not stage-4 TC39. Use the function.                                   |
| `Observable` / push-based streams      | Pull-based AsyncIterable is git's natural cadence.                    |

---

## 10. Implementation Order

Following internal dependencies (there are essentially none):

0. **`pipe.ts`** — pure, no source, foundational. All tests type-heavy.
1. **Fixtures: `test/unit/operators/fixtures.ts`** — `trackedRange`,
   `throwingAt`, `pullCounter`, `trackedPipeline4`, `awaitablePredicate`,
   `throwingPredicate`, `abortableRange`. Shared by every downstream
   operator test. **Ordered before `toArray`** because `toArray`'s red-phase
   tests include "source throws mid-iteration" which needs `throwingAt`.
2. **`types.ts`** — `Awaitable<T>` (five-site shared alias crossing the §6.7
   threshold). `UnaryFn<A, B>` and `FlatMapReturn<U>` stay inline until they
   also cross three sites.
3. **`to-array.ts`** — uncurried terminal. Its own tests bottom out on a
   manual `for await … of` loop (§7.3 floor) so downstream operator tests
   can use `toArray` as a verification sink without circularity.
4. **`map.ts`** — simplest transforming operator; template for the rest.
5. **`filter.ts`** — mirror of `map`.
6. **`take.ts`** — introduces the `return()`-cascade testing pattern and
   validation-at-call-time.
7. **`find.ts`** — terminal + short-circuit.
8. **`flat-map.ts`** — `for await` delegation (not `yield*`, per §5.4).
9. **`group-by.ts`** — terminal + buffered + `limit` param.
10. **`index.ts`** — flat barrel re-export.
11. **Composition laws: `test/unit/operators/laws.test.ts`** — property tests
    from §7.3 (take∘take, filter∘filter, map fusion, filter/map commutation,
    flatMap singleton identity, toArray length/identity, filter annihilation,
    groupBy flat permutation). Depends on all operators being green.
12. **Branch finalization.** Before merging to main:
    - `npm run validate` — full quality gate (types, tests, coverage, size,
      architecture, spelling).
    - **`stryker run`** — mutation testing. Fix every non-equivalent
      survivor. Equivalent mutants per §7.6 annotated with disable
      comments (with §7.6 cross-reference).
    - Parallel reviews (code, security, perf, test) per CLAUDE.md
      post-build workflow.
    - Update `docs/BACKLOG.md`: `[ ]` → `[x]` for items 6.1–6.8.
    - Commit, squash-and-merge, delete feature branch.

```
Step 0 (pipe)      ─── independent
Step 1 (fixtures)  ─── test-only, needed by 3..9 (and §7.5 cascade test)
Step 2 (types.ts)  ─── needed by 4..9 (via Awaitable<T>)
Step 3 (toArray)   ─── depends on Step 1 (fixtures) for throw-source test

Step 4 (map)     ──┐
Step 5 (filter)  ──┼── parallelizable after Steps 1 + 2 + 3
Step 6 (take)    ──┤
Step 7 (find)    ──┤
Step 8 (flatMap) ──┤
Step 9 (groupBy) ──┘

Step 10 (index.ts)    ─── depends on 0..9
Step 11 (laws test)   ─── depends on Step 10
Step 12 (finalize)    ─── Stryker + reviews + merge (per CLAUDE.md)
```

Each step: test (red) → implement (green) → refactor → `npm run check:types &&
npm run test:unit && npm run check:architecture && npm run check:size`.
Commit per step with message `feat(operators): add <name> — <what it does>`.

---

## 11. Open Questions

1. **When to extract `src/operators/types.ts`.** §4 states the threshold
   (more than three call sites). `Awaitable<T>` hits five. The extraction is
   a one-file addition deferred to Step 2 of the implementation plan to keep
   the initial green + refactor cycles tight. Net effect: no change to the
   public API.

Otherwise the design is intentionally minimal; all decisions are captured in
§6. Any deviation surfaces in Round 2 review notes per the project convention.
