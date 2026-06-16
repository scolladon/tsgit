# Plan — remaining-valueless-refusal

> Source: design doc `docs/design/remaining-valueless-refusal.md` · ADRs 346, 347 (amended), 348, 349
> The plan is the implementation script AND the knowledge handoff. Slice agents start
> with zero context: whatever a slice block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

## Sizing rules

- Every slice costs a full agent lifecycle (spin-up, zero-context rebuild, gate) — it
  must earn it. No standalone test-only slices: coverage/interop/property tests fold
  into the implementation slice whose code they exercise.
- A slice that would be a pure test pass over already-landed code merges into its
  neighbour.

## Surface decision (read before slicing — pre-paid here, do not re-litigate per slice)

NO public surface gate is tripped by this change. `CONFIG_MISSING_VALUE` already exists
(24.9l, `src/domain/commands/error.ts` `configMissingValue(key, source, line)`) — **no new
error code, no exhaustiveness switch, no barrel-surface test change**. `ParsedConfig`
(`src/application/primitives/config-read.ts`) is UNCHANGED. The three NEW symbols are all
**INTERNAL** (consumed only within `src/`):

- `findFirstValuelessInSection` + `assertNoValuelessInSection` — Slice 1, in
  `src/application/primitives/config-read.ts`. Barrel them from
  `src/application/primitives/index.ts` (alongside the existing `findFirstValuelessEntry`
  export, lines 13-18) because commands in slices 3 & 5/6/7 import across the primitives
  boundary. A primitives-barrel entry is INTERNAL — it does NOT touch the package entry
  (`src/index.ts` / `src/index.node.ts`), so it trips **no** `reports/api.json` /
  `check:doc-coverage` / `audit-browser-surface` / facade gate.
- `assertNoValuelessCoreConfig` — Slice 4, in
  `src/application/commands/internal/valueless-config-guard.ts`. INTERNAL helper next to
  the existing `assertNoValuelessConfig`; consumed only by command modules. Not barrelled
  from `commands/index.ts` (internal helpers are not re-exported there — confirm: the
  barrel exports commands + namespace binders + types, never `internal/*` guards).

Do NOT run `npm run docs:json` or touch `reports/api.json` in any slice. If a slice's
gate (`check:types`) or the phase-boundary `npm run validate` surfaces an api.json diff,
that is a signal something was wrongly exported from the package entry — fix the export,
do not regenerate the report.

## Shared conventions (apply in EVERY slice — do not re-derive)

- **Tests:** `describe('Given <ctx>')` > `describe('When <action>')` > `it('Then <expected>')`,
  AAA body with `// Arrange` / `// Act` / `// Assert` comments, `sut` = the function/object
  under test (NOT the result — result goes in `result`). 100% line/branch/function/statement;
  target 0 surviving mutants.
- **Error assertions are mutation-resistant:** assert `.data` fields INDIVIDUALLY via
  try/catch (`data.code`, `data.key`, `data.line`, `data.source`) — NEVER bare
  `toThrow(Class)` and never `toThrow(expect.objectContaining(...))`. Pattern to copy
  verbatim: `test/integration/missing-value-refusal-interop.test.ts` lines 106-125.
- **Guard clauses get ISOLATED tests** (one condition each). File-order/all-subsection
  discriminator tests are SEPARATE `it`s from single-key tests (kill fixed-key /
  fixed-subsection mutants).
- **No phase/ADR/backlog refs** inside any source or test code — the commit is the join point.
- **Serena is the default editor** (already activated; do NOT `activate_project`). Use
  `find_symbol` / `insert_after_symbol` / `replace_symbol_body` for TS edits; run
  `get_diagnostics_for_file` after each source edit. `Read`/`Grep` only for non-code or a
  literal scan. Diagnostics are advisory; ground truth is the gate.
- **Interop fixtures:** git's CLI cannot emit a valueless key — write the valueless line
  by `writeFile` into `<tmp>/.git/config`. Run real git via `interop-helpers.ts`
  (`runGit` / `tryRunGit` / `runGitEnv`, scrubbed `GIT_*`, isolated HOME,
  `GIT_CONFIG_NOSYSTEM=1`). Reconstruct git's two lines from `{ key, source, line }`,
  normalising the `file '<F>'` token to repo-relative `.git/config` (`key`/`line`
  verbatim). Copy the reconstruction block from the existing interop test lines 155-171.

---

## Slice 1 — `findFirstValuelessInSection` + `assertNoValuelessInSection` (subsection-wildcard scan primitive)

### Context

This is the new primitive §0 of the design — the dependency for slices 3 (branch) and 7
(merge). It is a subsection-WILDCARD sibling of the existing exact-subsection
`findFirstValuelessEntry`.

- **Add the primitive in** `src/application/primitives/config-read.ts`. The existing
  exact-subsection function is `findFirstValuelessEntry` (lines 122-150); its helper
  `matchesSection` (lines 106-112) does
  `tokenSection.toLowerCase() === section.toLowerCase() && tokenSubsection === subsection`
  (the `=== subsection` clause is the exact-match filter the new helper must DROP). The
  token loop, `keySet`, `inSection`, `qualifiedKey` shape are all visible there — mirror
  them. `ValuelessEntry` interface (lines 100-104): `{ key; source; line }`. `commonGitDir`
  imported from `./path-layout.js`. `readRawConfig` (lines 91-98) and `tokenizeConfig`
  (line 278) already exist — reuse, do not re-add.
- **New `findFirstValuelessInSection(ctx, section, keys)`** — signature is `findFirstValuelessEntry`
  MINUS the `subsection` param. Iterate the same token stream. Match a header when
  `tokenSection.toLowerCase() === section.toLowerCase()` (ignore `tokenSubsection`
  entirely — ANY subsection of `section` matches, including the no-subsection `[merge]`
  form, though merge/branch are always subsectioned in practice). On a valueless
  (`token.value === null`) entry whose lower-cased key is in the set, build
  `qualifiedKey` as `${loweredSection}.${tokenSubsection}.${loweredKey}` when the matched
  header has a subsection, else `${loweredSection}.${loweredKey}` — **subsection kept
  verbatim** (e.g. `branch.Main.merge`, `merge.custom.driver`). Capture the matched
  header's subsection in a local while iterating (it changes per header). Return
  `{ key, source: path, line: token.startLine + 1 }` or `undefined`. Reports the FIRST by
  file line.
