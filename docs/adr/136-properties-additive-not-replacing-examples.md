# ADR-136: Property tests are additive — they don't replace example tests

## Status

Accepted (at `288caf5`)

## Context

Phase 19.6 introduces property-based testing across parser families. Two scopes were considered:

1. **Replace** example tests with properties where a property strictly covers the example.
2. **Add** properties on top of existing examples, leaving the example suite untouched.

Option 1 was attractive on file-count grounds — some parser test files have dozens of "Given input X, Then output Y" specs that a single round-trip property arguably subsumes. But it conflates two different kinds of evidence:

- An **example test** is a literal Git-format string. It documents how a real `.git` file's bytes flow through the parser. The test is also a regression *spec* — if a future contributor "improves" parser output, the example test's intent is explicit.
- A **property test** asserts an invariant over a generated input space. It catches grammar-level bugs that examples can't enumerate, but it does **not** document specific Git on-disk encodings.

The two roles don't substitute. Deleting examples in favour of properties would shrink the literal-bytes documentation and increase the bus factor on Git format details.

This mirrors the policy ADR-129 set for parity scenarios: additive, no deletion.

## Decision

Phase 19.6 only **adds** `*.properties.test.ts` files and arbitraries. No existing `*.test.ts` file is modified except to *extract* arbitraries that were already defined inline (and only when the extraction is byte-for-byte identical).

Future phases may choose to delete an example test, but the decision must be deliberate and ADR-recorded; it cannot piggyback on a properties PR.

## Consequences

### Positive

- The literal-bytes spec corpus stays intact — Git-format documentation is preserved.
- Reviewers can read a 19.6 PR as a strict superset; nothing in the existing suite changes semantically.
- Mutation budgets remain stable (19.1) — properties add killed mutants, never subtract.

### Negative

- Total test count grows. The 19.2 pyramid audit (warn-only) will tilt slightly more toward the unit bucket, which is the desired direction anyway.
- Some duplication of intent — a property and an example may both kill the same mutant. We accept this; double coverage of load-bearing parsers is welcome.

### Neutral

- Future deletion of obsolete examples remains an option, gated by its own ADR.
- The 19.4 integration usefulness audit is unchanged — properties don't touch the integration bucket.
