# Phase 19.6 — Property-Based Tests for Parsers

> Status: draft
> Branch: `feat/19-6-property-based-parsers`
> BACKLOG: 19.6 — "Property-based tests for parsers (objects, refs, index, packfile, pathspec, gitignore)."

## Goal

Close the property-test gap on the six parser families called out in the backlog. Today many parsers have rich example-based coverage but zero `fast-check` exercise; example tests prove that *specific* inputs round-trip, not that the parser handles the *grammar*. Property tests fix that asymmetry.

We are **not** rewriting existing example tests, **not** raising mutation budgets, and **not** introducing a new test bucket. We add `*.properties.test.ts` siblings next to each parser whose grammar is wide enough to benefit, and we share arbitraries through the existing `arbitraries.ts` files. The aim is to add *evidence*, not surface.

## Non-goals

- Re-deriving correctness from scratch — example tests stay where they prove specific Git-format strings round-trip.
- Property tests on commands or primitives — the audit (19.4) covers integration; properties belong at the domain level.
- Property tests on transport / HTTP / OPFS — wire-format parsers only.
- Mutation-driven test design — properties supplement, they don't replace targeted mutation-killing tests.
- Performance fuzzing or differential testing against canonical git (deferred to 19.7 interop).

## Audit: current state

Property usage today, by parser family (count of `fc.` references in the parser's test file; "0" means zero `fast-check` exercise even when example coverage is heavy):

| Family | Parser file | Example test | `fc.` calls | Round-trip property? |
|---|---|---|---|---|
| **objects** | `header.ts` | `header.test.ts` (14 it) | 0 | no |
| | `tree.ts` | `tree.test.ts` | 0 (no it!) | no |
| | `file-mode.ts` | `file-mode.test.ts` (14 it) | 0 | no |
| | `blob.ts` | `blob.test.ts` (6 it) | 2 | partial |
| | `commit.ts` | `commit.test.ts` (30 it) | 11 | yes |
| | `tag.ts` | `tag.test.ts` (30 it) | 12 | yes |
| | `encoding.ts` | `encoding.test.ts` (38 it) | 11 | yes (low-level) |
| | `object-id.ts` | `object-id.test.ts` (23 it) | 4 | yes |
| | `author-identity.ts` | `author-identity.test.ts` (43 it) | 7 | yes |
| **refs** | `packed-refs.ts` | `packed-refs.test.ts` (31 it) | 3 | shallow |
| | `loose-ref.ts` | `loose-ref.test.ts` (17 it) | 4 | yes |
| | `ref-validation.ts` | `ref-validation.test.ts` (34 it) | 5 | yes (validator) |
| **index** | `index-parser.ts` | `index-parser.test.ts` (52 it) | **0** | **no** |
| | `index-writer.ts` | `index-writer.test.ts` (22 it) | 4 | partial |
| | `index-entry.ts` | `index-entry.test.ts` (21 it) | 4 | yes |
| | `path-validator.ts` | `path-validator.test.ts` | 0 | no |
| **packfile** | `pack-entry.ts` | (42 it) | 8 | yes |
| | `pack-index.ts` | (39 it) | 10 | yes |
| | `pack-writer.ts` | (26 it) | 15 | yes |
| | `delta.ts` | (44 it) | 12 | yes |
| **pathspec** | `compile-glob.ts` | (21 it) | 8 | yes (matcher behaviour) |
| | `compile-pathspec.ts` | (10 it) | 0 | no |
| | `match-pathspec.ts` | (8 it) | 0 | no |
| **gitignore** | `parse-gitignore.ts` | (31 it) | 0 | no |
| | `matcher-stack.ts` | (10 it) | 0 | no |
| | `match.ts` | (9 it) | 0 | no |

### What this means

The headline gap is **index parsing**: 52 example tests, zero property exercise. The serializer has a partial round-trip in `index-writer.test.ts`, but it never crosses entry counts > a handful or random stat-cache permutations. Index v3 (extended flags) and binary path encoding are the most fragile surfaces and the least exercised.

The next gap is **gitignore + pathspec**. The grammar is rich (negation, anchoring, dir-only suffix, `**` segments) and the matchers compose into stacks. Pure example tests can't cover the cross-product of pattern × candidate-path.

The smaller gaps — `header`, `tree`, `file-mode` — are fast wins: pure round-trip invariants on small algebraic types.

Packfile and object/encoding/commit/tag are already well-covered. We leave them alone.

## Properties to add

Every property name uses the canonical mathematical form `∀ x. P(x)`. Each property maps to a single `it()` under a `describe('Given an arbitrary <X>')` > `describe('When …')` > `it('Then …')` chain.

### O1 — `header.ts`

```
∀ (type ∈ {blob,tree,commit,tag}, size ∈ ℕ).
   parseHeader(serializeHeader(type, size)) ≡ { type, size, contentOffset: header.length }
```

```
∀ rawBytes without 0x00 in any prefix of length ≤ 256.
   parseHeader(rawBytes) throws INVALID_OBJECT_HEADER('missing null terminator')
```

Two `it`s. Generators: `fc.constantFrom('blob','tree','commit','tag')` × `fc.nat({ max: 2**31 - 1 })` for the round-trip; `fc.uint8Array({ minLength: 1, maxLength: 256 }).filter(b => !b.includes(0))` for the negative property.

### O2 — `tree.ts`

```
∀ entries (well-formed, name-sorted with directory suffix).
   parseTree(serializeTree(entries)) ≡ entries
```

```
∀ entries (unsorted but otherwise valid).
   serializeTree(entries) ≡ serializeTree(sortByName(entries))
```

Generator: `arbTreeEntry` returning `{ name, mode, id }` over the `FILE_MODE` union and the existing `arbObjectId(40)`. Names use ASCII subset (no `/`, no `\0`). One sorted-input round-trip, one sort-canonicalisation invariant. Tree is currently a complete blind spot — the test file has zero `it`s.

### O3 — `file-mode.ts`

```
∀ mode ∈ { REGULAR, EXECUTABLE, SYMLINK, DIRECTORY, GITLINK }.
   normalizeFileMode(serializeFileMode(mode)) ≡ mode
```

One property. The five-element enum is small enough that an exhaustive sweep is sound, but the property form lets us add quasi-mode mutants (e.g. `0644` → `100644`) without rewriting tests.

### R1 — `packed-refs.ts`

```
∀ entries ⊆ { (refName, objectId) } with valid names.
   parsePackedRefs(serializePackedRefs({ entries, peeling: 'none', sorted: false })).entries
   ≡ entries (after dedup-by-name)
```

```
∀ entries, peeling ∈ {'none','tags','fully'}.
   header round-trip preserves peeling
```

Two properties. Uses `arbRefName` and `arbObjectId`.

### I1 — `index-parser.ts` (the big one)

```
∀ index (v2, entries with valid stat data, valid paths, no extensions).
   parseIndex(serializeIndex(index)) ≡ index
```

```
∀ index (v3, with extendedFlags ⊃ { skipWorktree, intentToAdd }).
   parseIndex(serializeIndex(index)) ≡ index
```

```
∀ index where entries are unsorted on input.
   parseIndex(serializeIndex(index)).entries ≡ stableSortByPath(entries)
```

Three properties. The existing `arbIndexEntry` already generates well-formed entries; we wrap it in `arbGitIndex({ version: 2 | 3 })` that picks a small array of entries (size 0..20) and a deterministic empty `extensions` list.

This is where we expect to find bugs — the parser surface includes binary path encoding, NUL termination, 8-byte padding, flag bit packing, and extended-flag handling. Today's example tests probe each of these dimensions in isolation; the round-trip property exercises their combinations.

### P1 — `compile-pathspec.ts`

```
∀ patterns (ASCII, no NUL, no leading `/`).
   compilePathspec(patterns).every(entry => entry.compiled is a callable matcher)
```

```
∀ pattern, ∀ matchingPath where pattern is a literal directory.
   compilePathspec([pattern + '/']).match(pathInside(pattern)) === true
```

Two properties. The first is a structural / total-function property: compilation never throws on safe input. The second is a behavioural invariant: literal directory patterns match their descendants.

### P2 — `match-pathspec.ts`

```
∀ patterns, ∀ path.
   matchPathspec(compilePathspec(patterns), path) ⇔ any(p ⇒ p.compiled.match(path))
```

One property — `matchPathspec` is a disjunction of per-entry matchers. Property exercises the OR-aggregation.

### G1 — `parse-gitignore.ts`

```
∀ lines (mix of patterns, comments, blanks, escaped `#`/`!`).
   parseGitignore(serializeRules(parseGitignore(text))) ≡ parseGitignore(text)
```

(Parser idempotence — the parser has no canonical serializer, so we round-trip through a test-only serializer that reconstructs source from rules. This catches lossy parses.)

```
∀ patterns prefixed with `!`.
   parseGitignore(patterns).rules.filter(r => r.negate).length === count(patterns startsWith '!')
```

(Negation count invariant — every `!` line yields exactly one negate rule.)

```
∀ patterns containing `#` mid-line.
   parseGitignore(patterns).rules.every(r => !r.pattern.includes(unescaped #))
```

(Comment-stripping invariant.)

Three properties.

### G2 — `matcher-stack.ts` and `match.ts`

```
∀ rules, ∀ path.
   stackMatch(rules, path) ≡ lastWinning(rules, path)
```

Property: stack semantics — the *last* matching rule decides, and a negate rule un-ignores. One property; covers both files since `match` is the underlying primitive.

## Test structure

```
test/unit/domain/
  objects/
    arbitraries.ts             # add arbTreeEntry, arbObjectType, arbFileModeFromEnum
    header.properties.test.ts  # NEW
    tree.properties.test.ts    # NEW
    file-mode.properties.test.ts # NEW
  refs/
    arbitraries.ts             # extend
    packed-refs.properties.test.ts # NEW
  git-index/
    arbitraries.ts             # add arbGitIndex (v2/v3)
    index-parser.properties.test.ts # NEW
  pathspec/
    arbitraries.ts             # NEW — arbPathspecPattern, arbCandidatePath
    compile-pathspec.properties.test.ts # NEW
    match-pathspec.properties.test.ts # NEW
  ignore/
    arbitraries.ts             # NEW — arbGitignoreLine, arbGitignoreText
    parse-gitignore.properties.test.ts # NEW
    matcher-stack.properties.test.ts # NEW
```

File naming: `*.properties.test.ts`. The 19.3 expressiveness lint scans only `.test.ts` files; the suffix `.properties.test.ts` matches that glob, so the new files are gated by the same GWT and AAA rules as the rest of the suite.

## Why a sibling file (not extension of the existing example test)?

Three reasons:

1. **Failure attribution.** A failing property emits a shrunk counterexample; mixing properties with example assertions in one `describe` block makes it harder to spot which kind of test broke and triages slower.
2. **Run-time isolation.** `fc.assert` cycles can take 200–800 ms depending on `numRuns`; isolating them lets us tune `numRuns` per file without dragging the unit-test budget. Existing example files keep their <50 ms profile.
3. **GWT readability.** Property tests use the same describe/it grammar but their `Given` clauses read `Given an arbitrary X`. Keeping that consistent inside one file is easier than threading both styles into a shared `describe` tree.

## Run budget

`fc.assert` defaults to `numRuns: 100`. We adopt:

- **Round-trip properties** (cheap shrinking): `numRuns: 200`.
- **Negative properties** (filter-heavy, slow shrinking): `numRuns: 50`.
- **Composition properties** (matchers / stacks): `numRuns: 100` (default).

Aggregate impact: ~24 new properties × ~150 ms median = ~3.6 s added to unit-test wall time. The current unit suite runs in ~14 s; the +25% increase is acceptable, and properties parallelise within vitest's worker pool.

## Arbitraries policy

- Reuse `arbObjectId`, `arbRefName`, `arbIndexEntry` from existing files. Never duplicate.
- New per-family `arbitraries.ts` files export named arbitraries (no default exports).
- Arbitraries that emit *invalid* inputs (for negative properties) live next to the positive ones, named with a `Bad` or `Invalid` suffix: `arbHeaderBytesWithoutNul`.
- Path-flavoured arbitraries deliberately restrict to a small ASCII subset and reject `.`, `..`, leading `/`, embedded `\0`. These are properties of *the validator*, not of the parser, and the parser test fixtures should land downstream of validation.

## Determinism and shrinking

Every `fc.assert` call passes `{ seed }` only when reproducing a CI failure. Local runs use fast-check's default per-suite seed printed on failure. We do **not** hard-code seeds in committed tests — that defeats fast-check's value.

Shrinking should produce *minimal* counterexamples. Where we use `map`, we accept the worse shrinking quality; where we can express a property with `record`, we do, because records shrink each field independently.

## Failure modes the properties are expected to catch

| Property | Bug it would catch |
|---|---|
| I1 round-trip v3 | Extended-flag byte advancement off-by-one |
| I1 sorted-canonicalisation | Path comparator swap (byte vs UTF-16) |
| O2 tree round-trip | Mode-as-octal vs mode-as-decimal mismatch |
| O2 sort canonicalisation | Directory-suffix sort key forgotten |
| G1 idempotence | Comment-strip eating an escaped `\#` |
| G2 stack lastWinning | First-wins regression on negation |
| P1 total compilation | Regex compilation throwing on edge metachar |
| P2 OR-aggregation | Short-circuit returning `undefined` on no-match |

These are the canonical bug shapes property tests catch that example tests don't.

## Test-conventions compliance

All new tests follow the project rules verbatim:

- Describe/it tree: `describe('Given an arbitrary X')` > `describe('When …')` > `it('Then …')`.
- AAA body: `// Arrange`, `// Act`, `// Assert` markers around the `fc.assert` block. The `Act` step is `fc.assert(fc.property(…))`; the property body itself contains a nested AAA — that nested triple uses inline comments, not block comments, to keep the lambda readable.
- `sut` naming: the value under test inside the property body is named `sut`.
- No `toBeDefined()` — every property asserts concrete content.
- No coverage / mutation ignore directives.

## Mutation impact

The 19.1 budgets are per-bucket. These tests strictly increase the *domain* bucket's killed-mutant set without changing the budget. No extra equivalent-mutant comments are expected — the new tests should kill mutants the example tests miss, not the other way around. If a property fails to kill an existing mutant the example tests already covered, we accept it; if it surfaces a *new* surviving mutant, we kill it in source (not by widening the test).

## Open questions (resolved before implementation)

- **Sibling file or extension?** → sibling (see "Why a sibling file" above).
- **`numRuns` policy?** → tiered (200/100/50) — see Run budget.
- **Negative-property scope?** → only where the parser's failure modes have grammar-level invariants (e.g. missing NUL, oversized entry count). Not every error path.
- **Arbitrary placement?** → next to tests in `test/unit/domain/<family>/arbitraries.ts`. Never under `src/`.

## Convergence pass log

- **Pass 1** — initial draft.
- **Pass 2** — moved index-parser to "the big one" position; added run-budget table; split G into G1/G2; tightened negative-property scope.
- **Pass 3** — clarified arbitraries policy (no `Bad` arbitraries under `src/`); resolved `numRuns` per file class; locked test-file naming to `*.properties.test.ts`; specified that we never commit seeds.

Converged at pass 3.