- **New thin wrapper `assertNoValuelessInSection(ctx, section, keys)`** in
  `src/application/commands/internal/valueless-config-guard.ts` — copy the body of the
  existing `assertNoValuelessConfig` (lines 12-20) exactly, swapping the call to
  `findFirstValuelessInSection(ctx, section, keys)` and dropping the `subsection` param.
  Import `findFirstValuelessInSection` from `../../primitives/config-read.js` next to the
  existing `findFirstValuelessEntry` import (line 3).
- **Barrel** `findFirstValuelessInSection` from `src/application/primitives/index.ts`
  (extend the `findFirstValuelessEntry` export block, lines 13-18). INTERNAL — see the
  surface decision above; no public gate.
- **Unit tests** go in `test/unit/application/primitives/config-read.test.ts`, in a NEW
  `describe('Given a config with valueless/valued entries', () => describe('When findFirstValuelessInSection', ...))`
  block placed right after the existing `findFirstValuelessEntry` block (which ends near
  line 3849). Reuse the file's `seed(ctx, content)` helper (writes
  `${ctx.layout.gitDir}/config`) and `createMemoryContext` — both already imported at the
  top. Mirror the `findFirstValuelessEntry` test shape (lines 3629-3848): `sut =
  findFirstValuelessInSection`, `await seed(...)`, assert `result?.key` / `result?.line` /
  `result?.source`.
- **Pinned behaviour to reproduce** (design matrix B4/B7b, M4): key lower-cased,
  subsection verbatim; first valueless by file line across ALL subsections; empty-string
  (`= `) is NOT valueless (`value === null` only).

### TDD steps

RED — add to `config-read.test.ts` (each `it` fails: `findFirstValuelessInSection` does
not yet exist → import/type error, then undefined-not-a-function):
1. `Given [branch "main"]\n merge (valueless) only, When findFirstValuelessInSection(ctx,'branch',['merge','remote'])` →
   `Then key === 'branch.main.merge'`, `line === 2`, `source === ${gitDir}/config`. (single valueless, single subsection)
2. `Given [branch "a"] merge (line m) and [branch "b"] merge (line n>m) both valueless` →
   `Then reports 'branch.a.merge' at line m` (all-subsections file-order discriminator —
   kills a fixed-subsection / current-subsection mutant; B7b).
3. `Given [branch "b"] merge valueless under a non-current subsection, with NO other branch section` →
   `Then reports 'branch.b.merge'` (proves the scan is subsection-agnostic — B7).
4. `Given a valueless key under a NON-matching section ([other] merge)` → `Then undefined`
   (section negative scoping; isolated from the subsection cases).
5. `Given [branch "main"] merge = x (empty-string via "merge = ")` → `Then undefined`
   (null-only; kills a `value !== undefined` mutant). Note: `merge = ` parses to `''`, a
   distinct valued state; use `'[branch "main"]\n\tmerge = \n'`.
6. `Given [branch "Main"] Merge (valueless, mixed case)` → `Then key === 'branch.Main.merge'`
   (section+key lower-cased, subsection verbatim — B4; SEPARATE from the lower-case cases).
7. `Given [branch "main"] remote (valueless), merge valued` →
   `Then key === 'branch.main.remote'` (the other key in the set is reachable).
8. `Given a valueless target key before any section header` → `Then undefined`
   (`inSection` starts false — mirror the existing line-3821 test).
9. `Given a valueless NON-target key under a matching section ([branch "main"] foo)` →
   `Then undefined` (`keySet` filter — mirror the existing line-3836 test).
10. `Given missing config file` and `Given empty config ('')` → `Then undefined` (mirror
    existing lines 3672/3685).

GREEN — implement `findFirstValuelessInSection` in `config-read.ts` (subsection-wildcard
loop, verbatim-subsection qualifiedKey) and `assertNoValuelessInSection` in
`valueless-config-guard.ts`; add the primitives-barrel export.

REFACTOR — factor the shared `matchesSection`-without-subsection check if it reads
cleanly, but DO NOT touch the existing `findFirstValuelessEntry` / `matchesSection`
(exact-subsection consumers `remote`/`user`/`core` still depend on the `=== subsection`
clause). Keep functions <20 lines, early returns, no nesting >2. No tests for
`assertNoValuelessInSection` itself in this slice — it is a one-line wrapper exercised
end-to-end in slices 3 & 7 (its `findFirstValuelessInSection` core is fully covered here).

### Gate

`npx vitest run test/unit/application/primitives/config-read.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/config-read.ts src/application/primitives/index.ts src/application/commands/internal/valueless-config-guard.ts test/unit/application/primitives/config-read.test.ts`

### Commit

`feat(config): subsection-wildcard valueless scan primitive`

---

## Slice 2 — `remote.*.pushUrl` eager guard at push + fetch

### Context

Extends 24.9l's exact-subsection `url` guard to `['url','pushurl']`, fired EAGERLY (before
the `url === undefined` branch) at BOTH resolveRemoteUrl sites. Independent of slice 1
(uses the existing exact-subsection `assertNoValuelessConfig`). Pins P1-P5.

- **push.ts** `resolveRemoteUrl` (`src/application/commands/push.ts` lines 148-163). Today:
  builds `const remote = config.remote?.get(remoteName)` (line 153), `const url =
  remote?.pushUrl ?? remote?.url` (line 155), then INSIDE `if (url === undefined)` (line
  156) calls `await assertNoValuelessConfig(ctx, 'remote', remoteName, ['url'])` (line 159)
  before `throw remoteNotConfigured(remoteName)`. CHANGE: move the guard OUT of the
  `if (url === undefined)` block to fire right after line 153 (after
  `config.remote?.get(remoteName)`), and extend its key list to `['url', 'pushurl']`.
  Inside the `if (url === undefined)` block, keep only `throw remoteNotConfigured(remoteName)`.
  REMOVE the two-line comment "Only a valueless `url` ... not yet in scope (no pinned
  matrix row for it)." (lines 157-158). `assertNoValuelessConfig` is already imported
  (push.ts line 51).
