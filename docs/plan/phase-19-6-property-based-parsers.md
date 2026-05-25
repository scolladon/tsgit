# Plan — Phase 19.6 Property-Based Parser Tests

> Design: `docs/design/phase-19-6-property-based-parsers.md`
> ADRs: 134 (sibling files), 135 (tiered numRuns), 136 (additive policy)
> Branch: `feat/19-6-property-based-parsers`

## TDD note

Each step is Red → Green. "Red" here means: write the property, run it, and confirm it *passes* against the current implementation. A property that passes immediately is still doing work — it certifies the invariant holds *over the generated input space*, which the prior example tests didn't. If a property fails on first run, the bug is in the source, not the test; treat it as a 19.6 finding and fix the source (no source fix is expected — the parsers are mature).

Each step's commit follows conventional commits, scoped to the family being touched.

## Sequencing rationale

1. **Objects first** (small, no shared state) — proves the arbitraries pattern. Covers `header` and `file-mode`; `tree` already has property tests so we don't touch it.
2. **Index** — the highest-value step; requires building `arbGitIndex`. Run mutation testing right after this lands.
3. **Pathspec** — establishes the `arbPathspecPattern` / `arbCandidatePath` pair reused in step 4.
4. **Gitignore** — composes on step 3's arbitraries.
5. **Final sweep** — re-run validate, mutation budgets, doc updates.

No step depends on a later step. Each commit leaves the harness green.

## Step 1 — Objects: header, file-mode

### 1a. Extend `test/unit/domain/objects/arbitraries.ts`

Add:

- `arbObjectType(): fc.Arbitrary<'blob'|'tree'|'commit'|'tag'>` — `fc.constantFrom`.
- `arbFileModeEnum(): fc.Arbitrary<FileMode>` — `fc.constantFrom(...Object.values(FILE_MODE))`.

