# Plan — sparse checkout reads and writes its keys in `config.worktree`

> Source: design doc `docs/design/sparse-checkout-worktree-config.md` · ADRs 1184, 1185, 1186, 1187, 1188, 1189
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

**Why four parts, not the design's three.** The design's Part 2 (writers) touches
update-config.ts + its test, enable-worktree-config.ts + its test, sparse-checkout.ts + its
test and the interop file: 7 files, over the ceiling. The split: Part 2 lands the
per-verb read/mode rules plus the casing-preserving scoped writer (consumed at once by
`set`, still targeting the local file); Part 3 lands `enableWorktreeConfig` and retargets
`set` / `disable` to `config.worktree`. Design Part 3 (the gate) is plan Part 4.

**Public-surface decision — every new symbol is INTERNAL.** None is added to
src/application/primitives/index.ts, src/application/commands/index.ts, the `Repository`
facade or src/domain/error.ts. No new error code (the gate reuses
`CONFIG_BAD_BOOLEAN_VALUE`). So: no barrel, no api.json regeneration, no doc-coverage
page, no browser-surface scenario, no exhaustiveness switch. knip runs with
`ignoreExportsUsedInFile: true`, so every new export must have an importer in `src/` by
the end of the part that creates it — each part below is ordered so that holds.

| New symbol | File | Decision |
|---|---|---|
| `readSparseConfig`, `SparseConfig` | src/application/primitives/read-sparse-config.ts | internal |
| `updateConfigFileEntries`, `updateScopedConfigEntries` | src/application/primitives/update-config.ts | internal (not added to the primitives barrel) |
| `enableWorktreeConfig` | src/application/primitives/internal/enable-worktree-config.ts | internal |
| `assertWorktreeSparseBooleansValid` | src/application/primitives/internal/repo-state.ts | internal (not added to the commands/internal/repo-state.ts shim) |

**Test conventions (every part).** `describe('Given …')` > `describe('When …')` >
`it('Then …')`; AAA section comments; the System Under Test variable `sut` is the
FUNCTION (`const sut = readSparseConfig;` then `const result = await sut(ctx);`) — never
bind a result to `sut` (the test-pyramid gate `sutBindsResult` fails on it). Errors are
asserted with try/catch on `.data` (code, key, source, value) — never bare
`toThrow(Class)`. 100% line/branch/function/statement coverage. No provenance refs
(ADR / backlog / phase numbers) in source or test; short design row ids as a table
`id` field are fine (precedent: the `shape: 'S1'` rows in
test/integration/sparse-checkout-file-interop.test.ts) but titles describe the shape in
words. No suppression directives of any kind.

**Pinned rows, interop first.** Each part lists the exact design rows it must turn
green, and its RED list starts with the interop row(s). A row already matching git at
the part's start is a GUARD (written, passes, kept). Row bytes are in the design's
"Pinned matrix" tables — the interop twin is self-pinning (git runs the same verb on the
peer), so the part never hard-codes a git result it can compare live.

**Interop harness (shared by all parts).** One file,
test/integration/sparse-checkout-worktree-config-interop.test.ts, created in Part 1 and
extended by Parts 2–4. Header:

```ts
/**
 * Cross-tool interop — sparse-checkout keys in the per-worktree config layer.
 *
 * @proves
 *   surface:        sparseCheckoutConfig
 *   bucket:         cross-tool-interop
 *   unique:         sparse keys resolve local-then-worktree and are written to config.worktree as git does
 *   interopSurface: config, sparseCheckoutFile
 */
```

(`interopSurface` names must match an `@writes` tag: `config` is declared by
src/application/primitives/update-config.ts, `sparseCheckoutFile` by
src/application/primitives/write-sparse-checkout.ts.)

Helpers to import: `GIT_AVAILABLE`, `makePeerPair`, `initBothRepos`, `runGit`,
`tryRunGitWithExit` from test/integration/interop-helpers.ts; `commitOn`, `regular`,
`listing`, `COMMIT_ENV` from test/integration/occupant-displacement-fixtures.ts;
`openRepository` from src/index.node.ts; `readIndex` from
src/application/primitives/read-index.ts. Wrap the suite in
`describe.skipIf(!GIT_AVAILABLE)`; `beforeEach` → `makePeerPair('sparse-worktree-config')` +
`initBothRepos(peer, ours)`; `afterEach` → `pair.dispose()` plus removal of any extra
temp dir a row created.

Fixture (design: "init -b main, commit a/f b/f top on main; branch other adds a/g and
changes a/f and b/f"), built with pinned dates through `commitOn` (it uses `COMMIT_ENV`,
`GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` = `1700000000 +0000`):

```ts
const seedFixture = (dir: string): void => {
  const main = commitOn(dir, [regular('a/f', 'f1\n'), regular('b/f', 'f1\n'), regular('top', 't\n')]);
  const other = commitOn(dir, [regular('a/f', 'f2\n'), regular('a/g', 'g\n'), regular('b/f', 'f2\n'), regular('top', 't\n')], main);
  runGit(['-C', dir, 'update-ref', 'refs/heads/main', main]);
  runGit(['-C', dir, 'update-ref', 'refs/heads/other', other]);
  runGit(['-C', dir, 'reset', '-q', '--hard', 'main']);
};
const CONE_FILE = '/*\n!/*/\n/b/\n';
```

Structured state comparison (ADR-249 — rebuild git's display from tsgit's structured
fields, never ask the library for display text):

```ts
// tsgit side: git's `ls-files -t` view rebuilt from the index tsgit wrote
const tagView = async (repo: Repository): Promise<string> =>
  (await readIndex(repo.ctx)).entries
    .map((e) => `${e.flags.skipWorktree ? 'S' : 'H'} ${e.path}\n`)
    .join('');
// git side
const gitTagView = (dir: string): string => runGit(['-C', dir, 'ls-files', '-t']);
// work tree
expect(listing(ours)).toEqual(listing(peer));
```

Config bytes: `readFileSync(join(dir, '.git', 'config'), 'utf8')` and
`.git/config.worktree` (absent ⇒ compare `existsSync` on both sides). Always open the
tsgit repository AFTER git prepared the shape (`openRepository({ cwd: ours })`), so the
open-time layout read sees the final config.

Linked worktrees (L2, L3): the worktree id is the basename of its path, so both sides
must use the same basename. Create a fresh parent with `mkdtemp(join(tmpdir(), 'tsgit-wt-'))`
per side, then `git -C <repo> worktree add -q <parent>/wt -b side`; open tsgit with
`openRepository({ cwd: '<parent>/wt' })`. Remove both parents in `afterEach`.

**Rows no part twins (and why).**
- `pull --ff-only . other`: tsgit has no local-path transport (src/transport holds only
  http/ssh middleware), so `pull` cannot be twinned. `pull` reaches the matcher only
  through `loadSparseMatcher` (src/application/commands/pull.ts:439), which Part 1 fixes
  and pins.