- **fetch.ts** `resolveRemoteUrl` (`src/application/commands/fetch.ts` lines 135-154).
  Today: `const remote = config.remote?.get(remoteName)` (line 140), then INSIDE
  `if (remote?.url === undefined || remote.url === '')` (line 142) calls
  `await assertNoValuelessConfig(ctx, 'remote', remoteName, ['url'])` (line 143). CHANGE:
  move the guard OUT to fire right after line 140 with key list `['url', 'pushurl']`; keep
  the `if (...)` block's `throw remoteNotConfigured(remoteName)` (and leave the empty-url
  branch untouched — a valued-but-empty url is not valueless). `assertNoValuelessConfig`
  already imported (fetch.ts line 46).
- **Why fetch's list includes `pushurl`** even though fetch never uses that URL: P1/P5 pin
  that `git fetch origin` ALSO dies on a valueless `pushurl`. The guard list is a faithful
  validation surface, not a functional read.
- **Why eager:** P5 — valued `url` + valueless `pushurl` dies on BOTH commands; the old
  placement (inside `url === undefined`) skips entirely when a usable url is present.
- **Unit tests** extend `test/unit/application/commands/push.test.ts` and
  `test/unit/application/commands/fetch.test.ts`. Existing valueless-url describe blocks:
  push.test.ts lines 269-301 (`Given a remote with a valueless url entry`, `Given a remote
  with a valueless url but a valued pushurl` at 302-332); fetch.test.ts lines 195+
  (`Given a remote with a valueless url entry`). Mirror their fixture-seeding style
  (`'[remote "origin"]\n\turl\n...'` written to config) and their individual-`.data`-field
  assertions. NOTE: push.test.ts line 302-332 currently asserts "valueless url + valued
  pushurl → resolves via pushurl, does NOT throw" — under the new eager guard the
  valueless `url` STILL throws `CONFIG_MISSING_VALUE` (P3: url earlier → url). That
  expectation must be UPDATED: with `url` (line 2, valueless) before `pushurl` (line 3,
  valued), the guard now throws `remote.origin.url`. Adjust that test, do not delete it.

### TDD steps

RED — push.test.ts + fetch.test.ts:
1. push: `Given valueless pushurl with valued url, When push` → `Then CONFIG_MISSING_VALUE
   { key:'remote.origin.pushurl', line }` (P1/P5 — the decisive "valued url still dies"
   test; kills the "guard inside url===undefined" mutant). Fixture:
   `'[remote "origin"]\n\turl = /tmp/x\n\tpushurl\n'` (pushurl valueless at line 3).
2. fetch: same fixture, `When fetch` → same throw (P5 — fetch dies on pushurl too).
3. push: `Given both url and pushurl valueless, pushurl EARLIER` → `Then key
   'remote.origin.pushurl'`; push: `both valueless, url earlier` → `Then key
   'remote.origin.url'` (P2/P3 discriminator pair — SEPARATE `it`s).
4. push: `Given pushurl-only valueless (no url)` → `Then 'remote.origin.pushurl'` (P4).
5. push + fetch: `Given absent url and pushurl` → `Then REMOTE_NOT_CONFIGURED and NOT
   CONFIG_MISSING_VALUE` (regression — existing tests at push.test.ts 250-265,
   fetch.test.ts 173-190 must still pass; add/keep).
6. UPDATE push.test.ts 302-332: valueless url + valued pushurl now throws
   `CONFIG_MISSING_VALUE { key:'remote.origin.url' }` (eager guard fires on the
   first-by-line valueless key). The "resolves via pushurl" path is proven instead by a
   fixture where url is VALUED and pushurl valued — keep that as a separate resolves case.

GREEN — move both guards out of their `url === undefined` blocks; extend both key lists to
`['url', 'pushurl']`; remove the stale push comment.

REFACTOR — confirm the absent-url path still throws `remoteNotConfigured`; ensure no
duplicated guard call. Keep both `resolveRemoteUrl` bodies small.

INTEROP — extend `test/integration/missing-value-refusal-interop.test.ts`. Add a fixture
`VALUELESS_PUSHURL_VALUED_URL_FIXTURE = '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = /tmp/nonexistent\n\tpushurl\n'`
(pushurl valueless at line 5). Add: (P5) `git push origin main` AND `git fetch origin`
both exit 128 reporting `remote.origin.pushurl` at line 5, vs tsgit `push`/`fetch` throwing
`CONFIG_MISSING_VALUE { key:'remote.origin.pushurl', line:5 }`; reconstruct + compare the
two lines (copy the reconstruction block from lines 401-440). Add the P3 row (both
valueless, url earlier → `url`) for one of push/fetch. Reuse `runGitEnv` / `tryRunGit` /
`openRepository`.

### Gate

`npx vitest run test/unit/application/commands/push.test.ts test/unit/application/commands/fetch.test.ts test/integration/missing-value-refusal-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/push.ts src/application/commands/fetch.ts test/unit/application/commands/push.test.ts test/unit/application/commands/fetch.test.ts test/integration/missing-value-refusal-interop.test.ts`

### Commit

`fix(push): refuse a valueless remote pushUrl on push and fetch`

---

## Slice 3 — `branch.*.merge`/`remote` eager guard in `pull`

### Context

Depends on Slice 1 (`assertNoValuelessInSection`). Eager all-`[branch *]` guard as the
FIRST config-touching step of `pull`. Pins B1/B6/B7/B7b/B8.

- **pull.ts** `pull` (`src/application/commands/pull.ts` lines 91-129). Today the preamble
  is: `await assertRepository(ctx)` (92); `await assertNotBare(ctx, 'pull')` (93);
  `await assertNoPendingOperation(ctx)` (94); then `const head = await readHeadRaw(ctx)`
  (96) → `resolveUpstream(...)` (99) → `fetch(...)` (101). INSERT
  `await assertNoValuelessInSection(ctx, 'branch', ['merge', 'remote'])` as a NEW line
  immediately after line 94 (after `assertNoPendingOperation`), BEFORE `readHeadRaw` /
  `resolveUpstream` / `fetch`. This placement reproduces B8 (die before any network) and
  B1/B6 (dies on `pull origin main` and detached HEAD, because the guard runs regardless
  of `opts.ref` / `currentBranch`).
