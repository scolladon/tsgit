<!-- cspell:ignore CASEFOLD caseco casenc dmpscf dpscf dpsco dpscp fspathncmp mpscf ompscf pscf psco pscp rowdiff scf stps tolower twoway unstaging wildmatch -->
# Plan — sequencer-sparse-cone-writes

> Source: design doc `docs/design/sequencer-sparse-cone-writes.md` · ADRs 1211, 1212, 1213, 1214, 1215, 1216
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
  files in its `### Context` block, is two parts. What counts is a path in backticks:
  backtick the files the part CREATES or EDITS, and write read-only reference paths in
  plain text.

## Plan-wide notes (every part reads this)

**Rulings this plan is written against.** ADR-1211 (D-A): one materialisation rule for merge and
the sequencer/stash conflict path: a clean outcome is written only inside the patterns, a conflict
always is; an excluded `resolved-merged` outcome is staged stage 0 skip-worktree under its merged
blob and not written. ADR-1212 (D-B): a conflict stop removes clean out-of-pattern non-skip-worktree
files and marks them skip-worktree, through ONE helper shared by `applyMergeToWorktree` and
`merge.ts` (two-head AND octopus conflict writers). ADR-1213 (D-C): a dirty out-of-pattern mover is
kept `H` with one warning, forced or not, inside `materializeTree`. ADR-1214 (D-D):
`loadSparseMatcher` reads `core.ignorecase`; `buildSparseMatcher(spec, { ignoreCase })`;
`CompileGlobOptions.caseFold`. ADR-1215 (D-E): `applyMergeToWorktree` loads the matcher itself, once
per call; `ApplyMergeInput` does not change. ADR-1216 (D-F): `stash apply` without `--index` runs
git's step 2 (check out changed skip-worktree entries, clear their bit) before
`unstageChangesUnlessNew`. Breaking: every commit is `fix(<scope>):`, never `!` (design
"Breaking-change classification"; the only refusal touched, checkout dpsco, is removed: ADR-1199).

**Order and why nine parts.** Parts 1–3 fold case folding into the matcher (ADR-1214) and pin it
on the consumers that already use it (checkout, reset, merge, pull ff). Part 4 makes a dirty
out-of-pattern mover survive `materializeTree` (ADR-1213); it must precede Part 6, otherwise the
forced sequencer clean path would silently delete the dirty file (row dpscp). Part 5 lands stash's
step 2 (ADR-1216) BEFORE the clean path goes sparse, so st/sta never go red at a commit boundary
(before Part 6 no merged entry is skip-worktree, so step 2 is a no-op there; its rows are GUARDs).
Part 6 turns the clean path sparse (R1, ADR-1215). Parts 7–8 do the `applyMergeToWorktree`
conflict path (R2/R3, then R4 movers). Part 9 applies the shared rule and helper to `merge.ts`.
Parts run in sequence on one working tree; each starts from the previous part's commit.
apply-merge-to-worktree.ts and its unit suite recur in Parts 6–9, and the interop suite in Parts
3–9: deliberate, merging them would exceed the 6-file ceiling.

**Public-surface decisions (decided here, per symbol).**
- `CompileGlobOptions.caseFold` (src/domain/pathspec/compile-glob.ts): **internal** —
  `compileGlob`/`CompileGlobOptions` are not re-exported by src/domain/index.ts (no `pathspec`
  line) and absent from reports/api.json.
- `compileSparseRule`'s new optional third parameter `options: { readonly caseFold?: boolean }`
  (inline type, no new named type): **public** (src/domain/sparse/index.ts barrel →
  src/domain/index.ts). Gate: regenerate reports/api.json.
- `SparseMatchOptions` (new interface in src/domain/sparse/sparse-pattern.ts), `coneMatcher`'s and
  `buildSparseMatcher`'s new optional second parameter: **public** (same barrel). Gates: add
  `SparseMatchOptions` to the `export type { … }` line of src/domain/sparse/index.ts; regenerate
  reports/api.json. No error code, no Tier-1 command, no facade method, no README count.
- `loadSparseMatcher` (signature unchanged, doc comment changes): already public; regenerate
  reports/api.json.
- `MaterializeTreeOpts` / `materializeTree` are in reports/api.json: any JSDoc change there
  regenerates it.
- Everything else is **internal** (consumed only under `src/`, never re-exported from
  `src/index*.ts`, src/application/commands/index.ts or src/application/primitives/index.ts):
  `notUpToDate`, `warnLeftDespiteSparse` (new internal/sparse-left-dirty.ts); `checkOutSkippedChanges`
  (new commands/internal/check-out-skipped-changes.ts); `retireSparseMovers`, `withRetiredSkipped`,
  `SparseRetirement`, `NOTHING_RETIRED` (new internal/sparse-movers.ts); `isExcluded`,
  `isMaterialised` (exported from apply-merge-to-worktree.ts in Part 9 only, when merge.ts imports
  them); `CarriedOpts.leftDirty` (materialize-tree.ts private interface).
- If an implementer finds an export must become public, that is a blocker: report
  `{ unit, reason, options }`.

**api.json is a pre-push gate, not a validate gate.** Every part ends its gate with
`npm run docs:json` and commits reports/api.json in the same commit when it changed (generated;
the large typedoc-id diff is normal). Parts 1, 2, 3 and 4 are expected to change it.

**Implementers have NO MCP tools** (no serena, no graft). Use `Read` with the anchors given,
`command grep -n "<symbol>" <file>` (never bare `grep`: the rtk hook rewrites and truncates it),
and `Edit`. Anchors are point-in-time for commit ce3712f7; earlier parts shift them, so re-anchor
by symbol name.

**Craft Bash hook traps.** Denied: perl one-liners; `node -e` bodies holding `[` together with
`$(`, or template literals; `git show` / `git diff` without `--no-ext-diff`. Put any loop or
multi-command probe in a script file and run it as `bash /abs/script.sh literal args`.
State-mutating probes (git config, repo writes) run in a `mktemp -d` throwaway, never in the
worktree.

**Test conventions (every part).**
- Titles: `describe('Given …')` > `describe('When …')` > `it('Then …')`. The 2-level
  `describe('Given …, When …')` > `it('Then …')` only when one expectation lives under the When.
- Bodies: AAA comments (`// Arrange`, `// Act`, `// Assert`).
- `sut` is the FUNCTION under test (`const sut = applyMergeToWorktree;`). Never bind a result to
  `sut` (the test-pyramid `sutBindsResult` check fails on it).