- `read-tree -m -u`: no tsgit verb. `stash`: reads no matcher (stash.ts:343), unaffected.
- P-init, S5: no tsgit `init` verb. L1, C1–C3, N1, K1, I1, O5: out of scope (design
  "Out of scope"; IMPACT lines already recorded there).

**Gate command notes.** Use `./node_modules/.bin/vitest run <files>` (same binary as
`npx vitest run`; the rtk shell hook rewrites some `npx vitest` invocations into a full
suite run). `rm -rf .wireit` before `npm run check:types` because wireit caches the
result. Never commit on a red gate. Write long command output to a file in the
scratchpad and read back only the failing lines.

**Doc surfaces (documentation phase, NOT a part here):**
docs/use/commands/sparse-checkout.md (line ~50 says the keys go to `.git/config`: rewrite
to `config.worktree`, the extension turned on, `core.worktree` relocated, `disable`
writing `index.sparse = false`, `set` without `cone` keeping the current mode, non-cone
`add` normalising the pattern file); docs/use/errors.md (`CONFIG_BAD_BOOLEAN_VALUE` can
name `config.worktree` for the two sparse keys); docs/BACKLOG.md (tick 32.32).

## Decision candidates

Choices the design and ADRs 1184–1189 did not settle. Each part is written against the
recommendation; a different pick changes only the named part.

