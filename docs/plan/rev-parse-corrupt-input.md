# Plan — rev-parse and commit-ish resolution against corrupt input

> Source: design doc `docs/design/rev-parse-corrupt-input.md` · ADRs 1141, 1142, 1143, 1144, 1145, 1146, 1147
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

**Property tests: none.** No parser, matcher, serializer or round-trip pair is touched. The
`readHop` catch and the `scanLooseIn` classifier route faults; they define no grammar, so none
of the four lenses in .claude/workflow/property-testing.md applies (design, "Test strategy").

**Partition versus the design.** The design's P1–P8 become nine parts:

| Plan part | Design part | Why it moved |
|---|---|---|
| 1 interop harness | (new) | It holds the fixtures and rebuild helpers every later part extends, plus the GUARD rows for behaviour tsgit already matches. It has no `src/` change, so it is a test-infra part. |
| 2 quiet reread | design P2 | Goes before the peel part, because design P1's interop rows (`x^{commit}` non-hex, W once) need the quiet reread. |
| 3 peel | design P1 | — |
| 4 error codes | inside design P3, P4 and P5 | All three public codes land in one part: one `reports/api.json` regeneration, one pass over the surface gates. |
| 5 ladder + describe | design P3 | — |
| 6 sequencer | design P4 | — |
| 7 blame + merge | design P5 + P6 | Two small route parts (3 RED cycles together). |
| 8 fanout classifier | design P7 | — |
| 9 fanout memo | design P8 | — |

Parts run in order and share one working tree. Each part is one commit.

**Files that recur across parts, on purpose.**

- The corrupt-candidate interop suite (Parts 1–3 and 5–7) is shared infrastructure. Each route's rows land RED-first beside the GREEN that turns them.
- commit-ish.ts and its test appear in Parts 5 and 6. Part 6 adds `readRevisionObject`, whose first consumer is the sequencer. Merging the parts would put 9 files and 8 RED cycles in one part.
- resolve-oid-prefix.ts, its test, the abbreviation test and the posix suite appear in Parts 8 and 9. The classifier (ADR-1142/1144) and the count memo (ADR-1143) are separate decisions, each with its own RED rows. Merged, they would exceed 5 cycles.

## Conventions every part follows

- **One RED per function.** Run it and see it fail before you write that function's code. A
  `describe.each` table over one function counts as one RED. Interop rows are committed in the
  part whose GREEN makes them pass; write and run them before that GREEN.
- **GUARD.** A GUARD passes at its step. Every GUARD below over a git-pinned row quotes the
  tsgit probe output that proves it. If a GUARD goes red, **stop the part**. Find the read
  site with a probe, not by reading code, and escalate `{ unit, reason, ≤3 options }`.
- **Tests.** Use `describe('Given …')` > `describe('When …')` > `it('Then …')`, or the
  two-level `describe('Given …, When …')` shortcut. Bodies use `// Arrange`, `// Act` and
  `// Assert`. **`sut` is the function under test** (`const sut = resolveCommitIsh;`), never
  its result. `check:test-pyramid`'s `sutBindsResult` fails the phase gate on
  `const sut = await …`.
- **Refusal assertions.** Use try/catch, then `expect((caught as TsgitError).data).toEqual({ code, …fields })`.
  Never use `toThrow(Class)` on its own. Give each guard operand its own test.
- **No directives.** No `v8 ignore`, `stryker-disable`, `biome-ignore` or `@ts-ignore` in new
  code. No phase, ADR or backlog numbers in source or test text.
- **Interop twins.** Build real-git fixtures through test/integration/interop-helpers.ts
  (`runGit`, `git`, `tryRunGitWithExit`, `runGitEnv`, `disableAutoMaintenance`, `GIT_AVAILABLE`,
  `revParseStdout`, `makePeerPair`). Pin the dates with `GIT_AUTHOR_DATE` and
  `GIT_COMMITTER_DATE` = `1700000000 +0000`. Build the tsgit `Context`
  (`createNodeContext({ workDir })`) **after** every git write: the per-session fanout cache
  does not see subprocess writes. Never hard-code a SHA or a readdir order. Read ids back with
  `git rev-parse`.
- **Log reconstruction** (ADR-249, ADR-1030). Map `logger.warn(m)` to `warning: m`, keeping
  only `refname '…' is ambiguous.` and `ignoring dangling symref …` lines. Map
  `logger.error(m)` to `error: m`. Rebuild refusal lines from `.data` (see Part 1). The
  library emits no display string.
- **Probes** obey .claude/workflow/probes.md: a `mktemp -d` throwaway, a scrubbed env, no
  deletes, and every `cd` guarded. To run a tsgit probe script, use
  `node --import ./tooling/register-typescript-hooks.mjs <script> <worktree>`.
- **Stale caches.** `check:types` and `check:spelling` are wireit-cached. The bare oracles
  in each Gate are the ground truth.
- **Public surface.** Part 4 adds the only new public symbols: three error codes and their
  factories. Every other new export is **internal** (`src/application/**/internal/`, not
  reachable from a package entry), so it needs no barrel, docs or api change. If
  `npm run docs:json` still changes `reports/api.json` in a later part, commit it in that
  part.

## Decision candidates

These choices are load-bearing and neither the design nor the ADRs settle them consistently.
The parts below follow each recommendation; the session ratifies them before implementation.

| # | Choice | Alternatives (≤3) | Recommendation | Proof / why |
|---|---|---|---|---|
| DC-P1 | Does quiet mode skip counting the later ladder candidates? Design D4 and ADR-1147 say "without counting the rest". | (a) quiet still runs `countFound` and skips only `isAmbiguous` (the warning and the abbreviation scan); (b) quiet skips `countFound` too, as the ADR says | (a) | git's `expand_ref` reads every candidate whatever `GET_OID_QUIETLY` says. Only the `get_oid_basic` warning is gated. Pinned: <scratchpad>/pin-git-6.log `S run1 rev-parse d^{blob}` prints `warning: ignoring dangling symref refs/heads/d` **twice**. There `refs/heads/d` comes after the winning `refs/tags/d`, so only the count reads it. Under (b) the reread never reads it, and tsgit prints the line once. tsgit today prints it twice (`<scratchpad>/plan-guard-probe.log` `S run1 revParse d^{blob}`). (a) keeps that and still skips the scan, so the E counts of ADR-1143 hold. ADR-1147's sentence needs an erratum. |
| DC-P2 | When does `resolveOidPrefix` rescan on a miss (ADR-1143)? | (a) only when this call consulted a fanout directory that is in the failed-listing memo; drop those entries, then scan once more; (b) on every miss, as the ADR is worded | (a) | Every pinned count is the same under both: the first miss in a session memoises during its own first scan, so it scans again. (a) avoids doubling `readdir` on every hex-looking miss in a healthy store, because a successful listing is never cached. (b) does reproduce git's `odb_reprepare` race window, where an object is written between the two scans. That window is unpinned. |
| DC-P3 | Which fault codes count as "the object does not read" for `BAD_OBJECT`, the describe and merge refusals, and the sequencer's peel fault? | (a) exactly the two pinned codes, `OBJECT_NOT_FOUND` and `INVALID_OBJECT_ID`, behind one shared predicate `isObjectReadFault`; (b) every object parse code (`INVALID_TAG`, `INVALID_OBJECT_HEADER`, …) | (a) | Design D3 says "only the pinned code is folded; a new code joins only with its own pin". Every fixture A/M row pins one of the two codes (`<scratchpad>/pin-tsgit.log`, `pin-tsgit-5.log`). |

**Plan-level refinements, made without a decision because they preserve existing behaviour.**

- **`resolveCommitIsh` peels only a ref winner.** Design D1's sketch was
  `peelTags(resolveCommitIshObject(…))`. That would peel a full object id and an abbreviated
  one too, and break three existing tests: test/unit/application/commands/internal/commit-ish.test.ts
  "Given an exact 40-hex object id … Then returns it verbatim" (a nonexistent id, never read),
  the SHA-256 variant, and the 40-hex prefix of a blob. Part 5 keeps today's rule: only the
  ref ladder's winner is peeled.
- **Helper name.** Design P4 named the get_reference helper `readNamedObject`, but
  src/application/commands/rev-parse.ts already exports `readNamedObject`. The helper is
  `readRevisionObject` here.
- **Tree-path bases stay reporting.** The quiet mode reaches only the ref-or-hex `resolveBase`
  read. Its pinned rows are `x^{commit}` and `x^{blob}`. `x:path` keeps today's reporting
  read; that row is unpinned.

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

## Part 1 — corrupt-candidate interop harness (test infra, no src change)

### Context

**Creates** `test/integration/commit-ish-corrupt-candidate-interop.test.ts`. **Edits**
`test/integration/rev-parse-dwim-interop.test.ts`. Parts 2, 3 and 5–7 add rows to the new
suite. That is why the suite shows up in several parts; it is shared infrastructure.

Read-only models:

- test/integration/rev-parse-ambiguity-interop.test.ts for the header, the identity env and
  the log rebuild.
- test/integration/rev-parse-dwim-interop.test.ts lines ~298–356: the `stderrLines` helper,
  and the "revParse ambiguous refname warning" block that renders
  `warnings.flatMap((m, at) => (at === 0 ? \`warning: ${m}\` : m).split('\n'))`.

**Header of the new suite.** The first JSDoc in the file. `check:test-pyramid` parses
`@proves` and `check:write-surfaces` requires `interopSurface:` on a `cross-tool-interop`
file at the integration root:

```ts
/**
 * Cross-tool interop — a commit-ish whose first ref candidate names a corrupt object: a tag
 * whose `object` line does not parse or names a missing object, or a ref to a missing object.
 * Each row builds the same fixture for git and tsgit, runs one route on each, and rebuilds
 * git's warning, error and fatal lines from tsgit's structured logs and refusal data.
 *
 * @proves
 *   surface:        revParse, cherryPick, revert, blame, describe, merge, rebase
 *   bucket:         cross-tool-interop
 *   unique:         a corrupt first commit-ish candidate wins the ladder and every route refuses on it as git does
 *   interopSurface: revParse, cherryPick, revert, merge
 */
```

