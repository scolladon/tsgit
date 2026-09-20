# Property-based testing (when to reach for `fast-check`)

Read this when the work touches a parser, decoder, matcher or serializer.
Referenced from [`CLAUDE.md`](../../CLAUDE.md) §Test Conventions; decisions pinned in
[ADR-134](../../docs/adr/134-property-tests-as-sibling-files.md),
[ADR-135](../../docs/adr/135-tiered-numruns-budget.md),
[ADR-136](../../docs/adr/136-properties-additive-not-replacing-examples.md).

Example tests prove specific inputs round-trip; property tests prove the *grammar* round-trips. They are not interchangeable — example tests document literal Git on-disk encodings, property tests catch grammar-level bugs the examples can't enumerate.

**When property tests are appropriate** — touch the new/changed code with all four lenses; if any one fits, ship a `*.properties.test.ts` sibling alongside the example test:

1. **Round-trip pair** — code under test is half of a `parse`/`serialize` (or `compile`/`render`, `encode`/`decode`) pair. Property: `parse(serialize(x)) ≡ x` (modulo documented canonicalisation, e.g. sort order).
2. **Compositional matcher / aggregator** — function reduces an array of rules/entries/levels to a verdict (e.g. `matchesPathspec`, `matchInStack`, `matches`). Property: invariant shapes — empty input returns the identity, appending a non-negated match makes the verdict true, appending its negation flips it back.
3. **Total function over an algebraic grammar** — compiler / validator that should *never* throw on any input within a declared safe subset (e.g. `compilePathspec` over ASCII no-NUL). Property: `compile(any p in safeSubset)` returns a callable matcher.
4. **Idempotence / counting invariant** — parser whose output should re-parse to the same structure (e.g. `parseGitignore(rulesToText(parseGitignore(x))) ≡ parseGitignore(x)`), or where a syntactic input feature should map 1:1 to a semantic output feature (`!`-prefixed lines ↔ negated rules count).

**When property tests are NOT appropriate (skip them, no virtue points):**

- Single-purpose UI / orchestration code with no algebraic structure.
- Functions whose only inputs are a small enum (3–10 values) — a parameterised example sweep does the same job clearer.
- I/O wrappers, transport middleware, command facades — these belong in integration / parity tests, not property tests.
- A property that requires re-implementing the production loop as the oracle. If the oracle is a verbatim copy of the SUT, you have a tautology, not a property. Rewrite as invariants (case 2 above) or delegate to an *independently tested* sibling function.

**Layout and budget** (per ADRs 134–136):

- Property tests live in `<parser>.properties.test.ts` next to the example file, never mixed in. Per-family generators live in a shared `arbitraries.ts` in the same directory.
- Tiered `numRuns`: **200** for cheap round-trip properties, **100** (default) for composition / invariant properties, **50** for filter-heavy negative properties.
- Properties are *additive*: never delete an example test in the same PR that adds a property — the example documents the literal Git format, the property proves the grammar.
- Same describe/it / AAA / `sut` conventions as example tests. `Given` reads "Given an arbitrary X".
- Never commit a seed. Failing properties shrink to a counterexample; the seed is printed locally for repro, not pinned.

If the work touches a parser/decoder/matcher and the diff lands without a `*.properties.test.ts` sibling, surface the gap in the review pass and either add the property or note why the four lenses above don't fit.
