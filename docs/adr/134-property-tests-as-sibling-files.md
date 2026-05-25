# ADR-134: Property tests live in sibling `.properties.test.ts` files

## Status

Accepted (at `288caf5`)

## Context

Phase 19.6 adds property-based tests for six parser families. Two file layouts were on the table:

1. **Append properties to the existing example file** — one `header.test.ts` containing both example and property assertions.
2. **Sibling `*.properties.test.ts` file** — `header.test.ts` (examples) next to `header.properties.test.ts` (properties).

Mixing both forms in one file would have shrunk the file tree, but property tests carry distinct ergonomic requirements that don't compose well with example tests:

- They emit shrunk counterexamples, not literal inputs, so failure triage is different.
- Their wall-time profile is dominated by `fc.assert` cycles (~150 ms median), unlike examples (~5 ms).
- Their `Given` clause reads "Given an arbitrary X", which sits awkwardly next to literal `Given 'blob 12'` examples.

Phase 19.3's expressiveness lint scans `*.test.ts`; both forms match. Phase 19.2's pyramid audit reads directory classification, not filename — both forms count as unit tests.

## Decision

Property tests live in a sibling file named `<parser>.properties.test.ts`, next to the existing `<parser>.test.ts`. They share arbitraries through a co-located `arbitraries.ts` per domain family.

We do **not** mix property and example assertions in one file. We do **not** create a separate test bucket — properties remain unit tests.

## Consequences

### Positive

- Failure attribution is unambiguous — a CI line "FAIL header.properties.test.ts" tells the reader which kind of test broke.
- Per-file `numRuns` tuning becomes possible without touching example tests.
- The `Given an arbitrary X` GWT phrasing stays consistent inside each properties file.
- Arbitraries co-locate with their consumers (`arbitraries.ts` in the same directory), keeping the import graph shallow.

### Negative

- Doubles the file count for parsers that get both — twelve new files in this phase.
- Two-file split obscures the link unless contributors learn the convention. We document it in `docs/get-started/contributing.md` (refresh in step 8).

### Neutral

- The 19.3 lint and 19.2 audit are unchanged.
- Migration cost: zero — no existing test is moved.