| # | Choice | Alternatives (≤3) | Recommendation | Why / proof |
|---|---|---|---|---|
| D1 | Where `enableWorktreeConfig` moves a local `core.worktree` when run from a LINKED worktree | **a** `<commonDir>/config.worktree` (the main worktree's file). **b** scope `'worktree'` (`<gitDir>/config.worktree`), as the design's Part 2 text says | **a** | Probe on git 2.56.0 (scrubbed env, mktemp): main repo with `core.worktree` set locally, `worktree add ../wt -b side`, `sparse-checkout set --cone b` inside wt ⇒ `.git/config.worktree` = `[core]\n\tworktree = <dir>\n`, `.git/worktrees/wt/config.worktree` = `[core]\n\tsparseCheckout = true\n\tsparseCheckoutCone = true\n`. `core.worktree` describes the main worktree, so git relocates it to the main file. In the main worktree a and b are the same path (B3 unchanged). Affects Part 2 (adds the path-taking writer) and Part 3. |
| D2 | Non-cone `add` pattern-file text | **a** rebuild: the existing file's parsed patterns plus the added ones, each ending in `\n` (comments and blank lines dropped). **b** keep the existing bytes, add a missing final `\n`, append each added pattern plus `\n` | **a** | Probe on git 2.56.0: `set --no-cone /a/` ⇒ `/a/\n`; `add /b/` ⇒ `/a/\n/b/\n`; with the file hand-set to `/a/\n#c\n\n/b/` (no final newline), `add /top` ⇒ `/a/\n/b/\n/top\n`. git rewrites the file from its parsed pattern list. Same function as ADR-1189's fold. Affects Part 2. |
| D3 | Interop twins of R3, R5, V1, X1, whose cone key resolves absent, so the cone file is read non-cone and hits the pre-existing N1 `top` divergence (tsgit `S top`, git `H top`) | **a** add local `core.sparseCheckoutCone = true` to both twins, so the rows pin the `sparseCheckout` layering only. The absent-cone default is pinned by the `readSparseConfig` unit rows. **b** keep the shapes as pinned and compare only the `a/*` and `b/*` entries. **c** no interop twin for these four, unit rows only | **a** | The rows' axis is where `sparseCheckout` resolves from. Without the cone key, the twin would fail on N1 (design "Out of scope", tsgit table row R3) whatever this change does. a keeps a live git comparison with no filtering. Affects Part 1. |

## Part 1 — layered sparse reader feeds every matcher consumer

### Context

Pinned rows this part turns green, interop first: **T0, R2, R4, R5\*, V1\*, X1\*, L2-linked,
W-reset-hard, W-reset-mixed, W-merge-ff, W-merge-3way** (RED). GUARDs written in this part:
**R1, R3\*, R11, R13 (work tree only), D1, M2, L2-main**. (\* = local
`core.sparseCheckoutCone = true` added to both twins, decision D3.) Requirements 1, 2,
3, 4 (matcher half).

Files this part creates or edits:
- `src/application/primitives/read-sparse-config.ts` (NEW)
- `src/application/primitives/read-sparse-checkout.ts`
- `test/unit/application/primitives/read-sparse-config.test.ts` (NEW)
- `test/unit/application/primitives/read-sparse-checkout.test.ts`
- `test/integration/sparse-checkout-worktree-config-interop.test.ts` (NEW — see the plan-wide harness note)

Current code being changed — `loadSparseMatcher` in read-sparse-checkout.ts (lines 59–74):

```ts
export const loadSparseMatcher = async (ctx: Context): Promise<SparseMatcher | undefined> => {
  const config = await readConfig(ctx);
  if (config.core?.sparseCheckout !== true) return undefined;
  const coneRequested = config.core.sparseCheckoutCone === true;
  const text = await readSparsePatternText(ctx);
  ...
```

The file's docstring (line 4) says "pure read side over ports + domain + `readConfig`":
update it to name `readSparseConfig`. Drop the `readConfig` import.

Building blocks (read-only, plain paths):
- `readConfig(ctx)` — src/application/primitives/config-read.ts:550. Local file only
  (`${commonGitDir(ctx)}/config`), epoch-trusted. `config.core?.sparseCheckout` /
  `sparseCheckoutCone` are `boolean | undefined`, last VALID entry wins: a value outside
  git's boolean grammar is skipped and leaves the earlier value standing
  (`applyCoreBooleanEntry`, config-read.ts ~1643). On a trust-refused layout it returns
  `{}` without reading.
- `isWorktreeScopeActive(ctx)` — src/application/primitives/config-scoped-read.ts:156.
  `false` on `layoutFailsAcceptance`, with zero reads. Otherwise it reads
  `extensions.worktreeConfig` from the cached local scope under `parseGitBoolean`, so
  `yes` counts (X1).
- `readConfigSections({ ctx, scope: 'worktree' })` — same file :260. Returns
  `ReadonlyArray<{ scope, section: IniSection }>`, cached per `(session, gitDir, scope)`
  and re-stat'd on every call. A missing file gives `[]`, and a malformed file throws
  `CONFIG_PARSE_ERROR`. It throws `CONFIG_SCOPE_NOT_AVAILABLE` when the extension is off,
  so only call it after `isWorktreeScopeActive` returned true.
- `IniSection` — src/domain/config/config-ini.ts:24:
  `{ section, subsection: string | undefined, entries: { key, value: string | null }[] }`.
  `value === null` means a valueless key (boolean true).
- `parseGitBoolean(value: string | null)` — src/domain/config/config-ini.ts:845, returns
  `{ ok: true, value } | { ok: false }`. `null` ⇒ true, `''` ⇒ false.

Target shape (new file):

```ts
export interface SparseConfig {
  readonly enabled: boolean; // resolved core.sparseCheckout, absent ⇒ false
  readonly cone: boolean;    // resolved core.sparseCheckoutCone, absent ⇒ false
}
export const readSparseConfig = async (ctx: Context): Promise<SparseConfig> => { … };
```

Resolution: `enabled = wt.sparsecheckout ?? local.core?.sparseCheckout ?? false`, and
the same for `cone` with `sparsecheckoutcone`. `wt` is `{}` when
`isWorktreeScopeActive(ctx)` is false. Otherwise it is the last VALID boolean per key
over `[core]` sections with NO subsection, with section and key names compared
lowercased. A value outside the grammar is skipped, the same leniency as the local
file. The gate (Part 4) is what refuses it. Keep the walker a private pure helper in
the same file (under 20 lines, nesting ≤ 2: early `continue` per section). Name the key
literals as constants (no magic strings).

Test fixtures: tests use `createMemoryContext()` from src/adapters/memory/memory-adapter.ts.
Its layout is accepted, with `gitDir` = `commonDir`. Reset both caches in `beforeEach`:
`__resetConfigCacheForTests` (config-read.ts) and `__resetSectionsCacheForTests`
(config-scoped-read.ts). Write the local file at `${commonGitDir(ctx)}/config`
(`commonGitDir` from src/application/primitives/path-layout.ts:42) and the worktree file
at `${ctx.layout.gitDir}/config.worktree`. Linked-worktree context (precedent:
test/unit/application/primitives/config-scoped-read.test.ts ~line 120):

```ts
const linked = (base: Context): Context => ({
  ...base,
  layout: { ...base.layout, gitDir: `${base.layout.gitDir}/worktrees/wt`, commonDir: base.layout.gitDir },
});
```

Refused layout: `{ ...base, layout: { ...base.layout, untrusted: true as const } }`
(precedent: config-scoped-read.test.ts ~line 345, which counts `readUtf8` calls).

In the existing read-sparse-checkout.test.ts, `seedConfig` writes `${gitDir}/config`.
Add a sibling `seedWorktreeConfig(ctx, text)` that writes `${gitDir}/config.worktree`.
The existing `loadSparseMatcher` describe block gets the new cases.

Interop shapes for this part (git prepares, both sides then run the verb):
- T0 / W rows: `git sparse-checkout set --cone b` on both sides. Then the verb:
  `checkout other` (tsgit `repo.checkout({ rev: 'other' })`); `reset --hard other`
  (`repo.reset({ mode: 'hard', rev: 'other' })`); `reset other` (`mode: 'mixed'`);
  `merge --ff-only other` (`repo.merge.run({ rev: 'other', fastForward: 'only' })`);
  three-way: first commit a `top` change on `main` on both sides with `commitOn(dir, [a/f f1, b/f f1, top t2], main)`
  plus `update-ref refs/heads/main` and `reset -q --hard main` (do the commit BEFORE the
  git `set`), then `git merge -q --no-edit other` with `env: COMMIT_ENV` vs
  `repo.merge.run({ rev: 'other', message: …, author: … })` with the pinned identity
  (`name 'Ada'`, `ada@example.com`, timestamp `1_700_000_000`, `+0000`; precedent:
  test/integration/add-add-content-interop.test.ts:161). Compare the tag view and the
  listing. Merge SHAs are not compared.
- R2, R4, R5\*, V1\*, X1\*, D1, R3\*: `git config extensions.worktreeConfig true` (X1:
  `yes`). Local keys via `git config core.<key> <v>`. Worktree keys written raw to
  .git/config.worktree with `writeFileSync`, so the valueless (V1) and duplicate (D1)
  shapes are exact. Cone file written to .git/info/sparse-checkout (`mkdirSync` the
  info dir with `recursive: true`). Verb: `checkout other`.
- R1, R11, M2: the extension stays off. The worktree file is written by hand
  (true/true; `sparseCheckout = bogus`; `[core` malformed). Verb: `checkout other`.
- R13: `set --cone b`, then `git config extensions.worktreeConfig false`, then
  `checkout other`. Compare `listing` ONLY: the stale `S a/f` git keeps is K1, out of
  scope.
- L2: linked worktree `wt` on both sides (`-b side`), `git -C <wt> sparse-checkout set --cone b`.
  L2-main: `checkout --detach other` in the main worktree (tsgit
  `repo.checkout({ rev: 'other', detach: true })` on `openRepository({ cwd: ours })`).
  L2-linked: the same verb run inside `wt` on both sides (tsgit opened at the linked
  path). Compare the tag view (tsgit `readIndex(repo.ctx)` resolves the linked index)
  and the listing of each worktree dir.

### TDD steps

1. **RED (interop)** — T0 row in
   test/integration/sparse-checkout-worktree-config-interop.test.ts. Expected failure:
   the tsgit tag view is `H a/f H a/g H b/f H top` and `a/f a/g` are written, because
   `loadSparseMatcher` reads only the local file, which holds no sparse key.
2. **RED (interop)** — R2, R4, R5\*, V1\*, X1\*, L2-linked, then the four W rows. Each
   fails for the same reason: R2/R5/V1/X1/L2-linked/W are all `H` on tsgit. R4 shows
   `S` entries on tsgit because the local `true` wins and the worktree `false` is
   unseen.
3. **GUARD (interop)** — R1, R11, M2, R13 (work tree), D1, R3\*, L2-main. They pass
   now: the extension is off (R1, R11, M2, R13), the worktree file's effect equals
   local-only resolution (D1: no local key, worktree true-then-false ⇒ off; R3: local
   only), or the main worktree has no sparse key (L2-main). They must stay green after
   GREEN.
4. **RED (unit)** — new test/unit/application/primitives/read-sparse-config.test.ts.
   `describe('Given <local> and <worktree> with the extension <state>')` driven by
   `it.each` over the design's Test-strategy table (15 rows: R1, R13, R2, R3, R4, R5,
   R7, R8, R9, V1, D1, X1, subsection guard, upper-case `[CORE] SPARSECHECKOUT`,
   `sparseCheckout = bogus` ⇒ false/false), plus one row `true` then `bogus` in the
   worktree ⇒ enabled true (a refused value is skipped, matching the local leniency).
   Expected failure: module src/application/primitives/read-sparse-config.ts does not
   exist (import error).
5. **RED (unit)** — same file, linked worktree: the linked `config.worktree` sets sparse
   true/true and the main one does not ⇒ linked ctx true/true, main ctx false/false. Add
   the reverse case too (main sparse, linked not). Refused layout (untrusted) with the
   extension and worktree true/true ⇒ false/false and zero `readUtf8` calls on the
   config.worktree path. Expected failure: same missing module.
