# Plan — name-rev date cutoff

> Source: design doc `docs/design/name-rev-date-cutoff.md` · ADRs `461, 462, 463, 464`
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

## Sizing rules

- Every part costs a full agent lifecycle (spin-up, zero-context rebuild, gate) — it
  must earn it. No standalone test-only parts for FEATURE code: coverage/interop/property
  tests fold into the implementation part whose code they exercise. EXCEPTION:
  test-infra-only parts (fixtures, harness suites, benches) with no `src/` delta ARE
  standalone.
- Part 1 (pure helpers + their unit/property tests) and Part 2 (walk integration + its
  read-count tests) are a sequential feature split — pure decisions land isolated from
  walk I/O (mirrors `describe-early-termination.md`'s Part 1→Part 2 split and this
  feature's established `is-better-name` / `step` / `ref-pattern` domain/command layering,
  ADR-461). Parts 3 and 4 are the standalone test-infra exception (interop fixtures,
  bench) — they assert already-landed real behaviour and have no implementation part to
  fold into.

## Public-surface decision (whole change)

**No new public symbol.** `commitIsBeforeCutoff` and `nameRevCutoff` are exported from
the **internal** `src/domain/name-rev/index.ts` barrel only — never re-exported from
`domain/objects` / the package entry, so they do NOT enter `reports/api.json` (mirrors
the existing `isBetterName` / `step` / `ref-pattern` internal-only exports). No new
`NameRevOptions` field, no new `NameRevResult` field, no new command, no new error code.
Therefore **none** of the surface gates in `.claude/workflow/surface-gates.md` fire: no
barrel-to-`domain/objects`, no `Repository` facade, no `repository.test` snapshot, no
`check:doc-coverage` page, no `audit-browser-surface` scenario, no README count bump.
Each of Parts 1–2 asserts `reports/api.json` is byte-unchanged by the diff (`git diff
--no-ext-diff --exit-code reports/api.json` returns clean — nothing regenerated). This is
verified in the phase gate `npm run validate` and, for the push hook, `check:doc-typedoc`
sees no delta.

## Part 1 — pure cutoff helpers in `domain/name-rev/cutoff.ts`

### Context

- **New file** `src/domain/name-rev/cutoff.ts` (pure, zero I/O — the domain layer, ADR-461).
  Style precedent to copy exactly: `src/domain/name-rev/is-better-name.ts` (a single
  exported arrow, a leading `why` doc comment, `equivalent-mutant:` inline notes for any
  provably-unkillable mutant — NO provenance refs, NO phase/ADR numbers in code). Two
  exports:
  - `commitIsBeforeCutoff(commitDate: number, cutoff: number): boolean` — the strict-`<`
    predicate. Body is exactly `commitDate < cutoff`. This is git's
    `commit_is_before_cutoff` date branch (`commit->date < cutoff`); the generation-number
    branch is omitted (tsgit has no commit-graph — a design-doc note per §1.2/§5, NOT an
    ADR, and NOT a code comment referencing it).
  - `nameRevCutoff(targetDate: number): number` — the cutoff value. git's
    `adjust_cutoff_timestamp_for_slop` transcribed in full (ADR-463):
    ```
    const CUTOFF_DATE_SLOP = 86_400;             // one day in seconds
    const FLOOR = Number.MIN_SAFE_INTEGER;        // tsgit's TIME_MIN mapping
    // if (cutoff) — epoch-zero target keeps cutoff 0 (git's outer `if (cutoff)`):
    if (targetDate === 0) return 0;
    // underflow guard — subtract only above FLOOR + SLOP, else clamp to FLOOR:
    return targetDate > FLOOR + CUTOFF_DATE_SLOP ? targetDate - CUTOFF_DATE_SLOP : FLOOR;
    ```
    `CUTOFF_DATE_SLOP` and `FLOOR` are named module constants (no magic values — CLAUDE.md
    smell). Keep the function <20 lines, early returns.
- **Barrel** `src/domain/name-rev/index.ts` (18 lines, alphabetical-ish groups). Add:
  `export { commitIsBeforeCutoff, nameRevCutoff } from './cutoff.js';`. This is the
  **internal** barrel — the file header already documents "Deliberately NOT re-exported
  from `domain/objects` — these stay out of the public `api.json`". Do NOT touch
  `domain/objects` or any public entry. `reports/api.json` stays byte-identical.
