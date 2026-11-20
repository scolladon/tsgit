<!-- cspell:ignore lstat lstats errno ENOTDIR EACCES sdir ignorecase expectfilesoutsideofpatterns sparsecheckout -->
# Design — skip-worktree-present-files

> Brief: backlog 32.82. Under sparse checkout with `sparse.expectFilesOutsideOfPatterns` at its
> default (`false`), git's index read clears the skip-worktree bit of every entry whose path is
> present on disk. tsgit's index read keeps the bit, so `status()` reports clean where git reports
> ` M a/f`, and `stash.apply()` refuses without writing the cleared bit back. The re-pin confirms
> the brief and widens the perimeter. Once tsgit clears the bit, four readers that used the bit as a
> stand-in for "outside the sparse patterns" diverge from git in new ways. `add` stages a file git
> refuses. `checkout -b` persists a bit git never writes. `stash push` restores a file git retires.
> `reset --mixed` and `stash apply` are also affected. One config key and its eager refusal are new.
> Status: draft → self-reviewed ×3

## Context

### The corrected backlog statement

Re-pinned on main ac037122 against git 2.56.0 (macOS, `GIT_*` scrubbed, isolated `HOME`,
`GIT_CONFIG_NOSYSTEM=1`, signing off). Every git row ran under `core.ignorecase=false` and `=true`.
The output is byte-identical between the two (lesson 042). The tsgit rows ran the same way against
an esbuild bundle of `src/index.node.ts`. The `ts-probe.mjs` rows ran under both values and were
identical. P1, M1a and K6 ran under `false` only.

- **Confirmed:** `status` (S1), the persisted bit after a refused `stash apply` (T1: exit 128,
  `H a/f`), and tsgit's `S a/f` with `STASH_APPLY_WOULD_OVERWRITE`.
- **Corrected:** "`status` writes `H a/f` back" holds only sometimes. git's `status` writes the
  index only when its refresh changed an entry or an entry is racy (W9). The clear itself never
  marks the index changed (`sparse-index.c`: the clear is `ce->ce_flags &= ~CE_SKIP_WORKTREE` with
  no `cache_changed`). One of six repeat runs kept `S a/f` on disk. The persisted bit is
  deterministic only for writers that always write: `stash apply`/`push`
  (`repo_refresh_and_write_index` with `write_flags = 0`), path `checkout`, `commit`, and `add`
  when it changes something.
- **Newly found:** the scope is wider than the four readers the brief names. The pins below show a
  tsgit build that only clears the bit would:
  - stage an out-of-pattern file through `add` (A1, A2), which git refuses;
  - persist `H` through `checkout -b` (K6), which git never writes;
  - restore a file `stash push` should retire (P1);
  - keep a stashed change on disk that `stash apply` retires (T2);
  - re-mark `S` where `reset --mixed` keeps `H` (R2).

### git's rule (v2.56.0, `sparse-index.c`, `repository.c`; behaviour pinned below)

- `repo_read_index` calls `read_index_from`, then `clear_skip_worktree_from_present_files`. Every
  porcelain reader goes through it, including `stash.c`'s `repo_read_index_preload`.
  Re-reading the index during a command clears the bits again.
- `clear_skip_worktree_from_present_files` returns at once unless `core.sparseCheckout` is on
  and `sparse.expectFilesOutsideOfPatterns` is off. Both are resolved through the layered config,
  so `config.worktree` takes part when `extensions.worktreeConfig` is on (S4, S4b, S4c, E4b).
- For each skip-worktree entry in index order, `path_found(ce->name)` decides presence:
  1. If a cached missing directory `dir` (ending in `/`) prefixes the path, the answer is "absent"
     and no `lstat` runs.
  2. Otherwise it runs `lstat(path)`. Success means present, whatever stands there: a file, a
     directory (S5, S5b), a live or dangling symlink (S6, S6b), or a case variant on a
     case-insensitive filesystem (S13). A leading symlinked directory is followed (E2).
  3. On any `lstat` failure, the file is treated as absent: ENOENT, ENOTDIR (E1), and EACCES
     (X1, which neither warns from the clear nor clears). Then it grows `dir` from the common
     prefix with the previous `dir`, one component at a time. It runs `lstat` on each
     component and stops at the first missing one, which becomes the new `dir`. If none is
     missing, `dir` becomes `path + "/"`.

  The cache only saves work, because an entry beneath a missing directory can never be found. So
  the observable rule is "clear the bit if `lstat(path)` succeeds". The cost is about one `lstat`
  per S entry in a present directory, plus about two per absent directory subtree.
- On a sparse index (`index.sparse=true`), when a sparse-directory entry is present, git expands
  the index to full and runs the full pass (I1–I3). tsgit has no sparse-directory entries (no
  `sdir` support in `src`). Out of scope.
- `sparse.expectfilesoutsideofpatterns` is parsed by `git_default_sparse_config` with
  `git_config_bool`. A bogus value is fatal for every command that loads the default config,
  `rev-parse` included, even with sparse off (E3, E3b, O3). The fatal error names the first bad
  entry in file order across `[core]` and `[sparse]` (O1, O2). A valueless key is `true` (O4).
