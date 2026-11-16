# Plan — long-pathspec-refusals

> Source: design doc `docs/design/long-pathspec-refusals.md` · ADRs 1191, 1192, 1193, 1194, 1195, 1196
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

**Rulings this plan is written against.** D1 = delete both pathspec budgets. D2 = remove
both length caps from all three validators. D3 = `add` reads `PATH_TOO_LONG` on its
pathspec probes as "absent", via a new `lstatPathspecBody` plus a fold inside
`assertNoSymlinkedLeadingPath` (whose only caller is add.ts). D4 = `mv` re-raises
`pathTooLong(<destination, repo-relative>)` when the rename fails too long; row M5 keeps
`MV_DESTINATION_DIRECTORY_MISSING`. D5 = no warning field. D6 = every code commit is
`fix(<scope>): …`, never `fix!:`.

**Why six parts, not four.** Removing both validator caps in one part touches 7 files
(working-tree-path.ts, its unit test, its new property test, working-tree.test.ts,
walk-working-tree.test.ts, resolve-pathspec.test.ts, the interop file), which is over the
6-file ceiling. The caps are two independent guards, so they land as two slices: Part 2
removes the 4096-byte total cap (P5000 rows), Part 3 removes the 255-byte component cap
(S300 / CJK100 rows). Consequences:

- The resolve-pathspec property suite is created in Part 1 with a generator that stays
  inside both caps (still live at that step): ASCII components of 1–100 chars, 1–40 of
  them, so the total is at most 4039 bytes. Part 4, which edits resolve-pathspec.ts again,
  widens it to the design's subset (GUARD).
- The design's "300-byte single component" resolve row cannot pass before Part 3. It
  lands in Part 4 as a GUARD.
- `validatePathspecBody`'s doc comment loses "length" in Part 4, the next part that edits
  resolve-pathspec.ts.

The same files therefore recur across parts on purpose (plan-lint's cognitive-locality
warnings): resolve-pathspec.ts in Parts 1 and 4 (budget, then probe fold), its unit test in
Parts 1, 2 and 4, and working-tree-path.ts with its three unit suites in Parts 2 and 3
(total cap, then component cap). Merging them would put a part over the 6-file ceiling.
Parts are sequential on one working tree, so each starts from the previous commit.

**Public-surface decision: nothing new is public.** Every new symbol is module-private
(not exported): `lstatPathspecBody` and a `PATH_TOO_LONG` constant in add.ts,
`beyondSymlink` and a `PATH_TOO_LONG` constant in resolve-pathspec.ts, `moveOnDisk` and a
`PATH_TOO_LONG` constant in mv.ts. No error code is added or removed, no field changes,
and no barrel, facade, `Repository` member or result type changes. So: no exhaustiveness
switch, no barrel-surface test, no `docs/use/commands/README.md` row, no
`check:doc-coverage` page, no browser-surface scenario, and no `reports/api.json`
regeneration. If an implementer finds an export is needed after all, that is a blocker:
report `{ unit, reason, options }` and do not add it silently.

**Test conventions (every part).** `describe('Given …')` > `describe('When …')` >
`it('Then …')`. The 2-level `describe('Given …, When …')` > `it('Then …')` is allowed when
only one expectation lives under the When. Use AAA section comments (`// Arrange`,
`// Act`, `// Assert`). `sut` is the FUNCTION under test (`const sut = add;` then
`await sut(ctx, …)`). Never bind a result to `sut`: the test-pyramid gate
`sutBindsResult` fails on it. Assert errors on their data with try/catch or the file's
`expectError` helper plus `toEqual(<factory>(…).data)`, never `toThrow(Class)` alone.
Write one guard test per condition. Coverage is 100% (lines, branches, functions,
statements). No suppression directive of any kind may be added. The two existing
`Stryker disable` marks that survive (in `rejectInputShape` and on the
`rejectTraversalShape` loop) may only have their reason text edited. No provenance refs
(ADR, backlog, phase or design-row numbers) in source or test titles or comments. Row ids
such as `B1` may appear only as an `id` data field in an `it.each` table.

**TDD discipline (memory: agents batched REDs and wrote GREEN first).** Write one RED per
function and run it before you write that function's code. Record the failing reason you
saw, and check it matches the reason this plan predicts. Any test listed here as GUARD
must pass when it is written. If a GUARD is red at its step, stop: it is a RED the plan
mis-classified. Report it in the part's commit hand-off and make it green with the part's
GREEN. Never widen scope to do so.