- **New test file** `test/unit/domain/name-rev/cutoff.test.ts` (example tests). Conventions:
  GWT describe/it split (`describe('Given …')` > `describe('When …')` > `it('Then …')`),
  AAA bodies with `// Arrange` / `// Act` / `// Assert` section comments, the system under
  test named `sut`, 100% line/branch/function/statement, 0 surviving mutants. Import shape
  mirrors `test/unit/domain/name-rev/is-better-name.test.ts`:
  `import { commitIsBeforeCutoff, nameRevCutoff } from '../../../../src/domain/name-rev/cutoff.js';`.
  Assert the **numeric result** (not just a boolean/truthiness) so magic-value and
  off-by-one mutants die.
- **New property file** `test/unit/domain/name-rev/cutoff.properties.test.ts` (CLAUDE.md
  lens 3 — total function over a grammar; design §7). Layout precedent:
  `test/unit/domain/name-rev/is-better-name.properties.test.ts` (`fast-check`, `fc.assert`
  / `fc.property`, GWT describe/it, `sut` names the SUT). Shared generators live in
  `test/unit/domain/name-rev/arbitraries.ts` — extend it ONLY if a new arbitrary is reused
  (a plain `fc.integer(...)` inline is fine here; do not over-share). numRuns: 200 for the
  cheap `commitIsBeforeCutoff` round-trip/threshold property, 100 for `nameRevCutoff`.

### TDD steps

1. RED (`cutoff.test.ts`) — `commitIsBeforeCutoff` strict-`<` boundary, three isolated
   tests so the `<`→`<=` mutant dies on its own case:
   - Given a commit dated below the cutoff, When testing, Then `sut === true`.
   - Given a commit dated **exactly at** the cutoff (`date === cutoff`), When testing,
     Then `sut === false` (kills `<`→`<=`).
   - Given a commit dated above the cutoff, When testing, Then `sut === false`.
   Fails: `../cutoff.js` does not exist.
2. RED (`cutoff.test.ts`) — `nameRevCutoff`, each guard branch its own test asserting the
   exact number:
   - Given a normal target date `t` (e.g. `1_000_200_000`), When computing, Then
     `sut === t - 86_400` (`1_000_113_600`) — kills the `86_400` magic-value and the
     `-`→`+` operator mutants.
   - Given a target dated exactly `0` (epoch), When computing, Then `sut === 0` (the
     `if (targetDate === 0)` skip — isolated; kills dropping the epoch guard).
   - Given a target dated at/near `Number.MIN_SAFE_INTEGER` (crafted floor value, e.g.
     `Number.MIN_SAFE_INTEGER`), When computing, Then `sut === Number.MIN_SAFE_INTEGER`
     (the underflow `else` clamp — isolated; kills dropping the guard, which would
     underflow to a wrong value).
   - Given a target dated one second above the floor+slop boundary
     (`Number.MIN_SAFE_INTEGER + 86_400 + 1`), When computing, Then `sut ===
     Number.MIN_SAFE_INTEGER + 1` (proves the boundary takes the subtract branch — kills
     `>`→`>=` on the guard).
   Fails: symbol undefined.
3. GREEN — create `cutoff.ts` with both exports and the two named constants; add the
   barrel line. Minimal, transcribed exactly as in Context.
