# 474 — bench fixture-generator topology: new 'delta-chain' label + strategy discriminant

- **Status:** accepted
- **Date:** 2026-07-10
- **Design:** docs/design/memory-pressure-bench-scenarios.md · **Relates:** ADR-471

## Context

The deep-delta fixture (ADR-471) is a **different generation strategy** — one evolving
file re-content per commit — from the existing multi-blob `streamFastImport` (four fresh
random blobs per commit). `FixtureSpec`'s `blobs` field (total distinct blobs) is
meaningless for a single evolving path, and `resolveScaledContext`'s `given` phrase
interpolates `${spec.commits} commits, ${spec.blobs} blobs`, which would read wrong for
the delta-chain shape. The new fixture is also **label-specific** — it does not ride the
medium↔large `TSGIT_BENCH_LARGE` toggle — yet wants the same skip/Stryker/unavailable
handling the scaled scenarios already have.

## Options considered

1. **New label + strategy discriminant, same generator** — add a `'delta-chain'` label
   and `DELTA_CHAIN_FIXTURE` spec, a separate `streamEvolvingFastImport` builder
   alongside `streamFastImport`, sharing the cache/rename/meta/race machinery; give
   `FixtureSpec` a `strategy` discriminant plus `deltaDepth`/`deltaWindow` so
   `generateInto` selects the builder + repack knobs off the spec, not the label; **no**
   `FIXTURE_GENERATOR_VERSION` bump (pure addition). *(design recommendation)*
2. **Same, plus a defensive version bump to 2** — bump the cache version even though the
   `medium`/`large` shapes are untouched.
3. **Separate generator module** — a standalone file duplicating the cache/rename/race
   logic.

## Decision

Adopt option 1 (adopted as recommended — no user judgment). A new label is a pure
addition: the `medium`/`large` cache shapes are untouched, so their caches stay valid and
only a new `delta-chain-v1` cache dir is created — **no `FIXTURE_GENERATOR_VERSION`
bump** (editing the generator file already re-keys CI's `actions/cache`, and the shared
`streamFastImport` must not change). The `strategy` discriminant keeps the repack args
and stream-builder choice on the spec and fixes the `blobs`/`given`-phrase mismatch.

Two mechanics adopted with it:

- **Resolver generalisation (candidate #6):** generalise `resolveScaledContext(spec?)` /
  `scaledScenario` to accept an explicit `FixtureSpec`, defaulting to the env-driven
  medium/large spec so all five existing zero-arg call sites stay compatible. The
  delta-chain scenario reuses the same skip/Stryker/unavailable logic instead of
  duplicating or inlining it.
- **Comparative baseline (candidate #5):** the deep-delta scenario keeps an
  isomorphic-git baseline (the fixture is tiny, iso-git runs fine, and a comparative
  delta-chain-reader number is the point); the large-pack spread stays tsgit-only
  (ADR-472).

## Consequences

- One generator file grows a second strategy; no cache invalidation for existing
  fixtures; no separate module to keep in sync.
- `FixtureSpec` gains `strategy` + `deltaDepth`/`deltaWindow`; `blobs` is repurposed/led
  by the discriminant rather than overloaded.
- `resolveScaledContext`/`scaledScenario` take an optional explicit spec; the default
  keeps the existing scaled call sites byte-for-byte unchanged.