New integration files count toward the integration
tier ratio in test-pyramid-budgets.json, which only warns. The `overMockedIntegration` gate is
off, but use no `vi.spyOn` anyway. Capture logs with a plain closure logger.

**Fixtures** (build one template per variant in `beforeAll`, then copy it per row with
`cp(template, dir, { recursive: true })` from `node:fs/promises`; routes write state):

- **Base:** `git init -q -b main`, `git config user.name A`, `git config user.email a@x`,
  `disableAutoMaintenance`. Write file `f` = `hi\n`, add it, commit `c1`, then
  `git branch x`. Write `f` = `hi\ntwo\n`, `commit -qam c2`. HEAD is on main at c2.
- **A, by variant.** Write the tag body to a temp file outside the repo:
  `object <O>\ntype commit\ntag x\ntagger A <a@x> 1700000000 +0000\n\nmsg\n`. Here `<O>` is
  `z`×40 (non-hex), `abc` (truncated), `a`×40 (absent: well-formed but missing) or c1
  (valid). Then `git hash-object -t tag -w --literally <file>`. `update-ref` refuses that
  object, so write the ref file the tag ref file under the repository's refs/tags by hand with `writeFileSync`, content
  `<tag oid>\n`.
- **M:** the base, with the tag ref file x written by hand as `b`×40 + `\n`.
- **TT:** the base plus `git tag -a -m t t <c2 tree id>`. That makes the tag ref t point at a
  valid tag of a tree.
- **Dangling control** (for the dwim suite): `git init`, commit c1 (`f` = `hi\n`),
  `git tag d`. Then write the branch ref file d by hand as `ref: refs/heads/nowhere\n`.

**Helpers to add** (exported nowhere; later parts extend them):

- `type Variant = 'non-hex' | 'truncated' | 'absent' | 'valid' | 'missing-ref'`. Here
  `missing-ref` is fixture M.
- `buildTemplate(variant)` and `copyFixture(variant)`: the copy returns `{ dir, c1, c2, tag }`.
- `capture()`: returns `{ lines, logger }`. Its `warn` pushes `warning: ${m}` only for
  messages matching `/^refname '|^ignoring dangling symref /`. Its `error` pushes `error: ${m}`.
- `gitStderrLines(stderr)`: like `stderrLines`, but it drops git's `hint:` lines.
- `AMBIGUOUS_ARGUMENT(arg)`: returns the three lines git prints after an unresolved
  rev-parse argument:
  ```
  fatal: ambiguous argument '<arg>': unknown revision or path not in the working tree.
  Use '--' to separate paths from revisions, like this:
  'git <command> [<revision>...] -- [<file>...]'
  ```
- `refusalLines(data)`: a `switch` over `data.code`. Part 1 adds the `OBJECT_NOT_FOUND`
  arm, which gives `AMBIGUOUS_ARGUMENT(printed path)` when `data.printed` holds a path entry.
  Later parts add their arms. A `default` that throws `new Error(\`unexpected refusal ${data.code}\`)`
  keeps a stray code from passing silently.
- Each row compares `{ refused, stdout, diagnostics }`. git's `refused` is `exitCode !== 0`.
  tsgit's is that the route threw. `diagnostics` is `capture().lines` plus
  `refusalLines(caught.data)`, compared with `gitStderrLines(git.stderr)`. stdout is
  `revParseStdout(entries or data.printed)` for rev-parse.

**Pinned git rows this part reproduces** (design matrix, git 2.56.0, each run twice):

- `rev-parse x` for every A variant and for M exits 0. stdout is the tag oid (M: `b`×40) and
  stderr is `warning: refname 'x' is ambiguous.`.
- `rev-parse x~5` (valid) exits 128. stdout is `x~5`; stderr is the W line twice, then
  `AMBIGUOUS_ARGUMENT('x~5')`.
- Dangling control (<scratchpad>/pin-git-6.log, three runs):
  - `rev-parse d^{blob}` gives `warning: ignoring dangling symref refs/heads/d`, then
    `error: d^{blob}: expected blob type, but the object dereferences to tree type`, then both
    lines again, then `AMBIGUOUS_ARGUMENT('d^{blob}')`.
  - `rev-parse d~5` gives the dangling line twice, then `AMBIGUOUS_ARGUMENT('d~5')`.

**tsgit probe output proving the GUARDs** (worktree at d6efa13a; logs in `<scratchpad>`):

- `pin-tsgit.log`: the A non-hex `run1 revParse x` line: `ok`, the tag id `a7a20a89…`, `logged=[["warn","refname 'x' is ambiguous.",…]]`. The truncated and absent lines are the same with their own tag ids.
- `pin-tsgit-5.log`: `M(ref->missing) run1 revParse x | {"ok":"[{…\"id\":\"bbbb…\"…}]"} | logged=["W:refname 'x' is ambiguous."]`.
- `plan-guard-probe.log` (run twice, identical):
  - `valid run1 revParse x | ok tag id | logged=["W:refname 'x' is ambiguous."]`
  - `valid run1 revParse x~5 | OBJECT_NOT_FOUND printed [{path x~5}] | logged=[W, W]`
  - `S run1 revParse d^{blob} | OBJECT_NOT_FOUND printed [{path d^{blob}}] | logged=[dangling, E, dangling, E]`
  - `S run1 revParse d~5 | OBJECT_NOT_FOUND printed | logged=[dangling, dangling]`

### TDD steps

1. **GUARD**, new suite: `describe.each` over the five variants. Titles:
   `Given a tag ref x that names a $variant object ahead of branch x` > `When git rev-parse and revParse read x` > `Then tsgit prints the tag ref's own id and warns once, as git does`.
   This passes today (probe lines above): `revParse` uses the never-peeling `resolveCandidate`.
2. **GUARD**, new suite: `Given the valid tag variant` > `When git rev-parse and revParse read x~5` > `Then tsgit refuses on the printed path and warns twice, as git does`.
   This passes today: `dropsQuietRead('x~5')` and the reread re-emits (probe above).
3. **GUARD**, dwim suite: a new top-level
   `describe.skipIf(!GIT_AVAILABLE)('integration — revParse misspelt reread past a dangling symref', …)`
   with its own `beforeAll` dangling fixture. It is a `describe.each` over `d^{blob}` and
   `d~5`:
   `Given a tag d ahead of a dangling refs/heads/d` > `When git and tsgit rev-parse $arg` > `Then tsgit prints the dangling line as often as git does`.
   Rebuild both the `warning:` and the `error:` lines. This passes today (probe S rows). It is
   the regression net for DC-P1 in Part 2.
4. REFACTOR: none.

### Gate

```
npx vitest run test/integration/commit-ish-corrupt-candidate-interop.test.ts test/integration/rev-parse-dwim-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check test/integration/commit-ish-corrupt-candidate-interop.test.ts test/integration/rev-parse-dwim-interop.test.ts && npm run check:spelling
npx tsc --noEmit -p tsconfig.json
npx cspell --no-progress test/integration/commit-ish-corrupt-candidate-interop.test.ts test/integration/rev-parse-dwim-interop.test.ts
npm run check:test-pyramid && npm run check:write-surfaces
```

### Commit

`test(interop): pin git's reads of a corrupt first commit-ish candidate`

## Part 2 — the misspelt-name reread is quiet for the refname check

### Context

**Edits** `src/application/commands/internal/refname-ambiguity.ts`,
`src/application/commands/internal/revision-name.ts`, `src/application/commands/rev-parse.ts`,
`test/unit/application/commands/internal/refname-ambiguity.test.ts`,
`test/unit/application/commands/rev-parse-misspelt-name.test.ts`,
`test/integration/commit-ish-corrupt-candidate-interop.test.ts`.

Current code (line numbers at d6efa13a):

- refname-ambiguity.ts:
  - `resolveAmbiguousLadder<T>(ctx, name, candidates, read): Promise<T | undefined>`
    (l.145). When the first candidate is found it calls `readSettings`. If `warns` is set, it
    runs `countFound(candidates.slice(index + 1), read)`, then
    `if (await isAmbiguous(ctx, name, othersFound)) warnAmbiguous(ctx, name)`.
  - `resolveRefLadder(ctx, name, resolve)` (l.164).
  - `resolveSubstitutedRefLadder(ctx, name, substitute, resolve)` (l.172).
  - `isAmbiguous(ctx, name, othersFound)` (l.183) runs `isUniqueAbbreviation`, which is
    `resolveOidPrefix`: this is the abbreviation scan.
- revision-name.ts `resolveRevisionName(ctx, name, accepts?: CandidateFilter)` (l.46). It
  calls `resolveSubstitutedRefLadder` (l.59, branch mark), `resolveRefLadder` (l.61) and
  private `resolvePriorCheckout` (l.69 → l.75), then `resolveOidPrefix(ctx, name, accepts)`.
- rev-parse.ts:
  - `rereadMisspelt(ctx, table, arg)` (l.159) calls `evaluateTyped(ctx, table, arg)`;
    `dropsQuietRead(arg)` (l.178) already exists.
  - `evaluateTyped(ctx, table, expression, accepts?)` (l.387) → `evaluate(ctx, table, expr, raw, accepts?)`
    (l.399) → `resolveBase(ctx, expr.base, baseHint(ctx, expr.operations, accepts))` (l.420)
    → `resolveRevisionName(ctx, interpretEmptyAt(base), accepts)` (l.481).
  - Other `evaluateTyped` callers: `readReporting` (l.192) and `evaluateRevision` (l.384).
  - Other `evaluate` callers: `readWholeName` (l.440) and l.750 (the tree-path base, with
    `treeishFilter(ctx)`).

Change, per ADR-1147 and DC-P1(a):

- refname-ambiguity.ts exports the closed union
  `export type RevisionReadMode = 'reporting' | 'quiet';` (the doc comment names git's
  `GET_OID_QUIETLY`) and `export interface LadderOptions { readonly mode?: RevisionReadMode }`.
