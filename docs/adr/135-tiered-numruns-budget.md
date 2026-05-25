# ADR-135: Tiered `numRuns` budget for property tests

## Status

Accepted (at `288caf5`)

## Context

fast-check's `fc.assert` defaults to `numRuns: 100`. Phase 19.6 adds ~24 new properties across the parser families. A uniform `numRuns: 100` would put ~3.6 s on the unit-test wall time, which is fine — but the *value* of each run differs by property class:

- **Round-trip** properties (`parse(serialize(x)) ≡ x`) shrink cheaply because the generator produces only valid inputs. Doubling runs to 200 doubles coverage with no shrinking penalty.
- **Negative** properties (`parse(invalidBytes) throws`) often filter-heavy on the generator. Each generated input may take 5–10× longer than a valid one. 100 runs is overkill; 50 is plenty.
- **Composition** properties (matchers, stacks) sit between — they exercise interaction shape, not edge cases. The default 100 is right.

A single global `numRuns` masks this asymmetry and either burns CI minutes on cheap properties or under-tests the load-bearing ones.

## Decision

Adopt a three-tier budget keyed to property class:

| Class | `numRuns` |
|---|---|
| Round-trip (cheap) | 200 |
| Composition (medium) | 100 (default) |
| Negative / filter-heavy | 50 |

The class is declared inline by the test file's call to `fc.assert(fc.property(…), { numRuns })`. There is no central registry — readers see the budget next to the property body.

## Consequences

### Positive

- Round-trip parsers (the highest-leverage property class) get 2× the input coverage.
- Filter-heavy generators don't drag the unit-test budget.
- Each property's run budget is local and reviewable in diff.

### Negative

- Three numbers to remember instead of one. We mitigate by making the choice obvious from the property's shape (round-trip vs negative vs composition).
- A future generator may shift class without the `numRuns` being updated. The 19.3 lint does not check this — review catches it.

### Neutral

- Total budget: ~24 × ~150 ms median = ~3.6 s, identical to a uniform 100-run baseline since the tier savings on negative properties offset the round-trip increases.
- No CI configuration change. fast-check honours per-`assert` options.