- **Import** `assertNoValuelessInSection` from `./internal/valueless-config-guard.js`
  (pull.ts currently imports from `../primitives/config-read.js` line 15 and
  `./internal/repo-state.js` lines 18-23; add the new import line).
- `resolveUpstream` (lines 75-89) reads only `config.branch?.get(currentBranch)` and only
  when `opts.ref` absent — that narrow read is WHY the guard must be eager (B7/B7b: a
  valueless `branch.other.merge` dies even on `main` with no `[branch "main"]`). Do NOT
  change `resolveUpstream`; the eager guard precedes it.
- **Absent case unaffected:** a fully-absent `[branch "<cur>"]` makes the guard return
  normally, and `resolveUpstream` still throws `NO_UPSTREAM_CONFIGURED`
  (`noUpstreamConfigured`, imported pull.ts line 12).
- **Unit tests** extend `test/unit/application/commands/pull.test.ts`. The file's existing
  describe blocks: `pull` (line 110); `Given explicit remote and branch arguments` (268);
  `Given no upstream configuration and no explicit branch` (324); `Given a detached HEAD
  and no explicit branch` (352); `Given a bare repository` → "throws before issuing any
  fetch" (378-405); `Given an in-progress merge` → "throws OPERATION_IN_PROGRESS before
  any fetch" (407+). These show the pattern for asserting a guard fires before fetch (the
  bare/pending tests assert no fetch was issued). Mirror that to prove B8. The pull tests
  build real repos via the memory/node helpers (not a fetch mock) — inspect the file's
  setup helpers (top of file) and reuse them; seed the valueless `[branch *]` config via
  `ctx.fs.writeUtf8(${gitDir}/config, ...)`.
