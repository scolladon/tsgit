# Plan — `commonDir` on `OpenRepositoryOptions`

> Source: design doc `docs/design/common-dir-open-option.md` · ADRs 709–717
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

### Partition rationale — read this before starting any part

Four parts, strictly ordered, one shared worktree.

- **Part 1** lands the whole behaviour at the *internal* tier
  (`ExplicitLayoutOptions.commonDir` → the two route functions → the funnel). Every
  ADR-709…716 decision is directly unit-testable through `resolveLayout` /
  `findLayout`, so the part is fully proven without a public field existing yet.
  Nothing dead ships: the new internal field is consumed by both routes and exercised
  by the tests in the same commit.
- **Part 2** makes it public (`OpenRepositoryOptions.commonDir`), validates it, and
  threads it through all three runtime shims (including the ADR-717 signature
  migration). A public option that resolves nothing would be a knowingly-broken
  intermediate, which is exactly why the public field is NOT in Part 1 and the route
  plumbing is NOT in Part 2.
- **Part 3** is test-infra-only (no `src/` delta): the cross-tool interop file and the
  cross-adapter parity file. Both exercise code fully landed by Parts 1–2 and both
  need the *public* option, so neither can fold backwards into Part 1; folding them
  into Part 2 would double that part's size.
- **Part 4** is docs-only (no `src/` delta).

#### Facts measured during planning — do not re-derive

- **`src/repository/**` and `src/repository.ts` are OUTSIDE the coverage include list.**
  `vitest.config.ts` coverage `include` is `src/domain/**`, `src/ports/**`,
  `src/adapters/node/**`, `src/adapters/memory/**`, `src/operators/**`. The only
  in-scope file this feature touches is `src/ports/context.ts`, and its change is a
  JSDoc comment. **No coverage-threshold pressure exists on this feature.**
- **Mutation bucket:** `mutation-budgets.json` puts `src/repository/**` and
  `src/repository.ts` in the `application` bucket (high 100 / low 98 / **break 95**).
  `src/index.node.ts`, `src/index.default.ts`, `src/index.browser.ts` match **no**
  bucket glob and are ungated.
- **`test-pyramid-budgets.json` has NO per-file registry** — keys are `$schema`,
  `tiers`, `heuristics`, `gating`, `excludePaths`. Tiers are ratio bands; the parity
  tier's `target`/`warnBelow` are both `0` with `warnAbove: null`, so adding
  `test/parity/common-dir-open-option.test.ts` cannot trip it. Gated heuristics are
  style-only: `underAssertedUnit`, `gwtTitle`, `aaaBody`, `sutNaming`,
  `bareClassToThrow`, `emptyAaaSection`, `sutBindsResult`. `integrationProof` and
  `overMockedIntegration` are **report-only**.
- **`test/parity/**/*.test.ts` is its own vitest project** (`vitest.config.ts`, project
  `parity`), so a new `test/parity/*.test.ts` file runs without touching the
  `SCENARIOS` registry. **Do not add a `Scenario` to `test/parity/scenarios/index.ts`**:
  `Scenario.openOptions` is typed `{ readonly algorithm?: 'sha1' | 'sha256' }` and the
  Playwright browser driver (`test/browser/parity.spec.ts`) declares its own
  `openRepository` wrapper that forwards only `rootHandle` + `algorithm` — a
  `commonDir` scenario would have to widen both, and the browser driver has no way to
  pre-seed a split layout in OPFS.
- **`reports/api.json` staleness is a PREPUSH gate**, not a validate gate
  (`check:doc-typedoc` = `git diff --exit-code -- reports/api.json`, depending on
  `docs:json` = `typedoc --json reports/api.json …`). `docs:json`'s wireit `files`
  include `src/**/*.ts`, so the new public field makes it stale. Regenerate and commit
  it **in Part 2**.
- **`check:doc-coverage` / `audit-browser-surface` extract facade members by regex over
  `readonly (\w+): BindCtx<` and `readonly (\w+): commands.\w+Namespace`.** A new field
  on `OpenRepositoryOptions` matches neither, so this feature adds **no** required docs
  page and **no** browser-surface parity entry.
- **There is no exhaustive `OpenRepositoryOptions` key snapshot test.**
  `test/unit/public-types.test.ts:176` only asserts `toHaveProperty('fs')`.
  `test/unit/api-surface/snapshot-exports.test.ts` and
  `snapshot-barrel-surface.test.ts` list *exports*, not option keys. No new error code,
  no barrel change, no exhaustiveness switch.
- **`MemoryFileSystem`'s constructor seeds implicit parent directories**
  (`ensureParentDirs` per seeded file), so `files: { '/repo/shared/objects/.keep': … }`
  makes `/repo/shared/objects` `stat` as a directory. That is how a split layout is
  pre-seeded on the memory adapter.
- **`layoutFromGitfile` gains an optional trailing parameter, so `fixed-entry-layout.ts`
  keeps compiling unchanged after Part 1.** Part 1 therefore does not touch it.

#### Two conventions binding every part

- **No provenance refs in code.** No `§`, `Phase`, `ADR-…`, `D4`, backlog ids inside
  `src/` or `test/`. Explain *what git does* and *why*, never *which document said so*.
- **No suppression directives.** No `@ts-ignore`, `biome-ignore`, `v8 ignore`,
  `stryker-disable` (the pre-existing `Stryker disable next-line` comments in touched
  files stay as they are — do not add new ones).

---

## Part 1 — Substitute a caller-supplied common dir in both layout routes

### Context

**Goal.** `resolveLayout(probe, cwd, pathPolicy, { commonDir })` resolves a layout whose
common-dir coordinate is the caller's value, on the discovery walk, the cwd-is-gitdir
walk and the explicit-`gitDir` route — substituted *before* candidate validation, with
the degenerate (`=== gitDir`) value normalised off the layout but remembered, and the
bareness bypass extended to the routes git extends it to.

**Files to change (2):**

- `src/repository/find-layout.ts` (330 lines)
- `src/repository/resolve-layout.ts` (386 lines)

**Test files to change (6):**

- `test/unit/repository/find-layout.test.ts` (45 K)
- `test/unit/repository/resolve-layout.test.ts` (38.7 K)
- `test/unit/repository/resolve-layout-trust.test.ts` (29.5 K)
- `test/unit/repository/layout-roots.test.ts` (4.7 K)
- `test/unit/application/primitives/commondir-per-worktree-refs.test.ts` (365 lines)
- `test/unit/application/primitives/list-worktrees.test.ts`

#### `src/repository/find-layout.ts` — current shapes and exact edits

Current `WalkOutcome` (lines 21–37) is a three-arm discriminated union
(`'DISCOVERED'` with `origin`, `'BARE_DIR'`, `'EXPLICIT'`), each arm carrying
`readonly gitDir: string; readonly commonDir?: string;`.

1. **Add `readonly commonDirSupplied?: true;` to all three arms.** This is the
   ADR-713 marker: the *fact* that a caller named a common dir, carried beside the
   value because ADR-713 normalises the degenerate value off the outcome so
   `commonDir !== undefined` can no longer answer the question. It is read by
   `resolveWorkTree` only and is **never** emitted onto `RepositoryLayoutInput`
   (`finishLayout` line 284 emits `outcome.commonDir` alone — do not touch that line).
   Document it on the union with a comment saying exactly that.

   **Every `WalkOutcome` consumer, already checked:** `src/repository/resolve-layout.ts`
   (`isLinkedWorktreeAdmin`, `resolveWorkTree`, `resolveTrustGate`, `finishLayout`,
   `resolveExplicitOutcome`), `src/repository/trust-verdict.ts` (`repositoryPathOf`,
   `evaluateTrust`, `isImplicitBare`) and `src/repository/fixed-entry-layout.ts` (which
   builds its own outcome literal at line 38). The new member is **optional**, so none of
   them breaks; only `isLinkedWorktreeAdmin` reads it, and `fixed-entry-layout.ts` is
   Part 2's business, not this part's.

2. **`layoutFor`** (module-private, lines 199–223; current signature
   `(probe: LayoutProbe, gitDir: string, pathPolicy: PathPolicy) => Promise<GitDirLocation | undefined>`)
   gains a 4th optional parameter `commonDirOverride?: string`. Replace line 214
   (`const commonDir = await resolveCommonDir(probe, gitDir, pathPolicy);`) with the
   **explicit-undefined test**, not `??`:

   ```ts
   const commonDir =
     commonDirOverride === undefined
       ? await resolveCommonDir(probe, gitDir, pathPolicy)
       : commonDirOverride;
   ```

   Written this way for the same reason `commonDirOf`
   (`src/application/primitives/path-layout.ts:29`) is — a `??` here is
   `||`-mutant-equivalent because the value is never the empty string
   (`validateOptions` refuses it in Part 2). Everything below is unchanged:
   `sharedDirsValid(probe, commonDir, pathPolicy)` at line 215 now validates the
   **override**, which is the entire point of ADR-715 (an override lacking `objects/`
   or `refs/` invalidates the candidate and the walk climbs), and line 221's
   `...(commonDir !== gitDir ? { commonDir } : {})` already performs ADR-713's
   normalisation for the override for free.

   **Load-bearing consequence to state in the doc comment:** when an override is
   supplied the `<gitDir>/commondir` **file is never read at all** — not parsed, not
   size-checked, not refused. The argument replaces the file rather than out-ranking a
   parsed value, which is the only self-consistent reading of "the argument wins
   outright" and means a malformed `commondir` file cannot refuse an open the caller
   has already re-pointed. Pin it with the dedicated RED test below.

   `hasValidHead` at line 209 stays **before** the common-dir resolution: `HEAD` is a
   gitDir concern, `objects/` + `refs/` are a common-dir concern.

