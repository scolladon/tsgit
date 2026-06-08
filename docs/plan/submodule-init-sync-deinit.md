# Plan — Submodule write side (local): `init` / `sync` / `deinit`

Per-slice TDD (Red → Green → Refactor; `npm run validate` before each commit;
one slice = one atomic conventional commit). Slices 1–6 are **additive** (safe,
green throughout). Slice 7 is the **breaking namespace migration** — it lands the
rename + every surface gate in one commit, keeping only `list`, so validate stays
green. Slices 8–10 add the write verbs incrementally. 11 pins faithfulness; 12
refreshes docs + flips the backlog.

Branded types via the domain constructors; no primitives crossing boundaries.
`sut` is the function under test. GWT describe/it split, AAA bodies.

---

## Slice 1 — `domain/submodule/relative-url.ts` (pure port)

**Red** `test/unit/domain/submodule/relative-url.test.ts`: the resolution table
from the design (https `../`/`../../`/`./`/trailing-slash; scp `../`; scp
single-component colon-restore; over-pop collapse; absolute base; verbatim
`https://other`); plus a relative *base* case (base itself `./x`/`../x` →
`is_relative` branch). Assert exact strings.

**Green**: port `relativeUrl(base, url)` + private `chopLastDir` (returns
`{ base, colonSep }`, no mutation) + `urlIsLocalNotSsh` + `isAbsoluteUrl` +
`dosDrive`. Structure matches `remote.c` control flow.

**Properties** `relative-url.properties.test.ts` (numRuns 200): for any
ascii-no-NUL relative url (`./`/`../` prefixed) and any non-empty base,
`relativeUrl` returns a non-empty string and never throws (total over the safe
subset). `arbitraries.ts` for the url-segment generator.

**Refactor**: extract the `./`/`../` prefix predicates as named helpers.
Commit: `feat(submodule): port git relative_url resolution`.

## Slice 2 — `domain/submodule/update-mode.ts`

**Red** `update-mode.test.ts`: `parseUpdateMode('checkout'|'rebase'|'merge'|
'none')` → the value; `parseUpdateMode('!cmd')` and `parseUpdateMode('banana')`
→ `undefined` (caller maps `undefined` → refusal). Isolated test per branch.

**Green**: `SubmoduleUpdateMode` union + `parseUpdateMode(raw): SubmoduleUpdateMode
| undefined` (a `Set` membership check). Commit:
`feat(submodule): validated submodule update-mode`.

## Slice 3 — `domain/submodule/gitmodules.ts` (extract from walk-submodules)

**Red** `gitmodules.test.ts`: `parseGitmodules(text)` → rows in file order;
case-insensitive `path`/`url`/`update`/`branch`; `[submodule "x"]` quoting +
continuation + comments; unsafe-name drop (`..`, leading `-`, backslash, control
char, drive prefix, empty segment); duplicate-path last-wins is the caller's
concern (rows keep file order). `isUnsafeSubmoduleName` per-branch tests.

**Green**: move `reduceSection`/`mergeKey`/`GitmodulesRow`/`isUnsafeSubmoduleName`
/`hasControlChar`/the drive+segment guards out of `walk-submodules.ts` into the
new module; add `update`/`branch` to the row + `mergeKey`; export
`parseGitmodules` (returns `ReadonlyArray<GitmodulesRow>` in file order) +
`isUnsafeSubmoduleName`. Reuse the `config-read` `parseIniSections` tokenizer.

**Properties** `gitmodules.properties.test.ts` (numRuns 100): idempotence — for
generated submodule rows serialised to `.gitmodules` text, `parseGitmodules`
recovers name/path/url; `!`-name-unsafe invariant (an unsafe-named section never
appears in the output).

**Refactor `walk-submodules.ts`** to consume `parseGitmodules` (build its
`Map<path,row>` from the array, preserving last-wins). Existing
`walk-submodules.test.ts` stays green unchanged (behaviour-preserving) — move the
`__isUnsafeSubmoduleNameForTests` export to the domain module's direct test.
Commit: `refactor(submodule): extract .gitmodules parsing to domain`.

## Slice 4 — `config-read.ts` ParsedConfig `submodule` map

**Red** `config-read.test.ts` (extended): a config with `[submodule "libs/a"]`
`url`/`active`/`update` surfaces in `ParsedConfig.submodule.get('libs/a')` with
those fields; absent section ⇒ `submodule` undefined.

