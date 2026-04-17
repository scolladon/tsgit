# Plan: Phase 6 — Operators

Implements [design/operators.md](../design/operators.md).
Covers [backlog](../BACKLOG.md) items 6.1–6.8.

### Review Notes

Changes applied after Round 1 review (architect + code-reviewer + test-review agents, plus a personal close-read that verified claims against the repo):

- **`vitest.config.ts` coverage `include` actually updated** — the original Prereq #2 claimed operators were already globbed, but the config lacked `src/operators/**/*.ts`. Without the entry, Phase 6 files would ship at 0% covered with the 100% threshold silently inapplicable. Config now includes operators; Prereq #2 rewritten to reflect the landed change.
- **`check:size` dropped from per-step verify chain.** `size-limit` measures `dist/esm/operators/index.js` which only exists after `npm run build`; per-step verify doesn't rebuild, so the check was dead. Moved to Step 10 (post-barrel) and Step 12 (finalization) only.
- **Steps 0 and 3 gained fenced code sketches** — every other operator step had one; the prose-only form left too much room for implementer drift. Both now reproduce the design's sketch verbatim.
- **Step 0 overload count drift fixed** — the plan said "10 overload declarations" but the design specifies 9 typed overloads + 1 untyped implementation signature (10 function declarations total). Now matches §5.1 exactly.
- **Step 0 duplicate pipe tests distinguished** — the zero-function and empty-rest tests hit the same reduce path; the empty-rest test now explicitly uses `pipe(x, ...([] as []))` to force the rest-parameter path.
- **Step 1 restructured Test-first first** — the original "Fixtures to implement / Test first" ordering was inverted for strict TDD. Fixtures are test scaffolding so their red-phase is a contract lock, not a behavioral red; made that explicit.
- **Step 1 `awaitablePredicate` generalized to `awaitable<T>(fn)`** — Step 4 (`map`) needs an async-mapper fixture and there was no `awaitableMapper`. Generalizing once covers `filter`, `map`, `find`, `groupBy`, `flatMap` callbacks.
- **Step 2 switched from `.test-d.ts` to `.test.ts` with inline `expectTypeOf`** — vitest's `unit` project globs `test/unit/**/*.test.ts`; `.test-d.ts` isn't picked up without a typecheck config, so the type assertions would never have run. `expect-type@1.3.0` ships transitively under `node_modules/` (verified). Negative type cases use `@ts-expect-error` to pin rejection.
- **§7.5 cleanup tests added per transforming operator** — Steps 4/5/6/8 now cover (a) consumer-throw cascade, (b) source-self-abort tolerance via `abortableRange`. The `abortableRange` fixture was otherwise dead after Step 1.
- **Step 6 (take) absorbs the multi-hop cascade test.** `trackedPipeline4` was built in Step 1 and self-tested, then never consumed. Take is the natural cascade trigger; this is where the flagship §7.5 four-stage assertion lives. Uses a manual `for await … break` consumer (not `pipe` / `take` / `toArray` in the wiring — decoupled per design §7.5).
- **Step 7 (find) gains a `pullCounter` pull-count assertion** — predicate-spy count is not equivalent to source pulls; a buggy implementation could diverge. Added one test asserting exactly `index-of-match + 1` source pulls.
- **Step 8 (flatMap) test rewritten without `pipe` / `take`.** The Round-1 draft composed three operators-under-test in the flatMap cleanup assertion. Now uses a manual outer consumer that breaks after one item. Also added an outer-source-throws test (only inner-throws was present). Deps list updated.
- **Step 9 (groupBy) else-branch isolated.** First-of-key and repeated-key now separate tests so the `if (bucket)` ↔ `else` branches can't both be masked by one composite test.
- **Step 10 exports alphabetized.** Biome `organizeImports` is `"on"` — non-alphabetical order would have produced diff churn on the first `biome check --write` run.
- **Step 11 dependency widened from "Step 10" to "Steps 0 + 3–9".** The barrel is convenience; the real semantic requirement is every operator's behavior being green. Stated explicitly.
- **Step 12 equivalent-mutant annotations land inline at green-phase** — CLAUDE.md wants the rationale at the mutated line, not in finalization prose. Plan now instructs implementers to add `// Stryker disable next-line all -- equivalent, see design §7.6` (Stryker's canonical directive) during each operator's green-phase, not retroactively.
- **Post-Plan section dropped `git pull`** — this repo has no remote configured; the `pull` would have failed or been a no-op. Kept `git checkout main` only.

---

### Backlog → Step Mapping

| Backlog item | Description | Steps |
|---|---|---|
| **6.1** | `pipe` | 0 |
| **6.2** | `filter` | 5 |
| **6.3** | `map` | 4 |
| **6.4** | `flatMap` | 8 |
| **6.5** | `take` | 6 |
| **6.6** | `find` | 7 |
| **6.7** | `toArray` | 3 |
| **6.8** | `groupBy` | 9 |
| — | Test fixtures (`trackedRange`, `pullCounter`, `throwingAt`, `trackedPipeline4`, `awaitablePredicate`, `throwingPredicate`, `abortableRange`) | 1 |
| — | Shared type `Awaitable<T>` module | 2 |
| — | Barrel export `index.ts` | 10 |
| — | Composition-law property tests | 11 |
| — | Mutation testing + 4× parallel reviews + merge | 12 |

---

## Workflow

Each step follows TDD: write test (red) → implement (green) → refactor.
After every green step run: `npm run check:types && npm run test:unit && npm run check:architecture`.

**Commit strategy.** One commit per completed step (green + refactor). Message format: `feat(operators): add <name> — <what it does>`. Work on the existing `plan/phase-6-operators` branch until the plan itself lands, then **open a fresh implementation branch** (`feat/phase-6-operators` or a worktree under `.claude/worktrees/phase-6-operators`) for the code — never commit directly to main.

**Size gate.** The 5 kB gzipped cap on `dist/esm/operators/index.js` is verified by `npm run check:size` (size-limit). Because `size-limit` measures the built artifact in `dist/`, it requires an `npm run build` first — it does **not** run as part of the per-step verify chain. Instead it runs at **Step 10 (barrel, when the dist tree is wired for real)** and **Step 12 (finalization)**. If either of those gates fails, stop and restructure before proceeding.

---

## Prerequisites (before Step 0)

1. **Directories:** `src/operators/` already exists with an empty `index.ts`. No new directories needed. Create `test/unit/operators/` on demand in Step 1.
2. **vitest config:** `vitest.config.ts` has been updated to include `src/operators/**/*.ts` in the coverage globs (landed on this plan branch alongside the Round 1 fixes). The 100% statement/branch/function/line thresholds apply to operators from Step 0 onward. **Verified:** `npm run test:coverage` reports 100% after the include change with the operators directory empty except for the `export {};` placeholder (zero-denominator passes the threshold).
3. **ls-lint:** `.ls-lint.yml` already covers `src/operators/` with kebab-case — no new rule.
4. **dependency-cruiser:** rule `operators-must-be-standalone` already in `.dependency-cruiser.cjs` — enforces zero domain/app/ports/adapters/transport imports. No update needed.
5. **knip / cspell / jscpd:** current configs handle the new paths; cspell lexicon was extended during the design rounds (includes `thenables`, `microtasks`, `desugars`, etc.).
6. **package.json `exports`:** `./operators` entry already points at `dist/esm/operators/index.js` + types — no change.
7. **`.size-limit.json`:** entry `"Operators"` already configured with `limit: "5 kB"`, `gzip: true`. Ratchet lives here.
8. **No new runtime dependencies.** `fast-check` is already a devDependency; used for property tests in Step 11.

---

## File Conventions

- Source files under `src/operators/`.
- Test files under `test/unit/operators/`.
- File names: kebab-case (enforced by ls-lint). `flatMap.ts` → `flat-map.ts`, `groupBy.ts` → `group-by.ts`, `toArray.ts` → `to-array.ts`.
- Test file names: `<module>.test.ts`. Fixtures live in `fixtures.ts`. Property tests in `laws.test.ts`.
- **Test format:** Given/When/Then titles, AAA bodies with `// Arrange` / `// Act` / `// Assert` comments, `sut` variable. See CLAUDE.md and design §7.1.
- **Import extensions:** all imports MUST use the `.js` extension (ESM / verbatimModuleSyntax).
- **Zero non-operator imports in operator files.** Dep-cruiser rule `operators-must-be-standalone` blocks any import from `domain/`, `application/`, `ports/`, `adapters/`, `transport/`. The only imports allowed are between operator files (e.g. `index.ts` re-exporting siblings; operators importing `Awaitable<T>` from `types.ts` after Step 2).
- **Error types:** standard JS only (`RangeError`, `TypeError`). Never `TsgitError` — operators are domain-agnostic.
- **Return type discipline:** non-terminal operators return `AsyncIterable<T>` (NOT `AsyncGenerator<T, void, unknown>`). Implementations must annotate the return type explicitly. Design §6.10.
- **Iteration protocol:** non-terminal operators MUST iterate sources via `for await … of`. Manual `[Symbol.asyncIterator]()` + `.next()` is forbidden. Design §6.11.

---

## Design Decisions (applied in this plan)

- **Step 1 (fixtures) precedes Step 3 (`toArray`)** — `toArray`'s red-phase "source throws mid-iteration" test needs `throwingAt` from fixtures. Without this ordering, Step 3 has an incomplete red phase. Design §10 final order.
- **Step 2 (`types.ts`) lands before the operators that use `Awaitable<T>`** — `filter`, `map`, `find`, `flatMap`, `groupBy` all import it. Extracting it once (five sites crosses the design §4/§6.7 threshold) beats duplicating five times and then refactoring later.
- **Step 11 (composition laws)** is its own file — `test/unit/operators/laws.test.ts`. Depends on all eight operators being green. Property tests use `fast-check` (already a devDependency).
- **Property tests stay stateless.** Fast-check arbitraries generate fresh async iterables per run; no shared mutation between properties.
- **Manual consumer loops in cascade tests (§7.5)** — the multi-hop cascade test does not use `pipe` / `take` / `toArray` in its consumer wiring. Uses a plain `for await (const v of sut) { seen.push(v); if (seen.length >= 3) break; }`. Decoupled from operators-under-test per the Round 2 review.
- **`toArray` own tests bottom out on a manual `for await` loop** — not on any other operator. Floor test in Step 3. All later operator tests may use `toArray` as a verification sink.
- **Every invalid-input test asserts on `.message` regex** — never `toThrow(RangeError)` alone. Mutation-resistant per CLAUDE.md.
- **Expected equivalent mutants documented ahead of Stryker** (design §7.6): `take` integer loop bound, `groupBy` `if (bucket)` truthy check, `pipe` reduce vs for-of. Annotate survivors with `// stryker-disable-next-line equivalent-mutant -- see §7.6`.

---

## Step 0: `pipe.ts` — generic value pipeline

**Create:** `src/operators/pipe.ts`, `test/unit/operators/pipe.test.ts`

Depends on: nothing. Foundational, no source-iteration, no fixtures.

### Test first (red)

```
Given no functions (pipe(42)), When sut is called, Then it returns 42 (overload-1 identity path)
Given a single function f, When pipe(x, f) is called, Then it returns f(x)
Given two functions f and g, When pipe(x, f, g) is called, Then it returns g(f(x)) — left-to-right
Given an async function returning Promise<B>, When piped, Then the next function receives a Promise (pipe never awaits)
Given a function that throws at step 2 of 3, When pipe is called, Then step 3 is never invoked (spy confirms zero calls)
Given nine unary functions, When pipe is invoked with all nine, Then output equals their sequential composition
Given ten unary functions (beyond the 9 overloads; user-side `as` cast), When pipe is invoked, Then output equals their sequential composition — kills `fns.length` off-by-one mutations
Given an empty rest array materialized via pipe(x, ...([] as [])), When pipe is invoked through the rest-parameter path (distinct from overload-1), Then output equals the seed — forces the reduce over a zero-length array rather than matching overload-1
```

Plus `expectTypeOf`-style type-level tests for each of the 9 overload *declarations* (cover the 1-, 2-, 5-, and 9-arg paths — no need to write all 9 to get mutation coverage on the overload list). `expect-type@1.3.0` is already resolved transitively under `node_modules/vitest` and usable via `import { expectTypeOf } from 'expect-type';`.

### Implement (green)

Per design §5.1. Reproduce the full overload chain — **9 typed overloads** (arities 1–9) + **1 untyped implementation signature** = 10 function declarations total, single shared body:

```typescript
type UnaryFn<A, B> = (value: A) => B;

export function pipe<A>(a: A): A;
export function pipe<A, B>(a: A, ab: UnaryFn<A, B>): B;
export function pipe<A, B, C>(a: A, ab: UnaryFn<A, B>, bc: UnaryFn<B, C>): C;
export function pipe<A, B, C, D>(
  a: A, ab: UnaryFn<A, B>, bc: UnaryFn<B, C>, cd: UnaryFn<C, D>,
): D;
export function pipe<A, B, C, D, E>(
  a: A, ab: UnaryFn<A, B>, bc: UnaryFn<B, C>, cd: UnaryFn<C, D>, de: UnaryFn<D, E>,
): E;
export function pipe<A, B, C, D, E, F>(
  a: A, ab: UnaryFn<A, B>, bc: UnaryFn<B, C>, cd: UnaryFn<C, D>,
  de: UnaryFn<D, E>, ef: UnaryFn<E, F>,
): F;
export function pipe<A, B, C, D, E, F, G>(
  a: A, ab: UnaryFn<A, B>, bc: UnaryFn<B, C>, cd: UnaryFn<C, D>,
  de: UnaryFn<D, E>, ef: UnaryFn<E, F>, fg: UnaryFn<F, G>,
): G;
export function pipe<A, B, C, D, E, F, G, H>(
  a: A, ab: UnaryFn<A, B>, bc: UnaryFn<B, C>, cd: UnaryFn<C, D>,
  de: UnaryFn<D, E>, ef: UnaryFn<E, F>, fg: UnaryFn<F, G>, gh: UnaryFn<G, H>,
): H;
export function pipe<A, B, C, D, E, F, G, H, I>(
  a: A, ab: UnaryFn<A, B>, bc: UnaryFn<B, C>, cd: UnaryFn<C, D>,
  de: UnaryFn<D, E>, ef: UnaryFn<E, F>, fg: UnaryFn<F, G>,
  gh: UnaryFn<G, H>, hi: UnaryFn<H, I>,
): I;
export function pipe<A, B, C, D, E, F, G, H, I, J>(
  a: A, ab: UnaryFn<A, B>, bc: UnaryFn<B, C>, cd: UnaryFn<C, D>,
  de: UnaryFn<D, E>, ef: UnaryFn<E, F>, fg: UnaryFn<F, G>,
  gh: UnaryFn<G, H>, hi: UnaryFn<H, I>, ij: UnaryFn<I, J>,
): J;
export function pipe(
  initial: unknown,
  ...fns: ReadonlyArray<UnaryFn<unknown, unknown>>
): unknown {
  // Stryker disable next-line all -- equivalent mutant: `Array.prototype.reduce` ↔ for-of loop variants produce identical observable behavior (design §7.6)
  return fns.reduce((acc, fn) => fn(acc), initial);
}
```

`UnaryFn<A, B>` is inline — single-file use, below the §4 / §6.7 extraction threshold.

### Refactor

No per-overload branching; the single `reduce` body is already minimal.

### Verify

```bash
npm run check:types && npm run test:unit && npm run check:architecture
```

---

## Step 1: `fixtures.ts` — shared test fixtures

**Create:** `test/unit/operators/fixtures.ts`, `test/unit/operators/fixtures.test.ts`

Depends on: nothing. Test-only module; no source code under `src/operators/` in this step.

**Note on TDD ordering.** Fixtures are test scaffolding, not behavioral code. Their "red phase" is a **contract-lock** (does `returnCalled()` report `true` after a consumer break? does `pullCounter` tick exactly once per pull?) — there is no meaningful red-before-green for the fixtures themselves because the test exercises the fixture contract. Write the fixture self-tests and the fixture implementation together in one red → green → refactor cycle, then commit.

### Test first (red) — fixture contract self-tests

In `test/unit/operators/fixtures.test.ts`:

```
Given a trackedRange(3), When iteration completes normally, Then returnCalled() is false (for await runs to source end without an explicit return)
Given a trackedRange(10), When consumer breaks at item 3, Then returnCalled() is true
Given a pullCounter, When no iteration happens, Then pullCount() is 0
Given a pullCounter, When consumer pulls 5 items, Then pullCount() is 5
Given a throwingAt(2, 10), When consumer pulls past item 1, Then iteration throws on item 2
Given an awaitable(() => true), When awaited, Then resolves to true AND the returned value is NOT an instance of Promise — verify via `Object.getPrototypeOf(result) !== Promise.prototype` (pins the PromiseLike-but-not-Promise distinction)
Given an abortableRange(3, 10), When iterated to completion, Then exactly [0,1,2] is yielded (source self-closed at 3)
Given a throwingPredicate(x => x === 2, err), When called with 1 then 2, Then 1 resolves false and 2 rejects with err
Given a trackedPipeline4(100) composed as stage3(stage2(stage1(stage0))) with a manual for-await consumer breaking at 3, When iteration exits the loop, Then returnCalled().s0/s1/s2/s3 are all true
```

### Fixtures to implement (green)

Per design §7.4:

- `trackedRange(n)` — yields `0..n-1`; records `returnCalled()` flag via generator `try/finally`.
- `throwingAt(throwAt, n)` — yields `0..n-1` but throws on item `throwAt`.
- `pullCounter()` — finite-but-large source yielding indices only when pulled, tracking `pullCount()`. Upper bound `Number.MAX_SAFE_INTEGER` — callers bound via consumer `break`.
- `trackedPipeline4(n)` — returns `{ stage0, stage1, stage2, stage3, returnCalled }`. `stage0` is the upstream range; `stage1..3` are passthrough async generators that record their `return()` via per-stage `try/finally` closures.
- **`awaitable<T>(fn)`** (generalized from the design's `awaitablePredicate`) — wraps `fn: (value: TArg) => T` in a real `PromiseLike<T>` via `{ then(resolve) { queueMicrotask(() => resolve(fn(value))) } }`. Distinct from `Promise`. Covers both `awaitablePredicate` (when `T = boolean`) and `awaitableMapper` (when `T` is the mapper output type) — the design's five Awaitable call sites (`filter`, `map`, `find`, `groupBy`, `flatMap`) all go through this one fixture.
- `throwingPredicate<T>(throwFor, error)` — async predicate that throws `error` when `throwFor(value)` returns `true`.
- `abortableRange(abortAt, n)` — yields `0..abortAt-1` and then invokes `return` on itself (simulating a Phase 7 source reacting to `ctx.signal.aborted`).

Each fixture is a small async generator + a closure variable exposing the tracked state. Keep each fixture under ~25 lines; no shared helpers unless duplication crosses three.

### Refactor

If `trackedRange` and `abortableRange` share implementation (both yield `0..N-1`), keep them distinct — the abort semantics are a different contract, worth a dedicated function.

### Verify

```bash
npm run check:types && npm run test:unit
```

---

## Step 2: `types.ts` — shared `Awaitable<T>`

**Create:** `src/operators/types.ts`

Depends on: nothing (pure type alias).

### Type to export

```typescript
/**
 * Callback return that may be resolved synchronously or via any thenable.
 * Uses `PromiseLike<T>` — the exact shape `await` accepts under ES2022 —
 * so custom thenables and test doubles compose cleanly.
 */
export type Awaitable<T> = T | PromiseLike<T>;
```

Only `Awaitable<T>` is extracted in this step — `UnaryFn<A, B>` and `FlatMapReturn<U>` stay inline in `pipe.ts` and `flat-map.ts` respectively, below the §4 / §6.7 three-site threshold.

### Test first (red)

No runtime tests — this file has no runtime behavior. Use **`test/unit/operators/types.test.ts`** (regular `.test.ts`, NOT `.test-d.ts`) with inline `expectTypeOf` assertions. The unit project globs `test/unit/**/*.test.ts`; `.test-d.ts` files are not picked up without an additional `typecheck.enabled: true` config that this project does not set. `expect-type@1.3.0` is resolved transitively under `node_modules/` (verified) and importable directly.

Tests:

```
Given a value of type T, When used in an Awaitable<T> position, Then expectTypeOf<T>().toMatchTypeOf<Awaitable<T>>() holds
Given a Promise<T>, When used in an Awaitable<T> position, Then expectTypeOf<Promise<T>>().toMatchTypeOf<Awaitable<T>>() holds
Given a PromiseLike<T> with a then method (custom thenable), When used in an Awaitable<T> position, Then expectTypeOf<PromiseLike<T>>().toMatchTypeOf<Awaitable<T>>() holds — pins the PromiseLike (not Promise) widening
Given a non-thenable object unrelated to T, When used in an Awaitable<T> position, Then TS rejects via @ts-expect-error on the erroneous assignment (uncomment to verify; leave commented with the directive in CI)
```

Sketch:

```typescript
import { expectTypeOf } from 'expect-type';
import type { Awaitable } from '../../../src/operators/types.js';

test('Given value T, Then assignable to Awaitable<T>', () => {
  // Arrange / Act / Assert via type-only assertion
  expectTypeOf<number>().toMatchTypeOf<Awaitable<number>>();
});

test('Given PromiseLike<T>, Then assignable to Awaitable<T>', () => {
  expectTypeOf<PromiseLike<string>>().toMatchTypeOf<Awaitable<string>>();
});

test('Given unrelated object, Then TS rejects the assignment', () => {
  // @ts-expect-error — { foo: 1 } is not Awaitable<number>
  const _rejected: Awaitable<number> = { foo: 1 };
  void _rejected;
});
```

### Implement (green)

One-line type export + doc comment. No runtime emission.

### Verify

```bash
npm run check:types && npm run test:unit
```

---

## Step 3: `to-array.ts` — uncurried buffered terminal

**Create:** `src/operators/to-array.ts`, `test/unit/operators/to-array.test.ts`

Depends on: Step 1 (for `throwingAt` / `trackedRange` fixtures). Step 2 not strictly required (`toArray` has no `Awaitable` callback); add the import if the barrel re-exports force it.

### Test first (red)

**Floor tests — build the expected array manually via `for await`, NOT via any other operator. This is the verification floor for all downstream operator tests.**

```
Given an empty source, When sut is awaited, Then [] is returned
Given an async generator yielding [0,1,2], When sut is awaited, Then [0,1,2] is returned (build expectation with a manual for await loop in the test; deep-equal)
Given a trackedRange(5) that throws mid-iteration (throwingAt(3, 10)), When sut is awaited, Then the promise rejects; the partial array is not observable
Given a source of 5 items and limit = 3, When sut is awaited, Then the promise rejects with RangeError whose .message matches /exceeded limit of 3/
Given a source of 3 items and limit = 3 (>= boundary), When sut is awaited, Then [0,1,2] is returned
Given a source of 3 items and limit = 4, When sut is awaited, Then [0,1,2] is returned (no error)
Given an empty source and limit = 0, When sut is awaited, Then [] is returned
Given a one-item source and limit = 0, When sut is awaited, Then RangeError /exceeded limit of 0/
Given limit = -1, When sut is awaited, Then RangeError whose .message matches /non-negative/
Given limit = NaN, When sut is awaited, Then RangeError whose .message matches /non-negative/
```

### Implement (green)

Per design §5.7:

```typescript
export async function toArray<T>(
  source: AsyncIterable<T>,
  limit: number = Number.POSITIVE_INFINITY,
): Promise<T[]> {
  if (Number.isNaN(limit) || limit < 0) {
    throw new RangeError('toArray(limit): must be a non-negative number or Infinity');
  }
  const result: T[] = [];               // Deliberate local mutation — scoped to the async closure; never escapes before return (see design §6.12 boundary)
  for await (const value of source) {
    // Stryker disable next-line all -- equivalent mutant: `>= limit` ↔ `> limit - 1` for integer limit (design §7.6)
    if (result.length >= limit) {
      throw new RangeError(`toArray: exceeded limit of ${limit} items`);
    }
    result.push(value);
  }
  return result;
}
```

**Note on fractional limits.** `limit = 0.5` passes validation (`!NaN && !(< 0)`). It fires on the first item via `0 >= 0.5` being false, `1 >= 0.5` being true — so a one-item source with `limit = 0.5` would yield `[]` then throw on the second push attempt (no second item, so in practice `limit = 0.5` on a one-item source returns `[firstItem]`). This is intentionally accepted — `limit` is typed `number`, not `number & integer`. No test exercises it; design §7.7 doesn't require one.

### Refactor

Extract the `RangeError` messages into a shared `limitError` helper if `groupBy`'s Step 9 will reuse the same phrasing — defer until Step 9 to avoid premature abstraction.

### Verify

```bash
npm run check:types && npm run test:unit && npm run check:architecture
```

---

## Step 4: `map.ts` — transforming

**Create:** `src/operators/map.ts`, `test/unit/operators/map.test.ts`

Depends on: Steps 1, 2, 3 (uses `toArray` as verification sink).

### Test first (red)

```
Given a source [1,2,3] and mapper x => x * 2, When sut is iterated, Then [2,4,6] is yielded (toArray(sut(source)))
Given a source of length N, When sut is iterated, Then the output length equals N
Given map(x => x) (identity mapper), When sut is iterated, Then toArray(sut(source)) deep-equals toArray(source) (functor identity law)
Given an async mapper returning Promise<U>, When sut yields, Then the resolved U is yielded (not the Promise)
Given a mapper wrapped via awaitable<U>(fn) returning PromiseLike<U>, When sut is iterated, Then items are transformed correctly (pins the Awaitable widening to PromiseLike)
Given a mapper that throws on item k, When sut is iterated past k-1, Then error bubbles AND trackedRange.returnCalled() is true
Given a mapper returning Promise<U> whose resolution ticks a counter, When sut yields 3 items, Then the counter reads 3 at completion (kills `await`-drop mutant)
Given a pullCounter source, When sut is constructed but not iterated, Then pullCount() is 0 (laziness)
Given a pullCounter source, When consumer pulls 5 items, Then pullCount() is 5 (no look-ahead)
Given a trackedRange(100) and a consumer that throws after 3 pulls, When the throw exits for-await via try/catch, Then trackedRange.returnCalled() is true (§7.5 consumer-throw cascade)
Given an abortableRange(5, 100), When sut is iterated to completion, Then exactly 5 transformed items are yielded and no error is thrown (§7.5 source-self-abort tolerance)
Type-level: map((n: number) => n.toString()) on AsyncIterable<number> returns AsyncIterable<string>
```

### Implement (green)

Per design §5.3:

```typescript
import type { Awaitable } from './types.js';

export function map<T, U>(mapper: (value: T) => Awaitable<U>) {
  return async function* (source: AsyncIterable<T>): AsyncIterable<U> {
    for await (const value of source) {
      yield await mapper(value);
    }
  };
}
```

### Refactor

One-line body; nothing to extract.

### Verify

```bash
npm run check:types && npm run test:unit && npm run check:architecture
```

---

## Step 5: `filter.ts` — transforming

**Create:** `src/operators/filter.ts`, `test/unit/operators/filter.test.ts`

Depends on: Steps 1, 2, 3.

### Test first (red)

```
Given a source [1,2,3,4] and predicate x => x % 2 === 0, When sut is iterated, Then [2,4] is yielded in source order
Given a predicate returning true for all items, When sut is iterated, Then toArray(sut(source)) deep-equals toArray(source) (identity law)
Given a predicate returning false for all items, When sut is iterated, Then toArray output is [] (annihilation law)
Given an async predicate that returns Promise<true>, When sut yields, Then the item is included
Given a predicate wrapped via awaitable<boolean>(fn) returning PromiseLike<boolean>, When sut is iterated, Then items pass through correctly (pins the Awaitable widening to PromiseLike)
Given a throwingPredicate that throws on item k, When sut is iterated past k-1, Then error bubbles AND source returnCalled() is true
Given a predicate-spy and a consumer that breaks at item 5 of 100, When sut is iterated, Then the predicate is called exactly 5 times (laziness — no look-ahead)
Given a pullCounter source and filter(() => true), When consumer pulls 5 items, Then pullCount() is 5
Given a predicate () => true on source [1], When sut is iterated, Then [1] is yielded
Given the same predicate but returning false, When sut is iterated, Then [] is yielded (paired test kills `if (condition)` ↔ `if (false)` mutation)
Given a predicate returning Promise<boolean> resolving on next microtask, When sut is iterated, Then items arrive in source order (kills `await`-drop mutant)
Given a trackedRange(100) and a consumer that throws after 3 items, When the throw exits for-await, Then trackedRange.returnCalled() is true (§7.5 consumer-throw cascade)
Given an abortableRange(5, 100) and filter(() => true), When sut is iterated to completion, Then exactly [0,1,2,3,4] is yielded and no error is thrown (§7.5 source-self-abort tolerance)
```

### Implement (green)

Per design §5.2:

```typescript
import type { Awaitable } from './types.js';

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

### Verify

```bash
npm run check:types && npm run test:unit && npm run check:architecture
```

---

## Step 6: `take.ts` — transforming, validation-at-call-time

**Create:** `src/operators/take.ts`, `test/unit/operators/take.test.ts`

Depends on: Steps 1, 3.

### Test first (red)

**CRITICAL-severity coverage per design §7.3. All invalid-input tests use `.message` regex.**

```
Given take(0) on pullCounter().source, When sut is iterated to completion, Then pullCount() === 0 (source's next() never called)
Given a source of length 5 and take(3), When sut is iterated, Then exactly [0,1,2] is yielded
Given a source of length 2 and take(5), When sut is iterated, Then all 2 items are yielded; no error
Given take(1) on pullCounter().source, When sut is iterated to completion, Then pullCount() === 1 (kills `>=` ↔ `>` mutation)
Given take(N) on a source of exactly N items, When sut is iterated, Then pullCount() === N and no extra next() is called
Given take(3) and a trackedRange(100), When iteration cuts after 3, Then trackedRange.returnCalled() is true
Given take(-1), When sut is called (factory), Then RangeError whose .message matches /non-negative integer/
Given take(-2) (integer and negative — isolates count < 0 arm), When sut is called, Then RangeError /non-negative integer/
Given take(1.5), When sut is called, Then RangeError /non-negative integer/
Given take(NaN), When sut is called, Then RangeError /non-negative integer/
Given take(Infinity), When sut is called, Then RangeError /non-negative integer/
Given a trackedRange(100) and a consumer that throws inside for-await before take's cap is reached, When the throw exits the loop, Then trackedRange.returnCalled() is true (§7.5 consumer-throw cascade)
Given an abortableRange(3, 100) composed under take(10), When sut is iterated to completion, Then exactly [0,1,2] is yielded and no error is thrown (§7.5 source-self-abort tolerance; source closes itself at 3, below take's cap of 10)
Given a trackedPipeline4(1000) wired as stage3(stage2(stage1(stage0))) and take(3) applied to the outer stage, When iterated via a manual for-await + break-after-3 consumer, Then returnCalled() reports { s0: true, s1: true, s2: true, s3: true } — the flagship §7.5 multi-hop cascade assertion. NOTE: the consumer is manual for-await (not pipe / toArray), so only take is the operator-under-test; stages are test fixtures. This is where Step 1's trackedPipeline4 fixture is finally consumed.
Property test (fast-check): for any non-negative integer n and finite async iterable of length L, take(n)(source) yields exactly min(n, L) items equal to the first min(n, L) of source
```

All invalid-input tests use try/catch + `.message` regex — not `toThrow(RangeError)` alone.

### Implement (green)

Per design §5.5:

```typescript
export function take<T>(count: number) {
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError('take(count): count must be a non-negative integer');
  }
  return async function* (source: AsyncIterable<T>): AsyncIterable<T> {
    if (count === 0) return;
    let yielded = 0;                     // Deliberate local counter — O(1) vs spread-copy (see design §6.12 boundary discussion)
    for await (const value of source) {
      yield value;
      yielded += 1;
      // Stryker disable next-line all -- equivalent mutant: `>= count` ↔ `> count - 1` for integer count (design §7.6)
      if (yielded >= count) return;
    }
  };
}
```

### Refactor

Extract the error message into a module-local constant if Step 9's `groupBy` and Step 3's `toArray` land on a shared phrasing (`/non-negative/`). Defer to Step 9 consolidation if duplication crosses three sites.

### Verify

```bash
npm run check:types && npm run test:unit && npm run check:architecture
```

---

## Step 7: `find.ts` — terminal short-circuit

**Create:** `src/operators/find.ts`, `test/unit/operators/find.test.ts`

Depends on: Steps 1, 2.

### Test first (red)

```
Given a source [1,2,3] and predicate x => x === 2, When sut is awaited, Then 2 is returned
Given a predicate that never matches, When sut is awaited, Then undefined is returned
Given an empty source, When sut is awaited, Then undefined is returned
Given a source where match precedes throw (item 2 matches, item 5 throws), When sut is awaited, Then 2 is returned; predicate spy was called exactly 2 times (isolated guard test: match-before-throw)
Given a throwingPredicate that fires before any match, When sut is awaited, Then the error propagates; no value is returned (isolated guard test: throw-before-match)
Given a predicate wrapped via awaitable<boolean>(fn), When sut is awaited, Then the resolved boolean determines inclusion (pins Awaitable widening)
Given a match at index 2 of trackedRange(100), When sut is awaited, Then returnCalled() is true (for await cleanup fires)
Given a match at index 2 of pullCounter().source, When sut is awaited, Then pullCount() === 3 — exactly index-of-match + 1 source pulls (predicate-spy count is not the same signal; a buggy impl could invoke predicate from a lookahead without advancing source)
```

### Implement (green)

Per design §5.6. Plain `async` arrow (**not** `async function*`):

```typescript
import type { Awaitable } from './types.js';

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

### Verify

```bash
npm run check:types && npm run test:unit && npm run check:architecture
```

---

## Step 8: `flat-map.ts` — transforming, for-await delegation

**Create:** `src/operators/flat-map.ts`, `test/unit/operators/flat-map.test.ts`

Depends on: Steps 1, 2, 3. (No `pipe` / `take` dependency — inner-cleanup test uses a manual consumer loop to stay decoupled from other operators-under-test, matching the §7.5 decoupling principle.)

### Test first (red)

```
Given a mapper returning Iterable<U> (plain array), When sut is iterated, Then values are flattened in order
Given a mapper returning AsyncIterable<U> (via a generator), When sut is iterated, Then values are flattened in order
Given a mapper returning Promise<Iterable<U>>, When sut is iterated, Then the promise resolves before inner iteration begins
Given a mapper returning Promise<AsyncIterable<U>>, When sut is iterated, Then same
Given a mapper returning an empty iterable for a source item, When sut is iterated, Then that source item contributes 0 outputs and the next outer item is pulled normally
Given a two-item source [A, B], When sut yields, Then all of A's inner items appear before any of B's (sequential flatten; deterministic order)
Given a mapper returning Promise<[x]> whose resolution ticks a counter, When sut yields one outer item, Then the counter is 1 at yield completion (kills `await`-drop mutant)
Given a mapper whose inner iterable throws mid-yield, When the outer pipeline reaches that inner, Then the outer generator throws AND outer source returnCalled() is true
Given an outer throwingAt(2, 10) source and a mapper returning [value], When the outer throws on item 2, Then the flatMap generator throws (outer-source-throws — symmetric to the inner-throws case above)
Given a one-item outer source and flatMap(() => innerTrackedRange(100)), When a manual for-await consumer breaks after the first inner yield, Then innerTrackedRange.returnCalled() is true (inner cleanup fires on consumer cut; verified without pipe/take in the wiring). Sketch: `for await (const v of sut) { seen.push(v); if (seen.length >= 1) break; }`
Given a trackedRange(100) outer source and a consumer that throws on first yield, When the throw exits for-await, Then trackedRange.returnCalled() is true (§7.5 consumer-throw cascade)
Given an abortableRange(3, 100) outer source and a mapper returning [value], When sut is iterated to completion, Then exactly 3 inner items are yielded and no error is thrown (§7.5 source-self-abort tolerance)
```

### Implement (green)

Per design §5.4 — `for await` delegation, NOT `yield*`:

```typescript
type FlatMapReturn<U> =
  | Iterable<U>
  | AsyncIterable<U>
  | Promise<Iterable<U> | AsyncIterable<U>>;

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

`FlatMapReturn<U>` stays inline (single-site — below the extraction threshold).

### Verify

```bash
npm run check:types && npm run test:unit && npm run check:architecture
```

---

## Step 9: `group-by.ts` — terminal, buffered, limit-guarded

**Create:** `src/operators/group-by.ts`, `test/unit/operators/group-by.test.ts`

Depends on: Steps 1, 2, 3.

### Test first (red)

```
Given an empty source, When sut is awaited, Then an empty Map is returned
Given a source [1] keyed by identity (first-of-key only), When sut is awaited, Then result has one entry { 1 → [1] } — isolated else-arm test (bucket is undefined, result.set path only)
Given a source [1, 1] keyed by identity (repeated key after first), When sut is awaited, Then result has one entry { 1 → [1, 1] } — isolated if-arm test (bucket exists on second iteration, bucket.push path only)
Given a source [1,2,3] keyed by identity, When sut is awaited, Then three entries of size 1 each (three times the else-arm, no if-arm)
Given a source [a,b,a,b,a] keyed by identity, When sut is awaited, Then result has two entries in first-occurrence key order: a → [a,a,a], b → [b,b] (exercises both arms in interleave; pins insertion-order contract)
Given a source [x, y] keyed to someConst, When sut is awaited, Then [...result.keys()] equals [someConst] (insertion-order preservation)
Given a source [NaN, NaN] keyed by identity, When sut is awaited, Then result.get(NaN)!.length === 2 (SameValueZero equality)
Given a source of two items keyed to two distinct fresh {} literals, When sut is awaited, Then two entries of size 1 each (reference equality)
Given a source of two items keyed to the same frozen object, When sut is awaited, Then one entry of size 2
Given a throwingPredicate as keyFn that throws on item k, When sut is awaited, Then the promise rejects AND source returnCalled() is true. Partial-Map unreachability: the rejected promise carries only the error; the intermediate Map reference never escapes the async closure (verify by examining the implementation surface — no `.catch` handler in user code can recover it).
Given a source of 5 items and limit = 3, When sut is awaited, Then rejection with RangeError whose .message matches /exceeded limit of 3/
Given groupBy(k, -1), When sut is called (factory invocation), Then RangeError synchronously at construction time
Given groupBy(k, NaN), When sut is called, Then RangeError
Property test: Array.from(result.values()).flat() is a permutation of toArray(source) for any source and keyFn
```

### Implement (green)

Per design §5.8:

```typescript
import type { Awaitable } from './types.js';

export function groupBy<T, K>(
  keyFn: (value: T) => Awaitable<K>,
  limit: number = Number.POSITIVE_INFINITY,
) {
  if (Number.isNaN(limit) || limit < 0) {
    throw new RangeError('groupBy(limit): must be a non-negative number or Infinity');
  }
  return async (source: AsyncIterable<T>): Promise<ReadonlyMap<K, ReadonlyArray<T>>> => {
    const result = new Map<K, T[]>();
    let count = 0;                     // Deliberate local counter — bounded accumulator (see design §6.12)
    for await (const value of source) {
      // Stryker disable next-line all -- equivalent mutant: `>= limit` ↔ `> limit - 1` for integer limit (design §7.6)
      if (count >= limit) {
        throw new RangeError(`groupBy: exceeded limit of ${limit} items`);
      }
      const key = await keyFn(value);
      const bucket = result.get(key);
      // Stryker disable next-line all -- equivalent mutant: `if (bucket)` ↔ `if (bucket !== undefined)` (Map.get returns T[] | undefined; T[] is always truthy — design §7.6)
      if (bucket) {
        bucket.push(value);            // Deliberate local mutation — see design §6.12
      } else {
        result.set(key, [value]);
      }
      count += 1;
    }
    return result as ReadonlyMap<K, ReadonlyArray<T>>;
  };
}
```

### Refactor

If `toArray` (Step 3) and `groupBy` (Step 9) share identical `/exceeded limit of N items/` phrasing, extract a module-local `exceededLimitError(label: string, limit: number)` helper — **only after Step 9 is green**. Do not preempt in earlier steps.

### Verify

```bash
npm run check:types && npm run test:unit && npm run check:architecture
```

---

## Step 10: `index.ts` — barrel

**Modify:** `src/operators/index.ts` (currently `export {};`)

Depends on: Steps 0, 3, 4, 5, 6, 7, 8, 9 (every operator must be green).

### Actions

Replace `export {};` with (alphabetical — matches biome `organizeImports: "on"` to avoid first-run diff churn):

```typescript
export { filter } from './filter.js';
export { find } from './find.js';
export { flatMap } from './flat-map.js';
export { groupBy } from './group-by.js';
export { map } from './map.js';
export { pipe } from './pipe.js';
export { take } from './take.js';
export { toArray } from './to-array.js';
export type { Awaitable } from './types.js';
```

Consumer imports from `tsgit/operators` and tree-shakes unused exports (PRD §5.3).

### Test

Barrel re-export test in `test/unit/operators/index.test.ts`:

```
Given the barrel module, When imported, Then all 8 operators + Awaitable type are available
Given a consumer importing only { pipe }, When tree-shaken, Then dist size stays at the measured baseline (documented; asserted by size-limit at Step 12)
```

### Verify

```bash
npm run check:types && npm run test:unit && npm run check:dead-code && npm run build && npm run check:size
```

`check:dead-code` (knip) verifies every export is referenced or declared public. `check:size` requires an explicit `npm run build` in front because `size-limit` measures the built artifact in `dist/` — the wireit build dep would also satisfy it, but spelling it out keeps the verify chain explicit and debuggable.

---

## Step 11: `laws.test.ts` — composition-law property tests

**Create:** `test/unit/operators/laws.test.ts`

Depends on: Steps 0 + 3–9 green (every operator's behavior). Step 10 (barrel) is a convenience — laws imports operators through the barrel as a consumer would, but the real semantic requirement is every operator being correct. Starting Step 11 against an incomplete barrel with stub re-exports would fail at first run.

### Laws to verify (per design §7.3 tail)

```
Law: take(n) ∘ take(m) ≡ take(min(n, m))
  — for any non-negative integers n, m and any finite source
Law: filter(p) ∘ filter(q) ≡ filter(x => q(x) && p(x))
  — for any pure predicates p, q
Law: map(g) ∘ map(f) ≡ map(x => g(f(x)))
  — for any pure functions f, g (functor fusion)
Law: filter(p) ∘ map(f) ≡ map(f) ∘ filter(x => p(f(x)))
  — filter/map commutation; requires pure p and f
Law: toArray ∘ flatMap(x => [x]) ≡ toArray
  — flatMap of singleton lift is identity
Law: toArray(source).length === N for finite source of length N
  — toArray preserves length (kills off-by-one on accumulator)
Law: toArray ∘ map(x => x) ≡ toArray
  — functor identity
Law: toArray ∘ filter(() => true) ≡ toArray
  — filter identity
Law: toArray ∘ filter(() => false) ≡ []
  — filter annihilation
Law: Array.from(groupBy(k)(source).values()).flat() is a permutation of toArray(source)
  — groupBy preserves all items, no duplicates
```

### Fast-check arbitraries

Keep stateless. `fc.array(fc.integer())` generates arrays per property run; convert via a module-local `toAsyncIterable(arr)` helper defined inside this file:

```typescript
async function* toAsyncIterable<T>(items: ReadonlyArray<T>): AsyncIterable<T> {
  for (const item of items) {
    yield item;
  }
}
```

No closure-over-mutation, no shared state across property runs. Every property creates a fresh async iterable per fast-check sample.

### Verify

```bash
npm run check:types && npm run test:unit
```

---

## Step 12: Mutation Testing & Branch Finalization

**Not a code step** — finalization workflow per CLAUDE.md §Post-Build Workflow.

> **Important:** Equivalent-mutant annotations are **added inline during each operator's green-phase** (Steps 3, 6, 9, 0), NOT retroactively during this step. CLAUDE.md requires the rationale at the mutated line. The annotations below are therefore a verification checklist (each should already be present in the implementation); only novel survivors from the Stryker run get new annotations here.

1. Run `npx stryker run`. Fix every surviving mutant. Accept only provably equivalent ones. Use Stryker's canonical directive `// Stryker disable next-line all` with a trailing `// -- <rationale>`:
   - `src/operators/take.ts` line `if (yielded >= count) return;` — `>= count` ↔ `> count - 1` equivalent for integer `count`. Annotation: `// Stryker disable next-line all -- equivalent mutant: integer boundary (design §7.6)`.
   - `src/operators/group-by.ts` line `if (bucket)` — `if (bucket)` ↔ `if (bucket !== undefined)` equivalent since `Map.get` returns `T[] | undefined` and non-undefined `T[]` is always truthy. Annotation as above.
   - `src/operators/pipe.ts` line `return fns.reduce(…)` — `reduce` vs manual `for-of` loop variants equivalent. Annotation as above.
   - `src/operators/to-array.ts` line `if (result.length >= limit)` — `>= limit` ↔ `> limit - 1` equivalent for integer `limit`. Annotation as above.

   Verify Stryker's directive parsing matches: `stryker.config.json`'s `mutator.excludedMutations` is empty, so inline comments are the only channel. Syntax: `// Stryker disable next-line <mutator-or-all>` (reference: stryker-js/stryker/#3270). If the syntax diverges from the expected form in this project's Stryker version, adjust here and in every source file.
2. Run 4× parallel reviews per CLAUDE.md post-build workflow:
   - `feature-dev:code-reviewer` or `code-reviewer` — code correctness, clean code.
   - `security-reviewer` — public-API attack surface (DoS via unbounded sources, callback-side-effects, error-message leaks).
   - `profiling-driven-optimization` skill — microtask overhead, bundle size headroom, `for await` vs `yield*` delta on realistic workloads.
   - `test-review` skill — coverage / mutation / GWT compliance against §7.
   Address all CRITICAL and HIGH findings before merge.
3. Update docs:
   - `docs/BACKLOG.md` — mark 6.1–6.8 as `[x]`; update the "Progress" line to note Phase 6 done.
   - `README.md` — if the README has an operators entry or a feature matrix, update it.
   - `DESIGN.md` / `CONTRIBUTING.md` — capture any pattern emerging from implementation (e.g. if the shared-limit-error helper landed, note the extraction threshold).
   - `docs/design/operators.md` — add post-implementation notes at the top if any design decision changed during TDD (same pattern as `docs/design/domain-object-model.md`).
4. Final `npm run validate` — full quality gate green.
5. Commit final docs update on the implementation branch.
6. Squash-and-merge to main: single commit with subject `feat(operators): add phase 6 — operators`, matching Phase 5 convention.
7. Cleanup: if using a worktree, `git worktree remove .claude/worktrees/phase-6-operators && git branch -D <branch>`; otherwise `git branch -D feat/phase-6-operators`.

---

## Dependency Graph

```
Step 0  (pipe.ts)        ─── independent
Step 1  (fixtures.ts)    ─── test-only, independent
Step 2  (types.ts)       ─── type-only, independent

         │  │  │
         ▼  ▼  ▼
Step 3  (to-array.ts)    ─── needs Step 1 for throw test

         │
         ▼
Step 4  (map.ts)    ──┐
Step 5  (filter.ts) ──┼── parallelizable after Steps 1+2+3
Step 6  (take.ts)   ──┤
Step 7  (find.ts)   ──┤
Step 8  (flat-map.ts)─┤
Step 9  (group-by.ts)─┘

         │
         ▼
Step 10 (index.ts barrel)  ─── depends on 0 + 3..9
         │
         ▼
Step 11 (laws.test.ts)     ─── depends on Step 10
         │
         ▼
Step 12 (finalize)         ─── mutations + 4× reviews + docs + merge
```

**Parallelizable groups:**

- Steps 0 + 1 + 2 are fully independent and can be done in parallel in three separate commits.
- After Step 3, Steps 4–9 are fully independent; any ordering works. Doing them in the listed order (map → filter → take → find → flatMap → groupBy) follows design §10's "simplest first" rationale.
- Step 10 (barrel) can be started partially after any operator is green (re-export one line at a time), but the barrel's full test lands only after Step 9.
- Step 11 cannot start before Step 10.

---

## Post-Plan — next branch

Once this plan file is reviewed and merged, open a fresh branch for Step 0 of implementation:

```bash
git checkout main          # add `git pull` here if/when a remote is configured — today this repo is local-only
git checkout -b feat/phase-6-operators
# or, using a worktree for parallel work:
git worktree add .claude/worktrees/phase-6-operators -b feat/phase-6-operators
```

Execute Steps 0 → 12 on that branch. Do not commit code changes to the current `plan/phase-6-operators` branch.