4. RED (`cutoff.properties.test.ts`) — frame the properties as INVARIANTS, not a verbatim
   restatement of the body (`=== (date < cutoff)` would be a tautology — CLAUDE.md's "oracle
   is a copy of the SUT" trap). Genuine invariants:
   - `commitIsBeforeCutoff` monotone threshold — Given an arbitrary safe-integer `cutoff`:
     (a) totality — for any safe-integer `date`, `sut(date, cutoff)` returns a boolean and
     never throws; (b) monotone in `date` — for arbitrary `d1 < d2`, `sut(d2, cutoff)`
     implies `sut(d1, cutoff)` (once pruned, all older dates prune); (c) the value AT
     `cutoff` is `false` and the value at `cutoff - 1` is `true` (the threshold sits between
     them — this is the invariant the `<`→`<=` mutant breaks, expressed structurally rather
     than as `date < cutoff`). numRuns 200.
   - `nameRevCutoff` — Given an arbitrary safe-integer `t` with `t > 86_400` and `t !== 0`:
     the result is strictly less than `t`, and their difference is exactly the one-day slop
     (`t - sut === 86_400`, using a local test constant — `cutoff.ts` exports only the two
     functions, so do NOT import an unexported `CUTOFF_DATE_SLOP`) — an invariant over the
     arithmetic, not a copy of the branch. (Boundary/epoch/floor cases stay as the isolated
     example tests above — they
     document literal git control flow; keep them, do NOT delete an example test to add a
     property.) numRuns 100.
   Expected GREEN once step 3 lands; a deliberately-broken predicate must make it fail
   before trusting it.
5. REFACTOR — confirm functions <20 lines, named constants, no nesting >2; run the touched
   sweep.

### Gate

npx vitest run test/unit/domain/name-rev/cutoff.test.ts test/unit/domain/name-rev/cutoff.properties.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/name-rev/cutoff.ts src/domain/name-rev/index.ts test/unit/domain/name-rev/cutoff.test.ts test/unit/domain/name-rev/cutoff.properties.test.ts

### Commit

feat: pure name-rev date-cutoff predicate and slop arithmetic

## Part 2 — thread the cutoff through the name-rev walk

### Context

- **File** `src/application/commands/name-rev.ts` (139 lines — read it in full first). The
  walk shape: `nameRev` resolves `target: ObjectId` via `resolveCommit`, builds the ref
  filter, sorts refs, then `for (const ref of refs) await walkRef(ctx, ref, revNames)`;
  `walkRef` → `seedRef` (peels the ref, `accept`s the seed) then a LIFO stack popping into
  `expandParents` (loops `commit.data.parents`, reads each via `readObject`, `accept`s the
  candidate). `accept` is the improvement-gated map write.
- **Imports already present**: `readObject` from `../primitives/read-object.js`; the
  `../../domain/name-rev/index.js` barrel (add `commitIsBeforeCutoff`, `nameRevCutoff` to
  that existing import group). `Commit`, `ObjectId`, `RefName` from
  `../../domain/objects/index.js`.
- **The three edits** (git's cutoff, transcribed at its two guard sites + the up-front
  computation — design §1.1, §2, ADR-462):
  1. **`nameRev` — compute the cutoff up front, before the ref loop.** After
     `const target = await resolveCommit(ctx, rev ?? DEFAULT_REV);` add:
     `const targetCommit = (await readObject(ctx, target)) as Commit;` then
     `const cutoff = nameRevCutoff(targetCommit.data.committer.timestamp);`. `resolveCommit`
     peels to `'commit'` and refuses otherwise (`resolve-rev.ts` → `peel(ctx, …, 'commit')`),
     so the read is GUARANTEED a commit object (ADR-462) — narrow with `as Commit` (NOT
     `readCommit`, whose `Commit | undefined` return would introduce an untestable dead
     `undefined` branch; NOT a `type === 'commit'` runtime guard, which CLAUDE.md forbids as
     an unreachable branch). The `as Commit` narrowing assertion is the SAME idiom this file
     already uses for guaranteed-shape values (`stack.pop() as Commit`, `revNames.get(...) as
     RevName`); it is a discriminated-union narrowing, not an `any` escape. Then read
     `data.committer.timestamp` directly. `Commit.data`
     is `CommitData` with `committer: AuthorIdentity`, `timestamp: number` (epoch seconds).
     Thread `cutoff` into `walkRef(ctx, ref, revNames, cutoff)`.
  2. **`seedRef` — seed-tip guard** (git's `commit_is_before_cutoff(start_commit) →
     return`). `seedRef` peels to `tip.commit`; before `accept`-ing the seed, if
     `commitIsBeforeCutoff(tip.commit.data.committer.timestamp, cutoff)` return `undefined`
     (the ref seeds nothing). Signature becomes `seedRef(ctx, ref, revNames, cutoff)`;
     `walkRef` passes `cutoff` through.
  3. **`expandParents` — parent guard** (git's `commit_is_before_cutoff(parent) →
     continue`). In the parent loop, after reading `parent` via `readObject` and confirming
     `parent.type === 'commit'`, if `commitIsBeforeCutoff(parent.data.committer.timestamp,
     cutoff)` do NOT push it (`continue`). Signature becomes
     `expandParents(ctx, commit, name, revNames, cutoff)`; `walkRef` passes `cutoff`.
  Keep every function <20 lines (the cutoff check is one early-return / one `continue` per
  site). No provenance refs in the code.
- **The target is never pruned** — `cutoff = targetDate − 86400 < targetDate`, so
  `commitIsBeforeCutoff(target, cutoff) === false` always; the target's name is always
  recorded. This is the correctness invariant (design §1.3); the read-count tests below
  exercise it via the "query the oldest commit" case.
- **Tests** — extend `test/unit/application/commands/name-rev.test.ts` (499 lines — read
  the top helper block). Reuse the EXISTING helpers verbatim: `seed()` (init a memory ctx),
  `commitFile(ctx, name)` (bumps the module `clock` by 60 each call and returns the oid),
  `annotatedTag(ctx, name, target, taggerTime)`, `lightweightTag`, `writeCommit`,
  `treeOf`, `pointBranch`. The module-level `clock` starts at `1_700_000_000` and each
  `commitFile` adds 60s, so a chain of N commits spans `60·N` seconds — well inside one day
  (86_400s), so a naive cutoff would prune the whole chain; that is what makes the O(distance)
  claim observable. To place a commit strictly MORE than one day older than the target, use
  `writeCommit` with a hand-set identity, OR bump `clock` by `> 86_400` between commits.
- **Counting-spy precedent** — copy `withCountedObjectReads` from
  `test/unit/application/commands/describe.test.ts` (lines 1137–1150): it wraps
  `ctx.fs.read`, increments a counter when `path.includes('objects/')`, and returns
  `{ counted, reads: () => number }`. Add an identical local helper to `name-rev.test.ts`
  (the two test files do not share a helper module; a local copy is the established
  pattern — do NOT extract a cross-file helper). Pin EXACT read totals (mutation-resistant —
  a range assertion lets the dropped-guard mutant survive).
- Read-count cases to add (design §7 walk-integration bullets), each in its own
  `describe('Given …')` > `describe('When …')` > `it('Then …')`:
  - **O(distance), not O(N)** — Given a deep linear chain (e.g. 30 commits) with an
    annotated tag near the tip and a much-older commit near the root separated by
    `> 86_400`s from the target, When name-rev runs on a commit near the tip, Then the
    result is byte-stable AND the object-read count is far below the whole chain (assert the
    exact count — kills a dropped parent-guard mutant).
  - **Target-derived cutoff (oldest query walks all)** — Given the same chain, When
    name-rev runs on the OLDEST commit, Then nothing is pruned (its own cutoff is
    `date(oldest) − 1 day`) and the read count covers the full ancestry — proves the cutoff
    is target-derived (ADR-462).
  - **Seed-tip prune** — Given two refs, one whose tip commit is `> 86_400`s older than the
    target, When name-rev runs on the newer target, Then the old ref is NEVER seeded (its
    tip's name is absent from the result / it contributes no name), matching git's
    `commit_is_before_cutoff(start_commit) → return` (kills a dropped seed-guard mutant).
  - **Strict-`<` boundary at the walk** — Given a commit dated EXACTLY one day older than
    the target (`date === cutoff`), When name-rev runs, Then that commit is STILL walked and
    named (strict `<`, survives at the boundary — kills `<`→`<=` at the walk level).
  - All EXISTING `name-rev.test.ts` assertions stay green and UNCHANGED (the small-chain
    fixtures span < 1 day, so nothing they assert is pruned — the cutoff is inert on them).
- **`reports/api.json` unchanged** — this part touches only the command internals and tests;
  assert `git diff --no-ext-diff --exit-code reports/api.json` is clean (no regeneration).

### TDD steps

1. RED — the O(distance) read-count test (build the deep chain + near tag via the existing
   helpers, wrap with the counting spy, assert the exact low count). Fails: without the
   cutoff the walk reads the whole chain, so the count is the full-ancestry number.
2. GREEN — the three edits: up-front `readObject(ctx, target)` + `nameRevCutoff`; the
   seed-tip guard in `seedRef`; the parent guard in `expandParents`; thread `cutoff` through
   `walkRef` → `seedRef` / `expandParents`.
3. RED→GREEN — the oldest-query (full-walk) test, the seed-tip-prune test, and the
   `date === cutoff` boundary test. Each isolates one guard/condition so its mutant dies on
   its own case (mutation-resistant).
4. Confirm the ENTIRE existing `name-rev.test.ts` suite still passes unchanged.
5. REFACTOR — keep each touched function <20 lines and early-return-shaped; verify
   `reports/api.json` is byte-unchanged; run the touched sweep.

### Gate

npx vitest run test/unit/application/commands/name-rev.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/name-rev.ts test/unit/application/commands/name-rev.test.ts

### Commit

perf: prune name-rev walk at the target date cutoff

## Part 3 — interop fixtures pinning the cutoff against real git

### Context

- **Test-infra-only part** (no `src/` delta) — standalone per the sizing exception. It adds
  fixtures that assert already-landed real behaviour against canonical `git name-rev`.
- **File** `test/integration/name-rev-interop.test.ts` (223 lines — read it in full). It is
  guarded `describe.skipIf(!GIT_AVAILABLE)('name-rev interop', …)` and reconstructs
  `git name-rev --name-only` from tsgit's `NameRevResult` via the local `renderNameRev(r)`
  helper (strips `refs/heads/`, else `refs/`, appends `^0` / the `~n`/`^m` suffix). Existing
  expectations MUST stay byte-identical and UNCHANGED (design §5 — the sole faithfulness pin).
- **Isolation is already handled by the helpers** (`test/integration/interop-helpers.ts`) —
  reuse them, do NOT re-implement env scrubbing:
  - `git(dir, ...args)` / `runGit(args, { env })` spawn git with ALL `GIT_*` stripped from
    `process.env`, `HOME` pointed at a non-existent tmp path, `GIT_CONFIG_NOSYSTEM=1`,
    `XDG_CONFIG_HOME` under that HOME — so global/system/XDG config never leaks (signing is
    off because no `commit.gpgsign` is ever set and the isolated HOME has no config).
  - Local file-level helpers to reuse: `makeRepo(slug)` (init `-b main`, set user.name /
    user.email), `commitFile(dir, name)` (bumps the module `clock` by 60, writes+commits with
    `datedEnv(clock)` — deterministic `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE`),
    `annotate(dir, name, epoch)` (`git tag -a` with `datedEnv(epoch)`),
    `gitNameRev(dir, sha, ...args)` (`git name-rev --name-only … sha`), `renderNameRev(r)`.
    `SETUP_TIMEOUT = 60_000` per `beforeAll` (heavy git-spawning suites time out hook
    concurrency — keep the 60s timeout on new `beforeAll`s).
  - The module `clock` starts at `1_700_000_000` and advances 60s per `commitFile`. To place
    a commit MORE than one day older than the target so the cutoff actually FIRES, advance
    `clock` by `> 86_400` between the old commit and the rest (the existing suite never does
    this — its fixtures span < 1 day and the cutoff is inert on them; the new fixtures are
    the ones where pruning is active, and they still assert the SAME output git prints).
- **Two new `describe('Given …')` blocks** (design §3 rows 3 & 5, §7 interop bullet), each a
  self-contained `beforeAll`/`afterAll(rm dir)` fixture mirroring the existing blocks:
  - **Row 3 — named ancestor with a far-older pruned parent.** Build a linear history where
    `c0` is dated `> 1 day` before `c1`…`c3`, annotate a tag `rel` on the tip, then query a
    middle commit `c1`. `date(c0) < cutoff` so git prunes `c0` from the walk, yet the queried
    `c1` still resolves (`tags/rel~2`). Assert `renderNameRev(await nameRevCmd(ctx, c1)) ===
    gitNameRev(dir, c1)` — same output, pruning active. `ctx = createNodeContext({ workDir:
    dir })` (as the existing blocks do).
  - **Row 5 — older-tipped ref skipped at seed.** Build two tags: `oldtag` on a commit dated
    `> 1 day` before `newtag`'s commit. Query the newer commit. git prunes `oldtag`'s seed
    tip (`commit_is_before_cutoff(start_commit) → return`), and `newtag^0` is unchanged.
    Assert `renderNameRev(await nameRevCmd(ctx, newCommit)) === gitNameRev(dir, newCommit)`
    (and, per row 6, optionally the `--tags` variant via `gitNameRev(dir, newCommit,
    '--tags')`). Same output, seed-tip prune active.
  - Test bodies: GWT describe/it split, AAA with section comments, `sut` for the tsgit call
    result where an intermediate is named. No new expectations beyond "equals what real git
    prints" — the additions PROVE pruning does not alter output on histories where it fires.
- **No `src/` change, no `reports/api.json` change** — interop-only.

### TDD steps

1. Write the row-3 fixture block (far-older ancestor, tag on tip, query a middle commit),
   asserting the reconstruction equals `gitNameRev`. Benches/interop have no RED-against-
   missing-code phase — the code already prunes (Part 2); this fixture confirms the prune is
   byte-inert against real git. Run it to confirm GREEN; temporarily reverting Part 2's
   parent guard locally must NOT change the asserted output (proving inertness) while the
   read-count test in Part 2 is what actually detects the prune.
2. Write the row-5 fixture block (older-tipped ref, query the newer commit; optional
   `--tags` variant), asserting equality with `gitNameRev`.
3. Confirm the ENTIRE existing interop suite still passes unchanged.

### Gate

npx vitest run test/integration/name-rev-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check test/integration/name-rev-interop.test.ts

### Commit

test: pin name-rev cutoff pruning against real git

## Part 4 — scaled bench for the name-rev cutoff win

### Context

- **Test-infra-only part** (no `src/` delta) — standalone per the sizing exception. Its
  correctness is pinned by Parts 1–3; the bench records the `bench:summary` delta (ADR-464).
- **Structural model to mirror** `test/bench/describe.bench.ts` (56 lines — read it in full).
  Copy its shape exactly:
  - `import { resolveScaledContext, scaledScenario } from './support/scaled-bench.js';`
    (`resolveScaledContext` resolves the medium/large fixture once and returns `{ given }`
    only under Stryker or when no `git` CLI is available; `scaledScenario` registers a
    `benchScenario` that SKIPS cleanly — `describe.skipIf` — when the fixture is absent, so
    the bench is a clean no-op in the Stryker sandbox / without `git`). Do NOT re-implement
    skipping.
  - `import { openRepository } from '../../src/index.node.js';` and `afterAll` from
    `vitest`.
  - The `ensureNearTag`-style helper: scrub `GIT_*` from `process.env`, set deterministic
    `GIT_AUTHOR_*`/`GIT_COMMITTER_*` + `GIT_CONFIG_NOSYSTEM=1`, run `git -C cwd tag -f -a
    <name> -m <name> HEAD~<distance>` via `promisify(execFile)` — copy `describe.bench.ts`'s
    `ensureNearTag` verbatim (rename the tag constant).
- **New file** `test/bench/name-rev.bench.ts` (ADR-464, design §5A):
  - `const ctx = await resolveScaledContext();` at module top level.
  - Place an annotated tag `TAG_DISTANCE` (e.g. 10) commits below the deep-fixture tip
    (same `HEAD~<distance>` annotated-tag placement as `describe.bench.ts`).
  - `scaledScenario(ctx, 'When name-rev() names a near-tip commit, Then the walk stops at
    the date cutoff', async (fixture) => { await ensureNearTag(fixture.cwd); const repo =
    await openRepository({ cwd: fixture.cwd }); afterAll(async () => { await repo.dispose();
    }); return { sut: async () => { await repo.nameRev(<a rev near the tip>); } }; });`.
    Query a commit near the tip (e.g. `'HEAD~2'` or a rev the fixture exposes) so the cutoff
    prunes each ref's deep ancestry — O(distance) reads instead of O(N). `sut` is the
    async function under measurement (bench-dsl requires the returned `{ sut }`).
  - Leading file doc comment in the `describe.bench.ts` style (why: pins the O(distance)
    cutoff win; tsgit-only — isomorphic-git has no `name-rev`). NO provenance refs.
- Runner: `npm run test:bench` (wireit → `vitest bench --run --config
  vitest.bench.config.ts`), summarised by `npm run bench:summary` (→
  `reports/benchmarks/summary.md`). The bench file-filter form is
  `vitest bench --run --config vitest.bench.config.ts test/bench/name-rev.bench.ts`.
- **No `src/` change, no `reports/api.json` change** — bench-only.

### TDD steps

1. Write the bench (benches have no RED phase — correctness is pinned by Parts 1–3). Mirror
   `describe.bench.ts` exactly, swapping `describe()` for `nameRev(<near-tip rev>)` and the
   tag constant name.
2. Run the bench once locally to confirm it executes and records (and that it SKIPS cleanly
   when `git` is unavailable — the `scaledScenario` guard). It must not error.

### Gate

npx vitest bench --run --config vitest.bench.config.ts test/bench/name-rev.bench.ts && npm run check:types && ./node_modules/.bin/biome check test/bench/name-rev.bench.ts

### Commit

test: bench name-rev cutoff on deep history with near tag

## Phase gate (all parts landed)

npm run validate

- Confirms full unit + property + integration + bench type-check, 100% coverage
  (domain/adapters scope) over the new `cutoff.ts`, biome/format, cspell, and — critically
  for this perf-only change — that `reports/api.json` is byte-unchanged (no public surface
  added; `check:doc-typedoc` at prepush sees no delta).
- Separately (docs phase, not a code part): flip `docs/BACKLOG.md` **26.4b** to `[x]` under
  guard, referencing this design doc and ADRs 461–464.