**Green**: add `submodule?: ReadonlyMap<string, { url?; active?; update? }>` to
`ParsedConfig` + the internal accumulator; a `submodule` branch in the section
dispatcher + an `assembleSubmodule` reducer (mirror `assembleRemote`); `active`
parsed as boolean (`'true'`); the size-guard compact assembly. Commit:
`feat(config): surface [submodule] sections in ParsedConfig`.

## Slice 5 — `primitives/internal/submodule-context.ts` (extract)

**Red** `submodule-context.test.ts`: `deriveSubmoduleContext(ctx, name, treeRelPath,
visited?)` → child with `gitDir = ${gitDir}/modules/<name>`, `workDir =
${workDir}/<treeRelPath>`; promisor + hooks dropped; uninitialised (`${gitDir}/
HEAD` absent) → undefined; cycle (visited) → undefined; unsafe name handled by
caller (already filtered).

**Green**: lift `deriveChildContext` out of `walk-submodules.ts` into the shared
internal (keep the `exists(HEAD)` probe + freeze). `walk-submodules.ts` imports
it. Existing walk tests stay green. Commit:
`refactor(submodule): share child-Context derivation`.

## Slice 6 — error helper `submoduleHasModifications`

**Red** fold into Slice 10's deinit tests (no standalone file). Add the
`CommandError` code `SUBMODULE_HAS_MODIFICATIONS` + `submoduleHasModifications(
path: FilePath)` helper; message-map entry. (Landed in the deinit commit.)

## Slice 7 — unified `repo.submodule` namespace (BREAKING migration, `list` only)

**Red**: update `test/unit/repository/repository.test.ts` bound-key set
(`submodules` → `submodule`) + a namespace-shape + disposed-guard assertion for
`repo.submodule.list`; update `test/parity/scenarios/submodules-empty.scenario.ts`
to `repo.submodule.list(...)` (drop `kind`); update
`test/unit/application/commands/submodules.test.ts` → `submodule.test.ts` calling
`submoduleList`. Run — red (no namespace yet).

**Green**:
- Rename `commands/submodules.ts` → `commands/submodule.ts`: `submoduleList(ctx,
  opts?): SubmoduleListResult` (drop the `kind`, keep `coerceRef` + walk
  materialisation); export `SubmoduleListOptions`/`SubmoduleListResult`.
- New `commands/internal/submodule-namespace.ts`: `SubmoduleNamespace` (`list`
  only for now) + `bindSubmoduleNamespace(ctx, guard)` (frozen, guard-per-verb),
  mirroring `remote-namespace.ts`.
- `commands/index.ts`: drop `submodules` export; add `submoduleList` + namespace
  + types.
- `repository.ts`: `readonly submodule: commands.SubmoduleNamespace;` replaces
  `submodules`; bind `submodule: bindSubmoduleNamespace(ctx, guard)`;
  `walkSubmodules` primitive binding unchanged.
- `test/integration/submodules.test.ts`: re-point at `repo.submodule.list`.

`npm run validate` green. Commit: `refactor(submodule)!: unify list into repo.submodule namespace`.

## Slice 8 — `submodule.init`

**Red** `submodule.test.ts` (init group, memory adapter; seed a worktree
`.gitmodules` + `.git/config` + `remote.origin.url` via the memory fs):
- registers an un-registered submodule → config gains `active=true`, `url`
  (resolved), in that key order; entry `{ registered:true, url, update? }`.
- copies a valid `update` (`rebase`); omits `branch`/`ignore`.
- refuses invalid `update` (`!cmd` / `banana`) writing nothing →
  `invalidOption('submodule.<name>.update', …)` (assert `.data`).
- preserves an already-set `url` → `registered:false`, config untouched.
- relative url resolved against `remote.origin.url`; no-origin → worktree path.
- `paths` filters to exact matches; unmatched → `pathspecNoMatch` (assert `.data`).
- unsafe-named section dropped (not registered).
- `assertRepository` gate (assert `NOT_A_REPOSITORY`).

**Green**: `submoduleInit(ctx, opts?)`: read worktree `.gitmodules`
(`parseGitmodules`), filter by `paths`, read `ParsedConfig`, resolve base url
(`branch.<HEAD>.remote` → `origin` → workDir), per row validate update → resolve
url → `updateConfigOperations([set active, set url, set update?])` when url
absent. Add `submoduleInit` to the namespace + barrel + `repository.test` key.
Commit: `feat(submodule): init — register submodules into .git/config`.