3. **`layoutFromGitfile`** (exported, lines 138–149; current signature
   `(probe, workDir, gitfilePath, pathPolicy, gitfileSize)`) gains a 6th optional
   parameter `commonDirOverride?: string`, forwarded to its `layoutFor` call at line
   146. Appending it optionally is what keeps `src/repository/fixed-entry-layout.ts:36`
   compiling untouched in this part.

4. **`findLayout`** (exported, lines 78–108; current signature
   `(probe, cwd, pathPolicy, ceilingDirs?)`) gains a 5th optional parameter
   `commonDirOverride?: string`, threaded into **all three** locator calls:
   - line 92 `layoutFor(probe, candidate, pathPolicy)` — the `.git`-directory branch
   - line 95 `layoutFromGitfile(probe, current, candidate, pathPolicy, stat.size)` — the
     `.git`-file branch
   - line 102 `layoutFor(probe, current, pathPolicy)` — the cwd-is-gitdir branch

   The override applies on the cwd-is-gitdir branch too: git honours the value there
   (it is reported by `rev-parse --git-common-dir`) and only the *bareness* rule is
   inert on that route, which `isLinkedWorktreeAdmin` handles below — not the walk.

   All three returns (lines 93, 96, 103) must also carry the marker. Keep `findLayout`
   short by adding a module-private helper next to `ceilingTest`:

   ```ts
   /** ADR-713's "the caller named one" marker, spread onto whichever outcome the walk returns. */
   const suppliedMarker = (commonDirOverride: string | undefined): { commonDirSupplied?: true } =>
     commonDirOverride === undefined ? {} : { commonDirSupplied: true };
   ```

   compute it once before the loop and spread it into each of the three return
   literals. `exactOptionalPropertyTypes` is on — **never** write
   `commonDirSupplied: undefined`.

5. **Doc comments.** `findLayout`'s JSDoc gains one paragraph: a caller-supplied common
   dir replaces the file-derived one before validation, so an unusable value
   invalidates candidates and the walk climbs past them, exactly as git's own
   structural check does; the value arrives already resolved against `cwd`.

#### `src/repository/resolve-layout.ts` — current shapes and exact edits

1. **`ExplicitLayoutOptions`** (lines 21–29) gains, immediately after `workDir`:

   ```ts
   readonly commonDir?: string;
   ```

   with a one-line comment: the argument-tier equivalent of git's `GIT_COMMON_DIR`,
   resolved against `cwd` by `resolveLayout` before either route sees it.