No `Bad` arbitraries here; negative properties get their generators inline (they're parser-specific and small).

### 1b. `header.properties.test.ts`

Two properties:

- **Round-trip**: `∀ type, size. parseHeader(serializeHeader(type, size)) ≡ { type, size }`. `numRuns: 200`.
- **No-NUL negative**: `∀ rawBytes without 0x00. parseHeader(rawBytes) throws INVALID_OBJECT_HEADER('missing null terminator')`. `numRuns: 50`, generator filters out arrays containing 0.

### 1c. `file-mode.properties.test.ts`

One property:

- `∀ mode ∈ FILE_MODE. normalizeFileMode(mode) === mode` (identity on canonical forms; documents the contract). `numRuns: 50` (small input space).

Commit: `test(domain): property tests for object header/file-mode parsers`.

Acceptance check before commit: `npm run test:unit -- header.properties file-mode.properties`.

## Step 2 — Index: the big one

### 2a. Extend `test/unit/domain/git-index/arbitraries.ts`

Add:

- `arbIndexEntryV2(): fc.Arbitrary<IndexEntry>` — wraps existing `arbIndexEntry`, forcing `flags.skipWorktree = false`, `flags.intentToAdd = false` (v2-compatible).
- `arbIndexEntryV3(): fc.Arbitrary<IndexEntry>` — wraps existing `arbIndexEntry`, forcing at least one of `skipWorktree`/`intentToAdd` to true.
- `arbGitIndexV2(): fc.Arbitrary<GitIndex>` — record of `{ version: 2, entries: fc.uniqueArray(arbIndexEntryV2, { selector: e => e.path, maxLength: 12 }), extensions: [] }`.
- `arbGitIndexV3(): fc.Arbitrary<GitIndex>` — `{ version: 3, entries: array of arbIndexEntryV2 + arbIndexEntryV3 mixed, ensuring ≥1 extended entry, extensions: [] }`.

Max entry count is bounded at 12 so a single fast-check run completes in ~50 ms. Entries must have unique paths (the index never has duplicate stage-0 paths — multi-stage is out of scope for 19.6).

### 2b. `index-parser.properties.test.ts`

Three properties:

- **V2 round-trip**: `∀ index ∈ arbGitIndexV2. parseIndex(serializeIndex(index)) ≡ { ...index, entries: sortByPath(index.entries) }`. `numRuns: 200`.
- **V3 round-trip**: `∀ index ∈ arbGitIndexV3. parseIndex(serializeIndex(index)) ≡ { ...index, entries: sortByPath(index.entries) }`. `numRuns: 200`.
- **Path-order canonicalisation**: `∀ index. parseIndex(serializeIndex(index)).entries.map(e => e.path) is byte-sorted ascending`. `numRuns: 100`.

The round-trip equality uses a deep-equals check via `expect(received).toEqual(expected)` inside the property body. Paths are compared by their string form (the brand is a TypeScript-only annotation).

Commit: `test(domain): property tests for index parser (v2 + v3 round-trip)`.

After this commit: `stryker run --files 'src/domain/git-index/**'` to spot newly killable mutants. Anything new gets a fix-in-source commit before step 3.

## Step 3 — Pathspec

### 3a. Create `test/unit/domain/pathspec/arbitraries.ts`

- `arbLiteralPattern(): fc.Arbitrary<string>` — ASCII letters/digits/`-_.`, 1–10 chars, never starts with `!` or `/`.
- `arbGlobPattern(): fc.Arbitrary<string>` — literal pattern with one of `*`, `?`, `**` inserted at a random position. Filtered so the result still parses (`compileGlob` is total on safe ASCII).
- `arbCandidatePath(): fc.Arbitrary<FilePath>` — slash-separated array of literal-pattern strings, 1–4 components, never `.`/`..`. Returns through `FilePath.from`.

### 3b. `compile-pathspec.properties.test.ts`

Two properties:

- **Total compilation**: `∀ patterns (mix of literal + glob, neither starting with `/`). compilePathspec(patterns) returns a Pathspec with patterns.length entries, each with `compiled.test` callable on any FilePath without throwing`. `numRuns: 100`.
- **Literal-as-directory match**: `∀ literal L, ∀ descendantSuffix. compilePathspec([L]).find(e => e.isLiteral).compiled.test(\`\${L}/\${descendantSuffix}\`) === true`. `numRuns: 100`.

### 3c. `match-pathspec.properties.test.ts`

One property:

- **OR aggregation**: `∀ patterns, ∀ path. matchesPathspec(spec, path) ⇔ ∃ entry e ∈ spec, not e.negated, e.compiled.test(path)` — interpreted as "if any non-negated matcher hits and no later negation un-hits, matchesPathspec returns true". `numRuns: 100`.

Commit: `test(domain): property tests for compile-pathspec and match-pathspec`.

## Step 4 — Gitignore

### 4a. Create `test/unit/domain/ignore/arbitraries.ts`

Reuses pathspec arbitraries. Adds:

- `arbGitignorePattern(): fc.Arbitrary<string>` — pathspec literal/glob, optionally prefixed with `!`, optionally suffixed with `/`.
- `arbGitignoreText(): fc.Arbitrary<string>` — newline-joined mix of patterns, comment lines (`# …`) and blank lines.

### 4b. `parse-gitignore.properties.test.ts`

Three properties:

- **Idempotence-through-rules**: `∀ text. parseGitignore(reconstructFromRules(parseGitignore(text))) ≡ parseGitignore(text)`. The `reconstructFromRules` helper is local to the test file: it emits `!` + pattern + (directoryOnly ? '/' : '') joined by `\n`. The property asserts that a second parse yields a structurally identical ruleset (compared by `[ {pattern, negated, directoryOnly, anchored} ]`, ignoring the opaque `compiled` matcher). `numRuns: 200`.
- **Negation count**: `∀ patterns. parseGitignore(patterns.join('\n')).filter(r => r.negated).length === patterns.filter(p => p.startsWith('!')).length`. `numRuns: 100`.
- **Comment exclusion**: `∀ text whose lines all start with '#'. parseGitignore(text).length === 0`. `numRuns: 100`.

### 4c. `matcher-stack.properties.test.ts`

One property:

- **Last-match-wins via stack**: `∀ ruleset (non-empty, last rule matches the candidate). matchInStack([{ basedir:'', rules }], path, isDir) === (rules.findLast(r => r.compiled.test(path)).negated ? 'unignored' : 'ignored')`. `numRuns: 100`.

Commit: `test(domain): property tests for parse-gitignore and matcher-stack`.

## Step 5 — Final sweep

1. `npm run validate` — full harness green.
2. `stryker run` — kill any new survivors. Document equivalent mutants inline.
3. Three review passes (code/perf/security/tests) per the workflow.
4. Update docs:
   - `README.md` — no change expected (properties don't change capabilities).
   - `docs/understand/architecture.md` — add a sentence to the testing section noting properties-as-sibling-files.
   - `docs/get-started/` — no change.
   - `docs/BACKLOG.md` — flip 19.6 `[ ]` → `[x]` and append the ADR refs.
5. Push, open PR.

## Files created (final inventory)

```
test/unit/domain/objects/header.properties.test.ts          NEW
test/unit/domain/objects/file-mode.properties.test.ts       NEW
test/unit/domain/objects/arbitraries.ts                     MODIFIED
test/unit/domain/git-index/index-parser.properties.test.ts  NEW
test/unit/domain/git-index/arbitraries.ts                   MODIFIED
test/unit/domain/pathspec/compile-pathspec.properties.test.ts NEW
test/unit/domain/pathspec/match-pathspec.properties.test.ts NEW
test/unit/domain/pathspec/arbitraries.ts                    NEW
test/unit/domain/ignore/parse-gitignore.properties.test.ts  NEW
test/unit/domain/ignore/matcher-stack.properties.test.ts    NEW
test/unit/domain/ignore/arbitraries.ts                      NEW
docs/design/phase-19-6-property-based-parsers.md            NEW
docs/plan/phase-19-6-property-based-parsers.md              NEW
docs/adr/134-property-tests-as-sibling-files.md             NEW
docs/adr/135-tiered-numruns-budget.md                       NEW
docs/adr/136-properties-additive-not-replacing-examples.md  NEW
docs/BACKLOG.md                                              MODIFIED (flip 19.6)
docs/understand/architecture.md                              MODIFIED (one-line addition)
```

## Convergence pass log

- **Pass 1** — initial plan; sequencing felt arbitrary.
- **Pass 2** — reordered to put objects before refs (smaller arbitrary surface), explicitly called out mutation re-run after step 3 (where the highest bug-yield lives).
- **Pass 3** — added the "TDD note" preamble; tightened entry-count bound (≤12 to stay under per-property 50 ms), specified that paths are compared by string form in equality assertions.

Converged at pass 3.