- Consumers that decide on the sparse **patterns**, not the bit. Their behaviour shows once the
  bit is cleared:
  - `add` (`builtin/add.c`): the tracked-update callback skips `!path_in_sparse_checkout(path)`
    (A2). The untracked walk reports `!path_in_sparse_checkout` as sparse (A1, S7). Renormalize
    and chmod skip `ce_skip_worktree(ce) || !path_in_sparse_checkout`.
  - `rm` (`builtin/rm.c`): `ce_skip_worktree(ce) || !path_in_sparse_checkout` refuses (M1, M1a).
  - `checkout -- <path>` decides on the **bit** (`checkout_paths` skips `ce_skip_worktree`). A
    cleared entry is restored (K5).
  - `unpack_trees` re-applies the patterns on a switch, a forced checkout, `reset --hard`, and
    `stash push`'s reset (K2, K4, R1, P1). A clean out-of-pattern `H` entry is retired: the file
    is removed and the entry marked `S`. A dirty one is left `H` with the warning
    `The following paths are not up to date and were left despite sparse patterns:` (S2, S10).
  - `reset --mixed` keeps each entry's bit from the index it read (R2, R2x).

### Code map (names, not line numbers)

| Where | Symbol | Role today |
|---|---|---|
| `src/application/primitives/read-index.ts` | `readIndex(ctx): Promise<GitIndex>`, `readIndexAt(ctx, stat): Promise<GitIndex>`, `loadIndex`, the session `cache` (`IndexCacheEntry { key, index: Promise<GitIndex> }`), `invalidateIndexCache` | parses, verifies and caches `.git/index` by the index file's own `(size, mtimeMs, mtimeNs, ino)`. **No work-tree I/O.** Public through `repository.ts` (`primitives.readIndex`) |
| `src/application/primitives/internal/smudge-racily-clean.ts` | `readPreviousIndex(ctx)` → `readIndexAt` | the index-lock commit's view of the on-disk index: stat data, extensions and the trailer. It never looks at flags (`statDataKey`, `carriedOver`) |
| `src/application/primitives/internal/index-lock.ts` | `commitLocked`, `writeRefreshed` (`commitRefresh`), `withRefreshedStat`, `changeSince` → `diffIndexEntries` | writes the entries it is given, with their flags. `diffIndexEntries.differs` compares `id`/`mode` only, so a flag change never touches the carried extensions |
| `src/application/primitives/read-sparse-config.ts` | `readSparseConfig(ctx): Promise<SparseConfig { enabled; cone }>`, `coreKeyEntries(sections, keys)`, `lastValidBoolean`, `isWorktreeConfigExtensionOn` | the local + `config.worktree` overlay for the two `[core]` sparse keys. **No `[sparse]` section reader.** Nothing in `src` reads `sparse.expectFilesOutsideOfPatterns` |
| `src/application/primitives/read-sparse-checkout.ts` | `loadSparseMatcher(ctx): Promise<SparseMatcher \| undefined>` | the pattern matcher (undefined when sparse is off) |
| `src/application/primitives/internal/repo-state.ts` | `CORE_BOOLEAN_KEYS`, `computeGateVerdict`, `pickLowerLine`, `WORKTREE_BOOLEAN_KEYS`, `firstWorktreeRefusal`, `assertWorktreeCoreBooleansValid` | the eager gate (`CONFIG_BAD_BOOLEAN_VALUE`). Only the `[core]` section |
| `src/application/primitives/internal/fs-probes.ts` | `lstatIfReachable(fs, path)` | treats ENOENT and ENOTDIR as absent and rejects every other refusal |
| `src/application/primitives/internal/scan-tracked-entries.ts`, `compare-working-tree-entry.ts` | the `skipWorktree` skips | `status`, `rm`, `stash` change detection and refresh skip S entries. They inherit a cleared bit for free |
| `src/application/commands/status.ts` | `updateIndexIfAble` (`refreshed.length === 0 && !racy` → release) | the opportunistic write-back, same rule as git |
| `src/application/commands/internal/refresh-index.ts` | `refreshAndWriteIndex`, `refreshedIndex` | git's `refresh_and_write_cache`: an unconditional write. `stash apply` and `push` run it first, so they persist a cleared bit for free (T1, S2) |
| `src/application/commands/add.ts` | `splitSparseLiterals` (`namesSkipWorktree`), `withoutSkipWorktree`, `skipWorktreeOf`, `refuseUnseenRenormalized`, `verdictsOf`, and the `!entry.flags.skipWorktree` filters in the tracked passes | **bit-based** stand-ins for git's pattern predicates. They are right only while the bit is never cleared |
| `src/application/commands/checkout.ts` | `switchIndex`, `restorableUniverse` (bit-based, as git) | `checkout -b` on the same commit rewrites the index (K6: tsgit `index-rewritten=yes`, git `no`) |
| `src/application/commands/stash.ts` | `resetAfterPush` → `materializeTreeJudging(…, { force: true, forceRewriteAll: true }, 'oneway')` with **no `sparse`**; `reinstateIndex`; `stashApply` → `refreshAndWriteIndex` | push's reset does not re-apply the patterns (lesson 038: `materializeTree`'s `sparse` option) |
| `src/application/primitives/build-index-from-tree.ts` | `projectLeaf`, `includedFlags` | `reset --mixed` marks S from the **patterns** (`docs/design/sparse-reset-merge.md` §4), not from the read bit |
| `src/adapters/snapshot-resolvers/raw-index-resolver.ts`, `caching-index-resolver.ts` | `createRawIndexResolver` → `readIndex` | snapshot index rows. The caching layer keys on the index file |