- **B8 ordering proof:** the existing bare-repo test (line 380 "throws before issuing any
  fetch") demonstrates how the suite asserts fetch was not reached — replicate that
  assertion shape (e.g. a remote that would fail on contact, or asserting the thrown code
  is `CONFIG_MISSING_VALUE` not a network error) for the valueless-branch case.

### TDD steps

RED — pull.test.ts (each fails: guard not yet present → pull proceeds past it):
1. `Given valueless branch.<cur>.merge, When pull (no args)` → `Then CONFIG_MISSING_VALUE
   { key:'branch.main.merge', line, source }` (B1).
2. `Given valueless branch.<cur>.remote (merge valued), When pull` → `Then key
   'branch.main.remote'` (B2; separate key).
3. `Given valueless branch.other.merge while on main with NO [branch "main"], When pull` →
   `Then key 'branch.other.merge'` (B7 — proves all-subsections; kills a current-branch-only
   mutant).
4. `Given two valueless branch sections, [branch "zzz"] merge earlier than [branch "main"]
   merge, When pull` → `Then key 'branch.zzz.merge' at the earlier line` (B7b file-order
   discriminator).
5. `Given valueless branch.<cur>.merge AND a remote that would fail on network, When pull` →
   `Then throws CONFIG_MISSING_VALUE (NOT a fetch/network error) and fetch was not reached`
   (B8 — the guard fires before network; mirror the bare-repo "before any fetch" assertion
   at line 380).
6. `Given valueless branch.<cur>.merge with HEAD detached, When pull origin main` → `Then
   CONFIG_MISSING_VALUE` (B6 — eager even detached / explicit args).
7. `Given absent [branch "<cur>"] (no tracking), When pull` → `Then NO_UPSTREAM_CONFIGURED
   and NOT CONFIG_MISSING_VALUE` (regression — absent stays today's behaviour).

GREEN — insert the single `assertNoValuelessInSection(ctx, 'branch', ['merge','remote'])`
line after `assertNoPendingOperation` and add the import.

REFACTOR — none expected; confirm the line sits before `readHeadRaw`.

INTEROP — extend `missing-value-refusal-interop.test.ts`. Fixtures (line numbers chosen so
the valueless key's line is deterministic): (B1)
`'[core]\n\trepositoryformatversion = 0\n[branch "main"]\n\tmerge\n'` (merge valueless line
4); (B7) `'[core]\n\trepositoryformatversion = 0\n[branch "other"]\n\tremote = origin\n\tmerge\n'`
on `main` (merge valueless line 5). Init the repo on `-b main`, write the fixture, run
`git pull` (it dies on config before network) vs tsgit `repo.pull(...)`; assert both exit
128 / throw `CONFIG_MISSING_VALUE` with the matching key+line; reconstruct + compare lines.
For B7b add a two-valueless-section fixture asserting the earlier line is reported. Use
`repo.pull` via `openRepository`.

### Gate

`npx vitest run test/unit/application/commands/pull.test.ts test/integration/missing-value-refusal-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/pull.ts test/unit/application/commands/pull.test.ts test/integration/missing-value-refusal-interop.test.ts`

### Commit

`fix(pull): refuse a valueless branch merge or remote eagerly`

---

## Slice 4 — `assertNoValuelessCoreConfig` helper + read/inspect family

### Context

The `core` eager guard (§3, ADR-348) has the LARGEST surface (~80 command functions). This
slice ships the helper and proves it on the read/inspect command family; slices 5 & 6 wire
the remaining families. Uses the EXISTING exact-subsection `assertNoValuelessConfig`
(core is flat, no subsection) — independent of slice 1. Pins C1/C3/C4/C5-C9/C10/C11.

- **New helper** in `src/application/commands/internal/valueless-config-guard.ts` (sibling
  of `assertNoValuelessConfig`, lines 12-20):
  `export const assertNoValuelessCoreConfig = (ctx: Context): Promise<void> =>
   assertNoValuelessConfig(ctx, 'core', undefined, ['excludesfile', 'attributesfile', 'hookspath'])`.
  `Context` already imported (line 2). Keys are LOWER-CASE (git reports lower-case —
  C1; `findFirstValuelessEntry` already case-folds the file key, the LIST entries are the
  match set and must be lower-case to match the lower-cased file key).
- **`assertRepository`** is defined in `src/application/primitives/internal/repo-state.ts`
  and re-exported via `src/application/commands/internal/repo-state.ts` (the shim). Every
  in-scope command already imports `assertRepository` (and friends) from
  `./internal/repo-state.js`. The guard slots in IMMEDIATELY AFTER the existing
  `await assertRepository(ctx)` call in each command body (so a non-repo still throws
  `NOT_A_REPOSITORY` first — git also errors on no-repo before the config die).
- **Read/inspect family for THIS slice** (file : function : `assertRepository` line):
  - `status.ts` : `status` : 114
  - `log.ts` : `log` : 43
  - `show.ts` : `show` : 104
  - `diff.ts` : `diff` : 33
  - `blame.ts` : `blame` : 118
  - `cat-file.ts` : `catFile` : 39
  - `rev-parse.ts` : `revParse` : 31
  - `reflog.ts` : `reflog` : 66
  - `describe.ts` : `describe` : 99
  - `shortlog.ts` : `shortlog` : 40
  - `whatchanged.ts` : `whatchanged` : 44
  - `name-rev.ts` : `nameRev` : 58
  - `range-diff.ts` : `rangeDiff` : 122
  - `read-file-at.ts` : `readFileAt` : 47
  In each, add `import { assertNoValuelessCoreConfig } from './internal/valueless-config-guard.js';`
  (some already import `assertRepository` from `./internal/repo-state.js` — add the guard
  import alongside) and `await assertNoValuelessCoreConfig(ctx);` right after the
  `assertRepository(ctx)` line. Verify each line number with Serena `find_symbol` before
  editing (line numbers are from reconnaissance, not authoritative after prior slices'
  edits — though slices 1-3 do not touch these files).
- **Grouping justification:** the read/inspect family is the cleanest proving ground — all
  14 call `assertRepository`, none mutate, and `status` is the C1 representative the design
  names. Wiring them together (one guard import + one call each) keeps the slice
  reviewable (~14 two-line edits + the helper) while exercising the helper end-to-end.
- **null-only (C10):** `findFirstValuelessEntry` matches `value === null`, so empty-string
  / absent `core.*` fall through with no regression. Do not add any empty/absent handling —
  it is correct by construction; pin it with a test.
- **config/init/clone EXEMPT:** do NOT add the guard to `config.ts` (any `config*`
  function — C2/C11: porcelain config must stay non-throwing), `init.ts`, or `clone.ts`.
- **Unit tests:** add a focused test for the helper + the C2/C11 porcelain-exemption +
  one representative read command. Helper tests can live in a new
  `test/unit/application/commands/internal/valueless-config-guard.test.ts` (create it) OR
  fold into `status.test.ts` — prefer a dedicated guard test file for the helper's
  isolated guard-condition tests, and add a `status` integration-style throw test in
  `status.test.ts`. Seed config via `ctx.fs.writeUtf8(${gitDir}/config, ...)`.

### TDD steps

RED — new `test/unit/application/commands/internal/valueless-config-guard.test.ts`
(`sut = assertNoValuelessCoreConfig`):
1. `Given [core] excludesFile valueless` → `Then throws CONFIG_MISSING_VALUE
   { key:'core.excludesfile', line, source }` (C1). Three ISOLATED `it`s — one each for
   `excludesfile`, `attributesfile`, `hookspath` (C1/C3/C4; isolated guard conditions).
2. `Given two valueless core path-likes, earlier-line one` → `Then reports the earlier`
   (file-order discriminator).
3. `Given [core] excludesFile =  (empty string)` → `Then does NOT throw` (C10 — kills an
   "any-core-key" mutant ignoring null). Fixture `'[core]\n\texcludesFile = \n'`.
4. `Given absent core.* path-likes` → `Then does NOT throw`.
RED — `status.test.ts`:
5. `Given valueless core.excludesFile, When status` → `Then throws CONFIG_MISSING_VALUE
   { key:'core.excludesfile' }` (representative non-config command dies — C5).
6. `Given valueless core.excludesFile, When configList / configGet` → `Then does NOT throw`
   (C2/C11 porcelain exemption — add to `config.test.ts` or the guard test; the decisive
   "config is exempt" test, kills a "guard in readConfig" mutant). Use the real `configList`
   from `config.ts`.

GREEN — add `assertNoValuelessCoreConfig` to the guard file; wire the import + call into
all 14 read/inspect commands after their `assertRepository` line.

REFACTOR — confirm no read/inspect command double-guards; confirm `config`/`init`/`clone`
are untouched.

INTEROP — extend `missing-value-refusal-interop.test.ts`. Fixture
`VALUELESS_CORE_EXCLUDES_FIXTURE = '[core]\n\trepositoryformatversion = 0\n\texcludesFile\n'`
(excludesFile valueless at line 3). (C1) `git status` exits 128 reporting
`core.excludesfile` at line 3, vs tsgit `repo.status()` throwing
`CONFIG_MISSING_VALUE { key:'core.excludesfile', line:3 }`; reconstruct + compare. (C10)
empty-string fixture `'[core]\n\trepositoryformatversion = 0\n\texcludesFile = \n'` →
`git status` exits 0 AND tsgit `repo.status()` does not raise. (C2/C11) `git config --list`
succeeds AND tsgit `configList` does not throw on the valueless fixture.

### Gate

`npx vitest run test/unit/application/commands/internal/valueless-config-guard.test.ts test/unit/application/commands/status.test.ts test/unit/application/commands/config.test.ts test/integration/missing-value-refusal-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/internal/valueless-config-guard.ts src/application/commands/status.ts src/application/commands/log.ts src/application/commands/show.ts src/application/commands/diff.ts src/application/commands/blame.ts src/application/commands/cat-file.ts src/application/commands/rev-parse.ts src/application/commands/reflog.ts src/application/commands/describe.ts src/application/commands/shortlog.ts src/application/commands/whatchanged.ts src/application/commands/name-rev.ts src/application/commands/range-diff.ts src/application/commands/read-file-at.ts test/unit/application/commands/internal/valueless-config-guard.test.ts test/unit/application/commands/status.test.ts test/integration/missing-value-refusal-interop.test.ts`

### Commit

`fix(core): refuse valueless core path-likes on read commands`

---

## Slice 5 — `core` guard on mutation + branch/tag commands

### Context

Continues Slice 4: the helper `assertNoValuelessCoreConfig` already exists in
`src/application/commands/internal/valueless-config-guard.ts`. This slice wires it into the
mutation family — the commands that change the index/worktree/refs. Same pattern: import +
one call right after the existing `assertRepository(ctx)` line. Pins C5-C9 (the sweep
includes `add`/`commit`/`checkout`/`tag`/`branch`).

- **Mutation family for THIS slice** (file : function : `assertRepository` line):
  - `add.ts` : `add` : 71
  - `commit.ts` : `commit` : 73  (NOTE: commit also calls `assertNoValuelessConfig(ctx,'user',...)`
    at line 97 on its identity path — that is a DIFFERENT, pre-existing guard; the core
    guard is additive and goes after `assertRepository` at line 73, before the identity
    logic.)
  - `rm.ts` : `rm` : 67
  - `mv.ts` : `mv` : 96
  - `reset.ts` : `reset` : 62
  - `checkout.ts` : `checkout` : 308
  - `tag.ts` : `tagList` : 45 ; `tagCreate` : 64 ; `tagDelete` : 88
  - `branch.ts` : `branchList` : 60 ; `branchCreate` : 96 ; `branchDelete` : 121 ;
    `branchRename` : 138
- For namespace-bound commands (`tag*`, `branch*`), the guard goes in the REAL work
  functions in `tag.ts` / `branch.ts` (each already calls `assertRepository`), NOT the
  `bindTagNamespace` / `bindBranchNamespace` binders. Re-verify each `assertRepository`
  line with Serena `find_symbol` before editing (Slice 4 did not touch these files, but
  treat the recon line numbers as a starting hint).
- Each edit: add the `assertNoValuelessCoreConfig` import from
  `./internal/valueless-config-guard.js` (some files already import other guards from that
  path — extend the import) and the `await assertNoValuelessCoreConfig(ctx);` call after
  `assertRepository(ctx)`.

### TDD steps

RED — extend the relevant command unit tests with one representative throw test each (the
helper itself is already fully covered in Slice 4, so these are integration-of-call-site
tests, not re-testing the guard logic). At minimum:
1. `Given valueless core.excludesFile, When add` → `Then CONFIG_MISSING_VALUE
   { key:'core.excludesfile' }` (a mutation representative — kills a "guard missing on
   add" mutant).
2. `Given valueless core.hooksPath, When commit (with identity supplied)` → `Then
   CONFIG_MISSING_VALUE { key:'core.hookspath' }` BEFORE the identity/commit work (C4
   surface; proves the core guard precedes commit's own user guard).
3. `Given valueless core.attributesFile, When checkout` → `Then CONFIG_MISSING_VALUE`
   (a worktree-writing representative).
4. `Given valueless core.excludesFile, When branchList / tagList` → `Then
   CONFIG_MISSING_VALUE` (one ref-reading namespace representative).
Place each in the matching existing test file (`add.test.ts`, `commit.test.ts`,
`checkout.test.ts`, `branch.test.ts`, `tag.test.ts`). Seed config via
`ctx.fs.writeUtf8(${gitDir}/config, '[core]\n\texcludesFile\n')`.

GREEN — wire the import + call into all mutation-family functions listed above after their
`assertRepository` line.

REFACTOR — confirm `commit`'s existing `user` guard is untouched and the core guard fires
first; confirm no double-guard.

### Gate

`npx vitest run test/unit/application/commands/add.test.ts test/unit/application/commands/commit.test.ts test/unit/application/commands/checkout.test.ts test/unit/application/commands/branch.test.ts test/unit/application/commands/tag.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/add.ts src/application/commands/commit.ts src/application/commands/rm.ts src/application/commands/mv.ts src/application/commands/reset.ts src/application/commands/checkout.ts src/application/commands/tag.ts src/application/commands/branch.ts test/unit/application/commands/add.test.ts test/unit/application/commands/commit.test.ts test/unit/application/commands/checkout.test.ts test/unit/application/commands/branch.test.ts test/unit/application/commands/tag.test.ts`

### Commit

`fix(core): refuse valueless core path-likes on mutation commands`

---

## Slice 6 — `core` guard on integration, network, remote, submodule, sparse, worktree commands

### Context

Final wiring of `assertNoValuelessCoreConfig` (the remaining non-`config`/`init`/`clone`
commands). Same pattern: import + one call after `assertRepository(ctx)`. After this slice
EVERY shipped command except `config`/`init`/`clone` carries the core guard — completing
the C5-C9 surface.

- **Integration / history-rewrite family** (file : function : `assertRepository` line):
  - `pull.ts` : `pull` : 92  (already imports a guard from `./internal/valueless-config-guard.js`
    after Slice 3 — extend the import; the core guard goes after `assertRepository` at 92,
    i.e. BEFORE the branch guard added in Slice 3, which sat after `assertNoPendingOperation`.)
  - `merge.ts` : `mergeRun` : 150 ; `abort-merge.ts` : `mergeAbort` : 30 ;
    `continue-merge.ts` : `mergeContinue` : 34
  - `cherry-pick.ts` : `cherryPickRun` 419, `cherryPickContinue` 520, `cherryPickSkip` 570,
    `cherryPickAbort` 601
  - `revert.ts` : `revertRun` 407, `revertContinue` 486, `revertSkip` 532, `revertAbort` 558
  - `rebase.ts` : `rebaseRun` 440, `rebaseContinue` 515, `rebaseSkip` 558, `rebaseAbort` 584
  - `stash.ts` : `stashPush` 189, `stashList` 277, `stashApply` 415, `stashPop` 290, `stashDrop`
- **Network family:**
  - `fetch.ts` : `fetch` : 78 ; `fetch-missing.ts` : `fetchMissing` : 82 ;
    `push.ts` : `push` : 89
  - `clone.ts` : `clone` : EXEMPT (no `assertRepository`; repo-creating — do NOT add).
- **Remote / submodule / sparse / worktree family:**
  - `remote.ts` : `remoteList` 118, `remoteAdd` 133, `remoteRemove` 173, `remoteRename` 236,
    `remoteSetUrl` 306, `remoteShow` 329
  - `submodule.ts` : `submoduleList` 203, `submoduleAdd` 609, `submoduleInit` 287,
    `submoduleUpdate` 706, `submoduleSync` 378, `submoduleDeinit` 426
  - `sparse-checkout.ts` : `sparseCheckoutList` 70, `sparseCheckoutSet`, `sparseCheckoutAdd`,
    `sparseCheckoutReapply`, `sparseCheckoutDisable`
  - `worktree.ts` : `worktreeList` 66, `worktreeAdd` 208, `worktreeMove` 297, `worktreeRemove` 330
- **EXEMPT — do NOT add:** `config.ts` (all `config*`), `init.ts`, `clone.ts`.
- Re-verify each `assertRepository` line with Serena `find_symbol` before editing (Slice 3
  edited `pull.ts`; recon line numbers for the rest are starting hints). For each function:
  add the import (extend an existing `./internal/valueless-config-guard.js` import where
  present, else add one) + `await assertNoValuelessCoreConfig(ctx);` after the
  `assertRepository(ctx)` line.
- **Note on `pull`:** after this slice `pull` has BOTH the core guard (after
  `assertRepository`, line 92) AND the branch guard (after `assertNoPendingOperation`,
  Slice 3). Order: repo → core → bare → pending → branch → fetch. This matches git
  (core dies eagerly on every command; branch dies within pull). Confirm Slice 3's branch
  test still passes (a fixture with valueless branch but valued/absent core must still
  throw `branch.*`, not `core.*`).

### TDD steps

RED — add one representative throw test per sub-family (the helper is fully covered in
Slice 4; these prove the call site):
1. `Given valueless core.excludesFile, When merge` → `Then CONFIG_MISSING_VALUE
   { key:'core.excludesfile' }` (integration representative — `merge.test.ts`).
2. `Given valueless core.excludesFile, When push` → `Then CONFIG_MISSING_VALUE` (network
   representative — `push.test.ts`). And `When clone` on a fixture → does NOT raise
   `CONFIG_MISSING_VALUE` for core (clone is exempt; if clone has no pre-existing repo this
   may be vacuous — assert clone proceeds normally).
3. `Given valueless core.excludesFile, When remoteList / submoduleList / worktreeList /
   sparseCheckoutList` → `Then CONFIG_MISSING_VALUE` (one representative per
   namespace family).
4. Regression: re-run Slice 3's `branch`-valueless pull test (a fixture with a valueless
   branch key and NO valueless core key still throws `branch.*`).
Place tests in the matching existing files (`merge.test.ts`, `push.test.ts`,
`remote.test.ts`, `submodule.test.ts`, `worktree.test.ts`, `sparse-checkout.test.ts`).

GREEN — wire the import + call into every function listed above (NOT config/init/clone).

REFACTOR — sweep: confirm `config.ts`/`init.ts`/`clone.ts` carry no core guard; confirm
no command double-guards; confirm `pull`'s guard order is repo→core→…→branch.

INTEROP — extend `missing-value-refusal-interop.test.ts` with the C4 row:
`VALUELESS_CORE_HOOKSPATH_FIXTURE = '[core]\n\trepositoryformatversion = 0\n\thooksPath\n'`
(hooksPath valueless at line 3). `git commit` (hook-firing) exits 128 reporting
`core.hookspath` at line 3, vs tsgit `repo.commit(...)` throwing
`CONFIG_MISSING_VALUE { key:'core.hookspath', line:3 }`; reconstruct + compare. (Commit's
core guard is wired in Slice 5; this interop row pins the C4 message end-to-end and can
live here since commit + the full surface is complete.)

### Gate

`npx vitest run test/unit/application/commands/merge.test.ts test/unit/application/commands/push.test.ts test/unit/application/commands/remote.test.ts test/unit/application/commands/submodule.test.ts test/unit/application/commands/worktree.test.ts test/unit/application/commands/sparse-checkout.test.ts test/unit/application/commands/pull.test.ts test/integration/missing-value-refusal-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/pull.ts src/application/commands/merge.ts src/application/commands/abort-merge.ts src/application/commands/continue-merge.ts src/application/commands/cherry-pick.ts src/application/commands/revert.ts src/application/commands/rebase.ts src/application/commands/stash.ts src/application/commands/fetch.ts src/application/commands/fetch-missing.ts src/application/commands/push.ts src/application/commands/remote.ts src/application/commands/submodule.ts src/application/commands/sparse-checkout.ts src/application/commands/worktree.ts`

### Commit

`fix(core): refuse valueless core path-likes on remaining commands`

---

## Slice 7 — `merge.*.driver`/`name` lazy guard at the content-merge-table load

### Context

Depends on Slice 1 (`assertNoValuelessInSection`). The ADR-347-AMENDED placement (option A):
guard at the content-merge-table load in `buildContentMerger`, fired ONCE-lazily (latched)
the first time the returned merger closure runs for a path. NOT `namedChoice`. Pins
M1/M2/M4/M4b; stays lazy (M3).

- **build-content-merger.ts** `buildContentMerger`
  (`src/application/primitives/build-content-merger.ts` lines 40-79). Today it returns
  `async (mergeCtx): Promise<ContentMergeResult> => { ... }` (the closure at lines 47-78).
  The closure is INVOKED per path by `mergeTrees` — a fast-forward / no-content-merge merge
  invokes it for ZERO paths (M3 laziness). Add a LATCH (mirror the existing
  `providerPromise` lazy-once pattern at lines 44-46): a `let guardPromise: Promise<void> |
  undefined;` plus an `ensureNoValuelessMergeDriver = (): Promise<void> => (guardPromise ??=
  assertNoValuelessInSection(ctx, 'merge', ['driver', 'name']));`. As the FIRST statement
  inside the returned closure (before the `Promise.all` blob reads at line 48), `await
  ensureNoValuelessMergeDriver();`. This runs the all-`[merge *]` scan at most once per
  merge operation, on the first content-merged path, independent of attribute resolution
  (M4).
- **Import** `assertNoValuelessInSection` from
  `../commands/internal/valueless-config-guard.js`. NOTE the dependency direction:
  `primitives` importing from `commands/internal` would VIOLATE the layering
  (`commands → primitives`, primitives must not import commands). RESOLUTION: import
  `findFirstValuelessInSection` from `./config-read.js` (same primitives dir, added in
  Slice 1) and inline the throw, OR add `assertNoValuelessInSection` as a primitive too.
  PREFERRED: in `build-content-merger.ts`, call `findFirstValuelessInSection(ctx, 'merge',
  ['driver','name'])` directly and, if it returns an entry, `throw configMissingValue(
  found.key, found.source, found.line)`. PRECEDENT (verified): `configMissingValue` lives
  in `src/domain/commands/error.ts` (line 465) next to `configParseError`, which
  `config-read.ts` ALREADY imports (line 1); many primitives import from
  `../../domain/commands/error.js` (e.g. `fetch-pack.ts`, `apply-changeset.ts`,
  `run-hook.ts`). So a primitive throwing `configMissingValue` is the established pattern —
  NO primitives→commands edge is introduced (that would be the layering violation; importing
  the command-layer `assertNoValuelessInSection` IS forbidden here). Slice 1's
  `assertNoValuelessInSection` wrapper stays the command-layer affordance used by `pull`
  (Slice 3); the merger uses the primitive scan + domain error directly. Wrap the latch
  around this so the scan runs once. Confirm with `check:types` + `npm run validate`.
- **Lazy proof (M3):** because the guard is inside the returned closure (not in
  `buildContentMerger`'s synchronous body), constructing the merger does not run it; only
  invoking it per path does. A fast-forward merge never invokes it. Do NOT move the guard
  into `buildContentMerger`'s body.
- **Why all-subsections (M4):** git loads the whole `[merge *]` table at content-merge
  time and dies on the first valueless `driver`/`name` by file line, even with NO
  `.gitattributes` referencing the driver. `findFirstValuelessInSection` (Slice 1) provides
  exactly that scan.
- **Shared-path note:** every 3-way consumer (`merge` directly; `cherry-pick` / `revert` /
  `rebase` / `stash` via `applyMergeToWorktree`) routes through `buildContentMerger`, so
  they inherit the guard for free. The merger comment (lines 15-38) documents this.
- **Unit tests** extend `test/unit/application/primitives/build-content-merger.test.ts`.
  The file's helpers: `blob(ctx, content)` (writes a blob), `mergeCtxFor(ctx, {base,ours,
  theirs,path})` (builds a `ContentMergeContext`), `createMemoryContext`. Existing tests
  seed `[merge "custom"]` config via `ctx.fs.writeUtf8(${ctx.layout.gitDir}/config, '[merge
  "custom"]\n  driver = ...\n')` and `.gitattributes` via
  `ctx.fs.writeUtf8(${ctx.layout.workDir}/.gitattributes, '* merge=custom\n')` (lines
  113-116, 135-138). The `sut = buildContentMerger(ctx)` and is invoked
  `await sut(await mergeCtxFor(ctx, {...}))`.

### TDD steps

RED — build-content-merger.test.ts:
1. `Given [merge "custom"] driver valueless and NO .gitattributes referencing custom, When
   the merger runs for a path` → `Then throws CONFIG_MISSING_VALUE { key:'merge.custom.driver',
   line, source }` (M4 — the decisive no-attribute test; kills a `namedChoice`-only /
   attribute-gated mutant). Seed only `'[merge "custom"]\n\tdriver\n'`; no `.gitattributes`.
2. `Given [merge "custom"] driver valued, name valueless, When the merger runs` → `Then key
   'merge.custom.name'` (M2 — `name` is in the key set).
3. `Given two valueless [merge *] sections, earlier-line one, When the merger runs` → `Then
   reports the earlier` (file-order discriminator across subsections).
4. `Given [merge "custom"] driver valueless, When the merger is NOT invoked (construct
   buildContentMerger but never call the closure)` → `Then does NOT throw` (M3 laziness —
   constructing the merger must not run the guard; kills an "eager in body" mutant).
5. `Given [merge "custom"] driver valueless, When the merger runs for TWO paths` → `Then
   the scan runs once / throws on the first invocation` — assert the latch (e.g. the second
   invocation does not re-throw a different error / the guard is memoised). At minimum
   assert the first invocation throws.
6. `Given a valid [merge "custom"] driver, When the merger runs` → `Then resolves normally`
   (regression — valued driver path unchanged; mirror the existing external-driver test at
   lines 102-129).

GREEN — add the latched `findFirstValuelessInSection`+`configMissingValue` throw as the
first statement of the returned closure; add the imports.

REFACTOR — extract the latch helper alongside the existing `provider()` pattern; keep the
closure readable, nesting <2. Confirm the primitive layering (no primitives→commands
import).

INTEROP — extend `missing-value-refusal-interop.test.ts` with the M4 row. Build a
conflicting (or non-overlapping auto-resolving) 3-way merge fixture with
`'[merge "custom"]\n\tdriver\n'` written to `.git/config` (driver valueless) and NO
`.gitattributes` referencing custom. Real `git merge <branch>` exits 128 reporting
`merge.custom.driver` vs tsgit `repo.merge(...)` throwing `CONFIG_MISSING_VALUE
{ key:'merge.custom.driver', line }`; reconstruct + compare. Set up the two diverged
branches with `runGit` (commit a base, branch, edit the same file on each side to force a
content merge). Use `openRepository(...).merge(...)`.

### Gate

`npx vitest run test/unit/application/primitives/build-content-merger.test.ts test/integration/missing-value-refusal-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/build-content-merger.ts test/unit/application/primitives/build-content-merger.test.ts test/integration/missing-value-refusal-interop.test.ts`

### Commit

`fix(merge): refuse a valueless merge driver or name at content merge`