## Slice 9 — `submodule.sync`

**Red** (sync group): on a fresh (un-inited) clone → no-op (no config writes,
empty `entries`); on an inited submodule whose `.gitmodules` url changed →
`submodule.<name>.url` overwritten with the new resolved url; a seeded
`.git/modules/<name>/config` → its `remote.origin.url` updated
(`syncedRemote:true`), absent gitdir → `syncedRemote:false`; `paths` filter;
unmatched → `pathspecNoMatch`.

**Green**: `submoduleSync(ctx, opts?)`: iterate `.gitmodules` rows ∩
initialized (config has `submodule.<name>.url`); resolve + `set` superproject
url; if `.git/modules/<name>/config` exists, `updateConfigOperations` against a
child `Context` (`deriveSubmoduleContext`/a config-only child layout) setting
`remote.origin.url`. Add to namespace/barrel. Commit:
`feat(submodule): sync — re-point configured URLs from .gitmodules`.

## Slice 10 — `submodule.deinit`

**Red** (deinit group): neither `paths` nor `all` → refuse (`invalidOption`,
git's "Use '--all' …"); `all:true` clears + unregisters every inited submodule;
clears a populated worktree (dir remains, empty) + removes the config section
(`cleared:true`, raw `.gitmodules` url on the entry); leaves `.gitmodules` +
gitlink + `.git/modules/<name>`; refuses a dirty worktree without `force`
(modified tracked → `submoduleHasModifications`; untracked → same); `force`
discards a dirty worktree; `paths` filter; unmatched → `pathspecNoMatch`.

**Green**: add the `SUBMODULE_HAS_MODIFICATIONS` code + helper (Slice 6).
`submoduleDeinit(ctx, opts)`: require `paths`||`all`; resolve in-scope rows;
per row, if checked out and `!force`, derive child `Context` +
`status(childCtx).clean === false` ⇒ `submoduleHasModifications(path)`; clear the
worktree dir contents (`fs.rmRecursive` of children, keep the dir);
`updateConfigOperations([removeSection submodule.<name>])` when present. Add to
namespace/barrel. Commit: `feat(submodule): deinit — unregister + clear worktrees`.

## Slice 11 — interop faithfulness

**Red/Green** `test/integration/<bucket>/submodule-init-sync-deinit-interop.test.ts`
(node adapter, scrubbed `GIT_*`, shared `beforeAll` superproject per the
interop-timeout memory): build a real superproject with `.gitmodules` (relative
+ absolute + scp urls, a valid `update`), run the tsgit verb, reconstruct `git
submodule init/sync/deinit`'s `.git/config` (byte-for-byte section order/keys)
and stdout messages from the structured result, compare to real `git`. Cases:
init relative-resolution + no-origin fallback + `update` copy; sync overwrite +
checked-out `.git/modules/<name>/config`; deinit clear + section removal + dirty
refusal. Commit: `test(submodule): interop parity for init/sync/deinit`.

## Slice 12 — docs + surface gates + backlog

- `docs/use/commands/submodules.md` → `submodule.md` (list + init/sync/deinit);
  `docs/use/commands/README.md` count/entry; `README.md` command count;
  `reports/api.json` regenerated (prepush `check:doc-typedoc` gate).
- `docs/use/recipes.md` / `docs/understand/*` mentions of `repo.submodules`
  re-pointed.
- `docs/BACKLOG.md`: split 24.1 into 24.1a `[x]` (this) + 24.1b `[ ]`
  (`add`/`update`, network) in dependency order.
- RUNBOOK / CONTRIBUTING if a submodule surface is referenced.
Commit(s): `docs(submodule): …`, `docs(backlog): split 24.1 into 24.1a/24.1b`.

---

## Sequencing rationale

Domain (1–3) and primitive (4–5) slices are additive and independently green.
Slice 7 performs the breaking rename atomically with all surface gates so
validate never goes red mid-migration. Verbs (8–10) extend the namespace one
method at a time. Refactor pass (workflow Step 7) then widens to any further
DRY/altitude gains the verbs surface; mutation (Step 8) scores the final shape.
