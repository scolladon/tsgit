<!-- cspell:ignore backticked handback memoise ignorecase relativize relativizes gitlink wildmatch lstat mktemp pgrep uptime chmod chmodded arbitraries untracked excludesfile excludesFile oneline -->
# Plan — is-ignored-leading-directory

> Source: design doc `docs/design/is-ignored-leading-directory.md` · Rulings ADR-1271, ADR-1272, ADR-1273, ADR-1274, ADR-1275, ADR-1276, ADR-1277 (DC-1 A, DC-2 A user-ratified, DC-3 A, DC-4 A, DC-5 A)
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

## Sizing rules

- Every part costs a full agent lifecycle (spin-up, zero-context rebuild, gate) — it
  must earn it. No standalone test-only parts for FEATURE code: coverage/interop/property
  tests fold into the implementation part whose code they exercise. EXCEPTION:
  test-infra-only and docs-only parts (tooling config, test helpers, fixtures,
  harness/ADV/property suites, docs/prose) with no `src/` delta ARE standalone — they
  have no implementation part to fold into.
- A part that would be a pure test pass over already-landed code merges into its
  neighbour.
- A part should land in ~100 tool calls. More than ~5 RED→GREEN cycles, or more than 6
  files in its `### Context` block, is two parts. What counts is a backticked path:
  backtick the files the part CREATES or EDITS, and write read-only reference paths in
  plain text.

## Overview and ordering argument

Four parts, one commit each, every commit green on its own gate:

| # | Part | Behaviour it lands | Requirements | Interop rows |
|---|---|---|---|---|
| 1 | The leading-directory rule as pure domain functions | none observable (new internal functions, not yet called) | R2, R3 (verdict half), P1–P4 | none |
| 2 | One ignore session behind the per-path primitive | the per-path primitive answers as `git check-ignore` (Matrices A, E) | R1, R2, R3, R4, R5, R8 | Matrix A (28 rows), X1, X3, posix X2 |
| 3 | The shared predicate runs on the session | every overwrite pre-flight reads an occupant under an excluded directory as ignored (Matrices B, C, D, F); walk callers unchanged | R4, R6, R7, R8 | Matrices B, C, D, F, checkout X1, posix checkout X2, merge.abort and rebase.skip pins |
| 4 | Bench pair for the session | none (bench rows; the ratio is measured and handed back) | R7 cost half (ADR-1273) | none |
| 5 | One outcome per directory chain (added after the measurement, ADR-1278) | none (same verdicts; the session remembers per chain, a path asks only its parent) | R7 cost half | none (every interop row is a GUARD) |