2. **`isLinkedWorktreeAdmin`** (lines 56–73, currently
   `outcome.route === 'DISCOVERED' && outcome.commonDir !== undefined`) becomes:

   ```ts
   const isLinkedWorktreeAdmin = (outcome: WalkOutcome): boolean => {
     if (outcome.route === 'BARE_DIR') return false;
     if (outcome.commonDirSupplied === true) return true;
     return outcome.route === 'DISCOVERED' && outcome.commonDir !== undefined;
   };
   ```

   Verify the three branches against the pinned matrix before writing the tests:
   - no marker → the existing rule survives byte-for-byte (an EXPLICIT route whose
     `commonDir` came from a `commondir` **file** still returns `false`) — this is what
     makes R9 provable.
   - marker + `DISCOVERED` or `EXPLICIT` → `true`. Measured: setting the value **at
     all**, even to a value identical to the gitDir, makes git ignore `core.bare` and
     keep a work tree on both routes.
   - marker + `BARE_DIR` → `false`. Measured: on the cwd-is-gitdir route the override
     changes nothing — bareness follows `core.bare` alone. Guarding it explicitly (not
     relying on `resolveWorkTree`'s `BARE_DIR` fall-through to `{}`) matters for the
     `core.bare = true` **and** `core.worktree` set combination, where bypassing would
     resolve a work tree instead of reporting `workTreeConfigBogus`.

   **Rewrite the doc comment.** Its current last paragraph asserts "no measured row
   extends this bypass to an explicit gitDir" — that row now exists and the comment is
   wrong as written. Replace it with the measured rule (supplying the value suppresses
   `core.bare` on the discovery and explicit routes, keeps the route's own work-tree
   fall-through, and is inert on cwd-is-gitdir), and explain why the marker rather than
   the field drives it (a value equal to the gitDir is normalised off the outcome yet
   still carries the semantics).

   Nothing else in `resolveWorkTree` (lines 107–128) changes: once the `bareCfg === true`
   branch at line 119 is bypassed, its existing `DISCOVERED → outcome.origin` (line 125)
   and `EXPLICIT → cwd` (line 126) rows already return exactly the work tree git's
   `--show-toplevel` reports under the override.

3. **`resolveExplicitOutcome`** (lines 325–343) gains a 5th optional parameter
   `commonDirOverride?: string`. Replace line 337 with the same explicit-undefined test
   used in `layoutFor`, and add the marker to the returned literal:

   ```ts
   const commonDir =
     commonDirOverride === undefined
       ? await resolveCommonDir(probe, gitDir, pathPolicy)
       : commonDirOverride;
   return {
     route: 'EXPLICIT',
     gitDir,
     ...(commonDir !== gitDir ? { commonDir } : {}),
     ...(commonDirOverride !== undefined ? { commonDirSupplied: true as const } : {}),
   };
   ```

   The route's documented leniency is unchanged — still no candidate validation here,
   so an override naming a nonexistent directory still produces a layout and refuses at
   first command.

4. **`resolveLayout`** (lines 356–386) resolves the caller's value **once**, against
   `cwd`, before dispatching:

   ```ts
   const commonDirOverride =
     opts.commonDir === undefined ? undefined : resolveAgainst(cwd, opts.commonDir, pathPolicy);
   const outcome =
     opts.gitDir !== undefined
       ? await resolveExplicitOutcome(probe, opts.gitDir, cwd, pathPolicy, commonDirOverride)
       : await findLayout(probe, cwd, pathPolicy, opts.ceilingDirs, commonDirOverride);
   ```

   `resolveAgainst` (line 85, already in this module) is the required helper —
   `portablePosixPolicy.resolve` has no multi-arg "later absolute wins" semantics, so a
   two-arg `pathPolicy.resolve(cwd, value)` would silently nest an absolute value under
   `cwd` on the sandboxed adapters. Same call `gitDir` and `workDir` use. git's
   discovery-route `chdir` artefact (validation base ≠ resolution base) is deliberately
   **not** reproduced.

5. **`finishLayout` (lines 250–308) and `syntheticFallbackLayout` (lines 215–238) do
   NOT change.** This is the whole payoff of substituting in the routes: line 258's
   `outcome.commonDir ?? outcome.gitDir` already feeds the ownership gate
   (`resolveTrustGate` → `evaluateTrust`, whose `checkedPathsOf` at
   `src/repository/trust-verdict.ts:63` makes it the third checked path) and the
   repository-format read (`readRepositoryFormat(probe, outcome.gitDir, commonDir, …)`,
   which reads `<commonDir>/config`), and line 284 emits the field onto the layout,
   from which `layoutRootsOf` (`src/repository/layout-roots.ts:19`) derives the FS
   containment root set. The found-nothing bootstrap keeps ignoring the option — it
   already ignores everything outside `{ workDir, bare }`, and git's own `init` under
   the variable produces a repository neither tool can reopen.

#### Downstream consumers reached for free (do not special-case any of them)

`commonDirOf(layout)` / `commonGitDir(ctx)`
(`src/application/primitives/path-layout.ts:29,41`) and `perWorktreeRefDir(ctx, name)`
(line 48, splitting on `isPerWorktreeRef` from
`src/domain/refs/per-worktree-ref.ts:29`) fan the layout field out to ~40 call sites:
objects, packs, midx, commit-graph, `packed-refs`, shared refs and their reflogs,
`config` read/write, `shallow`, `info/exclude`, `info/attributes`, `hooks/`,
`worktrees/`. Per-worktree state (`HEAD`, `index`, `logs/HEAD`, `config.worktree`,
`info/sparse-checkout`, the pseudo-refs, `refs/bisect|worktree|rewritten/*`) stays on
`layout.gitDir`. Verified against git: 34 of 34 cross-checked `rev-parse --git-path`
entries classify identically under an override and under a real `commondir`-file split.

#### Existing test fixtures to extend

- `test/unit/repository/resolve-layout.test.ts` — top-level `describe('resolveLayout')`
  at line 19, with section describes `'Stage 3 precedence — discovery routes only'`
  (36), `'The objectFormat channel'` (201), `'Stage 4 — the bareness formula truth
  table'` (294), `'The EXPLICIT route (opts.gitDir)'` (418). Helper `makeGitDir(fs, dir)`
  at line 13 creates `objects/`, `refs/` and a `HEAD`. Probe is
  `fileSystemLayoutProbe(new MemoryFileSystem({ rootDir: '/repo' }))` with
  `posixPolicy`. **Add one new sibling section**
  `describe('The commonDir override', …)` rather than scattering rows.
- `test/unit/repository/find-layout.test.ts` — same `MemoryFileSystem` + `posixPolicy`
  pattern; existing `commondir`-file describes at lines 195, 239, 260, 466, 497, 524,
  548, 859, 885, 902, 1010, 1028, 1101, 1129, 1153, 1182 are the shapes to mirror.
- `test/unit/repository/resolve-layout-trust.test.ts` — `recordingProbe(fs, owned)`
  (line ~34) records every `isOwnedByCaller` query in order and every `readUtf8`;
  `makeGitDir` at line 17; `ranStage2(reads)` at line 24. This is the only place the
  checked *set* and its *order* are observable.
- `test/unit/repository/layout-roots.test.ts` — six existing rows including
  `'Given a hand-written commonDir in an unrelated subtree'` (line 84, keeps all three
  roots) and `'Given a linked worktree whose admin gitDir lives under the common dir'`
  (line 62, collapses to `[workDir, commonDir]`). The *unrelated-subtree* half of R7 is
  therefore **already pinned**; the shape the file appears to lack is a `commonDir` lying
  strictly **under** `workDir` (which must minimise away to `[workDir]`, the shape a
  caller pointing at a sibling directory inside their own checkout produces). Verify that
  before adding it, and never duplicate an existing row under a new name.
- `test/unit/application/primitives/commondir-per-worktree-refs.test.ts` — helper
  `asWorktreeChild(ctx)` (line ~44) reframes a seeded Context as
  `{ gitDir: `${gitDir}/worktrees/wt`, commonDir: gitDir }`; `seedAdminHead(ctx)` writes
  the admin `HEAD`; the Context comes from `buildSeededContext` in
  `test/unit/application/primitives/fixtures.js`. Check that fixture's `rootDir` before
  choosing paths for the new variant — an unrelated absolute subtree may fall outside
  the memory adapter's containment root.
- `test/unit/application/primitives/list-worktrees.test.ts` — `describe('listWorktrees')`
  at line 95; the main-entry branch under test is `isMainCheckoutBare` /`mainEntry` in
  `src/application/primitives/list-worktrees.ts` (`if (ctx.layout.commonDir === undefined)
  return ctx.layout.bare;`, and `stripGitSuffix(commonGitDir(ctx))` for the path).

### TDD steps

Test titles follow the repo tree: `describe('Given …')` > `describe('When …')` >
`it('Then …')`, AAA body with section comments, the system under test bound to `sut`
(the *function*, never the result — the result goes in `result`).

**RED 1 — `find-layout.test.ts`: the override replaces the file-derived value on the
`.git`-directory branch.**
Given `/repo/.git` valid with a `commondir` file naming `/repo/other` (itself valid) and
a valid `/repo/alt`, When `findLayout(probe, '/repo', posixPolicy, undefined, '/repo/alt')`
runs, Then the outcome is
`{ route: 'DISCOVERED', origin: '/repo', gitDir: '/repo/.git', commonDir: '/repo/alt', commonDirSupplied: true }`.
*Fails:* `findLayout` currently takes four parameters — TS2554 (too many arguments).

**RED 2 — the `commondir` file is never read when an override is supplied.**
Given `/repo/.git` valid whose `commondir` file is **zero-byte** (today a hard
`GITFILE_INVALID_FORMAT` throw from `resolveCommonDir`, pinned at
`find-layout.test.ts:859`) and a valid `/repo/alt`, When `findLayout` runs with the
override, Then it returns the outcome above and **does not throw**.
*Fails:* no override parameter exists; once added naively with `??` after the read, the
throw still escapes. This test is what forces "replace, don't out-rank".

**RED 3 — the override is honoured on the `.git`-**file** branch.**
Given `/repo/wt/.git` a gitfile pointing at `/repo/.git/worktrees/wt` (valid `HEAD`,
`commondir` naming `/repo/.git`) and a valid `/repo/alt`, When `findLayout(probe,
'/repo/wt', …, '/repo/alt')` runs, Then `commonDir` is `/repo/alt`, not `/repo/.git`.
*Fails:* `layoutFromGitfile` does not forward an override.

**RED 4 — the override is honoured on the cwd-is-gitdir branch.**
Given `/repo/bare.git` valid (no enclosing `.git`) and a valid `/repo/alt`, When
`findLayout(probe, '/repo/bare.git', …, '/repo/alt')` runs, Then the outcome is
`route: 'BARE_DIR'`, `commonDir: '/repo/alt'`, `commonDirSupplied: true`.
*Fails:* line 102's `layoutFor` call has no override.

**RED 5 — an override missing `objects/` invalidates every candidate (isolated).**
Given `/repo/inner/.git` valid, an enclosing `/repo/.git` also valid, and `/repo/alt`
containing only `refs/`, When `findLayout(probe, '/repo/inner', …, '/repo/alt')` runs,
Then the result is **`undefined`**.
Note the exact semantics before writing the assertion: the override is fed to **every**
level's `layoutFor`, so the walk does not "climb to the enclosing repository" — the
enclosing candidate fails the same check and the walk runs out. That is precisely git's
measured behaviour (an unusable value invalidates every candidate and discovery reports
`not a git repository (or any of the parent directories)`), and asserting `/repo` here
instead of `undefined` would encode a bug.
*Fails:* no override reaches `sharedDirsValid`, so both candidates still validate on
their own file-derived common dir and the result is `/repo/inner`.

**RED 6 — an override missing `refs/` invalidates every candidate (SEPARATE test).**
Same shape with `/repo/alt` containing only `objects/`. Written as its own `it` because
`sharedDirsValid`'s two guards (lines 326–329) must be killable independently — one
test triggering both proves neither alone.

**RED 7 — a degenerate override still sets the marker.**
Given `/repo/.git` valid, When `findLayout` runs with the override equal to
`/repo/.git`, Then the outcome has **no** `commonDir` key
(`expect('commonDir' in result).toBe(false)`) but `commonDirSupplied === true`.
*Fails:* neither the key omission nor the marker exists yet. This is the ADR-713 pin.

**RED 8 — R9: no override leaves the outcome byte-identical.**
Given a plain `/repo/.git`, When `findLayout` runs with no override, Then the outcome
`toStrictEqual`s `{ route: 'DISCOVERED', gitDir: '/repo/.git', origin: '/repo' }` —
asserting `commonDirSupplied` is absent, not `undefined`.

**GREEN A —** apply the `find-layout.ts` edits 1–5 from the Context block, minimally.

**RED 9 — `resolve-layout.test.ts`: the override wins over a present `commondir` file.**
Given the RED-1 fixture, When `resolveLayout(probe, '/repo', posixPolicy, { commonDir:
'/repo/alt' })` runs, Then `result.commonDir === '/repo/alt'`.
*Fails:* `ExplicitLayoutOptions` has no `commonDir` — TS2353 excess property.

**RED 10 — a relative override resolves against `cwd`, not the gitDir.**
The fixture must **distinguish** the two candidate bases, so a bare `'../shared'` will
not do (`/repo/sub/../shared` and `/repo/.git/../shared` both land on `/repo/shared`).
Use: repository at `/repo` (`/repo/.git` valid), `cwd` = `/repo/sub`, a **valid**
common dir at `/repo/sub/alt` and a **decoy** valid dir at `/repo/.git/alt`. When
`resolveLayout(probe, '/repo/sub', posixPolicy, { commonDir: 'alt' })` runs, Then
`result.commonDir === '/repo/sub/alt'` — the cwd base — and never `/repo/.git/alt`.
Assert both (`toBe` the one, `not.toBe` the other) so a base swap cannot pass.

**RED 11 — the explicit route stays lenient.**
Given nothing at `/repo/missing-common` and a valid `/repo/.git`, When `resolveLayout`
runs with `{ gitDir: '/repo/.git', commonDir: '/repo/missing-common' }`, Then a layout
is produced with `commonDir: '/repo/missing-common'` and `workDir` equal to `cwd` — no
throw, refusal deferred to first command.

**RED 12 — the degenerate value is normalised off the layout.**
Given `/repo/.git` valid, When `resolveLayout(probe, '/repo', posixPolicy, { commonDir:
'/repo/.git' })` runs, Then `'commonDir' in result` is `false`.

**RED 13 — bareness suppression on `DISCOVERED`.**
Given `/repo/.git` valid with `config` = `[core]\n\tbare = true\n`, and a valid
`/repo/alt` whose `config` also sets `bare = true`, When `resolveLayout(probe, '/repo',
…, { commonDir: '/repo/alt' })` runs, Then `result.workDir === '/repo'` (the discovered
origin) and `result.bare === false`.
*Fails:* `ExplicitLayoutOptions` has no `commonDir` — TS2353.
**Be honest about what this test does and does not discriminate:** once the field
exists, the *old* `isLinkedWorktreeAdmin` rule already returns `true` here (route
`DISCOVERED`, `commonDir` set), so this row does **not** prove the rule change. It is
still required — it is the R1/R3 behavioural pin for the discovery route — but REDs 14,
15, 16 and 17 are the ones that discriminate the new rule. Do not conclude the rule
change is proven when RED 13 goes green.

**RED 14 — bareness suppression on `EXPLICIT` (SEPARATE test).**
Same fixture, When `resolveLayout(probe, '/elsewhere', …, { gitDir: '/repo/.git',
commonDir: '/repo/alt' })` runs, Then `result.workDir === '/elsewhere'` (the cwd row)
and `result.bare === false`.
*Fails:* today's `isLinkedWorktreeAdmin` returns `false` on `EXPLICIT`, so `core.bare`
wins and `bare` is `true` with no `workDir`.

**RED 15 — the marker, not the field, drives the bypass.**
Given `/repo/.git` valid with `core.bare = true`, When `resolveLayout(probe,
'/elsewhere', …, { gitDir: '/repo/.git', commonDir: '/repo/.git' })` runs (the
**degenerate** override on the explicit route), Then `'commonDir' in result` is `false`
**and** `result.bare === false` **and** `result.workDir === '/elsewhere'`.
*Fails:* any implementation keying the bypass on `outcome.commonDir !== undefined`.
This single test is the one that kills the tempting one-line version.

**RED 16 — the override is inert on `BARE_DIR`.**
Given `/repo/bare.git` valid with `core.bare = true` and a valid `/repo/alt`, When
`resolveLayout(probe, '/repo/bare.git', …, { commonDir: '/repo/alt' })` runs, Then
`result.bare === true`, `'workDir' in result` is `false`, and
`result.commonDir === '/repo/alt'` (the value is honoured, only the bareness rule is
not).

**RED 17 — `BARE_DIR` + `core.bare = true` + `core.worktree` keeps reporting bogus.**
Same as RED 16 with `core.worktree = /repo/wt` added to the common dir's config, Then
`result.workTreeConfigBogus === true` and `'workDir' in result` is `false`.
*Fails:* an `isLinkedWorktreeAdmin` that returns `true` for a marked `BARE_DIR` outcome.

**RED 18 — the acceptance gate reads the OVERRIDDEN config.**
Given `/repo/.git` with a clean `config` and a valid `/repo/alt` whose `config` sets
`[core]\n\trepositoryformatversion = 99\n`, When `resolveLayout` runs with the override,
Then `result.formatRefusal` is present and its **fields** are asserted (the refusal kind
and the offending version), never mere presence — a presence-only assertion leaves the
`StringLiteral`/`ObjectLiteral` mutants inside `read-repository-format.ts` alive. Copy
the assertion shape from the existing `formatRefusal` rows in
`test/unit/repository/read-repository-format.test.ts`.
Add the mirror as a separate `it`: the same key in `<gitDir>/config` with a clean
override → `'formatRefusal' in result` is `false`.

**RED 19 — `objectFormat` follows the override.**
Given `/repo/.git`'s config declaring nothing and `/repo/alt`'s config declaring
`[extensions]\n\tobjectFormat = sha256\n` with `repositoryformatversion = 1`, When
`resolveLayout` runs with the override, Then `result.objectFormat === 'sha256'`.

**RED 20 — `refStorage` follows the override (SEPARATE test).**
Same shape with `refStorage = reftable`, Then `result.refStorage === 'reftable'`.

**RED 21 — the found-nothing bootstrap ignores the option.**
Given `/repo/lonely` with no repository anywhere above it and a perfectly valid
`/repo/alt`, When `resolveLayout(probe, '/repo/lonely', …, { commonDir: '/repo/alt' })`
runs, Then it returns `undefined` — the override does not conjure a repository.

**RED 22 — R9 field-by-field.**
Pick the existing `'Given route DISCOVERED with nothing above (a plain repo)'` case
(line 149) and add a sibling asserting the layout with `{}` options `toStrictEqual`s the
layout with `{ commonDir: undefined }` omitted — i.e. re-run the existing golden and
confirm no new key appears.

**GREEN B —** apply the `resolve-layout.ts` edits 1–4 from the Context block.

**RED 23 — `resolve-layout-trust.test.ts`: the ownership predicate checks the
overridden common dir.**
Using `recordingProbe`, Given a valid `/repo/.git` and a valid `/repo/alt`, and an
`owned` predicate returning `false` **only** for `/repo/alt`, When `resolveLayout` runs
with the override on the discovery route, Then `result.untrusted === true`,
`result.foreignPath === '/repo/alt'`, `ownershipQueries` equals
`['/repo', '/repo/.git', '/repo/alt']` in that order, and `ranStage2(reads)` is `false`
(a refused repository's config is never read).
Add the negative twin: the same fixture with `owned` returning `true` everywhere →
`untrusted` absent and `/repo/alt` still present in `ownershipQueries` (proving the
override, not the gitDir, was the third path).
*Fails:* the third checked path is currently the file-derived value.

**RED 24 — the EXPLICIT route is still ungated (the stated residual).**
Same probe and `owned` predicate, When `resolveLayout` runs with `{ gitDir, commonDir }`,
Then `ownershipQueries` is empty and `result.untrusted` is absent. This pins that the
option adds a second path into a pre-existing hole rather than a new one — and it must
not silently change.

**RED 25 — `commondir-per-worktree-refs.test.ts`: the split is parameterised, not
hard-coded to the `worktrees/` shape.**
Add a fixture variant beside `asWorktreeChild` — e.g.
`asOverriddenCommonDir(ctx)` returning
`{ ...ctx, layout: { ...ctx.layout, gitDir: `${rootDir}/wt/.git`, commonDir: `${rootDir}/shared` } }`
with the two in **disjoint** subtrees (both inside the seeded Context's `rootDir` — read
`fixtures.js` first). Two `it`s under it: `updateRef` on a shared ref lands under
`<commonDir>/refs/…`; `updateRef` on a per-worktree ref (`refs/bisect/bad`) lands under
`<gitDir>/refs/…`. Seed the admin `HEAD` the way `seedAdminHead` does.

**RED 26 — `list-worktrees.test.ts`: the main entry derives from the overridden common
dir.**
Given a Context whose `layout.commonDir` names an unrelated subtree ending in `/.git`,
When `listWorktrees` runs, Then the main entry's `path` is that directory with the
`/.git` suffix stripped — proving `mainEntry` reads `commonGitDir(ctx)` rather than
`layout.workDir` or `layout.gitDir`. Note the coupled branch: with `commonDir` present,
`isMainCheckoutBare` calls `readConfig(ctx)` instead of returning `ctx.layout.bare`, so
the fixture must place a readable `config` under the **common dir** (the existing
linked-worktree rows at lines 202 and 249 show both the bare and non-bare shapes).
Confirm first that no existing row already asserts this; if one does, extend it rather
than adding a duplicate.

**RED 27 — `layout-roots.test.ts`: a `commonDir` strictly under `workDir` minimises
away.**
Given `{ workDir: '/repo', gitDir: '/repo/wt/.git', commonDir: '/repo/shared', bare: false,
refStorage: 'files' }`, When `layoutRootsOf` runs, Then the result is `['/repo']`.
Add this **only** after confirming the file has no equivalent row (see the fixture note
above); the unrelated-subtree and admin-under-common shapes are already covered at
lines 84 and 62.

**REFACTOR.**
- Re-read `isLinkedWorktreeAdmin`'s and `findLayout`'s doc comments and make sure they
  state the measured rule and the *why*, never a document reference.
- Confirm no function exceeded ~20 lines: `findLayout`'s loop body must stay as-is (the
  marker is spread inline into the three existing single-line returns, plus the one
  `suppliedMarker` helper outside the function).
- Confirm both files stay far below the 800-line ceiling and that
  `src/repository/fixed-entry-layout.ts` still compiles untouched (the new parameters
  are all optional and trailing).
- Run the scoped coverage command only if curiosity demands it — `src/repository/**` is
  outside the coverage include list, so there is no threshold to satisfy here.

### Gate

```
npx vitest run test/unit/repository/find-layout.test.ts test/unit/repository/resolve-layout.test.ts test/unit/repository/resolve-layout-trust.test.ts test/unit/repository/resolve-layout-ref-storage-passthrough.test.ts test/unit/repository/resolve-layout-trust-options-shape.test.ts test/unit/repository/layout-roots.test.ts test/unit/repository/memory-shim-discovery.test.ts test/unit/application/primitives/commondir-per-worktree-refs.test.ts test/unit/application/primitives/list-worktrees.test.ts test/unit/application/primitives/path-layout.test.ts && npm run check:types && ./node_modules/.bin/biome check src/repository/find-layout.ts src/repository/resolve-layout.ts test/unit/repository/find-layout.test.ts test/unit/repository/resolve-layout.test.ts test/unit/repository/resolve-layout-trust.test.ts test/unit/repository/layout-roots.test.ts test/unit/application/primitives/commondir-per-worktree-refs.test.ts test/unit/application/primitives/list-worktrees.test.ts
```

### Commit

```
feat(repository): resolve a caller-supplied common dir in both layout routes
```

---

## Part 2 — Publish `commonDir` on `openRepository` and thread it through all three shims

### Context

**Goal.** `OpenRepositoryOptions.commonDir` becomes public, validated, documented with
its security residual, and reaches the layout on node, memory and browser — the browser
via the ADR-717 signature migration. `reports/api.json` is regenerated in this same
commit.

**Files to change (7 source + 1 generated):**

- `src/repository/validate-options.ts` (153 lines)
- `src/repository.ts` (918 lines) — the public field only
- `src/ports/context.ts` (245 lines) — a JSDoc nit only
- `src/index.node.ts` (338 lines)
- `src/index.default.ts` (113 lines)
- `src/repository/fixed-entry-layout.ts` (60 lines) — signature migration
- `src/index.browser.ts` (109 lines) — the one caller
- `reports/api.json` (generated)

**Test files to change (5):**

- `test/unit/repository/validate-options.test.ts`
- `test/unit/index.default.test.ts`
- `test/unit/index.browser.test.ts`
- `test/unit/index-node-root-canonicalisation.test.ts`
- `test/integration/node-shim.test.ts`

#### Public-surface decision

`OpenRepositoryOptions.commonDir` is **PUBLIC**. Gates it trips, all pre-paid here:

1. **`reports/api.json`** — a **prepush** gate (`check:doc-typedoc` =
   `git diff --exit-code -- reports/api.json`, depending on `docs:json`). A cached-green
   `npm run validate` will *not* catch it. Run `npm run docs:json` and commit the
   regenerated file **in this part's commit**; the large typedoc-id churn is normal.
2. **No barrel change, no facade binding, no new error code, no exhaustiveness switch,
   no `docs/use/commands/*` page, no `audit-browser-surface` entry** — verified:
   `check:doc-coverage` and `audit-browser-surface` extract facade members by regex over
   `readonly (\w+): BindCtx<` / `readonly (\w+): commands.\w+Namespace`, and an options
   *field* matches neither.

`ExplicitLayoutOptions.commonDir` (landed in Part 1), `ValidatableOptions.commonDir` and
`resolveFixedEntryLayout`'s overrides object are all **internal**.

#### `src/repository/validate-options.ts`

`ValidatableOptions` (lines 9–19) gains `readonly commonDir?: string;` immediately after
`workDir`. Add the guard next to `validateWorkDir` (lines 69–72), mirroring it exactly:

```ts
const validateCommonDir = (value: string | undefined): void => {
  if (value === undefined) return;
  if (value.length === 0) throw invalidOption('commonDir', 'must not be empty');
};
```

and call it from `validateOptions` on its own line, immediately after
`validateWorkDir(opts.workDir);` (line 41). The module's own header comment states the
mutation-resistance contract: **each guard is a separate `if`** so a `StatementRemoval`
mutant fails its dedicated test rather than passing through another. Not
absolute-required — relative values resolve against `cwd`, exactly as `gitDir` and
`workDir` do. This is where git's "an empty `GIT_COMMON_DIR` is an *active* override
that invalidates every candidate" becomes an informative refusal instead.

#### `src/repository.ts` — the public field

Insert immediately after `workDir` (which ends at line 98), before `bare`:

```ts
readonly commonDir?: string;
```

Its JSDoc must carry, in this order:

- **What it is** — the explicit shared/common git directory: the argument equivalent of
  git's `GIT_COMMON_DIR`. Relative values resolve against `cwd`. No environment
  variable is ever read.
- **What follows it** — objects, `packed-refs`, shared refs and their reflogs, `config`,
  `shallow`, `info/exclude`, `info/attributes`, `hooks/`, the commit-graph, the midx and
  `worktrees/`. Per-worktree state stays at `gitDir`: `HEAD`, `index`, `logs/HEAD`,
  `config.worktree`, `info/sparse-checkout`, the pseudo-refs and
  `refs/bisect|worktree|rewritten/*`.
- **Precedence** — it replaces any on-disk `<gitDir>/commondir` file; the file is not
  read at all when the argument is given.
- **Bareness** — supplying it makes `core.bare` inert and keeps a work tree (the
  discovered top level on the discovery route, `cwd` on the explicit route), matching
  git; on the cwd-is-gitdir route it has no bareness effect.
- **Degenerate value** — a value resolving to `gitDir` is accepted and carries the
  bareness rule, but is not reported on `repo.layout` (`layout.commonDir` is present if
  and only if it differs from `gitDir`).
- **Inert on bootstrap** — when discovery finds no repository, the option is ignored and
  `init`/`clone` create a normal repository at `cwd`.
- **Unusable values** — an override lacking `objects/` or `refs/` invalidates every
  discovery candidate, so a read command throws `NOT_A_REPOSITORY`; the explicit-`gitDir`
  route stays lenient and defers the refusal to the first command.
- **`WARNING:`** — same framing `hooks` (line 137) and `unsafeRawAdapters` (line 153)
  already use: naming a common dir widens the filesystem containment root set to that
  subtree, chooses which `config` is authoritative (and therefore which
  `merge.<driver>.driver` commands, `core.excludesFile` reads, hash algorithm and ref
  backend the repository runs with), and chooses which `hooks/` directory is spawned
  with the caller's environment. The ownership gate is **off** on the explicit-`gitDir`
  route, so `openRepository({ gitDir, commonDir })` against another user's directory is
  accepted without an ownership check, exactly as `openRepository({ gitDir })` already
  is. Pass `hooks: false` / `command: false` to close the two code-execution channels.
  `commonDir` is not a sandbox.

No other change in `repository.ts`: `validateOptions(opts)` at line 508 picks the field
up automatically, and `layoutRootsOf(fallback.layout)` at line 518 already folds the
resolved value into the containment roots.

#### `src/ports/context.ts` — the JSDoc nit (in scope)

`RepositoryLayout.commonDir`'s JSDoc (lines 44–51) currently ends
"…rather than reading this field directly — both are exported." Say **from where**:
importable as `import { commonGitDir, commonDirOf } from '@scolladon/tsgit/primitives'`,
with `commonGitDir` additionally bound at `repo.primitives.commonGitDir`. Comment text
only — no code change, so the 100 % coverage threshold on `src/ports/**` is unaffected.

#### `src/index.node.ts`

`buildLayoutOptions` (lines 258–270) gains one spread, immediately after the `gitDir`
spread at line 264:

```ts
...(opts.commonDir !== undefined ? { commonDir: opts.commonDir } : {}),
```

**Nothing else changes.** Deliberately: `opts.commonDir` is **not** canonicalised before
being passed, exactly as `opts.gitDir` is not — symmetry with the sibling layout
argument. The post-resolution realpath pass at lines 300–310 already realpaths
`resolved.commonDir` (whatever produced it) and folds the result into the `canonical`
flag, which is what keeps `NodeFileSystem`'s realpath containment from spuriously
denying under the macOS `/var` → `/private/var` class.

#### `src/index.default.ts`

The inline `ExplicitLayoutOptions` literal at lines 80–87 gains the same spread,
immediately after line 81's `gitDir` spread. Memory stays lexical
(`portablePosixPolicy`) — the same sandboxed-adapter split `core.worktree` and
`ceilingDirs` already follow.

#### `src/repository/fixed-entry-layout.ts` — the ADR-717 migration

Current signature (line 25):
`resolveFixedEntryLayout(fs: FileSystem, workDir: string, gitDir: string, bare?: boolean, explicitWorkDir?: string)`.
New signature:
`resolveFixedEntryLayout(fs: FileSystem, workDir: string, gitDir: string, overrides: FixedEntryOverrides = {})`
with an exported-for-typing-only interface in the same module:

```ts
interface FixedEntryOverrides {
  readonly bare?: boolean;
  readonly workDir?: string;
  readonly commonDir?: string;
}
```

(mirroring `LayoutOverrides` in `resolve-layout.ts:154`, which is what these parameters
become downstream anyway).

Body changes:

- Resolve the caller's value once against `workDir` (the browser's cwd is always
  `ROOT_WORK_DIR`, which is also this parameter):
  `resolveAgainst(workDir, overrides.commonDir, portablePosixPolicy)` — import
  `resolveAgainst` from `./resolve-layout.js`, which this module already imports
  `finishLayout` from (no new cycle).