- Errors: assert the full `data` (try/catch or the file's refusal helper), never `toThrow(Class)`.
- Logger rows assert the exact warning string (`toHaveBeenCalledWith(<exact>)` plus
  `toHaveBeenCalledTimes(1)`), never only that `warn` was called. Build the logger context as
  `const ctx = { ...base, logger: { warn } }` (precedent: test/unit/application/primitives/apply-changeset.test.ts line 524).
- Any DI row around a destructive call pins the TARGET path, not only the count.
- 100% lines/branches/functions/statements. No suppression directive of any kind. No provenance
  refs (ADR, backlog, design-row or part ids) in source, test titles or comments; row ids such as
  `cp` may appear only as an `id` data field of an `it.each` table.
- Unit sparse setup on the memory adapter: write `${ctx.layout.gitDir}/config` with
  `[core]\n\tsparseCheckout = true\n\tsparseCheckoutCone = true\n` (plus `\tignorecase = true\n`
  where a row needs it) and `${ctx.layout.gitDir}/info/sparse-checkout` with
  `/*\n!/*/\n/b/\n`, then `invalidateConfigCache(ctx)` (src/application/primitives/config-read.ts;
  the apply-merge suite's `configure` helper inside
  `describe('applyMergeToWorktree writes through the working-tree writer')` does exactly this —
  hoist it to module scope when a second describe needs it). If a stale verdict survives, also
  call `__resetSectionsCacheForTests()` from src/application/primitives/config-scoped-read.ts, as
  test/unit/application/primitives/read-sparse-checkout.test.ts does.

**TDD discipline.** Write each RED and run it before the code that satisfies it. Record the
failing reason you saw and check it against the reason this plan predicts. A GUARD must pass when
written; a red GUARD is a RED the plan misclassified: stop, note it in the hand-off, and make it
green with this part's GREEN only. Never widen scope.

**Gate command notes.**
- Run tests with `./node_modules/.bin/vitest run <files>`; vitest projects pick unit vs
  integration by path. Never bare `npx vitest` (the rtk hook can rewrite it into a full run).
- `rm -rf .wireit` before trusting `npm run check:types` / `npm run check:spelling` (wireit caches
  a stale green). Oracles: `node --max-old-space-size=4096 node_modules/typescript/bin/tsc --noEmit -p tsconfig.typecheck.json`
  and `npx cspell --no-progress <files>`.
- Run `npm run check:test-pyramid` in every part that touches the interop suite (lesson 045).
- Write long output to a scratchpad file and read back only the failing lines.
- Never commit on a red gate; never `--no-verify`. Commit with `git commit -m "<subject>"`: one
  line, no body, ≤ 100 chars (commitlint).

**Interop suite (created in Part 3, extended by Parts 4–9):
test/integration/sequencer-sparse-cone-writes-interop.test.ts.**

Header (copy the shape of test/integration/sparse-checkout-worktree-config-interop.test.ts lines
1–9). `bucket: cross-tool-interop`; `unique` 12–200 chars and unique repo-wide, e.g.
`sparse patterns govern every merge-driven work-tree write, case-folded under core.ignorecase, as canonical git applies them`;
`interopSurface: sequencer, stash, checkout, merge` (all four are declared by existing `@writes`
tags); `surface:` grows per part (`repo.checkout, repo.reset, repo.merge.run, pull` in Part 3;
`repo.cherryPick.run, repo.revert.run, repo.rebase.run, repo.stash.apply, repo.stash.pop` added
when those rows land).

Helpers to reuse (read-only):
- test/integration/interop-helpers.ts: `GIT_AVAILABLE`, `runGit(args, { env?, input? })`,
  `git(dir, ...args)`, `tryRunGitWithExit(args, { env? })` → `{ stdout, stderr, exitCode }`
  (its `env` REPLACES the safe env: pass `COMMIT_ENV`, which already spreads `runGitEnv()`),
  `makePeerPair(slug)` → `{ peer, ours, dispose }`, `initBothRepos(peer, ours)`.
- test/integration/occupant-displacement-fixtures.ts: `COMMIT_ENV` (pinned author/committer —
  pass it to every git op that commits, in BOTH twins), `commitOn(dir, entries, parent?)` (builds a
  commit from `regular(path, content)` entries with `read-tree --empty` + `update-index
  --cacheinfo` + `commit-tree`), `regular(path, content)`, `listing(dir)` (sorted
  `path=content` / `dir/` / `link@->target`, `.git` excluded).
- Seed shape from sparse-checkout-worktree-config-interop.test.ts `seedFixture` (commitOn +
  `update-ref refs/heads/<b>` + `reset -q --hard main`) and its `writeConeFile` / `gitConfig`.

Twin recipe (both twins get the identical git setup; only the operation differs):
1. `makePeerPair('sequencer-sparse')`; `initBothRepos(peer, ours)`. In `afterEach`, `dispose()`.
2. In each dir: `git config core.ignorecase <false|true>` (lesson 042: always explicit),
   `git config user.name Ada`, `git config user.email ada@example.com`, then the row's seed.
3. Sparse on: `git config core.sparseCheckout true`, `git config core.sparseCheckoutCone
   true|false`, write `.git/info/sparse-checkout` (`CONE_FILE = '/*\n!/*/\n/b/\n'` or
   `NON_CONE_FILE = '/top\n/b/\n'`), `git read-tree -mu HEAD`.
4. Row-specific pre-state (movers: `git update-index --no-skip-worktree a/g` then
   `git checkout -- a/g`; dirty: `writeFileSync(join(dir, 'a/g'), 'dirty\n')`).
5. git side: `tryRunGitWithExit(['-C', peer, ...op], { env: COMMIT_ENV })`. tsgit side: open
   AFTER the config is written: `const warnings: string[] = []; const repo = await
   openRepository({ cwd: ours, logger: { warn: (m: string) => warnings.push(m) } });` run the op,
   capture returned value or thrown `TsgitError.data`, `await repo.dispose()` in `finally`.
6. Compare: `runGit(['-C', d, 'ls-files', '-t', '-s'])` for both dirs (git reading tsgit's index
   validates its bytes; note git clears the skip-worktree bit of a PRESENT file when it reads an
   index, so the disk listing must be compared too), `listing(d)` for both, the exit (git
   `exitCode` vs tsgit returned / thrown / `kind`), and warnings (below). Never compare commit SHAs
   (tsgit's committer identity/date differs).

Structure (lesson 045; never chain `describe.skipIf(…).each(…)`):

```ts
describe.each(['false', 'true'] as const)('Given core.ignorecase=%s in both twins', (ignoreCase) => {
  describe('When cherry-pick replays a change outside the cone', () => {
    it.skipIf(!GIT_AVAILABLE)('Then the path stays skip-worktree and unwritten, as git leaves it', async () => { … });
  });
  // one `When …` describe per row family; table rows via it.each with an `id` data field
});
```

Dirty-mover warning (pinned on git 2.56.0 in a throwaway, exact stderr bytes):

```
warning: The following paths are not up to date and were left despite sparse patterns:
\ta/g
\ta/k

After fixing the above paths, you may want to run `git sparse-checkout reapply`.
```

tsgit emits it as ONE `ctx.logger?.warn` string without the `warning: ` prefix (the shape
src/application/commands/internal/apply-sparse-checkout.ts `warnAlreadyPresent` uses):
`'The following paths are not up to date and were left despite sparse patterns:\n' + paths.map((p) => `\t${p}\n`).join('') + '\nAfter fixing the above paths, you may want to run `git sparse-checkout reapply`.'`.
Paths in index order. Interop: `expect(gitStderr).toContain(`warning: ${w}\n`)` for the tsgit
warning `w` that starts with the header; when git prints no such header, tsgit has no such
warning.

Fixtures (from the design's pinned matrix):
- BASE: `a/f=f1\n a/g=g1\n b/f=f1\n top=t\n`. `other` = BASE with `a/f=f2\n`, `b/f=f2\n` unless a
  row says otherwise. Conflict variants: HEAD changes `b/f` to `f-ours\n` and `other` to
  `f-theirs\n` (one-line files conflict). Line-merged `a/f` (cf3): base `1\n2\n3\n4\n5\n`, HEAD
  edits line 1, `other` edits line 5 (git's merged blob is `1f29e7f…` for the design's bytes;
  compare the oid between twins, do not hard-code it).
- CASE: `B/f=f1\n x/y=y1\n top=t\n`; `other` changes `B/f` and `x/y`. Cone `/b/`, non-cone
  `/top\n/b/\n`.
- Expected verdicts per row are the design's "git" column (pinned matrix, Axes 1–5).

## Decision candidates

Load-bearing choices the design and ADRs leave open. The plan is written on each
recommendation; the "if overturned" line says what changes.

- **DC-1 — how the non-cone matcher folds case** (ADR-1214 fixes the API, not the mechanics; non-cone
  rules are compiled at parse time, before `ignoreCase` is known).
  - A. `buildSparseMatcher(spec, { ignoreCase: true })` re-parses the rules' `source` lines
    (`parseNonCone(rules.map((r) => r.source).join('\n'), { caseFold: true })`). Same lines, same
    budgets, no unreachable branch.
  - B. `parseSparseCheckout(text, cone, { ignoreCase })` compiles folded rules up front;
    `loadSparseMatcher` passes the flag twice. Departs from ADR-1214's API wording.
  - C. `SparseRule` gains a second, folded matcher compiled eagerly. Public type change, double
    compile cost for every caller.
  - **Recommendation: A.** If overturned (B): Part 3 edits `parseSparseCheckout` instead of the
    `buildSparseMatcher` no-cone arm.
- **DC-2 — the "not up to date" judge for out-of-pattern movers.**
  - A. `createWorkingTreeDirtyCheck(ctx)` (src/application/primitives/apply-changeset.ts): content
    hashed through the check-in conversion, absent file = clean. It is the judge whose refusal
    (dpsco) ADR-1213 replaces, and it is immune to a copied repository's stale stat.
  - B. `matchesCachedStat` + `racyContentMatcher` (stat first, content only when racy), as the
    design §3 sketch says. A stat-only change (touch, copy) then reads as dirty, and the file is
    kept where git, which falls back to a content compare (`ie_modified`), removes it.
  - **Recommendation: A.** If overturned: Part 4's `notUpToDate` body changes; tests unchanged.
- **DC-3 — how a retired conflict-path mover gets its bit.**
  - A. Post-mark after `withConflictStopStats`: `withRetiredSkipped(entries, retirement)` maps
    every retired stage-0 entry to `skipWorktreeEntry`. withConflictStopStats stays untouched.
  - B. The design §2 rule in `statOf`: "return the built entry when its skipWorktree differs from
    the prior entry's". With sparse OFF, that also replaces a donor `S` prior entry (bit set by
    `update-index --skip-worktree`) with the freshly built `H` entry, a change R10 forbids; it
    would have to be narrowed to one direction.
  - **Recommendation: A.** If overturned: Part 8 edits stat-conflict-index.ts and its suite
    instead of adding `withRetiredSkipped`.
- **DC-4 — where `isExcluded` / `isMaterialised` live** (design §2 proposes a new
  internal/sparse-verdict.ts).
  - A. In apply-merge-to-worktree.ts, module-private in Parts 7–8 and exported in Part 9 when
    merge.ts imports them (merge.ts already imports `survivingPathsOf` from there).
  - B. A new internal/sparse-verdict.ts module from Part 7.
  - **Recommendation: A** (one module fewer; no export without a consumer, which
    `check:dead-code` would flag). If overturned: Part 7 creates the module and its suite.
- **DC-5 — the dirty-mover warning text.**
  - A. Header + tab-indented paths + git's trailing reapply hint, byte-equal to git's stderr minus
    `warning: ` (the apply-sparse-checkout.ts `warnAlreadyPresent` precedent).
  - B. Header + paths only; the hint is display.
  - **Recommendation: A.** If overturned: Part 4's constant and every warning assertion drop the
    hint.

## Part 1 — fold ASCII case in the glob compiler and the non-cone rule compiler

### Context

**Requirements:** R8 (domain half, non-cone). No consumer passes the option yet: no behaviour
change outside the domain. Rows: none (interop pins land in Part 3).

Files this part edits or creates:
- `src/domain/pathspec/compile-glob.ts`
- `src/domain/sparse/non-cone.ts`
- `test/unit/domain/pathspec/compile-glob.test.ts`
- `test/unit/domain/pathspec/compile-glob.properties.test.ts`
- `test/unit/domain/sparse/non-cone.test.ts`
- `test/unit/domain/sparse/non-cone.properties.test.ts` (new)

**Current code (ce3712f7).**

compile-glob.ts:
- `CompileGlobOptions` (lines 24–32): `{ readonly anchored: boolean; readonly withDirSuffix?: boolean }`.
- `compileGlob(pattern: string, options: CompileGlobOptions): GlobMatcher` (lines 198–201):
  `const tokens = tokenize(pattern); return { test: (path) => matchTokens(tokens, options, path) };`
- This dialect has no `[…]` classes (header comment: `[…]` and `\` are literals), so "class" rows
  from the design reduce to literal rows.
- Callers that must stay byte-identical (no option passed): src/domain/ignore/parse-gitignore.ts
  line 115, src/domain/attributes/parse-gitattributes.ts line 125.

non-cone.ts:
- `compileSparseRule(tokenized: TokenizedIgnoreLine, source: string): SparseRule` (lines 25–35)
  calls `compileGlob(tokenized.cleanPattern, { anchored: tokenized.anchored, withDirSuffix: recursive })`.
- `nonConeMatcher(rules)` unchanged.

**Target.**

```ts
// compile-glob.ts
export interface CompileGlobOptions {
  readonly anchored: boolean;
  readonly withDirSuffix?: boolean;
  /** git's WM_CASEFOLD: ASCII letters compare case-insensitively; any other character stays exact. */
  readonly caseFold?: boolean;
}

export const compileGlob = (pattern: string, options: CompileGlobOptions): GlobMatcher => {
  if (options.caseFold !== true) {
    const tokens = tokenize(pattern);
    return { test: (path: string): boolean => matchTokens(tokens, options, path) };
  }
  const folded = tokenize(asciiLower(pattern));
  return { test: (path: string): boolean => matchTokens(folded, options, asciiLower(path)) };
};
```

- `asciiLower(text: string): string` exists in src/domain/pretty/ascii.ts (lines 14–15, `[A-Z]`
  only — git's `sane_ctype` tolower). Domain-to-domain import, already done by
  src/domain/git-index/resolve-undo.ts. Lowercasing before `tokenize` is safe: only `*`, `?`, /
  are special and none has a case.
- The unfolded branch keeps today's zero-allocation hot path (ignore/attribute matching).
- non-cone.ts: `compileSparseRule(tokenized, source, options: { readonly caseFold?: boolean } = {})`
  passes `caseFold: options.caseFold === true` into the `compileGlob` options. JSDoc: one sentence
  saying the option folds ASCII case as `core.ignorecase` does.

**Property siblings.** test/unit/domain/pathspec/compile-glob.properties.test.ts (existing,
`NUM_RUNS = 100`, imports `arbLiteralPattern` from ./arbitraries.js) gains:
- with `caseFold: true`, `test(path) === test(flipAsciiCase(path, mask))` for every path/mask;
- `compileGlob(p, o).test(x)` implies `compileGlob(p, { ...o, caseFold: true }).test(x)`.
`flipAsciiCase` is a local test helper: swap case of `[A-Za-z]` where the mask bit is set. Use a
small alphabet (`aAbB/*?`) for patterns and paths so matches are frequent.
non-cone.properties.test.ts (new; local arbitraries, ASCII lines such as `/[aAbB]{1,3}(/[aAbB]{1,3})?/?`
tokenised with `tokenizeIgnoreLine` from src/domain/ignore/index.ts, skipping `undefined`) holds
the same two properties over `compileSparseRule(t, s, { caseFold: true }).matcher`, plus "no option
≡ `{ caseFold: false }`".

**Mutation bucket:** compile-glob.ts (compile-glob.test.ts, compile-glob.properties.test.ts),
non-cone.ts (non-cone.test.ts, non-cone.properties.test.ts).

### TDD steps

1. RED — compile-glob.test.ts, new `describe('Given caseFold')`: `it.each` over
   `[pattern, anchored, path]` rows `['B/f', true, 'b/F']`, `['*.TXT', false, 'dir/a.txt']`,
   `['?/F', true, 'b/f']`, `['src', true, 'SRC/x']` with `withDirSuffix: true` → `true`.
   Fails: the option is ignored, literal comparison is exact, so each returns `false`.
2. GUARD — same describe: `['É', true, 'é']` → `false` (non-ASCII stays distinct; passes because
   both exact and ASCII folding keep `É` ≠ `é`). And without `caseFold`, `['B/f', true, 'b/f']` →
   `false` (passes: today's behaviour).
3. RED — non-cone.test.ts, `describe('Given compileSparseRule with caseFold')`: rule `/b/`
   (tokenised via `tokenizeIgnoreLine('/b/')`) tests `B/f` → `true`; a negated `!/B/x` rule's
   matcher tests `b/x` → `true`. Fails: the third parameter does not exist (type error at
   compile, `false` at runtime).
4. GREEN — the Target code above in compile-glob.ts and non-cone.ts.
5. Properties — add the compile-glob and non-cone properties (RED for the invariance property
   before step 4 would be redundant; write them after GREEN as GUARDs: they pass because folding
   both sides makes the verdict case-invariant).
6. REFACTOR — none expected; keep each function < 20 lines.

### Gate

`./node_modules/.bin/vitest run test/unit/domain/pathspec/compile-glob.test.ts test/unit/domain/pathspec/compile-glob.properties.test.ts test/unit/domain/sparse/non-cone.test.ts test/unit/domain/sparse/non-cone.properties.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/pathspec/compile-glob.ts src/domain/sparse/non-cone.ts test/unit/domain/pathspec/compile-glob.test.ts test/unit/domain/pathspec/compile-glob.properties.test.ts test/unit/domain/sparse/non-cone.test.ts test/unit/domain/sparse/non-cone.properties.test.ts && npm run check:spelling`, then `npm run docs:json` (commit reports/api.json if it changed).

### Commit

`fix(sparse-checkout): fold ASCII case in non-cone sparse rules on request`

## Part 2 — fold ASCII case in the cone matcher

### Context

**Requirements:** R8 (domain half, cone). No consumer passes the option yet. Rows: none.

Files this part edits or creates:
- `src/domain/sparse/sparse-pattern.ts`
- `src/domain/sparse/cone.ts`
- `src/domain/sparse/index.ts`
- `test/unit/domain/sparse/cone.test.ts`
- `test/unit/domain/sparse/cone.properties.test.ts` (new)

**Current code (ce3712f7).**

sparse-pattern.ts: `SparseSpec` union, `SparseMatcher = (path: FilePath) => boolean`. Add:

```ts
/** How a sparse matcher compares paths. */
export interface SparseMatchOptions {
  /** `core.ignorecase`: ASCII letters match case-insensitively, as git's fspathncmp and WM_CASEFOLD do. */
  readonly ignoreCase?: boolean;
}
```

cone.ts:
- `dirname(path)` (lines 75–78), `coneMatcher(spec: ConeSpec): SparseMatcher` (lines 88–100): root
  file → true; `spec.parents.has(dir)` → true; walk up `ancestor` via `lastIndexOf('/')` checking
  `spec.recursive.has(ancestor)`. JSDoc stresses "allocating nothing per call" (hot path in
  `materializeTree`).

index.ts line 10: `export type { SparseMatcher, SparseRule, SparseSpec } from './sparse-pattern.js';`
— add `SparseMatchOptions` (alphabetical inside the braces).

**Target.**

```ts
// cone.ts — extract the walk, keep the exact path allocation-free
const inCone = (parents: ReadonlySet<string>, recursive: ReadonlySet<string>, dir: string): boolean => { /* today's body */ };
const foldAll = (dirs: ReadonlySet<string>): ReadonlySet<string> => new Set([...dirs].map(asciiLower));

export const coneMatcher = (spec: ConeSpec, options: SparseMatchOptions = {}): SparseMatcher => {
  if (options.ignoreCase !== true) return (path) => inCone(spec.parents, spec.recursive, dirname(path));
  const parents = foldAll(spec.parents);
  const recursive = foldAll(spec.recursive);
  return (path) => inCone(parents, recursive, asciiLower(dirname(path)));
};
```

- `asciiLower` from src/domain/pretty/ascii.ts. Update the coneMatcher JSDoc: the folded matcher
  allocates one lowercased directory per call; the exact one allocates nothing.
- Perf note (design §6): the folded path costs one `asciiLower` per path, only under
  `core.ignorecase=true`. No bench gate in this part.

**Property sibling.** cone.properties.test.ts (new, `NUM_RUNS = 100`; local arbitraries: cone
dirs from segments over `[aAbB]{1,2}`, depth 1–3, via `buildConeSpec`; paths over the same
alphabet, depth 1–4): (1) `ignoreCase: true` verdict invariant under ASCII case flips of the
path; (2) exact match implies folded match; (3) omitted options ≡ `{ ignoreCase: false }`. The
design's "shared arbitraries.ts" is dropped: the cone and non-cone generators differ in shape.

**Public surface:** `SparseMatchOptions` and `coneMatcher`'s optional parameter are public —
barrel line in index.ts (this part) and reports/api.json (`npm run docs:json`).

**Mutation bucket:** cone.ts (cone.test.ts, cone.properties.test.ts).

### TDD steps

1. RED — cone.test.ts `describe('Given a cone of b with ignoreCase')`:
   `coneMatcher(buildConeSpec(['b']), { ignoreCase: true })` accepts `B/f` and `B/c/d`; a cone of
   `a/b` folded accepts `A/x` (a parent's direct file) and `A/B/c/d`. Fails: the option is
   ignored, `B` ≠ `b`.
2. GUARD — the folded matcher rejects `x/y`, accepts a root file `TOP`, rejects `É/f` for a cone
   of `é` (non-ASCII stays distinct); the unfolded matcher rejects `B/f`. All pass today.
3. GREEN — `SparseMatchOptions`, barrel line, Target code, JSDoc.
4. Properties (GUARDs after GREEN: folding both sides makes the verdict case-invariant).
5. REFACTOR — `inCone` < 20 lines, nesting ≤ 2.

### Gate

`./node_modules/.bin/vitest run test/unit/domain/sparse && npm run check:types && ./node_modules/.bin/biome check src/domain/sparse test/unit/domain/sparse && npm run check:spelling`, then `npm run docs:json` (commit reports/api.json).

### Commit

`fix(sparse-checkout): fold ASCII case in cone sparse patterns on request`

## Part 3 — match sparse patterns case-insensitively under core.ignorecase

### Context

**Requirements:** R8 (dispatch + every `loadSparseMatcher` consumer), R10, DC-1 = A. Rows turned
green (interop, under `ignorecase=true`): caseco (`checkout other`), case-reset (`reset --hard
other`), case-merge (`merge other`, fast-forward), case-pull (`pull` fast-forward). Under
`ignorecase=false` the same rows are GUARDs (they match today).

Files this part edits or creates:
- `src/domain/sparse/parse-sparse-checkout.ts`
- `test/unit/domain/sparse/parse-sparse-checkout.test.ts`
- `src/application/primitives/read-sparse-checkout.ts`
- `test/unit/application/primitives/read-sparse-checkout.test.ts`
- `test/integration/sequencer-sparse-cone-writes-interop.test.ts` (new)

**Current code (ce3712f7).**

parse-sparse-checkout.ts:
- `parseNonCone(text: string): ReadonlyArray<SparseRule>` (lines 27–48, module-private) calls
  `compileSparseRule(tokenized, line)`; `line` is the CR-stripped source, stored as `rule.source`.
- `buildSparseMatcher(spec: SparseSpec): SparseMatcher` (lines 66–69).

read-sparse-checkout.ts `loadSparseMatcher(ctx)` (lines 58–72): `readSparseConfig` →
`if (!enabled) return undefined` → `readSparsePatternText` → `parseSparseCheckout` → degraded
warning → `return buildSparseMatcher(parsed.spec);`.

**Target.**

```ts
// parse-sparse-checkout.ts (DC-1 = A)
const parseNonCone = (text: string, options: { readonly caseFold?: boolean } = {}) => … compileSparseRule(tokenized, line, options) …;

export const buildSparseMatcher = (spec: SparseSpec, options: SparseMatchOptions = {}): SparseMatcher => {
  if (spec.mode === 'cone') return coneMatcher(spec, options);
  if (options.ignoreCase !== true) return nonConeMatcher(spec.rules);
  // Rules are compiled at parse time; re-parse their own lines folded.
  return nonConeMatcher(parseNonCone(spec.rules.map((rule) => rule.source).join('\n'), { caseFold: true }));
};

// read-sparse-checkout.ts, after the degraded warning
const ignoreCase = (await readConfig(ctx)).core?.ignoreCase === true;
return buildSparseMatcher(parsed.spec, { ignoreCase });
```

- The re-parse sees the same lines, so the pattern budgets cannot fire a second time.
- `readConfig` from ./config-read.js (`core.ignoreCase?: boolean`, config-read.ts line 75; cached).
  Read only when sparse is enabled (R10: a sparse-off repository reads nothing new). The same
  read is used by materialize-tree.ts `clearedObstructions` (line 496).
- JSDoc on both: under `core.ignorecase` the patterns match ASCII case-insensitively.
- Public surface: `buildSparseMatcher`'s optional parameter (type from Part 2) → reports/api.json.
- Consumers (read-only, no edits): src/application/commands/checkout.ts line 448,
  src/application/commands/reset.ts lines 110 and 155, src/application/commands/internal/reset-worktree.ts
  line 39, src/application/commands/pull.ts line 439, src/application/commands/merge.ts lines 1211,
  1566, 1948, src/application/commands/sparse-checkout.ts line 205.

**Unit rows.** parse-sparse-checkout.test.ts `describe('Given buildSparseMatcher with ignoreCase')`:
non-cone `parseSparseCheckout('/top\n/b/\n!/b/x\n', false).spec` folded accepts `TOP` and B/f,
rejects B/X; cone `parseSparseCheckout('/*\n!/*/\n/b/\n', true).spec` folded accepts B/f;
GUARD: no options and `{ ignoreCase: false }` reject B/f in both modes.
read-sparse-checkout.test.ts (uses `createMemoryContext`, `seedConfig`, `seedPatternFile`, resets
caches with `__resetConfigCacheForTests` / `__resetSectionsCacheForTests`): cone /b/ +
`ignorecase = true` → accepts B/f; `ignorecase` absent → rejects; `= false` → rejects.

**Interop (new suite; header, helpers and twin recipe in the plan-wide notes).** Build the shared
harness here so later parts only add rows: `seedTwin(dir, ignoreCase, seed)`, `enableSparse(dir,
{ cone: boolean })`, `tagged(dir)`, `outcomeOf(run)`, `leftWarning(stderr)` / `leftWarnings(warnings)`.
Rows this part (CASE fixture, cone /b/; expected = design Axis 4):
- caseco: git `checkout -q other`; tsgit `repo.checkout({ rev: 'other' })`.
- case-reset: git `reset -q --hard other`; tsgit `repo.reset({ mode: 'hard', rev: 'other' })`.
- case-merge: git `merge -q other` (ff); tsgit `repo.merge.run({ rev: 'other', message: 'm', author: AUTHOR })`
  (AUTHOR shape: sparse-checkout-worktree-config-interop.test.ts lines 27–32).
- case-pull: a third repository `origin` seeded with the same commits, its `main` at `other`;
  git `pull -q <originPath> main`; tsgit through `createNodeContext` + `pull(ctx, …)` with
  `transport: backendTransport(originRoot)` and `remote.origin.url` set in both twins — copy the
  wiring from test/integration/fetch-pull-reflog-action-interop.test.ts (imports lines 16–26, the
  context build near line 130, `trackedContexts` from ./repository-lifecycle.js for disposal).
  If the http-backend wiring cannot reach a fast-forward within budget, hand the row off as
  `{ unit: 'case-pull', reason, options }` rather than skipping it.
Expected: `ignorecase=false` → `S B/f`, `S x/y`, only `top` on disk; `ignorecase=true` →
`H B/f` written, `S x/y`. The design pinned caseco only; case-reset, case-merge and case-pull are pinned by these twins: if git does not fold on one of them, stop and report `{ unit, reason, options }`.

**Mutation bucket:** parse-sparse-checkout.ts (parse-sparse-checkout.test.ts),
read-sparse-checkout.ts (read-sparse-checkout.test.ts).

### TDD steps

1. RED — parse-sparse-checkout.test.ts folded rows. Fails: the second parameter is ignored.
2. GUARD — unfolded rows (pass today).
3. GREEN — `parseNonCone` options + `buildSparseMatcher` dispatch.
4. RED — read-sparse-checkout.test.ts `ignorecase = true` row. Fails: the matcher is built
   without options, so `B/f` is rejected.
5. GUARD — `ignorecase` absent / `false` rows (kill `=== true` → truthy mutants). Pass today.
6. RED — interop caseco, case-reset, case-merge, case-pull under `true`. Fails: tsgit leaves
   `S B/f` unwritten where git writes `H B/f`. Under `false` the same rows are GUARDs.
7. GREEN — `loadSparseMatcher` reads `core.ignorecase`.
8. REFACTOR — none.

### Gate

`./node_modules/.bin/vitest run test/unit/domain/sparse/parse-sparse-checkout.test.ts test/unit/application/primitives/read-sparse-checkout.test.ts test/integration/sequencer-sparse-cone-writes-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/sparse/parse-sparse-checkout.ts src/application/primitives/read-sparse-checkout.ts test/unit/domain/sparse/parse-sparse-checkout.test.ts test/unit/application/primitives/read-sparse-checkout.test.ts test/integration/sequencer-sparse-cone-writes-interop.test.ts && npm run check:spelling && npm run check:test-pyramid`, then `npm run docs:json` (commit reports/api.json).

### Commit

`fix(sparse-checkout): match sparse patterns case-insensitively under core.ignorecase`

## Part 4 — leave a dirty out-of-pattern file in place with git's warning

### Context

**Requirements:** R6 in `materializeTree` (ADR-1213), DC-2 = A, DC-5 = A. Rows: dpsco RED→green
(both ignorecase values); psco GUARD. Every `materializeTree` caller that passes `headTree` +
`sparse` inherits it (checkout switch today; the sequencer clean path from Part 6).

Files this part edits or creates:
- `src/application/primitives/materialize-tree.ts`
- `test/unit/application/primitives/materialize-tree.test.ts`
- `src/application/primitives/internal/sparse-left-dirty.ts` (new)
- `test/unit/application/primitives/internal/sparse-left-dirty.test.ts` (new)
- `test/integration/sequencer-sparse-cone-writes-interop.test.ts`

**Current code (ce3712f7), materialize-tree.ts.**
- `sparseMovers(sparse, index): Set<IndexPathKey>` (lines 424–432): every stage-0 entry the
  matcher rejects plus every skip-worktree entry.
- `partitionCarry(allTarget, stageZero, agreed, movers): CarryPartition` (lines 719–733): a mover
  is never kept, so an out-of-pattern `H` path that head and target agree on leaves the carry,
  `planMaterialize` excludes it, and `computeChangeset` emits a `delete` (index has it, filtered
  target lacks it). Unforced → applyChangeset's dirty guard throws `CHECKOUT_OVERWRITE_DIRTY`
  (dpsco); forced → the file is deleted.
- `CarriedOpts` (lines 411–418) `{ opts, allTarget, carried, removals }`.
- `carryHeadAgreement(ctx, workdir, opts, allTarget): Promise<CarriedOpts>` (lines 805–823):
  early return `{ opts, allTarget, carried: [], removals: [] }` when `headTree` is undefined (no
  movers outside two-way mode).
- `materializeTreeJudging(ctx, options, staleRule)` (lines 924–944): `carry` →
  `planMaterialize` → `classifyChangeset` → `applyChangesetWithAttributes` →
  `assembleIndexEntries`.
- Existing fixture: `describe` around line 1480 with `buildFixture()` (blobs `old new same zed
  staged`; head `b=old, c=same`; target `b=new, c=same, z=zed`; work files `b=old`, `c=same`),
  `indexOf`, `makeIndexEntry`, `refusalOf`, `readWork`, `writeWork`. Add the new rows inside
  `describe('Given the sparse patterns select b only')` (line ~1608, `sparse = (path) => path === 'b'`).

**New module internal/sparse-left-dirty.ts** (shared with Part 8):

```ts
const NOT_UP_TO_DATE_HEADER =
  'The following paths are not up to date and were left despite sparse patterns:\n';
const REAPPLY_HINT =
  '\nAfter fixing the above paths, you may want to run `git sparse-checkout reapply`.';

/** git's verify_uptodate_sparse: an out-of-pattern file whose content differs from its entry stays. */
export const notUpToDate = async (
  ctx: Context,
  workdir: string,
  candidates: ReadonlyArray<IndexEntry>,
): Promise<ReadonlySet<IndexPathKey>> => { /* createWorkingTreeDirtyCheck(ctx); per candidate:
   joinPath(workdir, escapedPathOf(entry)), entry.id → dirty set of indexPathKey */ };

/** One warning, as git prints it, for the out-of-pattern files left in place. */
export const warnLeftDespiteSparse = (ctx: Context, paths: ReadonlyArray<FilePath>): void => {
  if (paths.length === 0) return;
  ctx.logger?.warn?.(`${NOT_UP_TO_DATE_HEADER}${paths.map((p) => `\t${p}\n`).join('')}${REAPPLY_HINT}`);
};
```

- `createWorkingTreeDirtyCheck(ctx): WorkingTreeDirtyCheck` from ../apply-changeset.js (lines
  215–220; absent file = not dirty; content through the check-in conversion). No import cycle:
  apply-changeset.ts does not import this module.
- A lossy entry (`isLossy`, src/domain/git-index/index-path-key.ts) and a gitlink
  (`FILE_MODE.GITLINK`) are never judged dirty: today both reach the delete wave, which already
  skips a lossy path and routes a gitlink to `removeGitlinkDirectory`; keeping them "clean" keeps
  today's verdict. Each gets its own unit row.

**Target in materialize-tree.ts.**
- `CarriedOpts` gains `readonly leftDirty: ReadonlyArray<IndexEntry>` (index order); the early
  return passes `leftDirty: []`.
- In `carryHeadAgreement`, after `sparseMovers`:
  candidates = `stageZero.filter((e) => movers.has(key) && !e.flags.skipWorktree && agreed(key))`
  (only when `opts.sparse !== undefined`); `const dirty = await notUpToDate(ctx, workdir, candidates)`;
  pass `movers` minus `dirty` to `partitionCarry`. A dirty mover is then agreed-kept: carried with
  its own entry (stat kept), filtered out of `allTarget`, never deleted. Keep each new helper < 20
  lines (`dirtyMoversOf(ctx, workdir, { opts, stageZero, movers, agreed })`).
- In `materializeTreeJudging`, after `applyChangesetWithAttributes` returns:
  `warnLeftDespiteSparse(ctx, carry.leftDirty.map(escapedPathOf))`.
- Update the `sparseMovers` JSDoc: a mover that is not up to date stays (git warns).

**Unit rows.** materialize-tree.test.ts (base `buildFixture`; c is out of pattern; write `c` as
`edited` for dirty): unforced dirty c → returns, `c` entry `H` with `blobs.same`, work file
`edited`, warn once with the exact string for `c`; forced (`force: true`) dirty c → same;
clean c → removed, `S` (GUARD); c already skip-worktree → no warn (GUARD).
sparse-left-dirty.test.ts: `notUpToDate` dirty / clean / absent / lossy / gitlink rows (memory
adapter, `buildSeededContext` from test/unit/application/primitives/fixtures.ts); `warnLeftDespiteSparse`
no-op on `[]` (no logger call), two paths in given order → exact string.

**Interop rows** (BASE fixture, cone; recipe step 4 makes a/g present `H`):
- dpsco: dirty a/g, git `checkout -q other` → exit 0, warning, `H a/g` kept dirty, `S a/f`;
  tsgit `repo.checkout({ rev: 'other' })` returns, same index/disk, `warnings` contains the exact
  string for a/g. RED today (`CHECKOUT_OVERWRITE_DIRTY`).
- psco: clean a/g → removed, `S a/g`. GUARD.

**Mutation bucket:** materialize-tree.ts (materialize-tree.test.ts,
materialize-tree-pruning.test.ts), internal/sparse-left-dirty.ts (sparse-left-dirty.test.ts).

### TDD steps

1. RED — sparse-left-dirty.test.ts, all `notUpToDate` and `warnLeftDespiteSparse` rows. Fails:
   the module does not exist.
2. GREEN — create internal/sparse-left-dirty.ts.
3. RED — materialize-tree.test.ts unforced dirty-c row. Fails: throws `CHECKOUT_OVERWRITE_DIRTY`
   with `localChanges: ['c']`.
4. RED — forced dirty-c row. Fails: c's work file is deleted and its entry is `S`.
5. GUARD — clean-c and skip-worktree-c rows (pass: unchanged mover path).
6. RED — interop dpsco under both values. Fails: tsgit refuses where git exits 0.
7. GUARD — interop psco.
8. GREEN — `CarriedOpts.leftDirty`, the candidate filter in `carryHeadAgreement`, the warning in
   `materializeTreeJudging`.
9. REFACTOR — run the whole materialize-tree*, checkout*, reset*, pull*, merge* unit suites
   (`./node_modules/.bin/vitest run test/unit/application/primitives/materialize-tree test/unit/application/commands/checkout test/unit/application/commands/reset test/unit/application/commands/merge test/unit/application/commands/pull`)
   to catch a row that pinned the old refusal; if one exists in checkout.test.ts, it is this
   part's behaviour change — update it in place (it is not a new file).

### Gate

`./node_modules/.bin/vitest run test/unit/application/primitives/materialize-tree.test.ts test/unit/application/primitives/internal/sparse-left-dirty.test.ts test/integration/sequencer-sparse-cone-writes-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/materialize-tree.ts src/application/primitives/internal/sparse-left-dirty.ts test/unit/application/primitives/materialize-tree.test.ts test/unit/application/primitives/internal/sparse-left-dirty.test.ts test/integration/sequencer-sparse-cone-writes-interop.test.ts && npm run check:spelling && npm run check:test-pyramid`, then `npm run docs:json` (commit reports/api.json if it changed).

### Commit

`fix(checkout): leave a dirty out-of-pattern file in place with git's warning`

## Part 5 — check out skipped changes before unstaging on stash apply

### Context

**Requirements:** R5 (ADR-1216), landed before the clean path goes sparse. Rows: st, sta, stu
are added as GUARDs (they match today and must keep matching once Part 6 lands; before Part 6
no merged entry is skip-worktree, so step 2 changes nothing observable yet).

Files this part edits or creates:
- `src/application/commands/stash.ts`
- `src/application/commands/internal/check-out-skipped-changes.ts` (new)
- `test/unit/application/commands/internal/check-out-skipped-changes.test.ts` (new)
- `test/integration/sequencer-sparse-cone-writes-interop.test.ts`

**Current code (ce3712f7), stash.ts.**
- `settleCleanIndex(ctx, lock, newIndexEntries, { currentIndex, stagedTree })` (lines 1362–1375):
  `stagedTree !== undefined` → `reinstateIndex` (R7: unchanged) → return; else
  `const { entries, restagedPaths } = unstageChangesUnlessNew(newIndexEntries, currentIndex.entries);`
  `await lock.commit(entries, 'replace', { restagedPaths });`.
- `settleIndex` runs `settleCleanIndex` only for `kind: 'clean'` (a conflict commits
  `merged.indexEntries` directly: git skips step 2 on conflict, scf3).
- Reached by `stashApply`/`stashPop`, `applyAutostash` (line 1228), `applyMergeAutostash` (line
  1244) — all without `--index`.
- unstage-changes-unless-new.ts (read-only): `unstageChangesUnlessNew(merged, before)` restores a
  changed path to its `before` entry with zeroed stat and `STAGE0_FLAGS` (bit cleared) and keeps
  an added path's merged entry as is — so step 2 must clear the bit and stat the file first.

**New module commands/internal/check-out-skipped-changes.ts.**

```ts
/** git's unstage_changes_unless_new step 2: a path the merge changed but left skip-worktree is checked out and loses its bit. */
export const checkOutSkippedChanges = async (
  ctx: Context,
  merged: ReadonlyArray<IndexEntry>,
  before: ReadonlyArray<IndexEntry>,
): Promise<ReadonlyArray<IndexEntry>>
```

- Changed = stage 0, `flags.skipWorktree`, and no stage-0 `before` entry with the same
  `indexPathKey` and the same `id` AND `mode` (absent → added → changed).
- Writer, built once and lazily (no "nothing changed" early return: the writer's provider and
  settings are already lazy, so a guard would be an equivalent mutant):

```ts
createWorkingTreeWriter(ctx, {
  provider: lazily(() => buildAttributeProvider(ctx, { kind: 'index-first', index: attributeBlobLookup(merged) })),
  settings: lazily(() => readEolSettings(ctx)),
  limiter: limiterFor(ctx, 'cpuBound'),
});
```

  Imports: `createWorkingTreeWriter` (../../primitives/internal/write-converted-entry.js),
  `attributeBlobLookup`, `buildAttributeProvider` (../../primitives/internal/read-gitattributes.js),
  `lazily` (../../primitives/internal/lazily.js), `limiterFor` (../../primitives/internal/concurrency.js),
  `readEolSettings` (../../primitives/resolve-conversion.js), `withStatData`
  (../../primitives/internal/index-entry-from-stat.js). Same recipe as
  apply-merge-to-worktree.ts `createMergeResultWriter` (lines 433–444).
- Per changed entry, in index order (sequential `for…of`): `const stat = await
  writer.writeBlob(escapedPathOf(entry), entry.id, entry.mode)`; the entry with
  `flags: { ...entry.flags, skipWorktree: false }`, plus `withStatData(…, stat)` when `stat` is
  defined. `writeBlob` returns `undefined` for a symlink (and an escaped path): keep the zero stat.
- No `.stash.XXXXXX` relocation branch: unreachable (design §5, row stu).
- stash.ts: `settleCleanIndex` no-`--index` branch becomes
  `const checkedOut = await checkOutSkippedChanges(ctx, newIndexEntries, currentIndex.entries);`
  then `unstageChangesUnlessNew(checkedOut, currentIndex.entries)`.

**Unit rows** (memory adapter; blobs via `writeObject`; index entries built like
test/unit/application/primitives/apply-merge-to-worktree.test.ts `indexEntry` lines 52–70):
changed `S` entry → file holds the blob, bit cleared, `fileSize` = byte length; added `S` entry →
written, cleared; same id+mode `S` entry → untouched, no file; mode-only change `S` (regular →
executable, same id) → written (kills `&&`→`||` in the same-content test); `H` changed entry →
untouched (no write); `S` changed symlink → link created, zero stat, bit cleared; merged entries
carrying a `.gitattributes` blob `* text eol=crlf` → the written file has CRLF (proves index-first
attributes from `merged`).

**Interop rows** (GUARD this part): st (stash made with the full work tree changes a/f+b/f,
then cone + `read-tree -mu HEAD`, `stash apply`: `H a/f` written f2, unstaged), sta (stash adds
staged a/n + edits b/f), stu (st shape + untracked `junk` file at a/f: git exit 128 with
"would be overwritten", tsgit `STASH_APPLY_WOULD_OVERWRITE`). Build the stash in both twins with
git (`git stash push` before enabling sparse). tsgit: `repo.stash.apply()`.

**Mutation bucket:** commands/internal/check-out-skipped-changes.ts
(check-out-skipped-changes.test.ts); stash.ts `settleCleanIndex` (stash.test.ts,
stash-unmerged-index.test.ts).

### TDD steps

1. RED — check-out-skipped-changes.test.ts, every unit row. Fails: the module does not exist.
2. GREEN — create the module.
3. GUARD — interop st, sta, stu (match today; recorded so Part 6 cannot regress them).
4. GREEN — wire `checkOutSkippedChanges` into `settleCleanIndex`.
5. GUARD — `./node_modules/.bin/vitest run test/unit/application/commands/stash test/unit/application/commands/internal/unstage-changes-unless-new.test.ts`
   stays green (no merged entry is skip-worktree without sparse, so step 2 is a no-op).
6. REFACTOR — none.

### Gate

`./node_modules/.bin/vitest run test/unit/application/commands/internal/check-out-skipped-changes.test.ts test/unit/application/commands/stash.test.ts test/integration/sequencer-sparse-cone-writes-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/stash.ts src/application/commands/internal/check-out-skipped-changes.ts test/unit/application/commands/internal/check-out-skipped-changes.test.ts test/integration/sequencer-sparse-cone-writes-interop.test.ts && npm run check:spelling && npm run check:test-pyramid`, then `npm run docs:json` (commit reports/api.json if it changed).

### Commit

`fix(stash): check out skipped changes before unstaging on apply`

## Part 6 — replay a clean merge sparse-aware in applyMergeToWorktree

### Context

**Requirements:** R1, R7, R9, R10 (ADR-1215). Rows turned green (both ignorecase values unless
noted): cp, rv, nc, mv, add, rb, rm, wt, rng (two-commit cherry-pick), pscp, dpscp, stps, sp,
case, casenc. GUARDs: del; st, sta, stu (now exercising Part 5's step 2 for real).

Files this part edits or creates:
- `src/application/primitives/apply-merge-to-worktree.ts`
- `test/unit/application/primitives/apply-merge-to-worktree.test.ts`
- `test/integration/sequencer-sparse-cone-writes-interop.test.ts`

**Current code (ce3712f7), apply-merge-to-worktree.ts.**
- `applyMergeToWorktree(ctx, input: ApplyMergeInput): Promise<ApplyMergeResult>` (lines 507–574):
  flatten → renames → `mergeEscapedTrees` → `rejectUnsupported` → `changedPaths` →
  `findWouldOverwrite` (returns `would-overwrite`) → clean branch (lines 557–572):
  `materializeTree(ctx, { targetTree: mergedTree, currentIndex: input.currentIndex, headTree: input.oursTree, force: true })`
  (no `sparse`), `writeAutoMerge`, `keepsStagedChanges` → `indexTree` → else
  `materialiseConflict(ctx, merged, changed, input.currentIndex)`.
- Consumers (read-only): src/application/commands/internal/replay-sequence.ts `replayMerge`
  (cherry-pick, revert, rebase picks), src/application/commands/internal/rebase-merges-steps.ts
  `mergeIntoLockedIndex`, src/application/commands/stash.ts `mergeStash`.

**Target.**
- Import `loadSparseMatcher` from ./read-sparse-checkout.js.
- After the `would-overwrite` return: `const sparse = await loadSparseMatcher(ctx);` (pure read;
  every caller already holds the index lock). Clean branch:
  `...(sparse !== undefined ? { sparse } : {})` in the `materializeTree` options
  (`exactOptionalPropertyTypes`). The conflict branch stays as is in this part.
- Update the module JSDoc (lines 1–17): the clean outcome honours the sparse patterns.
- `keepsStagedChanges` / `unchangedCount`: unchanged (a skip-worktree entry changes no id/mode).
- Dirty movers: handled by Part 4 inside `materializeTree` (forced or not) — dpscp needs no code
  here. Case: handled by Part 3.

**Unit rows** (new top-level `describe('Given sparse checkout selects b only')` in
apply-merge-to-worktree.test.ts; hoist `configure` to module scope and add a `withCone(ctx)`
helper writing the config + pattern file; fixture trees via `treeWith`/`treeEntry` with nested
paths a/f, b/f):
- excluded change: theirs changes a/f and b/f → `result.result.newIndexEntries` has a/f
  `skipWorktree: true` with theirs' id, no work file a/f, b/f written;
- excluded add a/n → `S`, no file;
- rename leaving `b/f → a/h` → a/h `S`, unwritten; rename entering `a/g → b/g` (with a/g
  `S` in the current index) → b/g written `H`;
- per-call load: a first call with pattern /b/ leaves a/f `S`; rewrite the pattern file to
  `/*\n!/*/\n/a/\n/b/\n`, a second call (new change to a/x) writes a/x `H`;
- GUARD: excluded delete → no entry, no file; sparse off (no config) → a/f written `H` (R10);
  `mergedTree` and `indexTree` oids equal a sparse-off run's on the same trees.

**Interop rows** (BASE fixture unless noted; expected = design Axes 1, 3, 4, 5):
- cp: `cherry-pick other` / `repo.cherryPick.run({ commits: ['other'] })`.
- rv: a commit `c1` on main changing a/f+b/f, then `revert HEAD` / `repo.revert.run({ commits: ['HEAD'] })`.
- nc: cp under `NON_CONE_FILE` with `core.sparseCheckoutCone false`.
- mv: `other` renames `a/g→b/g` and `b/f→a/h` (identical content).
- add: `other` adds a/n and b/n.
- del (GUARD): `other` deletes a/f.
- rb: branch `topic` changes a/f+b/f, `main` advanced by an unrelated `top` change; on
  `topic`: `rebase main` / `repo.rebase.run({ upstream: 'main' })`.
- rm: `side` changes a/f, merged into `topic` with a merge commit; `rebase --rebase-merges main`
  / `repo.rebase.run({ upstream: 'main', rebaseMerges: true })`.
- wt: `git worktree add ../wt-<twin> -b wt main` in each twin, then in the worktree
  `sparse-checkout set b` (writes `config.worktree`), then cherry-pick there; tsgit opens
  `openRepository({ cwd: <worktree> })`. Compare the worktree's index and listing.
- rng: `cherry-pick <c1> <c2>` (two commits each changing a/f and b/f) /
  `repo.cherryPick.run({ commits: [c1, c2] })`.
- pscp: recipe step 4 (a/g present clean), cp → a/g removed `S`, `S a/f`.
- dpscp: same with dirty a/g → exit 0, warning, `H a/g` kept dirty.
- stps: stash changes a/f; present clean a/g; plain `stash apply` → a/g removed `S`,
  `H a/f` written.
- sp: stash with a/f staged+modified and b/f modified; `stash pop --index` /
  `repo.stash.pop({ index: true })` (verify the option name in src/application/commands/stash.ts
  `StashApplyInput`) → `S a/f` (index f2) unwritten, `H b/f`.
- case, casenc: CASE fixture, cherry-pick `other`, cone and non-cone.

**Mutation bucket:** apply-merge-to-worktree.ts (apply-merge-to-worktree.test.ts).

### TDD steps

1. RED — unit excluded-change row. Fails: `a/f` written, entry `skipWorktree: false`.
2. RED — unit excluded-add and rename rows. Fail the same way.
3. RED — unit per-call row. Fails at its first call (`a/f` written).
4. GUARD — unit delete, sparse-off and oid rows.
5. RED — interop rows above (except del). Fail: tsgit writes the out-of-pattern paths `H`.
6. GREEN — Target code.
7. GUARD — del, st, sta, stu stay green (st/sta now go through step 2).
8. REFACTOR — none; run `./node_modules/.bin/vitest run test/unit/application/commands/internal/replay-sequence.test.ts test/unit/application/commands/internal/rebase-merges-steps.test.ts test/unit/application/commands/stash.test.ts`
   (memory contexts without sparse config: unchanged).

### Gate

`./node_modules/.bin/vitest run test/unit/application/primitives/apply-merge-to-worktree.test.ts test/integration/sequencer-sparse-cone-writes-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/apply-merge-to-worktree.ts test/unit/application/primitives/apply-merge-to-worktree.test.ts test/integration/sequencer-sparse-cone-writes-interop.test.ts && npm run check:spelling && npm run check:test-pyramid`, then `npm run docs:json` (commit reports/api.json if it changed).

### Commit

`fix(sequencer): leave out-of-pattern paths skip-worktree on a clean replay`

## Part 7 — keep out-of-pattern clean outcomes unwritten at a conflict stop

### Context

**Requirements:** R2, R3 for `applyMergeToWorktree`'s conflict path (ADR-1211), DC-4 = A. Rows
turned green: cf2, cf3, cf3rb, scf3. GUARDs: cf, dt.

Files this part edits or creates:
- `src/application/primitives/apply-merge-to-worktree.ts`
- `test/unit/application/primitives/apply-merge-to-worktree.test.ts`
- `test/integration/sequencer-sparse-cone-writes-interop.test.ts`

**Current code (ce3712f7), apply-merge-to-worktree.ts.**
- `blobBackedEntries(outcomes)` (lines 127–132): `unchanged`/`resolved-known` → `stage0Entry`.
- `writeConflictWorktree(ctx, outcomes, conflicts, changed)` (lines 311–339): `touched` = non-conflict
  outcomes whose path is in `changed`; deletions first (with `survivingPathsOf(touched, conflicts)`),
  `removeDisplacedFile`, writer, write every non-deleted `touched`, then every conflict.
- `buildUnmergedIndex(outcomes, conflicts, merged)` (lines 342–353).
- `materialiseConflict(ctx, merged, changed, currentIndex)` (lines 463–492):
  `validateMergeWritePaths(…, changed)` → `writeConflictWorktree(…, changed)` →
  `mergedBlobEntries` → `writeAutoMerge(conflictResultTree(…))` →
  `withConflictStopStats(ctx, buildUnmergedIndex(…), currentIndex, changed)`.
- `withConflictStopStats` (src/application/primitives/internal/stat-conflict-index.ts lines
  20–39, read-only): `lstat`s every stage-0 path in `written`, else carries the prior entry when
  id+mode agree. An unwritten path in `written` throws `FILE_NOT_FOUND`.
- `skipWorktreeEntry(entry: IndexPath & { id; mode })` (src/domain/git-index/index-entry.ts
  lines 137–154) keeps `pathBytes`; pass the `IndexEntry` itself.

**Target.**

```ts
/** True when sparse checkout is on and the patterns exclude the path. */
const isExcluded = (sparse: SparseMatcher | undefined, path: FilePath): boolean =>
  sparse !== undefined && !sparse(path);

/** git writes a clean outcome only inside the patterns; a conflict always is written. */
const isMaterialised = (outcome: ChangedOutcome, sparse: SparseMatcher | undefined): boolean =>
  !isExcluded(sparse, outcome.path);

/** The changed paths the conflict stop writes or removes: an excluded clean write is dropped. */
const materialisedPaths = (outcomes, changed, sparse): ReadonlySet<FilePath> => …;
```

- `materialiseConflict(ctx, merged, changed, currentIndex, sparse: SparseMatcher | undefined)`
  (file-private, so the extra parameter is no boolean-parameter smell); `applyMergeToWorktree`
  passes Part 6's `sparse`.
- `materialisedPaths` = `changed` minus every non-conflict, non-deleted outcome path with
  `!isMaterialised(outcome, sparse)`. Deleted outcomes stay (a deletion still removes its file).
- Pass `materialisedPaths` (not `changed`) to `writeConflictWorktree` and to
  `withConflictStopStats`. `writeConflictWorktree`'s body is then unchanged: its `touched` no
  longer holds excluded writes, so they are not written and do not keep a directory alive in
  `survivingPathsOf`. `validateMergeWritePaths` keeps `changed` (git verifies every path).
- `buildUnmergedIndex(outcomes, conflicts, merged, sparse)`: map every stage-0 entry
  (`blobBackedEntries` and `merged`) whose `escapedPathOf(entry)` `isExcluded` to
  `skipWorktreeEntry(entry)`. Conflict stages unchanged (no bit: cf, dt).
- `conflictResultTree` / `writeAutoMerge` unchanged: AUTO_MERGE still records every blob.
- A changed excluded path whose prior entry is `H` (a file on disk) keeps its old file until
  Part 8 retires it; no pinned row covers that shape in between.
- An unchanged excluded path whose prior entry is `H` (a mover): its built `S` entry is replaced
  by the prior `H` entry in `withConflictStopStats` (same content) — today's state, fixed by Part 8.
- Imports: `SparseMatcher` type from ../../domain/sparse/index.js, `skipWorktreeEntry` from
  ../../domain/git-index/index.js (check the barrel exports it; else index-entry.js).

**Unit rows** (apply-merge-to-worktree.test.ts, under the Part 6 describe or a sibling
`describe('Given sparse checkout selects b only and b/f conflicts')`; one-line b/f bodies
conflict):
- blob-backed excluded (a/f take-theirs, prior `S`) → entry `S` with theirs' id, no file, no
  `FILE_NOT_FOUND` (kills the `materialisedPaths` → `changed` mutant);
- line-merged excluded (a/f base `1..5`, ours edits line 1, theirs line 5) → entry `S` whose id
  is the merged blob (assert against `mergedBlobEntries`-style expectation: hash
  `1\n…` merged bytes with `writeObject`), no file; AUTO_MERGE's tree holds the same blob;
- deletion a/x + excluded write a/y in the same directory → directory `a` pruned;
- GUARD: conflict on an excluded path → markers written, stages 1/2/3 without the bit; sparse off
  → unchanged; an excluded unchanged path with a prior `S` entry keeps that entry.

**Interop rows** (BASE + conflict variants; expected = design Axis 2): cf2 (cherry-pick, b/f
conflicts, a/f take-theirs), cf3 (a/f line-merged), cf3rb (cf3 shape as `rebase main`; git exit
1, tsgit rebase stops), scf3 (cf3 shape via `stash apply` with a conflicting stash; tsgit
`kind: 'conflict'`), cf (GUARD: a/f itself conflicts), dt (GUARD: a/f file→symlink vs edit,
`it.skipIf(!GIT_AVAILABLE || process.platform === 'win32')`). Compare the merged blob oid of a/f
between twins via `ls-files -s`.

**Mutation bucket:** apply-merge-to-worktree.ts (apply-merge-to-worktree.test.ts).

### TDD steps

1. RED — unit blob-backed excluded row. Fails: `a/f` written, entry `H`.
2. RED — unit line-merged excluded row. Fails: written, entry `H`.
3. RED — unit deletion + excluded write row. Fails: `a/y` written keeps `a` alive.
4. RED — interop cf2, cf3, cf3rb, scf3. Fail: tsgit writes `a/f` `H`.
5. GUARD — unit conflict/sparse-off/prior-`S` rows; interop cf, dt.
6. GREEN — Target code.
7. REFACTOR — `materialiseConflict` < 20 lines (extract `stopIndexEntries` if needed).

### Gate

`./node_modules/.bin/vitest run test/unit/application/primitives/apply-merge-to-worktree.test.ts test/integration/sequencer-sparse-cone-writes-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/apply-merge-to-worktree.ts test/unit/application/primitives/apply-merge-to-worktree.test.ts test/integration/sequencer-sparse-cone-writes-interop.test.ts && npm run check:spelling && npm run check:test-pyramid`, then `npm run docs:json` (commit reports/api.json if it changed).

### Commit

`fix(sequencer): keep out-of-pattern clean paths unwritten at a conflict stop`

## Part 8 — retire clean out-of-pattern files at a conflict stop

### Context

**Requirements:** R4 and R6 on `applyMergeToWorktree`'s conflict path (ADR-1212, ADR-1213), DC-3 = A.
Rows turned green: pscf, dpscf.

Files this part edits or creates:
- `src/application/primitives/internal/sparse-movers.ts` (new)
- `test/unit/application/primitives/internal/sparse-movers.test.ts` (new)
- `src/application/primitives/apply-merge-to-worktree.ts`
- `test/unit/application/primitives/apply-merge-to-worktree.test.ts`
- `test/integration/sequencer-sparse-cone-writes-interop.test.ts`

**New module internal/sparse-movers.ts** (also used by merge.ts in Part 9):

```ts
/** What a conflict stop did to the out-of-pattern files the index still shows. */
export interface SparseRetirement {
  /** Removed from the work tree: their stage-0 entries take the skip-worktree bit. */
  readonly retired: ReadonlySet<IndexPathKey>;
  /** Kept because not up to date: their entries stay as they are. */
  readonly leftDirty: ReadonlySet<IndexPathKey>;
}
export const NOTHING_RETIRED: SparseRetirement;

/** git's sparse loop on a conflict stop: an out-of-pattern file the patterns now hide leaves the work tree unless it holds local changes. */
export const retireSparseMovers = async (
  ctx: Context,
  scope: { readonly currentIndex: GitIndex; readonly conflicts: ReadonlyArray<MergeConflict> },
  sparse: SparseMatcher | undefined,
): Promise<SparseRetirement>;

/** The stop's index with every retired path skip-worktree. */
export const withRetiredSkipped = (
  entries: ReadonlyArray<IndexEntry>,
  retirement: SparseRetirement,
): ReadonlyArray<IndexEntry>;
```

- `sparse === undefined` → `NOTHING_RETIRED`, no fs call.
- Candidates: stage-0 `currentIndex` entries with `!flags.skipWorktree`, `!sparse(escapedPathOf(e))`,
  `!isLossy(e)`, `mode !== FILE_MODE.GITLINK`, and a path not recorded by any conflict
  (`conflict.path` and `recordedPaths(conflict)` from src/domain/diff/index.js: a conflict is
  always written). Changed candidates are included: Part 7 skipped their write and
  `findWouldOverwrite` already refused a dirty changed path.
- `const dirty = await notUpToDate(ctx, workdir, candidates)` (Part 4's internal/sparse-left-dirty.ts).
- Clean candidates: `removeWorkingTreeFile(ctx, path)` (src/application/primitives/internal/write-working-tree-file.ts
  lines 350–354; tolerant of an absent file), then one
  `pruneEmptiedDirectories(ctx, workdir, removedPaths, survivingDirectoriesOf([]))`
  (src/application/primitives/internal/prune-emptied-directories.ts; an empty surviving set is safe
  because the pass runs after every write and pruning only removes empty directories).
- `warnLeftDespiteSparse(ctx, dirtyEntries.map(escapedPathOf))` (index order).
- `workdir` = `requireWorkTree(ctx, 'merge')` (src/application/primitives/internal/repo-state.ts).
- `withRetiredSkipped`: stage-0 entries whose `indexPathKey` is in `retired` →
  `skipWorktreeEntry(entry)`; others unchanged.

**Target in apply-merge-to-worktree.ts `materialiseConflict`:** after `writeConflictWorktree`,
`const retirement = await retireSparseMovers(ctx, { currentIndex, conflicts: merged.conflicts }, sparse);`
and wrap the index: `withRetiredSkipped(await withConflictStopStats(…), retirement)`. A clean
untouched mover keeps its id/mode (its `unchanged` outcome) and gains the bit; a changed one takes
the result's (already `S` from Part 7); a dirty one keeps its prior `H` entry (the stat carry).

**Unit rows.** sparse-movers.test.ts (memory adapter, cone matcher `(p) => p.startsWith('b/') || !p.includes('/')`):
clean mover removed + retired + its emptied directory pruned; dirty mover kept + in `leftDirty` +
one exact warning; skip-worktree entry ignored; in-pattern entry ignored; conflict-recorded path
ignored; absent file → retired, no throw; lossy entry ignored; gitlink ignored; `sparse`
undefined → `NOTHING_RETIRED` and `ctx.fs.rm` never called; `withRetiredSkipped` marks only
retired stage-0 entries. apply-merge-to-worktree.test.ts: b/f conflicts, present clean a/g
(prior `H`) → a/g removed, entry `S` with its id; dirty a/g → kept, entry `H`, one exact warn.

**Interop rows** (BASE + conflict on b/f; recipe step 4): pscf (clean a/g → removed `S`,
`S a/f`, stages b/f), dpscf (dirty a/g → git exit 1 with the warning, `H a/g` dirty kept;
tsgit `kind: 'conflict'` + warning).

**Mutation bucket:** internal/sparse-movers.ts (sparse-movers.test.ts),
apply-merge-to-worktree.ts (apply-merge-to-worktree.test.ts).

### TDD steps

1. RED — sparse-movers.test.ts, all rows. Fails: the module does not exist.
2. GREEN — create the module.
3. RED — apply-merge clean-mover row. Fails: `a/g` stays on disk, entry `H`.
4. RED — apply-merge dirty-mover row. Fails: no warning.
5. RED — interop pscf, dpscf. Fail: tsgit leaves `H a/g` (and no warning).
6. GREEN — wire `retireSparseMovers` + `withRetiredSkipped` into `materialiseConflict`.
7. REFACTOR — `retireSparseMovers` split into < 20-line helpers (`moverCandidates`,
   `removeRetired`).

### Gate

`./node_modules/.bin/vitest run test/unit/application/primitives/internal/sparse-movers.test.ts test/unit/application/primitives/apply-merge-to-worktree.test.ts test/integration/sequencer-sparse-cone-writes-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/sparse-movers.ts src/application/primitives/apply-merge-to-worktree.ts test/unit/application/primitives/internal/sparse-movers.test.ts test/unit/application/primitives/apply-merge-to-worktree.test.ts test/integration/sequencer-sparse-cone-writes-interop.test.ts && npm run check:spelling && npm run check:test-pyramid`, then `npm run docs:json` (commit reports/api.json if it changed).

### Commit

`fix(sequencer): retire clean out-of-pattern files at a conflict stop`

## Part 9 — merge stages excluded line-merged paths skip-worktree and retires movers

### Context

**Requirements:** R3 and R4 for `merge` (ADR-1211 supersedes ADR-076's resolved-merged clause;
ADR-1212 for both merge conflict writers; ADR-1213 for a dirty mover). Rows turned green: mcf3,
mpscf, dmpscf (merge conflict + dirty a/g), ompscf (octopus conflict + clean a/g). GUARDs:
mcf2, mg.

Files this part edits or creates:
- `src/application/commands/merge.ts`
- `test/unit/application/commands/merge.test.ts`
- `src/application/primitives/apply-merge-to-worktree.ts`
- `test/integration/sequencer-sparse-cone-writes-interop.test.ts`

**Current code (ce3712f7), merge.ts.**
- `isExcluded` (lines 2049–2051), `ChangedOutcome` (line 2053), `isMaterialised` (lines
  2055–2056: `outcome.status === 'resolved-merged' || !isExcluded(…)`), `survivingFor` (lines
  2059–2072), `writeConflictingWorkingTree(ctx, outcomes, conflicts, changed, matcher)` (lines
  ~2096–2140), `outcomeWave` (uses `isMaterialised` for `needsDirectories`).
- `writeOutcomeToTree(outcome, matcher, writer, scanner?)` (exported, lines ~2211–2231): writes a
  `resolved-merged` outcome regardless of the matcher; JSDoc states ADR-076's rule.
- `buildConflictIndexEntries(outcomes, conflicts, matcher, merged)` (exported, lines 2316–…):
  `merged` entries staged as is (no bit); excluded `unchanged`/`resolved-known` → `skipWorktreeEntry`.
- `writeConflictState` (lines ~1933–1960) and `persistOctopusConflict` (lines 1554–1576) both:
  `loadSparseMatcher` → `underIndexLock(ctx, async () => { await writeConflictingWorkingTree(…, matcher);
  await writeStopState(…); return buildConflictIndexEntries(…, matcher, …); })`.
- No `currentIndex` is in scope inside either lock callback: read it with `await readIndex(ctx)`
  inside the callback, before `writeConflictingWorkingTree` (the lock is not committed yet, so it
  is the pre-merge index; `readIndex` is already imported, line 1210 uses it).
- Why tsgit shows `H a/g` on mpscf today: `buildConflictIndexEntries` already marks the unchanged
  excluded a/g skip-worktree, but its file stays on disk, and git clears the bit of a present
  file when it reads the index. So the fix is the removal (and, for a dirty file, keeping `H`).

**Target.**
- apply-merge-to-worktree.ts: `export` `isExcluded` and `isMaterialised` (Part 7's), and
  `export type ChangedOutcome` if TypeScript needs the name in merge.ts.
- merge.ts: delete its `isExcluded`, `ChangedOutcome` (if now imported) and `isMaterialised`;
  import them from ../primitives/apply-merge-to-worktree.js (same import statement as
  `survivingPathsOf`, line 73). `survivingFor` and `outcomeWave` then follow the shared rule
  without edits.
- `writeOutcomeToTree`: `if (isExcluded(matcher, outcome.path)) return;` before both writes, so
  an excluded `resolved-merged` outcome is not written. Rewrite the JSDoc: a clean outcome is
  written only inside the patterns (its line-merged bytes are already a blob in the index); no
  ADR reference in the comment.
- `buildConflictIndexEntries`: each `merged` entry whose path `isExcluded` →
  `skipWorktreeEntry(entry)`. Drop the comment line saying merged paths are staged as written.
- Both lock callbacks: `const retirement = await retireSparseMovers(ctx, { currentIndex, conflicts }, matcher);`
  after `writeConflictingWorkingTree`, then pass `keepingLeftDirty(matcher, retirement.leftDirty)`
  to `buildConflictIndexEntries`, where
  `keepingLeftDirty = (matcher, leftDirty) => matcher === undefined || leftDirty.size === 0 ? matcher : (path) => matcher(path) || leftDirty.has(keyOfPath(path))`
  (`keyOfPath` from src/domain/git-index/index-path-key.ts, as materialize-tree.ts uses it). A
  dirty mover therefore stays `H`; a retired one is already `S` (excluded `unchanged`). If the
  ternary leaves an untestable arm, split it into two named functions with one test each.
- Octopus: same helper in `persistOctopusConflict` (ADR-1212 names merge's conflict writers);
  its `conflicts` = `result.conflicts`.

**Unit rows** (merge.test.ts):
- edit `describe('Given a resolved-merged outcome whose path the sparse matcher excludes')`
  (line ~3926) → `Then the file is not written` (`ctx.fs.exists(<workDir>/drop.txt)` false);
- `buildConflictIndexEntries (direct)` (line ~3702): a `merged` entry on an excluded path →
  `skipWorktree: true`, same id; an in-pattern merged entry → no bit (GUARD);
- a merge-run row with sparse config (find the existing sparse merge rows with
  `command grep -n "sparseCheckout" test/unit/application/commands/merge.test.ts`): conflict on
  b/f, present clean a/g → removed and `S`; dirty a/g → kept `H`, one exact warning. Cover
  the octopus callback the same way if a memory-adapter octopus row exists in the suite
  (`command grep -n "octopus" test/unit/application/commands/merge.test.ts`); otherwise the
  interop row ompscf plus `test:coverage` decide whether a unit row is needed.

**Interop rows** (expected = design Axis 2/5; tsgit via `repo.merge.run({ rev: 'other', message: 'm', author: AUTHOR })`):
mcf3 (RED), mpscf (RED), dmpscf (RED: git keeps `H a/g` dirty with the warning; tsgit has no
warning today), ompscf (RED: `git merge other1 other2` where `other2` conflicts on b/f, present
clean a/g; tsgit `repo.merge.run({ revs: [...] })` — check the octopus option name in
src/application/commands/merge.ts `MergeInput`; unpinned by the design, so this row IS the pin: if
git keeps a/g, stop and report `{ unit: 'ompscf', reason, options }`), mcf2 (GUARD), mg (GUARD).

**Mutation bucket:** merge.ts touched functions (`writeOutcomeToTree`,
`buildConflictIndexEntries`, `writeConflictState`, `persistOctopusConflict`, `keepingLeftDirty`;
suite merge.test.ts), apply-merge-to-worktree.ts exports.

### TDD steps

1. RED — edited writeOutcomeToTree row. Fails: `drop.txt` is written (`MERGED`).
2. RED — buildConflictIndexEntries excluded-merged row. Fails: entry has `skipWorktree: false`.
3. RED — merge-run clean-mover and dirty-mover rows. Fail: `a/g` stays on disk / is marked `S`
   with no warning.
4. RED — interop mcf3, mpscf, dmpscf, ompscf. GUARD — mcf2, mg.
5. GREEN — Target code.
6. REFACTOR — delete merge.ts's now-dead local predicates; `writeConflictState` and
   `persistOctopusConflict` < 20 lines (extract `conflictIndexUnderLock` if both grow).

### Gate

`./node_modules/.bin/vitest run test/unit/application/commands/merge.test.ts test/unit/application/primitives/apply-merge-to-worktree.test.ts test/integration/sequencer-sparse-cone-writes-interop.test.ts test/integration/sparse-reset-merge.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/merge.ts src/application/primitives/apply-merge-to-worktree.ts test/unit/application/commands/merge.test.ts test/integration/sequencer-sparse-cone-writes-interop.test.ts && npm run check:spelling && npm run check:test-pyramid`, then `npm run docs:json` (commit reports/api.json if it changed). Phase gate after this part: `npm run validate`.

### Commit

`fix(merge): stage excluded line-merged paths skip-worktree and retire clean movers`
