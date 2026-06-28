# 429 — bisect midpoint is a pure Tier-2 primitive returning structured halving data

- **Status:** accepted
- **Date:** 2026-06-28
- **Design:** docs/design/bisect-midpoint-primitive.md · **Relates:** ADR-249 (structured data only), ADR-226 (git-faithfulness)
- **Decision class:** D-API (user judgment)

## Context

`bisect` exposes only the **pure midpoint primitive**: given the good/bad commits, return
the next commit to test and the halving counts. The verdict and the stateful porcelain
(`start`/`good`/`bad`/`skip`/`reset`/`run`, the `BISECT_*` files, `refs/bisect/*`) stay the
consumer's — driving the loop is orchestration, not a data-library surface.

That leaves three load-bearing shape questions the library author owns:

1. **Public surface.** The brief says "given the good/bad reachable-commit sets". Computing
   "reachable from bad but not from any good" is real graph work tsgit already owns
   (`merge-base` flag-painting over the date-priority queue). So: does the public entry
   point take the already-built set, or take the good/bad oids and build the set itself?
2. **Output fields.** git's own counts diverge. The porcelain line reports
   `N = all − reaches − 1` ("revisions left to test after this"); `git rev-list
   --bisect-vars` reports `nr = max(reaches, all − reaches) − 1`. A single
   `remainingRevisions` field cannot reconstruct both surfaces.
3. **Terminal case.** When good and bad have no commit strictly between them, the bisection
   is already resolved — there is no midpoint to return.

## Options considered

**Public surface**
1. *Primitive builds the set* — public `repo.primitives.bisectMidpoint(good[], bad, ctx)`
   does the reachability I/O; a pure `findBisection` domain function stays internal *(user
   choice)*. One ergonomic surface; mirrors `mergeBase` / `walkSubmodules`.
2. *Also export the pure domain fn* — expose both the primitive and `findBisection(set)`.
   Two surfaces to document and pin.
3. *Pure domain fn only* — ship `findBisection(set)`; the consumer builds the reachable
   set. Forces every consumer to re-implement git-faithful reachability — tsgit's value-add.

**Output fields**
1. *Two half-counts + candidateCount* — return `remainingIfGood`, `remainingIfBad`,
   `candidateCount`, `remainingSteps` *(user choice)*. The caller reconstructs **both** the
   porcelain `N` and the `--bisect-vars nr` with no ambiguity.
2. *Single `remainingRevisions`* — matches the brief's literal wording but loses the
   `--bisect-vars nr` surface.
3. *Raw `reaches` + `candidateCount`* — maximally raw; pushes git's formulae onto every
   consumer.

**Terminal case**
1. *Return `undefined`* — idiomatic; no sentinel oid; the caller checks presence *(user
   choice)*.
2. *Discriminated union* (`{ kind: 'midpoint' } | { kind: 'none' }`) — explicit, more
   ceremony for a binary present/absent.
3. *Throw a typed error* — "already resolved" is a normal terminal state, not exceptional.

## Decision

**All three ratified by the user as recommended.**

- **Surface — option 1.** Public `repo.primitives.bisectMidpoint(good, bad, ctx)` builds the
  candidate set via the existing reachability machinery and returns structured data; the
  pure `findBisection` domain function is internal. The primitive is a read-only query (no
  state mutation): Tier-2, not porcelain.
- **Output — option 1.** Return `{ nextCommit, candidateCount, remainingIfGood,
  remainingIfBad, remainingSteps }`. No rendered string crosses the boundary (ADR-249); the
  interop test reconstructs git's `Bisecting: N revisions left … (roughly M steps)` line
  from these fields and compares to real `git`.
- **Terminal — option 1.** Return `undefined` when the candidate set is empty.

Naming (adopted as the design recommends, no user judgment): domain `findBisection`,
primitive `bisectMidpoint`, module `src/domain/bisect/`, types `BisectMidpoint` / `Bisection`
— tracking git's own `find_bisection`.

## Consequences

### Positive

- One ergonomic public surface; the consumer passes oids and never re-implements
  reachability. Both git count surfaces are reconstructable from the returned fields.
- The structured-output invariant (ADR-249) holds: counts and oids cross the boundary, never
  a formatted line.
- `undefined` keeps the resolved-bisection terminal out of the exception path.

### Negative

- Two count fields plus `candidateCount` is a wider result than the brief's literal single
  `remainingRevisions`; the caller does the final subtraction to print git's exact line.

### Neutral

- The pure `findBisection` staying internal means a consumer who already holds a candidate
  set still calls through `bisectMidpoint`; promoting it to public later is additive and
  non-breaking.