6. **GREEN** — create read-sparse-config.ts as specified in Context.
7. **RED (unit)** — read-sparse-checkout.test.ts: `Given the extension on and
   config.worktree setting sparseCheckout and sparseCheckoutCone true with a cone file`
   ⇒ `loadSparseMatcher` returns a matcher (`src/main.ts` included, `docs/readme.md`
   excluded). Expected failure: returns `undefined`, because `readConfig` sees no local
   sparse key.
8. **GUARD (unit)** — same file: `Given the extension off and config.worktree setting
   sparse true` ⇒ `undefined` (passes now and after GREEN).
9. **GREEN** — `loadSparseMatcher`: `const { enabled, cone } = await readSparseConfig(ctx);
   if (!enabled) return undefined;` and use `cone` as `coneRequested`. Remove the
   now-stale narrowing comment.
10. **REFACTOR** — run `npm run check:architecture` (depcruise `no-circular`:
    read-sparse-config.ts imports config-read.ts and config-scoped-read.ts, and
    config-scoped-read.ts must not import config-read.ts). Run the sparse regression
    suites listed in the Gate. Keep functions under 20 lines.

### Gate

```
./node_modules/.bin/vitest run test/unit/application/primitives/read-sparse-config.test.ts test/unit/application/primitives/read-sparse-checkout.test.ts test/integration/sparse-checkout-worktree-config-interop.test.ts test/integration/sparse-checkout-file-interop.test.ts test/integration/sparse-checkout.test.ts test/integration/sparse-reset-merge.test.ts test/integration/pack-sparse-interop.test.ts && rm -rf .wireit && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/read-sparse-config.ts src/application/primitives/read-sparse-checkout.ts test/unit/application/primitives/read-sparse-config.test.ts test/unit/application/primitives/read-sparse-checkout.test.ts test/integration/sparse-checkout-worktree-config-interop.test.ts && npm run check:spelling
```

### Commit

`fix(sparse-checkout): read the sparse keys from the worktree config layer`

## Part 2 — sparse-checkout verbs read the resolved pair; set keeps the mode; add writes no config

### Context

Pinned rows this part turns green, interop first: **R6, R7, R8, P-add, P-re (result
`cone`), A1, S1** (RED). GUARDs: **R9, B7, B8, S2**. Requirements 4 (list/add/reapply/set
mode reads), 6 (mode rule + "no write when sparse is on and no flag"), 9, 10 (casing
preserved by the new writer), ADR-1189 + decision D2.

Files this part creates or edits:
- `src/application/primitives/update-config.ts`
- `test/unit/application/primitives/update-config.test.ts`
- `src/application/commands/sparse-checkout.ts`
- `test/unit/application/commands/sparse-checkout.test.ts`
- `test/integration/sparse-checkout-worktree-config-interop.test.ts`

Current code (src/application/commands/sparse-checkout.ts):
- `sparseCheckoutList` (:91) reads `readConfig(ctx)` and `config.core?.sparseCheckout` /
  `sparseCheckoutCone`.
- `applyAndPersist(ctx, spec, text, force)` (:112) applies, writes the pattern file,
  then `updateCoreConfig(ctx, { sparseCheckout: 'true', sparseCheckoutCone: … })` for
  every caller.
