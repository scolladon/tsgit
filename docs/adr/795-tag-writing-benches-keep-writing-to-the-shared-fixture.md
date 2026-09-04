---
subjects:
  - test/bench/describe.bench.ts
  - test/bench/name-rev.bench.ts
---
# 795 — Tag-writing benches keep writing to the shared fixture

- **Status:** accepted
- **Date:** 2026-09-04
- **Design:** docs/design/fix-main-ci-bench-fixture-deps.md (D5) · **Supersedes/Refines:** none

## Context

`describe.bench.ts` writes one annotated tag with `git tag -f` and `name-rev.bench.ts` writes
one dangling commit with pinned dates plus one tag, both directly into the shared cached
fixture. Neither moves `HEAD` or `refs/heads/main`; both are idempotent, so repeated runs add
nothing. ADR-793's identity probe tolerates them by construction. Moving both onto disposable
copies would cost another ≈21 s per run, dominated by the `medium` tier.

## Options considered

1. **Leave as-is** (designer's recommendation) — pros: no cost; the writes have never broken
   anything and the fixtures absorb them / cons: the "never write a shared fixture" rule keeps
   two carve-outs.
2. **Move both onto scratch copies** — pros: a uniform rule / cons: ≈21 s per run to close a
   class of write that is additive and idempotent.
3. **Leave as-is and add a mechanical no-write check on `fixture.cwd`** — cons: needs a
   taxonomy of writing APIs the repository does not have.

## Decision

**Adopted-as-recommended (no user judgment): option 1.** A bench may add refs or objects to a
shared fixture only when the write is idempotent and leaves `HEAD` and `refs/heads/main`
untouched; anything that moves either, rewrites the index or rewrites the working tree runs on
a copy from `fixture-scratch.ts`.

## Consequences

- `describe.bench.ts` and `name-rev.bench.ts` are untouched; their measured `sut` and
  constants are unchanged.
- The rule is stated in the fixture's `cwd` docstring so the next writer meets it in the type.
