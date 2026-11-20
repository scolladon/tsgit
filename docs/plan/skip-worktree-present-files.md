<!-- cspell:ignore backticked handback pgrep lstat lstats errno ENOTDIR EACCES ignorecase expectfilesoutsideofpatterns sparsecheckout sparsecheckoutcone uptodate memcmp strbuf unpack noop argc fastpath backdated backdate utimes utimesSync renormalize -->
# Plan — skip-worktree-present-files

> Source: design doc `docs/design/skip-worktree-present-files.md` · ADRs 1236, 1237, 1238, 1239, 1240, 1241, 1242, 1243, 1244 (all adopted as recommended; D-J `rm` is deferred and out of scope)
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

## Planning pins (git 2.56.0, scrubbed `GIT_*`, `GIT_CONFIG_NOSYSTEM=1`, isolated `HOME`, signing off, 2026-11-20)

Every pin below ran under `core.ignorecase=false` and `=true`; the two outputs were
byte-identical. Fixture (the design's): commit a/f=`base` (`df967b9`), `a/g`, `a/d/x`, `b/f`;
cone patterns /*, !/*/, /b/; `read-tree -mu HEAD` gives `S a/d/x S a/f S a/g H b/f` with `a/`
absent. "disk" = `git -c sparse.expectFilesOutsideOfPatterns=true ls-files -t -s` (does not clear).

### Pin 1 — `add` route for a literal naming a cleared out-of-pattern tracked file (S7/A1)

Source (`builtin/add.c`, `pathspec.c`, `read-cache.c` v2.56.0) and behaviour agree. git computes
`seen` with `find_pathspecs_matching_against_index(…, PS_IGNORE_SKIP_WORKTREE)`, which **skips every
entry with `ce_skip_worktree(ce) || !path_in_sparse_checkout(ce->name)`**. A pathspec that only such
entries match stays unseen. The unseen loop then reports it through `matches_skip_worktree`, which
uses the same predicate. The report is the pathspec **as typed**, not the path.

| Command (a/f = `hi`, present) | git |
|---|---|
| `add a/f` / `add --dry-run a/f` / `add -u a/f` / `add -A a/f` / `add --chmod=+x a/f` | exit 1, reports a/f, nothing staged, disk `S a/f` |
| `add a` | exit 1, reports `a` (the pathspec), nothing staged |
| `add 'a/*'` | exit 1, reports `a/*` |
| `add a/f b/f` (b/f changed) | exit 1, reports a/f, stages `b/f`, disk `H a/f` (index written) |
| `add a/f`, bit `H` on disk, default or `expect=true` | exit 1, reports a/f, nothing staged |
| `add a/f`, a/f absent (`S`) | exit 1, reports a/f |
| `add .` / `add -u` / `add --renormalize .` | exit 0, a/f **not** staged (blob stays `df967b9`) |
| `add a/new` (untracked, out of pattern) | exit 1, reports a/new (walk route: `!path_in_sparse_checkout(name)`), not staged |
| `add -A` with untracked a/new | exit 1, reports a/new, stages the rest, index written |

tsgit main (bundle of ac037122): literal/dir/glob reports match while the bit is `S`. With the bit
cleared on disk (simulated) it **stages** a/f on every route (`add a/f`, `add a`, `add 'a/*'`,
`add .`, `add --renormalize .`, `add a/f b/f`). It also **stages untracked a/new** on both the
literal and the `-A` routes, before and after the clear. That is a pre-existing divergence on R5's
untracked-walk route, so it is folded here. tsgit has no `-u` option (`add([], {update})` is not a
surface), so M3 has no tsgit row.

The tracked update callback (`update_callback`) skips `!path_in_sparse_checkout(path)`, and
`run_diff_files` already skips S entries. So every add route uses one predicate:
**excluded(entry) = entry.skipWorktree || (sparse on && !matcher(path))**. The untracked walk uses
`!matcher(path)` and reports the **path**. Report order: git prints the pathspec block
(`only_match_skip_worktree`, argument order) before the walk block (`matched_sparse_paths`, walk
order).

### Pin 2 — which `checkout`/`switch` shapes write no index (K6, W7, W8)

`builtin/checkout.c` v2.56.0: `cmd_checkout` sets `only_merge_on_switching_branches = 1` **only when
`argc == 3 && argv[1] == "-b"`**, i.e. literally `git checkout -b <name>`. `switch_branches` skips
`merge_working_tree` (no unpack, no refresh, no index write) when no start point was given and that
flag is set. `cmd_switch` always sets it.

| Command (a/f present, index backdated) | index rewritten | disk a/f |
|---|---|---|
| `checkout -b other` | **no** | S |
| `switch -c other` / `switch -C other` / `switch --detach` | no | S |
| `checkout -b other HEAD` / `checkout -b other main` | yes | H |
| `checkout -B main` / `checkout -B other2` / `checkout --detach` / `checkout --detach HEAD` / `checkout main` / `checkout other` (same commit) / `checkout --orphan o` | yes | H |
| `checkout -b other --no-track` / `checkout -q -b other` / `checkout -m -b other` | yes (argc ≠ 3) | H |
| `checkout -f -b other` | yes | S (forced reset retires a/f) |
| `checkout -b x` over an **unmerged** index | **exit 0**, HEAD → x, stages 1/2/3 kept | — |
| `checkout -b y HEAD` over an unmerged index | exit 1 `you need to resolve your current index first` | — |

tsgit has no `switch`, `-B`, `-q`, `-m` or `--orphan`. The tsgit shape git leaves alone is exactly
`checkout({ createBranch: { name } })` with no `rev`, no `force`, no `detach`, no
`createBranch.track` and no `createBranch.noTrack`. The unmerged row is a refusal mismatch in the
edited function (tsgit's `switchIndex` → `rejectUnmergedIndex` refuses), so it is folded under
D-3.

### Pin 3 — which git step removes the file in `stash apply` T2

`GIT_TRACE2_PERF` regions plus a `post-index-change` hook dumping the index at each write:

```
T2 (a/f=base present, H after the read):   T3 control (a/f absent, S):
  refresh write      H df9 a/f=base          S df9 a/f=ABSENT
  write-tree write   H df9 a/f=base          S df9 a/f=ABSENT
  merge-ort write    S 25c a/f=ABSENT        S 25c a/f=ABSENT
  unstage write      H df9 a/f=ABSENT        H df9 a/f=st
```

1. merge-ort's `checkout()` runs `unpack_trees` two-way with the patterns re-applied
   (`clear_ce_flags(…NEW_SKIP_WORKTREE…)`). The cleared out-of-pattern `H` entry goes
   `H → S` (`apply_sparse_checkout`: `CE_WT_REMOVE`), and the file is **removed**.
2. `unstage_changes_unless_new` step 2 sees `S` and calls `checkout_entry`. The in-core entry still
   carries `CE_WT_REMOVE` from step 1, so `checkout_entry_ca` takes its first branch
   (`if (ce->ce_flags & CE_WT_REMOVE) { unlink_entry; return 0; }`) and writes **nothing**. The bit
   is then cleared.
3. Step 3 rebuilds the entry from `c_tree` with flags 0, giving `H a/f df967b9`, file absent.

In T3 the entry was already `S` before the merge, so step 1 sets no `CE_WT_REMOVE` and step 2
writes `st`. tsgit mechanism: `checkOutSkippedChanges` must not write an entry that the merge
**newly hid** (S after the merge, not S in the pre-merge index). It clears the bit without a
write. Part 4.

### Pin 4 — `reset --mixed` bit shapes (R9)

`builtin/reset.c` v2.56.0 `update_index_from_diff`: only paths that **differ** between the index and
the target are rebuilt (`make_cache_entry`, zero stat). A rebuilt entry gets `CE_SKIP_WORKTREE` iff
`(pos >= 0 && ce_skip_worktree(index[pos])) || (pos < 0 && !path_in_sparse_checkout(path))`, where
`pos` is the **stage-0** position. Unchanged entries are untouched. Behaviour (t2: a/f=`v2`
`8c1384d`, a/new added, b/n added, a/g removed):

| Row | Start | git result |
|---|---|---|
| unchanged, present | `S a/f` + file (cleared to H on read) | `H df967b9` |
| unchanged, absent | `S a/f` | `S` |
| unchanged, H on disk absent, expect=true | `H a/f` | `H` |
| in-pattern `S b/f` (update-index), expect=true | `S b/f` | `S` (pattern ignored) |
| changed, absent | `S a/f` → t2 | `S 8c1384d` |
| changed, present | `S a/f` + file → t2 | `H 8c1384d` (read bit carried) |
| changed, H on disk absent (default or expect=true) | `H a/f` → t2 | `H 8c1384d` |
| staged change, absent S / absent H / present | index `45b983b` → HEAD | `S` / `H` / `H` at `df967b9` |
| new out-of-pattern, absent or **present** untracked a/new | — → t2 | `S a/new` (patterns) |
| new in-pattern b/n | — → t2 | `H b/n` |
| removed a/g | → t2 | entry gone |

The rule is wider than the design's R9 wording ("unchanged" only). **A changed entry also carries
the read bit.** See decision candidate DC-2.

### Pin 6 — the clear alone never writes the index (W-axis)

From a settled, non-racy index, git's `add -A`, `status --porcelain`, `add b/f` (unchanged) and
`commit -am` (nothing to commit) all leave the index file untouched, and disk keeps `S a/f` with
a/f present. Settle recipe: `sleep 1.2`, then
`git -c sparse.expectFilesOutsideOfPatterns=true update-index -q --really-refresh`, then
`touch .git/index`, then `sleep 1.2`. The design's W1–W5 "writes yes" rows came from a racy fresh
checkout. Neither git nor tsgit (`commitIfChanged` in add.ts; `updateIndexIfAble` in status.ts) counts
the clear as a change, so a persisted `H` comes only from a write some other change triggers.

### Pin 5 — the snapshot caching resolver can serve a stale cleared bit (D-I / ADR-1244)

Code reading of `src/adapters/snapshot-resolvers/caching-index-resolver.ts`, `resolve`: a hit is
returned when the generation is unchanged (no stat), or when the index file's stat matches
(`isStatValidatedHit`). A file appearing or vanishing at an S path changes neither the generation
nor .git/index. With the clear inside `readIndex` (wrapped by `createRawIndexResolver`), the cache
would return the bit as cleared at the first resolve. Part 9 moves the clear above the cache.

### git's ordered presence decision for the clear (lesson 046)

From `sparse-index.c` v2.56.0, `clear_skip_worktree_from_present_files` → `path_found`. Each branch
gets an interop row (Parts 8 and 9):

1. `core.sparseCheckout` off (layered) → no clear (S11, S15).
2. `sparse.expectFilesOutsideOfPatterns` true (layered, valueless = true, last wins, worktree
   wins) → no clear (E4, E4d, O4, S4, E4b, E4c).
3. Only S entries are tested, in index order.
4. `dir` non-empty and `path` starts with `dir` → absent, no `lstat`.
5. `lstat(path)` succeeds → present, so clear it. This covers a file (S1, S8), a directory (S5b),
   a live or dangling symlink (S6), a case variant on a case-insensitive FS (S13), and a path under a
   symlinked leading directory (E2).
6. `lstat` fails (ENOENT; ENOTDIR E1; EACCES X1) → absent. Then
   `dir = path[0..max_common_dir_prefix(path, dir)]`. It grows one component at a time
   (`lstat(dir + component + "/")`) and stops at the first missing directory. If every parent
   exists, `dir = path + "/"`.

`max_common_dir_prefix(p1, p2)` is the length up to and including the last `/` at which the two
strings still agree.

## Decision candidates

These are the load-bearing choices the ADRs do not settle. The recommendation is the planner's;
the user decides.

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| DC-1 | Where `reset --mixed`'s bit rule lives | A: an internal post-pass `applyResetSkipWorktree` in `src/application/primitives/internal/reset-skip-worktree.ts`; `reset.ts` calls `buildIndexFromTree` **without** `sparse` and then the post-pass · B: a new field on the public `BuildIndexFromTreeOpts` (regenerate reports/api.json) · C: change `projectLeaf` for every sparse caller, `stash.reinstateIndex` included | A | No public surface change. C changes `stash apply --index` (`reinstateIndex`), whose bit behaviour is the open spike 32.85 and is not pinned here. B pays an api.json regeneration for a reset-only rule |
| DC-2 | Scope of R9 | A: git's whole `update_index_from_diff` rule (Pin 4): a changed stage-0 entry carries the read bit, a new path follows the patterns · B: the design's wording, where only an unchanged entry keeps its bit | A | ADR-1241 left the rule to the pins. B leaves the pinned rows "changed, present → H" and "changed, H absent → H" red, which DOCTRINE D-2 folds anyway |
| DC-3 | How T2 is ported | A: `checkOutSkippedChanges` skips the write, and clears the bit, for an entry the merge newly hid (S now, not S before) · B: thread a `retired` path set out of `materializeTree` into the stash settle step | A | One predicate in the module that already ports `unstage_changes_unless_new` step 2. The pre-merge index it receives is exactly git's "was not skip-worktree" |
| DC-4 | Snapshot resolver fix | A: `createRawIndexResolver` reads the raw parse, and a new outermost `createClearingIndexResolver` clears on every resolve · B: the caching resolver skips its cache whenever sparse is on · C: record the staleness in `docs/known-divergences.md` | A | Matches R2 ("computed per call, after the cache"). The cache keeps working, and one decorator is the only new code |
| DC-5 | Where `lstatSucceeds` lives | A: a private helper in the clear module · B: an export of `src/application/primitives/internal/fs-probes.ts` (the design's wording) | A | It has one caller. Keeping it private keeps the "refusal reads absent" exception local and its doc comment beside the only reason for it. B adds a file to Part 7, which is over the ceiling |
| DC-6 | `AddResult.sparse` order with both kinds of report | A: pathspec reports (argument order), then untracked paths (walk order), as git's two advice blocks print · B: one sorted list | A | git's output order. The field is documented as git's list |
| DC-7 | An S entry whose path is lossy (non-UTF-8, `pathBytes` set) | A: never probed, so the bit is kept (as `compareAndRefresh` treats it as absent) · B: probe the escaped decode | A | tsgit cannot `lstat` git's raw bytes. B could clear on a different file's presence |

## Part 1 — Read and gate `sparse.expectFilesOutsideOfPatterns` (R1, R10)

### Context

Breaking (ADR-1238): every operational command now refuses a bogus value.

Files this part edits or creates:
- `src/application/primitives/read-sparse-config.ts`
- `src/application/primitives/internal/repo-state.ts`
- `test/unit/application/primitives/read-sparse-config.test.ts`
- `test/unit/application/primitives/internal/repo-state-worktree-sparse.test.ts`
- `test/integration/sparse-expect-files-config-interop.test.ts` (new)
- `docs/use/errors.md`

Current code (read-sparse-config.ts):
- `export interface SparseConfig { readonly enabled: boolean; readonly cone: boolean }`
- `export const coreKeyEntries = (sections: ReadonlyArray<IniSection>, keys: ReadonlySet<string>): ReadonlyArray<CoreKeyEntry>` filters `section.section.toLowerCase() === 'core'` and `subsection === undefined`, and lower-cases keys. It is also imported by repo-state.ts.
- `lastValidBoolean(entries, wanted): boolean | undefined` returns the last entry that parses.
- `readWorktreeKeys(ctx)` reads only when `isWorktreeConfigExtensionOn(ctx)`, through `readActiveWorktreeSections(ctx)` (from config-scoped-read.ts).
- `readSparseConfig(ctx)` resolves `worktree.x ?? local.core?.x ?? false`, where `local = await readConfig(ctx)`.
- Local single-key read: `findLastEntry(ctx, section, key): Promise<LocatedConfigEntry | undefined>` in config-read.ts. `LocatedConfigEntry.value: string | null` (null = valueless). Parse with `parseGitBoolean(value)` from domain/config/config-ini.ts, which returns `{ ok, value }`, valueless → true.

Target shape:
- `SparseConfig` gains `readonly expectFilesOutsideOfPatterns: boolean`. It is internal (not in reports/api.json; only `loadSparseMatcher` and commands/sparse-checkout.ts read `readSparseConfig`). There is no public surface gate.
- Add `sectionKeyEntries(sections, section, keys)`, and make `coreKeyEntries` the `'core'` partial of it so its callers are unchanged. Use `sectionKeyEntries(…, 'sparse', {'expectfilesoutsideofpatterns'})` in `readWorktreeKeys`.
- Resolution: `worktree ?? localLastValid ?? false`. An invalid local value never reaches this point on a gated command, so treat it as unset.

Current code (repo-state.ts):
- `CORE_BOOLEAN_KEYS` holds ignorecase, sparsecheckout, sparsecheckoutcone, filemode and trustctime. They are checked in `coreCandidates` through `findFirstInvalidBoolean(ctx, 'core', undefined, CORE_BOOLEAN_KEYS)`.
- `assertEagerConfigValid` reduces every candidate with `pickLowerLine` and throws through `throwEagerCandidate` (a boolean kind becomes `configBadBooleanValue(entry.key, entry.source, entry.value)`).
- `WORKTREE_BOOLEAN_KEYS` and `WORKTREE_GATED_KEYS` feed `firstWorktreeRefusal(ctx, path)`, which calls `findFirstInvalidBooleanAt(ctx, path, 'core', WORKTREE_BOOLEAN_KEYS)`.
- `assertWorktreeCoreBooleansValid` returns early when `coreKeyEntries(await readActiveWorktreeSections(ctx), WORKTREE_GATED_KEYS)` is empty. Widen that presence check to the `[sparse]` key.
- Add a `[sparse]` candidate. Locally: `findFirstInvalidBoolean(ctx, 'sparse', undefined, ['expectfilesoutsideofpatterns'])`, a new `sparseCandidates(ctx)` spread into `assertEagerConfigValid`. In the worktree: `findFirstInvalidBooleanAt(ctx, path, 'sparse', [...])` in `firstWorktreeRefusal`. Ordering is by line against every `[core]` candidate (O1/O2). Sparse being off does not exempt the key (O3).
- The finder reports `key` lower-cased and qualified (`sparse.expectfilesoutsideofpatterns`), which matches git's `fatal: bad boolean config value 'bogus' for 'sparse.expectfilesoutsideofpatterns'`.

Fixture models (read-only): test/integration/config-boolean-interop.test.ts (eager-gate twin rows for `[core]` booleans, including the `config.worktree` ones), test/integration/interop-helpers.ts (`runGit`, `tryRunGitWithExit`, `GIT_AVAILABLE`), and test/integration/sparse-checkout-worktree-config-interop.test.ts (extension-on fixtures).

Doc surface: the `CONFIG_BAD_BOOLEAN_VALUE` row in `docs/use/errors.md` lists every key and the tier it refuses at. Add `sparse.expectFilesOutsideOfPatterns`: it refuses the operational surface, also in an active `config.worktree`, and also with sparse off. docs/use/commands/sparse-checkout.md's error list is left to the documentation phase.

### TDD steps

1. RED `read-sparse-config.test.ts`, `Given an unset expectFilesOutsideOfPatterns` > `When readSparseConfig runs` > `Then expectFilesOutsideOfPatterns is false`. It fails because the field is absent (`toEqual` mismatch, the property is undefined).
2. RED same file, rows S4, E4, E4d, E4c, O4 and E4b, each a `When` under its own `Given`. S4: `config.worktree` true with the extension on gives true. E4: local `true` gives true. E4d: local `1` gives true. E4c: local `true` then `false` gives false. O4: local valueless gives true. E4b: local `true` with worktree `false` and the extension on gives false. Also: worktree `true` with the extension off gives false. Each fails for the same missing field.
3. GREEN: `sectionKeyEntries`, the field, and the resolution.
4. RED `repo-state-worktree-sparse.test.ts`. E3: local `[sparse] expectFilesOutsideOfPatterns = bogus`, then `assertOperationalRepository` throws `CONFIG_BAD_BOOLEAN_VALUE`, asserted with try/catch on `data.code`, `data.key === 'sparse.expectfilesoutsideofpatterns'`, `data.value === 'bogus'` and `data.source`. It fails because nothing reads `[sparse]`, so the call resolves.
5. RED same file. O1: `[sparse]` bogus on line 2 before `[core] filemode = bogus` on line 4, so the sparse key is named. O2: the reverse order, so `core.filemode` is named. O3: `core.sparseCheckout` absent, still refuses. E3b: the bogus value only in `config.worktree` with `extensions.worktreeConfig=true` refuses, with `source` naming config.worktree. E3b-off: the same with the extension off resolves; that one is a GUARD, because the worktree file is not read with the extension off.
6. GREEN: the `sparseCandidates` and worktree candidate, and the widened presence check.
7. GUARD interop `test/integration/sparse-expect-files-config-interop.test.ts`, with an `@proves` header (surface: config gate, bucket: cross-tool-interop). Wrap it in `describe.each(['false','true'])('Given core.ignorecase=%s in both twins', …)` with inner `When …` describes (lesson 045). Rows E3, E3b, O1, O2 and O3 (O3 runs git `rev-parse HEAD` against tsgit's `revParse`). The rows assert git's exit 128 and fatal line, and tsgit's `CONFIG_BAD_BOOLEAN_VALUE` with git's line rebuilt from `key`/`value`. They pass after step 6. On main they fail, because tsgit `status` succeeds on a bogus value.
8. Docs: `docs/use/errors.md` row update (no test).
9. REFACTOR: keep each function under 20 lines, and run `npm run check:test-pyramid`.

### Gate

`./node_modules/.bin/vitest run test/unit/application/primitives/read-sparse-config.test.ts test/unit/application/primitives/internal/repo-state-worktree-sparse.test.ts test/unit/application/primitives/internal/repo-state.test.ts test/integration/sparse-expect-files-config-interop.test.ts test/integration/config-boolean-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/read-sparse-config.ts src/application/primitives/internal/repo-state.ts test/unit/application/primitives/read-sparse-config.test.ts test/unit/application/primitives/internal/repo-state-worktree-sparse.test.ts test/integration/sparse-expect-files-config-interop.test.ts && npm run check:spelling && npm run check:test-pyramid`

(`./node_modules/.bin/vitest` stands in for the manifest's `npx vitest`. The rtk hook rewrites `npx vitest …` into a whole-suite run.)

### Commit

`fix(sparse-checkout)!: refuse a bogus sparse.expectFilesOutsideOfPatterns as git does`

## Part 2 — `add` decides "outside the sparse definition" with git's predicates (R5)

### Context

Files this part edits or creates:
- `src/application/commands/add.ts`
- `test/unit/application/commands/add-sparse-patterns.test.ts` (new)
- `test/integration/skip-worktree-present-files-add-interop.test.ts` (new)

The rule (Pin 1) is one predicate for every tracked route:
`excluded(entry) = entry.flags.skipWorktree || (matcher !== undefined && !matcher(escapedPathOf(entry)))`.
The untracked walk uses `!matcher(path)` → report the path. `matcher` comes from
`loadSparseMatcher(ctx)` (read-sparse-checkout.ts; `undefined` when sparse is off, so every route
keeps today's bit-only test). Load it once per call. Recommended: put it on the scope built once in
`addInScope` (`buildConversionScope(ctx)` returns `ConversionScope { provider, settings, executableBit }`).
Add `sparseExclusion: (entry: IndexEntry) => boolean` and `outsideSparse: (path: FilePath) => boolean`,
built from the matcher, and thread them where the scope already flows. `addRenormalized(ctx, paths, scope)`
receives the scope too.

Sites in add.ts that test the bit today. Each becomes `scope.sparseExclusion(entry)`:
- `splitSparseLiterals` → inner `namesSkipWorktree` (the literal fast path report).
- `withoutSkipWorktree(walked, existing)` (the walk filter: tracked excluded → drop silently). Also report: a walked path with **no** index entry and `outsideSparse(path)` is dropped **and** reported in `sparse` (Pin 1 a/new).
- `isSkipWorktree` / `skipWorktreeOf(existing)` (feeds `reachesSkipWorktree` in `settleUnseenPositives`).
- `verdictsBesideSkipWorktree` (seen-ness: an excluded entry takes no verdict, so its pathspec stays unseen).
- `refuseUnseenRenormalized` (`notSkipped` / `skipped` split).
- `isRecleaned` (renormalize).
- `isHiddenCandidate`.
- `stagedGitlinks` filter.
- `collectRemovedEntries` (`if (entry.flags.skipWorktree) continue;`).

The two `Stryker disable` comments on `skipWorktreeOf` / `refuseUnseenRenormalized` justify
equivalence for the bit list. Re-check that the reasoning still holds for the widened predicate, and
reword or remove them. Never add a new one without user approval.

The `-A` route `addAll` currently returns `sortedResult(tally, settled.removed, { sparse: [], ignored: [] })`.
It must return the untracked out-of-pattern paths. Report order: pathspec reports first, then walk
paths (DC-6).

Unit fixtures (read-only models): test/unit/application/commands/add-skip-worktree.test.ts
(`sparseRepo`, `refusalOf`, `entryOf`), test/unit/application/commands/add-index-fixtures.ts
(`seedIndex(ctx, rows)`, where a row takes `skipWorktree: true`), test/unit/application/commands/fixtures.ts
(`seedRepo(ctx, { workingTree })`), and test/unit/application/commands/sparse-checkout.test.ts (how a
memory repo turns sparse on: core.sparseCheckout = true in .git/config plus
.git/info/sparse-checkout). The new unit file seeds sparse on with cone patterns /*, !/*/,
/b/, an **H** entry "a/f" (bit cleared) with a changed file on disk, and an in-pattern "b/f".

Interop setup (stable before and after Part 8): both twins get local
`sparse.expectFilesOutsideOfPatterns=true`, then `git update-index --no-skip-worktree a/f` with
a/f=`hi`. That is Pin 1's "H on disk" shape. Interop model (read-only):
test/integration/add-skip-worktree-interop.test.ts (`adviceOf`, `snapshotOf`, twin layout and
`@proves` header). Tags are read with `-c sparse.expectFilesOutsideOfPatterns=true ls-files -t -s`
(lesson 047), and the disk listing is compared as well.

### TDD steps

1. RED unit: `Given sparse on and an out-of-pattern entry without the bit whose file changed` > `When add names it as a literal` > `Then it reports the literal in sparse and stages nothing`. It fails because the literal route stages the file (`modified: ['a/f']`).
2. GREEN: the scope predicate and the literal and seen-ness sites (`splitSparseLiterals`, `verdictsBesideSkipWorktree`, `skipWorktreeOf`).
3. RED unit, three rows that each fail by staging a/f: `When add runs on the directory "a"` reports `a`. `When add runs on the glob "a/*"` reports `a/*`. `When add runs with all` stages nothing for a/f and reports nothing. `withoutSkipWorktree` and `collectRemovedEntries` still use the bit.
4. GREEN: the walk and removal sites, plus `isHiddenCandidate` and `stagedGitlinks`.
5. RED unit: `When add renormalizes "."` leaves a/f's blob unchanged. It fails because `isRecleaned` restages it. GREEN: `isRecleaned` and `refuseUnseenRenormalized`.
6. RED unit: `Given sparse on and an untracked out-of-pattern file` > `When add names it` reports `sparse: ['a/new']` and adds nothing. Same for `When add runs with all`. Both fail because tsgit stages a/new today. Add a row for "both kinds": `add(['a/f', 'a/new'])` gives `sparse` = `['a/f', 'a/new']` (pathspec, then walk).
7. GREEN: the untracked report on the walk and literal routes, and `addAll` returning it.
8. GUARD unit: `Given sparse off and an entry with the bit set` keeps every current bit-only behaviour. It passes because the matcher is `undefined`. The existing add-skip-worktree.test.ts suite is the bulk of this guard; run it.
9. GUARD interop `test/integration/skip-worktree-present-files-add-interop.test.ts` (both ignorecase twins). Rows A1 (`add a/f`), `add a`, `add 'a/*'`, `add -A` (git `add -A` ⇔ tsgit `{ all: true }`), `add .`, `add --renormalize .`, `add a/f b/f`, `add a/new` and `add -A` with a/new. Each compares git's exit (0 or 1) and advice list with tsgit's `sparse`, the staged blobs, and the disk tags. They pass after the GREENs. On main they fail because tsgit stages a/f or a/new.
10. REFACTOR: keep functions under 20 lines, with no boolean parameters (the predicate is a function, not a flag). Run `npm run check:test-pyramid`.

### Gate

`./node_modules/.bin/vitest run test/unit/application/commands/add-sparse-patterns.test.ts test/unit/application/commands/add-skip-worktree.test.ts test/unit/application/commands/add.test.ts test/integration/skip-worktree-present-files-add-interop.test.ts test/integration/add-skip-worktree-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/add.ts test/unit/application/commands/add-sparse-patterns.test.ts test/integration/skip-worktree-present-files-add-interop.test.ts && npm run check:spelling && npm run check:test-pyramid`

### Commit

`fix(add): leave out-of-pattern paths unstaged and report them as git does`

## Part 3 — `checkout -b` on the current commit writes no index (R6)

### Context

Files this part edits or creates:
- `src/application/commands/checkout.ts`
- `test/unit/application/commands/checkout-create-branch.test.ts`
- `test/integration/checkout-create-branch-no-index-write-interop.test.ts` (new)

Current flow in checkout.ts:
- `switchBranch(ctx, opts)` maps `opts.rev ?? 'HEAD'` before calling `switchToCommit(ctx, { ...opts, rev }, priorHead, headOid)`. The unborn case goes to `switchUnbornToNewBranch` first.
- `switchToCommit` → `resolveCommitSwitch` (which runs `assertBranchCreatable`) → `switchRequestOf` (`loadSparseMatcher`, `readTree`) → `materializeSwitch` (index lock, `switchIndex` → `readIndex` + `rejectUnmergedIndex` + `refreshedIndex`, `materializeTreeJudging`, `lock.commit`) → `finishSwitch` (create the branch, move HEAD, `removeBranchState`, post-checkout hook).

Target (Pin 2): git's no-merge shape is `checkout({ createBranch: { name } })` with **no `rev`** (decided on the caller's
`opts`, before the `'HEAD'` default), `force !== true`, `detach !== true`,
`createBranch.track === undefined`, and `createBranch.noTrack !== true`. On that shape
`switchToCommit` skips `switchRequestOf` and `materializeSwitch` entirely: no lock, no read, no
refresh and no write, with `changedPaths: 0`. `finishSwitch` still runs: branch creation, HEAD and
its reflog, branch-state removal, and post-checkout with old = new oid. `CheckoutSwitchOptions` is
public, but no field changes, so there is no surface gate. Name the predicate for what git checks,
e.g. `keepsWorkingTreeAsIs(opts)`, and pass the original opts down rather than a boolean.

Unit model (read-only): test/unit/application/commands/checkout-create-branch.test.ts (extend it)
and test/unit/application/commands/checkout-index-refresh.test.ts (how a test observes an index write
on the memory adapter: stat or mtime of .git/index before and after). Interop model:
test/integration/checkout-unborn-switch-interop.test.ts.

Interop observation: backdate .git/index with `utimesSync` to 2000-01-01, then compare
`(mtimeMs, ino)` before and after on each twin. tsgit's lock commit renames, so its inode changes.

### TDD steps

1. RED unit: `Given a repository on main` > `When checkout creates a branch with no start point` > `Then the index file is not rewritten`. Assert that the index bytes and stat are unchanged, and that HEAD → `refs/heads/other`. It fails because `materializeSwitch` commits unconditionally.
2. RED unit: `Given an unmerged index` > `When checkout creates a branch with no start point` > `Then HEAD moves to it and every stage stays`. It fails with `rejectUnmergedIndex`'s refusal.
3. GREEN: the predicate and the early path in `switchToCommit`.
4. GUARD unit, these keep writing: `rev: 'HEAD'` with createBranch, `noTrack: true`, `force: true`, `detach: true` (no createBranch), and a plain `rev: 'main'` with no createBranch. Each passes because the predicate excludes it. Also `rev: 'HEAD'` with createBranch over an unmerged index still refuses.
5. GUARD interop (both ignorecase twins, `@proves` header): `checkout -b other` ⇔ `{ createBranch: { name: 'other' } }` leaves the index untouched on both twins. Then `checkout -b other HEAD` ⇔ `{ rev: 'HEAD', createBranch }` and `checkout -b other --no-track` ⇔ `{ createBranch: { name, noTrack: true } }` rewrite on both. Then `checkout -b x` over an unmerged index succeeds on both, with `ls-files -s` equal. Add a sparse row: K6 with the H on disk + expect=true setup from Part 2 and a/f present, where disk tags are unchanged on both. They pass after step 3. On main the no-write and unmerged rows fail.
6. REFACTOR, then run `npm run check:test-pyramid`.

### Gate

`./node_modules/.bin/vitest run test/unit/application/commands/checkout-create-branch.test.ts test/unit/application/commands/checkout.test.ts test/unit/application/commands/checkout-index-refresh.test.ts test/integration/checkout-create-branch-no-index-write-interop.test.ts test/integration/checkout-unborn-switch-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/checkout.ts test/unit/application/commands/checkout-create-branch.test.ts test/integration/checkout-create-branch-no-index-write-interop.test.ts && npm run check:spelling && npm run check:test-pyramid`

### Commit

`fix(checkout): leave the index untouched when checkout -b stays on the current commit as git does`

## Part 4 — `stash` retires a clean out-of-pattern file as git does (R7, R8)

### Context

Files this part edits or creates:
- `src/application/commands/stash.ts`
- `src/application/commands/internal/check-out-skipped-changes.ts`
- `test/unit/application/commands/internal/check-out-skipped-changes.test.ts`
- `test/unit/application/commands/stash.test.ts`
- `test/integration/skip-worktree-present-files-stash-interop.test.ts` (new)

R7 (P1, P2): `resetAfterPush(ctx, lock, inputs)` in stash.ts calls
`materializeTreeJudging(ctx, { targetTree: target, currentIndex, force: true, forceRewriteAll: true }, 'oneway')`
with no `sparse`. Add `sparse` from `loadSparseMatcher(ctx)`, which is already imported. Spread it only
when defined, under `exactOptionalPropertyTypes`, as `reinstateIndex` does. git's push reset is
`unpack_trees` with the patterns, so a clean or dirty out-of-pattern `H` entry is removed from disk
and marked `S`. The forced path agrees with `checkout -f` (design K4 sim: removed, S).

R8 (T2), Pin 3 and DC-3: `checkOutSkippedChanges(ctx, merged, before)` (check-out-skipped-changes.ts)
writes every merged entry that `isChangedSkipped(entry, previous)` accepts. That is
`entry.flags.skipWorktree`, plus an id or mode change against `before`, which is the refreshed pre-merge
index (`currentIndex.entries`). New rule: when the `before` entry exists and was **not**
skip-worktree, the merge newly hid it (git's `CE_WT_REMOVE` leak). Push it with
`skipWorktree: false` and **no write and no stat data**. `unstageChangesUnlessNew`
(unstage-changes-unless-new.ts, read-only) then rebuilds the entry from `cTree` with `STAGE0_FLAGS`.
The result is `H a/f` at HEAD's blob with the file absent. A path absent from `before` keeps today's
write.

Precondition to confirm in step 1: tsgit's clean merge (`applyMergeToWorktree` →
`materializeTree(…, { sparse, headTree, force: true })`) must retire the H out-of-pattern entry
whose content changes, so it ends S with the file removed. The design's simulation shows a/f=`st`,
which is consistent with either "the merge retired it and `checkOutSkippedChanges` rewrote it" or
"the merge wrote it". If the merge writes it, stop: that is a blocker `{ unit: Part 4, reason, options }`
and is not to be patched around.

Unit models (read-only): test/unit/application/commands/stash.test.ts (memory stash fixtures) and
test/unit/application/commands/internal/unstage-changes-unless-new.test.ts.

Interop setup (stable across Part 8): both twins get local `sparse.expectFilesOutsideOfPatterns=true`.
To build a stash touching a/f: `update-index --no-skip-worktree a/f`, `echo st > a/f`, `git stash`,
`sparse-checkout reapply`, `rm -f a/f`, `update-index --skip-worktree a/f`. Then for the T2 shape:
`update-index --no-skip-worktree a/f` with a/f=`base`. Rows compare disk tags (expect=true read),
whether a/f exists and its bytes, and git exit vs tsgit kind or code. Model (read-only):
test/integration/sequencer-sparse-cone-writes-interop.test.ts (`tagged()` and its stash rows).

### TDD steps

1. Probe (no commit): run the T2 shape through tsgit and record whether a/f exists after `applyMergeToWorktree` and before the settle step. A throwaway script under the session scratchpad is enough. Continue only if it is retired.
2. RED unit (check-out-skipped-changes.test.ts): `Given a pre-merge entry without the bit and a merged entry the merge hid with a new blob` > `When the skipped changes are checked out` > `Then nothing is written and the entry loses its bit`. Assert the file is absent and `flags.skipWorktree === false`. It fails because today it writes the blob.
3. GUARD unit: an entry S before and after with a new blob is still written (T3). It passes on today's code.
4. GREEN: the predicate in `isChangedSkipped`, renamed for what it decides.
5. RED unit (stash.test.ts): `Given sparse on and an out-of-pattern entry without the bit holding a change` > `When stash push runs` > `Then the file is removed and the entry is skip-worktree at HEAD's blob`. It fails because the reset rewrites the file without patterns.
6. GREEN: `sparse` in `resetAfterPush`.
7. GUARD interop (both ignorecase twins): T2 (a/f absent, `H df967b9`, tsgit `{kind:'applied'}` vs git exit 0), T3 control (a/f=`st`, H), T1 (`STASH_APPLY_WOULD_OVERWRITE` vs exit 128 `would be overwritten by merge`, then disk on both), P1 (a/f=`hi` stashed, stash tree a/f = `45b983b` on both, a/f removed, `S`), and P2 (b/f change, a/f=`base`: removed, `S`). They pass after steps 4 and 6. On main T2 and P1 fail.
8. REFACTOR, then run `npm run check:test-pyramid`.

### Gate

`./node_modules/.bin/vitest run test/unit/application/commands/internal/check-out-skipped-changes.test.ts test/unit/application/commands/stash.test.ts test/unit/application/commands/internal/unstage-changes-unless-new.test.ts test/integration/skip-worktree-present-files-stash-interop.test.ts test/integration/sequencer-sparse-cone-writes-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/stash.ts src/application/commands/internal/check-out-skipped-changes.ts test/unit/application/commands/internal/check-out-skipped-changes.test.ts test/unit/application/commands/stash.test.ts test/integration/skip-worktree-present-files-stash-interop.test.ts && npm run check:spelling && npm run check:test-pyramid`

### Commit

`fix(stash): retire a clean out-of-pattern file on push and apply as git does`

## Part 5 — `reset --mixed` carries the read bit as git does (R9)

### Context

Files this part edits or creates (DC-1 option A, DC-2 option A):
- `src/application/commands/reset.ts`
- `src/application/primitives/internal/reset-skip-worktree.ts` (new, internal, not barrelled)
- `test/unit/application/primitives/internal/reset-skip-worktree.test.ts` (new)
- `test/unit/application/commands/reset.test.ts`
- `test/integration/skip-worktree-present-files-reset-interop.test.ts` (new)

Current: `rebuildIndexFromCommit(ctx, commitId)` in reset.ts loads `matcher`, takes the lock, runs
`readIndex`, calls `buildIndexFromTree(ctx, { targetTree, currentIndex, ...(matcher ? { sparse: matcher } : {}) })`,
then `lock.commit(newEntries, 'update')`. In build-index-from-tree.ts (read-only here), `projectLeaf`
with `sparse` returns `skipWorktreeEntry(leaf)` for an excluded path. Otherwise it returns the donor
with `includedFlags` (which forces `skipWorktree: false`) when `(id, mode)` matches, or else
`zeroStatEntry(leaf)` with `STAGE0_FLAGS`. Without `sparse`, a matched donor keeps its flags
verbatim (stage forced to 0).

Target: reset.ts calls `buildIndexFromTree` **without** `sparse`. That keeps unchanged entries
verbatim, bit included, and builds changed and new entries zero-stat with no bit. It then applies:

```ts
// reset-skip-worktree.ts
export const applyResetSkipWorktree = (
  rebuilt: ReadonlyArray<IndexEntry>,
  currentIndex: GitIndex,
  sparse: SparseMatcher | undefined,
): ReadonlyArray<IndexEntry>;
```

The rule, git's `update_index_from_diff` (Pin 4): the donor is the stage-0 entry at the same
`indexPathKey`. If a donor exists and `(id, mode)` matches, the entry is the donor itself (keep it).
If a donor exists and differs, set `skipWorktree = donor.flags.skipWorktree`. If there is no stage-0
donor, set `skipWorktree = sparse !== undefined && !sparse(escapedPathOf(entry))`. When the bit is set
on a rebuilt entry, the stat stays zero (`skipWorktreeEntry` shape). `buildIndexFromTree`'s public
`BuildIndexFromTreeOpts` is unchanged, so reports/api.json is not touched. `stash.reinstateIndex`
keeps `sparse` and today's rule (32.85 territory, out of scope). `materializeTree`'s hard reset is
untouched.

Existing assertions this flips (explain each in the commit's handback):
test/unit/application/primitives/build-index-from-tree.test.ts is unchanged, because the primitive
is unchanged. In test/unit/application/commands/reset.test.ts and
test/integration/sparse-reset-merge.test.ts, any row asserting "an in-pattern stale skip-worktree bit
is cleared by reset --mixed" now keeps the bit. Pin 4's row "in-pattern `S b/f` → `S`" is the reason.
Any other flip is a blocker.

Rows whose pin starts from a file present at an S path first run `update-index --no-skip-worktree`:
expect=true stops git's read clear, so the cleared state is put on disk instead. The natural
default-config R2 row lands in Part 8.
Interop setup: local `sparse.expectFilesOutsideOfPatterns=true` on both twins. Commit `t2`
(a/f=`v2`, add a/new and b/n, remove a/g) **before** turning sparse on, as in Pin 4's `p6` fixture.
Then the cone patterns and `read-tree -mu HEAD`.

### TDD steps

1. RED unit (reset-skip-worktree.test.ts), one `Given` per Pin 4 shape. A changed donor with the bit keeps it. A changed donor without the bit gets none. An unchanged donor keeps its entry object. A new out-of-pattern path gets the bit with zero stat. A new in-pattern path gets none. With sparse undefined a new path gets none. A stage-2-only path (no stage-0 donor) takes the pattern rule. They fail because the module is missing (import error).
2. GREEN: the module.
3. RED unit (reset.test.ts): `Given sparse on and an out-of-pattern entry without the bit` > `When reset --mixed to HEAD runs` > `Then the entry stays without the bit`. It fails because `includedFlags` / `projectLeaf` re-marks it S. Add `Given an in-pattern entry carrying the bit` → it keeps the bit, which fails because `includedFlags` clears it.
4. GREEN: wire reset.ts.
5. GUARD interop (both ignorecase twins): R2 (H on disk, present → H), R2x (H absent → H), R2a (S absent → S), changed-present, changed-H-absent, new a/new present → S, new b/n → H, in-pattern S b/f → S. Compare full `ls-files -t -s` with expect=true. They pass after step 4. On main R2, R2x, the changed-H and the in-pattern rows fail.
6. Regression: run test/integration/sparse-reset-merge.test.ts and test/unit/application/primitives/build-index-from-tree.test.ts, and update only the rows Pin 4 explains.
7. REFACTOR, then run `npm run check:test-pyramid`.

### Gate

`./node_modules/.bin/vitest run test/unit/application/primitives/internal/reset-skip-worktree.test.ts test/unit/application/commands/reset.test.ts test/unit/application/primitives/build-index-from-tree.test.ts test/integration/skip-worktree-present-files-reset-interop.test.ts test/integration/sparse-reset-merge.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/reset.ts src/application/primitives/internal/reset-skip-worktree.ts test/unit/application/primitives/internal/reset-skip-worktree.test.ts test/unit/application/commands/reset.test.ts test/integration/skip-worktree-present-files-reset-interop.test.ts && npm run check:spelling && npm run check:test-pyramid`

### Commit

`fix(reset): keep each entry's skip-worktree bit on reset --mixed as git does`

## Part 6 — `status` bench on sparse fixtures (test-infra, no `src/` delta)

### Context

Files this part edits or creates:
- `test/bench/status-sparse.bench.ts` (new)
- `test/bench/fixtures.ts` (add `setupSparseStatusFixture`)

This part lands **before** the clear so Part 8 can A/B this commit against its own commit with
`npm run bench:ab -- <this-part-sha> HEAD 3 status-sparse.bench.ts`. `bench:ab` needs the bench
file in both refs, so main cannot be the base.

Fixture `setupSparseStatusFixture(layout: 'present-directories' | 'absent-directories')` is built
with the git CLI under `scrubbedGitEnv()` (already in fixtures.ts, with `execFileAsync`).
- `present-directories`: 200 directories dNNN/, each with `keep` plus 100 `sNNNN` files (20 000 S
  candidates). Non-cone patterns "/*" then "!/d*/s*", `core.sparseCheckout=true`,
  `core.sparseCheckoutCone=false`, then `git read-tree -mu HEAD`. The directories stay present, so
  every S entry costs one `lstat` (the worst case ADR-1243 gates).
- `absent-directories`: the same tree with cone patterns "/*" and "!/*/" and one top-level file.
  The directories are removed, so the missing-directory cache answers.

The scenarios are tsgit-only (`baseline` is optional in `BenchComparison`;
test/bench/support/bench-dsl.ts). Open the repo once, warm it with one `status()`, and measure
`status()`. `teardown` must remove synchronously (`removeSync` from
test/bench/support/fixture-scratch.ts) and dispose the repo. Model (read-only):
test/bench/status-dirty.bench.ts (settle delay so refresh writes stop, then warm call). Name the
scenarios in GWT form.

### TDD steps

1. Write the fixture and the two scenarios. A bench is not a RED/GREEN unit. Its check is that it runs.
2. GUARD: `./node_modules/.bin/vitest bench --run --config vitest.bench.config.ts test/bench/status-sparse.bench.ts > <scratch>/bench.txt 2>&1` completes, and both scenarios report a mean. The stdout goes to a file; read back only the summary rows.
3. REFACTOR: fixture helper under 20 lines per function (extract the tree writer).

### Gate

`./node_modules/.bin/vitest bench --run --config vitest.bench.config.ts test/bench/status-sparse.bench.ts && npm run check:types && ./node_modules/.bin/biome check test/bench/status-sparse.bench.ts test/bench/fixtures.ts && npm run check:spelling`

### Commit

`test(bench): measure status on sparse checkouts with many skip-worktree entries`

## Part 7 — The presence decision and the clear primitive (R2 core, R3, D-G, DC-5, DC-7)

### Context

Files this part edits or creates (nothing calls the primitive yet; Part 8 wires it):
- `src/domain/sparse/missing-directory.ts` (new; internal; import it by module path, **not** through domain/sparse/index.ts)
- `test/unit/domain/sparse/missing-directory.test.ts` (new)
- `test/unit/domain/sparse/missing-directory.properties.test.ts` (new)
- `src/application/primitives/internal/clear-skip-worktree-from-present-files.ts` (new; internal)
- `test/unit/application/primitives/internal/clear-skip-worktree-from-present-files.test.ts` (new)

Domain (pure, no platform import). It ports `path_found` and `max_common_dir_prefix` (see
"git's ordered presence decision" above):

```ts
// missing-directory.ts
export type PathProbe = (path: string) => Promise<boolean>;
/** Paths (index order) that a successful probe finds; a cached missing directory answers the rest. */
export const presentPaths = (paths: ReadonlyArray<string>, probe: PathProbe): Promise<ReadonlySet<string>>;
export const commonDirectoryPrefix = (a: string, b: string): number; // up to and incl. last agreeing '/'
```

`presentPaths` keeps `dir` ('' = none; otherwise it ends in '/'). For each path: if
`dir !== '' && path.startsWith(dir)`, it is absent with no probe. Else if `await probe(path)`, it is
present. Else it grows `dir` from `commonDirectoryPrefix(path, dir)`, probing `dir + component + '/'`
and stopping at the first false. If none is missing, `dir = path + '/'`. Probes run sequentially in
index order (ADR-1243). It stays immutable outside the loop's own local cursor; write it as a
recursive helper or a reduce over an accumulator, whichever keeps functions under 20 lines.

Application:

```ts
// clear-skip-worktree-from-present-files.ts
export const clearSkipWorktreeFromPresentFiles = (ctx: Context, index: GitIndex): Promise<GitIndex>;
```

The short circuits run in cost order and each returns `index` itself:
1. `ctx.layout.workDir === undefined`.
2. No entry has `flags.skipWorktree`. Memoise this per `GitIndex` object in a module `WeakMap<GitIndex, ReadonlyArray<IndexEntry>>` of S candidates, so a cached parse pays the scan once.
3. `readSparseConfig(ctx)` (Part 1) gives `!enabled || expectFilesOutsideOfPatterns`.

Candidates are S entries that are not lossy (`isLossy` from domain/git-index/index-path-key.ts, so a
lossy entry keeps its bit; DC-7), in index order. The probe is
`lstatSucceeds(ctx.fs, joinPath(workDir, path))`, where `joinPath` comes from
src/application/primitives/internal/join-working-tree-path.ts. `lstatSucceeds` is a private helper:
`fs.lstat` resolved means true, and **any** rejection means false (ADR-1242: git's `path_found`
treats every errno as absent). Its doc comment says that this is the one place a refusal reads as
absence, and why. No other catch-all may appear. If the present set is empty, return `index`. Else
return `{ ...index, entries }`, where only cleared entries are replaced by
`{ ...entry, flags: { ...entry.flags, skipWorktree: false } }`. `version`, `extensions`,
`trailerSha` and `indexMtime` carry over by the spread. The input is never mutated.

Unit fixtures: `createMemoryContext()` (src/adapters/memory/memory-adapter.ts). Index rows come from
test/unit/application/commands/add-index-fixtures.ts `seedIndex` or are built directly as `GitIndex`
literals via `skipWorktreeEntry` (domain/git-index/index-entry.ts). Sparse config is written to the
memory .git/config. Property conventions: .claude/workflow/property-testing.md (oracle lens,
numRuns budget). Arbitraries: generate a sorted unique set of paths over a small alphabet with depth
≤ 4, plus a random "present" set closed under parents. The probe answers path membership, or "is a
directory" for a path ending in '/'.

### TDD steps

1. RED domain table (missing-directory.test.ts), one `Given` per shape: an absent top-level directory skips its later siblings with no probe; a nested absent directory; a present parent with an absent leaf caches `leaf/`; a sibling after a cached miss is probed again; a path equal to the cached directory minus its slash; a present path never touches `dir`; `commonDirectoryPrefix` cases ('a/b/c' vs 'a/b/d' → 4, 'a/x' vs 'b/x' → 0, no slash → 0). Assert both the result set and the exact probe sequence (a recorded array), which kills mutants on the prefix arithmetic. They fail because the module is missing.
2. GREEN: the domain module.
3. GUARD property (missing-directory.properties.test.ts): over random trees, `presentPaths` equals the naive filter `paths.filter(p => present.has(p))`, and the probe count is ≤ `paths.length` + the total number of directory components. It passes on step 2's code. It is the oracle that the cache never hides a present path.
4. RED application (clear-skip-worktree-from-present-files.test.ts), one row per branch:
   - sparse off → same object, and no config read (spy on nothing; assert identity).
   - expect=true → same object.
   - no S entry → same object.
   - bare layout → same object.
   - a file at an S path → cleared.
   - a directory at the path → cleared.
   - a regular file at the parent → kept (ENOTDIR → absent).
   - a probe rejection other than not-found: use an fs wrapper whose `lstat` rejects with `PERMISSION_DENIED` for that path → kept, no throw.
   - a lossy entry → kept.
   - two S entries, one present → only that one replaced, `trailerSha`/`indexMtime`/`extensions` identical (`toBe`).
   - input not mutated.
   It fails because the module is missing.
5. GREEN: the primitive.
6. REFACTOR: functions under 20 lines, named constants, no boolean params.

### Gate

`./node_modules/.bin/vitest run test/unit/domain/sparse/missing-directory.test.ts test/unit/domain/sparse/missing-directory.properties.test.ts test/unit/application/primitives/internal/clear-skip-worktree-from-present-files.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/sparse/missing-directory.ts src/application/primitives/internal/clear-skip-worktree-from-present-files.ts test/unit/domain/sparse/missing-directory.test.ts test/unit/domain/sparse/missing-directory.properties.test.ts test/unit/application/primitives/internal/clear-skip-worktree-from-present-files.test.ts && npm run check:spelling && npm run check:architecture`

(`check:architecture` (dependency-cruiser) confirms the domain module imports nothing outward.)

### Commit

`feat(sparse-checkout): port git's present-file probe for skip-worktree entries`

## Part 8 — Every index read clears the bit of a present file (R2, R4, R11, ADR-1243 gate)

### Context

Files this part edits or creates:
- `src/application/primitives/read-index.ts`
- `test/unit/application/primitives/read-index.test.ts`
- `test/integration/skip-worktree-present-files-fixtures.ts` (new: the design's matrix fixture for both twins)
- `test/integration/skip-worktree-present-files-status-interop.test.ts` (new)
- `test/integration/skip-worktree-present-files-readers-interop.test.ts` (new)
- `test/integration/posix-only/skip-worktree-present-files-interop.test.ts` (new)

Current read-index.ts: `readIndex(ctx)` → `assertRepoSettingsValid`. When the index is missing it
returns the empty index; otherwise `readIndexAt(ctx, await ctx.fs.stat(path))`. The session `cache`
holds `Promise<GitIndex>` keyed on the index file's stat. `readIndexAt` is also called by
`readPreviousIndex` (internal/smudge-racily-clean.ts), which must stay raw.

Target:
- Extract today's `readIndex` body as `export async function readRawIndex(ctx): Promise<GitIndex>`. It is internal: **not** added to src/application/primitives/index.ts; Part 9's raw snapshot resolver imports it by module path.
- `readIndex(ctx) = clearSkipWorktreeFromPresentFiles(ctx, await readRawIndex(ctx))`. The cache keeps holding the raw parse, so a file appearing between two calls is seen with no index change.
- `readIndexAt` is unchanged. `primitives.readIndex` (public via repository.ts) now returns git's `ls-files -t` view (R11). The signature is unchanged, so there is no api.json change. Confirm with `npm run docs:json` and `git diff --no-ext-diff --stat reports/api.json` being empty.

Fixture module (both twins, a real git repo and a tsgit-opened copy, like the existing interop
suites): the design's "Pinned matrix" fixture. Commit a/f=`base`, a/g, a/d/x, b/f, and t2 (a/f=`v2`)
for K-rows. Cone patterns, `read-tree -mu HEAD`. Expose a `tagsOf(dir)` that reads
`git -c sparse.expectFilesOutsideOfPatterns=true ls-files -t -s` (lesson 047), a disk listing, and a
`settle(dir)` that applies Pin 6's recipe. With it, the opportunistic writers (`status`, `add`, `commit`)
skip the write on both twins. Without it, the fresh checkout is racy and both write. Use `runGit`, `GIT_AVAILABLE` and `tryRunGitWithExit` from
test/integration/interop-helpers.ts. Every suite wraps rows in
`describe.each(['false','true'])('Given core.ignorecase=%s in both twins', …)` with `When …` inner
describes (lesson 045), and carries an `@proves` header. Test titles describe behaviour; no design
row ids (no provenance refs in tests).

Status interop rows: one per branch of the ordered decision list above (lesson 046). Rebuild git's
porcelain line from tsgit's structured change (ADR-249). Rows: S1 (` M a/f`), S8 (clean), S5b
(` D a/f`, empty directory), S12 (` M a/d/x`, only a/d/x cleared), E1 (`?? a`, nothing cleared),
S14 (non-cone patterns "/*" then "!/a/"), S11 (sparse off → no clear), S15 (bit via `update-index --skip-worktree`
without sparse → no clear), S4b (`core.sparseCheckout` only in config.worktree, extension on →
cleared), E4b, E4c, O4 (valueless → no clear), S13 (case variant "A/f"; run only where the FS is
case-insensitive, probed at runtime with `it.skipIf`). Writer rows: status-writes-cleared-bit-when-racy
(not settled → disk `H` on both), status-skips-write-when-settled (Pin 6: disk stays S on both),
C1 (`commit -a` → `NOTHING_TO_COMMIT` vs exit 1, disk unchanged), W11 (commit of a b/f change → disk `H a/f` on both), and `ls-files -t`
vs `primitives.readIndex` (`H a/f`).

Readers interop rows. This is the natural state: default config, `S` on disk, file present. These
are the same readers Parts 2–5 fixed under the H-on-disk setup, now reached through the clear:
S7 (`add a/f` → `sparse: ['a/f']`, disk `S`), S7b (`add -A` → a/f not staged; disk compared
twin-to-twin), K1 (`CHECKOUT_OVERWRITE_DIRTY {localChanges:['a/f']}` vs exit 1), K2 (switch, a/f
removed, `S`), K3 control, K4 (`checkout -f t2` → removed), K5 (`checkout({paths:['a/f']})` → a/f=`base`, `H`),
K6 (`checkout -b` → index untouched), T1, T2, T3, S2 (warning text
`The following paths are not up to date and were left despite sparse patterns:` via the logger, and
`H`), P1, P2, R1 (`reset --hard` → removed, `S`), R2 (mixed → `H`), and S10
(`sparseCheckout.reapply` → `retained: ['a/f']`, `H`). `rm` (M1, M1a) stays out of scope (D-J
deferred); do not add rows.

Posix-only rows (run by `npm run test:posix-integration`, not by `validate`): S6 (live symlink at
a/f → ` T a/f`), S6b (dangling), E2 (a → symlink to a directory holding f → ` D a/f`, `?? a`,
a/f cleared), X1 (`chmod 000 a` with a/f inside → nothing cleared, status succeeds on both; skip when
running as root).

Regression watch (R2 changes `readIndex` for every caller under sparse). Run every suite that
touches sparse or skip-worktree. Write the list with
`rtk proxy rg -l "sparseCheckout|skip-worktree|skipWorktree|sparse-checkout" test > <scratch>/sparse-suites.txt`
(96 files at plan time). Run it with
`./node_modules/.bin/vitest run $(cat <scratch>/sparse-suites.txt) > <scratch>/sparse-run.txt 2>&1`,
then grep the failures. Every changed assertion must map to a design or pin row (S-, K-, T-, P-, R-,
W-axis). Record the mapping in the handback. Anything unexplained is a blocker, not an update.
Expected: suites that leave a file at an S path under sparse with default config now see it
(e.g. `status` reports it, `stash` warns `left despite sparse patterns`). Twin suites that compare
`ls-files -t` with stock git keep passing, because both sides clear on read. Their oracle is
tightened in Part 10.

Bench gate (ADR-1243). Commit first, then measure ("bench:ab after the commit"). Check that the
machine is quiet: `uptime`, and no foreign `stryker`/`vitest` process (`pgrep -fl stryker`). Run
`npm run bench:ab -- <Part 6 sha> HEAD 3 status-sparse.bench.ts > <scratch>/ab.txt 2>&1` and read
the comparison rows. The gate is that the `present-directories` scenario regresses ≤ 10% against the
Part 6 commit.
- If it is above 10%, ADR-1243 option 2 replaces the sequential walk. Group the candidates by parent
  directory. Resolve each distinct parent once, sequentially through `presentPaths`'s
  missing-directory logic. Then probe the leaves under present parents with
  `boundedMapFor(ctx, 'ioBound', leaves, probe)` (src/application/primitives/internal/concurrency.ts).
  The answers must be identical; the Part 7 property suite is the oracle.
- Land it as a follow-up commit `perf(sparse-checkout): probe skip-worktree leaves under bounded concurrency`
  and re-run the A/B.

### TDD steps

1. RED unit (read-index.test.ts): `Given sparse on and an S entry whose file is on disk` > `When readIndex runs` > `Then the entry has no bit`. It fails because `readIndex` returns the raw parse.
2. RED unit: `Given the same session` > `When a file appears at an S path between two readIndex calls with no index write` > `Then the second call clears it`. Add the vanish case too (cleared, then file removed → S again). Both fail for the same reason.
3. RED unit: `When readIndexAt runs` → the bit is kept. This is a GUARD (raw today). Also `readIndex` with nothing to clear returns the cached object (`toBe` across two calls), another GUARD.
4. GREEN: `readRawIndex` plus the clear.
5. GUARD interop: the status, readers and posix rows above. They pass after step 4. On main most fail (e.g. S1 is clean instead of ` M a/f`, K2 keeps the file, R2 gives `S`). Note in the handback any row that already passed on main.
6. Regression watch (above). Fold every explained change in this part. A src change in a reader to fix an unexplained red is a blocker.
7. REFACTOR, then run `npm run check:test-pyramid`.
8. Commit. Then run the bench gate, and the conditional perf commit if it fails.

### Gate

`./node_modules/.bin/vitest run test/unit/application/primitives/read-index.test.ts test/integration/skip-worktree-present-files-status-interop.test.ts test/integration/skip-worktree-present-files-readers-interop.test.ts && ./node_modules/.bin/vitest run --project posix-integration test/integration/posix-only/skip-worktree-present-files-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/read-index.ts test/unit/application/primitives/read-index.test.ts test/integration/skip-worktree-present-files-fixtures.ts test/integration/skip-worktree-present-files-status-interop.test.ts test/integration/skip-worktree-present-files-readers-interop.test.ts test/integration/posix-only/skip-worktree-present-files-interop.test.ts && npm run check:spelling && npm run check:test-pyramid`

### Commit

`fix(sparse-checkout): clear the skip-worktree bit of present files at every index read as git does`

## Part 9 — Snapshot index rows clear above the cache (ADR-1244, DC-4)

### Context

Files this part edits or creates:
- `src/adapters/snapshot-resolvers/raw-index-resolver.ts`
- `src/adapters/snapshot-resolvers/clearing-index-resolver.ts` (new; internal, not exported from any public entry)
- `src/repository.ts`
- `test/unit/adapters/snapshot-resolvers/raw-index-resolver.test.ts`
- `test/unit/adapters/snapshot-resolvers/clearing-index-resolver.test.ts` (new)

Pin 5: `createCachingIndexResolver(inner, fs, stream, view)` returns `entry.parsed` on the same
generation, or on a stat-validated hit of .git/index. After Part 8 its inner resolver
(`createRawIndexResolver()` → `readIndex`) returns the **cleared** parse, so a later resolve serves
a bit cleared before a file appeared or vanished.

Target:
- `createRawIndexResolver` → `resolve: (ctx) => readRawIndex(ctx)`, imported from src/application/primitives/read-index.ts by module path (`readRawIndex` landed in Part 8). Update its doc comment.
- New `createClearingIndexResolver(inner: IndexResolver): IndexResolver` → `resolve: async (ctx, opts) => clearSkipWorktreeFromPresentFiles(ctx, await inner.resolve(ctx, opts))`.
- repository.ts, the line that builds `indexResolver` (≈ line 503: `createSingleFlightIndexResolver(createCachingIndexResolver(createRawIndexResolver(), ctx.fs, bus.stream, view))`), becomes the clearing resolver wrapping that whole stack.
- `IndexResolver` (src/ports/snapshot-resolvers.ts) is public but unchanged. The `create*` factories are not in reports/api.json, so there is no surface gate.

Test models (read-only): test/unit/adapters/snapshot-resolvers/caching-index-resolver.test.ts
(`wrapCounting`, stream/view setup) and test/unit/adapters/snapshot-resolvers/single-flight-index-resolver.test.ts.

### TDD steps

1. RED (clearing-index-resolver.test.ts): `Given the composed stack over a sparse memory repo with an S entry` > `When a file appears at the S path between two resolves with no index write` > `Then the second resolve reports the bit cleared`. Build the stack exactly as repository.ts does. It fails because the module is missing. With only the raw resolver changed, the caching layer would serve the stale bit.
2. RED same file: the vanish case (cleared, then the file removed → S on the next resolve). Also `bypassCache` passes through to the inner resolver (assert with a counting inner).
3. GREEN: the decorator and the repository wiring. The appear case passes now. The vanish case stays red: the cache holds an already-cleared parse that nothing re-marks.
4. RED (raw-index-resolver.test.ts): `Given sparse on and a present file at an S path` > `When the raw resolver resolves` > `Then the bit is kept`. It fails because the raw resolver still calls `readIndex`.
5. GREEN: `createRawIndexResolver` reads `readRawIndex`. The vanish case passes.
6. GUARD: the existing caching-index-resolver suites (mutation and properties) pass unchanged. The caching layer is untouched.
7. REFACTOR.

### Gate

`./node_modules/.bin/vitest run test/unit/adapters/snapshot-resolvers/ test/unit/repository/repository.test.ts && npm run check:types && ./node_modules/.bin/biome check src/adapters/snapshot-resolvers/raw-index-resolver.ts src/adapters/snapshot-resolvers/clearing-index-resolver.ts src/repository.ts test/unit/adapters/snapshot-resolvers/raw-index-resolver.test.ts test/unit/adapters/snapshot-resolvers/clearing-index-resolver.test.ts && npm run check:spelling && npm run check:architecture`

### Commit

`fix(snapshot): clear skip-worktree bits per resolve above the index cache`

## Part 10 — Sparse twins read stored bits (lesson 047; test-infra, no `src/` delta)

### Context

Files this part may edit. Each one's oracle reads `git ls-files -t` with stock config:
- `test/integration/checkout-unborn-switch-interop.test.ts` (`probe(dir, ['ls-files', '-t'])`)
- `test/integration/eol-conversion-interop.test.ts` (`tags: git(dir, 'ls-files', '-t')`)
- `test/integration/occupant-displacement-fixtures.ts` (`runGit(['-C', dir, 'ls-files', '-t'])`)
- `test/integration/sparse-checkout-worktree-config-interop.test.ts` (`gitTagView`)
- `test/integration/sparse-checkout.test.ts` (around `When git ls-files -t reads it`)
- `test/integration/sparse-reset-merge.test.ts` (`lsFiles` read)

After Part 8, stock git clears present files on read on both twins, so a tag comparison cannot see a
stored-bit difference. That is lesson 047; the model is the `tagged()` helper in
test/integration/sequencer-sparse-cone-writes-interop.test.ts. Switch each **twin comparison**
oracle to `git -c sparse.expectFilesOutsideOfPatterns=true ls-files -t` and also compare the disk
listing. Leave a single-repository check whose subject is git's own read view as it is, with a
one-line comment why (sparse-checkout.test.ts's "When git ls-files -t reads it" is likely one).
A twin row where git itself writes the cleared bit (a refused `stash apply`) keeps an explicit
override with a comment, as lesson 047's evidence does.

### TDD steps

1. For each file: switch the oracle. These are GUARD entries: they pass when tsgit's stored bits equal git's, which Parts 2–9 deliver. Run each file. A red here is a stored-bit divergence the earlier parts missed: record `{ file, row, git disk, tsgit disk }` and hand back as a blocker. Do not patch `src/` in this part.
2. Run `npm run check:test-pyramid`.

### Gate

`./node_modules/.bin/vitest run test/integration/checkout-unborn-switch-interop.test.ts test/integration/eol-conversion-interop.test.ts test/integration/occupant-displacement-fixtures.ts test/integration/sparse-checkout-worktree-config-interop.test.ts test/integration/sparse-checkout.test.ts test/integration/sparse-reset-merge.test.ts && npm run check:types && ./node_modules/.bin/biome check test/integration/checkout-unborn-switch-interop.test.ts test/integration/eol-conversion-interop.test.ts test/integration/occupant-displacement-fixtures.ts test/integration/sparse-checkout-worktree-config-interop.test.ts test/integration/sparse-checkout.test.ts test/integration/sparse-reset-merge.test.ts && npm run check:spelling && npm run check:test-pyramid`

(occupant-displacement-fixtures.ts holds no tests; vitest ignores it. Its importers are covered by the phase gate `npm run validate`.)

### Commit

`test(interop): read sparse twin tags without git's present-file clear`

## Requirement → part map

| Req | Part(s) |
|---|---|
| R1 | 1 (reader), 8 (interop rows E4b, E4c, O4, S4b) |
| R2 | 7 (primitive), 8 (wiring + rows) |
| R3 | 7 (short circuits, identity, cache), 8 (bench gate) |
| R4 | 8 (`readIndexAt` raw; writer rows W, C1, W11) |
| R5 | 2 (H-on-disk rows), 8 (natural rows S7, S7b) |
| R6 | 3, 8 (K6) |
| R7 | 4, 8 (P1, P2) |
| R8 | 4, 8 (T2) |
| R9 | 5, 8 (R2) |
| R10 | 1 |
| R11 | 8 (`primitives.readIndex` row), 9 (snapshot rows) |
| ADR-1243 bench | 6, 8 |
| Lesson 047 | 10 (plus every new suite's `tagsOf`) |
