# ADR-464: `name-rev` perf pinned by dedicated bench + read-count assertions

## Status

Accepted (2026-07-09)

## Context

The backlog requires a `bench:summary` delta demonstrating the cutoff's win.
The repo precedent (`describe` early termination, ADR-460) is one bench file
per command on the scaled fixture family, complemented by deterministic
read-count unit tests, because wall-clock benches are noisy
(`benchmark-compare` measures runner noise).

## Decision

A new `test/bench/name-rev.bench.ts` mirrors `describe.bench.ts`: the scaled
fixture (`resolveScaledContext` / `scaledScenario`), an annotated tag placed
near the deep-fixture tip, benchmarking `repo.nameRev()` for a commit near
the tip; it skips cleanly in the Stryker sandbox and without a `git` CLI.
Alongside it, unit tests with a counting spy over the object reader assert
the walk reads O(distance) commits — not the whole chain — pinning the
pruning claim deterministically.

## Consequences

- The perf win is recorded twice: a human-visible `bench:summary` delta and
  a mutation-hard read-count assertion immune to runner noise.
- One bench file per command keeps the bench suite's Given/When structure
  clean.

## Alternatives considered

- **Fold a scenario into an existing bench file** — muddies that file's
  Given/When; against the one-file-per-command precedent.
- **Micro-bench the pure predicate** — measures nothing observable; the win
  is fewer object reads across the whole walk, not predicate speed.