- Thread the resolved override into the gitfile branch's `layoutFromGitfile` call
  (line 36, now a 6th argument) **and** into the literal branch (line 37), which
  currently returns a bare `{ gitDir }` and never reads a `commondir` file at all:
  `{ gitDir, ...(override !== undefined && override !== gitDir ? { commonDir: override } : {}) }`.
- Add `...(override !== undefined ? { commonDirSupplied: true as const } : {})` to the
  `WalkOutcome` literal at line 38 — this shim hard-wires `route: 'DISCOVERED'`, so
  without the marker a supplied value would silently satisfy the *old* rule via the
  field alone and the browser would diverge from node/memory on the degenerate case.
- Keep the `bare` / `explicitWorkDir` spreads at lines 44–45 reading from `overrides`.
- Extract the `located` computation into a module-private
  `locateFixedEntry(probe, workDir, gitDir, commonDirOverride)` so
  `resolveFixedEntryLayout` stays short.
- Leave the trailing bootstrap branch (lines 47–59, which strips `objectFormat` when
  nothing exists at the entry) exactly as it is.

#### `src/index.browser.ts` — the one caller

Lines 70–76 migrate from five positionals to the object form:

```ts
const layout = await resolveFixedEntryLayout(
  fs,
  ROOT_WORK_DIR,
  resolveGitDirEntry(opts.gitDir, gitDirName),
  {
    ...(opts.bare !== undefined ? { bare: opts.bare } : {}),
    ...(opts.workDir !== undefined ? { workDir: opts.workDir } : {}),
    ...(opts.commonDir !== undefined ? { commonDir: opts.commonDir } : {}),
  },
);
```