32 non-test files call `readIndex`. Besides the rows above, these modules read the bit with the
meaning git's code gives it, so a cleared entry behaves as git's cleared entry does:
`materialize-tree.ts` (the hidden/in-scope split), `apply-merge-to-worktree.ts`,
`internal/sparse-movers.ts`, `internal/stale-entries.ts`, `internal/clean-work-tree.ts`,
`internal/submodule-absorb.ts`, `internal/apply-sparse-checkout.ts`, and
`internal/check-out-skipped-changes.ts`. The simulated rows K2, K4, R1 and S2 show the
materialisation path agreeing with git. The rest (`blame`, `grep`, `rev-parse`, `fsck/roots`,
`read-gitattributes`, `submodule`, `worktree`, `mv`, `pull`, the `rebase` family,
`write-index-cache-tree`, `materialize-worktree-from-head`, `apply-changeset`) ignore the bit or
pass the entries to a writer. A writer persists the cleared bit exactly when it writes. The rows
in Axis W say when git writes.

### Constraining ADRs, doctrine, lessons

- ADR-226 (prime directive), ADR-249 (no new field: `status` gains a change, not a shape),
  ADR-1170 (filing bar).
- ADR-1184–1186: the overlay of the sparse keys from `config.worktree` and its gate. This design
  extends both to `sparse.expectFilesOutsideOfPatterns`. ADR-182 / `config-read.ts`
  `loadConfigEntry`: typed reads are local-only by containment, so global and system scopes stay out.
- ADR-1213 (a dirty out-of-pattern file is left with a warning), ADR-1216 (stash apply checks out
  skipped changes before unstaging): the warning path that S2/S10 exercise once the bit is cleared.
- DOCTRINE D-2: a row the change newly reaches that inherits a divergence on main is folded with
  an interop pin per consumer. D-3: a pinned refusal mismatch in an edited function is folded,
  marked `!`. D-5: a divergence proven in an edited seam is folded per consumer.
- Lessons: 033 (re-pinned here), 038 (consumer table from the primitive, not the function),
  042/045 (ignorecase twins, twin in the Given slot), 046 (one interop row per branch), 047 (read
  twin tags with `-c sparse.expectFilesOutsideOfPatterns=true` and compare the disk listing).

## Pinned matrix (git 2.56.0, tsgit main ac037122, 2026-11-20)

Fixture: commit `a/f`=`base`, `a/g`, `a/d/x`, `b/f`; cone patterns `/*\n!/*/\n/b/\n`;
`read-tree -mu HEAD` → `S a/d/x S a/f S a/g H b/f`, `a/` absent. Then the row's change ("present"
= `mkdir -p a; echo hi > a/f`). "disk" is the index as read with
`-c sparse.expectFilesOutsideOfPatterns=true ls-files -t`, so the reading does not clear. "tsgit
post-fix (sim)" runs tsgit after clearing the bit **on disk** with
`update-index --no-skip-worktree a/f`. It predicts a tsgit that only clears the bit. It cannot
model a mid-command re-read, and a non-writing command keeps the simulated `H`. Scripts:
`git-probe.sh`–`git-probe5.sh`, `ts-probe.mjs`, `ts-probe2.mjs` in the session scratchpad (not
committed).

### Axis S — read-only readers and `status`

| Row | Setup | git | tsgit main | tsgit post-fix (sim) |
|---|---|---|---|---|
| S1 | present `hi` | ` M a/f`; disk S or H (opportunistic) | clean | ` M a/f` ✓ |
| S1b/S1c | `ls-files -t` / `diff-files` | `H a/f` / `M a/f`; never writes | — | — |
| S8 | present, same content | clean; `H` when written | clean | (= S1 logic) |
| S5 / S5b | directory at `a/f` (non-empty / empty) | ` D a/f` | clean | — |
| S6 / S6b | live / dangling symlink at `a/f` | ` T a/f` | clean | — |
| S12 | `a/d/x` present, `a/f` absent | ` M a/d/x`; only `a/d/x` cleared | clean | — |
| S13 | `A/f` present (case-insensitive FS) | ` M a/f` (+`?? A/` under ignorecase=false) | clean | — |
| S14 | non-cone `/*\n!/a/\n` | ` M a/f` | — | — |
| E1 | `a` is a regular file | `?? a`; nothing cleared (ENOTDIR) | `?? a` | — |
| E2 | `a` → symlink to a dir holding `f` | ` D a/f`, `?? a`; `a/f` cleared | `?? a` | — |
| X1 | `a/` mode 000, `a/f` inside | warning from the untracked walk only; nothing cleared (EACCES) | — | — |
| D1 | `diff HEAD` | `M a/f` | — | — |

### Axis C — config