- `resolveAmbiguousLadder(ctx, name, candidates, read, { mode = 'reporting' }: LadderOptions = {})`
  still runs `countFound`. That call is git's `dwim_ref` count, and it emits `warnSkipped`.
  It skips `isAmbiguous` (the warning and the scan) when `mode === 'quiet'`.
- `resolveRefLadder` and `resolveSubstitutedRefLadder` take a trailing
  `options?: LadderOptions` and pass it through.
- Leave `warnSkipped`, `warnIfRefNamesObjectId`, `reportPeelMismatch` and the `readSettings`
  read ungated.
- revision-name.ts:
  `export interface RevisionNameOptions { readonly accepts?: CandidateFilter; readonly mode?: RevisionReadMode }`
  and `resolveRevisionName(ctx, name, { accepts, mode }: RevisionNameOptions = {})`. Thread
  `{ mode }` to both ladder calls and to `resolvePriorCheckout`. The trailing
  `resolveOidPrefix(ctx, name, accepts)` stays ungated, because git's quiet reread still
  scans a name no ref holds.
- Callers of `resolveRevisionName`:
  - status.ts:458, tag.ts:96, checkout.ts:153 and reflog.ts:171 all pass two arguments.
    They are unchanged and must still compile.
  - rev-parse.ts:481 becomes `resolveRevisionName(ctx, interpretEmptyAt(base), { accepts, mode })`.
  - test/unit/application/commands/internal/revision-name.test.ts calls it with two
    arguments only.
  - The other `resolveAmbiguousLadder` callers (rev-parse.ts:512 and l.532, the reflog and
    HEAD-log ladders) are unchanged: they get the default reporting mode.
- rev-parse.ts: replace the positional `accepts?` of `evaluateTyped`, `evaluate` and
  `readWholeName` with `options: RevisionNameOptions = {}`. `resolveBase(ctx, base, options)`
  hands `{ accepts: baseHint(ctx, expr.operations, options.accepts), mode: options.mode }`
  on. `readReporting` and `evaluateRevision` pass `{ accepts }`. l.750 passes
  `{ accepts: treeishFilter(ctx) }`. `rereadMisspelt` passes
  `{ mode: dropsQuietRead(arg) ? 'reporting' : 'quiet' }`. Hoist the mode into a named
  constant or a small function; no inline ternary on a magic string twice.
- `readWholeName` keeps the reporting read: tree-path bases are out of the pinned set (see
  the refinements above).

Unit fixtures:

- refname-ambiguity.test.ts (42 lines) only tests `expandRef` today. It uses
  `createMemoryContext` and `vi.spyOn(configRead, …)`. Add a `describe('resolveAmbiguousLadder', …)`
  with a hand-written `read` stub (`(candidate) => Promise.resolve(map[candidate])`) and
  `vi.spyOn(resolveOidPrefixModule, 'resolveOidPrefix')`. Import
  `* as resolveOidPrefixModule from '…/primitives/resolve-oid-prefix.js'`.
- rev-parse-misspelt-name.test.ts reuses its `seedRepo` fixture (test/unit/application/commands/fixtures.ts,
  read-only). Seed refs the branch ref x and the tag ref x (a lightweight tag is enough to be
  ambiguous) on a commit whose tree is `EMPTY_TREE`. For M, seed the tag ref x as `b`×40.

Pinned rows (design matrix):

- `rev-parse x^{commit}` and `x^{blob}` on A absent and on M: 128, stdout the argument,
  **W once**, `AMBIGUOUS_ARGUMENT`.
- Valid `x^{blob}`: W once, then `error: x^{blob}: expected blob type, but the object dereferences to tree type` twice.

tsgit today:

- `pin-tsgit.log` `A absent run1 revParse x^{commit}` gives OBJECT_NOT_FOUND printed with
  `logged=[W, W]`.
- `pin-tsgit-5.log` M gives the same.
- `pin-tsgit-2.log` `A valid run1 revParse x^{blob}` gives `logged=[W, E, W, E]`.

### TDD steps

1. **RED** refname-ambiguity.test.ts:
   `Given two candidates that both resolve` > `When resolveAmbiguousLadder reads them in quiet mode` > `Then it returns the first and warns nothing`.
   Fails today: the fifth argument is ignored and `warn` is called with `refname 'x' is ambiguous.`.
2. **RED** same file:
   `Given one candidate that resolves under a hex-looking name` > `When resolveAmbiguousLadder reads it in quiet mode` > `Then it makes no abbreviation scan`.
   Assert the `resolveOidPrefix` spy was not called. Fails today: `isUniqueAbbreviation`
   calls it once.
3. **GUARD** same file:
   `Given a winner followed by a dangling candidate` > `When resolveAmbiguousLadder reads them in quiet mode` > `Then the later candidate is still read`.
   Assert the `read` stub was called for every candidate. This passes today because
   `countFound` runs whenever `warns` (refname-ambiguity.ts:156). It pins DC-P1(a).
4. GREEN refname-ambiguity.ts as in Context.
5. **RED** rev-parse-misspelt-name.test.ts: `describe.each` over
   `{ arg: 'x^{blob}', fixture: 'both namespaces' }` and
   `{ arg: 'x^{commit}', fixture: 'tag ref to a missing object' }`:
   `Given an ambiguous name x` > `When revParse reads $arg, which names no object` > `Then it warns the ambiguity once, the reread being quiet`.
   Assert the refusal data (`OBJECT_NOT_FOUND`, `printed: [{ kind: 'path', path: arg }]`) and
   the ambiguity warnings `== 1`. Fails today with two warnings (probe lines above).
6. **GUARD** same file: `When revParse reads x~5` > `Then it warns twice, the ancestor step dropping the quiet read`.
   This passes today (`plan-guard-probe.log` `valid run1 revParse x~5`, logged `[W, W]`).
7. **GUARD** same file:
   `Given a tag d ahead of a dangling refs/heads/d` > `When revParse reads d^{blob}` > `Then the dangling line is logged twice`.
   This passes today (`plan-guard-probe.log` `S run1 revParse d^{blob}`).
8. **RED** interop suite: `describe.each` over A absent and M × {`x^{commit}`, `x^{blob}`},
   plus valid `x^{blob}`:
   `Given $variant` > `When git rev-parse and revParse read $arg` > `Then tsgit warns and errs as often as git, and refuses on the printed path`.
   Fails today: tsgit's diagnostics carry a second `warning: refname 'x' is ambiguous.`.
9. GREEN revision-name.ts, then rev-parse.ts as in Context. Steps 5, 8 and the existing suite
   turn green.
10. REFACTOR: keep each touched function under 20 lines. Run
    `npx vitest run test/unit/application/commands/rev-parse*.test.ts test/unit/application/commands/internal/revision-name.test.ts test/integration/rev-parse-*-interop.test.ts`.
    A pre-existing row that expects the reread's second ambiguity warning is a git-checked
    behaviour. Re-pin it on real git (throwaway) before changing its expectation, and quote
    the pin in the commit.

### Gate

```
npx vitest run test/unit/application/commands/internal/refname-ambiguity.test.ts test/unit/application/commands/rev-parse-misspelt-name.test.ts test/unit/application/commands/internal/revision-name.test.ts test/unit/application/commands/rev-parse.test.ts test/integration/commit-ish-corrupt-candidate-interop.test.ts test/integration/rev-parse-dwim-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/internal/refname-ambiguity.ts src/application/commands/internal/revision-name.ts src/application/commands/rev-parse.ts test/unit/application/commands/internal/refname-ambiguity.test.ts test/unit/application/commands/rev-parse-misspelt-name.test.ts test/integration/commit-ish-corrupt-candidate-interop.test.ts && npm run check:spelling
npx tsc --noEmit -p tsconfig.json
npx cspell --no-progress src/application/commands/internal/refname-ambiguity.ts src/application/commands/internal/revision-name.ts src/application/commands/rev-parse.ts test/unit/application/commands/internal/refname-ambiguity.test.ts test/unit/application/commands/rev-parse-misspelt-name.test.ts test/integration/commit-ish-corrupt-candidate-interop.test.ts
```

### Commit

`fix(rev-parse): read the misspelt-name reread quietly for the refname check, as git does`

## Part 3 — a tag whose object line does not parse names no object under a peel

### Context

**Edits** `src/application/primitives/internal/peel.ts`,
`test/unit/application/primitives/internal/peel.test.ts`,
`test/unit/application/commands/rev-parse-peel-errors.test.ts`,
`test/integration/commit-ish-corrupt-candidate-interop.test.ts`.

Current code:

- peel.ts private
  `readHop(ctx, table, oid): Promise<PeelHopObject | undefined>` (l.47) returns
  `parseTypedPeelHop(ctx, table, oid)` for a non-blob. That throws `INVALID_OBJECT_ID { value }`
  when a tag's `object` line is not an object id.
- `peel` (l.25) already turns an `undefined` hop result into `objectNotFound(walk.id)` (l.37).
- Consumers, read-only: rev-parse.ts `peelTo` (l.591) and `withPrinted`, and
  src/application/commands/internal/resolve-rev.ts `resolveCommit`, `resolveTreeish` and
  `peelToTree` (log, diff, grep, archive, shortlog, whatchanged, worktree).

Change (design D3, DC-P3(a)):

- `readHop` catches only `errorDataCode(error) === 'INVALID_OBJECT_ID'` and returns
  `undefined`, which is git's `parse_object` NULL in `peel_onion`.
- Every other error is rethrown. Name the code in a constant. Import `errorDataCode` from
  src/domain/error-data-code.ts.
- Known collateral, unpinned: `log x` (bare corrupt x) moves from `INVALID_OBJECT_ID` to
  `OBJECT_NOT_FOUND`. Both differ from git's `bad object x`. This is out of scope (design
  "Out of scope", last rows).

Fixtures:

- `writeRawObjectBytes(ctx, 'tag', bytes)` and `writeForgedTagLoop` in
  test/unit/application/primitives/fixtures.ts (read-only). Build the tag bytes as
  `object ${'z'.repeat(40)}\ntype commit\ntag x\ntagger A <a@a> 0 +0000\n\nmsg\n`.
