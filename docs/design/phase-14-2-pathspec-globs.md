# Phase 14.2 — Pathspec globs across `add`, `rm`, `checkout`

## 1. Goal

Extend the path arguments of `repo.add`, `repo.rm`, and
`repo.checkout({ paths })` so callers can supply globs (`*.ts`,
`src/**`, `[abc]?.log`, `!*.test.ts`) in addition to literal paths.

BACKLOG §14.2 acceptance:

> Pathspec globs (`*.ts`, `src/**`) across `add`, `rm`, `checkout`,
> `status` filters.

**Status of `status` is deferred** ([ADR-039](../adr/039-defer-status-pathspec.md)).
`status` is a read-only summary already returning every working-tree
change; callers wanting a filtered view can filter the result array
themselves. Wiring pathspec into the walk would couple the (already
busy) status flow without a corresponding semantic win for v1.

Scope is deliberately narrow:

- **Glob syntax**: `*`, `?`, `**`, inherited verbatim from the existing
  `parseGitignore` compiler. Character classes `[abc]` and magic
  prefixes (`:(top)`, `:(literal)`, `:(glob)`, etc.) are NOT supported
  in v1 — both deferred. The existing `parseGitignore` compiler does
  not honour character classes either (a literal `[` in a `.gitignore`
  is escaped through to the regex), so this preserves source parity.
- **Auto-detection** ([ADR-037](../adr/037-pathspec-auto-detect.md)):
  a pattern containing `*`, `?`, or `[` is interpreted as a glob; any
  other string is a literal path. No explicit prefix is required.
- **Exclusions** ([ADR-038](../adr/038-pathspec-exclusion.md)): a
  pattern beginning with `!` excludes matches that preceding
  patterns selected. Last-match-wins, mirroring `.gitignore` and the
  `matches` helper from `domain/ignore`.

## 2. Architecture

### 2.1 Matcher domain primitive

New module `src/domain/pathspec/`:

```typescript
// pathspec.ts
export interface PathspecEntry {
  readonly pattern: string;     // original, for diagnostics
  readonly negated: boolean;    // starts with `!`
  readonly isLiteral: boolean;  // no glob metacharacters → literal-prefix match
  readonly compiled: RegExp;    // converted via the parseGitignore glob compiler
}

export type Pathspec = ReadonlyArray<PathspecEntry>;

export const compilePathspec = (patterns: ReadonlyArray<string>): Pathspec;
export const matchesPathspec = (spec: Pathspec, path: FilePath, isDir: boolean): boolean;
export const containsGlob = (pattern: string): boolean;  // helper
```

`compilePathspec` parses each input string:

- Strip a leading `!` → `negated = true`.
- `containsGlob(pattern)` checks for `*`, `?`, or `[`.
- For literals: compile a regex that matches the exact path AND
  anything under it (`^src(/.*)?$` for input `src`).
- For globs: reuse the existing `compileGlob` helper extracted from
  `parseGitignore` (rename + share — see §3.1).

`matchesPathspec(spec, path, isDir)` evaluates entries in order:
each entry is checked against the path; last match wins. If NO
non-negated entry exists in the spec, the spec matches "nothing" (an
all-negation spec is a no-op). The starting state is "no match" —
this means a caller passing only `'!*.test.ts'` selects nothing.

### 2.2 Reuse `compileGlob` from `parseGitignore`

The glob→regex compilation logic already exists in
`src/domain/ignore/parse-gitignore.ts` as a private `compilePattern`.
Phase 14.2 extracts it into a sibling module
`src/domain/pathspec/compile-glob.ts` and both `parseGitignore` and
`compilePathspec` import from there. Pure refactor with no behaviour
change on the `.gitignore` side.

The only addition to `compileGlob`: an `anchored` parameter (already
present in `compilePattern`) plus a `withDirSuffix` parameter for
literal-prefix matching (so `'src'` compiles to `^src(/.*)?$`
instead of `^src$`).

### 2.3 Command wiring

Each command now accepts globs in the same `paths` array. The flow
forks on whether ANY input pattern contains a glob character:

- **All literal**: existing per-path behaviour (no regression risk).
- **Any glob**: compile the pathspec, run command-specific resolution:
  - `add(paths)`: walk the working tree (just like `add --all`)
    filtering by the pathspec instead of by `.gitignore`. The
    resolved leaves are then staged. Note this means `add(['*.ts'])`
    is effectively `add({ all: true })` with a different filter —
    `.gitignore` rules ARE still applied on top of the pathspec
    filter, because pathspec selects "what the user wants to consider"
    and `.gitignore` selects "what the user wants to skip".
  - `rm(paths)`: filter the existing index entries; any match is
    removed. Non-matching paths in the spec do not throw
    `PATHSPEC_NO_MATCH` (Git's behaviour: glob with zero matches is
    a no-op, but a *literal* with no match throws).
  - `checkout({ paths, source })`: filter the source tree's flat
    entry list by the pathspec, materialise matches.

### 2.4 No-match semantics

Mirroring Git:

- **Literal pathspec** that matches nothing in the relevant scope
  (working tree for `add`, index for `rm`, tree for `checkout`)
  throws `PATHSPEC_NO_MATCH` (existing error).
- **Glob pathspec** that matches nothing is a no-op (returns empty
  `added`/`removed`/`changedPaths`).
- **All-negation spec** (only `!`-prefixed) is a no-op.

## 3. Module structure

```
src/domain/pathspec/                    NEW
  compile-glob.ts                       NEW (extracted from parse-gitignore)
  compile-pathspec.ts                   NEW
  match-pathspec.ts                     NEW
  index.ts                              NEW barrel
src/domain/ignore/
  parse-gitignore.ts                    MODIFIED — imports compileGlob
src/application/commands/internal/
  resolve-pathspec.ts                   NEW — command-side resolution helpers
src/application/commands/
  add.ts                                MODIFIED — pathspec branch in addLiteral
  rm.ts                                 MODIFIED — pathspec branch
  checkout.ts                           MODIFIED — pathspec branch in pathRestore
```

## 4. New domain helpers

### 4.1 `compileGlob` (extracted)

```typescript
// src/domain/pathspec/compile-glob.ts
export interface CompileGlobOptions {
  readonly anchored: boolean;
  /** When `true`, the literal pattern matches the path AND any descendant. */
  readonly withDirSuffix?: boolean;
}

export const compileGlob = (pattern: string, options: CompileGlobOptions): RegExp;
export const containsGlob = (pattern: string): boolean;
```

The body is the existing `compilePattern` from `parse-gitignore.ts`,
with the `withDirSuffix` addition for literals.

### 4.2 `compilePathspec` + `matchesPathspec`

```typescript
// src/domain/pathspec/compile-pathspec.ts
export const compilePathspec = (patterns: ReadonlyArray<string>): Pathspec => {
  return patterns.map((raw) => {
    const negated = raw.startsWith('!');
    const body = negated ? raw.slice(1) : raw;
    const isLiteral = !containsGlob(body);
    const compiled = isLiteral
      ? compileGlob(body, { anchored: true, withDirSuffix: true })
      : compileGlob(body, { anchored: body.includes('/') });
    return { pattern: raw, negated, isLiteral, compiled };
  });
};

// src/domain/pathspec/match-pathspec.ts
export const matchesPathspec = (
  spec: Pathspec,
  path: FilePath,
  _isDir: boolean,
): boolean => {
  let matched = false;
  for (const entry of spec) {
    if (entry.compiled.test(path)) {
      matched = !entry.negated;
    }
  }
  return matched;
};
```

(`isDir` is reserved for future expansion — current pathspec rules
don't distinguish directory-only vs file matches the way
`.gitignore` does.)

### 4.3 `resolvePathspec` helper

