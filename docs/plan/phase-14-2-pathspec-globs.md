# Plan — Phase 14.2 — Pathspec globs

Design: `docs/design/phase-14-2-pathspec-globs.md`.
ADRs: 037 (auto-detect), 038 (exclusion), 039 (defer status), 040 (shared compileGlob).

Branch: `feat/pathspec-globs`.

Atomic conventional-commit per step. TDD per slice.

## Step 1 — Extract `compileGlob` from `parseGitignore`

**Files touched:**
- `src/domain/pathspec/compile-glob.ts` — NEW: `compileGlob`,
  `containsGlob` (extracted from `parse-gitignore.ts` private helper).
- `src/domain/pathspec/index.ts` — NEW barrel.
- `src/domain/ignore/parse-gitignore.ts` — MODIFIED: import
  `compileGlob` instead of inlining.

**Tests first** (`test/unit/domain/pathspec/compile-glob.test.ts`):
- Single `*` → `[^/]*`.
- `**` → `.*` (and absorbs trailing `/`).
- `?` → `[^/]`.
- Character class `[abc]` → preserved.
- Anchored vs non-anchored — different prefix.
- `withDirSuffix: true` on a literal → matches the path AND `<path>/...`.
- `containsGlob` true for `'*'`, `'?'`, `'['`; false for plain strings.

The existing `parseGitignore` tests must still pass (parity check).

**Commit:** `refactor(domain): extract compileGlob from parseGitignore`.

## Step 2 — `compilePathspec` + `matchesPathspec`

**Files touched:**
- `src/domain/pathspec/compile-pathspec.ts` — NEW: `Pathspec`,
  `PathspecEntry`, `compilePathspec`.
- `src/domain/pathspec/match-pathspec.ts` — NEW: `matchesPathspec`.
- `src/domain/pathspec/index.ts` — barrel update.

**Tests first**:
- `compilePathspec`:
  - Literal pattern (`'src/foo.ts'`) → `{ isLiteral: true, negated: false }`.
  - Glob pattern (`'*.ts'`) → `{ isLiteral: false, negated: false }`.
  - Anchored glob (`'src/**'`) → anchored regex.
  - `!`-prefixed → `negated: true`, body parsed normally.
  - `'!*.ts'` → negated + glob.
  - `'!src/foo'` → negated + literal.
  - Multiple patterns → returns array in input order.
- `matchesPathspec`:
  - Empty spec → returns `false`.
  - Single literal `'src/foo.ts'`: matches itself AND `'src/foo.ts/x'`
    (literal-as-directory semantics).
  - Single glob `'*.ts'`: matches `'foo.ts'` AND `'src/foo.ts'`.
  - `'src/**'` matches `'src/a'`, `'src/a/b'`. Does NOT match `'src'`.
  - Negation: `['*.ts', '!*.test.ts']` → `true` for `'foo.ts'`,
    `false` for `'foo.test.ts'`.
  - Only-negations → false for everything.
  - Last-match-wins: `['!*.ts', '*.ts']` → `true` for `'foo.ts'`.

**Commit:** `feat(pathspec): compilePathspec + matchesPathspec`.

## Step 3 — `resolvePathspec` application helper

**Files touched:**
- `src/application/commands/internal/resolve-pathspec.ts` — NEW.