- peel.test.ts has `logging()` (l.18) and `caught()` (l.34).
- rev-parse-peel-errors.test.ts has `peelRepo()` (l.66), `writeTag` (l.50) and
  `failureCode` (l.103). Extend `describe('Given objects behind zero or more tags')` (l.260).

Pinned rows:

- `rev-parse x^{commit}` and `x^{blob}`, A non-hex and truncated: 128, stdout the argument,
  W once, `AMBIGUOUS_ARGUMENT`.
- `log -1 x^{commit}` and `diff x^{commit}`: 128, W once, `AMBIGUOUS_ARGUMENT`
  (<scratchpad>/pin-git-7.log).

tsgit today: `pin-tsgit.log` the A non-hex `run1 revParse x^{commit}` line gives
`INVALID_OBJECT_ID { value: 'zzz…' }` with no printed path.

### TDD steps

1. **RED** peel.test.ts:
   `Given a tag whose object line is not an object id` > `When it is peeled to a commit` > `Then it refuses OBJECT_NOT_FOUND on the tag's id`.
   Use `describe.each` over `z`×40 and `abc`, and assert `data` `{ code: 'OBJECT_NOT_FOUND', id: tagId }`.
   Fails today with `INVALID_OBJECT_ID { value }`.
2. **GUARD** peel.test.ts:
   `Given a hop whose read fails without an error code` > `When it is peeled` > `Then the failure propagates unchanged`.
   Use `vi.spyOn` on the object-type-table module's `parseTypedPeelHop` rejecting
   `new Error('boom')`, and assert `caught` is that error. This passes today: `readHop` has
   no catch.
3. **RED** rev-parse-peel-errors.test.ts:
   `When revParse reads <tag>^{commit} on a tag whose object line does not parse` > `Then it prints the argument as a path and refuses OBJECT_NOT_FOUND`.
   See it fail with `INVALID_OBJECT_ID`.
4. **RED** interop suite: `describe.each` over non-hex and
   truncated × {`revParse x^{commit}`, `revParse x^{blob}`, `log({ rev: 'x^{commit}' })`, `diff({ from: 'x^{commit}' })`}.
   The log and diff rows compare `refused` and the warning lines only, plus tsgit
   `data.code === 'OBJECT_NOT_FOUND'`. git prints no stdout for them. Fails today:
   `INVALID_OBJECT_ID`, and no printed path for rev-parse. If the diff row's failure on
   today's code is not `INVALID_OBJECT_ID`, record the actual code in the row comment. It is
   unprobed on tsgit.
5. GREEN peel.ts `readHop`.
6. REFACTOR: none expected.

### Gate

```
npx vitest run test/unit/application/primitives/internal/peel.test.ts test/unit/application/commands/rev-parse-peel-errors.test.ts test/integration/commit-ish-corrupt-candidate-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/peel.ts test/unit/application/primitives/internal/peel.test.ts test/unit/application/commands/rev-parse-peel-errors.test.ts test/integration/commit-ish-corrupt-candidate-interop.test.ts && npm run check:spelling
npx tsc --noEmit -p tsconfig.json
npx cspell --no-progress src/application/primitives/internal/peel.ts test/unit/application/primitives/internal/peel.test.ts test/unit/application/commands/rev-parse-peel-errors.test.ts test/integration/commit-ish-corrupt-candidate-interop.test.ts
```

### Commit

`fix(rev-parse): a tag whose object line does not parse names no object under a peel`

## Part 4 — git-named refusal codes for a corrupt commit-ish

### Context

**Edits** `src/domain/commands/error.ts`, `src/domain/error.ts`,
`test/unit/domain/exhaustiveness.ts`, `test/unit/domain/commands/error.test.ts`,
`reports/api.json`, `docs/use/errors.md`.

**Public, decided now** (ADR-1141). Three new members of the public error union and their
factories. They are reachable through `TsgitErrorData`, so every gate below is pre-paid here.

| Code | Data | Factory (beside `cannotPickNonCommit`, l.880) | Message case in src/domain/error.ts (beside `CANNOT_PICK_NON_COMMIT`, l.681) | git line it rebuilds |
|---|---|---|---|---|
| `BAD_OBJECT` | `{ revision: string }` | `badObject(revision)` | `bad object ${data.revision}` | `fatal: bad object x` |
| `DESCRIBE_NEITHER_COMMIT_NOR_BLOB` | `{ revision: string }` | `describeNeitherCommitNorBlob(revision)` | `${data.revision} is neither a commit nor blob` | `fatal: x is neither a commit nor blob` |
| `BLAME_NON_COMMIT` | `{ revision: string }` | `blameNonCommit(revision)` | `Non commit ${data.revision}?` | `fatal: Non commit x?` |

- **Union members.** Put them in src/domain/commands/error.ts right after the
  `CANNOT_PICK_NON_COMMIT` member (l.331–337). Each `revision` doc comment reads: "the
  argument as the caller typed it (`'HEAD'` when the command defaults)". Each factory gets
  a one-line doc naming git's die site: `revision.c` get_reference, builtin/describe.c,
  builtin/blame.c.
- **Exhaustiveness switches.**
  - src/domain/error.ts has a `never` default at l.854. The compiler fails until the three
    message cases exist.
  - test/unit/domain/exhaustiveness.ts `assertExhaustiveSwitch` has a `never` default at
    l.297. Add the three `case` labels next to `'CANNOT_PICK_NON_COMMIT'` (l.214).
- **Tests.**
  - test/unit/domain/commands/error.test.ts "extractDetail message formatting" `cases`
    table (l.1800; the `CANNOT_PICK_NON_COMMIT` row is at l.2233). Add one row per code, for
    example `[{ code: 'BAD_OBJECT', revision: 'x' }, 'BAD_OBJECT: bad object x']`.
  - In "domain commands error — factory data" (l.130), add a `describe('Given a revision a corrupt commit-ish names')`
    with `it.each` over the three factories. Assert `.data` `toEqual({ code, revision: 'x' })`.
    This also keeps knip from flagging the factories before their consumers land. knip.json
    treats test files as entries.
- **API report.** Run `npm run docs:json`. It runs
  `typedoc --json reports/api.json --disableSources --out reports/api-tmp` and removes the
  temporary dir. Commit `reports/api.json`, whose typedoc id churn is normal.
  `check:doc-typedoc` (`git diff --exit-code -- reports/api.json`) runs at **pre-push**, not
  in `npm run validate`.
- **Docs surface.** Not gated, but kept true. Add three rows to the table in
  docs/use/errors.md next to `CANNOT_PICK_NON_COMMIT` (l.179), in the same
  `| code | fields | meaning |` shape:
  - `BAD_OBJECT`: the named object does not read (cherry-pick, revert, blame).
  - `DESCRIBE_NEITHER_COMMIT_NOR_BLOB`: describe's target does not read or peel.
  - `BLAME_NON_COMMIT`: blame's named tag reads but its target is missing.
- **Size gate.** The three messages land in every bundle that carries src/domain/error.ts.
  Earlier runs saw under 100 B headroom on the core and browser rows. Run `npm run build`
  (a clean rebuild; stale dist chunks have tripped this before) and then
  `npm run check:size`. If any row goes over, stop and escalate
  `{ unit: 'part 4', reason: '<row> <size>/<limit>', options }`. Never raise a limit
  yourself.

### TDD steps

1. **RED** error.test.ts message rows (3). Fails today: the message builder has no case, so
   the detail is not the expected text.
2. **RED** error.test.ts factory rows. Fails today: `badObject` and the others are not
   exported (`TypeError: … is not a function`).
3. GREEN: union members, factories, message cases, exhaustiveness cases.
4. Regenerate `reports/api.json`. Add the docs rows.
5. REFACTOR: none.

### Gate

```
npx vitest run test/unit/domain/commands/error.test.ts test/unit/domain/error.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/commands/error.ts src/domain/error.ts test/unit/domain/exhaustiveness.ts test/unit/domain/commands/error.test.ts && npm run check:spelling
npx tsc --noEmit -p tsconfig.json
npx cspell --no-progress src/domain/commands/error.ts src/domain/error.ts test/unit/domain/exhaustiveness.ts test/unit/domain/commands/error.test.ts docs/use/errors.md
npm run docs:json && git diff --stat -- reports/api.json
npm run build && npm run check:size && npm run check:dead-code
```

### Commit

`feat(errors): add BAD_OBJECT, DESCRIBE_NEITHER_COMMIT_NOR_BLOB and BLAME_NON_COMMIT refusals`

## Part 5 — the commit-ish ladder takes the first candidate; describe refuses a corrupt one

### Context

**Edits** `src/application/commands/internal/commit-ish.ts`,
`src/application/primitives/resolve-ref.ts` (doc comment only),
`test/unit/application/commands/internal/commit-ish.test.ts`,
`src/application/commands/describe.ts`, `test/unit/application/commands/describe.test.ts`,
`test/integration/commit-ish-corrupt-candidate-interop.test.ts`.

Current code, commit-ish.ts (76 lines):

- `resolveCommitIsh(ctx, target): Promise<ObjectId>` (l.32).
  - A full oid: `warnIfRefNamesObjectId(ctx, target, peeledCandidate(ctx))`, then the oid
    verbatim. It is never read.
  - `nthPriorCheckout`, then `resolvePriorCheckout` (l.55): a detached prior checkout gives
    its oid verbatim, a branch goes through `resolveSubstitutedRefLadder(…, peeledCandidate(ctx))`.
  - `resolveRefLadder(ctx, target, peeledCandidate(ctx))`.
  - `resolveOidPrefix(ctx, target)`, verbatim and unpeeled.
  - Otherwise `refNotFound`.
- `peeledCandidate` (l.67) calls `readRefCandidate(ctx, c, { peel: true })`. It folds
  `isAbsentCandidate` (l.27: `OBJECT_NOT_FOUND` plus `UNREADABLE_REF_CODES`) to
  `{ kind: 'missing' }`. **That fold is the sweep.**
- `readRefCandidate` (resolve-ref.ts:159) already turns ref-read faults into
  broken/dangling/missing candidates on its own (`isUnreadableRef` → `unreadableCandidate`).
  So a broken ref, a cycle and a five-hop chain stay skipped whatever `peel` says.

