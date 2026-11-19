<!-- cspell:ignore filemode IXUSR ISREG ISLNK ISGITLINK lstat chmod ctime -->
# Design — core-filemode-false

> Brief: backlog 32.74. tsgit ignores `core.fileMode = false`. `add` stages the exec bit, `status`
> reports `unstaged: 'mode-changed'`, and every local-modification valve treats an exec-bit-only
> change as a change. git does none of this. Nothing in `src` reads the key for these paths.
> The only reader is the sparse mover judge, and it reads the local file only. The fix also
> resolves the fileMode case of ledger entry 32.62 (`config.worktree` ignored). The re-pin
> widens the perimeter. `rm`, `stash push`, `cherry-pick` and the unmerged `add`/`status` rows
> also diverge. The brief's checkout refusal row does not reproduce. The checkout family's
> real divergence is the inverse one under the **default** `core.fileMode = true`.
> Status: draft → self-reviewed ×3

## Context

### The corrected backlog statement

32.74 was filed against git 2.56.0. Re-pinned on main a23c92ec against git 2.56.0 (macOS,
`env -i`, isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, signing off). Every row was run under
`core.ignorecase=false` and `=true`, and the output is byte-identical between the two (oids
differ only where a commit timestamp enters them).

- **Confirmed:** `add` (A1–A3, A6), `status` (S1, S3, S4) and the `config.worktree` layer
  (C2) diverge as the brief says.
- **Not reproduced:** "a non-forced file/directory switch refuses `CHECKOUT_OVERWRITE_DIRTY`
  where git switches". Under `core.fileMode=false`, tsgit switches in both directions (K3, K4),
  as git does. That is an accident. The switch's overwrite check
  (`apply-changeset.ts` `evaluateChangedPath` → `blobMatches`) compares content only.