```typescript
// src/application/commands/internal/resolve-pathspec.ts
export interface ResolvedPathspec {
  /** The pathspec matcher, ready to test against any path. */
  readonly matcher: Pathspec;
  /** Literal patterns that MUST match at least one path (for
   *  PATHSPEC_NO_MATCH semantics). Empty when only globs/negations
   *  were supplied. */
  readonly literalMustMatch: ReadonlyArray<FilePath>;
  /** True if any non-negated entry is a glob (relaxes no-match for the
   *  overall call). */
  readonly hasGlob: boolean;
}

export const resolvePathspec = (
  patterns: ReadonlyArray<string>,
): ResolvedPathspec => {
  const validated = patterns.map(validatePath);   // existing validator
  const matcher = compilePathspec(validated);
  const literalMustMatch = matcher
    .filter((e) => e.isLiteral && !e.negated)
    .map((e) => e.pattern as FilePath);
  const hasGlob = matcher.some((e) => !e.negated && !e.isLiteral);
  return { matcher, literalMustMatch, hasGlob };
};
```

The validator (`validatePath`) already rejects `..`, `/`-prefixed,
backslash, etc. Pathspecs go through it just like literal paths.
Patterns like `*.ts` pass validation (no traversal segments). A
pattern like `../escape.ts` is rejected upfront — pathspecs CANNOT
escape the working tree.

## 5. Command wiring

### 5.1 `add`

```typescript
const addLiteral = async (ctx, paths, opts) => {
  const { matcher, literalMustMatch, hasGlob } = resolvePathspec(paths);

  // Existing behaviour: if every input is a literal path AND none of them
  // is a directory, route through the per-path stageOne loop. This
  // preserves the byte-identical happy path for `add(['file.ts'])`.
  const allPureLiterals = !hasGlob && literalMustMatch.length === paths.length;
  if (allPureLiterals && (await everyLiteralIsFile(ctx, literalMustMatch))) {
    return addLiteralOnly(ctx, literalMustMatch, opts);
  }

  // Walk + filter path: shares acquireIndexLock + per-leaf stage machinery
  // with addAll, but the predicate is the pathspec instead of the ignore stack.
  return addByPathspec(ctx, matcher, opts);
};
```

`addByPathspec` re-uses `walkWorkingTree` and the per-leaf staging
helpers. The walker's `ignore` option is wired to the
`buildRepoIgnorePredicate` from §14.3 (gitignore still applies);
each yielded leaf is additionally tested by `matchesPathspec`. Only
leaves that PASS the pathspec AND are NOT ignored are staged.

Literal must-match enforcement: after the walk, for every literal
pattern that didn't appear in the staged-leaf set AND wasn't a
directory prefix, throw `PATHSPEC_NO_MATCH`.

### 5.2 `rm`

```typescript
export const rm = async (ctx, paths, opts) => {
  // …assertions
  const { matcher, literalMustMatch, hasGlob } = resolvePathspec(paths);
  const lock = await acquireIndexLock(ctx, …);
  try {
    const index = await readIndex(ctx).catch(emptyOnMissing);
    const byPath = new Map(index.entries.map((e) => [e.path, e]));
    const matched: FilePath[] = [];
    for (const [path] of byPath) {
      if (matchesPathspec(matcher, path, false)) matched.push(path);
    }
    // No-match semantics: literals that match nothing throw; globs are
    // best-effort.
    enforceLiteralMustMatch(literalMustMatch, matched, /* errorOnAbsent */ true);
    for (const path of matched) byPath.delete(path);
    // …existing working-tree removal + lock.commit
    return { removed: matched };
  } finally { … }
};
```

### 5.3 `checkout({ paths, source })`

`pathRestore` filters the flat tree (from `materializePathRestore*`'s
diff calculation) by the pathspec matcher. Same enforcement on
literals.

## 6. Validation rules

- `paths` array must be non-empty (existing contract).
- Each pattern goes through `validateWorkingTreePath` AFTER stripping
  a leading `!`. So `!../escape` is rejected — `..` is invalid even
  when negated.
- Empty pattern (or `'!'` alone) → `EMPTY_PATHSPEC`.

## 7. No-match enforcement

```typescript
const enforceLiteralMustMatch = (
  literals: ReadonlyArray<FilePath>,
  matched: ReadonlyArray<FilePath>,
  errorOnAbsent: boolean,
): void => {
  if (!errorOnAbsent) return;
  const matchedSet = new Set(matched);
  for (const lit of literals) {
    // Literal matched directly OR something under it (literal acts as a
    // directory prefix).
    const hit =
      matchedSet.has(lit) ||
      Array.from(matchedSet).some((m) => m.startsWith(`${lit}/`));
    if (!hit) throw pathspecNoMatch(lit);
  }
};
```