Change (design D1, ADR-1141, refinements above):

- Delete `isAbsentCandidate` and `peeledCandidate`, and drop the `UNREADABLE_REF_CODES`
  import. Add a private `unpeeledCandidate = (ctx) => (c) => readRefCandidate(ctx, c)`.
- Add a private resolver that returns `{ id, namedBy }`, with
  `type NamedBy = 'object-name' | 'ref'`. It is today's ladder over the unpeeled resolver:
  a full oid, a detached prior checkout and an oid prefix give `'object-name'`; the ref
  ladder and a prior-checkout branch give `'ref'`.
- `export const resolveCommitIshObject = async (ctx, target): Promise<ObjectId>`: git's
  `repo_get_oid`, the winner unpeeled.
- `export const resolveCommitIsh`: the same resolution, then a `'ref'` winner is peeled
  through `peelChain(ctx, id, readObject, tagHop)`
  (src/application/primitives/internal/peel-chain.ts and read-object.ts, read-only). That is
  equal to resolve-ref.ts's private `peelTags` at unbounded depth. An `'object-name'` winner
  is returned verbatim, as today. A peel fault propagates.
- `export const isObjectReadFault = (error: unknown): boolean`: true exactly for the two
  codes of DC-P3(a), through `errorDataCode` and a module-level `ReadonlySet`. Parts 6 and 7
  reuse it.
- resolve-ref.ts:14 doc comment: drop `resolveCommitIsh` from "a caller sweeping several
  candidates", or reword it to the rev-parse ladder. Comment only.
- Other `resolveCommitIsh` callers keep it and so pick up the propagated fault (ADR-1141 with
  ADR-233), with no edit:
  - rebase.ts:1290, the interactive todo `oid`. It is resolved in the planning loop before
    any state is written.
  - rebase-merges-steps.ts:51 `lookupLabel`.
  - blame.ts:183/193/224 and sequencer-revisions.ts:109 until Parts 6 and 7.

Describe (current describe.ts):

- `describe(ctx, rev?, opts = {})` (l.78). At l.86:
  `const target = await resolveCommitIsh(ctx, rev ?? DEFAULT_REV);` (`DEFAULT_REV = 'HEAD'`, l.65).
  Today the corrupt candidate is swept, and the fault escapes later from `buildNameMap`.
- Add a private
  `resolveDescribeTarget(ctx, revision: string): Promise<ObjectId>`: `try { return await resolveCommitIsh(ctx, revision) } catch (e) { if (isObjectReadFault(e)) throw describeNeitherCommitNorBlob(revision); throw e; }`.
  The ladder cannot throw either fault code: `readRefCandidate` folds a ref file's
  `INVALID_OBJECT_ID` as broken, and the prefix scan logs candidate read faults. So an
  unresolved name keeps `REF_NOT_FOUND`, and the ladder's warning is logged before the
  refusal.
- l.86 becomes `resolveDescribeTarget(ctx, rev ?? DEFAULT_REV)`.
- `describeContains` (`--contains`) does not reach it and is untouched.

Fixtures (unit):

- commit-ish.test.ts `seedCommit()` (l.25) and `codeOf` (l.34).
- Plant the corrupt tag with `writeRawObjectBytes(ctx, 'tag', bytes)` (primitives
  fixtures.ts, read-only) and write the tag ref x and the branch x with
  `ctx.fs.writeUtf8(\`${gitDir}/refs/…/x\`, \`${id}\n\`)`.
- Capture `ctx.logger.warn` with a closure array.
- describe.test.ts `seed()` (l.36) and `commitFile` (l.44).

Pinned rows:

- `describe x` and `describe --always x`, for non-hex, truncated, absent and M: 128, W, then
  `fatal: x is neither a commit nor blob`.
- `rebase -i`, todo `pick x`: git exits 1 with `error: invalid line 1: pick x`. tsgit refuses
  before state with the raw fault: non-hex and truncated `INVALID_OBJECT_ID { value }`,
  absent `OBJECT_NOT_FOUND { id: 'a'×40 }`, M `OBJECT_NOT_FOUND { id: 'b'×40 }`. No
  `rebase-merge` dir is written, and HEAD is unchanged.

tsgit today: `pin-tsgit.log` `resolveCommitIsh x` lines return c1 with `logged=[]`. `pin-tsgit-2.log`
`describe x always` gives INVALID_OBJECT_ID or OBJECT_NOT_FOUND with `logged=[]`.

### TDD steps

1. **RED** commit-ish.test.ts: a `describe.each` over non-hex (`INVALID_OBJECT_ID { value: 'z'×40 }`),
   absent (`OBJECT_NOT_FOUND { id: 'a'×40 }`) and M (`OBJECT_NOT_FOUND { id: 'b'×40 }`):
   `Given a tag ref x naming a $variant object ahead of branch x` > `When resolveCommitIsh resolves x` > `Then it refuses on the tag ref and warns the ambiguity first`.
   Fails today: it returns the branch tip and logs nothing.
   **Replace** the mock-based test "Given a ref candidate whose target object is absent ahead
   of a resolvable one … swept past" (l.~345). It asserts the sweep this part removes.
2. **RED** commit-ish.test.ts:
   `Given an annotated tag v1` > `When resolveCommitIshObject resolves v1` > `Then it returns the tag's own id`.
   Fails today: the export does not exist.
3. **RED** commit-ish.test.ts, `describe.each` over the two codes, `REF_NOT_FOUND`, and an
   code-less `Error`: `Given a $fault` > `When isObjectReadFault judges it` > `Then it answers $expected`.
   Fails today: no export.
4. **RED** interop suite rows for the rebase todo. Run them red;
   today the sweep resolves c1 and refuses `INVALID_OPTION` "not in the list".
   `describe.each` over non-hex, truncated, absent and M:
   `Given $variant` > `When git rebase -i and rebaseRun take the todo pick x` > `Then both refuse and tsgit writes no rebase state`.
   - git side: `tryRunGitWithExit(['-C', dir, 'rebase', '-i', c1], { env: { ...env, GIT_SEQUENCE_EDITOR: "printf 'pick x\\n' >" } })`.
     Assert `exitCode === 1` and that stderr contains `error: invalid line 1: pick x`.
   - tsgit side: `rebaseRun(ctx, { upstream: c1, interactive: [{ action: 'pick', oid: 'x' }] })`.
     Assert `.data` per the pinned row, no `.git/rebase-merge`, and HEAD still c2.
5. **GUARD** the existing rows still pass:
   - "a broken ref candidate ahead of a resolvable one" (l.183)
   - "symref-cycle" (l.203)
   - "five-hop" (l.~292)
   - "store rejects while a candidate is peeled" (l.~322)
   - the full-oid, SHA-256 and prefix rows (l.43–117)
   They pass because `readRefCandidate` folds ref-read faults itself (resolve-ref.ts:165–169),
   and the `'object-name'` arm keeps the verbatim return.
6. GREEN commit-ish.ts, plus the resolve-ref.ts comment.
7. **RED** describe.test.ts, `describe.each` over the four variants:
   `Given a tag ref x naming a $variant object ahead of branch x` > `When describe reads x` > `Then it refuses DESCRIBE_NEITHER_COMMIT_NOR_BLOB { revision: 'x' } after warning the ambiguity`.
   Add a second row with `{ always: true }`. Fails at this step (after the commit-ish GREEN): the raw
   `INVALID_OBJECT_ID` or `OBJECT_NOT_FOUND` escapes from `resolveCommitIsh`.
8. **GUARD** describe.test.ts:
   `Given a name no ref or object carries` > `When describe reads it` > `Then it refuses REF_NOT_FOUND { name }`.
   This passes today (commit-ish.ts:50 `refNotFound(target)`).
9. **GUARD** describe.test.ts:
   `Given a tag whose read fails without a code` > `When describe reads it` > `Then the failure propagates`.
   Use `vi.spyOn(readObjectModule, 'readObject')` rejecting `new Error('boom')` for the tag
   id. This passes today: `isAbsentCandidate` rethrows an code-less error (commit-ish.ts:73).
10. **RED** interop rows: describe and `describe --always`
    (`describe(ctx, 'x', { always: true })`) × four variants. Add the refusal arm
    `DESCRIBE_NEITHER_COMMIT_NOR_BLOB` → `fatal: ${revision} is neither a commit nor blob`.
    Run it red before the next step.
11. GREEN describe.ts `resolveDescribeTarget`.
12. REFACTOR: commit-ish.ts functions under 20 lines; no `UNREADABLE_REF_CODES` or dead imports left.

### Gate

```
npx vitest run test/unit/application/commands/internal/commit-ish.test.ts test/unit/application/commands/describe.test.ts test/unit/application/commands/rebase-merges.test.ts test/integration/commit-ish-corrupt-candidate-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/internal/commit-ish.ts src/application/primitives/resolve-ref.ts src/application/commands/describe.ts test/unit/application/commands/internal/commit-ish.test.ts test/unit/application/commands/describe.test.ts test/integration/commit-ish-corrupt-candidate-interop.test.ts && npm run check:spelling
npx tsc --noEmit -p tsconfig.json
npx cspell --no-progress src/application/commands/internal/commit-ish.ts src/application/primitives/resolve-ref.ts src/application/commands/describe.ts test/unit/application/commands/internal/commit-ish.test.ts test/unit/application/commands/describe.test.ts test/integration/commit-ish-corrupt-candidate-interop.test.ts
```

### Commit

`fix(describe): take the first commit-ish candidate unswept and refuse a corrupt one as git does`

## Part 6 — the sequencer refuses a corrupt name with git's codes and reads each name twice

### Context

**Edits** `src/application/commands/internal/commit-ish.ts`,
`test/unit/application/commands/internal/commit-ish.test.ts`,
`src/application/commands/internal/sequencer-revisions.ts`,
`test/unit/application/commands/internal/sequencer-revisions.test.ts`,
`test/integration/commit-ish-corrupt-candidate-interop.test.ts`.
commit-ish.ts comes back from Part 5 because `readRevisionObject` is the sequencer's
get_reference. Its first consumer is here.