| Row | Config | git `status` |
|---|---|---|
| S3 | `-c sparse.expectFilesOutsideOfPatterns=true` | clean, no clear (tsgit has no `-c` scope) |
| E4 / E4d | local `true` / `1` | clean, no clear |
| E4b | local `true`, `config.worktree` `false` (extension on) | ` M a/f` — the worktree file wins |
| S4 | `config.worktree` `true` (extension on) | clean |
| E4c | local `true` then `false` in one file | ` M a/f` — the last entry wins |
| O4 | local valueless `expectFilesOutsideOfPatterns` | clean — valueless is `true` |
| S4b / S4c | `core.sparseCheckout` only in `config.worktree`, extension on / off | cleared / not cleared |
| S11 / S15 | `core.sparseCheckout=false` / bit set by `update-index --skip-worktree` without sparse | no clear |
| E3 / E3b | `bogus` in local / in `config.worktree` | `fatal: bad boolean config value 'bogus' for 'sparse.expectfilesoutsideofpatterns'`, exit 128 |
| O3 | `bogus`, sparse off; also `rev-parse HEAD` | same fatal, exit 128 |
| O1 / O2 | `[sparse]` bogus before `[core] filemode = bogus` / after it | the first in file order is named |

tsgit main: `status()` succeeds on E3 (clean).

### Axis W — which git commands write the index (so persist a cleared bit)

`index-rewritten` = the index mtime moved (1.1 s apart).

| Row | Command, `a/f` present | git writes | disk after |
|---|---|---|---|
| W1–W3 | `add -A` | yes (even with `a/f` absent) | `H a/f` only when the clear ran |
| W4/W5 | `add b/f` | yes | `H a/f` |
| W6 | `add a/f` (refused) | no | `S a/f` |
| W7/W8 | `checkout -b other` (same commit) | **no** | `S a/f` |
| W9 | `status` twice | yes, then no | `H a/f` |
| W10 | `commit -a` (nothing to commit) | no | `S a/f` |
| W11 | `commit` of a `b/f` change | yes | `H a/f` |

### Axis R — per reader

| Row | Command | git | tsgit main | tsgit post-fix (sim) |
|---|---|---|---|---|
| S7 | `add a/f` | exit 1, lists `a/f` as outside the sparse definition; nothing staged; disk `S` | `sparse: ['a/f']`, disk `S` | **stages `a/f`** (`modified: ['a/f']`) ✗ |
| A1 | `add a/f`, bit `H` on disk, expect=true | exit 1, same list, nothing staged | — | — |
| S7b / A2 | `add -A` | exit 0, `a/f` **not** staged; disk `H` | nothing staged, disk `S` | **stages `a/f`** ✗ |
| S7c | `add --sparse a/f` | stages, `H` | (no `--sparse` surface) | — |
| M3 | `add -u` | exit 0, disk `H` | — | — |
| C1 | `commit -a` | exit 1, nothing committed, disk `S` | `NOTHING_TO_COMMIT` | `NOTHING_TO_COMMIT` ✓ |
| K1 | `checkout t2` (t2 changes `a/f`), `a/f`=`hi` | exit 1 `would be overwritten by checkout: a/f`; disk `S`; `a/f`=`hi` | **switches**, `a/f`=`hi` kept | `CHECKOUT_OVERWRITE_DIRTY {localChanges:['a/f']}` ✓ |
| K2 | same, `a/f`=`base` | switches; `a/f` removed; `S` | switches, `a/f`=`base` left | removed, `S` ✓ |
| K3 | same, `a/f` absent (control) | switches, `S` | — | — |
| K4 | `checkout -f t2`, `a/f`=`hi` | removed, `S` | `a/f`=`hi` left | removed, `S` ✓ |
| K5 | `checkout -- a/f`, `a/f`=`hi` | exit 0; `a/f`=`base`; disk `H` | `PATHSPEC_NO_MATCH` | `a/f`=`base`, `H` ✓ |
| K6 | `checkout -b other`, `a/f`=`hi` | no index write; `S` | **rewrites the index**; `S` | would persist `H` ✗ |
| T1 | `stash apply`, stash changes `a/f`, `a/f`=`junk` | exit 128 `would be overwritten by merge: a/f`; disk `H`; `a/f`=`junk` | `STASH_APPLY_WOULD_OVERWRITE`, disk `S` | `STASH_APPLY_WOULD_OVERWRITE` ✓; disk `H` not observable in the sim (already `H`), reasoned from `stashApply` → `refreshAndWriteIndex` writing the read entries |
| T2 | same, `a/f`=`base` | exit 0; **`a/f` absent**; disk `H a/f` at HEAD's blob `df967b9`; `status` `deleted: a/f` | `a/f`=`st`, `H` | `a/f`=`st`, `H` ✗ |
| T3 | same, `a/f` absent (control) | `a/f`=`st`, `H` | `a/f`=`st`, `H` ✓ | — |
| S2 | `stash apply`, stash changes `b/f` only, `a/f`=`hi` | exit 0; warning `…left despite sparse patterns:\n\ta/f…`; disk `H` | no warning, `S` | same warning, `H` ✓ |
| P1 | `stash push`, `a/f`=`hi` | saves (stash tree `a/f`=`45b983b`); `a/f` removed; `S` | `no-local-changes`; `a/f` kept | saves `45b983b`; **`a/f`=`base` written, `H`** ✗ |
| P2 | `stash push` (`b/f` changed), `a/f`=`base` | saves; `a/f` removed; `S` | — | — |
| R1 | `reset --hard` | `a/f` removed, `S` | `a/f` kept, `S` | removed, `S` ✓ |
| R2 | `reset` (mixed) | `a/f` kept, **`H`** | `S` | **`S`** ✗ |
| R2x | `reset` (mixed), `H` on disk, expect=true (no clear) | `H` kept | — (sim of R2 = `S`) | — |
| R2a | `reset` (mixed), `a/f` absent | `S` | — | — |
| M1 | `rm a/f`, `a/f`=`hi` | exit 1, outside the sparse definition, disk `S` | `RM_LOCAL_MODIFICATIONS` | `RM_LOCAL_MODIFICATIONS` ✗ (unchanged) |
| M1a | `rm a/f`, `a/f` absent | exit 1, same refusal | **removes `a/f`** | — (no clear involved) |
| M2 | `rm --cached --sparse a/f` | removes the entry | (no `--sparse` surface) | — |
| S10 | `sparse-checkout reapply` | warning; `H` | `retained: ['a/f']`; `H` ✓ | — |
| I1–I3 | sparse index: `a/f` present / `add -A` / empty `a/` | expands; `S a/d/ H a/f S a/g`; empty `a/` → no expansion, `S a/` | no sparse-index support | — |