**Matrix rows, not summaries (lesson 037).** Each part names the design rows (by the
design's ids: B1–B9, T1–T4, C1–C9, I1–I4, K1–K6, M1–M7) it turns green (RED) or
re-pins (GUARD). The interop twin is self-pinning: git runs the same verb on its twin, so
never hard-code a git result the twin can produce live.

**Interop harness (created in Part 1, extended by Parts 2–5).** One file:
test/integration/pathspec-length-interop.test.ts. Model it on
test/integration/pathspec-backslash-interop.test.ts. Read that file first. Do not copy
its helpers verbatim; jscpd scans only src/, but keep the helpers small anyway. Header:

```ts
/**
 * Cross-tool interop — a pathspec or a working-tree path is never refused for its
 * length: git and tsgit stage, remove, restore, grep, move and report long names
 * alike, and a long pathspec that names nothing ends in the same no-match outcome.
 *
 * @proves
 *   surface:        add
 *   bucket:         cross-tool-interop
 *   unique:         long pathspecs and long working-tree names are acted on, or not matched, as git does
 *   interopSurface: add, rm
 */
```

Part 3 appends `, mv` to `interopSurface`. `interopSurface` names must match an
`@writes` `surface:` tag: add.ts declares `add`, rm.ts `rm`, mv.ts `mv`.

Imports: `GIT_AVAILABLE`, `runGit`, `runGitEnv`, `tryRunGitWithExit`, `hashBlob`,
`stageRaw` from test/integration/interop-helpers.ts. `createNodeContext` from
src/adapters/node/index.ts. `add`, `rm`, `checkout`, `grep`, `status`, `blame`, `mv` from
their src/application/commands/*.ts modules. `pathspecNoMatch` from
src/domain/commands/error.ts. Wrap everything in
`describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')(…)`. Windows' legacy
260-character limit makes P805 itself host-conditional there. Use one `mkdtemp` root
resolved with `realpath` in `beforeAll`, removed in `afterAll`. Every row builds twin
repositories `git-<n>` and `tsgit-<n>` identically with git. git acts in the first and
tsgit in the second.

Generated names. Write them exactly like this, and never as literal runs:

```ts
const P805 = `${['a', 'b', 'c', 'd'].map((c) => c.repeat(200)).join('/')}/x`; // 805 bytes, tracked
const DIR805 = P805.slice(0, -'/x'.length);
const M127 = 'm'.repeat(127);
const P256 = `${M127}/${'n'.repeat(128)}`; // tracked
const P257 = `${M127}/${'n'.repeat(129)}`; // tracked
const S255 = 's'.repeat(255); // tracked
const S256 = 's'.repeat(256); // no host holds it
const S300 = 's'.repeat(300); // no host holds it
const P5000 = `${Array.from({ length: 98 }, () => 'q'.repeat(50)).join('/')}/x`; // 4999 bytes
const CJK100 = '漢'.repeat(100); // 300 UTF-8 bytes, 100 UTF-16 units
```

Fixture: `base`, `P805`, `P256`, `P257` and `S255`, each holding `needle\n`, committed on
`main`. Build it with `git init -q -b main`, `git add -A`, then
`git -c user.name=t -c user.email=t@example.com -c commit.gpgsign=false commit -q -m m`
with `{ env: runGitEnv() }`. A row that needs a modification writes `changed\n` to both
twins before the call.

State comparison (ADR-249: rebuild git's view from tsgit's fields, never ask tsgit for
display text):

```ts
const snapshotOf = (repo: string) => ({
  index: runGit(['-C', repo, 'ls-files', '-s']),
  status: runGit(['-C', repo, 'status', '--porcelain', '--untracked-files=all']),
});
```

A refusal row runs git with `tryRunGitWithExit(['-C', gitRepo, …])` and catches tsgit's
error with try/catch. It then asserts four things: git's exit code (128 for add, rm and
mv; 1 for checkout and grep); tsgit's `err.data` (for example
`toEqual(pathspecNoMatch(spec).data)`); git's stderr rebuilt from tsgit's fields
(`toContain(\`pathspec '${data.pattern}' did not match\`)`); and
`snapshotOf(tsgitRepo)` equal to `snapshotOf(gitRepo)`. Exclusions are `!p` for tsgit and
`:!p` for git.

grep: tsgit `grep(ctx, { patterns: [/needle/], paths: [spec] })`, with
`target: { treeish: 'HEAD' }` for a `HEAD --` row and `target: 'index'` for `--cached`.
git: `git grep -l -z needle [HEAD|--cached] -- <spec>` through `tryRunGitWithExit` (exit 1
means no hit), split on `\0`. On a HEAD row, rebuild git's `HEAD:<path>` lines from
tsgit's `paths[].path`. checkout: `checkout(ctx, { paths: [spec] })`, plus
`source: 'HEAD'` for `HEAD --`. rm: `rm(ctx, [spec], { cached })`; git
`rm -q [--cached] -- <spec>`.

Index-only entries (rows I1–I4, M4) are planted in both twins before the call:
`hashBlob(repo, 'needle\n')` and then
`stageRaw(repo, [{ mode: '100644', oid, path: new TextEncoder().encode(name) }])`.

Host probes (R9: never hard-code a limit):

- PATH_MAX: `Number(execFileSync('getconf', ['PATH_MAX', root]).toString().trim())`, read
  once in `beforeAll` (`getconf` is already in the cspell.json word list). Every row that uses P805 or P257 asserts, in its Arrange,
  `path.join(repo, P805).length < pathMax`, with the measured length in the message
  (`expect(len, \`P805 absolute length ${len}\`).toBeLessThan(pathMax)`).
- Wide component (Part 3): `canHoldWideComponent`, measured in `beforeAll` by trying
  `mkdir(path.join(root, CJK100))` and recording success or failure. APFS and NTFS hold it
  (255 UTF-16 units). ext4 refuses it (255 bytes). The K existence rows are
  `it.runIf(canHoldWideComponent)`, and their L3 arms are `it.skipIf(canHoldWideComponent)`.
  Because `beforeAll` runs after collection, compute the probe synchronously at module
  load with `mkdtempSync`, `mkdirSync` and `rmSync` in try/catch. Read the error's
  `code` and treat only `ENAMETOOLONG` as "cannot hold"; rethrow anything else.

**Gate command notes.** Run tests with `./node_modules/.bin/vitest run <files>`; the rtk
hook rewrites some `npx vitest` calls into a full-suite run. Before trusting
`npm run check:types`, run `rm -rf .wireit`. Write long output to a scratchpad file and
read back only the failing lines. Always type `command grep`, never bare `grep`: rtk
truncates at about 25 hits per file. The size caps (in the repo's size-limit config) sit
about 20–110 B above the measurement. This change deletes code, so it should not raise
them. Before trusting a size red, run `rm -rf ./dist ./.wireit`. A real raise is a blocker
for the user: never edit the caps. Never commit on a red gate. State-mutating probes run
in a `mktemp -d` throwaway, never in the worktree.

**Tool bootstrap (every code part).** These are deferred tools; load each family in ONE
call. If ToolSearch returns nothing (implementer agents may have no MCP tools), fall back
to `command grep -n` plus `Read`.

- graft: `ToolSearch("select:mcp__graft__graft_find_code,mcp__graft__graft_find_all,mcp__graft__graft_trace_calls,mcp__graft__graft_file_api,mcp__graft__graft_repo_map")`
- serena: `ToolSearch("select:mcp__serena__activate_project,mcp__serena__find_symbol,mcp__serena__find_referencing_symbols,mcp__serena__get_symbols_overview,mcp__serena__replace_symbol_body,mcp__serena__replace_content")`.
  Activate it on this worktree's absolute path first. For `replace_symbol_body` on an
  `export const` arrow, omit the `export const` prefix (it doubles otherwise).

## Part 1 — pathspecs carry no byte or `**` budget

### Context

Rows turned green (RED): **B1, B2 (P257), B3, B4, B5, B6, B7, B8, B9, T1, T2, T3**.
GUARD: **B2 (P256), T4**. Requirements R1, R10, and R3/R4/R7 for the B/T rows.

Files this part creates or edits:
- `src/application/commands/internal/resolve-pathspec.ts`
- `test/unit/application/commands/internal/resolve-pathspec.test.ts`
- `test/unit/application/commands/internal/resolve-pathspec.properties.test.ts` (NEW)
- `test/integration/pathspec-length-interop.test.ts` (NEW; see the plan-wide harness note)

Current code being deleted, all in resolve-pathspec.ts:
- `MAX_PATHSPEC_PATTERN_BYTES` (256), `MAX_DOUBLE_STAR_PER_PATTERN` (4) and
  `PATTERN_ENCODER`, plus the 5-line comment above them ("Matching is linear, but a
  hostile pattern …").
- `enforcePatternBudget(pattern)`: the two `invalidOption('paths', …)` throws.
- `countDoubleStars(pattern)`, with both of its `Stryker disable` lines.
- In `resolvePathspec`, the line `for (const raw of wellFormedPatterns) enforcePatternBudget(raw);`.
  Also delete the comment paragraph "Patterns are also length-capped at …; both throw
  `INVALID_OPTION`." above it.
- `invalidOption` in the import list: nothing else in the file uses it, and knip fails
  on a dead import.

`resolvePathspec` afterwards (signature unchanged:
`(patterns: ReadonlyArray<string>) => ResolvedPathspec`):

```ts
export const resolvePathspec = (patterns: ReadonlyArray<string>): ResolvedPathspec => {
  const collapsed = patterns.map(wellFormed).map(collapsePattern);
  const matcher = compilePathspec(collapsed);
  const literalMustMatch = matcher.filter(isPositiveLiteral).map((e) => bodyOf(e));
  const hasGlob = matcher.some(isPositiveGlob);
  const symlinkScanTargets = matcher.flatMap(scanTargetsOf);
  return { matcher, literalMustMatch, hasGlob, symlinkScanTargets };
};
```

Keep `validatePathspecBody` and its catch-all exactly as they are (its doc comment is
edited in Part 4). The matcher (src/domain/pathspec/wildcard.ts and
src/domain/refs/ref-glob.ts) is unchanged (R10).

Unit test edits in resolve-pathspec.test.ts (top-level `describe('resolvePathspec')`;
helpers `expectError(fn, code)` and `path(s)` sit at the top of the file):
- Delete these describes: `Given a pattern exceeding the per-pattern length cap`,
  `Given a pattern with more than the **-token cap`,
  `Given a pattern exactly at the byte cap (256 bytes)`, `Given ten consecutive \`*\``.
- In `Given a pattern at a non-throwing boundary`, delete the `**/**/**/**` and
  `a*a*a*a*a*` rows and keep the `x` row.
- Delete the `PATTERN_BYTE_LENGTH` helper.
- KEEP the `an over-long body` row of `Given a pattern holding a backslash`. It is refused
  by the validator cap, not by the budget, and Part 2 handles it.

Callers that reach `resolvePathspec` (read-only): `resolveCommandPathspec` in
src/application/commands/internal/pathspec-intake.ts serves add.ts, rm.ts, checkout.ts
and grep.ts. add.ts also compiles `WHOLE_TREE_MATCHER`. The pathspec-intake unit test
holds no budget row, so no change there.

Tool examples for this part: graft `graft_file_api` on
src/application/commands/internal/resolve-pathspec.ts (confirms nothing else uses
`invalidOption`). serena `find_referencing_symbols` for `enforcePatternBudget` (expect
only the `resolvePathspec` call), then `replace_symbol_body` on `resolvePathspec`.

### TDD steps

1. **RED (interop): rows B1–B9, T1–T3.** Create the interop file with the header, the
   name constants, the fixture builder, `snapshotOf`, the PATH_MAX probe and these
   `describe.each` / `it.each` tables:
   - add: P805 modified; an untracked sibling `${DIR805}/y`; `${DIR805}/*`;
     `*${'b'.repeat(200)}/${'c'.repeat(200)}/${'d'.repeat(200)}/x`; `${DIR805}/`; P257
     modified (B1, B2). `add .` plus exclusion of P805 with `base` and P805 modified, where
     `base` is staged (B3). `**a**b**c**d**x` (T1). `**********` with `base` modified (T2).
     For each, assert `snapshotOf` is equal across twins.
   - add refusals: `${DIR805}/nope`, `${P805}/` (B4) and `**/**/**/**/**/x` (T3). Assert git
     exit 128, `err.data` equal to `pathspecNoMatch(spec).data`, and the snapshots equal.
   - rm: P805, `--cached` P805, `${DIR805}/*`, and `**a**b**c**d**x` (B5, T1). Snapshots
     and the on-disk file list are equal.
   - checkout: P805 modified, restored by `-- P805`, `HEAD -- P805`, `-- ${DIR805}/*` and
     `-- **a**b**c**d**x` (B6, T1). Restored content and snapshots are equal. Refusal:
     `-- ${DIR805}/nope`, with git exit 1 and `PATHSPEC_NO_MATCH` (B7).
   - grep: `-- P805`, `-- ${DIR805}/*`, `HEAD -- P805` and `-- **a**b**c**d**x`, one hit
     each (B8, T1). `-- ${DIR805}/nope` gives git exit 1 and tsgit `paths` equal to `[]`
     (B9).

   Expected failure: every tsgit call throws
   `INVALID_OPTION { option: 'paths', reason: 'pattern exceeds max length 256 bytes' }`
   (the ** count reason for T1–T3).
2. **GUARD (interop): P256 modified (B2) and `**a**b**c**d**x` minus one `**`, i.e.
   `**a**b**c**x` (T4).** Both stage, snapshots equal. They pass because 256 bytes and
   four `**` sit inside the budgets.
3. **RED (unit): `Given a pathspec no budget limits` > `When resolved` > `it.each`
   `Then $label resolves to its entry`.** Rows:
   - a 300-byte three-component literal (`${'a'.repeat(100)}/${'b'.repeat(100)}/${'c'.repeat(98)}`)
     gives `isLiteral: true`, `negated: false`, and `body` equal to the input;
   - five `**` (`**a**b**c**d**x`) and ten `*` (`**********`) give `isLiteral: false`;
   - a 300-byte negated body (`!` + the literal above) gives `negated: true` and `body`
     equal to the literal;
   - a 300-byte directory-only body (the literal plus `/`) gives `body` equal to the input
     with its `/`.

   Assert `result.matcher.map((e) => ({ body: e.body, isLiteral: e.isLiteral, negated: e.negated }))`
   with `toEqual`, and assert `matchesPathspec(result.matcher, <target>)` is `true` for a
   target each positive pattern selects (the literal itself for the literal rows, P805's shape
   for the star rows). For the negated row, assert the entry data only. Expected failure:
   `INVALID_OPTION` thrown by `enforcePatternBudget`.
4. **RED (property): create resolve-pathspec.properties.test.ts.** Its header comment
   names lens 3 (a total function over a declared safe subset) and says why lenses 1, 2
   and 4 do not fit (see the design's "Property tests" section). Generators (fast-check
   4.10, `fc`):
   - component: `fc.array(fc.constantFrom(...SAFE_ASCII), { minLength: 1, maxLength: 100 })`
     joined, filtered against `.`, `..` and `isDotGitAlias` (src/domain/path/verify-path.ts).
     `SAFE_ASCII` is printable 0x20–0x7e minus `/`, `\`, `*`, `?` and `[`, built from a
     code range (not a pasted string).
   - pattern: `fc.array(component, { minLength: 1, maxLength: 40 })` joined by `/`, filtered
     with `!/^[A-Za-z]?:/.test(p)` and `!p.startsWith('!')`.
   - Property A, `Then a literal of any length resolves to itself and matches itself`:
     `resolvePathspec([p]).matcher[0].body === p` and
     `matchesPathspec(matcher, p as FilePath)`.
   - Property B, `Then a pattern of any count of * and ? never throws`: components drawn
     from `SAFE_ASCII` plus `*` and `?`. Assert one entry with `isLiteral === false` when
     the pattern holds a `*` or `?`.
   - `numRuns: 100` each, as named constants.

   Expected failure: `INVALID_OPTION` once a generated pattern passes 256 bytes or four `**`.
5. **GREEN.** Delete the budget machinery listed in Context and drop the `invalidOption`
   import. Run steps 1–4: all green.
6. **REFACTOR.** Delete the obsolete unit describes, rows and helper listed in Context.
   Re-read the `ResolvedPathspec` and `resolvePathspec` comments: no budget wording may
   remain. Run `./node_modules/.bin/knip` or rely on `check:types` plus biome: no unused
   import.

### Gate

```bash
./node_modules/.bin/vitest run test/unit/application/commands/internal/resolve-pathspec.test.ts test/unit/application/commands/internal/resolve-pathspec.properties.test.ts test/unit/application/commands/internal/pathspec-intake.test.ts test/integration/pathspec-length-interop.test.ts \
  && rm -rf .wireit && npm run check:types \
  && ./node_modules/.bin/biome check src/application/commands/internal/resolve-pathspec.ts test/unit/application/commands/internal/resolve-pathspec.test.ts test/unit/application/commands/internal/resolve-pathspec.properties.test.ts test/integration/pathspec-length-interop.test.ts \
  && npm run check:spelling
```

### Commit

`fix(pathspec): accept pathspecs of any length or wildcard count`

## Part 2 — a working-tree path is not refused for its total length

### Context

Rows turned green (RED): **C7 (P5000 arm), C8 (P5000 arm), C9 (P5000 arm), I2**.
Requirements R2 (total-length half), R4 and R6 for those rows.

Files this part edits:
- `src/domain/working-tree-path.ts`
- `test/unit/domain/working-tree-path.test.ts`
- `test/unit/application/commands/internal/working-tree.test.ts`
- `test/unit/application/primitives/walk-working-tree.test.ts`
- `test/unit/application/commands/internal/resolve-pathspec.test.ts`
- `test/integration/pathspec-length-interop.test.ts`

Current code (working-tree-path.ts):
- `const MAX_PATH_BYTES = 4096;` — delete it.
- In `rejectInputShape(input)`, delete the line
  `if (byteLength(input) > MAX_PATH_BYTES) reject(input);`. The other three guards and
  their `Stryker disable` lines stay.
- `MAX_COMPONENT_BYTES`, `PATH_ENCODER`, `byteLength` and `asciiOnly` STAY: the component
  cap still uses them until Part 3.
- In the `validateWorkingTreePath` doc comment, change the bullet
  "- Length caps: total path ≤ 4096 bytes; each component ≤ 255 bytes." to
  "- Length cap: each component ≤ 255 bytes.". The `validateWalkedEntryPath` doc keeps
  "length caps" until Part 3.

Exported validators (signatures unchanged):
`validateWorkingTreePath(input: string): FilePath`,
`validateWorkingTreePathOn(input: string, host: PathSyntaxHost): FilePath` and
`validateWalkedEntryPath(input: string, host: PathSyntaxHost): FilePath`. Consumers (all
read-only): `validatePath` alias, `materializeFile`, `removeFile`, `removeDirectory` and
`renameInWorkingTree` in src/application/commands/internal/working-tree.ts; `mv` in
src/application/commands/mv.ts; `seedWorkingTree` in src/application/commands/blame.ts;
`stepEntry` in src/application/primitives/walk-working-tree.ts; `validatePathspecBody` in
src/application/commands/internal/resolve-pathspec.ts. src/repository/wrap-fs-validator.ts
has no length rule and does not change.

Unit tests that break, measured on a scratch copy with both caps removed:
- working-tree-path.test.ts, under `describe('validateWorkingTreePath')`:
  `Given a path that exceeds 4096 bytes`,
  `Given a path exceeding 4096 bytes but with every component legal`. Under
  `describe('validateWalkedEntryPath')`: `Given a path that exceeds 4096 bytes`. Each
  flips to acceptance. The helpers `expectReject` and `expectWalkedEntryReject` sit at the
  top of the file. Keep `Given a path of exactly 4096 bytes` as an acceptance row.
- working-tree.test.ts, under `describe('validatePath')` > `Given a path rejected by a
  validatePath guard`: the `'a'.repeat(4097)` row. Its sibling describe
  `Given a 4096-byte path with components ≤255` merges into a new acceptance `it.each`.
- walk-working-tree.test.ts: `Given a working tree 2049 levels deep (config unset,
  default cap)` now throws `TREE_DEPTH_EXCEEDED` (measured), not `PATHSPEC_OUTSIDE_REPO`.
  Also, the comment in `Given a working tree exactly 2048 levels deep …` explains the leaf
  placement by the 4096-byte cap. Fixtures: `seedDeepEmptyWorkingTree`,
  `seedDeepWorkingTreeWithNearBottomLeaf` (read-only, test/unit/application/primitives/fixtures.ts).
  The error factory is `treeDepthExceeded(depth)` → `{ code: 'TREE_DEPTH_EXCEEDED', depth }`.
- resolve-pathspec.test.ts: the `an over-long body` row
  (`a\\` + `'b'.repeat(5000)`) of `Given a pattern holding a backslash`. After this part
  it would pass only because of the component cap, and Part 3 removes that cap, so it is
  replaced here (step 4).

Tool examples: serena `find_symbol` with name path `rejectInputShape` (body), then
`replace_symbol_body`. graft `graft_trace_calls` on `validateWalkedEntryPath`, to confirm
`stepEntry` is the only walk caller.

### TDD steps

1. **RED (interop): rows C7, C8, C9 and I2 for P5000.** Add tables:
   - `rm -- P5000` and `rm --cached -- P5000` (C7): git exit 128,
     `PATHSPEC_NO_MATCH { pattern: P5000 }`, snapshots equal.
   - `checkout -- P5000` and `checkout HEAD -- P5000` (C8): git exit 1, `PATHSPEC_NO_MATCH`.
   - `grep -- P5000` (C9): git exit 1, tsgit `paths` equal to `[]`.
   - `rm --cached -- P5000` with P5000 planted index-only in both twins (I2): both
     succeed, snapshots equal, and P5000 is gone from `ls-files`.

   Expected failure: tsgit throws `PATHSPEC_OUTSIDE_REPO { path: P5000 }` (the total cap,
   rethrown by `validatePathspecBody`).
2. **RED (unit, validators).** Flip the three working-tree-path describes listed in
   Context to `it('Then returns the input unchanged')` with `expect(sut(input)).toBe(input)`
   (`sut = validateWorkingTreePath`, or `(p) => validateWalkedEntryPath(p, POSIX_HOST)`).
   In working-tree.test.ts, add
   `describe('Given a path no length rule refuses')` > `describe('When validatePath')` >
   `it.each` `Then $label is returned unchanged`. It takes the 4097-byte row moved out of
   the rejected table, plus the 4095-byte 16 × 255 row from the merged describe. Delete
   that describe. Expected failure: `PATHSPEC_OUTSIDE_REPO` from the total cap.
3. **RED (unit, walk).** Retitle the 2049-level test to
   `Then throws TREE_DEPTH_EXCEEDED at depth 2049, never a raw RangeError`. Assert
   `expect(err.data).toEqual({ code: 'TREE_DEPTH_EXCEEDED', depth: 2049 })`. Rewrite its
   Arrange comment: the default `maxDepth` (2048) is what bounds this walk now. Expected
   failure: received `PATHSPEC_OUTSIDE_REPO`.
4. **RED (unit, resolve).** Delete the `an over-long body` row. Add
   `describe('Given a backslash body longer than 4096 bytes')` > `describe('When resolved')` >
   `it('Then it is one wildcard entry')`. The pattern is
   `a\\b/${Array.from({ length: 21 }, () => 'c'.repeat(200)).join('/')}` (4224 bytes, every
   component ≤ 255). Assert `matcher.map((e) => [e.body, e.isLiteral])` equals
   `[[pattern, false]]`. Expected failure: `PATHSPEC_OUTSIDE_REPO` from the total cap.
5. **GREEN.** Delete `MAX_PATH_BYTES` and the `rejectInputShape` length line, and edit
   the doc bullet. Run steps 1–4: all green.
6. **REFACTOR.** In the 2048-level walk test, rewrite the Arrange comment: no byte cap
   exists, and the leaf sits one level short of the bottom only to keep the empty 2048th
   directory in the walk. Keep the fixture call unchanged.

### Gate

```bash
./node_modules/.bin/vitest run test/unit/domain/working-tree-path.test.ts test/unit/application/commands/internal/working-tree.test.ts test/unit/application/primitives/walk-working-tree.test.ts test/unit/application/commands/internal/resolve-pathspec.test.ts test/integration/pathspec-length-interop.test.ts \
  && rm -rf .wireit && npm run check:types \
  && ./node_modules/.bin/biome check src/domain/working-tree-path.ts test/unit/domain/working-tree-path.test.ts test/unit/application/commands/internal/working-tree.test.ts test/unit/application/primitives/walk-working-tree.test.ts test/unit/application/commands/internal/resolve-pathspec.test.ts test/integration/pathspec-length-interop.test.ts \
  && npm run check:spelling
```

### Commit

`fix(working-tree): stop refusing a path for its total length`

## Part 3 — a working-tree path component is not refused for its length

### Context

Rows turned green (RED): **C2, C5, C7 (the S300, S300 glob and S300-slash-x arms), C8 (the
same three arms plus HEAD -- S300), C9 (the same three arms plus HEAD -- S300), I1, I3,
K1, K2, K3, K4, K5**, plus the rm, checkout and grep L3 arms of CJK100. GUARD: **I4, K6**.
Requirements R2 (component half), R3, R4, R6, R7 (exists arm) and R9.

Files this part creates or edits:
- `src/domain/working-tree-path.ts`
- `test/unit/domain/working-tree-path.test.ts`
- `test/unit/domain/working-tree-path.properties.test.ts` (NEW)
- `test/unit/application/commands/internal/working-tree.test.ts`
- `test/unit/application/primitives/walk-working-tree.test.ts`
- `test/integration/pathspec-length-interop.test.ts`

Current code (working-tree-path.ts) after Part 2:
- Delete `MAX_COMPONENT_BYTES`, `PATH_ENCODER` and `byteLength` (the last line of the
  file). Nothing else uses them; confirm with `command grep -rn "byteLength\|PATH_ENCODER" src/domain/working-tree-path.ts`.
- `rejectTraversalShape(component, original)` becomes exactly:

```ts
const rejectTraversalShape = (component: string, original: string): void => {
  if (component === '') reject(original); // empty component → trailing slash or // sequence.
  if (component === '.' || component === '..') reject(original);
  // Stryker disable next-line EqualityOperator: equivalent — `i <= component.length` reads one past the end where `charCodeAt` returns NaN; `NaN <= 0x1f` and `NaN === 0x7f` are both false, so the extra iteration never rejects.
  for (let i = 0; i < component.length; i += 1) {
    const code = component.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) reject(original);
  }
};
```

  The 4-line "Single pass: …" comment, `asciiOnly`, its `code > 0x7f` line and
  `componentByteLength` all go. The Stryker mark is the existing one with the `asciiOnly`
  clause removed. Do not add any new mark.
- Doc comments: remove the "- Length cap: each component ≤ 255 bytes." bullet from
  `validateWorkingTreePath`. In `validateWalkedEntryPath`, remove "length caps, " from the
  list "absolute path, NUL, dot/dotdot/empty component, control characters, length caps,
  and a backslash …".

Unit tests that break (measured): in working-tree-path.test.ts, under both
`describe('validateWorkingTreePath')` and `describe('validateWalkedEntryPath')`:
`Given a component longer than 255 bytes` and
`Given a non-ASCII component whose UTF-16 length is under 255 but whose UTF-8 byte length exceeds it`.
Flip them to acceptance. Keep the `exactly 255 bytes` describes (ASCII and non-ASCII) as
acceptance, retitled without "(boundary …)". KEEP every control-byte test (0x00, 0x01,
0x1f, 0x20, 0x7f): they alone kill the loop's mutants now. In working-tree.test.ts, the
`a/${'b'.repeat(256)}/c` row of the rejected table moves into Part 2's
`Given a path no length rule refuses` table. The `Given a component of exactly 255 bytes`
describe merges into it.

Walk primitive: `walkWorkingTree(ctx)` in src/application/primitives/walk-working-tree.ts
(read-only). The test helper `seedFs(workingTree)` and `collect(it)` are at the top of
walk-working-tree.test.ts.

Commands the K rows drive (read-only signatures): `status(ctx, opts?)` returns
`{ changes: ChangedPath[], untracked: FilePath[], … }`.
`blame(ctx, path, { worktree: true })` returns `{ path, lines: BlameLine[] }`, where
`BlameLine` is `{ committed: true, commit: ObjectId, … } | { committed: false, … }`.
`mv(ctx, sources, destination, opts?)` returns `{ moved: { from, to }[], skipped }`.
`checkout(ctx, { rev })` switches.

Tool examples: serena `find_symbol` with name path `rejectTraversalShape`, then
`replace_symbol_body` with the block above. graft `graft_find_all` for `byteLength`
scoped to src/domain, to prove that no other user remains.

### TDD steps

1. **RED (interop): S300 rows, run on every host.** Add tables:
   - C2: `add sub/${S300}` gives git 128 and `PATHSPEC_NO_MATCH`. The missing parent
     raises `FILE_NOT_FOUND` before any too-long stat.
   - C5: `add .` plus the exclusion of S300 with `base` modified. Both stage `base` and
     the snapshots are equal.
   - C7: rm and `rm --cached` of S300, `${S300}*` and `${S300}/x`: git 128 and
     `PATHSPEC_NO_MATCH`.
   - C8: `checkout --` and `checkout HEAD --` of S300, and `checkout --` of `${S300}*` and
     `${S300}/x`: git 1 and `PATHSPEC_NO_MATCH`.
   - C9: `grep --` of S300, `${S300}*` and `${S300}/x`, and `grep HEAD -- S300`: git 1 and
     `paths` equal to `[]`.
   - I1: S300 planted index-only, then `rm --cached S300`. Both remove it and the
     snapshots are equal.
   - I3: S300 index-only, then `grep --cached -- S300` (`target: 'index'`). One hit, and
     tsgit `paths[0].path` equals S300.

   Expected failure: `PATHSPEC_OUTSIDE_REPO` from the component cap. Do NOT add the add
   rows C1, C3, C4 or C6 here: without the probe fold they leak `PATH_TOO_LONG` (Part 4).
2. **GUARD (interop): I4.** S300 planted index-only beside the tracked S255, then
   `rm --cached '${'s'.repeat(254)}*'`. Both remove S255 and S300. It passes because the
   pattern is 255 bytes, its single component is ≤ 255, and the matcher reaches the
   index-only entry without a stat.
3. **RED (interop, host-conditional K rows).** Add the `canHoldWideComponent` probe, and
   append `, mv` to the header's `interopSurface`. Existence arms
   (`it.runIf(canHoldWideComponent)`), each on twins whose fixture also holds CJK100,
   tracked for K2, K3 (source) and K4, untracked for K1:
   - K1: `add CJK100` untracked, `add CJK100` modified, and `add .`.
   - K2: `rm CJK100` and `rm --cached CJK100`.
   - K3: `mv CJK100 short` and `mv base CJK100`. Snapshots equal, plus the working-tree file
     list.
   - K4: CJK100 modified, then `checkout -- CJK100`. Content equal.
   - K5: status with CJK100 untracked, then modified. Rebuild git's porcelain path list
     from `status.untracked` and `status.changes[].path`. Use
     `git status --porcelain -z --untracked-files=all` so the name is not quoted.
     `grep -- CJK100` gives one hit. `blame(ctx, CJK100, { worktree: true })` on a tracked
     CJK100 (`needle\n`) with `changed\n` appended, so one line is committed and one is not:
     compare
     `lines.map((l) => (l.committed ? l.commit : '0'.repeat(40)))` with the first 40 chars
     of each line of `git blame -l -s -- <CJK100>`.

   L3 arms (`it.skipIf(canHoldWideComponent)`): `rm -- CJK100`, `checkout -- CJK100` and
   `grep -- CJK100` give the C7, C8 and C9 no-match outcome. Expected failure on APFS:
   `PATHSPEC_OUTSIDE_REPO` (300 UTF-8 bytes > 255), and for `add .` and status the walk's
   `validateWalkedEntryPath` refusal. The add L3 arm lands in Part 4.
4. **GUARD (interop): K6.** `grep` with no pathspec over a tree holding CJK100, and
   `checkout({ rev })` switching to and from a commit holding CJK100. Snapshots equal and
   grep hits equal. Per the design these already match git. If either is red at this step,
   it is a RED: say so in the hand-off and keep it.
5. **RED (unit, validators and walk).** Flip the working-tree-path describes listed in
   Context to `expect(sut(input)).toBe(input)`. Move the 256-byte row in working-tree.test.ts
   and merge the 255-byte describe. In walk-working-tree.test.ts, add
   `describe('Given a file whose name is longer than 255 bytes')` >
   `describe('When walked')` > `it('Then yields it')`, built with
   `seedFs({ [\`${'b'.repeat(300)}.txt\`]: '1', [CJK100]: '2' })` and asserting
   `result.sort()` equals both names sorted. Expected failure: `PATHSPEC_OUTSIDE_REPO` from
   the component cap.
6. **RED (property): create working-tree-path.properties.test.ts.** Its header names
   lens 3 and why lenses 1, 2 and 4 do not fit.
   - Component: `fc.array(codeUnit, { minLength: 1, maxLength: 600 })` mapped through
     `String.fromCharCode` and joined. `codeUnit` is an integer in [0x20, 0xd7ff] minus
     0x2f (`/`), 0x5c (`\`) and 0x7f. That is BMP without surrogates, so no lone
     surrogate is produced. Filter against `.`, `..` and `isDotGitAlias`.
   - Path: `fc.array(component, { minLength: 1, maxLength: 40 })` joined by `/`, filtered
     with `!/^[A-Za-z]?:/.test(p)`.
   - Properties: `validateWorkingTreePath(p)` returns `p`, and so do
     `validateWalkedEntryPath(p, {})` and `validateWorkingTreePathOn(p, {})`.
     `numRuns: 100` (named constant).

   Expected failure: `PATHSPEC_OUTSIDE_REPO` for the first component over 255 UTF-8 bytes.
7. **GREEN.** Apply the working-tree-path.ts edits listed in Context. Run steps 1–6: all
   green.
8. **REFACTOR.** Re-read both validators' doc comments: no length wording may remain.
   `command grep -rn "255\|4096" src/domain/working-tree-path.ts` returns nothing.

### Gate

```bash
./node_modules/.bin/vitest run test/unit/domain/working-tree-path.test.ts test/unit/domain/working-tree-path.properties.test.ts test/unit/application/commands/internal/working-tree.test.ts test/unit/application/primitives/walk-working-tree.test.ts test/unit/application/commands/internal/resolve-pathspec.test.ts test/integration/pathspec-length-interop.test.ts \
  && rm -rf .wireit && npm run check:types \
  && ./node_modules/.bin/biome check src/domain/working-tree-path.ts test/unit/domain/working-tree-path.test.ts test/unit/domain/working-tree-path.properties.test.ts test/unit/application/commands/internal/working-tree.test.ts test/unit/application/primitives/walk-working-tree.test.ts test/integration/pathspec-length-interop.test.ts \
  && npm run check:spelling
```

### Commit

`fix(working-tree): stop refusing a path component for its length`

## Part 4 — add reads a pathspec probe the host refuses as too long as absent

### Context

Rows turned green (RED): **C1** (S256, S300, `${S300}*`, `?${S255}`, P5000,
`${P5000}/*`), **C3, C4, C6**, plus the add L3 arm of CJK100. Requirements R5, R4 and R7
for add. Lesson 038 applies: the fold must NOT widen, and the guard tests in step 7 prove
that.

Files this part edits:
- `src/application/commands/add.ts`
- `test/unit/application/commands/add.test.ts`
- `src/application/commands/internal/resolve-pathspec.ts`
- `test/unit/application/commands/internal/resolve-pathspec.test.ts`
- `test/unit/application/commands/internal/resolve-pathspec.properties.test.ts`
- `test/integration/pathspec-length-interop.test.ts`

add.ts probe primitives, current (around lines 741–773):

```ts
const NOT_A_DIRECTORY = 'NOT_A_DIRECTORY';
const lstatOrBeneathFile = async (ctx: Context, path: FilePath): Promise<Awaited<ReturnType<typeof lstatOrMissing>>> => {
  try { return await lstatOrMissing(ctx, path); }
  catch (err) { if (err instanceof TsgitError && err.data.code === NOT_A_DIRECTORY) return undefined; throw err; }
};
// lstatOrMissing(ctx, path): FILE_NOT_FOUND → undefined, anything else rethrown
```

The consumer map, from the primitive outward (design table). Route ONLY the three
pathspec-body probes through the new helper:

| Caller | Today | After |
|---|---|---|
| `literalStats` (its `boundedMapFor` callback) | `lstatOrBeneathFile` | `lstatPathspecBody` |
| `namesDiskPath` (← `refuseUnseenWalked`) | `lstatOrBeneathFile` | `lstatPathspecBody` |
| `namesOnDisk` (← `refuseUnseenRenormalized`) | `lstatOrBeneathFile` | `lstatPathspecBody` |
| `hiddenWalkEntryOf`, `movedGitlinkOf` | `lstatOrBeneathFile` | unchanged |
| `renormalizeOne`, `presentOnDisk` | `lstatOrMissing` | unchanged |

New helper, placed beside `lstatOrBeneathFile`. Use the file's existing `instanceof` form;
`TsgitError` and `FileStat` are already imported:

```ts
const PATH_TOO_LONG = 'PATH_TOO_LONG';

/** A pathspec body the file system refuses as too long names nothing on disk, as git's `file_exists` reads it. */
const lstatPathspecBody = async (ctx: Context, body: FilePath): Promise<FileStat | undefined> => {
  try {
    return await lstatOrBeneathFile(ctx, body);
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === PATH_TOO_LONG) return undefined;
    throw err;
  }
};
```

resolve-pathspec.ts scan fold. `assertNoSymlinkedLeadingPath(ctx, targets)` is called
only from add.ts (`dispatchPathspec` and `addRenormalized`). Its 16 other scanner
consumers call `createLeadingPathScanner` directly and are untouched. The scanner's
`lstatPrefix` (src/application/primitives/internal/symlinked-leading-path.ts, read-only)
folds only `FILE_NOT_FOUND`, and its memo caches the in-flight promise, so a second
target sharing a too-long prefix gets the same cached rejection. Add the following, and
import `errorDataCode` from src/domain/error-data-code.ts and the `LeadingPathScanner`
type from the scanner module:

```ts
const PATH_TOO_LONG = 'PATH_TOO_LONG';

