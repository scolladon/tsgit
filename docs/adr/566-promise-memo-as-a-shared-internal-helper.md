# 566 — Promise-memo as a shared internal helper

- **Status:** accepted
- **Date:** 2026-08-01
- **Design:** docs/design/pack-registry-single-flight.md · **Supersedes/Refines:** none

## Context

Both of the pack registry's lazy initializers (`loadAll`, `offsetTable`) must become
single-flight promise-memos, and the clear-on-reject path needs an identity guard whose
subtlety (a rejected predecessor must not clobber a successor memo installed after an
intervening `refresh()`) is easy to get wrong twice in one file. The invariant being
established — memoise the promise, not the result — wants one named implementation.

## Options considered

1. **Shared internal helper** `src/application/primitives/internal/promise-memo.ts`
   exposing `createPromiseMemo<T>(factory)` → `{ get, peek, clear }`; both sites consume
   it (designer's recommendation). Pros: the identity-guard subtlety is implemented and
   mutation-tested once; `internal/` already holds exactly this kind of ~30-line building
   block (`bounded-map`, `bounded-reader`, `concurrency-limiter`); ADR-567's rule has a
   named home / cons: one new module.
2. **Two inline promise-memos** in `pack-registry.ts` — cons: duplicates the identity
   guard twice; the `offsetTable` copy of the guard is provably-never-false there, an
   unkillable equivalent mutant.
3. **A `LazyResource<T>` class** owning memo + disposal — cons: over-fits (only one site
   owns a disposable) and contradicts the file's FP-first closure style.

## Decision

Adopted-as-recommended (no user judgment): **option 1**.

## Consequences

`peek`/`clear` give `refresh()`/`dispose()` their two verbs without reaching into memo
internals. The helper lands in `primitives/internal/`, unexported from any barrel, so
`reports/api.json` does not move. Its own unit file kills the identity-guard mutants once,
for every consumer.