**Conditional spreads are mandatory, not stylistic:** `exactOptionalPropertyTypes` is
on, so `{ bare: opts.bare }` with `opts.bare: boolean | undefined` is a type error where
the old positional `opts.bare` was legal. `commonDir` is inherited from
`OpenRepositoryOptions` by `OpenBrowserRepositoryOptions` (line 36) and is **not**
stripped from `coreOpts` (lines 93–100) — it stays in the forwarded options and the core
re-validates it, which is correct.

#### Existing test fixtures to extend

- `test/unit/repository/validate-options.test.ts` — two top-level describes:
  `'validateOptions — invalid option values'` (line 21) and
  `'validateOptions — valid option values'` (line 149).
- `test/unit/index.default.test.ts` — `describe('memory shim — openRepository')` (line
  6); the `gitDir: ''` refusal row at line 35 is the shape to mirror; the explicit
  `workDir` row at line 117 shows how a layout field is asserted.
- `test/unit/index.browser.test.ts` — **seven direct `resolveFixedEntryLayout` call
  sites** at lines 226, 254, 283, 303, 325, 351 and 375 (each bound to `sut` inside a
  `describe('When resolveFixedEntryLayout runs …')`). Every one migrates to the object
  form in this part; the shim-level describes start at line 14, and line 97's
  `gitDir: ''` refusal row is the validation shape.