- `sparseCheckoutSet` (:127): `useCone = input.cone ?? config.core?.sparseCheckoutCone ?? true`.
- `sparseCheckoutAdd` (:141) refuses `INVALID_OPTION` ('action', 'add requires sparse
  checkout to be enabled') on the local key only, and persists config through
  `applyAndPersist`.
- `sparseCheckoutReapply` (:159) reports `cone` from `readConfig`.
- `sparseCheckoutDisable` (:173): leave it UNCHANGED in this part (Part 3 rewrites it).
  It keeps `updateCoreConfig` as an importer.
- `buildSpecAndText` (:184) builds non-cone text with `patterns.join('\n')` (no final
  newline). `combineSpecAndText` (:200) builds non-cone text with
  `[existing, ...added].join('\n')`.
- `specToList(spec)` (:84) maps a no-cone spec to `rule.source` lines. Reuse it to read
  the existing patterns for D2.

Target:
- Every sparse-key read in this file goes through `readSparseConfig(ctx)` (Part 1,
  src/application/primitives/read-sparse-config.ts). Drop the `readConfig` import.
- set: `const sparse = await readSparseConfig(ctx);`
  `useCone = input.cone ?? (sparse.enabled ? sparse.cone : true)`;
  `recordMode = input.cone !== undefined || !sparse.enabled`.
- `applyAndPersist(ctx, spec, text, options)` with
  `options: { readonly force: boolean | undefined; readonly recordMode: boolean }` (an
  options record, not a boolean parameter). When `recordMode` is true it writes
  `core.sparseCheckout = true` and `core.sparseCheckoutCone = <true|false>` through
  `updateScopedConfigEntries(ctx, 'local', entries)`. Still the LOCAL file in this part:
  Part 3 retargets it. add passes `recordMode: false`.
- add: refuse on `!sparse.enabled` (same `invalidOption` arguments). The mode is
  `sparse.cone`.
- reapply: `toApplied((await readSparseConfig(ctx)).cone, applied)`.
- Non-cone text: a private `nonConeText(patterns) = patterns.map((p) => \`${p}\n\`).join('')`.
  set uses `nonConeText(input.patterns)`. add uses
  `nonConeText([...specToList(parseSparseCheckout(existing, false).spec).patterns, ...added])`.
  The spec is still `parseSparseCheckout(text, false).spec`, built from that text.

New writers in src/application/primitives/update-config.ts (both internal, NOT added
to src/application/primitives/index.ts):

```ts
/** Read-modify-write one config file at `path`, folding setConfigEntryInText over entries — caller's key casing kept. */
export const updateConfigFileEntries = async (ctx: Context, path: string, entries: ReadonlyArray<ConfigEntry>): Promise<void>
/** updateConfigFileEntries on the file `resolveConfigScopePath(ctx, scope)` names. */
export const updateScopedConfigEntries = async (ctx: Context, scope: ConfigScope, entries: ReadonlyArray<ConfigEntry>): Promise<void>
```

Model them on `updateConfigEntries` (:420). It reads with `readConfigText` (a missing
file reads as `''`), validates with `parseIniSectionsForWrite`, reduces
`setConfigEntryInText(text, e.section, e.subsection, e.key, e.value)`, then
`ctx.fs.writeUtf8`, `invalidateConfigCache(ctx)` and
`invalidateScopedConfigCache(ctx)`. REFACTOR `updateConfigEntries` to delegate to
`updateConfigFileEntries(ctx, \`${commonGitDir(ctx)}/config\`, entries)`. Its
behaviour is identical and its existing suite (update-config.test.ts:1589) is the guard.
Do NOT use `setConfigEntry`: `parseConfigKey` lowercases the name
(src/domain/commands/config-key.ts:89-93). `resolveConfigScopePath` is in
src/application/primitives/config-scoped-read.ts:186: `'local'` ⇒
`${commonGitDir}/config`, and `'worktree'` throws `CONFIG_SCOPE_NOT_AVAILABLE`
(`worktree-extension-unset`) while the extension is off.
`updateConfigFileEntries` exists for Part 3's `core.worktree` relocation (decision D1).
In this part its only importer is `updateScopedConfigEntries` / `updateConfigEntries`,
which is enough for knip because the use is in the same file.

Existing unit assertions that change (test/unit/application/commands/sparse-checkout.test.ts):
`readSparseFile` expectations at ~:403 (`'/src/'` ⇒ `'/src/\n'`), ~:586 (`'/src/\n/docs/'`
⇒ `'/src/\n/docs/\n'`), ~:603 (`'/docs/'` ⇒ `'/docs/\n'`). Config assertions still read
the local file in this part, and still pass. Helpers there: `seedRepoWithTree`,
`enableSparse(ctx, cone)` (overwrites the local config with true/<cone>), `readConfigText`,
`readSparseFile`, `expectError`. For worktree-layer seeding, add
`seedWorktreeSparse(ctx, text)`: append `[extensions]\n\tworktreeConfig = true\n` to the
local config, write `${gitDir}/config.worktree`, then call `invalidateConfigCache(ctx)`.

Interop shapes:
- R6: `set --cone b` on both. Compare tsgit `repo.sparseCheckout.list()` `{ cone, patterns }`
  with `git sparse-checkout list` lines (cone true, `['b']`). Then
  `git config --worktree core.sparseCheckoutCone false` on both, and compare again (cone
  false, `['/*', '!/*/', '/b/']`).
- R7 / R8 / R9: config shape by hand as in the design reader table, with the cone file.
  Compare `list`.
- P-add: `set --cone b` on both, then `add a` (git) / `repo.sparseCheckout.add({ patterns: ['a'] })`.
  Compare the config and config.worktree bytes (unchanged), the pattern-file bytes and
  the tag view.
- P-re: `set --cone b` on both, then `reapply`. tsgit result `cone === true`. Config
  bytes unchanged, tag view equal.
- A1: local `core.sparseCheckout true` only (extension off), pattern file `/b/\n`, then
  `add a`. Compare the config bytes (git leaves them unchanged), pattern bytes
  (`/b/\na\n`), no config.worktree on either side.
- B7 / B8: local true/true (extension off), `add a` / `reapply`. Config bytes unchanged,
  no config.worktree.
- S1: local true/false (extension off), `set /a/` with no flag. Config bytes unchanged,
  no config.worktree, pattern bytes `/a/\n`. S2: local true/true, `set a` with no flag.
  Config unchanged, pattern bytes equal.

### TDD steps

1. **RED (interop)** — R6 (both halves), R7, R8. Expected failure: tsgit `list` returns
   `{ cone: false, patterns: [] }`, because `sparseCheckoutList` reads only the local
   file.
2. **RED (interop)** — P-add: tsgit throws `INVALID_OPTION` ("add requires sparse
   checkout to be enabled"). P-re: tsgit's `cone` is `false`. A1: tsgit appends
   `sparseCheckoutCone = false` to the local config and writes `/b/\na` (no final
   newline). S1: the tsgit pattern file is `/a/`, with no newline.
3. **GUARD (interop)** — R9 (extension off ⇒ worktree file ignored), B7 / B8 (tsgit
   rewrites the same true/true bytes in place / reapply writes no config), S2 (same
   bytes in place). Each passes now. They must stay green: B7 and S2 then pass because
   no write happens at all.
4. **RED (unit, sparse-checkout.test.ts)** — `list` on a worktree-layer sparse repo
   reports the resolved `{ cone, patterns }`, and `reapply` reports `cone: true`. Both
   fail: the local read sees nothing (`list` ⇒ empty; `reapply` ⇒ `cone: false`).
   GREEN: route list/reapply/add/set reads through `readSparseConfig`.
5. **RED (unit)** — the set mode rule and the no-write rule, one test per branch:
   (a) not sparse, local `sparseCheckoutCone = false`, no flag ⇒ `result.cone === true`.
   Fails: the current code reuses the local `false`. (b) sparse on (local true/false), no
   flag ⇒ `cone: false` and NO `fs.writeUtf8` call on the config path (spy). Fails: the
   current code rewrites the same bytes in place, so the spy sees a write. (c) add on a
   local true/true repo ⇒ no `fs.writeUtf8` call on the config path. Fails: the current
   add persists config. GUARD (d): an explicit `cone` with sparse on ⇒ a config write
   happens. It passes now (every set writes) and pins the `input.cone !== undefined`
   half of `recordMode`. GREEN: the `recordMode` options record.
6. **RED (unit)** — non-cone bytes: set `['/src/']` ⇒ `'/src/\n'`. add over an existing
   `'/src/\n#c\n\n/x/'` ⇒ `'/src/\n/x/\n/docs/\n'` (D2). Fails: the current output
   has no newline / keeps the comment. Update the three existing expectations listed in
   Context. GREEN: `nonConeText`.
7. **RED (unit, update-config.test.ts)** — new `describe('updateScopedConfigEntries')`.
   (a) scope local on a fresh file, entries `core.sparseCheckout`, then
   `core.sparseCheckoutCone` ⇒ exact text `[core]\n\tsparseCheckout = true\n\tsparseCheckoutCone = true\n`
   (casing kept). (b) scope worktree with the extension on ⇒ writes
   `${gitDir}/config.worktree`, the local file unchanged. (c) scope worktree with the
   extension off ⇒ `CONFIG_SCOPE_NOT_AVAILABLE` with `scope: 'worktree'`,
   `reason: 'worktree-extension-unset'` (assert the `.data` fields that
   `configScopeNotAvailable` sets; check them in src/domain/commands/error.ts), and no
   file written. (d) linked ctx ⇒ writes `<gitDir>/worktrees/wt/config.worktree`.
   (e) the cache is invalidated: `getConfigValue({ ctx, key: 'core.sparsecheckout', scope: 'worktree' })`
   after the write returns the new value. Plus `describe('updateConfigFileEntries')`:
   writes to an arbitrary given path and keeps casing. Expected failure: the exports do
   not exist. GREEN: add both, switch `applyAndPersist` to
   `updateScopedConfigEntries(ctx, 'local', …)`, then REFACTOR `updateConfigEntries` to
   delegate.
8. **REFACTOR** — functions under 20 lines; `applyAndPersist` takes the options record;
   no unused imports (`readConfig` gone from sparse-checkout.ts). Run the regression
   suites in the Gate.

### Gate

```
./node_modules/.bin/vitest run test/unit/application/primitives/update-config.test.ts test/unit/application/commands/sparse-checkout.test.ts test/integration/sparse-checkout-worktree-config-interop.test.ts test/integration/sparse-checkout-file-interop.test.ts test/integration/sparse-checkout.test.ts test/integration/sparse-reset-merge.test.ts test/integration/pack-sparse-interop.test.ts test/parity/memory.test.ts && rm -rf .wireit && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/update-config.ts src/application/commands/sparse-checkout.ts test/unit/application/primitives/update-config.test.ts test/unit/application/commands/sparse-checkout.test.ts test/integration/sparse-checkout-worktree-config-interop.test.ts && npm run check:spelling
```

### Commit

`fix(sparse-checkout): resolve the mode per worktree and stop add from writing config`

## Part 3 — set and disable write the sparse keys to config.worktree

### Context

Pinned rows this part turns green, interop first: **B1, P-nc, P-pre, B2, B3, B4, B5, B6,
S3, S4, S6, P-dis, P-dis0, L3, W-dis, TS-set** (all RED: tsgit writes the local file
today). Requirements 6 (write target), 7, 8, 10; ADR-1188; decision D1.

Files this part creates or edits:
- `src/application/primitives/internal/enable-worktree-config.ts` (NEW)
- `test/unit/application/primitives/internal/enable-worktree-config.test.ts` (NEW)
- `src/application/commands/sparse-checkout.ts`
- `test/unit/application/commands/sparse-checkout.test.ts`
- `test/integration/sparse-checkout-worktree-config-interop.test.ts`

Target — enable-worktree-config.ts (internal):

```ts
export const enableWorktreeConfig = async (ctx: Context): Promise<void> => {
  if (await isWorktreeScopeActive(ctx)) return;
  await updateScopedConfigEntries(ctx, 'local', [EXTENSION_ENTRY]); // { section: 'extensions', key: 'worktreeConfig', value: 'true' }
  await relocateCoreWorktree(ctx);
};
const relocateCoreWorktree = async (ctx: Context): Promise<void> => {
  const { values } = await getAllConfigValues({ ctx, key: 'core.worktree', scope: 'local' });
  const value = values.at(-1)?.value; // git's config read: last wins
  if (typeof value !== 'string') return;
  await updateConfigFileEntries(ctx, `${commonGitDir(ctx)}/config.worktree`, [{ section: 'core', key: 'worktree', value }]);
  await unsetAllConfigEntries({ ctx, key: 'core.worktree', scope: 'local' });
};
```

This is git's `init_worktree_config` order: extension first, then the move, then the
local unset. `setConfigEntryInText` rewrites an existing `worktreeConfig = false` line
in place (B2), or appends `[extensions]\n\tworktreeConfig = true\n` (B1).
`core.repositoryformatversion` is never touched (B1 keeps 0, B4 keeps 1). There is no
`core.bare` branch: a bare repository cannot reach a sparse writer (`requireWorkTree`).
Decision D1 makes the relocation target `<commonDir>/config.worktree`. In the main
worktree that is the same file `set` then writes, which gives B3's
`[core]\n\tworktree = <dir>\n\tsparseCheckout = true\n\tsparseCheckoutCone = true\n`.

Building blocks (read-only): `isWorktreeScopeActive`, `getAllConfigValues` (:349,
returns `{ key, values: { value: string | null, scope }[] }`) in
src/application/primitives/config-scoped-read.ts; `updateScopedConfigEntries`,
`updateConfigFileEntries` (Part 2), `unsetAllConfigEntries` (:705, idempotent, no I/O
when absent) in src/application/primitives/update-config.ts; `commonGitDir` in
src/application/primitives/path-layout.ts.

Target — sparse-checkout.ts:
- `applyAndPersist` with `recordMode`: `await enableWorktreeConfig(ctx)`, then
  `updateScopedConfigEntries(ctx, 'worktree', sparseEntries(cone))`, where
  `sparseEntries(cone)` = `core.sparseCheckout = 'true'`,
  `core.sparseCheckoutCone = cone ? 'true' : 'false'`. One write of config.worktree
  (Decision 4 / ADR-1187).
- `sparseCheckoutDisable`: after `applySparseCheckout`,
  `await enableWorktreeConfig(ctx)`, then `updateScopedConfigEntries(ctx, 'worktree', DISABLE_ENTRIES)`
  = `core.sparseCheckout = 'false'`, `core.sparseCheckoutCone = 'false'`,
  `index.sparse = 'false'`, in that order (P-dis bytes:
  `[core]\n\tsparseCheckout = false\n\tsparseCheckoutCone = false\n[index]\n\tsparse = false\n`).
  The local file is left alone (S6 keeps the local `sparseCheckout = true`).
- Remove the `updateCoreConfig` import. `updateCoreConfig` stays exported from
  src/application/primitives/index.ts:113 (public primitive; removing it is an API
  break, out of scope), so knip stays green through the barrel.

Existing unit assertions that move to config.worktree
(test/unit/application/commands/sparse-checkout.test.ts): ~:382–383 (set cone),
~:406 (set non-cone), ~:424 (no cone flag), ~:483 (non-cone with cone-shaped
patterns), ~:622 (add cone-shaped: the value was written by the preceding `set`),
~:710 (disable ⇒ `sparseCheckout = false`). Add a helper
`readWorktreeConfigText = (ctx) => ctx.fs.readUtf8(\`${ctx.layout.gitDir}/config.worktree\`)`.
Make the assertions exact-byte where the design pins bytes (B1, P-dis), not
`toContain`. Capture the local text after `init` in Arrange and assert
`before + '[extensions]\n\tworktreeConfig = true\n'`.

Interop shapes (tsgit runs the writer on `ours`, git runs it on `peer`; compare the
`.git/config` and `.git/config.worktree` bytes; then compare the tag view and the
listing):
- B1 `set --cone b` fresh; P-nc `set --no-cone /b/`; P-pre (local true/false first);
  B2 (local `extensions.worktreeConfig false` first); B3 (local
  `core.worktree = <that side's own work dir>` first: substitute each side's path with a
  placeholder before comparing); B4 (`core.repositoryformatversion 1` first); B5
  (`set --cone b` then `set --no-cone /a/`); B6 (`set --cone b`, `disable`, `set b`);
  S3 (local sparse=true, then `set --cone a`); S4 (local cone=false, not sparse, then
  `set a` with no flag: config.worktree true/**true**, list ⇒ `['a']` cone); S6 (local
  sparse=true, then `disable`); P-dis (`set --cone b`, then `disable`; all `H`, all
  files); P-dis0 (`disable` on a never-sparse repo).
- L3: linked worktree `wt` on both sides; tsgit `set` (cone, `['b']`) opened inside
  `wt`, git `sparse-checkout set --cone b` inside the peer's `wt`. Compare
  .git/worktrees/wt/config.worktree and the common config bytes. Main has no
  config.worktree on either side. Then `git sparse-checkout list` in each MAIN worktree
  gives the same outcome (`tryRunGitWithExit`: exit code + stderr).
- W-dis: git `set --cone b` on both; then tsgit `disable` on ours / git `disable` on
  peer. Compare the bytes. Then on BOTH sides `git sparse-checkout list` (same exit
  code 128 and stderr, "this worktree is not sparse") and `git checkout -q other` (same
  tag view, all `H`).
- TS-set: tsgit `set` cone `['b']` on ours, git `set --cone b` on peer. Then
  `git checkout -q other` on both. Equal tag view (git reads what tsgit wrote:
  `S a/f S a/g H b/f H top`).

### TDD steps

1. **RED (interop)** — B1. Expected failure: tsgit's config.worktree does not exist,
   and the local config holds `sparseCheckout = true` / `sparseCheckoutCone = true`
   under `[core]` instead of `[extensions] worktreeConfig = true`.
2. **RED (interop)** — P-nc, P-pre, B2, B3, B4, B5, S3, S4, L3, TS-set. Same root
   cause: the write targets the local file. L3 also shows the shared file turning
   sparse on for main. TS-set: the tag view after git's `checkout other`
   already matches (git reads tsgit's local keys), so the row is RED on the config bytes
   only; assert both.
3. **RED (interop)** — P-dis, P-dis0, S6, B6, W-dis. Expected failure: tsgit appends
   `sparseCheckout = false` to the local file and leaves config.worktree untouched, so
   git stays sparse after W-dis (`list` ⇒ `b`, `checkout other` ⇒ `S a/f S a/g`).
4. **RED (unit, enable-worktree-config.test.ts)** — `sut = enableWorktreeConfig`; one
   test per step in isolation: (a) extension already on ⇒ no `writeUtf8` call at all
   (spy). (b) fresh local ⇒ local gains exactly `[extensions]\n\tworktreeConfig = true\n`,
   and no config.worktree is created. (c) local `worktreeConfig = false` ⇒ rewritten in
   place to `true`, no second `[extensions]`. (d) local `[core]` with `worktree = /w` ⇒
   `${commonDir}/config.worktree` = `[core]\n\tworktree = /w\n` and the local file no
   longer holds `worktree`. (e) two local `worktree` entries ⇒ the LAST one is moved
   and both are removed. (f) no `core.worktree` ⇒ no config.worktree write. (g) linked
   ctx with local `core.worktree` ⇒ written to `<commonDir>/config.worktree`, and
   `<commonDir>/worktrees/wt/config.worktree` is not created (D1). Expected failure:
   the module does not exist. GREEN: create the module.
5. **RED (unit, sparse-checkout.test.ts)** — set (cone) ⇒ exact config.worktree
   `[core]\n\tsparseCheckout = true\n\tsparseCheckoutCone = true\n` plus the local file
   = before + extension; set twice (cone, then non-cone) ⇒ `sparseCheckoutCone = false`
   rewritten in place; disable after set ⇒ the P-dis bytes; disable on a fresh repo ⇒
   the same three keys; disable with local sparse true ⇒ the local `sparseCheckout = true`
   is kept. Move the six existing assertions listed in Context. Expected failure: the
   config.worktree read throws `FILE_NOT_FOUND`, because tsgit wrote the local file.
   GREEN: the `applyAndPersist` / `sparseCheckoutDisable` changes.
6. **REFACTOR** — remove the `updateCoreConfig` import. Run `npm run check:dead-code`
   (knip) and `npm run check:architecture`. Run the parity and sparse regression suites
   in the Gate (the parity `sparse-checkout` scenario does set then list, now through
   config.worktree on the memory and node adapters).

### Gate

```
./node_modules/.bin/vitest run test/unit/application/primitives/internal/enable-worktree-config.test.ts test/unit/application/commands/sparse-checkout.test.ts test/integration/sparse-checkout-worktree-config-interop.test.ts test/integration/sparse-checkout-file-interop.test.ts test/integration/sparse-checkout.test.ts test/integration/sparse-reset-merge.test.ts test/integration/pack-sparse-interop.test.ts test/parity/memory.test.ts test/parity/node.test.ts && rm -rf .wireit && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/enable-worktree-config.ts src/application/commands/sparse-checkout.ts test/unit/application/primitives/internal/enable-worktree-config.test.ts test/unit/application/commands/sparse-checkout.test.ts test/integration/sparse-checkout-worktree-config-interop.test.ts && npm run check:spelling
```

### Commit

`fix(sparse-checkout): write the sparse keys to the worktree config`

## Part 4 — operational gate refuses a bad sparse boolean in config.worktree

### Context

Pinned rows this part turns green, interop first: **R10 (checkout and status), R12**
(RED). GUARDs: **O1, O2, R11, M1, O3**. Requirement 5 step 5; ADR-1185 (placement),
ADR-1186 (only the two sparse keys).

Files this part creates or edits:
- `src/application/primitives/internal/repo-state.ts`
- `test/unit/application/primitives/internal/repo-state-worktree-sparse.test.ts` (NEW)
- `test/integration/sparse-checkout-worktree-config-interop.test.ts`

Current code (src/application/primitives/internal/repo-state.ts):

```ts
export const assertOperationalRepository = async (ctx: Context): Promise<FilePath> => {   // ~:404
  await assertUsableHeadAndOpenEpoch(ctx);
  return await memoizeGateVerdict(ctx, computeGateVerdict);
};
export const assertOperationalRepositorySettingsFirst = async (ctx: Context): Promise<FilePath> => {   // ~:421
  await assertUsableHeadAndOpenEpoch(ctx);
  assertTrustedAndFormat(ctx, await assertDiscoveryAndRoot(ctx));
  await assertRepoSettingsValid(ctx);
  return await memoizeGateVerdict(ctx, computeGateVerdict);
};
```

Target: both become `const root = await memoizeGateVerdict(...); await assertWorktreeSparseBooleansValid(ctx); return root;`.
The check stays OUTSIDE the memo: the memo is keyed on the local file's mtime only.
`readSingleScope`'s own stat keeps the check fresh, and its `(session, gitDir)` bucket
keeps linked worktrees apart.

```ts
export const assertWorktreeSparseBooleansValid = async (ctx: Context): Promise<void> => {
  if (!(await isWorktreeScopeActive(ctx))) return;
  const sections = await readConfigSections({ ctx, scope: 'worktree' });
  // first [core] (no subsection) entry, file order, whose lowercased key is
  // sparsecheckout | sparsecheckoutcone and whose non-null value parseGitBoolean refuses:
  // throw configBadBooleanValue(<lowercased key>, resolveWorktreeScopePath(ctx, { active: true }), value)
};
```

- `isWorktreeScopeActive`, `readConfigSections` — src/application/primitives/config-scoped-read.ts.
  `isWorktreeScopeActive` returns false on a refused layout without reading, so an
  untrusted or format-refused repository reaches the memo's own refusal first and its
  worktree file is never parsed (ADR-679).
- `resolveWorktreeScopePath(ctx, { active: true })` —
  src/application/primitives/internal/config-scope.ts:51. Pure, it returns
  `${ctx.layout.gitDir}/config.worktree`. Use it for `source` so the path literal has one
  home.
- `parseGitBoolean` — src/domain/config/config-ini.ts:845. A valueless entry (`null`)
  is accepted.
- `configBadBooleanValue(key, source, value)` — src/domain/commands/error.ts:1221. It is
  already imported by repo-state.ts (`throwEagerCandidate`). The key is lowercased
  because git's message prints `core.sparsecheckout` / `core.sparsecheckoutcone`.
- The key set as a named constant (`WORKTREE_SPARSE_KEYS = ['sparsecheckout', 'sparsecheckoutcone']`).
  Do NOT reuse `CORE_BOOLEAN_KEYS`: it includes `ignorecase` (ADR-1186: only the sparse keys).
- Do NOT add the function to the deprecated shim
  src/application/commands/internal/repo-state.ts (internal; tests import from
  primitives/internal/repo-state.ts).
- Import-cycle check: repo-state.ts → config-scoped-read.ts must not close a cycle. Run
  `npm run check:architecture`.

Unit test fixtures: copy the `seedRepo` (writes HEAD) and `seedConfig` helpers from
test/unit/application/commands/internal/repo-state.test.ts:23-29 into the new file. Add
`seedWorktreeConfig`. `withFormatRefusal` (same file :37) is the refused-layout
precedent. `sut` = the function under test (`assertWorktreeSparseBooleansValid`,
`assertOperationalRepository`, `assertOperationalRepositorySettingsFirst`).

Interop shapes (git prepares on both, then tsgit status/checkout vs git's; use
`tryRunGitWithExit` for git's exit code + stderr). Open tsgit AFTER planting the shape;
for M1/O3 the `openRepository` call itself is the refusal under test:
- R10: extension on; config.worktree `[core]\n\tsparseCheckout = bogus\n`. git
  `checkout other` and `status` ⇒ exit 128, stderr contains
  `bad boolean config value 'bogus' for 'core.sparsecheckout'`. tsgit `repo.checkout({ rev: 'other' })`
  and `repo.status()` ⇒ `CONFIG_BAD_BOOLEAN_VALUE`, with `data.key === 'core.sparsecheckout'`,
  `data.value === 'bogus'` and `data.source` ending in /.git/config.worktree.
- R12: sparse = true, `sparseCheckoutCone = bogus` ⇒ key `core.sparsecheckoutcone`.
- O1: local `sparseCheckout = bogus1` + worktree `sparseCheckout = bogus2` ⇒ both name
  `'bogus1'`, with the tsgit `source` ending in /.git/config. O2: local
  `sparseCheckoutCone = bogus1` + worktree `sparseCheckout = bogus2` ⇒ both name
  `core.sparsecheckoutcone` / `bogus1`.
- R11: extension off + worktree `sparseCheckout = bogus` ⇒ git and tsgit `checkout other`
  succeed; all `H` tag view.
- M1 / O3: extension on + config.worktree `[core` (O3 also has local
  `sparseCheckout = bogus1`) ⇒ git exit 128 with `bad config line 1 in file .git/config.worktree`.
  tsgit `openRepository` throws `CONFIG_PARSE_ERROR` with `line: 1` and `source` ending
  in /.git/config.worktree.

### TDD steps

1. **RED (interop)** — R10 (checkout and status as two `it`s), R12. Expected failure:
   tsgit `checkout` / `status` resolve (no throw), because no gate step reads
   config.worktree. (After Part 1 the lenient reader simply skips `bogus`.)
2. **GUARD (interop)** — O1, O2 (the local eager gate already refuses first), R11
   (extension off), M1 / O3 (`readRepositoryFormat` refuses at open). Each passes now
   and must stay green.
3. **RED (unit, repo-state-worktree-sparse.test.ts)** — `sut = assertWorktreeSparseBooleansValid`.
   Separate tests for each condition: (a) bad `sparseCheckout` ⇒ `.data` =
   `{ code: 'CONFIG_BAD_BOOLEAN_VALUE', key: 'core.sparsecheckout', source: \`${gitDir}/config.worktree\`, value: 'bogus' }`.
   (b) bad `sparseCheckoutCone` alone ⇒ key `core.sparsecheckoutcone`. (c) both bad ⇒
   the first in file order. (d) valueless `sparseCheckout` ⇒ resolves. (e) bad value
   under `[core "x"]` ⇒ resolves. (f) bad `ignoreCase` in config.worktree ⇒ resolves
   (ADR-1186). (g) extension off + bad value ⇒ resolves. (h) refused layout (untrusted)
   + extension + bad value ⇒ resolves with zero reads of config.worktree. (i) upper-case
   `[CORE] SPARSECHECKOUT = bogus` ⇒ refuses with the lowercased key. Expected
   failure: the export does not exist. GREEN: add the function.
4. **RED (unit)** — `sut = assertOperationalRepository`: (a) a settled verdict (the
   first call passes), then config.worktree rewritten raw to a bad value in the same
   session ⇒ the next call refuses (freshness outside the memo). (b) config.worktree
   rewritten to `[core` after a passing call ⇒ `CONFIG_PARSE_ERROR` with `line: 1` and
   `source` = the worktree path. (c) local bad value + worktree bad value ⇒ the local one
   is named (O1 at unit level). (d) linked ctx: bad value in the linked worktree file
   only ⇒ the linked ctx refuses and the main ctx passes (if the full entry point cannot
   be driven on a linked memory ctx, pin (d) on `assertWorktreeSparseBooleansValid`
   directly and say so in the test's Arrange comment). `sut = assertOperationalRepositorySettingsFirst`:
   (e) worktree bad value ⇒ refuses with the worktree source. Expected failure: the
   operational entry points resolve. GREEN: wire the call after `memoizeGateVerdict` in
   both.
5. **REFACTOR** — `npm run check:architecture`. Then run the wider suites every
   operational command passes through:
   `./node_modules/.bin/vitest run test/unit/application/commands test/unit/repository > <scratchpad>/p4-sweep.log 2>&1`,
   and read back only the failures. A failure that counts `stat` / `readUtf8` calls on
   the local config (the new `isWorktreeScopeActive` read adds one cached-scope stat per
   operational command; design "Cost") is a blocker: escalate it as
   `{ unit, reason, ≤3 options }` and do not loosen the count silently.

### Gate

```
./node_modules/.bin/vitest run test/unit/application/primitives/internal/repo-state-worktree-sparse.test.ts test/unit/application/commands/internal/repo-state.test.ts test/unit/application/primitives/internal/repo-state.test.ts test/integration/sparse-checkout-worktree-config-interop.test.ts test/integration/config-boolean-interop.test.ts test/integration/sparse-checkout.test.ts test/integration/sparse-reset-merge.test.ts && rm -rf .wireit && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/repo-state.ts test/unit/application/primitives/internal/repo-state-worktree-sparse.test.ts test/integration/sparse-checkout-worktree-config-interop.test.ts && npm run check:spelling
```

### Commit

`fix(sparse-checkout): refuse a bad sparse boolean in the worktree config`