**Tests first**:
- Single literal → `hasGlob: false`, `literalMustMatch: [literal]`.
- Single glob → `hasGlob: true`, `literalMustMatch: []`.
- Mix → both populated correctly.
- `!`-only entries → `hasGlob: false`, no literal-must-match
  (negation isn't a must-match).
- Validation: `'../escape'` → throws `PATHSPEC_OUTSIDE_REPO` (via
  `validateWorkingTreePath`).
- Validation: `'!../escape'` → throws (validator sees the body).
- Empty pattern (`''`) or bare `'!'` → throws `PATHSPEC_OUTSIDE_REPO`
  (empty body).

**Commit:** `feat(pathspec): resolvePathspec command-side helper`.

## Step 4 — `enforceLiteralMustMatch`

**Files touched:**
- `src/application/commands/internal/resolve-pathspec.ts` — extend
  with `enforceLiteralMustMatch(literals, matchedSet)`.

**Tests first**:
- Literal hit directly → no throw.
- Literal hit as directory prefix (literal `'src'`, matched
  `'src/a.ts'`) → no throw.
- Literal not hit → throws `PATHSPEC_NO_MATCH` with the pattern.
- Multiple literals, one missing → throws with the missing one.

**Commit:** `feat(pathspec): enforce literal must-match helper`.

## Step 5 — Wire `rm`

**Files touched:**
- `src/application/commands/rm.ts` — replace the per-path loop with
  pathspec resolution + index filter.

**Tests first** (extend `test/unit/application/commands/rm.test.ts`):
- `rm(['*.log'])` removes every `.log` in the index → `removed`
  contains the matched set, `removed: []` if none matched and no
  literals were supplied.
- `rm(['*.nope'])` (glob, zero matches) → returns `removed: []`,
  no throw.
- `rm(['nope.txt'])` (literal, not in index) → throws
  `PATHSPEC_NO_MATCH` (existing behaviour preserved).
- `rm(['*.log', '!keep.log'])` keeps `keep.log` in index.
- `rm(['src/foo.ts'])` literal still works (regression pin).

**Commit:** `feat(rm): accept pathspec globs`.

## Step 6 — Wire `checkout`

**Files touched:**
- `src/application/commands/checkout.ts` — in `pathRestore`, compile
  the pathspec, expand against the source tree by enumerating its
  paths (via `walkTree` on the tree id, or by re-using the synthesised
  tree's entries), then materialise the matched Set.

**Tests first** (extend `test/unit/application/commands/checkout.test.ts`):
- `checkout({ paths: ['*.ts'], source: 'HEAD' })` restores only `.ts`
  paths (assertion: `result.changedPaths` matches the count).
- `checkout({ paths: ['src/**'], source: 'HEAD' })` restores
  everything under `src/`.
- `checkout({ paths: ['*.nope'], source: 'HEAD' })` (no match) →
  `changedPaths: 0`, no throw.
- `checkout({ paths: ['nope.txt'], source: 'HEAD' })` (literal, not
  in tree) → throws `PATHSPEC_NO_MATCH`.
- `checkout({ paths: ['src/foo.ts'], source: 'HEAD' })` (literal) is
  byte-identical to today's path-restore — regression pin.

**Commit:** `feat(checkout): accept pathspec globs in path-restore`.

## Step 7 — Wire `add`

**Files touched:**
- `src/application/commands/add.ts` — branch in the literal-paths
  flow: if all inputs are pure literals AND each points at an
  existing file, route through the existing `stageOne` path; else
  walk + filter by pathspec.

**Tests first** (extend `test/unit/application/commands/add.test.ts`):
- `add(['*.ts'])` walks the working tree and stages every matching
  path (respects `.gitignore`).
- `add(['*.ts', '!*.test.ts'])` excludes test files.
- `add(['src/**'])` stages everything under `src/`.
- `add(['nope.txt'])` (literal, no matching file) throws
  `PATHSPEC_NO_MATCH`.
- `add(['*.nope'])` (glob, no match) returns `added: []`.
- Literal-path mode regression: `add(['file.ts'])` is byte-identical
  to §14.1 happy path (per-path stage, no walk).
- Literal directory: `add(['src'])` walks under `src/` (still
  respects `.gitignore`).
- Literal-but-ignored: `add(['build.log'])` (file exists, matches
  `*.log` in gitignore) STILL stages it (Git's "literal beats
  ignore" semantics).

**Commit:** `feat(add): accept pathspec globs in literal-path mode`.

## Step 8 — Coverage / mutation polish

Run `npm run test:coverage`; fill any gap. Run stryker on the
§14.2 surface; kill killable mutants, document equivalents inline.

**Commit:** `test(pathspec): kill mutants on compile + match`.

## Step 9 — Docs + BACKLOG

- `README.md` — add a "Pathspec globs" subsection.
- `MIGRATION.md` — extend the `add` / `rm` / `checkout` rows with
  glob examples.
- `RUNBOOK.md` — pathspec semantics + literal-vs-glob detection +
  exclusion + no-match rules.
- `docs/BACKLOG.md` — flip `[ ] 14.2` → `[x] 14.2 …` (note `status`
  filter deferred per ADR-039).

**Commit:** `docs(pathspec): readme migration runbook + backlog`.

## Order summary

```
1. extract compileGlob
2. compilePathspec + matchesPathspec
3. resolvePathspec helper
4. enforceLiteralMustMatch
5. rm wiring (smallest)
6. checkout wiring (medium)
7. add wiring (largest)
8. coverage + mutation
9. docs + BACKLOG
```

Then: 3 review passes → harness green → push → open PR.