## Requirements

- **R1** One reader resolves `sparse.expectFilesOutsideOfPatterns` as git does in tsgit's scopes.
  The `config.worktree` value (extension on) wins over local. The last entry in a file wins. The
  value uses git's boolean grammar, valueless being `true`. The default is `false` (S4, E4–E4d, O4).
- **R2** Every `readIndex` call returns the index with the skip-worktree bit cleared on each entry
  whose path `lstat`s successfully. This happens only when R1 is `false` and the layered
  `core.sparseCheckout` is on (S1–S15, E1, E2, X1). Any `lstat` failure means absent. The result is
  computed per call, after the cache, so a file appearing or vanishing between two reads is seen
  (git re-clears on every `repo_read_index`).
- **R3** The cost is bounded as git bounds it. There is no work when sparse is off, R1 is `true`, or
  the index holds no S entry. Otherwise there is one `lstat` per S entry outside a known-missing
  directory, plus a missing-directory cache that skips whole absent subtrees. The cached parse is
  never mutated, and the cached object is returned when nothing clears.
- **R4** `readIndexAt` (and so the index-lock's `readPreviousIndex`) stays a raw parse. A writer
  persists exactly the flags of the entries it commits. So a cleared bit reaches disk only when
  the command writes, as in git (W1–W11).
- **R5** `add` decides "outside the sparse definition" with git's predicates. The tracked-update
  passes use the patterns. Literal reporting and the untracked walk use the bit or the patterns
  where git does. A cleared out-of-pattern file is neither staged nor removed, and its literal is
  reported in `AddResult.sparse` (S7, A1, S7b, A2, M3).
- **R6** `checkout -b` (and `createBranch` on the current commit) does not write the index, as
  git's fast path does (K6, W7, W8).
- **R7** `stash push`'s reset re-applies the sparse patterns: a clean out-of-pattern file is
  retired and marked `S` (P1, P2).
- **R8** `stash apply` of a change to a cleared out-of-pattern clean file leaves the file absent
  and the entry `H` at the pre-apply blob (T2).
- **R9** `reset --mixed` carries the read entry's bit for a path whose `(mode, id)` is unchanged,
  instead of re-marking from the patterns (R2, R2x, R2a).
- **R10** A bogus `sparse.expectFilesOutsideOfPatterns` in local or active `config.worktree` is
  refused by the eager gate with `CONFIG_BAD_BOOLEAN_VALUE`, ordered by file line against the
  `[core]` keys, whatever `core.sparseCheckout` says (E3, E3b, O1–O3).
- **R11** No public signature change. `primitives.readIndex` returns git's `repo_read_index`
  view, the one `ls-files -t` shows.

R6–R9 are conditional on the decisions below. R5 is not: without it the change ships a
regression (S7, A2 sim).

## Design

### 1. The config reader (R1)

Context:
- `src/application/primitives/read-sparse-config.ts`: `coreKeyEntries(sections, keys)` filters
  `[core]` only. `lastValidBoolean(entries, wanted)`. `readWorktreeKeys`.
- `src/application/primitives/config-read.ts`: `findLastEntry(ctx, section, key)` reads the local
  file, with the last entry winning.
- `src/domain/config/config-ini.ts`: `parseGitBoolean(value | null)`.

Generalise `coreKeyEntries` into `sectionKeyEntries(sections, section, keys)`, keeping
`coreKeyEntries` as the `[core]` partial so its callers stay unchanged. Add
`expectFilesOutsideOfPatterns: boolean` to `SparseConfig`:

```ts
// read-sparse-config.ts
export interface SparseConfig {
  readonly enabled: boolean;
  readonly cone: boolean;
  readonly expectFilesOutsideOfPatterns: boolean;
}
```

Resolve it as `worktree ?? local ?? false`, where `local` = `findLastEntry(ctx, 'sparse',
'expectFilesOutsideOfPatterns')` parsed with `parseGitBoolean`. A bogus value never reaches here,
because the gate (§6) refuses first. `readSparseConfig` gets one more caller.
`loadSparseMatcher` ignores the new field.

### 2. The clear (R2, R3, R4)

Context:
- `src/application/primitives/read-index.ts`: `readIndex`, `readIndexAt`, `cache`.
- `src/application/primitives/internal/fs-probes.ts`: `lstatIfPresent`, `lstatIfReachable`.
- `src/domain/git-index/index.ts`: `GitIndex`, `IndexEntry.flags.skipWorktree`.
- The working tree root: `ctx.layout.workDir` (the same root `scan-tracked-entries.ts` joins
  against).

New `src/application/primitives/internal/clear-skip-worktree-from-present-files.ts`:

```ts
/** git's clear_skip_worktree_from_present_files: the bit of every present S entry is cleared. */
export const clearSkipWorktreeFromPresentFiles = async (
  ctx: Context,
  index: GitIndex,
): Promise<GitIndex>;
```

- Short circuits run in cost order:
  1. No work tree (`ctx.layout.workDir` undefined, a bare layout): return `index`. There is no
     file to find. git would `lstat` relative to its cwd, which is unpinned and not reachable
     through tsgit's API.
  2. No S entry: return `index` without reading config. The scan is O(n) once per parse. For a
     cached parse it is memoised next to the cache entry, so later calls are O(1).
  3. `readSparseConfig` says disabled or expecting files: return `index`.
- `path_found` is ported as a pure state machine over a `MissingDirectory` value (`dir` +
  `commonDirPrefix`), with the `lstat` injected. A domain function holds the prefix arithmetic
  (`src/domain/sparse/missing-directory.ts`). The application primitive owns the I/O.
- Presence means any successful `lstat`. A failure (any errno) means absent (X1). The probe is a
  new `fs-probes.ts` helper `isLstatable(fs, path): Promise<boolean>`. It is the one place that
  reads a refusal as absence. Its doc comment explains why: git's `path_found` does the same.
- The function returns a new `GitIndex` with only the cleared entries replaced
  (`{ ...entry, flags: { ...entry.flags, skipWorktree: false } }`). `version`, `extensions`,
  `trailerSha` and `indexMtime` carry over unchanged. `commitRefresh` compares `trailerSha` against
  the on-disk index, and `status` reads `indexMtime` for its racy test. When nothing clears, the
  function returns the input object.

`readIndex` becomes `clearSkipWorktreeFromPresentFiles(ctx, await readIndexAt(ctx, stat))`, and
the empty-index branch is unchanged. `readIndexAt` stays raw. Its only other caller is
`readPreviousIndex`, which reads stat data, extensions and the trailer, never flags. The cached
`Promise<GitIndex>` holds the raw parse. Every call clears it again, so the cache key (the index
file's stat) never has to cover the work tree.

Why not in the cache: a file written at an S path does not change `.git/index`, so a cached
cleared parse would serve the stale bit.

### 3. `add` (R5)

Context:
- `src/application/commands/add.ts`: `splitSparseLiterals` / `namesSkipWorktree`,
  `withoutSkipWorktree`, `skipWorktreeOf`, `refuseUnseenRenormalized`, `verdictsOf`, and the two
  tracked-pass `!entry.flags.skipWorktree` filters.
- `loadSparseMatcher(ctx)` from `read-sparse-checkout.ts`.

git's predicate per route, read from `builtin/add.c` and `read-cache.c` `update_callback`. The
observed outcomes are pinned by S7, A1, S7b, A2 and M3:

| Route | git predicate for "leave alone / report" |
|---|---|
| tracked update (`-u`, `-A`, a pathspec naming a tracked path) | `!path_in_sparse_checkout(path)` → skip silently |
| untracked walk (new files) | `!path_in_sparse_checkout(name)` → report as sparse, exit 1 |
| unmatched literal | `matches_skip_worktree` (bit) → report as sparse |
| renormalize / chmod | `ce_skip_worktree(ce) \|\| !path_in_sparse_checkout` → skip |
| a literal naming a **cleared** tracked out-of-pattern file (S7, A1) | reported as sparse, exit 1, nothing staged. Source reading did not identify the route: the pathspec is `seen` against a non-S entry, and `fill_directory` does not list tracked paths. Planning traces it before writing the unit row, so the literal's report is pinned, not inferred |

Load the matcher once per `add` call, and put a single `outsideSparse(path)` closure next to the
bit test on each route. With sparse off the matcher is `undefined` and every route keeps its
current bit test. The planning phase writes one unit row per route, and the interop rows are S7,
S7b and M3.

### 4. `checkout -b` (R6, conditional on D-D)

Context:
- `src/application/commands/checkout.ts`: `switchIndex`, `materializeSwitch`, `staysOnHead`,
  `createRequestedBranch`.

git's `switch_branches` skips `unpack_trees` and the index write when the new branch starts at
`HEAD` with no other change (W7, W8). tsgit's same-commit `createBranch` currently reaches the
index write. Gate the write on the switch actually changing the tree or the index. The planning
phase must pin which `checkout`/`switch` shapes git treats as no-ops (`-b`, `-B` on `HEAD`,
`--detach` on `HEAD`) before the guard is written.

### 5. `stash` (R7, R8, conditional on D-E)

Context:
- `src/application/commands/stash.ts`: `resetAfterPush` → `materializeTreeJudging(ctx, {
  targetTree, currentIndex, force: true, forceRewriteAll: true }, 'oneway')`. `reinstateIndex`,
  `stashApply`, and the skipped-change checkout (ADR-1216,
  `internal/check-out-skipped-changes.ts`).
- `src/application/primitives/materialize-tree.ts`: `MaterializeTreeOpts.sparse`.

R7: pass `sparse: await loadSparseMatcher(ctx)` into `resetAfterPush`'s materialisation, as
lesson 038 found for merge. R8: from `builtin/stash.c` `unstage_changes_unless_new`, the last step
rebuilds each entry that differs from `c_tree` with `make_cache_entry` from the `c_tree` side
(flags 0). That accounts for `H a/f` at HEAD's blob. Which step removes the file is not yet traced.
The likely candidate is the merge-ort checkout retiring the now clean out-of-pattern `H` entry.
Planning confirms it under `GIT_TRACE2` before writing the twin row. Either way, the interop row
pins the outcome: file absent, `H a/f` at `df967b9`.

### 6. The eager gate (R10, conditional on D-C)

Context:
- `src/application/primitives/internal/repo-state.ts`: `computeGateVerdict` (local, with
  `pickLowerLine` over candidates), `firstWorktreeRefusal`, `WORKTREE_GATED_KEYS`,
  `assertWorktreeCoreBooleansValid`.
- `config-read.ts`: `findFirstInvalidBoolean(ctx, section, subsection, keys)`,
  `findFirstInvalidBooleanAt`.

Add a `[sparse]` boolean candidate (`expectfilesoutsideofpatterns`) to the local verdict, ordered
by line against the `[core]` candidates (O1, O2). Add it to the worktree candidates too, and widen
the cheap presence check in `assertWorktreeCoreBooleansValid` from `[core]` to `[core]` +
`[sparse]` (E3b). This supersedes ADR-1186 ("only the sparse keys") for one more key, as ADR-1233
did for `core.fileMode`. Sparse off does not exempt the key (O3).

### 7. `reset --mixed` (R9, conditional on D-F)

Context:
- `src/application/primitives/build-index-from-tree.ts`: `projectLeaf`, `includedFlags`,
  `BuildIndexFromTreeOpts.sparse`.
- `src/application/commands/reset.ts` (mixed route).

git keeps the donor's bit for an unchanged `(mode, id)` (R2x `H` stays `H`, R2a `S` stays `S`).
tsgit re-marks from the patterns. Planning must pin the changed-entry and new-entry shapes before
choosing the rule (`docs/design/sparse-reset-merge.md` §4 assumed the pattern rule without a
pin).

### Breaking-change classification (D-3)

| Part | Effect | Type |
|---|---|---|
| §1–§3 | `status`/`stash`/`checkout` report and act on present files; `add` keeps refusing them. No signature change | `fix` |
| §4, §5, §7 | persisted bits and files match git. No signature change | `fix` |
| §6 (if D-C folds) | every operational command refuses a bogus `sparse.expectFilesOutsideOfPatterns` | breaking `!` |

Proposed squash title: `fix(sparse-checkout)!: clear the skip-worktree bit of present files as git
does` if D-C folds, else `fix(sparse-checkout): …`.

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| D-A | Where the clear runs | A: in `readIndex`, after the cache, per call; `readIndexAt` stays raw · B: a separate primitive each reading command opts into · C: inside the cached parse, with the work tree in the cache key | A | git does it in `repo_read_index`, the single read path. B repeats lesson 038: every unlisted reader drifts. C cannot key on the work tree, so it would serve stale bits |
| D-B | `add`'s sparse predicate (R5) | A: git's per-route predicates with the pattern matcher (§3) · B: feed `add` a raw index (bits as on disk) · C: ship the clear without touching `add` | A | B keeps today's results only while nothing else clears the bit: after `status` writes `H`, a raw read is `H` too and `add` stages (A1/A2 show git refusing with `H` on disk). C ships the S7/A2 regression |
| D-C | Refuse a bogus `sparse.expectFilesOutsideOfPatterns` (E3, E3b, O1–O3) | A: fold local + worktree, ordered by line, breaking `!` · B: fold local only; ledger the worktree case · C: ledger both; read an invalid value as `false` | A | the change starts reading the key from both files. Under D-3 a value it reads but cannot parse must refuse where git does. Same shape as ADR-1233 |
| D-D | `checkout -b` index write (K6) | A: fold — no write when git's fast path applies (§4) · B: fold by writing the raw bits on that path · C: ledger | A | without a fold, the change makes tsgit persist `H` where git keeps `S` (D-2, newly reached). B invents a write git never does |
| D-E | `stash push` reset and `stash apply` T2 (P1, T2) | A: fold both (§5) · B: fold P1 (one `sparse` argument), ledger T2 pending a trace · C: ledger both | A | both rows become reachable through the clear and diverge on file contents (D-2). P1 is one argument. T2's outcome is pinned even though git's mechanism is still to be traced |
| D-F | `reset --mixed` keeps the read bit (R2) | A: fold — carry the donor bit for an unchanged `(mode, id)`, pinned first · B: ledger it as a pre-existing `buildIndexFromTree` divergence (R2x reproduces it without the clear) | A | D-2: the reset reader row stays red without it. Rule: never mark a cleared present file `S`, which would hide it again. The new-entry and changed-entry shapes need pins before the plan |
| D-G | `lstat` failure handling | A: every errno means absent (git, X1) · B: ENOENT/ENOTDIR absent, others rejected (`lstatIfReachable`) | A | git never refuses here. B makes `status` throw on an unsearchable directory git reads past. The one helper documents the reason |
| D-H | `lstat` scheduling | A: sequential port of `path_found` (git's `lstat` count) · B: same answers, with the missing-directory resolution batched under bounded concurrency | A, with a bench gate | the result is identical either way. A keeps git's cost bound and is the simplest. Switch to B only if the new `status` sparse bench (non-cone, 20k S entries in present directories) shows the clear costing more than 10% of `status` against main on the same fixture |
| D-I | Snapshot index rows / public `readIndex` | A: cleared, the `ls-files -t` view (R11) · B: raw for the snapshot resolvers, cleared elsewhere | A | one meaning for the bit across the API (git's `ls-files -t` shows the cleared bit, S1b). Open point for planning: the caching resolver keys on the index file. Under A, a cached snapshot row carries the bit as cleared at its read time, so its invalidation contract must be checked against a file appearing at an S path |
| D-J | `rm` sparse refusal (M1, M1a) | A: fold — refuse with git's sparse advice (`ce_skip_worktree \|\| !path_in_sparse_checkout`) · B: record in `docs/known-divergences.md` | B | the clear does not change it (M1 is `RM_LOCAL_MODIFICATIONS` before and after), and M1a has no present file. It is an `rm` refusal predicate outside the read path. Above the bar (wrong result: M1a removes what git refuses), so filing it is the user's call |

## Test strategy

- **Unit, domain:** the missing-directory state machine (`src/domain/sparse/missing-directory.ts`)
  as a table over path sequences: absent top-level dir, nested absent dir, present parent with
  absent leaf, sibling after a cached miss, a path equal to the cached `dir` minus `/`. Plus a
  `*.properties.test.ts` (oracle lens): over random sorted path sets and random present sets,
  "cleared set" equals the naive `exists(path)` filter, and the probe count is at most one per
  path plus one per directory component.
- **Unit, application:** `clearSkipWorktreeFromPresentFiles` with the memory adapter. Covers each
  short circuit (no S entry → no config read; sparse off; expect on), identity on no-op, a file, a
  directory and a symlink at the path, and a regular file at the parent. The any-errno row uses a
  failing adapter stub with `code` asserted via try/catch where a throw is expected. `readIndex`
  cache rows: a file appears between two calls on the same session, then the bit clears on the
  second call with no index change. `readSparseConfig` rows S4, E4–E4d, O4. Gate rows
  E3/E3b/O1/O2/O3 (try/catch on `code`, `key`, `value`). `add` one row per route of §3. `stash`
  `resetAfterPush` with a sparse matcher. `checkout` same-commit `createBranch` writes nothing.
- **Interop** (new `test/integration/skip-worktree-present-files-interop.test.ts`, plus
  `test/integration/posix-only/skip-worktree-present-files-interop.test.ts` for the `chmod` and
  symlink rows). Each row runs under both `core.ignorecase` values, the twin in the Given slot
  (lesson 045). Tags are read with `-c sparse.expectFilesOutsideOfPatterns=true ls-files -t -s`
  and compared together with the disk listing (lesson 047). Entries are backdated with `utimesSync`
  so the opportunistic writers (`status`, `add`) write or skip deterministically:
  - `status`: S1 (` M a/f` rebuilt from the structured change), S8, S5b (` D`), S6 (` T`), S12,
    E1, S14 (non-cone), S11, S15 (no clear), S4b (worktree `core.sparseCheckout`), E4b, E4c.
    `status-writes-cleared-bit-when-racy` (forced racy, then disk `H`).
  - `stash apply`: T1 (refusal, then disk `H`), T2, T3, S2 (warning text plus `H`).
  - `stash push`: P1, P2.
  - `checkout`: K1 (`CHECKOUT_OVERWRITE_DIRTY` against git exit 1), K2, K4, K5, K6.
  - `add`: S7 (`sparse: ['a/f']`, disk `S`), S7b, M3 (`all`/update without staging `a/f`).
  - `commit`: C1, W11 (disk `H` after a `b/f` commit).
  - `reset`: R1, R2.
  - `sparse-checkout reapply`: S10.
  - config: E3, E3b, O1, O2, O3 (`rev-parse`).
  - posix-only: E2 (symlinked leading directory) and X1 (`chmod 000` parent).
- **Bench:** `test/bench/status-sparse.bench.ts`. A cone fixture with 20k S entries in absent
  directories, and a non-cone one with 20k S entries in present directories. Run it with
  `npm run bench`, A/B against main (D-H gate).
- **Mutation:** scoped Stryker over the touched files with their eponymous suites
  (`.claude/workflow/mutation.md`).

## Out of scope

- Sparse index (`index.sparse=true`, sparse-directory entries, I1–I3): tsgit reads and writes no
  sparse-directory entries. How to prove the boundary: open an index git wrote with
  `--sparse-index` and read `status()`.
- `-c sparse.expectFilesOutsideOfPatterns=…` (S3): tsgit has no command-line config scope.
- Global and system scope for the key: the local-only containment of ADR-182.
- `add --sparse` and `rm --sparse` (S7c, M2): tsgit has neither option.
- `rm`'s sparse refusal (M1, M1a), unless D-J folds it.
- 32.85 (`stash apply --index` leaving `H` with the file absent): a different git step
  (`reset_tree` of the index tree). Not shown to share a cause with T2.