- `test/unit/index-node-root-canonicalisation.test.ts` — the block at line 237
  (`'Given a linked worktree whose commondir is reached through a symlink'` → asserts
  `layout.commonDir` is the realpathed target, not the symlink's lexical path) is the
  exact template for the override's symlink row; `tmpdir` is created in a `beforeEach`
  at line 41.
- `test/integration/node-shim.test.ts` — the block at line 413
  (`'Node shim — explicit gitDir + workDir containment'` → both disjoint roots reachable,
  their common ancestor refused) is the template for the raw-adapter root-set probe; the
  linked-worktree layout assertions at lines 179–229 show the `layout.commonDir`
  assertion style, including `expect('commonDir' in sut.ctx.layout).toBe(false)`.

### TDD steps

**RED 1 — `validate-options.test.ts`: the empty-string refusal, isolated.**
Given `{ commonDir: '' }`, When `validateOptions` runs, Then it throws with
`error.data.option === 'commonDir'` **and** `error.data.reason === 'must not be empty'`.
Use try/catch plus direct `.data` assertions with a `expect.fail`-style unreachable
guard — never `toThrow(TsgitError)` and never
`toThrow(expect.objectContaining(...))`; a `StringLiteral` mutant on the reason survives
a type-only check. Its own `it`, never shared with `gitDir`'s or `workDir`'s.
*Fails:* `commonDir` is not in `ValidatableOptions` (TS2353) and no guard exists.

**RED 2 — the valid cases.**
Under the valid-values describe: `{ commonDir: '/abs/common' }`, `{ commonDir: 'rel/common' }`
and an options object with `commonDir` absent all return without throwing — pinning that
the guard is emptiness-only, not absoluteness.

**GREEN A —** `validate-options.ts` edits.

**RED 3 — `index.default.test.ts`: the memory shim honours `commonDir`.**
Seed the split through the `files` option (the constructor's `ensureParentDirs` turns a
seeded file into its parent directories):
`'/repo/wt/.git/HEAD'` = `'ref: refs/heads/main\n'`,
`'/repo/wt/.git/config'` = `'[core]\n\tbare = true\n'` (the decoy — and the degenerate
twin's subject),
`'/repo/shared/objects/.keep'`, `'/repo/shared/refs/.keep'`,
`'/repo/shared/config'` = `'[core]\n\tbare = true\n'`.
When `openRepository({ cwd: '/repo', gitDir: '/repo/wt/.git', commonDir: '/repo/shared' })`
runs, Then `repo.layout.commonDir === '/repo/shared'`, `repo.layout.bare === false` and
`repo.layout.workDir === '/repo'` (the explicit route's cwd row with `core.bare`
suppressed).
*Fails:* the memory shim drops `opts.commonDir` on the floor, so the layout carries no
`commonDir` and `core.bare` from the decoy makes it bare with no work tree.
**Degenerate twin (a separate `it`):** `commonDir: '/repo/wt/.git'` → `'commonDir' in
repo.layout` is `false`, `repo.layout.bare === false` and `repo.layout.workDir === '/repo'`.
The gitDir's own `core.bare = true` is what makes this row prove suppression rather than
tautology — without the decoy config it would pass for the wrong reason.
Always `await repo.dispose()` at the end of each memory-shim test.

**GREEN B —** `index.default.ts` spread.

**RED 4 — `index.browser.test.ts`: the signature migration plus the new coverage.**
Two distinct harnesses live in this file and each carries part of the browser proof:

- `fakeHandle = {} as unknown as FileSystemDirectoryHandle` (line 12) makes **every**
  OPFS call reject, which `fileSystemLayoutProbe` maps to "absent" — so the
  `openRepository`-level describes exercise the *nothing-exists* branch of
  `resolveFixedEntryLayout`.
- `stubFsOver({ '<path>': { kind: 'file' | 'dir', content? } })` builds a synthetic
  `FileSystem`, used by the seven direct `resolveFixedEntryLayout` calls.

Steps:
1. Migrate all seven direct call sites (lines 226, 254, 283, 303, 325, 351, 375) from
   `sut(fs, '/', '/.git', false)` to `sut(fs, '/', '/.git', { bare: false })`. They go
   red as TS2345 the moment the signature changes, so this migration lands in the same
   commit as the signature.
2. **`stubFsOver` rows** (the real layout proof): a `/.git` gitfile pointing at `/admin`
   whose `commondir` names `/decoy`, plus a valid `/shared` — with
   `{ commonDir: '/shared' }` the layout's `commonDir` is `/shared` and never `/decoy`
   (the file-beaten-by-argument rule on the browser path). A second row with a plain
   `/.git` **directory** entry (no gitfile, no `commondir` file read at all on this
   branch) and `{ commonDir: '/shared' }` → `commonDir: '/shared'`. A third row with
   `{ commonDir: '/.git' }` (degenerate) → no `commonDir` key.
3. **`fakeHandle` row** (the forwarding proof): `openRepository({ rootHandle: fakeHandle,
   commonDir: '/shared' })` → `repo.layout.commonDir === '/shared'` — nothing exists, so
   this pins that `index.browser.ts` actually passes the option down. Add the relative
   twin `commonDir: 'shared'` → `/shared` (resolved against the fixed root work dir).

**GREEN C —** `fixed-entry-layout.ts` + `index.browser.ts` edits.

**RED 5 — `node-shim.test.ts`: the node shim honours `commonDir` and the raw adapter
reaches it.**
Given a real tmpdir with `<root>/main/.git` (a real repository, built by `repo.init()`
plus a commit) and a hand-built valid `<root>/alt` (`objects/`, `refs/`, `HEAD`), When
`openRepository({ cwd: <root>/main, gitDir: <root>/main/.git, commonDir: <root>/alt })`
runs, Then `repo.layout.commonDir` equals the **realpathed** `<root>/alt`, and a raw
read through the adapter reaches a file under `<root>/alt` while a file at the roots'
common ancestor is refused. Use `realpath()` on the tmpdir (macOS `/var` →
`/private/var`) and follow the disjoint-roots assertions at line 413.
*Fails:* `buildLayoutOptions` drops the field.

**GREEN D —** `index.node.ts` spread.

**RED 6 — `index-node-root-canonicalisation.test.ts`: a symlinked override is
realpathed onto the layout.**
Given `<tmp>/real-common` valid and `<tmp>/link-common` a symlink to it, When
`openRepository({ cwd, gitDir, commonDir: '<tmp>/link-common' })` runs, Then
`repo.ctx.layout.commonDir` is the realpathed target and **not** the symlink path —
mirroring the assertion pair at lines 264–265.

**GREEN E —** expected to need **no** production change: `index.node.ts:301–302` already
realpaths whatever `resolved.commonDir` holds. If the test passes on its first run, keep
it — it is a regression pin for a property the shim provides implicitly. If it fails,
the fix belongs in the realpath pass, never in the test's expectation.

**RED 7 — `repository.ts` public field + JSDoc + `ports/context.ts` nit.**
No behavioural test: the field is proven by REDs 3–6 through the shims. Add the field
and the JSDoc, then run `npm run check:types`.

**REFACTOR / surface pre-payment.**
1. `npm run docs:json` — regenerate `reports/api.json`.
2. `git add reports/api.json` and include it in this part's single commit.
3. Sanity-check with `npm run check:doc-typedoc` (it re-runs `docs:json` and
   `git diff --exit-code`).
4. Re-read the new JSDoc: no `§`/ADR/backlog reference may appear in it.
5. Confirm `resolveFixedEntryLayout` and `locateFixedEntry` are each well under 20 lines
   and `fixed-entry-layout.ts` is still a small file.

### Gate

```
npx vitest run test/unit/repository/validate-options.test.ts test/unit/index.default.test.ts test/unit/index.browser.test.ts test/unit/index.node.test.ts test/unit/index-node-root-canonicalisation.test.ts test/unit/index-default-trust-option-forwarding.test.ts test/unit/index-node-trust-option-forwarding.test.ts test/unit/public-types.test.ts test/unit/api-surface/ test/integration/node-shim.test.ts && npm run check:types && ./node_modules/.bin/biome check src/repository/validate-options.ts src/repository.ts src/ports/context.ts src/repository/fixed-entry-layout.ts src/index.node.ts src/index.default.ts src/index.browser.ts test/unit/repository/validate-options.test.ts test/unit/index.default.test.ts test/unit/index.browser.test.ts test/unit/index-node-root-canonicalisation.test.ts test/integration/node-shim.test.ts
```

Then `npm run docs:json` and commit the regenerated `reports/api.json` **with** this
part — `check:doc-typedoc` is a prepush gate a cached-green `validate` will not catch.

### Commit

```
feat(repository): accept an explicit commonDir on openRepository across every runtime
```

---

## Part 3 — Pin `commonDir` against canonical git and across adapters

### Context

**Goal.** Two new test files, no `src/` delta: the cross-tool interop suite implementing
scenarios A–J, and a cross-adapter parity file. Both exercise only code landed by Parts
1–2.

**Files to create (2):**

- `test/integration/common-dir-open-option-interop.test.ts`
- `test/parity/common-dir-open-option.test.ts`

#### Interop file — required scaffolding

Copy the structure of `test/integration/linked-worktree-discovery-interop.test.ts`
(the closest sibling — same subject, same helpers). Required elements:

- **`@proves` docblock** at the top of the file:
  `surface: openRepository`, `bucket: cross-tool-interop`,
  `unique: caller-supplied common dir resolves and writes where canonical git's split places it`,
  `interopSurface: layout`. (`check:write-surfaces` is warn-only in `validate` — an
  orphan-coverage report line for `interopSurface: layout` is expected and is not a
  failure.)
- **`describe.skipIf(!GIT_AVAILABLE)`** using `GIT_AVAILABLE` from `./interop-helpers.js`.
- **One shared `beforeAll(fn, 60_000)` per scenario group** — the explicit timeout is
  mandatory; git-spawning setup routinely exceeds vitest's per-hook default on a loaded
  runner. Reuse the `SETUP_TIMEOUT = 60_000` constant name the sibling file uses.
- **Every git invocation through `interop-helpers.ts`** — `runGit`, `git(dir, ...args)`,
  `runGitEnv()`, `tryRunGitWithExit`. They scrub every `GIT_*` from the parent
  environment, isolate `HOME`/`XDG_CONFIG_HOME`, set `GIT_CONFIG_NOSYSTEM=1` and turn
  signing off. Never call `execFileSync('git', …)` directly. When a scenario needs
  `GIT_COMMON_DIR`, pass it explicitly:
  `runGit(['-C', dir, …], { env: { ...runGitEnv(), GIT_COMMON_DIR: alt } })`.
- **Deterministic identity** — copy the sibling's `AUTHOR` / `COMMIT_ENV` constants.
- **`git(dir, …)` prepends `-C dir`.** A scenario needing `--git-dir` against a
  directory that is not a cwd must go through the array form —
  `runGit(['--git-dir', alt, 'show-ref'])` — not `git(alt, '--git-dir', '.', …)`.
- **`realpath`-resolved tmpdirs** — copy `mkRoot(slug)`
  (`realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-interop-cdo-<slug>-')))`), and
  `afterAll` with `rm(root, { recursive: true, force: true })`.
- **A fresh `openRepository` after every real-git write.** The per-`Context`
  loose-object fanout cache is invalidated only by tsgit's own `writeObject`; a Context
  held across a `git` subprocess write will miss objects git just created and report a
  spurious `OBJECT_NOT_FOUND`. Always `await repo.dispose()` before re-opening.
- **`disableAutoMaintenance(dir)`** on every fixture repository whose `objects/pack`
  shape a scenario inspects — `git commit` can fork a detached `gc --auto`.
- **A >1 s settle sleep** before any assertion comparing tsgit's `status` against git's
  after a real-git working-tree write: git's racy-clean stat guard is
  second-resolution, so a same-second write reads dirty in one tool and clean in the
  other.
- **`gitDirPair(cwd)`** — copy the sibling's helper
  (`git rev-parse --path-format=absolute --git-dir --git-common-dir`, split into a pair)
  for scenarios A and I.

#### Interop scenarios A–J (the design's §6 table, made concrete)

| # | Fixture | Peer | Assertions |
|---|---|---|---|
| A | `git init $R/main`, commit, `git -C $R/main worktree add ../wt`. tsgit opens `$R/wt` with `commonDir: $R/main/.git` (the same value the `commondir` file already implies). | none | `layout.gitDir`/`layout.commonDir` equal `gitDirPair($R/wt)`; `revParse('HEAD')`, `log()` length and `status()` agree with git from the same cwd. |
| B | `git init $R/plain` + commit; `cp -R $R/plain/.git $R/alt`. tsgit opens with `{ gitDir: $R/plain/.git, commonDir: $R/alt }` and writes a blob. | `GIT_COMMON_DIR=$R/alt git -C $R/plain hash-object -w --stdin` | tsgit's loose object lands at `$R/alt/objects/<xx>/<rest>`, byte-identical to git's for the same content, and **not** under `$R/plain/.git/objects`; `GIT_COMMON_DIR=$R/alt git cat-file -p <oid>` reads tsgit's object back. |
| C | The scenario-A worktree plus `cp -R $R/main/.git $R/alt`. tsgit opens `{ gitDir: $R/main/.git/worktrees/wt, workDir: $R/wt, commonDir: $R/alt }`. | **a real linked worktree**, never `GIT_COMMON_DIR=… git` | `branch.create`, `tag.create`, `commit` and `packRefs` land under `$R/alt/refs/**`, `$R/alt/logs/refs/**` and `$R/alt/packed-refs`; `git --git-dir=$R/alt show-ref` lists them; nothing appears under `$R/main/.git/refs`. `HEAD`, `index`, `logs/HEAD` and `ORIG_HEAD` land in `$R/main/.git/worktrees/wt`, and the peer proves the same split shape by running `git -C $R/wt branch peer-branch` and finding it at `$R/main/.git/refs/heads/peer-branch`. **`GIT_COMMON_DIR=… git` is the wrong peer here** — measured, git's env override leaves refs in the gitdir, so the naive assertion fails against correct git. |
| D | Scenario-B fixture; tsgit `config.set('probe.key', 'landed')`. | `GIT_COMMON_DIR=$R/alt git -C $R/plain config --list --show-origin --local` | tsgit writes `$R/alt/config`; git reports every key with origin `file:$R/alt/config`. |
| E | Scenario-B fixture, with a decoy copy of each artefact planted in `$R/plain/.git`. | `GIT_COMMON_DIR=$R/alt git` | `shallow`, `info/exclude`, `info/attributes` and the `hooks/` lookup all read/write at `$R/alt`; the gitdir decoys are ignored — in **both** tools. |
| F | `$R/alt/config` carrying `core.repositoryformatversion = 99`; then the same key in `$R/plain/.git/config` with a clean `$R/alt`; then a sha256-declaring `$R/alt` over a sha1 `$R/plain/.git`. | `git rev-parse --show-object-format`, `--git-dir` exit codes via `tryRunGitWithExit` | version 99 in the override refuses in both tools (git: exit 128, `fatal: Expected git repo version <= 1, found 99`); the same key in the gitdir config does **not** refuse (git warns, exit 0); the sha256 override resolves sha256 in both tools — assert the **resolved format only**, never that the mismatched pair is readable (git's own `log` there fails with `fatal: your current branch appears to be broken`). |
| G | `core.bare = true` in either config, `commonDir` supplied, on all three routes. | `GIT_COMMON_DIR=… git rev-parse --is-bare-repository --is-inside-work-tree --show-toplevel` | discovery route and explicit route: both tools report not-bare / inside-work-tree with the same top level (discovered origin, resp. `cwd`); cwd-is-gitdir route: both stay bare with no work tree. |
| H | Four unusable overrides — nonexistent, a regular file, `objects/`-only, `refs/`-only. | `tryRunGitWithExit` | git exits 128 with the pinned condition (attributed to the **gitDir**, never naming the common dir); tsgit's discovery route finds nothing (read command → `NOT_A_REPOSITORY`) and its explicit route defers to first command — asserted as the documented refusal-**shape** divergence with the **conditions** co-pinned. Each of the four is its own `it`. |
| I | Scenario-B fixture. | `GIT_COMMON_DIR=$R/alt git rev-parse --git-path <p>` over the design's §1e entry list | Encode §1e as **test data**, not prose: an `it.each` table of `{ path, side: 'common' \| 'perWorktree' }`. For every row assert git's reported path starts with `$R/alt` (common) or `$R/plain/.git` (per-worktree) per the table — that pins the classification against real git. For the **ref** rows additionally assert `isPerWorktreeRef` (`src/domain/refs/per-worktree-ref.ts`) agrees with `side`, which is the pin that tsgit's own split is the same one. Include at minimum both counter-intuitive rows: `info/sparse-checkout` is per-worktree while the rest of `info/` is common, and `logs/HEAD` is per-worktree while the rest of `logs/` is common. Non-ref rows (`objects`, `config`, `shallow`, `hooks`, `info/exclude`) get their tsgit-side proof from scenarios B, D and E — do not invent a tsgit accessor for them here. |
| J | Scenario-A worktree. tsgit opens with the explicit `commonDir` and writes a commit. | `git -C $R/wt` with **no** override (the real `commondir` file) | git reads the identical oid — the round-trip proof that the argument models the file. |

Group A+C+J, B+D+E+I, and F+G+H into three `describe` blocks, one `beforeAll(fn, 60_000)`
each, so the suite spawns three fixture trees rather than ten.

#### Parity file — `test/parity/common-dir-open-option.test.ts`

`test/parity/**/*.test.ts` is its own vitest project. **Do not** register a `Scenario` in
`test/parity/scenarios/index.ts` (see the measured facts above).

Shape: one shared fixture description, driven twice.

- **Split layout, identical on both adapters**, expressed relative to a root:
  `<root>/wt/.git/HEAD` = `'ref: refs/heads/main\n'`; `<root>/shared/objects/` and
  `<root>/shared/refs/` as directories; `<root>/shared/config` =
  `'[core]\n\tbare = true\n[probe]\n\tmarker = shared\n'`; a decoy
  `<root>/wt/.git/config` = `'[core]\n\tbare = true\n[probe]\n\tmarker = local\n'`.
  The read key lives in its own `[probe]` section deliberately — a `[core]` key would
  drag the eager `[core]` validation tier into the assertion for no gain, while
  `core.bare` in both files is what makes the bareness half of the golden meaningful.
- **Memory driver** — `openRepository` from `src/index.default.ts` with a `files` seed
  (`'/repo/shared/objects/.keep'` and `'/repo/shared/refs/.keep'` create those
  directories via the constructor's `ensureParentDirs`) and
  `{ cwd: '/repo', gitDir: '/repo/wt/.git', commonDir: '/repo/shared' }`.
- **Node driver** — `openRepository` from `src/index.node.ts` over a `realpath`ed
  `mkdtemp` root, staged with `node:fs/promises` `mkdir`/`writeFile`, same option shape.
- **Shared assertions (the golden)** — for each driver: `layout.commonDir` is the split's
  shared directory; `layout.gitDir` is the admin dir; `layout.bare === false` and
  `layout.workDir` is `cwd` (the explicit route's cwd row with `core.bare` suppressed);
  `repo.primitives.commonGitDir()` equals `layout.commonDir`; and
  `repo.config.get('probe.marker')` resolves to `'shared'`, **not** `'local'` — a real
  cross-adapter read proof that costs no compression fixture. Express the golden once as
  a module constant (parameterised by the root) and assert both drivers against it, so a
  divergence reads as a parity failure rather than two expectations drifting apart.
  Always `await repo.dispose()` in a `finally`, the way `test/parity/run-scenario.ts`
  does (an undisposed `FileHandle` surfaces as an unrelated test's failure).

### TDD steps

This part is test-infra: the RED for each scenario is "the assertion does not yet exist",
and the GREEN is the scenario passing against already-landed code. Write them in this
order and run after each group so a failure is attributable.

1. **RED/GREEN — parity file first** (fastest feedback, no git subprocess). Write the
   memory driver, run it, then the node driver, run it. A divergence here is a real
   adapter bug in Part 1/2, not a test bug — do **not** paper over it by weakening the
   golden; escalate as `{ part, reason, ≤3 options }`.
2. **RED/GREEN — interop group A+C+J.** Build the fixture in one
   `beforeAll(fn, 60_000)`; assert A first (pure read agreement), then C (the ref
   placement pin — the most consequential assertion in the feature), then J.
3. **RED/GREEN — interop group B+D+E+I.** B and D are the two surfaces git genuinely
   routes through `GIT_COMMON_DIR`, so their peers are `GIT_COMMON_DIR=… git`. I is an
   `it.each` table.
4. **RED/GREEN — interop group F+G+H.** H's four unusable shapes are four separate
   `it`s. G covers all three routes.
5. **REFACTOR.** Collapse repeated fixture builders into named helpers *inside the
   file* (`makeSplit(root)`, `openSplit(root)`); do not add anything to
   `interop-helpers.ts` unless two files would use it. Re-read every test title for the
   Given/When/Then split, every body for the AAA section comments, and every `sut`
   binding (`sut` is the function under test; the value goes in `result`) — all four are
   **gated** heuristics in `check:test-pyramid`.
6. Verify no `@proves` key is missing and no phase/ADR/backlog reference leaked into
   either file.

### Gate

```
npx vitest run test/parity/common-dir-open-option.test.ts test/integration/common-dir-open-option-interop.test.ts test/integration/linked-worktree-discovery-interop.test.ts && npm run check:types && npm run check:test-pyramid && ./node_modules/.bin/biome check test/parity/common-dir-open-option.test.ts test/integration/common-dir-open-option-interop.test.ts
```

If the interop run exits non-zero while every test reports pass, re-run
`npm run test:integration` before investigating — a known EPIPE-class flake in this
suite family produces exactly that signature.

### Commit

```
test(repository): pin the commonDir open option against canonical git and across adapters
```

---

## Part 4 — Document the `commonDir` open option

### Context

**Goal.** The five documentation pages the design's §9 names. Docs-only: **no `src/` and
no `test/` delta.** The later documentation phase re-runs its drift probe over the whole
branch; this part pre-pays the pages already known.

**Files to change (6):**

| page | current anchors | change |
|---|---|---|
| `docs/understand/repository-layout.md` (146 lines) | `## The three routes` (line 9), the walk paragraph (19–27), `## Work-tree precedence` table (34–42) and its "Two rows surprise people" list (44–51), `## Reading the result` (64–83), `## Deliberate divergences` (131–146) | Add `commonDir` to the routes discussion (it is honoured on all three routes and replaces the on-disk `commondir` file); add a work-tree-precedence row for the bareness suppression — a supplied `commonDir` makes row 2 (`core.bare = true`) inert on the explicit and discovered routes while leaving the bare/cwd-is-gitdir route untouched — and add it to the "surprise" list with the measured justification; in `## Reading the result`, state that `layout.commonDir` reports the override and is present if and only if it differs from `gitDir`; in `## Deliberate divergences`, add `commonDir` to the arguments-not-environment sentence (line 138–140 already names `GIT_COMMON_DIR` among the variables never read — make explicit that the *argument* now exists and that the env var still is not read), and note the two deliberate divergences from the env variable: tsgit follows the value **uniformly** (refs included) rather than reproducing git's report-here/write-there split, and a trailing slash is normalised where git echoes it verbatim. |
| `docs/get-started/node.md` (194 lines) | line 40 (the `gitDir`/`workDir`/`bare`/`ceilingDirs` sentence), the explicit-layout example at 52–60, the `repo.layout` snippet at 106–110 | Add `commonDir` to the argument list sentence, add an explicit-layout example naming a shared common dir, and add `commonDir` to the `repo.layout` destructuring prose. |
| `docs/get-started/memory.md` (122 lines) | line 44 (the "same `gitDir` / `workDir` / `bare` / `ceilingDirs` options" sentence) and the examples at 47–51 | Add `commonDir` to the option list, noting it is forwarded lexically like the others and reads as absent when it resolves outside `rootDir`. |
| `docs/get-started/browser.md` (158 lines) | lines 100–114 (the fixed-entry / `gitDir` / `workDir` / `ceilingDirs` discussion) | Add `commonDir`: it rides the same fixed-entry resolution, relative values resolve against the root work dir, and unlike `ceilingDirs` it **does** take effect here. |
| `docs/use/primitives/internals.md` (144 lines) | the `readRepositoryFormat` entry (line 107–108) and the `resolveLayout` entry (line 119–120) | `readRepositoryFormat`: say that a caller-supplied `commonDir` moves which `<commonDir>/config` the acceptance gate, `objectFormat` and `refStorage` are read from. `resolveLayout`: say that the caller's value is resolved against `cwd` once and substituted in each route **before** candidate validation, so an unusable value invalidates discovery candidates, and that a value equal to the gitDir is normalised off the layout while still suppressing `core.bare`. |
| `docs/understand/security.md` (175 lines) | the containment-roots paragraph (line 9) and the trust bullets (157, 167) | Add the threat-model line: `commonDir` is a privilege-relevant argument in the same class as `gitDir` — it widens the containment root set, chooses which `config` is authoritative (and therefore which merge-driver commands, `core.excludesFile` reads, hash algorithm and ref backend run), and chooses which `hooks/` directory is spawned; the ownership gate checks it on the gated routes and is off on the explicit route, exactly as for `gitDir`; `hooks: false` / `command: false` close the code-execution channels; it is not a sandbox. |

Prose rules: British-leaning spelling consistent with the surrounding pages (`check:spelling`
runs cspell and has caught `-ising`/`-ised` forms before); no phase, ADR or backlog
reference in a get-started or understand page unless the page already links ADRs that
way (`repository-layout.md` and `security.md` do link ADRs — follow the local
convention on each page); every new internal link must resolve (`check:doc-links`).

### TDD steps

Documentation has no RED/GREEN cycle; the equivalent discipline is *verify each claim
against the code you are describing*, then run the doc battery.

1. **Verify before writing.** For each of the six statements below, open the source and
   confirm it still says what this plan claims — the parts above may have landed a
   slightly different shape: (a) `isLinkedWorktreeAdmin`'s final rule in
   `src/repository/resolve-layout.ts`; (b) whether `layout.commonDir` is omitted for the
   degenerate value (`finishLayout`'s emission line); (c) that the bootstrap path
   ignores the option (`syntheticFallbackLayout`); (d) the exact `INVALID_OPTION` reason
   string in `src/repository/validate-options.ts`; (e) the browser's resolution base in
   `src/repository/fixed-entry-layout.ts`; (f) the containment root formula in
   `src/repository/layout-roots.ts`.
2. Write `docs/understand/repository-layout.md` first — it is the reference the other
   pages defer to — then the three get-started pages, then `internals.md`, then
   `security.md`.
3. Cross-check that no page now contradicts another: the bareness rule, the resolution
   base and the bootstrap inertness are each stated in more than one place and must
   agree word-for-word on the *rule*, even where the phrasing differs.
4. Run the gate; fix cspell findings by rewording, never by adding dictionary entries
   unless the word is a genuine project term.

### Gate

```
npm run check:doc-links && npm run check:doc-coverage && npm run check:spelling && npm run check:types
```

No test file and no `.ts` file is touched by this part, so the `npx vitest run
<touched-tests>` and `biome check <touched-files>` placeholders resolve to the
documentation battery above. `npm run validate` still runs at the phase boundary.

### Commit

```
docs(repository): document the commonDir open option
```