Current code, sequencer-revisions.ts (138 lines):

- `resolveSeeds(ctx, args)` (l.79) runs `addSeed` per arg into mutable `SeedLists`, then
  `assertPicksCommit` per `seeds.objects`.
- `assertPicksCommit(ctx, { name, id })` (l.87):
  `peelRefToCommit(ctx, id)` (primitives/internal/peel-ref-to-commit.ts, read-only, returns
  `{ commit, viaTag, taggerDate } | undefined`), else
  `cannotPickNonCommit(name, (await readObject(ctx, id)).type)`.
- `addSeed(ctx, arg, seeds)` (l.93):
  - `A..B` sides go through `evaluateRevision` (from ../rev-parse.js).
  - `^A` goes through `evaluateRevision`.
  - Otherwise `REVISION_OPERATOR.test(arg) ? evaluateRevision : resolveCommitIsh` (l.109).
  - Then `addTip` or `addExcluded`.
- `walkSeeds` feeds `seeds.tips`, `seeds.excluded` and `seeds.named` to `limitList`, which
  does not peel.

Change (design D2, ADR-1141, ADR-1146):

1. commit-ish.ts:
   `export const readRevisionObject = async (ctx, id: ObjectId, revision: string): Promise<GitObject>`.
   It calls `readObject(ctx, id)`. On `isObjectReadFault(error)` it throws `badObject(revision)`;
   anything else (an code-less error included) is rethrown.
2. sequencer-revisions.ts, two phases, as git does:
   - **Phase 1** (`setup_revisions`): resolve every argument into a list of
     `{ name, id, role: 'tip' | 'excluded' }`. The plain-name arm uses `resolveCommitIshObject`,
     then `readRevisionObject(ctx, id, arg)`. The operator, range and `^` arms keep
     `evaluateRevision`.
   - **Phase 2** (`sequencer_pick_revisions`): for each named object, run a private
     `pickedCommit(ctx, named)`:
     - `const reread = await evaluateRevision(ctx, named.name)`. This is git's second
       `repo_get_oid`: the second ambiguity warning, and the third fanout log in Part 9.
     - Peel `reread` with `peelRefToCommit` inside a try. `isObjectReadFault` or `undefined`
       refuses `cannotPickNonCommit(named.name, (await readObject(ctx, reread)).type)`. That
       type is the unpeeled object's, so a tag reports `'tag'`.
     - It returns `peeled.commit.id`. Push that into `tips`, `excluded` and `named` by role,
       so every seed is a commit id.
   - All of it runs before `openReplayRun` writes state.
   - Keep `SeedLists` construction immutable-by-default where cheap. Keep functions under
     20 lines.
3. git resolves every argument before checking types. The row "a blob id and then an unknown
   revision" (l.280) guards that ordering.

Unit fixture: sequencer-revisions.test.ts `buildHistory(SPEC)` (l.30). `history.id('a2')`,
`history.ctx`. Plant tags with `writeObject` and raw tags with `writeRawObjectBytes`, and refs
with `history.ctx.fs.writeUtf8`. Capture warnings with `{ ...history.ctx, logger: { warn } }`.

Pinned rows (design matrix):

- `cherry-pick x`, `cherry-pick x main` and `revert x` on non-hex, truncated and M: 128,
  W, `fatal: bad object x`, no state.
- The same routes on absent: 128, **W×2**, `error: x: can't cherry-pick a tag`, then
  `fatal: cherry-pick failed` (revert: `fatal: revert failed`), no state.
- TT `cherry-pick t` and `t main`: 128, `error: t: can't cherry-pick a tag`,
  `fatal: cherry-pick failed`.
- Valid controls `cherry-pick x`, `cherry-pick x..main`, `cherry-pick ^x main` and
  `revert x`: **W×2**. Compare the warning lines only; the picks themselves proceed.
- R6: no `CHERRY_PICK_HEAD`, `REVERT_HEAD` or `sequencer`, HEAD at c2, and
  `git status --porcelain` empty, on both twins.

tsgit at this step (after Part 5): the plain arm propagates raw `INVALID_OBJECT_ID` or
`OBJECT_NOT_FOUND`. On absent, `resolveCommitIsh` throws `OBJECT_NOT_FOUND`. TT reports
`type: 'tree'` (`pin-tsgit-2.log` `TT run1 cherryPickRun t`). The valid controls log W once
(`pin-tsgit-2.log` `A valid run1 cherryPickRun x main` and `revertRun x`).

Interop additions:

- A `stateOf(dir)` helper: existence of the three state paths, plus `git rev-parse HEAD`
  and `git status --porcelain`.
- Refusal arms: `BAD_OBJECT` → `fatal: bad object ${revision}`. `CANNOT_PICK_NON_COMMIT` →
  `error: ${revision}: can't cherry-pick a ${type}` + `fatal: ${route} failed`, where the row
  passes `route` (`cherry-pick` or `revert`).
- APIs: `cherryPickRun(ctx, { commits: [...] })` from src/application/commands/cherry-pick.ts
  and `revertRun(ctx, { commits: [...] })` from src/application/commands/revert.ts.

### TDD steps

1. **RED** commit-ish.test.ts: `describe.each` over the non-hex tag (`INVALID_OBJECT_ID`) and
   a missing id (`OBJECT_NOT_FOUND`):
   `Given a named object whose read fails with $code` > `When readRevisionObject reads it` > `Then it refuses BAD_OBJECT { revision }`.
   Fails: no export.
2. **RED** commit-ish.test.ts:
   `Given a read failing without a code` > `When readRevisionObject reads it` > `Then the failure propagates unchanged`.
   Use `vi.spyOn(readObjectModule, 'readObject')`. Fails: no export. Make it a separate test
   from step 1.
3. GREEN `readRevisionObject`.
4. **RED** sequencer-revisions.test.ts, `describe.each` over non-hex and M:
   `Given a tag ref x naming a $variant object ahead of branch x` > `When the sequencer resolves x` > `Then it refuses BAD_OBJECT { revision: 'x' }`.
   Fails: the raw `INVALID_OBJECT_ID` or `OBJECT_NOT_FOUND` propagates.
5. **RED** sequencer-revisions.test.ts, `describe.each` over absent (a tag naming a missing
   object) and a tag of a tree:
   `When the sequencer resolves the tag's name` > `Then it refuses CANNOT_PICK_NON_COMMIT with type 'tag'`.
   Fails: absent gives `OBJECT_NOT_FOUND`, and the tag of a tree gives `type: 'tree'`.
6. **RED** sequencer-revisions.test.ts, `describe.each` over `['x']`, `['x..main']` and
   `['^x', 'main']`, with x valid and ambiguous (a lightweight tag and a branch on one
   commit):
   `When the sequencer resolves $args` > `Then it warns the ambiguity twice, once per read git makes`.
   Fails: it warns once.