**Ordering argument.** Part 1 lands the verdict as pure functions so Parts 2 and 3 only wire
loading. Part 2 builds the session and moves only `isIgnored` onto it: the predicate (and so every
pre-flight and walk caller) still runs the old code, so Part 2's blast radius is the one primitive.
Part 3 switches `buildRepoIgnorePredicate` to the session; that one body flips every probe consumer
at once (D-2 — they share it through `createIgnoredProbe`), so all their interop rows must land in
Part 3. Part 4 adds the D-7 bench right after the change it guards (no `src/` delta; ADR-1273
gate measured, not wired, as ADR-1267's precedent).

**Why Part 3 is at the six-file ceiling.** The predicate switch is one body; it flips every probe
consumer, so its unit rows (predicate, occupant classifier, directory clearing), the occupant
interop file and the posix-only checkout row have no other part to land in (the rows would be
GUARDs anywhere after it). The occupant interop file is table-driven so its RED is one entry.

**Why two files recur across parts (plan-lint's locality warning).** ignore-evaluator.ts changes in
Part 2 (the session is added beside the untouched predicate) and Part 3 (the predicate's body moves
onto it). Doing both in Part 2 would flip every pre-flight there, pulling the occupant interop file,
the consumer unit rows and the walk-caller gate into a part already holding the Matrix A rows — over
the six-file ceiling. The posix-only interop file is created in Part 2 (the per-path row it turns
green) and gains the checkout row in Part 3 (the part that turns that row green). Each part starts
from the previous part's committed tree.

**Requirement map.**

| Requirement | Part(s) | Proof rows |
|---|---|---|
| R1 (Matrix A verdicts and `-v` source) | 2 | unit Matrix A rows; interop file 1 |
| R2 (excluded leading directory reports its rule) | 1, 2 | domain rows C1, D1-shape, I1, O1; P1 |
| R3 (leading directory tested as a directory; query `isDirectory` caller-declared) | 1, 2 | E1, Q1, B2, E2, R2 rows |
| R4 (no read at or beneath an excluded directory) | 2, 3 | X1, X3, deeper X1 (unit), X2 (posix); predicate X1; checkout X1/X2 |
| R5 (order independence) | 1, 2 | order rows; P4 |
| R6 (pre-flights return git's outcome) | 3 | occupant interop file; occupant-clash and apply-changeset unit rows |
| R7 (walk callers unchanged; cost within D-7) | 3, 4 | existing status/add/stash suites in Part 3's gate; Part 4 bench |
| R8 (no exported signature change; nothing that returned starts throwing) | 1–3 | no barrel edit; reports/api.json untouched (see Public surface) |

## Planning facts (read once; every part relies on them)

- **Implementers have no MCP tools.** Every symbol below is named with its file and current
  signature; use Read/Grep/Edit. The harness LSP is rooted at the main checkout and reports false
  `Cannot find module` errors: `npm run check:types` is the only type oracle.
- **One RED per function, run it red before writing its code.** A row that already passes at its
  step is a GUARD (run it, see it pass). A RED test fails against the code as it stands at its step
  (earlier GREENs included). No step breaks code to watch a test fail; a red-capability check for a
  GUARD is an uncommitted temporary edit, run once and reverted before the gate
  (`git diff --no-ext-diff` then shows only the part's real edits).
- **Test shape** (CLAUDE.md): `describe('Given …')` > `describe('When …')` > `it('Then …')`, AAA
  section comments (`// Arrange`, `// Act`, `// Assert`), the system under test is `sut`. Under
  the ignorecase twin `describe.each(['false', 'true'])('Given core.ignorecase is %s', …)` the inner
  describes are `When …` only, and a platform skip goes on the `it` (`it.skipIf`), never
  `describe.skipIf(…).each(…)` (lesson 045). Error assertions use try/catch and assert `.data`
  (code AND the payload fields). No call-count spies to prove "not read" (lesson 011): prove it by
  outcome — an oversized `.gitignore` that would throw `GITIGNORE_FILE_TOO_LARGE` if read.
- **No provenance in src or test code.** No ADR numbers, no backlog id, no matrix row ids (A1, T5,
  X1, U4 …) in titles, comments or identifiers. Titles describe behaviour ("a negation beneath an
  excluded directory cannot re-include a path"). Row ids live only in this plan and the design.
- **No suppression directives** except the hook-permitted
  `// Stryker disable next-line <Mutators>: equivalent — <proof>` for a proven equivalent whose
  (mutator, line) pair holds no real mutant (.claude/workflow/mutation.md: a pair holding both an
  equivalent and a real mutant stays unsuppressed and the equivalence is recorded in the handback).
  See PC-1 and PC-2: with the recommended forms, the session code needs no new disable comment.
  The existing `BooleanLiteral` comment on the `rule === undefined` guard in is-ignored.ts stays
  verbatim. Comments that today sit on lines this plan deletes go with them.
- **vitest binary.** The part gate below is the manifest's verbatim. If the rtk hook widens
  `npx vitest run <files>` into a whole-suite run, run the same arguments through
  `./node_modules/.bin/vitest run`. wireit caches `check:types` and `check:spelling`: a
  "Ran 0 scripts" line is not a pass — the bare forms are
  `./node_modules/.bin/tsc --noEmit -p tsconfig.json` and
  `./node_modules/.bin/cspell --no-progress <files>`. Any command whose output may exceed ~100
  lines writes to a file under the session scratchpad; read back only the lines that matter.
  vitest swallows `console.log` here: a probe that must print writes to a file.
- **Never write git state in the worktree.** Interop rows build repositories under the OS temp dir
  (`makePeerPair` / `mkdtemp`). Probes against real git run as `bash /abs/script.sh` in a
  `mktemp -d` throwaway with `set -euo pipefail`, scrubbed `GIT_*`, an isolated `HOME`,
  `GIT_CONFIG_NOSYSTEM=1`, `git config core.ignorecase <v>` in every repository, each outcome run
  twice (.claude/workflow/probes.md, .claude/workflow/faithfulness.md).
- **git's answer is every interop row's expectation.** Rows run git inside the test through
  test/integration/interop-helpers.ts (`runGit`, `git`, `tryRunGitWithExit`, `makePeerPair`,
  `GIT_AVAILABLE`) and compare structured fields; the library emits no display string — the test
  rebuilds git's `-v` line from `source` (ADR-249). No probe path starts with `:` (lesson 058).
  Every repository sets `core.ignorecase` explicitly, both values (lesson 042).
- **Public surface: every new symbol is internal (R8).** src/domain/index.ts is a typedoc entry
  point (typedoc.json) and does `export * from './ignore/index.js'`, so anything added to
  src/domain/ignore/index.ts lands in reports/api.json (a prepush gate). The design's §1 says
  "exported through src/domain/ignore/index.ts"; this plan overrides that to keep R8: the three
  domain functions are exported from src/domain/ignore/matcher-stack.ts ONLY and imported by path
  (`../../../domain/ignore/matcher-stack.js`), never added to the barrel. `createIgnoreSession` and
  `IgnoreSession` live in src/application/primitives/internal/ignore-evaluator.ts, which no barrel
  re-exports (src/application/primitives/index.ts exports only `isIgnored` and its types from
  is-ignored.ts); the deprecated shim src/application/commands/internal/build-ignore-evaluator.ts
  is NOT extended. No `Repository` method, error code or command changes, so no facade,
  exhaustiveness switch, doc-coverage row or browser-surface entry is touched, and
  `npm run docs:json` is not needed. knip (`check:dead-code`) is satisfied because every new export
  has a src importer from Part 2 on (Part 1's are imported by tests only; knip's vitest plugin
  counts them).
- **Breaking mark.** None (ADR-1274, D-6): source commits are plain `fix(ignore): …`.
- **Size caps.** Parts never touch `.size-limit.json`. A part whose only red is a size cap reports
  it in its handback (the session raises caps once after review, clean build, `chore(size)`).

### git's rule, condensed (design §"git's rule")

`last_matching_pattern`: `prep_exclude` walks the path's proper leading directories root-first
(the root itself never tested); each is tested AS A DIRECTORY against the lists loaded so far (the
directories above it plus `info/exclude` and `core.excludesFile`). A negative match counts as no
match. The first positive match stops the walk, its pattern is the answer, and that directory's
own `.gitignore` (and everything beneath) is never read. Only when no leading directory is excluded
is the full path matched. tsgit's levels (global → info → root → deeper appended, last match wins,
`relativize` skipping a level whose basedir is the path itself, beneath it or unrelated) already
give git's precedence; only the leading-directory walk is missing.

## Decision candidates

Choices the design and ADRs leave open. The plan follows each recommendation; the session
ratifies or overrides before Part 2 spawns.

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| PC-1 | The per-directory memo lookup in the session (design §2 writes `if (known !== undefined) return known;` and §4 marks its skip mutant equivalent) | A: `state.entered.get(directory) ?? rememberEntry(state, directory)` · B: the design's `if` form, unmarked, the `false` survivor recorded as equivalent in the handback · C: the design's `if` form with `// Stryker disable next-line ConditionalExpression` | A | With the `if`, the ConditionalExpression pair holds a real mutant (`true` returns `undefined` for every new directory, so nested rules are never loaded — killed) and the equivalent one (`false`, re-enter every time), so mutation.md forbids C. A is value-free (lesson 011): its only mutant (`??` → `&&`) returns `undefined` for a new directory and is killed by every nested-`.gitignore` row; no equivalent survives |
| PC-2 | The empty-ruleset guard `if (rules.length > 0)` before pushing a level (design §4: equivalent, re-marked) | A: keep the guard, no disable comment; the implementer records the `true` and `>=` survivors as equivalent in its handback ("an empty level matches nothing") · B: `// Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent — …` as today's code does | A | Both pairs on that line also hold a real mutant (`false` and `<=` never push a non-empty level — killed by every nested-rule row); mutation.md: such a pair stays unsuppressed and the equivalence is recorded. B swallows two killed mutants. The guard itself stays: without it every walked directory adds a level and `matchInStack` scans O(directories) per entry (design §4) |
| PC-3 | The `merge.abort` and `rebase.skip` pin shapes (design: "an unmerged path whose ORIG_HEAD entry is absent" — that shape never writes the occupant's path, so it cannot pin the overwrite) | A: clean-deletion shapes — `merge.abort`: `other` deletes a tracked `ab/c` and edits `f`, `main` edits `f`; the merge stops on `f` with `ab/c` cleanly removed; an untracked `ab/c` is laid; abort restores `ORIG_HEAD`'s `ab/c`. `rebase.skip`: `main`'s commit deletes `ab/c` and edits `f`, `up` edits `f`; the rebase stops on `f` with `ab/c` removed; an untracked `ab/c` is laid; skip resets to `HEAD`, which tracks `ab/c` · B: the design's literal shape · C: drop the two pins | A | A is the shape that makes reset-worktree write over the occupant, which is what ADR-1274 asks the pins to prove. B proves nothing about the probe. C leaves ADR-1274's two unpinned consumers unpinned |
| PC-4 | Who builds the stopped state for the abort/skip rows | A: each tool drives its own twin end to end (git: `git merge other` / `git rebase up`, then the abort/skip; tsgit: `repo.merge.run` / `repo.rebase.run` to the same stop, then `repo.merge.abort()` / `repo.rebase.skip()` / `repo.rebase.abort()`), the stop asserted equal before the occupant is laid · B: git builds the stop in both twins and tsgit only runs the abort/skip | A | A compares whole operations and never has tsgit read state git wrote mid-sequence, so a row's red names the abort, not a state-file difference. The equal-stop assertion catches a divergence at the start separately |
| PC-5 | How the defect ratio of the bench gate is measured (lesson 056: record the fix's ratio and the defect's) | A: a temporary third scenario (the real predicate plus one extra directory match per leading directory of every file — a session that re-tests each entry's chain), measured in the same three runs and removed before the commit · B: commit it as a permanent third row | A | The gate is measured and recorded, not automated (ADR-1267 precedent, ADR-1273). A committed defect row times no shipped code path and costs CI bench time |

## Part 1 — The leading-directory rule as pure domain functions (R2, R3, R5; ADR-1271, ADR-1272)

### Context

Files this part edits:
- `src/domain/ignore/matcher-stack.ts`
- `test/unit/domain/ignore/matcher-stack.test.ts`
- `test/unit/domain/ignore/matcher-stack.properties.test.ts`
- `test/unit/domain/ignore/arbitraries.ts`

Behaviour: none observable — three new exported functions no src module calls yet (Part 2 wires
them). Do NOT edit src/domain/ignore/index.ts (Public surface fact: the barrel reaches
reports/api.json).

matcher-stack.ts today (79 lines): `interface IgnoreLevel { basedir: FilePath | ''; rules: IgnoreRuleset; kind?: 'global' | 'info' | 'gitignore' }`,
`interface VerboseMatch { verdict: MatchResult; level?: IgnoreLevel; ruleIndex?: number }`,
private `relativize(path, basedir)` (returns `undefined` unless `path` starts with `basedir + '/'`;
`''` basedir returns the path), `matchInStack(stack, path, isDir): MatchResult` (delegates),
`matchInStackVerbose(stack, path, isDir): VerboseMatch` (scans levels in order, last level whose
`matchesVerbose` returns a `ruleIndex` wins). `MatchResult` = `'ignored' | 'unignored' | 'unset'`
(src/domain/ignore/match.ts). Add, after `matchInStackVerbose`, exactly the design §1 code:

```ts
/** Each proper leading directory of `path`, root-first: `a/b/c` → `['a', 'a/b']`. */
export const leadingDirectoriesOf = (path: FilePath): ReadonlyArray<FilePath> =>
  path
    .split('/')
    .slice(0, -1)
    .map((_, depth, segments) => segments.slice(0, depth + 1).join('/') as FilePath);

/** git's prep_exclude test of one directory: the positive match that excludes it, if any. */
export const directoryExclusion = (
  stack: ReadonlyArray<IgnoreLevel>,
  directory: FilePath,
): VerboseMatch | undefined => {
  const match = matchInStackVerbose(stack, directory, true);
  return match.verdict === 'ignored' ? match : undefined;
};

/** git's last_matching_pattern: the first excluded leading directory decides, else the full path. */
export const matchBeneathLeadingDirectories = (
  stack: ReadonlyArray<IgnoreLevel>,
  path: FilePath,
  isDir: boolean,
  exclusionOf: (directory: FilePath) => VerboseMatch | undefined,
): VerboseMatch => {
  for (const directory of leadingDirectoriesOf(path)) {
    const exclusion = exclusionOf(directory);
    if (exclusion !== undefined) return exclusion;
  }
  return matchInStackVerbose(stack, path, isDir);
};
```

The `map` callback's third argument is the SLICED array, so `segments.slice(0, depth + 1)` never
includes the last segment; there is no length guard and no array literal (no `ArrayDeclaration`
or `<= 1` mutants). Why the whole stack is git's "lists loaded so far": `relativize` drops a level
whose basedir is the tested directory, beneath it, or unrelated, so only proper-ancestor levels and
base levels can match (design §1). Update the module doc only if a sentence becomes false.

Test helpers that exist (matcher-stack.test.ts): `level(basedir, source): IgnoreLevel` (parses
with `parseGitignore(source)`, no kind, no caseFold) and `path(s): FilePath`. Add beside them a
`foldedLevel(basedir, source)` using `parseGitignore(source, { caseFold: true })` and a
`kindLevel(kind, source)` (`basedir: ''`). `parseGitignore(text, { caseFold? })` is in
src/domain/ignore/parse-gitignore.ts; each `IgnoreRule` carries `lineNumber` and `pattern`.

Property file today (113 lines): imports `matches`, `IgnoreLevel`, `matchInStack`,
`parseGitignore`, `FilePath` (from src/domain/objects/index.js), `arbCandidatePath`,
`arbLiteralPattern` (test/unit/domain/pathspec/arbitraries.ts: segments over
`abcdefghijklmnopqrstuvwxyz0123456789-_.`, 1–8 chars, never ./..; paths of 1–4 segments). It
has a local `arbRuleLine` (optional `!`, literal body, optional /) and `arbRuleLines` (0–6).
test/unit/domain/ignore/arbitraries.ts exports `arbGitignorePattern` and `arbGitignoreText`. New
arbitraries for P1–P4 go in arbitraries.ts (exported, named below); keep each under 20 lines.

Mutation hot spots this part owns and the rows that kill them:
- `slice(0, -1)` (UnaryOperator `+1`, MethodExpression drop): rows `a` → `[]`, a/b/c → `['a', 'a/b']`.
- `depth + 1` (ArithmeticOperator `-`): row a/b/c.
- `=== 'ignored'` (ConditionalExpression, EqualityOperator, StringLiteral) and the `true` passed as
  `isDir` (BooleanLiteral): the negation-last row (ab/ then !ab/) and the directory-only row
  (ab/ against `ab`, no slash in the path).
- The domain loop's `exclusion !== undefined` early return: the two-exclusions row (first one wins)
  and A1 (a `false` mutant falls through to the full path, which does not match).

### TDD steps

1. RED `leadingDirectoriesOf` (matcher-stack.test.ts, new top-level `describe('leadingDirectoriesOf')`,
   `it.each` over `{ path: 'a', expected: [] }`, `{ 'a/b', ['a'] }`, `{ 'a/b/c', ['a', 'a/b'] }`,
   title `Given a path of %s segments` > `When its leading directories are listed` >
   `Then they are the proper prefixes, root-first`). Fails: the import is `undefined`
   (`TypeError: sut is not a function`). GREEN: add the function.
2. RED `directoryExclusion` (new `describe('directoryExclusion')`, one `it` each):
   - root `ab/` → returns `{ verdict: 'ignored', level, ruleIndex: 0 }` for `ab`;
   - root `ab/` then `!ab/` → `undefined` (a negation as last match);
   - root `a/b/`, level `a` holding `!b/` → `undefined` for `a/b`;
   - root `ab/` (directory-only) against `ab` → defined (tested as a directory);
   - a single level at basedir `ab` holding `*` → `undefined` for `ab` (a level at the directory
     itself never applies).
   Fails: import `undefined`. GREEN: add the function.
3. RED `matchBeneathLeadingDirectories` (new describe; `exclusionOf` is
   `(d) => directoryExclusion(stack, d)` in every row; assert `verdict`, the level by identity
   (`toBe(stack[i])`) and `ruleIndex`), `it.each` rows:
   - `ab` → query `ab/c` file: ignored, root, 0 (a rule naming the directory without a slash);
   - `ab/`, `!ab/c` → `ab/c`: ignored, root, 0 (a later negation cannot re-include);
   - `x/y/` → `x/y/z/w` and `x/y/z`: ignored, root, 0; `x/q`: `unset`;
   - `x/y/`, `x/y/z/` → `x/y/z/w`: ignored, root, ruleIndex 0 (the first excluded directory decides,
     not the deeper rule on line 2);
   - `ab/`, `!ab/` → `ab/c`: `unset`;
   - `*`, `!ab/` → `ab/c`: ignored, root, 0 (the leading test is negative, the full path matches `*`);
   - `ab`, `*.log` → `ab/x.log`: ignored, root, ruleIndex 0 (not 1);
   - level `a` holding `b/` → `a/b/c`: ignored, level `a`, 0;
   - root `a/`, level `a` holding `!b/` and `!b/c` → `a/b/c`: ignored, root, 0;
   - root `**/build/` → `p/build/o/f`: ignored, root, 0;
   - `ab/*`, `!ab/c` → `ab/c`: `unignored`, ruleIndex 1; `ab/d`: ignored, 0;
   - `kindLevel('info', 'ab/')` → `ab/c`: ignored, that level (kind `info`); same for `global`;
   - `foldedLevel('', 'AB/')` → `ab/c`: ignored; `level('', 'AB/')` → `ab/c`: `unset`.
   Fails: import `undefined`. GREEN: add the function.
4. GUARD properties (matcher-stack.properties.test.ts, one `describe('Given …')` each, AAA,
   `numRuns: 100`, no committed seed). Each passes on the GREEN code; prove red-capability once with
   a temporary edit (dropping the domain loop's early return makes P1 and P3 fail), reverted:
   - **P1** `arbExcludedDirectoryCase()` in arbitraries.ts: ancestor segments drawn from digits
     only (`[0-9]{1,4}`, 0–2 of them), a last segment `last` drawn from lower-case letters only, so
     no literal or letter-prefixed glob can match an ancestor; the excluding rule is one of
     `${last}/`, `${last}`, `/${dirPath}/`, `${last[0]}*`; it sits at a random index of the root
     level among positive literal rules over letter words other than `last`; trailing rules are only negations strictly
     beneath the directory (`!/${dirPath}/<seg>`, `!${last}/<seg>`); 0–2 extra levels at the
     directory or beneath it hold any `arbRuleLines`; the query is `${dirPath}/<1–3 segments>` with
     an arbitrary `isDir`. Property: the result is `'ignored'` with the root level and the
     excluding rule's index. Count the runs where the result is `'ignored'` and assert the count
     equals the run count after `fc.assert` (yes-rate 100% by construction, lesson 057).
   - **P2** `arbStackWithoutExcludedLeadingDirectory()`: path segments from `arbLiteralPattern`, a root level whose
     rules mix the path's own segments (literal, optional `/`, optional `!`) with `arbRuleLines`,
     and 0–2 levels at proper ancestors of the path. `fc.pre(every proper prefix p:
     matchInStackVerbose(stack, p, true).verdict !== 'ignored')` (the oracle, not the SUT). Property:
     `matchBeneathLeadingDirectories(…)` `toEqual` `matchInStackVerbose(stack, path, isDir)`.
     Before relying on it, count once how often the oracle answers `'ignored'` over 1000 samples:
     a temporary `it` that writes the count to a file under the session scratchpad, run once,
     deleted. Record the rate in one line of the describe's leading comment ("the oracle answers
     ignored in N% of runs"). Below ~20%: bias the rule mix further toward the path's own last
     segment and re-count.
   - **P3** reuse `arbExcludedDirectoryCase()`; add 1–3 levels at basedirs beneath the directory or
     in an unrelated directory (a basedir whose first segment starts with `u-`, which neither a
     digits-only ancestor nor the letters-only `last` can equal). Property: the result over
     `[...stack, ...extra]` `toEqual` the result over `stack` (each with its own `exclusionOf`).
   - **P4** a fixed level set over basedirs `a`, `a/b`, `c`, `c/d` plus a root level (rules from
     `arbRuleLines`), and a list of 1–5 query paths under them. Build two stacks: base first, then
     the other levels in a random permutation stably sorted by depth (ancestor before descendant).
     Property: for each query, both stacks give the same `verdict`, `ruleIndex` and level `basedir`
     — also when the query list is permuted (`fc.shuffledSubarray` with full length).
5. REFACTOR: functions under 20 lines, named constants for digit/letter alphabets in
   arbitraries.ts, no magic numbers in rows beyond the rule index.

### Gate

`npx vitest run test/unit/domain/ignore && npm run check:types && ./node_modules/.bin/biome check src/domain/ignore/matcher-stack.ts test/unit/domain/ignore/matcher-stack.test.ts test/unit/domain/ignore/matcher-stack.properties.test.ts test/unit/domain/ignore/arbitraries.ts && npm run check:spelling`

Coverage (100%, src/domain is in the include set) is the phase gate's `npm run test:coverage`; a
subset run with `--coverage` trips the global thresholds, so do not use it as a part check.

### Commit

`fix(ignore): add git's leading-directory exclusion rule as pure matcher-stack functions`

## Part 2 — One ignore session behind the per-path primitive (R1–R5, R8; ADR-1271, ADR-1272, ADR-1275, ADR-1276)

### Context

Files this part edits or creates:
- `src/application/primitives/internal/ignore-evaluator.ts`
- `src/application/primitives/is-ignored.ts`
- `test/unit/application/primitives/is-ignored.test.ts`
- `test/integration/is-ignored-leading-directory-interop.test.ts` (new)
- `test/integration/posix-only/ignored-leading-directory-unreadable-gitignore-interop.test.ts` (new)

Behaviour: `isIgnored` answers every Matrix A row as `git check-ignore -v --no-index` does, and
never reads a .gitignore at or beneath an excluded directory (X1–X3 stop throwing / start
matching). `buildRepoIgnorePredicate` is NOT changed here (Part 3), so no pre-flight or walk
caller moves.

ignore-evaluator.ts today: `interface IgnoreEvaluator { base: ReadonlyArray<IgnoreLevel>; loadDirRules: (dir: FilePath | '') => Promise<IgnoreRuleset> }`;
`buildIgnoreEvaluator(ctx)` (reads `core.ignoreCase` once through `readConfig`, builds `base` =
global → info → root, `loadDirRules` caches per directory and maps an absent file to `[]`);
`buildRepoIgnorePredicate(ctx)` (its own stack + `stackedDirs` + private `ancestorsOf`) — leave
both untouched. Add, between them (imports: `directoryExclusion`, `leadingDirectoriesOf`,
`matchBeneathLeadingDirectories`, type `VerboseMatch` from ../../../domain/ignore/matcher-stack.js
— by path, not the barrel):

```ts
/** One ignore judgement for a command: rules read lazily, one verdict per leading directory. */
export interface IgnoreSession {
  /** git's verdict for one path, with the rule that decided it. */
  readonly match: (path: FilePath, isDirectory: boolean) => Promise<VerboseMatch>;
}

interface SessionState {
  readonly evaluator: IgnoreEvaluator;
  readonly stack: IgnoreLevel[];
  readonly entered: Map<FilePath, Promise<VerboseMatch | undefined>>;
  readonly resolved: Map<FilePath, VerboseMatch | undefined>;
}
```

Module-level helpers over `SessionState` (each under 20 lines; names fixed so Part 3 and the
reviewer can find them):
- `pushDirRules(state, directory): Promise<void>` — `const rules = await state.evaluator.loadDirRules(directory);`
  `if (rules.length > 0) state.stack.push({ basedir: directory, rules, kind: 'gitignore' });` (PC-2: no disable comment).
- `enterDirectory(state, directory): Promise<VerboseMatch | undefined>` —
  `const exclusion = directoryExclusion(state.stack, directory);` then
  `if (exclusion === undefined) await pushDirRules(state, directory);` (an excluded directory's
  .gitignore is never read), `state.resolved.set(directory, exclusion)`, return it.
- `rememberEntry(state, directory)` — `const entry = enterDirectory(state, directory); state.entered.set(directory, entry); return entry;`
  (the promise is stored before it settles, so two overlapping calls share one `enterDirectory`).
- `exclusionOf(state, directory)` — `state.entered.get(directory) ?? rememberEntry(state, directory)` (PC-1).
- `settleLeadingDirectories(state, path): Promise<void>` — root-first over
  `leadingDirectoriesOf(path)`, `if ((await exclusionOf(state, directory)) !== undefined) return;`.
- `export const createIgnoreSession = async (ctx: Context): Promise<IgnoreSession>` — builds the
  state from `await buildIgnoreEvaluator(ctx)` (`stack: [...evaluator.base]`, two empty maps) and
  returns `{ match: async (path, isDirectory) => { await settleLeadingDirectories(state, path); return matchBeneathLeadingDirectories(state.stack, path, isDirectory, (d) => state.resolved.get(d)); } }`.

Why `resolved` is always filled for what the domain loop asks: the settle loop and the domain loop
walk the same root-first list and both stop at the first exclusion (design §2). Memo soundness and
order independence: design §2 / ADR-1275 (a directory's verdict depends only on its proper
ancestors' levels and the base, all pushed before its first entry).

is-ignored.ts today (114 lines): header comment (lines 1–10, mentions "loads per-directory
.gitignore rules lazily along each query path's ancestor chain"), types `IsIgnoredQuery`,
`IsIgnoredMatchSource`, `IsIgnoredMatch` (unchanged — R8), private `ancestorsOf` (with three
Stryker comments), and `isIgnored(ctx, queries)`: abort check, `queries.length === 0` → `[]`,
`buildIgnoreEvaluator`, `stack`, `stackedDirs`, closure `ensureAncestorRules`, then per query an
abort check, `ensureAncestorRules`, `matchInStackVerbose(stack, query.path, isDir)` and the
`VerboseMatch` → `{ path, ignored, source? }` mapping (with the `rule === undefined` guard and its
`BooleanLiteral` comment). Change to: delete `ancestorsOf` and `ensureAncestorRules` (and their
comments) and the now-unused imports (`IgnoreLevel`, `IgnoreRuleset`, `matchInStackVerbose`,
`buildIgnoreEvaluator`); `const session = await createIgnoreSession(ctx);` after the empty-queries
return; per query keep the abort check, then `const match = await session.match(query.path, query.isDirectory === true);`
and the unchanged mapping. REFACTOR extracts the mapping into `toIgnoredMatch(path, match): IsIgnoredMatch`
so `isIgnored` drops under 20 lines. Rewrite the header's "lazily" sentence: rules are read only on
the chain above the first excluded leading directory, whose rule then decides.

Unit test file today: helpers `path(p)`, `seedRepo(homeDir?)` (memory context + HEAD), an
`afterEach(() => __resetConfigCacheForTests())` (src/application/primitives/config-read.js);
config is written to ${ctx.layout.gitDir}/config; rules with ctx.fs.writeUtf8. Existing
describes (keep green, unchanged): ignorecase rows, provenance rows, negation, directory-only,
info/global kinds, empty queries "without touching the fs", order preservation, three abort rows
("a signal aborted during buildIgnoreEvaluator" aborts on the root .gitignore read — still the
evaluator's read inside `createIgnoreSession`). Oversized file: `'x'.repeat(MAX_GITIGNORE_BYTES + 1)`
with `MAX_GITIGNORE_BYTES` from src/application/primitives/types.js (1 MiB). A directory at a
path: ctx.fs.mkdir(abs) (creates parents). Error shape: `TsgitError` (src/domain/error.js),
data.code `'GITIGNORE_FILE_TOO_LARGE'` with data.path (basename, .gitignore), data.size,
`data.limit`.

Matrix A in memory (rules → query → expected `source` as `{ kind, basedir, line, pattern }`, or
not ignored). `dir` = query with `isDirectory: true`. Same expectation under both ignorecase values
unless stated:

| row | rule files | query | expected |
|---|---|---|---|
| A1 / A2 | root "ab" | ab/c · ab | gitignore '' 1 "ab" (both) |
| B1 / B2 / B3 | root "ab/" | ab/c · ab dir · ab/c/d | gitignore '' 1 "ab/" |
| C1 | root "ab/", "!ab/c" | ab/c | gitignore '' 1 "ab/" |
| D1 / D2 | root "ab/"; ab/.gitignore "!c" | ab/c · ab/.gitignore | gitignore '' 1 "ab/" |
| E1 / E2 | root "ab/", nothing at ab | ab/c · ab (file query) | 1 "ab/" · not ignored |
| F1 / F2 / F3 | root "x/y/" | x/y/z/w · x/y/z · x/q | 1 "x/y/" · 1 "x/y/" · not ignored |
| G1 | root "ab/", "!ab/" | ab/c | not ignored |
| H1 | root "*", "!ab/" | ab/c | gitignore '' 1 "*" |
| I1 | root "ab", "*.log" | ab/x.log | gitignore '' 1 "ab" |
| J1 | a/.gitignore "b/" | a/b/c | gitignore 'a' 1 "b/" |
| K1 | info/exclude "ab/" | ab/c | info '' 1 "ab/" |
| L1 | root "AB/" | ab/c | false: not ignored · true: gitignore '' 1 "AB/" |
| N1 | root "a/b/"; a/.gitignore "!b/" | a/b/c | not ignored |
| O1 | root "a/"; a/.gitignore "!b/", "!b/c" | a/b/c | gitignore '' 1 "a/" |
| P1 / P2 | root "ab/*", "!ab/c" | ab/c · ab/d | not ignored · gitignore '' 1 "ab/*" |
| Q1 / Q2 | root "ab/", a FILE at ab | ab/c · ab | 1 "ab/" · not ignored |
| R1 / R2 | root "**/build/" | p/build/o/f · p/build dir | gitignore '' 1 "**/build/" |
| S1 | core.excludesFile → a file under the git dir holding "ab/" | ab/c | global '' 1 "ab/" |

S1 config: `[core]\n\tignorecase = <v>\n\texcludesfile = ${ctx.layout.gitDir}/global-excludes\n`
(readGlobalExcludes in src/application/primitives/internal/read-gitignore.ts reads the configured
path; the existing "global excludes" rows use ~/global with seedRepo('/repo/home') — either works).

Interop file 1 (is-ignored-leading-directory-interop.test.ts), modelled on
test/integration/glob-bracket-class-interop.test.ts (read-only: `writeIgnoreRepo`, `gitCheckIgnore`,
`verboseMatches`, the `@proves` header, `beforeAll` realpath'd `mkdtemp` root, `afterAll` rm):
- Header: `@proves` with `surface: isIgnored`, `bucket: cross-tool-interop`, a `unique:` line of
  12–200 chars ("a path beneath an excluded leading directory reports that directory's rule as git check-ignore does under both core.ignorecase values"),
  `interopSurface: isIgnored` (the write-surfaces audit is warn-only; the glob precedents name
  non-write surfaces the same way).
- Row type `{ title, files: Record<string, string>, directories?: string[], excludesFile?: string, query }`
  — `files` holds every rule file and every on-disk file (a .git/info/exclude key is allowed and
  written after `git init`); `excludesFile` is written to <repo>/.git/global-excludes and set with
  `git config core.excludesFile <that absolute path>`. The table is Matrix A (28 rows, fixtures as in
  the unit table; on-disk: the query path exists as a file unless the row says otherwise — E1/E2
  create nothing at ab, Q1/Q2 a file at ab, B2/R2 query an existing directory) plus X1
  (ab/.gitignore oversized under root "ab/", query ab/c) and X3 (a directory at ab/.gitignore,
  query ab/c). Titles describe behaviour, no row ids.
- Per row: `runGit(['init', '-q', '-b', 'main', repo])`, `git(repo, 'config', 'core.ignorecase', v)`,
  write the files; git side `tryRunGitWithExit(['-C', repo, 'check-ignore', '-v', '-z', '--no-index', '--', query])`
  (exit 0 matched, 1 none, > 1 → throw with stderr); fields `source\0line\0pattern\0path\0`. Expected:
  `ignored` = exit 0 and the pattern does not start with `!`; `verbose` = the string
  source + ':' + line + ':' + pattern when ignored, else `undefined`.
  tsgit side: `isIgnored(createNodeContext({ workDir: repo }), [{ path: query, isDirectory: lstatSync(join(repo, query), { throwIfNoEntry: false })?.isDirectory() === true }])`;
  rebuild the source file from `{ kind, basedir }`: `gitignore` → .gitignore when basedir is empty,
  else basedir + '/.gitignore';
  `info` → .git/info/exclude, `global` → the configured excludesFile string. Compare the two
  objects with `toEqual`. `describe.skipIf(!GIT_AVAILABLE)` outer, then
  `describe.each(['false', 'true'])('Given core.ignorecase is %s', …)` >
  `describe('When … is asked about …')` > `it.each(ROWS)('Then … as git check-ignore reports', …)`.
  If git prints the excludes file under another spelling than the configured string, compare
  against git's printed spelling for that kind only and say so in the handback.

Posix-only file (`test/integration/posix-only/ignored-leading-directory-unreadable-gitignore-interop.test.ts`),
modelled on test/integration/posix-only/rev-parse-unreadable-fanout-interop.test.ts (read-only:
`const IS_ROOT = process.getuid?.() === 0;`, `describe.skipIf(!GIT_AVAILABLE || IS_ROOT)(…)`,
`chmod` restore before cleanup). Header `@proves` with `surface: isIgnored` (Part 3 adds
`repo.checkout`), `bucket: platform-only`, a `unique:` line, NO `interopSurface` (forbidden outside
`cross-tool-interop`). Row X2: root "ab/", ab/c on disk, ab/.gitignore at mode 000
(`chmodSync(…, 0o000)`); both values; git `check-ignore -v -z --no-index -- ab/c` vs `isIgnored`,
same comparison as file 1 (no throw, .gitignore:1:ab/). `afterEach` restores `0o644` then removes
the root. This directory is NOT part of `npm run validate`; run it with
`./node_modules/.bin/vitest run --project posix-integration test/integration/posix-only/ignored-leading-directory-unreadable-gitignore-interop.test.ts`
(CI job `posix-integration` runs `npm run test:posix-integration`).

Mutation hot spots this part owns:
- `enterDirectory`'s `exclusion === undefined` guard (ConditionalExpression `true` reads the
  excluded directory's own .gitignore): the oversized ab/.gitignore row (throws if read). Do not
  rely on D1 for it — the verdict is the same.
- `settleLeadingDirectories`' early `return` (ConditionalExpression `false` enters ab/x beneath an
  excluded ab): the deeper row — root "ab/", ab/x/.gitignore oversized, query ab/x/y.
  ConditionalExpression `true` / EqualityOperator: J1 and the nested-rule rows (a depth-2 level is
  never loaded).
- `exclusionOf`'s `??` (LogicalOperator `&&`): every nested-.gitignore row (J1, D1-type).
- `pushDirRules`' `rules.length > 0`: `false` / `<=` killed by J1; `true` / `>=` equivalent (PC-2 —
  record in the handback, no comment).
- `isDirectory === true`: B2 / R2 dir rows vs E2 file row.

### TDD steps

Every RED below fails against the starting code (Part 1 landed, `isIgnored` still on its old
loop); write all four, run them red, then the one GREEN.

1. RED unit Matrix A (is-ignored.test.ts, new `describe.each(['false', 'true'])('Given core.ignorecase is %s', …)`
   > `describe('When isIgnored is asked about a path beneath its rule files')` >
   `it.each(ROWS)('Then $title')`, each row carrying `expected` and an optional `expectedFolded`
   for L1). Fails on the 22 diverging rows: today's loop reports "not ignored" (or line 2 for I1).
   The agreeing rows (A2, B2, E2, F3, G1, H1, N1, P1, P2, Q2, R2) pass inside the same table — expected.
2. RED unit faults (same file, `describe('Given a rule excluding ab and a .gitignore inside ab that cannot be read as rules')`):
   - ab/.gitignore oversized, query ab/c → ignored by `.gitignore` line 1 `ab/`, no throw (today:
     throws `GITIGNORE_FILE_TOO_LARGE`);
   - a directory at ab/.gitignore, query ab/c → ignored (today: not ignored);
   - ab/x/.gitignore oversized, query ab/x/y → ignored by line 1 `ab/`, no throw (today: throws).
3. RED interop file 1 (all rows, both values): fails on the 22 diverging rows and X1 (throws) / X3
   (not ignored), as the unit table does.
4. RED posix X2 file: fails today with `PERMISSION_DENIED` thrown by `isIgnored` (run it with the
   posix command; it skips as root — say so in the handback if the machine runs as root).
5. GREEN: `createIgnoreSession` and its helpers in ignore-evaluator.ts, `isIgnored` on it. Run
   steps 1–4 green.
6. GUARD X4 (passes before and after: the directory is not excluded, so its file is read): no root
   rule, ab/.gitignore oversized, query ab/c → throws `GITIGNORE_FILE_TOO_LARGE` with
   `data.path === '.gitignore'`, `data.size === MAX_GITIGNORE_BYTES + 1`,
   `data.limit === MAX_GITIGNORE_BYTES` (ADR-036 stays; kills a "never read" mutant).
7. GUARD order rows (R5; pass before and after — a verdict is a function of the path's chain):
   root "ab/": `[ab/c, ab dir]` and `[ab dir, ab/c]` give the same per-path results; a/.gitignore
   "*.log" and a/b/.gitignore "!keep.log": `[a/x.log, a/b/keep.log, a/b/c.log]` and its reverse give
   identical per-path `ignored` and `source`. Hand-verify PC-1's claim on this row: temporarily
   make `exclusionOf` always call `rememberEntry(state, directory)` (memo off), run, see green,
   revert; record it in the handback.
8. REFACTOR: extract `toIgnoredMatch`; every new function under 20 lines; the header of
   is-ignored.ts and the doc of `buildIgnoreEvaluator` ("the caller (typically
   `buildRepoIgnorePredicate`) loads them on demand") stay true or are reworded.

### Gate

`npx vitest run test/unit/application/primitives/is-ignored.test.ts test/unit/application/commands/internal/build-ignore-evaluator.test.ts test/unit/application/primitives/index.test.ts test/unit/repository/repository.test.ts test/integration/is-ignored-leading-directory-interop.test.ts test/integration/glob-bracket-class-interop.test.ts test/integration/glob-double-star-interop.test.ts test/integration/gitignore-end-to-end.test.ts && ./node_modules/.bin/vitest run --project posix-integration test/integration/posix-only/ignored-leading-directory-unreadable-gitignore-interop.test.ts && ./node_modules/.bin/vitest run --project parity && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/ignore-evaluator.ts src/application/primitives/is-ignored.ts test/unit/application/primitives/is-ignored.test.ts test/integration/is-ignored-leading-directory-interop.test.ts test/integration/posix-only/ignored-leading-directory-unreadable-gitignore-interop.test.ts && npm run check:spelling && npm run check:test-pyramid`

### Commit

`fix(ignore): stop the per-path ignore check at the first excluded leading directory as git does`

## Part 3 — The shared predicate runs on the session (R4, R6, R7, R8; ADR-1273, ADR-1274, ADR-1276)

### Context

Files this part edits or creates:
- `src/application/primitives/internal/ignore-evaluator.ts`
- `test/unit/application/commands/internal/build-ignore-evaluator.test.ts`
- `test/unit/application/primitives/internal/occupant-clash.test.ts`
- `test/unit/application/primitives/apply-changeset.test.ts`
- `test/integration/ignored-leading-directory-occupant-interop.test.ts` (new)
- `test/integration/posix-only/ignored-leading-directory-unreadable-gitignore-interop.test.ts`

Behaviour: `buildRepoIgnorePredicate(ctx)` becomes
`const session = await createIgnoreSession(ctx); return async (path, isDirectory) => (await session.match(path, isDirectory)).verdict === 'ignored';`.
Delete its stack, `stackedDirs`, loop and the private `ancestorsOf` (with all their Stryker
comments) and the imports that become unused (`matchInStack`, `IgnoreRuleset` if unused). Rewrite
its doc: one session per predicate; a path beneath an excluded directory is ignored and nothing at
or beneath that directory is read. `createIgnoredProbe` (src/application/primitives/internal/occupant-clash.ts,
read-only) is NOT edited: it wraps `buildRepoIgnorePredicate` in `lazily` + a one-at-a-time limiter
and its comment stays true. The predicate keeps its name, signature (`IgnorePredicate` from
./ignore-predicate.js: `(path, isDirectory) => boolean | Promise<boolean>`) and module, so the
existing spies in apply-changeset.test.ts (`vi.spyOn(ignoreEvaluatorMod, 'buildRepoIgnorePredicate')`
— "never read for the deleted files", "built once for the clash check and once for the clearing")
stay green.

Consumers that flip through the probe (read-only): occupant-clash.ts `classifyAddedPath`,
`holdsSurvivor` / `childSurvives`, `classifyLeadingObstruction`; apply-changeset.ts clash scope
(`ignoredOccupants === 'protect' ? NEVER_IGNORED : createIgnoredProbe(ctx)`), `clearOccupants` →
`clearDirectoryAt` → `removeIgnoredBelow` (policy `'ignored'` removes every ignored child recursively);
find-would-overwrite.ts (merge, cherry-pick, revert, stash apply); merge.ts
`displaceIgnoredLeadingFiles` (true merge only); reset-worktree.ts (`untrackedOccupants: 'protect'`:
rebase abort/skip, merge abort). Walk callers that must not move (R7): status.ts
(`pruneGitlinkDirectories`), stash.ts `listUntracked` (`gitlinkPrunedIgnore`), add.ts (`collectIgnored`,
`splitIgnoredLiterals`, `firstIgnoredAncestorOf`) — the walk (walk-working-tree.ts `stepEntry`)
skips a directory the predicate calls ignored before entering it, so every path it asks has had
each leading directory answered "no" (design Context proof).

Unit files:
- build-ignore-evaluator.test.ts: imports `buildIgnoreEvaluator`, `buildRepoIgnorePredicate` from
  the shim src/application/commands/internal/build-ignore-evaluator.ts; helper `seed(homeDir?)`;
  `afterEach(() => __resetConfigCacheForTests())`; `describe('buildRepoIgnorePredicate')` at line 135.
- occupant-clash.test.ts: helpers `path`, `BYTES`, `scopeOf(ctx, { removed?, ignored?, ignoredAsDirectory?, tracked? })`
  (a FAKE probe), `classify(ctx, target, scope, mode?)` → `classifyOccupant(ctx, { kind: 'add', path, mode }, scope)`,
  `classifyChange`; config via `invalidateConfigCache(ctx)`. Add a `realScopeOf(ctx)` helper:
  `{ ...scopeOf(ctx), isIgnoredPath: createIgnoredProbe(ctx) }` (import `createIgnoredProbe` and
  `holdsSurvivor` from occupant-clash.ts). Rules: ctx.fs.writeUtf8(${ctx.layout.workDir}/.gitignore`, …)`.
- apply-changeset.test.ts: `buildSeededContext` (from ./fixtures.js), `writeBlob`, `makeAdd`,
  `makeDelete`, `makeChangeset`, `outcomeOf`, `enc`/`dec`, `WORKDIR = '/repo'`; model rows at
  "Given a directory d holding only ignored files and a deleted tracked file, replaced by a file d"
  and the refusing twin after it (~lines 761–812).

Occupant interop file (ignored-leading-directory-occupant-interop.test.ts). Model:
test/integration/gitlink-removal-occupant-interop.test.ts (read-only: `initTwin`, `commit` with
`COMMIT_ENV`, `runGitTwin`, `runTsgitTwin` opening `openRepository({ cwd })` from
src/index.node.js and disposing it, `compareTwins`, `describe.each(['false', 'true'] as const)`,
`makePeerPair` per row in `beforeEach`/`afterEach`). Reuse from test/integration/occupant-displacement-fixtures.ts:
`COMMIT_ENV`, `listing(dir)` (sorted `rel=content` / rel/ / `rel@->target` lines, .git excluded),
`outcomeOfGitStderr`, `tsgitOutcomeOf(run, dirtyCode)`.
- Header `@proves`: `surface: repo.checkout, repo.merge.run, repo.merge.abort, repo.cherryPick.run, repo.revert.run, repo.rebase.run, repo.rebase.abort, repo.rebase.skip, repo.stash.apply`,
  `bucket: cross-tool-interop`, a `unique:` line (≤ 200 chars), `interopSurface: checkout`.
- Both twins are built by git (`initTwin` sets ignorecase, user, `commit.gpgsign false`). Every
  shape commits .gitignore (the row's rules, possibly empty) and `f` = `base\n` in the base
  commit; a path the rules ignore is staged with `git add -f`. The occupant is `mine\n`; theirs is
  `theirs\n`.
- Snapshot per twin: `{ succeeded, refusal, branch: symbolic-ref --short -q HEAD, headTree: rev-parse HEAD^{tree}, inProgress: .git/rebase-merge or .git/MERGE_HEAD exists, files: listing(dir) }`.
  `refusal`: git → `outcomeOfGitStderr(stderr)` for checkout and merge rows, else `undefined`;
  tsgit → `tsgitOutcomeOf` with the command's dirty code for checkout (`CHECKOUT_OVERWRITE_DIRTY`)
  and merge (`WORKING_TREE_DIRTY`), else the thrown `TsgitError`'s data.code checked against the
  code the command throws on the starting code for the no-rule row (run the GUARD rows first and pin the observed
  code in the row table — it must be an overwrite refusal such as `WORKING_TREE_DIRTY` or
  `STASH_APPLY_WOULD_OVERWRITE`; any other code is a blocker). Compare `succeeded`, `branch`,
  `headTree`, `inProgress` and `files` with `toEqual`; compare refusal paths where both sides carry them.
- Shapes and commands (rules: `0` = empty, `1` = "ab/", `2` = "ab", `3` = "ab/c", `4` = "ab/" then
  "!ab/c"; `6` = empty, `7` = "ab/c" (T) or "ab/c" + "ab/sub/d" (V); Z: `0` empty, `1` "x/", `3` "x/ab"):

| shape | built as | commands (git · tsgit) | rules |
|---|---|---|---|
| added file | `other` = base + ab/c (theirs); on main an untracked ab/c | `checkout other` · `repo.checkout({ rev: 'other' })`; `merge other` (ff) · `repo.merge.run({ rev: 'other' })` | checkout 0–4; merge-ff 0, 1, 3, 4 |
| added file, diverged | as above plus a main commit adding g | `merge --no-edit other` · `repo.merge.run({ rev: 'other' })`; `cherry-pick other` · `repo.cherryPick.run({ commits: ['other'] })`; `rebase other` · `repo.rebase.run({ upstream: 'other' })` | 0, 1, 3, 4 |
| re-added file | main: base, a commit adding ab/c, a commit removing it; untracked ab/c | `revert --no-edit HEAD` · `repo.revert.run({ commits: ['HEAD'] })` | 0, 1, 3, 4 |
| stashed add | main: `git add -f ab/c` (theirs), `git stash push`; untracked ab/c | `stash apply` · `repo.stash.apply()` | 0, 1, 3, 4 |
| directory becomes a file | `other` = base + a FILE ab; main holds untracked ab/c (T) or ab/c and ab/sub/d (V) | checkout (T: 1, 6, 7); diverged `merge --no-edit other` and `cherry-pick other` (V: 1, 6, 7 for merge; 1, 6 for cherry-pick) | as listed |
| leading file | `other` = base + x/ab/c; main holds an untracked FILE x/ab | `checkout other`; diverged `merge --no-edit other` | Z 0, 1, 3 |
| oversized nested rule file | added-file shape, rules 1, plus an untracked ab/.gitignore of `MAX_GITIGNORE_BYTES + 1` bytes (constant from src/application/primitives/types.js) | `checkout other` | 1 |
| rebase abort | base tracks f and ab/c; `up` removes ab/c and edits f; main edits f; each tool rebases main onto up to the stop (PC-4); then an untracked ab/c | `rebase --abort` · `repo.rebase.abort()` | 0, 1, 3, 4 |
| rebase skip (pin) | base tracks f and ab/c; `up` edits f; main's commit removes ab/c and edits f; each tool rebases to the stop; untracked ab/c | `rebase --skip` · repo.rebase.skip() | 0, 1 |
| merge abort (pin) | base tracks f and ab/c; `other` removes ab/c and edits f; main edits f; each tool merges to the stop; untracked ab/c | `merge --abort` · `repo.merge.abort()` | 0, 1 |

  Exact `RebaseRunInput` / `MergeRunInput` / `CherryPickRunInput` / `RevertRunInput` /
  `StashApplyInput`: src/application/commands/{rebase,merge,cherry-pick,revert,stash}.ts
  (`upstream`, `rev`, `commits`, optional index). How tsgit reports a stop (returned result vs
  thrown error) for rebase.run / merge.run: read `RebaseResult` / `MergeResult` before writing
  the abort shapes, and assert the stop state equal across twins (`inProgress`, conflicted `f`)
  before laying the occupant.
- Row ids stay out of titles: e.g. `Then checkout over an untracked file beneath an excluded directory ends as git ends`.
- **Pins (ADR-1274).** `merge.abort` and rebase.skip were never run against git. Before writing
  their rows, run each shape against git in a `mktemp -d` probe script (both ignorecase values,
  twice). If git's outcome is not "overwrites ab/c under the ab/ rule, refuses with no rule",
  STOP and hand back `{ unit: 'Part 3 pins', reason: <git's exit, stderr, final listing>, options }`
  — never bend the row or the shape.
- Posix-only file (created in Part 2): add row X2 for checkout — added-file shape, rules 1, an
  untracked ab/.gitignore at mode 000; git `checkout other` vs `repo.checkout({ rev: 'other' })`
  (both overwrite ab/c and switch); add `repo.checkout` to its `surface:` line. Restore the mode in
  `afterEach`.

Mutation: the predicate body has one comparison (`=== 'ignored'`) killed by every predicate row;
the session's mutants are Part 2's. No equivalent comment is added in this part.

### TDD steps

1. RED predicate rows (build-ignore-evaluator.test.ts `describe('buildRepoIgnorePredicate')`, one
   `it` each): root "ab" → `ab/c` file true; root "ab/" → `ab/c` true; root "ab/", "!ab/c" → `ab/c`
   true; root "ab/" + ab/.gitignore "!c" → `ab/c` true; root "ab/" + oversized ab/.gitignore →
   `ab/c` true, no throw (today: false, false, false, false, throws). Probe-order row: with root
   "ab/" and ab/.gitignore "!c", ask `ab/c` (file) BEFORE `ab` (directory) → both true.
2. RED consumer unit rows (with the real probe):
   - occupant-clash.test.ts: `Given an untracked file beneath a directory the rules exclude` →
     `classify(ctx, 'ab/c', realScopeOf(ctx))` → `{ kind: 'clear' }` (today: untracked clash at ab/c);
     twin with no rule → `{ kind: 'clash', clash: { class: 'untracked', path: 'ab/c' } }` (GUARD);
     `holdsSurvivor(ctx, abs('ab'), realScopeOf(ctx))` over ab/c and ab/sub/d under "ab/" → false
     (today true), no-rule twin → true (GUARD); a FILE at x/ab and `classify(ctx, 'x/ab/c', realScopeOf(ctx))`
     under "x/" → clear (today: untracked at x/ab), no-rule twin → untracked at x/ab (GUARD).
   - apply-changeset.test.ts: `Given an untracked directory ab holding c and sub/d under a rule excluding ab, replaced by a file ab`
     → `applyChangeset(ctx, { changeset: makeChangeset([makeAdd('ab', newId)]), force: false, workdir: WORKDIR })`
     writes the file (`dec(read(ab)) === 'file'`), and ab/c, ab/sub/d are gone (today: refuses
     `CHECKOUT_OVERWRITE_DIRTY` with `untracked: ['ab']`); GUARD twin under rule "ab/c" only
     (ab/sub/d unignored) → refuses with `untracked: ['ab']` and keeps `ab/sub/d`.
3. RED occupant interop file (table-driven, one RED entry): write the scaffold and every row; run
   it; the GUARD rows (rules 0, 3, 6, 7, Z0, Z3) pass on the starting code and the rule rows
   (1, 2, 4, T5, V1, Z1, X1, Y1, Y4, and the two pins' rule-1 rows if git overwrites) fail with
   tsgit refusing where git succeeds. Pins first (probe, see Context).
4. RED posix X2 checkout row: fails today with `PERMISSION_DENIED`.
5. GREEN: the predicate body above. Run steps 1–4 green.
6. GUARD walk callers (R7, no edit): the full gate below (status, add, stash, sparse, checkout,
   merge, rebase, cherry-pick, revert unit and interop suites unchanged). A red here is a design
   defect: STOP and hand back with the failing row, never adjust the suite.
7. REFACTOR: drop dead imports in ignore-evaluator.ts; doc comments true.

### Gate

`npx vitest run test/unit/application test/unit/domain/ignore test/integration/ignored-leading-directory-occupant-interop.test.ts test/integration/is-ignored-leading-directory-interop.test.ts && ./node_modules/.bin/vitest run --project integration ignore glob occupant status stash add- sparse checkout merge rebase cherry revert && ./node_modules/.bin/vitest run --project posix-integration test/integration/posix-only/ignored-leading-directory-unreadable-gitignore-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/ignore-evaluator.ts test/unit/application/commands/internal/build-ignore-evaluator.test.ts test/unit/application/primitives/internal/occupant-clash.test.ts test/unit/application/primitives/apply-changeset.test.ts test/integration/ignored-leading-directory-occupant-interop.test.ts test/integration/posix-only/ignored-leading-directory-unreadable-gitignore-interop.test.ts && npm run check:spelling && npm run check:test-pyramid`

### Commit

`fix(ignore): read an occupant beneath an excluded directory as ignored in every pre-flight`

## Part 4 — Bench pair for the ignore session (R7 cost half; ADR-1273, D-7)

### Context

Files this part edits or creates (no src/ delta):
- `test/bench/ignore-leading-directory.bench.ts` (new)
- `test/bench/support/ignore-rules.ts` (new)
- `test/bench/ignore-match.bench.ts`

Move ignore-match.bench.ts's `RULES_PLAIN` array (40 rules, lines 35–76) verbatim into
ignore-rules.ts as `export const IGNORE_RULES_PLAIN: ReadonlyArray<string>` and import it back in
ignore-match.bench.ts (`RULES_CLASS` and `RULES_FLOOR` keep deriving from it; titles unchanged).
Never import one bench file from another — vitest would register its scenarios twice.

New bench (model, read-only: test/bench/ignore-match.bench.ts and test/bench/status-racy-window.bench.ts;
`benchScenario(given, whenThen, build)` in test/bench/support/bench-dsl.ts — build returns
`{ sut, teardown? }`; vitest bench hooks do not run here, so all per-iteration state is created
inside `sut`):
- Header comment: the session answering a walk against the same entries matched over the loaded
  rules plus one directory match per distinct directory — the work no leading-directory rule can
  avoid; tsgit-only, no baseline library.
- Fixture (named constants `PACKAGE_COUNT = 20`, `LIBRARIES_PER_PACKAGE = 10`,
  `FILES_PER_LIBRARY = 100`, the `EXTENSIONS` list of ignore-match): entries in walk order —
  for each package `pkg<p>` (as a directory), for each library pkg<p>/lib<m> (as a directory),
  then its 100 files pkg<p>/lib<m>/file<k>.<ext>. Directory names are chosen so no rule of
  `IGNORE_RULES_PLAIN` excludes a directory (a walk never asks beneath an excluded one); check it
  once with `matchInStack(base, dir, true) !== 'ignored'` in the build and throw a descriptive
  `Error` if a name collides. A memory context (`createMemoryContext()` from
  src/adapters/memory/memory-adapter.js) with ${gitDir}/HEAD and ${workDir}/.gitignore =
  the rules joined by `\n`.
- Row `Given 20200 walked entries in 200 directories two levels deep` / `When the ignore session answers each in walk order, Then measure tsgit alone`:
  `sut` builds a fresh `await buildRepoIgnorePredicate(ctx)` (src/application/primitives/internal/ignore-evaluator.js)
  and awaits it for every entry (`isDir` per entry); keep a tally of ignored answers.
- Floor twin `… / When each entry and each distinct directory is matched once over the loaded rules, Then measure tsgit alone`:
  `sut` builds `await buildIgnoreEvaluator(ctx)`, then `matchInStack(evaluator.base, entry.path, entry.isDir)`
  per entry plus `matchInStack(evaluator.base, dir, true)` per distinct directory (220), same tally.
- Both rows in one file = one process. Not registered in docs/perf/hot-paths.json.

Measuring protocol (ADR-1273, lesson 056) — the numbers go into the handback; the session records
them in the design:
1. Quiet machine first: `uptime` load average below 16 and `pgrep -fl 'stryker|vitest'` shows no
   foreign run. Otherwise wait; never measure under load.
2. PC-5: add a temporary third scenario — the row's `sut` plus, per file, one
   `directoryExclusion(evaluator.base, d)` per leading directory d (a session that re-tests each
   entry's chain). Not committed.
3. Run three times, each to its own scratch file:
   `./node_modules/.bin/vitest bench --run --config vitest.bench.config.ts test/bench/ignore-leading-directory.bench.ts > <scratch>/ignore-bench-<n>.txt 2>&1`;
   read the mean of each row. Ratio_fix = row / twin, ratio_defect = defect / twin, per run.
4. Gate = a value strictly between the largest ratio_fix and the smallest ratio_defect (the
   midpoint rounded to one decimal). If no gap exists (any ratio_fix ≥ any ratio_defect) or the gap
   is under 0.3, STOP and hand back through the blocker protocol — never tune the fixture toward a
   gate.
5. Remove the temporary scenario; re-run once to confirm the two committed rows report a mean.
6. Handback: the three ratio_fix, the three ratio_defect, the gate, `uptime` at start and end,
   machine, Node and git versions.

### TDD steps

1. Extract `IGNORE_RULES_PLAIN`; GUARD: `./node_modules/.bin/vitest bench --run --config vitest.bench.config.ts test/bench/ignore-match.bench.ts`
   still reports its three rows with the same titles.
2. Write the bench file; GUARD: one run completes with both rows reporting a mean and a non-zero
   tally (the row and the twin agree on the tally — assert it once in a throwaway check, since the
   predicate and `matchInStack` must answer the same on this fixture).
3. Measure per the protocol above.
4. REFACTOR: functions under 20 lines, named constants, no magic numbers.

### Gate

`npx vitest bench --run --config vitest.bench.config.ts test/bench/ignore-leading-directory.bench.ts test/bench/ignore-match.bench.ts && npm run check:types && ./node_modules/.bin/biome check test/bench/ignore-leading-directory.bench.ts test/bench/support/ignore-rules.ts test/bench/ignore-match.bench.ts && npm run check:spelling`

### Commit

`test(bench): time the ignore session against a same-process floor twin`

## Part 5 — One outcome per directory chain in the session (R7 cost half; ADR-1278, ADR-1273)

Added after Parts 1–4 landed: the session of Part 2 costs 1.37 to 1.63 times main's predicate
on a walk (design §10). This part changes how the session remembers, not what it answers:
every existing unit, property and interop row is a GUARD and must stay green unchanged, apart
from the rows of the two functions it replaces.

### Context

Files this part edits:
- `src/domain/ignore/matcher-stack.ts`
- `src/application/primitives/internal/ignore-evaluator.ts`
- `test/unit/domain/ignore/matcher-stack.test.ts`
- `test/unit/domain/ignore/matcher-stack.properties.test.ts`
- `test/unit/domain/ignore/arbitraries.ts`
- `test/unit/application/primitives/is-ignored.test.ts`

Read-only and unchanged: src/application/primitives/is-ignored.ts (it only calls
`session.match`), test/bench/ignore-leading-directory.bench.ts (re-measured, not edited), every
interop file, build-ignore-evaluator.test.ts, occupant-clash.test.ts, apply-changeset.test.ts.

matcher-stack.ts today exports (Part 1) `leadingDirectoriesOf(path)`,
`directoryExclusion(stack, directory)` and
`matchBeneathLeadingDirectories(stack, path, isDir, exclusionOf)`. Keep `directoryExclusion`
as it is. Add, exactly (design §10):

```ts
/** The directory holding `path`, or `''` for a root-level path. */
export const parentDirectoryOf = (path: FilePath): FilePath | '' =>
  path.slice(0, Math.max(path.lastIndexOf('/'), 0)) as FilePath | '';

/** git's prep_exclude step: an excluded chain above decides, else the directory's own test. */
export const chainExclusion = (
  stack: ReadonlyArray<IgnoreLevel>,
  directory: FilePath,
  above: VerboseMatch | undefined,
): VerboseMatch | undefined => above ?? directoryExclusion(stack, directory);

/** git's last_matching_pattern: the exclusion of the leading chain decides, else the full path. */
export const matchBeneathChain = (
  stack: ReadonlyArray<IgnoreLevel>,
  path: FilePath,
  isDir: boolean,
  chain: VerboseMatch | undefined,
): VerboseMatch => chain ?? matchInStackVerbose(stack, path, isDir);
```

Then delete `leadingDirectoriesOf` and `matchBeneathLeadingDirectories` (no src importer may
remain; `npm run check:dead-code` proves it). Still exported from matcher-stack.ts only, never
from src/domain/ignore/index.ts.

ignore-evaluator.ts today (Part 2 and 3): `IgnoreSession`, `SessionState { evaluator, stack,
entered, resolved }`, helpers `pushDirRules`, `enterDirectory`, `rememberEntry`, `exclusionOf`,
`settleLeadingDirectories`, then `createIgnoreSession` and `buildRepoIgnorePredicate`. Change
to (names fixed; each helper under 20 lines; `IgnoreSession`, `pushDirRules`,
`buildRepoIgnorePredicate` and `buildIgnoreEvaluator` unchanged):

```ts
type ChainOutcome = Promise<VerboseMatch | undefined>;

interface SessionState {
  readonly evaluator: IgnoreEvaluator;
  readonly stack: IgnoreLevel[];
  /** The first excluded directory on each directory's chain, root-first; the root has none. */
  readonly chains: Map<FilePath | '', ChainOutcome>;
}

const resolveChain = async (state: SessionState, directory: FilePath): ChainOutcome => {
  const above = await chainOf(state, parentDirectoryOf(directory));
  const exclusion = chainExclusion(state.stack, directory, above);
  if (exclusion === undefined) await pushDirRules(state, directory);
  return exclusion;
};

const rememberChain = (state: SessionState, directory: FilePath): ChainOutcome => {
  const chain = resolveChain(state, directory);
  state.chains.set(directory, chain);
  return chain;
};

const chainOf = (state: SessionState, directory: FilePath | ''): ChainOutcome =>
  state.chains.get(directory) ?? rememberChain(state, directory as FilePath);
```

`createIgnoreSession` builds `chains: new Map([['', Promise.resolve(undefined)]])` and its
`match` is
`async (path, isDirectory) => matchBeneathChain(state.stack, path, isDirectory, await chainOf(state, parentDirectoryOf(path)))`.
`enterDirectory`, `rememberEntry`, `exclusionOf`, `settleLeadingDirectories`, `entered` and
`resolved` are deleted. `resolveChain` and `chainOf` call each other: declare them as `const`
arrow functions in the order above (the call happens after both are initialised); if biome's
`noInvalidUseBeforeDefine` objects, write `resolveChain` and `rememberChain` as hoisted
`function` declarations instead, keeping the bodies. An async return type must be spelled
`Promise<VerboseMatch | undefined>` if TypeScript refuses the alias on an `async` function.

Why the `await chainOf(parent)` comes before the test: the parent's promise settles after the
parent's rules are pushed, so the directory is tested against every level above it, and an
excluded chain reads nothing at or beneath its first excluded directory.

Test helpers that exist: matcher-stack.test.ts has `level`, `path`, `foldedLevel`, `kindLevel`
and three describes from Part 1 (`leadingDirectoriesOf` 3 rows, `directoryExclusion` 5 rows,
`matchBeneathLeadingDirectories` 18 rows with `exclusionOf = (d) => directoryExclusion(stack, d)`).
arbitraries.ts exports `arbGitignoreRules`, `levelOf`, `arbExcludedDirectoryCase`,
`arbLevelsBeyondDirectory`, `arbStackWithoutExcludedLeadingDirectory`. The four properties in
matcher-stack.properties.test.ts call `matchBeneathLeadingDirectories`.

Add to arbitraries.ts one pure composition of the three domain functions, used by the unit
rows and the properties in place of the deleted function (nothing but the domain functions
inside it):

```ts
/** The first excluded directory on `directory`'s chain over a fully loaded stack. */
export const chainOver = (
  stack: ReadonlyArray<IgnoreLevel>,
  directory: FilePath | '',
): VerboseMatch | undefined =>
  directory === ''
    ? undefined
    : chainExclusion(stack, directory, chainOver(stack, parentDirectoryOf(directory)));

/** The whole leading-directory rule over a fully loaded stack. */
export const judgeBeneathChain = (
  stack: ReadonlyArray<IgnoreLevel>,
  path: FilePath,
  isDir: boolean,
): VerboseMatch => matchBeneathChain(stack, path, isDir, chainOver(stack, parentDirectoryOf(path)));
```

Mutation hot spots this part owns and the rows that kill them:
- `Math.max` → `Math.min` (every path root-level) and the `0` literal: the `a/b/c` → `a/b` row
  and every nested row.
- `above ?? directoryExclusion(...)` → `&&`: the directory-excluded row with `above` undefined.
  The "first exclusion wins" row (`above` defined AND the directory itself excluded by another
  rule: the result is `above` by identity) kills a swapped-operand form.
- `chain ?? matchInStackVerbose(...)` → `&&`: any full-path row with no chain.
- `exclusion === undefined` in `resolveChain`: forced true reads the excluded directory's own
  `.gitignore` (the oversized `ab/.gitignore` row); forced false never loads a nested rule file
  (the `a/.gitignore` rows).
- `state.chains.get(directory) ?? rememberChain(...)` → `&&`: a new directory yields no
  outcome, so every excluded-directory row fails.
- The root's seeded entry (`['', …]`): emptied or renamed, the root's chain asks for itself
  before it is stored and every row throws a stack overflow.
- `rules.length > 0`: unchanged from Part 2 (no comment).

### TDD steps

1. RED `parentDirectoryOf` (matcher-stack.test.ts, new `describe('parentDirectoryOf')`,
   `it.each`): `a` → `''`, `a/b` → `a`, `a/b/c` → `a/b`. Fails: the import is `undefined`.
   GREEN: add the function.
2. RED `chainExclusion` (new describe, one `it` each): `above` defined and the directory not
   excluded → `above` by identity; `above` defined and the directory excluded by another rule →
   still `above` by identity; `above` undefined and root `ab/` → the `ab/` match for `ab`;
   `above` undefined and root `ab/` then `!ab/` → `undefined`. GREEN: add the function.
3. RED `matchBeneathChain` (new describe): a chain given and root `ab/`, `!ab/c` → the chain by
   identity for `ab/c`; no chain and root `*.log` → ignored for `x.log`; no chain and root
   `ab/*`, `!ab/c` → `unignored` with rule index 1 for `ab/c`; no chain and no rule → `unset`.
   GREEN: add the function.
4. GUARD: add `chainOver` and `judgeBeneathChain` to arbitraries.ts; move the 18 rows of the
   `matchBeneathLeadingDirectories` describe onto `judgeBeneathChain(stack, path, isDir)`
   (retitle the describe by behaviour: the whole leading-directory rule over a loaded stack),
   same expectations (verdict, level by identity, rule index). They pass on the code of steps
   1–3.
5. GUARD: the four properties call `judgeBeneathChain` in place of
   `matchBeneathLeadingDirectories`; same generators, same assertions, the recorded oracle rate
   stays as measured in Part 1. Prove red-capability once with a temporary edit (make
   `chainExclusion` ignore `above`: the excluded-directory property fails for a query two
   levels beneath the directory), reverted.
6. REFACTOR the session onto the chain memo (the code above). Every suite named in the gate is
   a GUARD and stays green unchanged. Add one GUARD row to is-ignored.test.ts beside the
   existing oversized-file rows: root `ab/`, an oversized `.gitignore` at `ab/x`, at `ab/x/y`
   and at `ab/x/y/z`, query `ab/x/y/z/w` → ignored by `.gitignore` line 1 `ab/`, no throw.
7. Delete `leadingDirectoriesOf` and `matchBeneathLeadingDirectories` with the
   `leadingDirectoriesOf` describe; `npm run check:dead-code` and
   `command grep -rn "leadingDirectoriesOf\|matchBeneathLeadingDirectories" src test` (no hit).
8. Measure (quiet machine first: `uptime` load average below 16 and no foreign
   `stryker`/`vitest` run): three runs of
   `./node_modules/.bin/vitest bench --run --config vitest.bench.config.ts test/bench/ignore-leading-directory.bench.ts`,
   each to its own scratch file; per run, ratio = session row mean / floor twin mean. Hand back
   the three pairs of means, the three ratios and `uptime` at start and end. The session sets
   the gate against the first session's 2.02 to 2.21.

### Gate

`npx vitest run test/unit/domain/ignore test/unit/application/primitives/is-ignored.test.ts test/unit/application/commands/internal/build-ignore-evaluator.test.ts test/unit/application/primitives/internal/occupant-clash.test.ts test/unit/application/primitives/apply-changeset.test.ts test/integration/is-ignored-leading-directory-interop.test.ts test/integration/ignored-leading-directory-occupant-interop.test.ts test/integration/gitignore-end-to-end.test.ts && ./node_modules/.bin/vitest run --project posix-integration test/integration/posix-only/ignored-leading-directory-unreadable-gitignore-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/ignore/matcher-stack.ts src/application/primitives/internal/ignore-evaluator.ts test/unit/domain/ignore/matcher-stack.test.ts test/unit/domain/ignore/matcher-stack.properties.test.ts test/unit/domain/ignore/arbitraries.ts test/unit/application/primitives/is-ignored.test.ts && npm run check:spelling && npm run check:test-pyramid && npm run check:dead-code`

### Commit

`perf(ignore): keep one outcome per directory chain in the ignore session`

## Notes for later phases (not parts)

- **Documentation phase** (design §9): docs/use/primitives/is-ignored.md (leading-directory rule,
  the "loaded lazily" line, never throws on a `.gitignore` inside an excluded directory),
  docs/use/primitives/internals.md (the session), docs/use/commands/checkout.md, rebase.md,
  merge.md, stash.md, cherry-pick.md, revert.md; docs/BACKLOG.md (tick 32.92, correct its "only the
  public per-path primitive" sentence, Release order table).
- **Ledger row (ADR-1277)**: row X5 in docs/known-divergences.md under "Corrupt, forged or
  unreadable input", with its proof — the impact triage writes it.
- **Design §6 numbers**: the session records Part 4's measured ratios and gate in the design.
- **Session after the commits**: `npm run bench:ab` on status, status-dirty, add, checkout, stash
  benches (quiet machine first) and `bench:check`; size caps raised once after review on a clean
  build (`rm -rf dist .wireit`), `chore(size)`; mutation validation scoped to matcher-stack.ts,
  ignore-evaluator.ts and is-ignored.ts with their eponymous suites (every timeout hand-verified).
- **Design deviation recorded here**: the three domain functions are not added to
  src/domain/ignore/index.ts (Public surface fact); §2's memo `if` becomes `??` (PC-1).
