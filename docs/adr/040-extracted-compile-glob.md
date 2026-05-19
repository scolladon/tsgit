# ADR-040: `compileGlob` extracted from `parseGitignore` into shared domain module

## Status

Accepted (at `49a147e`)

## Context

The glob→regex compiler in `src/domain/ignore/parse-gitignore.ts`
(`compilePattern`) handles exactly the syntax §14.2 needs: `*`, `?`,
`**`, character classes, escaping. Two strategies:

1. **Extract into a shared sibling module** (`src/domain/pathspec/compile-glob.ts`)
   that both `parseGitignore` and `compilePathspec` import.
2. **Duplicate the logic** into pathspec, leaving `parseGitignore` alone.

Option 2 has lower risk (no parse-gitignore change), but creates two
sources of truth for glob compilation. A future syntax tweak (e.g.
adding `{a,b,c}` brace expansion) would have to be applied in two
places. Mutation tests on `parseGitignore` would not protect the
duplicated copy.

Option 1 requires extracting `compilePattern` and re-importing it.
The change to `parseGitignore` is mechanical (move + import). The
existing `parseGitignore` test suite (already in the repo) provides
the regression safety net.

## Decision

Adopt option 1. Create `src/domain/pathspec/compile-glob.ts` with:

```typescript
export interface CompileGlobOptions {
  readonly anchored: boolean;
  readonly withDirSuffix?: boolean;   // §14.2 addition
}

export const compileGlob = (pattern: string, options: CompileGlobOptions): RegExp;
export const containsGlob = (pattern: string): boolean;
```

`parseGitignore` switches `compilePattern(pattern, anchored)` →
`compileGlob(pattern, { anchored })`. `compilePathspec` consumes the
same helper with `withDirSuffix: true` for literal-path mode.

## Consequences

### Positive

- Single source of truth for glob compilation. Future tweaks (brace
  expansion, character-class negation, etc.) land in one file.
- `containsGlob` becomes a shared helper rather than a hand-rolled
  predicate per call site.
- Mutation coverage on `compileGlob` protects both `parseGitignore`
  and `compilePathspec` paths.

### Negative

- The `parseGitignore.ts` file changes shape. Its tests still pass
  because the input/output behaviour is preserved — but reviewers
  reading the §14.2 diff will see `parseGitignore` touched and may
  worry about ignored-rule regressions. Mitigated by the unchanged
  test suite + parity tests added in the extraction commit.

### Neutral

- `compile-glob.ts` lives under `src/domain/pathspec/` rather than
  `src/domain/ignore/` — its primary consumer in §14.2 is pathspec,
  not ignore. The cross-import direction (ignore → pathspec) doesn't
  create a cycle because pathspec → ignore is the only edge that
  existed before, and now neither imports from the other.