7. **GUARD** the existing table rows (l.99–150 walk orders, "a tree path", "a range side
   naming a tree", "excluding a tree", "a blob id", "a blob id and then an unknown revision")
   stay green. Phase 2 reads the same names; tree and blob objects keep their own type. Run
   them right after GREEN. If one goes red, stop: it is a behaviour claim this plan did not
   probe.
8. **RED** interop rows, run red before the next step. Cherry-pick single and list, and
   revert, on the four corrupt variants; TT single and list; the valid W×2 controls; and R6
   `stateOf` equality on every refusal row.
9. GREEN sequencer-revisions.ts phases 1 and 2.
10. REFACTOR: the `SeedLists` push helpers collapse into one role-keyed push if that is shorter.

### Gate

```
npx vitest run test/unit/application/commands/internal/commit-ish.test.ts test/unit/application/commands/internal/sequencer-revisions.test.ts test/unit/application/commands/cherry-pick.test.ts test/unit/application/commands/revert.test.ts test/integration/commit-ish-corrupt-candidate-interop.test.ts test/integration/sequencer-range-order-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/internal/commit-ish.ts src/application/commands/internal/sequencer-revisions.ts test/unit/application/commands/internal/commit-ish.test.ts test/unit/application/commands/internal/sequencer-revisions.test.ts test/integration/commit-ish-corrupt-candidate-interop.test.ts && npm run check:spelling
npx tsc --noEmit -p tsconfig.json
npx cspell --no-progress src/application/commands/internal/commit-ish.ts src/application/commands/internal/sequencer-revisions.ts test/unit/application/commands/internal/commit-ish.test.ts test/unit/application/commands/internal/sequencer-revisions.test.ts test/integration/commit-ish-corrupt-candidate-interop.test.ts
```

### Commit

`fix(cherry-pick): refuse a corrupt commit-ish with git's codes and read each name twice`

## Part 7 — blame and merge refuse a corrupt first candidate as git does

### Context

**Edits** `src/application/commands/blame.ts`, `test/unit/application/commands/blame.test.ts`,
`src/application/commands/merge.ts`,
`test/unit/application/commands/merge-revision-forms.test.ts`,
`test/integration/commit-ish-corrupt-candidate-interop.test.ts`.

Blame, current code:

- `blame(ctx, path, opts?)` (blame.ts:159). Its non-worktree arm (l.~192–193) is
  `const rev = opts.rev ?? DEFAULT_REV; await seed(board, await resolveCommitIsh(ctx, rev), filePath, rev, opts.range);`.
- The bare-repository site (l.~183) and the `seedWorkingTree` site (l.~224) resolve
  `DEFAULT_REV`. They keep `resolveCommitIsh`; a corrupt HEAD is unpinned (design "Out of scope").

Blame change (ADR-1141 tiers). Add a private
`resolveBlameTarget(ctx, revision: string): Promise<ObjectId>`:

```ts
const named = await resolveCommitIshObject(ctx, revision);          // the ladder warns first
const object = await readRevisionObject(ctx, named, revision);      // BAD_OBJECT: non-hex, truncated, M
if (object.type !== 'tag') return named;
// peel object.data.object with peelChain(ctx, …, readObject, tagHop) inside a try:
// errorDataCode === 'OBJECT_NOT_FOUND' → throw blameNonCommit(revision) (absent); anything else rethrown
```

Only `OBJECT_NOT_FOUND` maps to `BLAME_NON_COMMIT`; that is the pinned tier. The call at
l.193 becomes `resolveBlameTarget(ctx, rev)`. blame makes one read, so it warns once.

Merge, current code: merge.ts `resolveMergeParent(ctx, name)` (l.661):

```ts
const object = await resolveRevisionExpression(ctx, spelt);
if (object === undefined) throw refNotFound(name as RefName);
const { id, result } = await peelChain(ctx, object, readObject, tagHop);
if (result.type !== 'commit') throw refNotFound(name as RefName);
```

`resolveRemotes` (l.672) runs it per octopus head.

Merge change (ADR-1145): wrap the `peelChain` call in a small private helper.
`isObjectReadFault` (from ./internal/commit-ish.js) becomes `refNotFound(name as RefName)`.
Everything else is rethrown. `MERGE_HEAD` is never written.

Fixtures:

- blame.test.ts uses `createMemoryContext`, `init`, `commitFile(ctx, label, path, body)` and
  `write`. Look at the "worktree blame that cannot resolve the path" table (l.~1605) for the
  `rejects.toMatchObject({ data })` shape, but use try/catch with `.data` `toEqual` for the
  new rows.
- merge-revision-forms.test.ts has `seed()` (l.30): base, side g/h with tag v1, main m, HEAD
  on main. Results use the `sut(…).then(() => undefined, (e) => e.data)` shape (l.118).
  Plant the corrupt tag ref x with `writeRawObjectBytes` from the primitives fixtures.

Pinned rows:

- `blame x -- f`: non-hex, truncated and M give 128, W, `fatal: bad object x`. Absent gives
  128, W, `fatal: Non commit x?`.
- `merge x`: all four variants give exit 1, W, `merge: x - not something we can merge`.

tsgit at this step:

- blame propagates the raw `INVALID_OBJECT_ID` or `OBJECT_NOT_FOUND` (Part 5).
- merge: `pin-tsgit.log` the A non-hex `run1 mergeRun x` line gives `INVALID_OBJECT_ID` with W logged,
  and `pin-tsgit-5.log` M gives `OBJECT_NOT_FOUND { id: 'b'×40 }` with W.

Interop refusal arms:

- `BLAME_NON_COMMIT` → `fatal: Non commit ${revision}?`.
- `REF_NOT_FOUND` on the merge route → `merge: ${name} - not something we can merge`.
  The row tags the route. git's exit class is 1, and `refused` is `exitCode !== 0`.

### TDD steps

1. **RED** blame.test.ts, `describe.each` over non-hex, truncated and M:
   `Given a tag ref x naming a $variant object ahead of branch x` > `When blame reads f at x` > `Then it refuses BAD_OBJECT { revision: 'x' } after warning the ambiguity`.
   Fails: the raw fault propagates.
2. **RED** blame.test.ts:
   `Given a tag ref x whose target object is missing` > `When blame reads f at x` > `Then it refuses BLAME_NON_COMMIT { revision: 'x' }`.
   Fails: raw `OBJECT_NOT_FOUND`.
3. **GUARD** blame.test.ts:
   `Given a tag target whose read fails without a code` > `When blame reads f at x` > `Then the failure propagates`.
   Use `vi.spyOn(readObjectMod, 'readObject')`; the `readObjectMod` import already exists at
   l.20. This passes at this step: `resolveCommitIsh`'s `peelChain` rethrows it.
4. **RED** interop blame rows × four variants, run red before the next step.
5. GREEN blame.ts `resolveBlameTarget`.
6. **RED** merge-revision-forms.test.ts, `describe.each` over the four variants ×
   {`rev: 'x'`, `rev: ['side', 'x']`}:
   `Given a tag ref x naming a $variant object` > `When merge takes $rev` > `Then it refuses REF_NOT_FOUND { name: 'x' }`.
   Fails with raw `INVALID_OBJECT_ID` or `OBJECT_NOT_FOUND`.
7. **RED** interop merge rows × four variants, plus R6: no `MERGE_HEAD`, HEAD unchanged.
8. GREEN merge.ts.
9. REFACTOR: none expected.

### Gate

```
npx vitest run test/unit/application/commands/blame.test.ts test/unit/application/commands/merge-revision-forms.test.ts test/unit/application/commands/merge.test.ts test/integration/commit-ish-corrupt-candidate-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/blame.ts src/application/commands/merge.ts test/unit/application/commands/blame.test.ts test/unit/application/commands/merge-revision-forms.test.ts test/integration/commit-ish-corrupt-candidate-interop.test.ts && npm run check:spelling
npx tsc --noEmit -p tsconfig.json
npx cspell --no-progress src/application/commands/blame.ts src/application/commands/merge.ts test/unit/application/commands/blame.test.ts test/unit/application/commands/merge-revision-forms.test.ts test/integration/commit-ish-corrupt-candidate-interop.test.ts
```

### Commit

`fix(blame,merge): refuse a corrupt first commit-ish candidate as git does`

## Part 8 — the prefix scan skips and logs an unreadable fanout directory

### Context

**Edits** `src/application/primitives/resolve-oid-prefix.ts`,
`src/application/primitives/internal/loose-oid-cache.ts` (doc comment only),
`test/unit/application/primitives/resolve-oid-prefix.test.ts`,
`test/unit/application/primitives/abbreviate-object-id.test.ts`. **Creates**
`test/integration/posix-only/rev-parse-unreadable-fanout-interop.test.ts`.
Part 9 shares the scan file and the posix suite.

Current code, resolve-oid-prefix.ts:

- `scanLooseIn(ctx, source, prefix)` (l.74) computes
  `const dir = fanoutDirIn(source.objectsDir, prefix.slice(0, 2))`. Around
  `source.fs.readdir(dir)` it has `catch (error) { if (!isMissingFanoutDir(error)) throw error; return []; }`.
- It is shared by `resolveOidPrefix` (l.158) and abbreviate-object-id.ts `rivalsSharing`
  (l.47).
- `isMissingFanoutDir` (loose-oid-cache.ts, `FILE_NOT_FOUND` or `NOT_A_DIRECTORY`) stays for
  `listSuffixes`. Its doc comment says "Exported for resolve-oid-prefix.ts's scanLoose".
  Reword it, since this part drops that import. Keep the export: knip's
  `ignoreExportsUsedInFile` covers it.

Change (ADR-1142, ADR-1144): a private classifier in resolve-oid-prefix.ts.

- `FILE_NOT_FOUND` → `[]`, silent.
- No code (`errorDataCode(error) === undefined`) → rethrow.
- Any other code (`PERMISSION_DENIED`, `NOT_A_DIRECTORY`, …) → `[]` plus
  `ctx.logger?.error?.(\`unable to open ${dir}\`, { path: dir, code })`. Name the message
  prefix as a constant.
- Update the module JSDoc (l.67–73), which says faults are rethrown.

Unit fixtures, resolve-oid-prefix.test.ts:

- `buildSeededContext`, `instrumentedContext`, `writeLooseNamed` (l.~52) and
  `writeSyntheticPack(In)` (pack-fixture.ts, read-only).
- The PERMISSION_DENIED row (l.432) stubs `fs.readdir` as
  `{ ...base, fs: { ...base.fs, readdir: async (p) => { if (p === fanoutDir) throw permissionDenied(fanoutDir); return base.fs.readdir(p); } } }`.
  Reuse it, and add `logger: { error }` to the spread.
- The regular-file row is at l.416, and the missing-dir row at l.399.

abbreviate-object-id.test.ts (341 lines): use the same stub pattern on the id's own prefix
directory.

**Posix suite.** Its header is the first JSDoc. bucket `platform-only` is allowed under
posix-only by the `directoryRules`. Omit `interopSurface:`: the write-surface audit requires
it only on `cross-tool-interop`. Gate it like test/integration/posix-only/status-refresh-readonly-interop.test.ts:

- `const IS_ROOT = process.getuid?.() === 0; describe.skipIf(!GIT_AVAILABLE || IS_ROOT)(…)`.
- `afterEach` restores `chmod(dir, 0o755)` on every directory a row made unreadable. Keep
  them in a list.
- `makePeerPair` for twins, `pair.dispose()` in `afterEach`.

```ts
/**
 * POSIX-only interop — the abbreviated-oid scan over a fanout directory that cannot be listed:
 * mode 000, or a regular file at the fanout path. git logs `error: unable to open <dir>: <errno
 * text>` and carries on; each row rebuilds those lines from tsgit's structured error log and
 * compares them and their count.
 *
 * @proves
 *   surface:        revParse, abbreviateObjectId, describe, cherryPick, revert, merge, blame
 *   bucket:         platform-only
 *   unique:         an unreadable fanout directory is skipped and logged as often as git logs it on every route
 */
```

Fixture B:

- `git init`, `f` = `hi\n`, commit c1 with pinned dates, `git branch abcd`. Then
  mkdirSync on the repository's objects/ab and `chmodSync(…, 0)`.
- File variant: an empty regular file written at objects/ab instead.
- Packed clone: build that repo without the branch, `git clone -q --no-local src dst`, then
  make `dst`'s objects/<first two hex of HEAD> with mode 0. Derive the prefix from
  `git rev-parse HEAD`; never hard-code it.

Rebuilding the error line:

- `error: unable to open ${path.relative(ctx.layout.workDir, logged.path)}: ${ERRNO_TEXT[logged.code]}`,
  with the test-local
  `ERRNO_TEXT = { PERMISSION_DENIED: 'Permission denied', NOT_A_DIRECTORY: 'Not a directory' }`.
- Compare it with git's stderr lines matching `/^error: unable to open /`.
- Make the path relative to `ctx.layout.workDir`, not the mkdtemp path: macOS tmp paths resolve
  through `/private`.

Run the posix suite with
`npx vitest run --project posix-integration test/integration/posix-only/rev-parse-unreadable-fanout-interop.test.ts`.
A plain `npx vitest run <file>` reports "No test files found": the default projects exclude
test/integration/posix-only (vitest.config.ts l.57, project `posix-integration` at l.68).
`npm run validate` does not run it; the CI job does.

Pinned rows this part owns. Each needs one scan per call, so no memo is needed:

- Packed clone, mode 000 on the HEAD prefix:
  - `rev-parse <7-hex of HEAD>` exits 0 with E×1.
  - `rev-parse --short HEAD` is tsgit `abbreviateObjectId(ctx, head)`: E×1.
  - `describe --always` is tsgit `describe(ctx, undefined, { always: true })` followed by the
    test's own `abbreviateObjectId(ctx, result.oid)`. The caller renders (ADR-249), and E×1
    comes from that call.
- `-c core.warnAmbiguousRefs=false rev-parse abcd`, mode-000 dir: git exits 0 with no
  stderr. For tsgit, write `core.warnAmbiguousRefs false` into the repo config with git
  before building the Context.

tsgit today (`pin-tsgit-2.log`):

- `B packed run1 revParse 962da73` and `abbreviateObjectId HEAD` throw `PERMISSION_DENIED`.
- `B packed run1 describe always` returns ok with `logged=[]`. Its render call to
  `abbreviateObjectId` throws.
- `B dir run1 warnAmbiguousRefs=false revParse abcd` returns ok with `logged=[]`.

### TDD steps

1. **RED** resolve-oid-prefix.test.ts, rewriting the l.432 row:
   `Given a fanout directory whose readdir rejects with PERMISSION_DENIED` > `When resolveOidPrefix scans that prefix` > `Then it answers undefined and logs one unable-to-open error with the path and code`.
   Assert `error` was called once with `(\`unable to open ${fanoutDir}\`, { path: fanoutDir, code: 'PERMISSION_DENIED' })`.
   Fails today: the fault is rethrown.
2. **RED** same file, extending the l.416 row with a logger:
   `Then it answers undefined and logs NOT_A_DIRECTORY once`. Fails today: silent fold.
3. **GUARD** same file, extending the l.399 row: `Then it logs nothing`. This passes today:
   `FILE_NOT_FOUND` is folded silently (l.86).
4. **GUARD** same file:
   `Given a fanout readdir that fails without an error code` > `When resolveOidPrefix scans` > `Then the failure propagates`.
   This passes today: `isMissingFanoutDir` is false for it, so it is rethrown.
5. **RED** abbreviate-object-id.test.ts:
   `Given the id's own fanout directory rejects PERMISSION_DENIED` > `When abbreviateObjectId abbreviates it` > `Then it answers the base-length abbreviation and logs once`.
   Fails today: it throws.
6. **RED** posix suite: the three packed rows. See them fail with `PERMISSION_DENIED`.
7. GREEN the classifier and the doc comments.
8. **GUARD** posix suite: the `core.warnAmbiguousRefs=false` row passes today (probe line
   above). The ladder reads the setting and returns before `isAmbiguous`.
9. REFACTOR: keep `scanLooseIn` under 20 lines by extracting the classifier.

### Gate

```
npx vitest run test/unit/application/primitives/resolve-oid-prefix.test.ts test/unit/application/primitives/abbreviate-object-id.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/resolve-oid-prefix.ts src/application/primitives/internal/loose-oid-cache.ts test/unit/application/primitives/resolve-oid-prefix.test.ts test/unit/application/primitives/abbreviate-object-id.test.ts test/integration/posix-only/rev-parse-unreadable-fanout-interop.test.ts && npm run check:spelling
npx vitest run --project posix-integration test/integration/posix-only/rev-parse-unreadable-fanout-interop.test.ts
npx tsc --noEmit -p tsconfig.json
npx cspell --no-progress src/application/primitives/resolve-oid-prefix.ts src/application/primitives/internal/loose-oid-cache.ts test/unit/application/primitives/resolve-oid-prefix.test.ts test/unit/application/primitives/abbreviate-object-id.test.ts test/integration/posix-only/rev-parse-unreadable-fanout-interop.test.ts
npm run check:test-pyramid
```

### Commit

`fix(rev-parse): skip and log an unreadable fanout directory during the abbreviation scan`

## Part 9 — the fanout log counts follow git's per-process cache and miss rescan

### Context

**Edits** `src/application/primitives/resolve-oid-prefix.ts`,
`test/unit/application/primitives/resolve-oid-prefix.test.ts`,
`test/unit/application/primitives/abbreviate-object-id.test.ts`,
`test/integration/posix-only/rev-parse-unreadable-fanout-interop.test.ts`.

Mechanism (ADR-1143, DC-P2(a)):

- A module-level `const failedListings = new WeakMap<Context['session'], Set<string>>()`,
  keyed on `ctx.session`. The pattern is src/application/primitives/internal/loose-oid-cache.ts
  `fanoutCache` and `primaryPrefixMap` (read-only).
- `scanLooseIn` answers `[]` with no `readdir` and no log for a directory in the set. A
  logged fault adds the directory. `FILE_NOT_FOUND` and successful listings are never
  recorded.
- `resolveOidPrefix`: when the merged candidate list is empty, run a private
  `forgetFailed(ctx, sources, prefix): boolean`. It deletes the consulted directories (one
  per source, the same `fanoutDirIn` key) from the set and answers whether any was there. If
  so, scan every source once more (loose and packs).
- `abbreviateObjectId` never scans again; it only reads through the memoised `scanLooseIn`.
- Extract the per-source scan already duplicated in `resolveOidPrefix` (l.166–170) and
  `rivalsSharing` into one exported internal helper only if it stays under 20 lines.
  Otherwise leave both.

Per-call log counts this must give, in one session (git's `get_short_oid`):

| Call | Logs |
|---|---|
| first, miss | 2 |
| first, hit | 1 |
| later, miss | 1 |
| later, hit | 0 |

That yields 2 for one `rev-parse abcd` (ladder → `isUniqueAbbreviation` miss), 3 for
cherry-pick (Part 6's second read adds 1), and 3 for a no-ref name (the quiet reread scans
after the ladder misses; Part 2 leaves that scan ungated).

Unit fixtures:

- A counting stub: `readdir` wrapped to count the calls on `fanoutDir` and throw
  `permissionDenied(fanoutDir)`.
- One `Context` spread reused across calls, so the session is the same. `buildSeededContext()`
  gives a fresh session per row.
- A "hit" with the failed loose directory comes from a pack. Use
  `writeSyntheticPack(ctx, …)` (pack-fixture.ts) holding an object whose id starts with the
  prefix. Use a 4-hex prefix taken from the packed id.

Pinned rows this part owns (design matrix; `E` = the unable-to-open line):

- Mode-000 dir with branch abcd: `rev-parse abcd`, `abcd^{commit}`, `describe --always abcd`
  (the oid comes back structured; its prefix directory is readable, so it adds nothing),
  `merge abcd` and `blame abcd -- f` all exit 0 with E×2.
- `cherry-pick abcd` and `revert abcd`: E×3. Compare E lines only; the pick's own outcome is
  covered elsewhere. Use separate twins, because they write state.
- Regular file at the fanout path: `rev-parse abcd` gives ENOTDIR×2 and `cherry-pick abcd`
  gives ENOTDIR×3.
- No branch abcd: `rev-parse abcd` exits 128 with E×3, stdout `abcd` and `AMBIGUOUS_ARGUMENT`.
- Packed clone, absent prefix (`<HEAD 2-hex>ff`, checked absent with
  `git cat-file -e` failing): `rev-parse` exits 128 with E×3.

tsgit at this step (after Part 8): every call logs once per scan and never scans again, so these
rows show 1 or 2 where git shows 2 or 3.

### TDD steps

1. **RED** resolve-oid-prefix.test.ts:
   `Given a fanout directory that cannot be listed and no packed match` > `When resolveOidPrefix misses it twice in one session` > `Then it logs twice on the first call and once on the second`.
   Assert the per-call logs `[2, 1]` and `readdir` counts `[2, 1]`. Fails after Part 8 with
   `[1, 1]`.
2. **RED** same file:
   `Given that directory and a packed object under the prefix` > `When resolveOidPrefix resolves the prefix twice in one session` > `Then it logs once, then not at all, and reads the directory once`.
   Fails after Part 8: the second call logs.
3. **GUARD** same file:
   `Given a readable directory and no match` > `When resolveOidPrefix misses` > `Then it reads the directory once`.
   This holds after Part 8, which has no rescan. It pins DC-P2(a). Under DC-P2(b) it becomes
   a RED expecting two reads.
4. **GUARD** same file:
   `Given a readable directory` > `When resolveOidPrefix resolves it twice` > `Then it reads it twice`.
   Successful listings are never cached; that holds after Part 8. Run it before GREEN; if it
   is red, stop.
5. **RED** abbreviate-object-id.test.ts:
   `Given a resolveOidPrefix that already logged the failed directory` > `When abbreviateObjectId runs in the same session` > `Then it neither reads nor logs that directory again`.
   Fails after Part 8: it logs once.
6. **RED** posix suite: every row above, seen red on its count.
7. GREEN memo + `forgetFailed` + rescan.
8. REFACTOR: functions under 20 lines; the memo accessor mirrors `primaryPrefixMap`.

### Gate

```
npx vitest run test/unit/application/primitives/resolve-oid-prefix.test.ts test/unit/application/primitives/abbreviate-object-id.test.ts test/integration/commit-ish-corrupt-candidate-interop.test.ts test/integration/rev-parse-ambiguity-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/resolve-oid-prefix.ts test/unit/application/primitives/resolve-oid-prefix.test.ts test/unit/application/primitives/abbreviate-object-id.test.ts test/integration/posix-only/rev-parse-unreadable-fanout-interop.test.ts && npm run check:spelling
npx vitest run --project posix-integration test/integration/posix-only/rev-parse-unreadable-fanout-interop.test.ts
npx tsc --noEmit -p tsconfig.json
npx cspell --no-progress src/application/primitives/resolve-oid-prefix.ts test/unit/application/primitives/resolve-oid-prefix.test.ts test/unit/application/primitives/abbreviate-object-id.test.ts test/integration/posix-only/rev-parse-unreadable-fanout-interop.test.ts
```

### Commit

`fix(rev-parse): log an unreadable fanout directory as often as git does`