For `add`, `errorOnAbsent` is `true` only when the literal points at
a non-existent file (a literal that's an existing-but-ignored file
is a no-op, not an error — matches `git add`'s `--dry-run` parity).
For `rm`, `errorOnAbsent` is `true` unconditionally — `rm a` with no
matching index entry has always been an error in this codebase.

## 8. Testing strategy

### 8.1 Domain tests

`src/domain/pathspec/`:

1. `compileGlob` parity tests: every existing `parseGitignore` test
   still passes (the helper is the same code path).
2. `compilePathspec`:
   - Literal-only pattern → `isLiteral: true`, regex with dir suffix.
   - Glob pattern (`*.ts`) → `isLiteral: false`, anchored false.
   - Anchored glob (`src/**`) → `isLiteral: false`, anchored true.
   - `!`-prefixed → `negated: true`, body parsed normally.
   - `!*.ts` → glob + negated.
   - `!src/foo` → literal + negated.
3. `matchesPathspec`:
   - Single literal: matches exact path AND descendants.
   - Single glob `*.ts`: matches `foo.ts`, `src/foo.ts`.
   - `src/**`: matches `src/a`, `src/a/b`. Does NOT match `src` alone.
   - Negation: `['*.ts', '!*.test.ts']` matches `foo.ts`, not
     `foo.test.ts`.
   - Only-negations spec → never matches.
   - Last-match-wins: `['!*.ts', '*.ts']` matches everything `.ts`.

### 8.2 Command tests

`add.test.ts`:
- `add(['*.ts'])` stages every `.ts` in working tree (respecting
  gitignore).
- `add(['src/**'])` stages everything under `src/`.
- `add(['*.ts', '!*.test.ts'])` stages `*.ts` minus `*.test.ts`.
- `add(['nope.txt'])` (literal, no matching file) throws
  `PATHSPEC_NO_MATCH`.
- `add(['*.nope'])` (glob, no match) returns `added: []` (no throw).
- Literal-path mode (single literal-file path) unchanged — byte-
  identical to §14.1.
- Literal directory path (`add(['src'])`) walks under `src/`.

`rm.test.ts`:
- `rm(['*.ts'])` removes every `.ts` from index.
- `rm(['*.nope'])` (glob, no match) returns `removed: []` — no throw.
- `rm(['nope.txt'])` (literal, not in index) throws
  `PATHSPEC_NO_MATCH`.
- `rm(['*.ts', '!*.test.ts'])` keeps test files.

`checkout.test.ts`:
- `checkout({ paths: ['*.ts'], source: 'HEAD' })` restores only
  `.ts` paths.
- Glob with no match → `changedPaths: 0`, no throw.

## 9. ADRs

- ADR-037 — Pathspec auto-detection (glob vs literal).
- ADR-038 — `!` exclusion semantics (last-match-wins).
- ADR-039 — Defer `status` pathspec filtering.
- ADR-040 — Extracted `compileGlob` shared between `parse-gitignore`
  and `compile-pathspec`.

## 10. Acceptance checklist

- [ ] `repo.add(['*.ts'])` walks the working tree and stages every
      matching path (respecting `.gitignore` from §14.3).
- [ ] `repo.add(['*.ts', '!*.test.ts'])` excludes test files.
- [ ] `repo.add(['src/foo.ts'])` (single literal file) is byte-
      identical to the §14.1 happy path.
- [ ] `repo.rm(['*.log'])` removes every `.log` in the index without
      throwing on a literal mismatch.
- [ ] `repo.checkout({ paths: ['src/**'], source: 'HEAD' })` restores
      only paths under `src/`.
- [ ] Literal-only invocations of all three commands still work
      verbatim (no regressions).
- [ ] 100% coverage holds on touched files.
- [ ] Stryker mutation surface keeps killable mutants killed;
      equivalent mutants documented inline.