// git's lstat_cache records a failed lstat as "not a symlink": a prefix the file
// system cannot name has nothing beneath it, so no later prefix can be a link.
const beyondSymlink = async (scanner: LeadingPathScanner, target: FilePath): Promise<boolean> => {
  try {
    return await scanner.hasSymlinkedLeadingPath(target);
  } catch (err) {
    if (errorDataCode(err) === PATH_TOO_LONG) return false;
    throw err;
  }
};
// in assertNoSymlinkedLeadingPath's loop:
//   if (await beyondSymlink(scanner, target)) throw pathspecBeyondSymlink(target);
```

Also edit the `validatePathspecBody` doc comment: drop "length" from "(traversal, control
bytes, `.git` aliases, leading `/`, length)".

Test fixtures in add.test.ts (read the top of the file): `seedFreshRepo(workingTree)`,
`expectError(fn, code)`, `RENORMALIZE` (`{ renormalize: true }`), `refusalOf` (local to
`add refuses an unmatched pathspec before any object write`), `seedTrackedThenIgnored(files, rules)`,
`writeWork(ctx, path, text)`, `readIndex`. Import `pathTooLong` from
src/domain/error.ts; it is not on the domain barrel. Existing describes to extend:
`Given a tracked file deleted from disk and a stat that fails on it` (a `describe.each`
over `{ label, fault }` inside `describe('add')`). The isolated PERMISSION_DENIED guard
for the literal probe already exists: `Given a genuine PERMISSION_DENIED from the adapter
on the lstat of a literal path`.

Tool examples: serena `find_referencing_symbols` for `lstatOrBeneathFile` (expect exactly
five callers: `literalStats`, `namesOnDisk`, `namesDiskPath`, `hiddenWalkEntryOf`,
`movedGitlinkOf`), then `replace_content` on the three pathspec call lines. graft `graft_trace_calls` on `assertNoSymlinkedLeadingPath` (expect
two callers, both in add.ts).

### TDD steps

Add a top-level `describe('add — a pathspec probe the file system refuses as too long')`
to add.test.ts, with a local helper:

```ts
const refusingTooLong = (ctx: Context, names: ReadonlyArray<string>): Context => {
  const refused = new Set(names.map((name) => `${ctx.layout.workDir}/${name}`));
  const baseLstat = ctx.fs.lstat;
  const fs = new Proxy(ctx.fs, {
    get(target, prop, receiver) {
      if (prop !== 'lstat') return Reflect.get(target, prop, receiver);
      return async (p: string) => {
        if (refused.has(p)) throw pathTooLong(p);
        return baseLstat(p);
      };
    },
  });
  return { ...ctx, fs };
};
```

1. **RED (interop): C1, C3, C4, C6 and the add L3 arm.** Rows:
   - `add` of each of S256, S300, `${S300}*`, `?${S255}`, P5000 and `${P5000}/*` (C1):
     git 128 and `PATHSPEC_NO_MATCH { pattern: spec, patterns: [spec] }`, snapshots equal.
   - `add ${S300}/x` (C3), same outcome.
   - `add base S300` with `base` modified (C4): `PATHSPEC_NO_MATCH` naming S300 only, and
     `base` not staged on either side.
   - `add .` plus the exclusion of `${S300}/x` with `base` modified (C6): both stage `base`.
   - `add CJK100` under `it.skipIf(canHoldWideComponent)`: git 128 and `PATHSPEC_NO_MATCH`.

   Expected failure: tsgit throws `PATH_TOO_LONG { path: <absolute path> }` (the node
   adapter's `ENAMETOOLONG`).
2. **RED (unit, `namesDiskPath`): a glob.** Given `seedFreshRepo({ a: 'a' })` and
   `refusingTooLong(ctx, ['long*'])`, `add(ctx, ['long*'])` refuses with `err.data` equal
   to `pathspecNoMatch('long*').data`. Expected failure: `PATH_TOO_LONG` from
   `namesDiskPath`. **GREEN:** add `PATH_TOO_LONG` and `lstatPathspecBody`, and route
   `namesDiskPath` through it.
3. **RED (unit, `literalStats`): a literal.** `add(refusingTooLong(ctx, ['long']), ['long'])` gives
   `pathspecNoMatch('long').data`. Expected failure: `PATH_TOO_LONG` from `literalStats`
   (`namesDiskPath` is already folded). **GREEN:** route the `literalStats` callback.
4. **RED (unit, `namesOnDisk`): renormalize.** With a tracked `a.txt`,
   `add(refusingTooLong(ctx, ['long']), ['long'], RENORMALIZE)` gives `pathspecNoMatch('long').data`.
   Expected failure: `PATH_TOO_LONG` from `namesOnDisk`. **GREEN:** route `namesOnDisk`.
5. **RED (unit, `beyondSymlink`) in resolve-pathspec.test.ts.** Under
   `describe('assertNoSymlinkedLeadingPath')`, add
   `Given a target whose leading prefix the file system refuses as too long` >
   `When checked` > `Then it resolves`. Build it on `createMemoryContext()`, with an lstat
   Proxy that throws `pathTooLong(p)` for `${workDir}/long`, then call
   `assertNoSymlinkedLeadingPath(ctx, [path('long/x')])` and expect
   `resolves.toBeUndefined()`. Expected failure: rejects with `PATH_TOO_LONG`. **GREEN:**
   add `beyondSymlink` and call it in the loop.
6. **GUARD (unit, fold precision).** Each passes at this step:
   - resolve-pathspec.test.ts: the same prefix throwing `permissionDenied(p)` rejects
     with `err.data.code === 'PERMISSION_DENIED'`. It is the isolated guard on `=== PATH_TOO_LONG`.
   - resolve-pathspec.test.ts: targets `['long/x', 'dir/file']` with `dir` a symlink.
     Expect `PATHSPEC_BEYOND_SYMLINK { path: 'dir/file' }`: the fold does not end the loop.
   - add.test.ts: `add(refusingTooLong(ctx, ['long', 'long/x']), ['long/x'])` gives
     `pathspecNoMatch('long/x').data` (the C3 shape through both folds).
   - add.test.ts: `seedFreshRepo({ a: 'a' })`, then
     `add(refusingTooLong(ctx, ['long', 'long/x']), ['.', '!long/x'])` gives `added` equal to `['a']`
     (the C6 shape).
7. **GUARD (unit, the fold did not widen).** Each passes because the tracked-entry paths
   still sit on `lstatOrMissing` / `lstatOrBeneathFile` and the scanner is unfolded:
   - Extend the `describe.each` of `Given a tracked file deleted from disk and a stat that
     fails on it` with `{ label: 'PATH_TOO_LONG', fault: pathTooLong('x/y') }`.
     `add({ all: true })` rejects with that fault and the index still lists `x/y`. This
     covers `presentOnDisk`.
   - New: `Given a tracked file whose leading directory the file system refuses as too long`.
     Seed and stage `x/y`, remove `x/y` and the `x` directory from disk, and stub lstat of
     `${workDir}/x` with `pathTooLong`. `add(ctx, [], { all: true })` rejects with
     `PATH_TOO_LONG` and the index still lists `x/y`. This covers the removal pass's
     scanner, which is not the folded call site.
   - New: `Given a modified tracked file an ignore rule hides and a stat refused as too long`.
     Use `seedTrackedThenIgnored({ 'x.log': 'a' }, '*.log\n')` and `writeWork`, and refuse
     `x.log`. `add(ctx, ['*.log'])` rejects with `PATH_TOO_LONG`. This covers
     `hiddenWalkEntryOf`.
   - New: `Given a tracked file whose renormalize stat is refused as too long`. With
     `a.txt` tracked and refused, `add(ctx, ['a.txt'], RENORMALIZE)` rejects with
     `PATH_TOO_LONG`. This covers `renormalizeOne`.

   Assert `err.data` equal to `pathTooLong(<abs>).data` each time.
8. **GUARD (resolve, the widening the caps allowed).** In resolve-pathspec.test.ts, add
   the design's "300-byte single component" row (`'s'.repeat(300)`, resolved literal with
   `body` equal to the input) to Part 1's `Given a pathspec no budget limits` table. Widen
   the property generators in resolve-pathspec.properties.test.ts to the design's subset:
   component code units in [0x20, 0xd7ff] minus `/`, `\` and 0x7f (minus `*`, `?` and `[`
   for property A), lengths 1–600, 1–40 components. Both pass since Part 3.
9. **REFACTOR.** Edit the `validatePathspecBody` doc comment ("length" goes). Check that
   no other caller of `lstatOrBeneathFile` / `lstatOrMissing` changed:
   `git diff --no-ext-diff -U0 src/application/commands/add.ts` shows only the helper and
   the three call lines.

### Gate

```bash
./node_modules/.bin/vitest run test/unit/application/commands/add.test.ts test/unit/application/commands/internal/resolve-pathspec.test.ts test/unit/application/commands/internal/resolve-pathspec.properties.test.ts test/integration/pathspec-length-interop.test.ts test/integration/pathspec-backslash-interop.test.ts \
  && rm -rf .wireit && npm run check:types \
  && ./node_modules/.bin/biome check src/application/commands/add.ts src/application/commands/internal/resolve-pathspec.ts test/unit/application/commands/add.test.ts test/unit/application/commands/internal/resolve-pathspec.test.ts test/unit/application/commands/internal/resolve-pathspec.properties.test.ts test/integration/pathspec-length-interop.test.ts \
  && npm run check:spelling
```

### Commit

`fix(add): read a pathspec the file system refuses as too long as matching nothing`

## Part 5 — mv names the destination when the host refuses it as too long

### Context

Rows turned green (RED): **M2**. GUARD: **M1, M3, M4, M5, M6, M7**. Requirements R8,
R3/R4 for mv. Out of scope: X1 (`mv -k base S300`, a failed rename under `skipErrors`)
and the `lstatOrUndefined` fold-everything route behind M5 (design "Out of scope"). Do
not touch either.

Files this part edits:
- `src/application/commands/mv.ts`
- `test/unit/application/commands/mv.test.ts`
- `test/integration/pathspec-length-interop.test.ts`

Current code (mv.ts, `mv`):

```ts
    applyToIndex(indexPathRules, byPath, planned);
    for (const item of planned) {
      await renameInWorkingTree(ctx, item.source, item.target);
    }
    await lock.commit(Array.from(byPath.values()), 'update');
```

`renameInWorkingTree` (src/application/commands/internal/working-tree.ts, read-only)
calls `moveNode`, which calls `ctx.fs.mkdir(parent)` and then `ctx.fs.rename(fromAbs, toAbs)`.
The node adapter maps `ENAMETOOLONG` to `pathTooLong(<absolute path>)` (the source,
because one errno cannot name the operand). The lock is released in `finally` without a
commit, so the index stays unchanged (R8).

Change: wrap the per-item move in a private helper, using the file's existing
`instanceof TsgitError` form. `pathTooLong` comes from src/domain/error.ts, the same
module the file already imports `basename`, `dirname` and `TsgitError` from:

```ts
const PATH_TOO_LONG = 'PATH_TOO_LONG';

// One errno cannot say which operand was too long; the source already exists, so it is the destination.
const moveOnDisk = async (ctx: Context, item: PlanItem): Promise<void> => {
  try {
    await renameInWorkingTree(ctx, item.source, item.target);
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === PATH_TOO_LONG) throw pathTooLong(item.target);
    throw err;
  }
};
```

`item.target` is repo-relative. In into-directory mode it is `<destDir>/<basename>`.

mv.test.ts fixtures: `seedAndStage(workingTree)`, `expectError(fn, code)`,
`exists(ctx, path)`, `indexEntry(ctx, path)`, and the `{ ...ctx, fs: { ...ctx.fs, <method> } }`
stub pattern (see `Given a non-index-missing readIndex error`). Import `pathTooLong` and
`permissionDenied` from src/domain/error.ts. The interop side compares against git's
`mv` refusal: exit 128 and stderr containing `File name too long`.

Tool examples: serena `find_symbol` with name path `mv` (body), then `replace_content`
on the `for (const item of planned)` loop. graft `graft_file_api` on
src/application/commands/mv.ts, to place `moveOnDisk` beside `workPath`.

### TDD steps

1. **RED (interop): M2.** Run `mv base S300` and `mv base ${DIR805}/${S300}`. git exits
   128 with stderr containing `File name too long`. tsgit's `err.data` equals
   `{ code: 'PATH_TOO_LONG', path: S300 }` (and `${DIR805}/${S300}`). Snapshots and the
   working-tree file lists are equal. Expected failure: `path` is the absolute SOURCE
   (`<root>/tsgit-<n>/base`).
2. **GUARD (interop): M1, M3, M4, M5, M6, M7.** Each passes since Part 3:
   - M1: `mv P805 moved`, `mv base ${DIR805}/z`, and `mv base ${M127}/${'o'.repeat(129)}`.
     All succeed and the snapshots are equal.
   - M3: missing S300, P5000 and `${DIR805}/nope` moved to `short`. git 128, tsgit
     `MV_SOURCE_NOT_TRACKED { source, destination }`.
   - M4: S300 index-only moved to `short`. git 128, tsgit `MV_BAD_SOURCE`.
   - M5: `mv base P5000`. git 128 (rename failed), tsgit
     `MV_DESTINATION_DIRECTORY_MISSING`. Assert state unchanged on both sides, and pin the
     different code as the design's accepted consequence.
   - M6: `mv(ctx, ['base'], S300, { dryRun: true })` returns
     `{ moved: [{ from: 'base', to: S300 }], skipped: [] }`. git `mv -n` exits 0 and
     nothing moves on either side.
   - M7: `mv(ctx, [S300], 'short', { skipErrors: true })` returns `skipped` equal to
     `[{ source: S300, reason: 'source-not-tracked' }]`. git `mv -k` exits 0.
3. **RED (unit).** `describe('Given a rename the file system refuses as too long')` >
   `describe('When mv')` > `it('Then it names the destination and leaves the index and the
   source unchanged')`. Use `seedAndStage({ 'a.txt': 'a' })` and
   `fs: { ...ctx.fs, rename: async () => { throw pathTooLong('/abs/a.txt'); } }`. Then
   `mv(stub, ['a.txt'], 'b.txt')` gives `err.data` equal to
   `{ code: 'PATH_TOO_LONG', path: 'b.txt' }`, `indexEntry(ctx, 'a.txt')` is defined,
   `indexEntry(ctx, 'b.txt')` is undefined, and `exists(ctx, 'a.txt')` is true. Expected
   failure: `path` is `'/abs/a.txt'`.
4. **GREEN.** Add `PATH_TOO_LONG` and `moveOnDisk`, and call `await moveOnDisk(ctx, item)`
   in the loop.
5. **GUARD (unit).** Each passes after GREEN:
   - The same stub throwing `permissionDenied('/abs/a.txt')` rejects with exactly that
     error (`rejects.toBe(fault)`). It is the isolated guard on `=== PATH_TOO_LONG`.
   - Into-directory mode: `seedAndStage({ 'a.txt': 'a', 'd/k': 'k' })` and
     `mv(stub, ['a.txt'], 'd')` give `path` equal to `'d/a.txt'`. That is `item.target`,
     not the raw destination.
6. **REFACTOR.** The loop body is one call. No other mv behaviour changes; check with
   `git diff --no-ext-diff src/application/commands/mv.ts`.

### Gate

```bash
./node_modules/.bin/vitest run test/unit/application/commands/mv.test.ts test/integration/pathspec-length-interop.test.ts test/integration/mv-interop.test.ts \
  && rm -rf .wireit && npm run check:types \
  && ./node_modules/.bin/biome check src/application/commands/mv.ts test/unit/application/commands/mv.test.ts test/integration/pathspec-length-interop.test.ts \
  && npm run check:spelling
```

### Commit

`fix(mv): name the destination when the host refuses it as too long`

## Part 6 — docs drop the length caps

### Context

Docs-only part (no src/ delta). Requirement R11 (docs/use stops claiming a cap). There
is no barrel change, so docs/use/commands/README.md is NOT touched. The design (§7)
searched blame.md, rm.md, mv.md, checkout.md and grep.md under docs/use/commands and
found no length claim. docs/use/serializers/archive.md's 256-byte limit belongs to the tar
header and is unrelated. Leave all of them.

Files this part edits:
- `docs/use/primitives/walk-working-tree.md`
- `docs/use/errors.md`
- `docs/use/commands/add.md`
- `docs/BACKLOG.md`

Edits:
- walk-working-tree.md: rewrite the bullet that starts "**The default depth cap is
  effectively unreachable on a real filesystem walk.**" (it names `MAX_PATH_BYTES` and
  `PATHSPEC_OUTSIDE_REPO`). New content: the walk refuses no path for its length. On the
  node adapter the OS refuses a `readdir` past its `PATH_MAX` (`PATH_TOO_LONG`) before a
  one-character-per-level path reaches the default 2048 `maxDepth`. The memory adapter has
  no such limit, so `maxDepth` (`TREE_DEPTH_EXCEEDED`) bounds a walk there. Keep the
  meaning of the sentence about raising `core.maxTreeDepth`: on the node adapter the OS
  limit is independent of it.
- errors.md, the `PATH_TOO_LONG` row (around line 46): append that `add` reads a pathspec
  the file system refuses as too long as matching nothing on disk (`PATHSPEC_NO_MATCH`),
  and that `mv` names the destination when the rename fails too long. Leave the
  `PATHSPEC_OUTSIDE_REPO` row as is.
- add.md, `## Pathspec syntax`: add one sentence after the backslash paragraph. A pathspec
  has no length or `**` limit of its own, and a body longer than the file system allows
  matches nothing on disk.
- BACKLOG.md: tick `- [ ] **32.40**` to `- [x]`, and append
  ` · ADRs 1191–1196 · design/long-pathspec-refusals.md` in the house style (see the ticked
  32.32 line). In the `## Release order` table, row 3, strike `32.40` to `~~32.40~~`. Do
  not reorder anything else.

### TDD steps

1. **GUARD (docs).** `command grep -rn "MAX_PATH_BYTES\|pattern exceeds max\|\*\*-token" docs/use`
   returns nothing after the edits. Before them it returns the walk-working-tree.md line.
2. **GREEN.** Apply the four edits above. Write in plain short sentences, with no
   superlatives and no provenance refs in docs/use.
3. **REFACTOR.** Re-read each edited paragraph against the shipped behaviour of Parts 1–5,
   then run the gate.

### Gate

```bash
npm run check:spelling && npm run check:doc-coverage
```

### Commit

`docs(pathspec): drop the length caps from the docs`
