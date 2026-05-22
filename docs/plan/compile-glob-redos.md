# Implementation Plan — Harden `compileGlob` against ReDoS (17.3b)

Derived from [`docs/design/compile-glob-redos.md`](../design/compile-glob-redos.md)
and [ADR-077](../adr/077-linear-glob-matcher.md).

TDD: Red → Green → Refactor. `Given/When/Then` titles, AAA bodies, `sut`.
`npm run validate` before committing. One concept per commit.

## Step 1 — Tokeniser + linear matcher + consumer retype (one atomic change)

`compileGlob`'s return type changes from `RegExp` to `GlobMatcher`, so the
three consumers' field types must change in the same commit — the build does
not pass otherwise. This is one atomic commit.

### Test first — `test/unit/domain/pathspec/compile-glob.test.ts`

- The existing 12 cases stay verbatim — they call `sut.test(...)`, which
  `GlobMatcher` still answers. They are the primary equivalence guard.
- Add cases pinning each §5 recurrence row independently:
  - `literal` — a plain char matches itself, a different char does not.
  - `single` (`?`) — one non-`/` char, not zero, not two, not `/`.
  - `star` (`*`) — run of non-`/`, never crosses `/`.
  - `star-star` (`**`, no trailing `/`) — spans `/`.
  - `star-slash` (`**/`) — zero-or-more whole segments; does NOT match
    within a segment (`a/**/c` rejects `a/xc`).
  - `anchored` true vs false; `withDirSuffix` true vs false.
  - empty pattern matches only the empty string; `***` behaves as `**` + `*`.
- **ReDoS regression** — `compileGlob('a*'.repeat(64) + 'b', { anchored: true })`
  `.test('a'.repeat(10_000))` returns `false`; the test completes within a
  tight elapsed-time bound. Catastrophic backtracking would hang it.
- **Equivalence property test** (`fast-check`) — inline the *old* regex
  compiler as a test-only oracle; for a random glob pattern and a random
  line-terminator-free path, assert
  `compileGlob(pat, opts).test(path) === oracleRegex(pat, opts).test(path)`.

### Implement — `src/domain/pathspec/compile-glob.ts`

- Add `export interface GlobMatcher { test(path: string): boolean }`.
- `GlobToken` union + `tokenize(pattern): GlobToken[]` (reuse the `consumeStar`
  cursor logic; emit tokens, not regex fragments).
- `matchTokens(tokens, anchored, withDirSuffix, path): boolean` — the backward
  DP of design §5. `step<kind>` helpers per token kind, small and pure.
- `compileGlob` tokenises once and returns `{ test: (path) => matchTokens(...) }`.
- `containsGlob` unchanged.

### Retype the consumers (same commit)

- `src/domain/pathspec/index.ts` — export `GlobMatcher`.
- `src/domain/pathspec/compile-pathspec.ts` — `PathspecEntry.compiled: GlobMatcher`.
- `src/domain/ignore/parse-gitignore.ts` — `IgnoreRule.compiled: GlobMatcher`.
- `src/domain/sparse/sparse-pattern.ts` — rename `SparseRule.regex` →
  `SparseRule.matcher`, type `GlobMatcher`.
- `src/domain/sparse/non-cone.ts` — `compileSparseRule` sets `matcher`;
  `nonConeMatcher` reads `rule.matcher.test(path)`. Drop the now-stale comment
  about regex `g`/`y` flags.

### Verify

`npm run validate` — the `compile-glob`, `parse-gitignore`, `compile-pathspec`,
`match-pathspec`, `non-cone`, `parse-sparse-checkout` unit suites and the
`gitignore-end-to-end` / `sparse-checkout` integration suites all stay green.

### Commit

`fix(pathspec): compile globs to a linear non-backtracking matcher`.

## Step 2 — Review ×3, harness, mutation

- Three review passes over the diff (code / security / tests), parallel
  agents, fixing every finding each pass.
- `npm run validate` fully green.
- `stryker run` over `compile-glob.ts`, `non-cone.ts`, `compile-pathspec.ts`,
  `parse-gitignore.ts` — kill every killable mutant; document provable
  equivalents inline with `// equivalent-mutant:`.

## Step 3 — Docs refresh, BACKLOG flip, deps

- `docs/BACKLOG.md` — flip **17.3b** `[ ]` → `[x]` inside this PR's commits.
- `README.md` / pathspec docs — the pathspec/`.gitignore` syntax description
  is unchanged (the grammar is identical); confirm nothing claims a `RegExp`
  is exposed. No user-facing surface changed.
- `npm run check:deps` green — bring outdated dependencies current.
- **Commit** — `docs: record compileGlob ReDoS hardening (17.3b)`.

## Dependency graph

```
Step 1 ──> Step 2 ──> Step 3
```