- **Newly found, same predicate:** under `core.fileMode=true` (git's default on POSIX) git
  **refuses** a switch or merge that would overwrite an exec-bit-only change (K1t, K3t, K4t,
  M1t). tsgit switches or merges and silently resets the bit. This is the same `ie_match_stat`
  mode test seen from the other side.
- **Newly found under `false`:** `rm` refuses `RM_LOCAL_MODIFICATIONS` (R1),
  `stash push` saves a stash and chmods the file where git says `No local changes to save`
  (T1), `cherry-pick` refuses `WORKING_TREE_DIRTY` (M2), and `add` of an unmerged path takes
  the mode from `lstat` where git takes it from a stage entry (A7–A10). The unmerged `status`
  `worktree.mode` diverges the same way (S5).
- **Global layer:** git honours `core.fileMode` from `~/.gitconfig` (C3). tsgit reads no
  global or system scope for any typed key, deliberately (`config-read.ts` `loadConfigEntry`:
  those files sit outside the filesystem port's containment root). That divergence is
  documented and not reopened here. The reader this design adds covers local plus
  `config.worktree`, as the brief says.

### git's rule (v2.56.0, names from `read-cache.c` / `read-cache-ll.h`; behaviour pinned below)

- `ce_mode_from_stat(ce, st_mode)`. When `trust_executable_bit` (`core.fileMode`) is off and
  the work file is a regular file, the result is the donor entry's mode if the donor is a
  regular file, and `100644` otherwise. A symlink work file is always `120000`. When the bit is
  trusted, the result is `create_ce_mode(st_mode)`: `100755` when the owner exec bit is set,
  else `100644`. (The function's first arm, `has_symlinks` off, belongs to `core.symlinks`.
  It is out of scope.)
- `ie_match_stat` / `ce_match_stat_basic`. The exec bit counts as `MODE_CHANGED` only under
  `trust_executable_bit`. A type change (regular ↔ symlink) always counts. The stat fields still
  count (rows P1/P2 show a ctime change still forces a rewrite).
- `add_to_index` takes its donor from `index_name_pos_also_unmerged`. That is the stage-0 entry
  (an intent-to-add entry included). For an unmerged path the preference is stage 2, then 1,
  then 3 (pinned: A7–A10). With no entry the path is new, and the result is `100644`.
- The work-tree mode in `status` (`mW`) comes from the same function. For an unmerged path the
  donor follows the same 2 → 1 → 3 preference (S5).
- `core.filemode` is parsed in `git_default_core_config`, so every command dies on a bogus
  value in local **or** `config.worktree` (C5, C6). This is the same eager tier as
  `core.ignorecase`.

### Code map (names, not line numbers)

| Where | Symbol | Role today |
|---|---|---|
| `src/domain/objects/file-mode.ts` | `deriveWorkingMode(stat: { isSymbolicLink; mode }): FileMode` | symlink → `120000`; the owner exec bit (`S_IXUSR`, `0o100`) → `100755`/`100644`. The trusted arm of git's rule, used everywhere |
| `src/application/primitives/compare-working-tree-entry.ts` | `compareFile(ctx, entry, absPath, stat, scope)` → `statOnlyVerdict`, `compareContent`; `compareGitlink` (`type-changed` arm); `ComparisonScope { provider?, indexMtime?, filterDriversConfigured?, scanner? }`; `compareAndRefresh`, `compareWorkingTreeDelta`, `compareWorkingTreeEntry` (public via `tsgit/primitives`), `racyContentMatcher` | **the seam.** `worktreeMode = deriveWorkingMode(stat)`, and `worktreeMode !== entry.mode` yields `mode-changed`. Consumers: `status`, `rm`, `stash` (change detection, list at `stash.ts` `'mode-changed'`), `clean-work-tree`, `refresh-index`, `find-would-overwrite` (merge family), `submodule-state`, `submodule-absorb`, `scan-tracked-entries` |
| `src/application/primitives/internal/is-entry-stat-clean.ts` | `matchesCachedStat({ entry, indexMtime }, absPath, stat, contentMatches)` | `deriveWorkingMode(stat) !== entry.mode` → not clean. Consumers: `stale-entries.ts` `upgradeStaleNoops` (forced and path checkout rewrite), `sparse-left-dirty.ts` |
| `src/application/primitives/internal/smudge-racily-clean.ts` | `statStillMatches` | the same mode test before the racy smudge |
| `src/application/primitives/internal/sparse-left-dirty.ts` | `modeDiffers(judgement, entry, stat)`, `Judgement.trustsExecutableBit` = `lazily(readConfig(ctx).core?.fileMode !== false)` | **the only fileMode reader today.** It is local-only, so 32.62 bites here too |
| `src/application/commands/add.ts` | `renormalizeOne`, `stagePromisorChecked` (`mode = deriveWorkingMode(fresh)`), `restagesAsIs` (`deriveWorkingMode(fresh) === previous.mode && isEntryStatClean(…)`) | the staged mode, and the skip-restage short cut |
| `src/application/commands/stash.ts` | `hashFileAt` → `HashedFile.mode = deriveWorkingMode(request.stat)` | the mode recorded in the stash's work-tree tree |
| `src/application/commands/status.ts` | `readWorktreeMode(ctx, workDir, path)` | the unmerged entry's `worktree.mode` |
| `src/application/primitives/apply-changeset.ts` | `evaluateChangedPath` → `classifyOccupant`, then `blobMatches` | the switch/merge overwrite check: **content only, mode-blind** |
| `src/application/primitives/find-would-overwrite.ts` | `isLocalChange` → `compareAndRefresh` → `isWorkingTreeModified` | the overwrite check for cherry-pick, revert, rebase and stash apply: mode-aware, fileMode-blind |
| `src/application/primitives/read-sparse-config.ts` | `isWorktreeConfigExtensionOn(ctx)`, `sparseKeyEntries(sections)`, `lastValidBoolean`, `readSparseConfig` | **the pattern to reuse**: local `readConfig` overlaid key by key with `readActiveWorktreeSections` |
| `src/application/primitives/internal/repo-state.ts` | `CORE_BOOLEAN_KEYS` (`ignorecase`, `sparsecheckout`, `sparsecheckoutcone`) in `assertEagerConfigValid`; `assertWorktreeSparseBooleansValid` | the eager gate. It does not refuse `filemode` |
| `src/application/primitives/config-read.ts` | `CORE_BOOLEAN_FIELDS.filemode → core.fileMode` | already parsed (local scope, invalid → dropped) |
| `src/application/primitives/snapshot/workdir-entry.ts` `deriveFileMode`, `src/adapters/snapshot-resolvers/fs-workdir-enumerator.ts` `deriveFileMode` | `WorkdirStat.mode` / `WorkdirEntryRow.mode` | a raw stat mirror for the snapshot API (race detection: "mode is included so race detection covers chmod-only changes"). No index entry, no git verdict |

### Constraining ADRs and doctrine

- ADR-226 (prime directive). ADR-249 (structured output: no new field. `worktree.mode` keeps its
  meaning, git's `mW`).
- ADR-1170 (filing bar). Every diverging row below is a wrong result on a well-formed repository
  with a setting git's own `init` writes on Windows. All are above the bar.
- ADR-1184 / ADR-1185 / ADR-1186 and `docs/design/sparse-checkout-worktree-config.md`. These
  settle the sparse keys' `config.worktree` overlay and its gate (ADR-1186: "the gate checks only
  the sparse keys in the worktree file"). This design extends the same overlay to one more key.
  It does not make `readConfig` layered (32.62 stays open for every other key).
- ADR-182 + `config-read.ts` `loadConfigEntry`: typed reads are local-only by containment.
- DOCTRINE D-2: the shared seam (`compareFile`, `matchesCachedStat`) is folded whole, with an
  interop pin per affected consumer. D-3: a pinned refusal mismatch in a function the change
  edits is folded even when it breaks the API. This governs D-B and D-C below.

## Pinned matrix (git 2.56.0, tsgit main a23c92ec, 2026-11-19)

`core.fileMode=false` in local config unless the row says otherwise. Modes come from
`git ls-files -s` / `ls-tree`, and `±x` is the work file's owner exec bit after the operation.
tsgit ran on its own repository built by the same git script (not on a copy: a copy's stat
data differs from the index). Re-runnable scripts are in the session scratchpad (not committed):
`probe1.sh`–`probe11.sh`, `probe-ts.sh`, `probe-ts2.sh`, `probe-ts3.sh`, `t.mjs`, `t2.mjs`
against an esbuild bundle of `src/index.node.ts`.

### Axis A — `add` (the staged mode)

| # | Shape | git | tsgit main | Verdict |
|---|---|---|---|---|
| A1 | tracked `100644`, `chmod +x`, `add f` | `100644`; `commit -a` → "nothing to commit" | `100755` | diverge |
| A2 | tracked `100755`, `chmod -x`, `add f` | `100755` | `100644` | diverge |
| A3 | A2 + content change, `add` / `add -A` / `commit -a` | `100755` new blob; tree `100755` | `100644` | diverge |
| A4 | A1 + content change, `add` | `100644` new blob | (A1 path) `100755` | diverge |
| A5 | new untracked exec file, `add e` | `100644` | `100755` | diverge |
| A6 | `100755` entry, file removed and recreated `-x` with new content | `status` `.M 100755 100755 100755`; `add` → `100755` | `worktree.mode 100644`; `add` → `100644` | diverge |
| A6b | `rm --cached` a `100755` path, then `add` it (exec on disk) | `100644` (no donor) | not run (same code path as A5) | — |
| A7 | unmerged stage2 `100755` + stage3 `100644`, file `-x`, `add` | `100755` (stage 2) | `100644` | diverge |
| A8 | unmerged stage1 `100644` + stage2 `100755`, file `-x`, `add` | `100755` (stage 2) | `100644` | diverge |
| A9 | unmerged stage1 `100755` + stage3 `100644`, file `-x`, `add` | `100755` (stage 1 over 3) | `100644` | diverge |
| A10 | unmerged stage1 `100644` + stage3 `100755`, file `+x`, `add` | `100644` (stage 1 over 3) | `100755` | diverge |
| A11 | unmerged stage2 `100644` + stage3 `100755`, file `+x`, `add` | `100644` | `100755` | diverge |
| A12 | intent-to-add of an exec file (`add -N`), then `add` | ITA entry `100644`, then `100644` | n/a (tsgit `add` has no intent-to-add; an ITA entry git wrote is a donor like any stage-0 entry) | — |
| A13 | symlink entry replaced by an exec regular file, `add` | `100644` | `100755` | diverge |
| A14 | regular entry replaced by a symlink, `add` | `120000` | not run (symlink arm unchanged) | — |
| A15 | gitlink entry replaced by an exec regular file, `add` | `status` `.T 160000 160000 100644`; `add` → `100644` | not run (A13 rule: a non-regular donor gives `100644`) | — |
| A16 | `update-index --chmod=+x` under `false`, then `chmod -x` + `add` | `100755` kept | n/a (no `update-index`) | — |

### Axis S — `status` (`unstaged` and `worktree.mode`)

| # | Shape | git (`--porcelain=v2`) | tsgit main | Verdict |
|---|---|---|---|---|
| S1 | A1 shape | clean; `diff` empty | `unstaged: 'mode-changed'`, `worktree.mode 100755` | diverge |
| S2 | A1 shape, `-c core.fileMode=true` | `.M … 100644 100644 100755` | same | match (control) |
| S3 | A2 shape | clean | `mode-changed`, `100644` | diverge |
| S4 | symlink → exec file | `.T 120000 120000 100644` | `type-changed`, `worktree.mode 100755` | diverge (mode only) |
| S5 | unmerged rows, file `±x` | `mW` = stage-2 mode (`UD` 644/755 → `100755`; `AA` 755/644 → `100755`); stage-1 over stage-3 (`DU` 755/644 → `100755`) | `worktree.mode` from `lstat` (`100644` or `100755` with the disk) | diverge |

### Axis K — switch / path restore / forced rewrite

| # | Shape | git | tsgit main | Verdict |
|---|---|---|---|---|
| K1 | target changes `f`'s content, file `+x`, switch | switches; `f` rewritten `-x`; an untouched `+x` file keeps `+x` | same | match |
| K1t | K1 under `core.fileMode=true` | refuses: "Your local changes … would be overwritten by checkout" | switches, resets the bit | **diverge (default config)** |
| K2 | target changes `f`'s mode only (`100644` → `100755`), file `-x` | switches; `f` becomes `+x` (written from the target entry) | same | match |
| K3 | file `d` → directory `d/` in target, file `+x` | switches | switches | match (brief row not reproduced) |
| K3t | K3 under `true` | refuses | switches | **diverge** |
| K4 | directory `d/x` → file `d`, `d/x` `+x` | switches | switches | match |
| K4t | K4 under `true` | refuses | switches | **diverge** |
| K5 | target deletes `f`, file `+x` | switches; `f` removed | same | match |
| P1 | `checkout -- f`, `-x` entry, `chmod +x` ≥1 s after the index write (also `reset --hard`, `checkout -f HEAD`) | rewritten (new inode), `-x` | rewritten, `-x` | match |
| P2 | P1 with the `chmod` in the same second as the index write | untouched, `+x` (git's ctime test is whole-second) | rewritten, `-x` | diverge. This is tsgit's nanosecond ctime compare, not fileMode (see Out of scope) |
| P3 | `checkout -- f` with a content change, `100755` entry, file `-x` | rewritten `+x` | rewritten `+x` | match |

### Axis M — merge family, `rm`, `stash`

| # | Shape | git | tsgit main | Verdict |
|---|---|---|---|---|
| M1 | `merge` changing `f`, file `+x` | merges; `f` `-x` | same | match |
| M1t | M1 under `true` | refuses "would be overwritten by merge" | merges | **diverge** |
| M2 | `cherry-pick` changing `f`, file `+x` | picks; `f` `-x` | `WORKING_TREE_DIRTY` | diverge |
| M2t | M2 under `true` | refuses | `WORKING_TREE_DIRTY` | match |
| M3 | `cherry-pick` not touching `f`, file `+x` (both values) | picks; `f` keeps `+x` | same | match |
| R1 | `rm f`, exec-only change | removes | `RM_LOCAL_MODIFICATIONS` | diverge |
| R1t | R1 under `true` | refuses "has local modifications" | same | match |
| T1 | `stash push`, exec-only change | "No local changes to save", exit 0, `f` keeps `+x` | saves a stash (w-tree `100755`), chmods `f` `-x` | diverge |
| T1t | T1 under `true` | saves; w-tree `100755`; `f` `-x` | same | match |
| T2 | `stash push`, content + exec change on a `100644` entry | w-tree `100644`; `f` `-x`; apply → `.M`, `-x` | w-tree `100644`, `-x` | match |
| T3 | `stash push`, content change on a `100755` entry, file `-x` | w-tree `100755`; after `pop` `f` `+x` | not run (follows `hashFileAt`'s mode → `100644` today) | expected diverge |

### Axis C — config layers and values (`status` after `chmod +x` on a `100644` entry)

| # | Layers | git | tsgit main | Verdict |
|---|---|---|---|---|
| C1 | local unset, no global | dirty (default true) | dirty | match |
| C2 | `extensions.worktreeConfig=true`, local `true`, `config.worktree` `false` | clean (worktree wins) | dirty | diverge (32.62) |
| C2b | local `false`, `config.worktree` `true` | dirty | — | (worktree wins) |
| C2c | `config.worktree` `false` but extension off | dirty (file ignored) | dirty | match |
| C2d | linked worktree with its own `config.worktree` `false`; main worktree local `true` | linked clean, main dirty | — | per-worktree |
| C3 | local unset, global `false` | clean | dirty | divergence already documented (`loadConfigEntry`); not reopened |
| C3b | local `true`, global `false` / local `false`, global `true` | dirty / clean (local wins) | — | local wins |
| C4 | `-c core.fileMode=false` | clean | n/a (no command-line scope) | — |
| C5 | local `core.fileMode = bogus` | `fatal: bad boolean config value 'bogus' for 'core.filemode'`, exit 128, on `log`, `rev-parse`, `branch --list`, `status`, `add`, `cat-file` | ignored, `status` succeeds dirty | diverge |
| C6 | `config.worktree` `core.fileMode = bogus` (extension on) | same fatal on `status` and `log` | ignored | diverge |
| C7 | value forms: `""` → false, valueless → true, `No` → false, `0` → false; multi-valued false then true → last wins | as listed | `parseGitBoolean` grammar (same forms) | match (grammar shared) |

## Requirements

- **R1** One reader resolves `core.fileMode` as git does within tsgit's scopes: the
  `config.worktree` value (when `extensions.worktreeConfig` is on) wins over local, the last valid
  entry in each file wins, and the default is trusted (C1, C2, C2b, C2c, C2d, C7).
- **R2** One pure domain function implements `ce_mode_from_stat`'s fileMode arm: the work
  file's stat, an optional donor mode and the trust policy give the index mode. It is total over
  every donor mode, gitlink included (A1–A15).
- **R3** `add` stages the R2 mode with git's donor: the stage-0 entry (ITA included), else
  unmerged stage 2 → 1 → 3, else none (A1–A11, A13).
- **R4** The working-tree comparison seam reports R2's mode as `worktreeMode`. So `mode-changed`
  never fires on an exec-bit-only difference when the bit is untrusted, and `type-changed`
  still fires (S1, S3, S4). Every consumer inherits it: `status`, `rm` (R1), `stash` change
  detection (T1), the merge-family overwrite check (M2) and refresh.
- **R5** `matchesCachedStat` and the racy smudge apply the same mode test, so forced and path
  rewrites still follow the stat fields (P1, P3) and ignore the exec bit when it is untrusted.
- **R6** The stash work-tree tree records R2's mode (T2, T3).
- **R7** The unmerged `status` `worktree.mode` uses the 2 → 1 → 3 donor (S5).
- **R8** The sparse mover judge reads the R1 reader instead of local-only config.
- **R9** (D-B) The switch/merge overwrite check refuses an exec-bit-only change when the bit is
  trusted, as git does (K1t, K3t, K4t, M1t), and keeps accepting it when untrusted (K1, K3,
  K4, M1).
- **R10** (D-C) A bogus `core.fileMode` in local or active `config.worktree` is refused by the
  eager gate with git's `CONFIG_BAD_BOOLEAN_VALUE` (C5, C6).
- **R11** No public signature changes. Behaviour is config-driven. `tsgit/primitives`'
  `compareWorkingTreeEntry(ctx, entry, provider?, indexMtime?)` keeps its shape.

## Design

### 1. The reader (R1)

A new application primitive, next to the sparse reader and on its pattern:

```ts
// src/application/primitives/read-executable-bit-trust.ts
export type ExecutableBitTrust = 'trusted' | 'ignored';

export const readExecutableBitTrust = async (ctx: Context): Promise<ExecutableBitTrust> => {
  const worktree = await readWorktreeFileMode(ctx);          // undefined unless extension on + key set
  const local = (await readConfig(ctx)).core?.fileMode;      // already parsed, invalid dropped
  return (worktree ?? local ?? true) ? 'trusted' : 'ignored';
};
```

`readWorktreeFileMode` reuses `isWorktreeConfigExtensionOn` and `readActiveWorktreeSections`. It
needs a key filter like `sparseKeyEntries`. Which helper serves both is D-A. Both reads are
session-cached (`readConfig` single-flight per session; `readActiveWorktreeSections` through the
scoped cache), so per-call cost is a cache hit after the first. Each consumer still resolves the
policy once per operation, not per entry (§3).

`ExecutableBitTrust` is a two-member string union, not a boolean, so no function grows a boolean
parameter.

### 2. The domain function (R2)

```ts
// src/domain/objects/file-mode.ts
/** git's ce_mode_from_stat, core.fileMode arm: an untrusted exec bit defers to the donor entry. */
export const indexModeFromStat = (
  stat: { readonly isSymbolicLink: boolean; readonly mode: number },
  donor: FileMode | undefined,
  trust: ExecutableBitTrust,
): FileMode => {
  if (trust === 'trusted' || stat.isSymbolicLink) return deriveWorkingMode(stat);
  return donor !== undefined && isRegularFileMode(donor) ? donor : FILE_MODE.REGULAR;
};
```

`ExecutableBitTrust` is declared in the domain (it is a domain concept) and re-exported by the
reader. `isRegularFileMode` = `REGULAR | EXECUTABLE`. Today it is repeated in
`archive.ts`, `grep.ts`, `read-gitattributes.ts` and `walk-submodules.ts`. This change adds the
one domain predicate and uses it only at the new call. The existing copies are left alone (no
refactor outside the perimeter). `deriveWorkingMode` stays the trusted arm, unchanged.

Truth table (exhaustive unit table; small finite domain, see Test strategy):

| stat | donor | trusted | ignored |
|---|---|---|---|
| regular, `+x` | none | `100755` | `100644` |
| regular, `-x` | `100755` | `100644` | `100755` |
| regular, `+x` | `100644` | `100755` | `100644` |
| regular, any | `120000` / `160000` | exec bit | `100644` |
| symlink | any | `120000` | `120000` |

### 3. The comparison seam (R4, R5, R7)

`compareFile` is where `worktreeMode` is born. It becomes
`indexModeFromStat(stat, entry.mode, trust)`. `compareGitlink`'s `type-changed` arm likewise
uses donor `GITLINK`, which gives `100644` under `ignored` (A15's `status` row). `statOnlyVerdict`
and `compareContent` are unchanged: they compare `worktreeMode` with `entry.mode`, and that
comparison is now git's. Refresh (`compareAndRefresh` → `withStatData`) keeps `entry.mode`. That
is what git's `refresh_cache_ent` writes (`ce_mode_from_stat` with the entry as donor), so an
`ignored` refresh never rewrites the staged mode.

How `trust` reaches `compareFile` is D-E. The recommended shape adds an optional
`executableBit?: ExecutableBitTrust` to `ComparisonScope`. `compareAndRefresh` resolves it once
when the caller did not (`scope.executableBit ?? await readExecutableBitTrust(ctx)`). Loops that
already build one scope per scan (`status`, `scan-tracked-entries`, `find-would-overwrite`) set
it once. The public `compareWorkingTreeEntry` keeps its signature (R11). Its standalone callers
pay one cached read.

`matchesCachedStat(cached, absPath, stat, contentMatches)` gains the policy in `CachedStat`
(`{ entry, indexMtime, executableBit }`). Its mode test becomes
`indexModeFromStat(stat, entry.mode, executableBit) !== entry.mode`. `upgradeStaleNoops`
(`stale-entries.ts`) and `sparse-left-dirty.ts` supply it. `smudge-racily-clean.ts`
`statStillMatches` gets the same treatment. `sparse-left-dirty.ts` `modeDiffers` keeps its
`core.symlinks` arm. Its `trustsExecutableBit` becomes
`lazily(async () => (await readExecutableBitTrust(ctx)) === 'trusted')` (R8). That is the
32.62 fileMode case for the sparse judge.

`status.ts` `readWorktreeMode` (unmerged `mW`) takes the conflict's stages and computes
`indexModeFromStat(stat, unmergedDonor(stages), trust)` (R7). `unmergedDonor` is a pure helper:
stage 2, else 1, else 3. It is shared with `add` (§4), and lives in `src/domain/git-index/`
next to the other stage helpers.

### 4. `add` (R3)

The three sites read the policy once per `add` call and compute the donor per path:

- `stagePromisorChecked` and `renormalizeOne`: `mode = indexModeFromStat(fresh, donorOf(path), trust)`.
  `donorOf` is the stage-0 entry's mode when present, ITA included. Otherwise it is
  `unmergedDonor` over the path's stages, otherwise `undefined`.
- `restagesAsIs`: `indexModeFromStat(fresh, previous.mode, trust) === previous.mode && isEntryStatClean(…)`.
  The existing Stryker equivalence comment on that line names `deriveWorkingMode`. Implementation
  rewrites it for the new call. The reasoning (a gitlink `previous.mode` never equals a derived
  mode) still holds because a gitlink donor yields `100644` or the exec arm.

### 5. `stash` (R4, R6)

Change detection already flows through `compareWorkingTreeEntry` (§3), so T1 returns the existing
`{ kind: 'no-local-changes' }` and the file is left untouched. `hashFileAt`'s `HashedFile.mode` becomes
`indexModeFromStat(request.stat, <stage-0 entry mode for the path>, trust)`. `HashRequest`
already carries `indexBlob` from the stage-0 entry. It gains `indexMode?: FileMode` beside it.

### 6. The switch/merge overwrite check (R9, D-B)

`apply-changeset.ts` `evaluateChangedPath` compares content only. git's `verify_uptodate` runs
`ie_match_stat` after a refresh, where an untrusted exec bit is no change and a trusted one is.
The recommended fold adds the mode test before the content compare. The changeset entry carries
`previousMode`, and the policy joins the lazily-built `DirtyProbe`:

```ts
if (await modeChanged(probe, entry, stat)) return { class: 'local-changes', path: entry.path };
```

`modeChanged` is `indexModeFromStat(stat, previousMode, trust) !== previousMode` for a regular
`previousMode`. `stat` comes from the `lstat` that `classifyOccupant` already takes, exposed on
its `compare-content` verdict, so no second stat is added. A file ↔ symlink kind change is
already settled by `classifyOccupant`. `merge`'s clean route reaches this check through
`materializeTree` (`merge.ts`, which maps `CHECKOUT_OVERWRITE_DIRTY` to `WORKING_TREE_DIRTY`).
Its octopus and `workTreeTakes` routes use `findWouldOverwrite`, which §3 already covers. Under
`ignored` nothing changes (K1, K3, K4, M1 stay green). Under `trusted`, K1t/K3t/K4t/M1t refuse
with the existing `CHECKOUT_OVERWRITE_DIRTY` / merge `WORKING_TREE_DIRTY` shapes. This is a new
refusal on the default configuration, so it is breaking (D-3).

### 7. The eager gate (R10, D-C)

`repo-state.ts` `CORE_BOOLEAN_KEYS` gains `filemode`. git parses it in the same
`git_default_core_config` pass as `ignorecase` (C5: `log`, `rev-parse`, `branch --list` all die).
For `config.worktree` (C6), `assertWorktreeSparseBooleansValid` would widen to `filemode`. That
reverses ADR-1186's "only the sparse keys" for one key, so it needs its own ADR. Breaking: every
operational command newly throws on a value it ignored.

### 8. Snapshot rows (D-D)

`WorkdirEntryRow.mode` / `WorkdirStat.mode` mirror the disk for race detection and have no index
entry to act as a donor. Recommended: unchanged. They are not a git-equivalent surface, and
`verify()` must keep flagging a chmod as a race.

### Breaking-change classification (D-3)

| Part | Effect | Type |
|---|---|---|
| §1–§5, §8 | `add`/`status`/`rm`/`stash`/`cherry-pick` stop staging, reporting or refusing an untrusted exec bit. No signature change | `fix` |
| §6 (if D-B = fold) | switch/merge newly refuse under the default config | breaking `!` |
| §7 (if D-C = fold) | every operational command refuses a bogus `core.fileMode` | breaking `!` |

Proposed squash title: `fix(add)!: honour core.fileMode = false as git does` if either D-B or D-C
folds, else `fix(add): …`.

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| D-A | Where the layered `core.fileMode` read lives | A: new `read-executable-bit-trust.ts` reusing `isWorktreeConfigExtensionOn` + `readActiveWorktreeSections`, with its own one-key filter · B: generalise `sparseKeyEntries` into a `coreKeyEntries(sections, keys)` that sparse and fileMode share · C: make `readConfig` layered (fold 32.62 whole) | B | one filter, one overlay rule, no duplicate `[core]` scan. C changes every typed key's scope, outside the perimeter (32.62 remains a ledger entry for the other keys) |
| D-B | The switch/merge overwrite check under `core.fileMode=true` (K1t, K3t, K4t, M1t) | A: fold here, with a mode test in `evaluateChangedPath`, breaking `!` · B: fix only the `false` side (already matching) and file `true` as a backlog item · C: record in `known-divergences.md` | A | D-3: a pinned refusal mismatch in the predicate this change rewrites. Wrong result on git's default config, and the user's exec bit is silently lost |
| D-C | Refuse a bogus `core.fileMode` (C5 local, C6 `config.worktree`) | A: fold both (gate key + widen the worktree gate, superseding ADR-1186 for `filemode`) · B: fold local only (C5); ledger C6 · C: ledger both | A | git dies on both from the same parse. The change starts reading the key from both files, so a value it reads but cannot parse must refuse where git does (D-3) |
| D-D | Snapshot `WorkdirEntryRow.mode` | A: keep raw stat (unchanged) · B: apply the policy with no donor (`ignored` → always `100644`) | A | a raw race-detection mirror. B would hide chmod races and invent a mode git never reports |
| D-E | How the policy reaches `compareFile` | A: optional `ComparisonScope.executableBit`, resolved by `compareAndRefresh` when absent · B: mandatory parameter threaded through every caller · C: read inside `compareFile` per entry (cached) | A | no public signature change (R11), one resolution per scan, and standalone callers stay correct |

## Test strategy

- **Unit, domain:** `indexModeFromStat` as an exhaustive table over
  {regular `±x`, symlink} × {none, `100644`, `100755`, `120000`, `160000`} × {trusted, ignored}.
  `unmergedDonor` over each stage combination (2 alone, 1+2, 1+3, 3 alone, 1+2+3). No
  `*.properties.test.ts`. Neither is a parser, serializer or matcher, and the round-trip and
  oracle lenses do not apply to a 20-row finite mapping (`.claude/workflow/property-testing.md`).
  An exhaustive table is stronger than sampled properties here.
- **Unit, application:** `readExecutableBitTrust` rows C1, C2, C2b, C2c, C7 (in-memory adapter,
  config fixtures). `compareFile` `mode-changed` vs `unchanged` per policy. `matchesCachedStat`
  per policy. `restagesAsIs` per policy. `evaluateChangedPath` mode test (D-B). Gate rows C5/C6
  (D-C), with try/catch asserting `code`, `key`, `value`, `source`.
- **Interop** (new `test/integration/posix-only/core-filemode-false-interop.test.ts`, posix-only
  because the exec bit is not observable on Windows and Windows git writes `filemode = false`
  itself). Each row runs under both `core.ignorecase` values, ignorecase twin in the Given slot
  (lesson 045):
  `add` A1, A2, A3, A5, A6, A7, A9, A10, A13; `status` S1, S3, S4, S5 (reconstructing git's
  `--porcelain=v2` columns from the structured fields); `rm` R1; `stash` T1, T2, T3;
  `cherry-pick` M2; switch K1, K3, K4 under `false` and K1t, K3t, K4t, M1t under `true` (D-B);
  path restore P1 and P3 (P1's `chmod` lands ≥1 s after the index write, because git's ctime
  test is whole-second and a same-second row is timing-dependent; see P2); config C2 (local
  `true` + `config.worktree` `false`), C2d (linked worktree) and C5/C6 (D-C).
  Note: `npm run validate` skips the posix-only project. Run it explicitly
  (`vitest --project posix-integration`) before the PR, and CI runs it on Linux.
- **Mutation:** scoped Stryker over the touched files with their eponymous suites
  (`.claude/workflow/mutation.md`).

## Out of scope

- Global/system `core.fileMode` (C3): documented local-only containment divergence
  (`loadConfigEntry`). Widening containment is a security decision.
- `-c core.fileMode=…` (C4): tsgit has no command-line config scope.
- Every other key in `config.worktree` (32.62 beyond fileMode): stays in the ledger. This change
  resolves only the fileMode case, so the ledger entry is narrowed, not closed.
- `core.symlinks = false` (`ce_mode_from_stat`'s first arm, and checkout writing symlinks as
  files): a different key with a write side. How to prove: `status` after replacing a `120000`
  entry with a regular file under `core.symlinks=false` (git keeps `120000`).
- P2 (same-second chmod): caused by `matchesContentStat`'s nanosecond ctime compare against git's
  whole-second build. It is independent of fileMode and reproduces with `chmod g+w` under the
  default config.
- `init` on Windows writing `filemode = true` (git probes and writes `false`): an `init` concern.
  It cannot be pinned on this host.
- `update-index --chmod` and `add -N`: tsgit has neither surface.
