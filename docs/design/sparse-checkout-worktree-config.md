# Design — sparse checkout reads and writes its keys in `config.worktree`

> Brief: backlog 32.32. `git sparse-checkout set` turns on `extensions.worktreeConfig` and
> writes `core.sparseCheckout` / `core.sparseCheckoutCone` into `<gitDir>/config.worktree`.
> tsgit reads both keys from `<commonDir>/config` only. A later `checkout` writes paths git
> keeps out of the work tree.
> Status: draft → self-reviewed ×3

## Context

`loadSparseMatcher` (`src/application/primitives/read-sparse-checkout.ts:59`) gates on
`(await readConfig(ctx)).core?.sparseCheckout === true` and picks the mode from
`core.sparseCheckoutCone`. `readConfig` (`src/application/primitives/config-read.ts:550`)
serves `loadConfigEntry` (`:697`), which reads `${commonGitDir(ctx)}/config` and nothing
else. Its docstring says the local-only read is deliberate: system and global sit outside
the filesystem port's containment. That reason does not cover `config.worktree`, which
lives inside `gitDir`.

The pattern file is already per worktree: `readSparsePatternText` reads
`sparseCheckoutPath(ctx.layout.gitDir)` (`path-layout.ts:128`). Only the two config keys
are read from the wrong file.

A scoped reader that gates on the extension already exists. The `config` porcelain uses
it (ADR-182):

| Piece | Where | Shape |
|---|---|---|
| `isWorktreeScopeActive(ctx)` | `src/application/primitives/config-scoped-read.ts:156` | `extensions.worktreeConfig` from the cached local scope, git boolean grammar, `false` on a refused layout |
| `resolveConfigScopePath(ctx, scope)` | same file `:186` | `'worktree'` ⇒ `${ctx.layout.gitDir}/config.worktree`, throws `CONFIG_SCOPE_NOT_AVAILABLE` (`worktree-extension-unset`) when the extension is off |
| `readConfigSections({ ctx, scope })` | same file `:260` | `IniSection[]` for one scope. Cached per `(session, gitDir, scope)` with an mtime+size stat on every call |
| `setConfigEntry({ ctx, key, value, scope })` | `src/application/primitives/update-config.ts:642` | read-modify-write of one key in the resolved scope file. Invalidates both caches. Lowercases the key name (`parseConfigKey`) |
| `unsetConfigEntry({ ctx, key, scope })` | same file `:669` | remove one key; no I/O when absent |
| `readRepositoryFormat` | `src/repository/read-repository-format.ts:194` | open-time layout read. Already reads `config.worktree` for `core.bare` / `core.worktree` under the extension (ADR-661) |

The writers persist into the common config too. `sparseCheckoutSet` / `sparseCheckoutAdd`
go through `applyAndPersist` (`src/application/commands/sparse-checkout.ts:112`), which
calls `updateCoreConfig` (`update-config.ts:439`, always `${commonGitDir}/config`,
ADR-074). `sparseCheckoutDisable` (`:173`) writes `sparseCheckout = false` to the same file.

The consumers that gate on the matcher:

| Consumer | Site |
|---|---|
| `checkout` (branch switch) | `src/application/commands/checkout.ts:421` |
| `reset --mixed` / `--hard` | `src/application/commands/reset.ts:110`, `:155` |
| one-way reset used by `merge --abort`, the sequencer abort, `rebase`, merge `--autostash` | `src/application/commands/internal/reset-worktree.ts:39` (`resetWorktreeToCommit`) |
| `merge` conflict write (two-way and octopus) | `src/application/commands/merge.ts:1551`, `:1933` |
| `pull` fast-forward | `src/application/commands/pull.ts:439` |
| `sparseCheckout.reapply` | `src/application/commands/sparse-checkout.ts:164` |
| `sparseCheckout.list` / `set` / `add` / `reapply` (mode only, direct `readConfig`) | same file `:93`, `:135`, `:149`, `:168` |

tsgit has no `read-tree` command, and `stash` reads no matcher: it keeps skip-worktree
entries as they are (`stash.ts:343`). Every consumer goes through `loadSparseMatcher`,
apart from the four direct `readConfig` reads in `sparse-checkout.ts`. One reader change
fixes them all.

The eager config gate (`assertEagerConfigValid`,
`src/application/primitives/internal/repo-state.ts:241`) checks `core.sparseCheckout` and
`core.sparseCheckoutCone` against git's boolean grammar (`CORE_BOOLEAN_KEYS`, `:164`). It
walks the local tokens only.

Re-pinned on main `4a49607e` before design (lesson 033). `loadSparseMatcher`,
`readConfig`'s local-only read and the writers sit where the brief says. The defect
reproduces (row T0). The probes also found five more gaps in the same keys and verbs. tsgit writes
the keys to the shared file, so `set` in a linked worktree turns sparse on for every
worktree (L3). `disable` after a git `set` leaves git sparse (W-dis). `add` writes config
that git does not write (A1). `set` without `cone` picks the mode from a stale key (S4). Non-cone `set` drops the pattern file's trailing newline (S1/S4).

## Requirements

Each axis gets its own requirement (lesson 037). The axes the pins vary are: the file
holding the key, the extension state, the key, the worktree kind, and the writer.

1. **Extension gate.** `<gitDir>/config.worktree` is read only when `<commonDir>/config`
   sets `extensions.worktreeConfig` true under git's boolean grammar (`yes` counts, X1).
   With the extension off or false, the file is never read. Its sparse keys have no
   effect (R1, R9, R13), and neither a malformed line (M2) nor a bad boolean (R11) refuses.
2. **Layering per key.** `core.sparseCheckout` and `core.sparseCheckoutCone` are resolved
   one key at a time. The last occurrence wins, in the order local entries then worktree
   entries (R2–R8, D1). One key can come from local and the other from worktree (R2, R7,
   R8). A valueless entry is `true` (V1). An absent `sparseCheckout` means sparse is off.
   An absent `sparseCheckoutCone` means non-cone.
3. **Worktree kind.** The worktree file is `${ctx.layout.gitDir}/config.worktree`. For the
   main worktree that is `.git/config.worktree`. For a linked worktree it is
   `.git/worktrees/<id>/config.worktree` (L2). A worktree's keys never affect another
   worktree (L2: main stays fully checked out).
4. **Readers.** Every consumer in the Context table reads the resolved pair: the matcher
   gate, the matcher mode, and the `cone` that `list` / `reapply` report (T0, R2–R8,
   W-rows, L2).
5. **Refusals.** With the extension on, a `config.worktree` that does not parse refuses
   every operational command, as git's `bad config line N in file .git/config.worktree`
   does (M1). So does a sparse key holding a value outside the boolean grammar (R10, R12:
   `status` refuses too). git parses every file before it validates any value, so the
   order is:
   1. discovery-tier local refusals (O5: `core.bare = bogus` beats a malformed worktree
      file);
   2. a malformed local file (O6);
   3. a malformed `config.worktree` (O3, O7: it beats a local bad boolean);
   4. local value refusals (the existing eager gate);
   5. `config.worktree` sparse-boolean refusals (O1, O2: a local bad value beats a
      worktree one).

   tsgit already produces steps 2–4 (`readRepositoryFormat` parses both files at open,
   local first; O3, O6, M1 pinned on tsgit). Step 1 is a pre-existing open-path gap (O5,
   IMPACT line) that this change does not touch. The change adds step 5, which refuses
   with the existing `CONFIG_BAD_BOOLEAN_VALUE`, with `source` naming
   `config.worktree`. Decision 3 fixes which keys are checked; Decision 2 fixes where the
   check sits.
6. **Writer: `set`.**
   - The mode is `input.cone` when given. Without it: the resolved `sparseCheckoutCone`
     when sparse is already on, else cone (S1, S2, S4).
   - Config is written only when `input.cone` is given or sparse is off (S1, S2 write
     nothing; S3, S4, B5 write).
   - A write is two steps: enable the worktree scope (requirement 8), then write
     `core.sparseCheckout = true` and `core.sparseCheckoutCone = <true|false>` to
     `<gitDir>/config.worktree` (B1, B5, L3).
   - The local file keeps any sparse keys it already holds (P-pre).
7. **Writer: `disable`.** Enable the worktree scope (requirement 8). Then write
   `core.sparseCheckout = false`, `core.sparseCheckoutCone = false` and
   `index.sparse = false` to `<gitDir>/config.worktree`. This holds even when sparse was
   on only in local config (S6), and on a repository that was never sparse (P-dis0). The
   local file is left as it is.
8. **Enable the worktree scope.** This step runs only when the extension is not already
   active:
   - set `extensions.worktreeConfig = true` in `<commonDir>/config`. An existing
     `worktreeConfig = false` line is rewritten in place (B2). Otherwise an
     `[extensions]` section is appended (B1);
   - move a local `core.worktree` to the top of `[core]` in `config.worktree`, and remove
     it from the local file (B3);
   - leave `core.repositoryformatversion` alone: 0 stays 0 and 1 stays 1 (B1, B4).

   `core.bare = true` would also move, but a bare repository cannot reach the writers
   (`requireWorkTree`), so tsgit omits that branch.
9. **Writers that persist no config.** `add` and `reapply` write no config (P-add, B7, B8,
   A1). They read the resolved pair (requirement 4).
10. **Bytes.** Key casing is `worktreeConfig`, `sparseCheckout`, `sparseCheckoutCone`,
    `sparse`. Each line is a tab, then `key = value`. Each section header is on its own
    line (B1, B3, B5, B6, S6). A second `set` rewrites the values in place (B5). After
    `disable`, a later `set` leaves the `[index]` section alone (B6).
11. **Unchanged.** The pattern file location and the cone/non-cone matching are
    unchanged, as are every consumer's materialisation and the result shapes
    (`SparseCheckoutListResult`, `SparseCheckoutAppliedResult`). The local-only
    `readConfig` used by every other key does not change (Out of scope).

## Design

### Pinned matrix — git 2.56.0 (scrubbed `GIT_*`, isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, `-c commit.gpgsign=false -c gc.auto=0`, `mktemp -d` throwaways)

The fixture for every row: `init -b main`, commit `a/f b/f top` on `main`. Branch `other`
adds `a/g` and changes `a/f` and `b/f`. Back on `main`. "cone file" means
`.git/info/sparse-checkout` = `/*\n!/*/\n/b/\n`. The state column is
`ls-files -s -t` (tag and path), then the files in the work tree.

#### Writers (git `sparse-checkout <verb>`): file contents after the verb

| Row | Shape | `.git/config` gains | `.git/config.worktree` |
|---|---|---|---|
| B1 | `set --cone b` (fresh) | `[extensions]\n\tworktreeConfig = true\n` appended; `repositoryformatversion = 0` kept | `[core]\n\tsparseCheckout = true\n\tsparseCheckoutCone = true\n` |
| P-nc | `set --no-cone /b/` | same | `sparseCheckout = true`, `sparseCheckoutCone = false` |
| P-init | `init` / `init --cone` / `init --no-cone` | same | true / true · true / true · true / false |
| P-add | `set --cone b; add a` | same | unchanged after `add` (true / true) |
| P-re | `set --cone b; reapply` | same | unchanged after `reapply` |
| P-dis | `set --cone b; disable` | same | `[core]\n\tsparseCheckout = false\n\tsparseCheckoutCone = false\n[index]\n\tsparse = false\n`; state `H a/f H b/f H top`, all files present |
| P-dis0 | `disable` on a never-sparse repo | `[extensions] worktreeConfig = true` | same three keys as P-dis |
| P-pre | local `core.sparseCheckout=true`, `core.sparseCheckoutCone=false`, then `set --cone b` | local sparse keys kept as they are; `[extensions]` appended | true / true |
| B2 | local `extensions.worktreeConfig = false`, then `set --cone b` | that line rewritten in place to `worktreeConfig = true` | true / true |
| B3 | local `core.worktree = <dir>`, then `set --cone b` | `core.worktree` removed from local | `[core]\n\tworktree = <dir>\n\tsparseCheckout = true\n\tsparseCheckoutCone = true\n` |
| B4 | `repositoryformatversion = 1`, then `set` | version stays 1 | — |
| B5 | `set --cone b; set --no-cone /a/` | — | `sparseCheckout = true`, `sparseCheckoutCone = false` (rewritten in place) |
| B6 | `set --cone b; disable; set b` | — | `[core] sparseCheckout = true, sparseCheckoutCone = true` + `[index] sparse = false` kept |
| B7 | local true / true (extension off), `add a` | unchanged | not created |
| B8 | local true / true (extension off), `reapply` | unchanged | not created |
| S1 | local true / false (extension off), `set /a/` (no flag) | unchanged | not created; pattern file `/a/\n` (non-cone kept) |
| S2 | local true / true (extension off), `set a` (no flag) | unchanged | not created |
| S3 | local `sparseCheckout = true` (extension off), `set --cone a` | `[extensions]` appended | true / true |
| S4 | not sparse, local `sparseCheckoutCone = false`, `set a` (no flag) | `[extensions]` appended | true / **true**; `list` ⇒ `a` (cone) |
| S5 | local true / false, `init` (no flag) | unchanged | not created |
| S6 | local `sparseCheckout = true` (extension off), `disable` | local `sparseCheckout = true` kept; `[extensions]` appended | false / false + `[index] sparse = false`; all paths `H`, all files present |

#### Readers: config placement, then a git command

| Row | Extension | `config` | `config.worktree` | git result |
|---|---|---|---|---|
| T0 | on (via `set --cone b`) | — | true / true | `checkout other` ⇒ `S a/f S a/g H b/f H top`; work tree `b/f top` |
| R1 | off | — | true / true (by hand), cone file | `checkout other` ⇒ all `H`, all files. `sparse-checkout list` ⇒ `fatal: this worktree is not sparse`, exit 128 |
| R2 | on | cone = true | sparse = true | `checkout` ⇒ `S a/f S a/g H b/f H top`; `list` ⇒ `b` |
| R3 | on | sparse = true | — | `S a/f S a/g H b/f H top` |
| R4 | on | sparse = true | sparse = false | all `H`, all files |
| R5 | on | sparse = false | sparse = true | `S a/f S a/g H b/f H top` |
| R6 | on (via `set --cone b`) | — | then `cone = false` | `list` ⇒ `b`, then `/* !/*/ /b/` |
| R7 | on | cone = true | sparse = true, cone = false | `list` ⇒ `/* !/*/ /b/` |
| R8 | on | cone = false | sparse = true, cone = true | `list` ⇒ `b` |
| R9 | off | sparse = true, cone = true | cone = false (by hand) | `list` ⇒ `b` (worktree file ignored) |
| R10 | on | — | `sparseCheckout = bogus` | `checkout` and `status` ⇒ `fatal: bad boolean config value 'bogus' for 'core.sparsecheckout'` |
| R11 | off | — | `sparseCheckout = bogus` | `checkout` succeeds, all `H` |
| R12 | on | — | sparse = true, `sparseCheckoutCone = bogus` | `checkout` ⇒ `fatal: bad boolean config value 'bogus' for 'core.sparsecheckoutcone'` |
| R13 | `set --cone b`, then `extensions.worktreeConfig false` | — | true / true | `checkout other` ⇒ `S a/f H a/g H b/f H top`, all files present (sparse off; the stale `S` on `a/f` survives, see Out of scope) |
| M1 | on | — | `[core` (malformed) | `status` and `checkout` ⇒ `fatal: bad config line 1 in file .git/config.worktree` |
| M2 | off | — | `[core` | `checkout` succeeds |
| V1 | on | — | `[core]\n\tsparseCheckout\n` (valueless) | `S a/f S a/g H b/f H top` |
| D1 | on | — | `sparseCheckout = true` then `= false` | all `H`, all files |
| X1 | `worktreeConfig = yes` | — | sparse = true | `S a/f S a/g H b/f H top` |

#### Refusal order when both files are broken (git, extension on, `status`)

| Row | `config` | `config.worktree` | git names |
|---|---|---|---|
| O1 | `sparseCheckout = bogus1` | `sparseCheckout = bogus2` | `bad boolean config value 'bogus1' for 'core.sparsecheckout'` (local) |
| O2 | `sparseCheckoutCone = bogus1` | `sparseCheckout = bogus2` | `'bogus1' for 'core.sparsecheckoutcone'` (local, though the worktree file holds the other key) |
| O3 | `sparseCheckout = bogus1` | `[core` | `bad config line 1 in file .git/config.worktree` (repeated 3×) |
| O5 | `bare = bogus` | `[core` | `bad boolean config value 'bogus' for 'core.bare'` |
| O6 | `[x` (malformed last line) | `[core` | `bad config line 10 in file .git/config` |
| O7 | — | `[core` | `git config --get core.bare` also dies with the worktree parse error |
| O4 | — | `sparseCheckout = bogus` | `git config --get core.sparseCheckout` ⇒ `bogus`, exit 0 (the porcelain does not validate values) |

#### Every writer under `set --cone b` (git)

`reset --hard other`, `reset other` (mixed), `merge --ff-only other`, a three-way
`merge other` (with `main` changing `top`), `read-tree -m -u HEAD other`,
`pull --ff-only . other`: each ends with `S a/f S a/g H b/f H top` and only `b/f top` in
the work tree. `stash` then `stash pop` with `b/f` dirty: `S a/f H b/f H top`, the work tree
unchanged.

#### Linked worktrees (git)

| Row | Shape | git result |
|---|---|---|
| L1 | `set --cone b` in main, then `worktree add ../wt other` | `worktrees/wt/config.worktree` = true / true, `worktrees/wt/info/sparse-checkout` copied; the new worktree is sparse (`S a/f S a/g H b/f H top`) |
| L2 | `worktree add ../wt -b side`, `set --cone b` inside it | `worktrees/wt/config.worktree` = true / true, `worktrees/wt/info/sparse-checkout`; the main repo has no `config.worktree`; main `checkout --detach other` ⇒ all `H`, all files |
| C1 | main sparse, plus `foo.bar = 1` in main `config.worktree`, `worktree add` | linked `config.worktree` = the whole main file (`[core]` sparse keys + `[foo] bar = 1`) |
| C2 | main not sparse, extension on, `foo.bar = 1` in main `config.worktree`, `worktree add` | linked `config.worktree` = `[foo]\n\tbar = 1\n` (copied without sparse) |
| C3 | main sparse through local config only (extension off), `worktree add` | linked worktree has `info/sparse-checkout`, no `config.worktree`; sparse through the shared local key |

### tsgit on the same rows (main `4a49607e`, git-prepared repositories, then the tsgit verb)

| Row | tsgit result | Matches git? |
|---|---|---|
| T0 | `checkout other` ⇒ all `H`, `a/f a/g` written | no |
| R1, R9, R11, R13-config, M2 | the worktree file is never read | yes (by accident) |
| R2 | all `H`; `list` ⇒ `{ cone: false, patterns: [] }` | no |
| R3 | `S a/f S a/g H b/f S top`; `top` deleted | `top` differs: a non-cone defect not tied to the worktree file (see N1, Out of scope) |
| R4 | `S … S top` (local true wins) | no |
| R5 | all `H` | no |
| R6, R8 | `list` ⇒ `{ cone: false, patterns: [] }` | no |
| R10, R12 | `checkout` and `status` succeed | no |
| R13 | all `H` | `a/f` differs (stale-bit, Out of scope) |
| W reset `--hard` / merge ff | all `H`, every file written | no |
| W reset `--mixed` | all `H`, files untouched | no |
| W-re/add | `reapply` / `add` ⇒ `INVALID_OPTION` "requires sparse checkout to be enabled" | no |
| W-dis | `disable` after git `set`: local `sparseCheckout = false` appended, `config.worktree` untouched ⇒ `git sparse-checkout list` still `b`; a git `checkout other` re-sparsifies (`S a/f S a/g`) | no |
| TS-set | `set b` on a fresh repo: local `sparseCheckout = true`, `sparseCheckoutCone = true`, no extension, no `config.worktree` | no (B1) |
| L2 | linked worktree: `checkout other` ⇒ all `H` | no |
| L3 | `set b` in a linked worktree writes the shared `.git/config`. Git's main worktree then warns `this worktree is not sparse (sparse-checkout file may not exist)` because sparse is on in main with no pattern file | no |
| L1 | `worktree.add` copies neither `config.worktree` nor `info/sparse-checkout` | no (Out of scope, IMPACT) |
| S4 | `set({ patterns: ['a'] })` ⇒ `cone: false`, pattern file `a` without a newline | no |
| A1 | `add a` on local-only sparse writes `sparseCheckoutCone = false` into local config | no (B7) |
| I1 | `core.ignorecase = bogus` in `config.worktree` (extension on): `status` succeeds; git refuses | no (Out of scope, IMPACT) |
| M1, O3, O7 | `openRepository` throws `CONFIG_PARSE_ERROR { line: 1, source: …/config.worktree }` (from `readRepositoryFormat`) | yes (refuses; at open rather than at the command) |
| M2 | opens and checks out | yes |
| O1 | `status` ⇒ `CONFIG_BAD_BOOLEAN_VALUE { key: 'core.sparsecheckout', source: …/.git/config, value: 'bogus1' }` | yes (local named first) |
| O5 | `openRepository` throws the worktree `CONFIG_PARSE_ERROR`; git names `core.bare` | no (pre-existing open path, IMPACT) |

### Change

Three parts. Each part's tests come first (TDD, London School).

#### Part 1: the layered sparse reader

New primitive `readSparseConfig(ctx): Promise<SparseConfig>` in
`src/application/primitives/read-sparse-config.ts`:

```ts
export interface SparseConfig {
  readonly enabled: boolean;   // resolved core.sparseCheckout, absent ⇒ false
  readonly cone: boolean;      // resolved core.sparseCheckoutCone, absent ⇒ false
}
```

Resolution:

```
local   = (await readConfig(ctx)).core            // existing parse, epoch-trusted
active  = await isWorktreeScopeActive(ctx)
wtCore  = active ? lastBooleanEntries(await readConfigSections({ ctx, scope: 'worktree' }),
                                       'core', ['sparsecheckout', 'sparsecheckoutcone'])
                 : {}
enabled = wtCore.sparsecheckout     ?? local?.sparseCheckout     ?? false
cone    = wtCore.sparsecheckoutcone ?? local?.sparseCheckoutCone ?? false
```

`lastBooleanEntries` walks the `[core]` sections without a subsection, matches keys
case-insensitively, and keeps the last entry per key. It turns a value into a boolean with
`parseGitBoolean`, where `null` means `true`. A value git's grammar refuses resolves to
`undefined` here, the same leniency `assembleParsed` applies to the local file; the gate
(Part 3) is what refuses it. Pure, so it lives in `src/domain/config/` next to
`parseGitBoolean`, or inline if it stays under 20 lines.

Call-site changes:

- `loadSparseMatcher` (`read-sparse-checkout.ts:59`): replace the `readConfig` read
  with `readSparseConfig`. Drop the `readConfig` import.
- `sparseCheckoutList` / `sparseCheckoutAdd` / `sparseCheckoutReapply`
  (`sparse-checkout.ts:91`, `:141`, `:159`): read `readSparseConfig` instead of
  `config.core?.sparse*`.
- `sparseCheckoutSet` (`:127`): the mode becomes
  `input.cone ?? (sparse.enabled ? sparse.cone : true)` (requirement 6).

Context to pre-pay:

- `readConfigSections`, `isWorktreeScopeActive`: `src/application/primitives/config-scoped-read.ts`.
  Both already exist, so no new cache is needed: `readSingleScope` buckets by
  `ctx.layout.gitDir`, which gives the per-linked-worktree isolation of requirement 3.
- `parseGitBoolean`: `src/domain/config/config-ini.ts` (re-exported by `config-read.ts:45`).
- `IniSection`: `src/domain/config/config-ini.ts:24` (`section`, `subsection`, `entries[{ key, value }]`).
- Tests to extend: `test/unit/application/primitives/read-sparse-checkout.test.ts`
  (`seedConfig` helper, memory adapter). Add a `seedWorktreeConfig` helper that writes
  `${gitDir}/config.worktree`. New `test/unit/application/primitives/read-sparse-config.test.ts`.
- Import cycle check: `read-sparse-config.ts` imports `config-read.ts` and
  `config-scoped-read.ts`. `config-read.ts` already imports `invalidateScopedConfigCache`
  from `config-scoped-read.ts`, and `config-scoped-read.ts` does not import
  `config-read.ts`, so depcruise `no-circular` stays green.

#### Part 2: the writers target `config.worktree`

New internal helper `enableWorktreeConfig(ctx)` in
`src/application/primitives/internal/enable-worktree-config.ts`. It is a no-op when
`isWorktreeScopeActive(ctx)`. Otherwise, in order:

1. Write `extensions.worktreeConfig = true` to the local file with
   `updateScopedConfigEntries(ctx, 'local', [{ section: 'extensions', key: 'worktreeConfig', value: 'true' }])`.
   `setConfigEntryInText` rewrites an existing value in place or appends
   `[extensions]` (B1, B2).
2. When the local file holds `core.worktree`, read its raw value with
   `getConfigValue({ ctx, key: 'core.worktree', scope: 'local' })`. Write it to scope
   `'worktree'` (`{ section: 'core', key: 'worktree', value }`), then remove it from the
   local file with `removeConfigEntry` in a local read-modify-write (B3).

Step 2 needs step 1's extension write first, because `resolveConfigScopePath('worktree')`
refuses while the extension is off.

Do not use `setConfigEntry`. It goes through `parseConfigKey`, which lowercases the
name (`src/domain/commands/config-key.ts:89-93`), so it would write `worktreeconfig` and
`sparsecheckout`, where git writes `worktreeConfig` and `sparseCheckout` (requirement 10).
`updateConfigEntries` keeps the caller's casing, which is how tsgit writes
`sparseCheckout = true` today (TS-set), and `updateScopedConfigEntries` must keep it too.

`sparse-checkout.ts`:

- `applyAndPersist` (`:112`) gets a `recordMode` switch, expressed as an options record
  rather than a boolean parameter (house smell rule). Only `set` passes it. When the mode
  is recorded, it calls `enableWorktreeConfig`, then sets `core.sparseCheckout` and
  `core.sparseCheckoutCone` in scope `'worktree'`.
- `sparseCheckoutAdd` stops writing config: it persists the pattern file only
  (requirement 9).
- If Decision 5 is a: `buildSpecAndText` (`:184`) and `combineSpecAndText` (`:200`) end
  the non-cone text with `\n` after each pattern (S1: git writes `/a/\n`).
- `sparseCheckoutDisable` (`:173`) calls `enableWorktreeConfig`, then sets
  `core.sparseCheckout = false`, `core.sparseCheckoutCone = false` and
  `index.sparse = false` in scope `'worktree'`.

The worktree writes run as one read-modify-write of `config.worktree`. A new
`updateScopedConfigEntries(ctx, scope, entries: ReadonlyArray<ConfigEntry>)` in
`update-config.ts` resolves the path with `resolveConfigScopePath`, then folds
`setConfigEntryInText` over the entries as `updateConfigEntries` does for local. It
invalidates both caches. The bytes of B1, P-dis and B5 then come out of one write. Writing them one at a time gives the same bytes at three times the I/O
(Decision 4).

`updateCoreConfig` loses its only caller. It stays exported from
`src/application/primitives/index.ts:113` (public primitive surface). Removing it is an
API break and out of scope.

Context to pre-pay:

- `setConfigEntryInText` (`:212`), `removeConfigEntry` (`:387`), `ConfigEntry` (`:408`),
  `updateConfigEntries` (`:420`, the template for the scoped variant),
  `readModifyWriteScopedConfig` (`:612`): all in `src/application/primitives/update-config.ts`.
- `getConfigValue`: `src/application/primitives/config-scoped-read.ts:315`.
- Writer tests: `test/unit/application/commands/sparse-checkout.test.ts`. Assertions at
  `:382` (`sparseCheckout = true` in local) and `:710` (`sparseCheckout = false` in local)
  move to `config.worktree`; `seed` at `:82` keeps local seeding (requirement 2 still
  reads it).
- ADR-074's "writes go to `.git/config`" is superseded for these keys. The line-surgery
  mechanism stays the same.

#### Part 3: the gate sees `config.worktree`

tsgit already refuses a malformed worktree file. `readRepositoryFormat`
(`src/repository/read-repository-format.ts:209`) tokenizes `config.worktree` at
`openRepository` when the extension is on, and throws `CONFIG_PARSE_ERROR { line: 1,
source: …/config.worktree }` (pinned on M1/O7 shapes: tsgit throws at open, git refuses
at the command). It skips the file when the extension is off (M2). The local file is
tokenized first, so O6 also holds, and O3 holds because the worktree parse error comes
before any command-time value check. So Part 3 only adds the boolean check.

New `assertWorktreeSparseBooleansValid(ctx)` in
`src/application/primitives/internal/repo-state.ts`. It returns at once when
`isWorktreeScopeActive(ctx)` is false. Otherwise it reads
`readConfigSections({ ctx, scope: 'worktree' })` and refuses the first
`core.sparseCheckout` / `core.sparseCheckoutCone` entry whose value `acceptsGitBoolean`
rejects, with
`configBadBooleanValue('core.sparsecheckout' | 'core.sparsecheckoutcone', <path>, value)`
(R10, R12). The key is lowercased because git's message prints it that way.

Placement, as recommended by Decision 2:

```
assertOperationalRepository(ctx):
  assertUsableHeadAndOpenEpoch(ctx)                      // unchanged
  root = memoizeGateVerdict(ctx, computeGateVerdict)     // unchanged: discovery, trust, local values
  assertWorktreeSparseBooleansValid(ctx)                 // O1, O2: after local values
```

`assertOperationalRepositorySettingsFirst` (`:421`) gets the same call after its memo.
The check stays outside the verdict memo. The memo is keyed on the local file's mtime
only (`snapshotConfigMtimeKey`), so a `config.worktree` edit would not re-key it.
`readSingleScope`'s own stat keeps the check fresh, and its `(session, gitDir)` bucket
keeps linked worktrees apart. A worktree file that is corrupted after
`openRepository` throws `CONFIG_PARSE_ERROR` from this same `readConfigSections` call,
so a mid-session corruption still refuses on the next operational command.

A refused layout never reads the file. `isWorktreeScopeActive` returns `false` on
`layoutFailsAcceptance`, which is `layoutFailsTrustGate || formatRefusal`
(`src/application/primitives/internal/layout-verdict.ts:38`). So an untrusted or
format-refused repository still reaches the memo's own refusal, and its file is never
parsed first (ADR-679).

Context to pre-pay:

- `assertOperationalRepository`: `repo-state.ts:404`.
  `assertOperationalRepositorySettingsFirst`: `:421`. `computeGateVerdict`: `:380`.
- `acceptsGitBoolean` / `configBadBooleanValue`: imported by the `config-read.ts` finders
  (`:2571`) and `src/domain/commands/error.js`.
- Tests: `test/unit/application/primitives/internal/repo-state*.test.ts`. Interop:
  `test/integration/config-boolean-interop.test.ts` (existing local-file bad-boolean rows).

### Cost

`readSparseConfig` adds `isWorktreeScopeActive`'s cached local-scope read, which is one
`stat` per call. With the extension on, it also adds one `stat` of `config.worktree` and
one parse the first time. `loadSparseMatcher` runs once per command, twice on a
conflicting merge. The gate (Part 3) calls `isWorktreeScopeActive` once per operational
command, which is one `stat` of the local file, plus one `stat` of `config.worktree`
when the extension is on.

ADR-850 brought config to one stat per command. The worst case here is about four more
on a sparse-aware command with the extension on, and two when it is off. That cost is
measurable but bounded. If a benchmark shows it, a per-command memo of
`isWorktreeScopeActive` is the follow-up, and it must not be built without that proof.
Hot loops do not reach it: no per-path call reads config.

### Doc surfaces

- `docs/use/commands/sparse-checkout.md:50`: "`core.sparseCheckout` /
  `core.sparseCheckoutCone` are written to `.git/config`". Rewrite it to say
  `config.worktree`, that the extension is turned on, that `core.worktree` moves, that
  `disable` writes `index.sparse = false`, and that `set` without `cone` keeps the current
  mode.
- `docs/use/errors.md`: `CONFIG_BAD_BOOLEAN_VALUE` can now name `config.worktree` for the
  two sparse keys.
- `docs/BACKLOG.md:672`: tick 32.32.

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| 1 | Where the layered read lives | **a** a sparse-only `readSparseConfig` over `readConfig` + `readConfigSections('worktree')`. **b** `loadConfigEntry` merges `config.worktree` into `ParsedConfig` under the extension, so every `readConfig` key layers. **c** a, plus a generic `readLayeredCore(ctx, keys)` for later keys | **a** | The brief scopes the change to the sparse keys. b changes 48 `readConfig` call sites' semantics and the token finders' `source` attribution, and it overturns `loadConfigEntry`'s documented local-only contract. That is a separate faithfulness change (IMPACT line I1). c is YAGNI. |
| 2 | Where the worktree boolean check sits | **a** after `memoizeGateVerdict`, outside the memo, fresh through `readSingleScope`'s stat (Part 3). **b** inside `computeGateVerdict`, with the memo and `openConfigEpoch` keyed on both files' mtimes. **c** inside `loadSparseMatcher` only | **a** | a matches O1 and O2, where the local value is named first. The parse-error rows (M1, O3, O6, O7) are already refused at open by `readRepositoryFormat`. b puts the per-gitDir worktree file into the per-session config cache, whose key cannot tell linked worktrees apart (`config-scoped-read.ts:81` is why the scoped cache keys on gitDir), and it reworks ADR-850's key. c lets `status` pass on R10, where git refuses. |
| 3 | Which `config.worktree` keys the gate checks | **a** the two sparse booleans only (R10, R12). **b** every key `assertEagerConfigValid` checks in the local file (`ignorecase`, `autocrlf`, `logallrefupdates`, …), read from `config.worktree` too. **c** none; record R10/R12 in the ledger | **a** | The brief and backlog 32.32 scope the change to the sparse keys. b is the I1 IMPACT line (every eager key, its own pin set). c leaves `status` passing on R10 / R12, where git refuses: a pinned refusal mismatch on the very keys this change starts reading from the file. |
| 4 | Shape of the worktree write | **a** new `updateScopedConfigEntries(ctx, scope, entries)`: one read-modify-write per file, caller's key casing kept. **b** sequential `setConfigEntry` calls. **c** generalise `updateConfigEntries` with an optional scope | **a** | b lowercases every key name (`parseConfigKey`), so it would write `sparsecheckout` where git writes `sparseCheckout` (B1), and it needs three writes for `disable`. c changes an exported primitive's signature. |
| 5 | Fold the non-cone pattern-file newline (S4/S1: git writes `/a/\n`, tsgit writes `a` with no trailing newline) | **a** fold: `buildSpecAndText` / `combineSpecAndText` end each pattern with `\n`. **b** IMPACT line only | **a** | Same function (`sparse-checkout.ts:184`), same verb, and the change's own probe exposed it (CLAUDE.md "fold, don't file"). The fix is one line and pinned by S1. |

## Test strategy

**Unit, domain/primitive** (`read-sparse-config.test.ts`, new; `sut = readSparseConfig`;
GWT describe/it split, AAA; memory adapter with `seedConfig` + `seedWorktreeConfig`).
`it.each` rows. Each one kills one branch:

| local | worktree | extension | expected `{ enabled, cone }` | Row |
|---|---|---|---|---|
| — | true / true | off | false / false | R1 |
| — | true / true | `false` | false / false | R13 |
| cone true | sparse true | on | true / true | R2 |
| sparse true | — | on | true / false | R3 |
| sparse true | sparse false | on | false / false | R4 |
| sparse false | sparse true | on | true / false | R5 |
| cone true | sparse true, cone false | on | true / false | R7 |
| cone false | sparse true, cone true | on | true / true | R8 |
| sparse true, cone true | cone false | off | true / true | R9 |
| — | valueless `sparseCheckout` | on | true / false | V1 |
| — | true, then false | on | false / false | D1 |
| — | sparse true | `yes` | true / false | X1 |
| — | `[core "x"] sparseCheckout = true` (subsection) | on | false / false | subsection guard |
| — | `[CORE] SPARSECHECKOUT = true` | on | true / false | case-insensitive keys |
| — | `sparseCheckout = bogus` | on | false / false (lenient) | gate owns refusal |

Linked worktree: the context's `layout.gitDir` is `.git/worktrees/wt`. Its
`config.worktree` sets sparse, the main `.git/config.worktree` does not, and the reverse
case is tested too (L2).

**Unit, writers** (`sparse-checkout.test.ts`): exact `config` / `config.worktree` text
after `set` (B1, B2, B3, B5, S1–S4), `disable` (P-dis, P-dis0, S6) and `add` (A1/B7: local
bytes unchanged). `enableWorktreeConfig` gets its own suite, with one test per step in
isolation (extension already on ⇒ no I/O; `false` rewritten; `core.worktree` moved; no
`core.worktree` ⇒ no worktree write).

**Unit, gate** (`sut = assertWorktreeSparseBooleansValid` and the two operational
entry points): R10 and R12 each refuse with a specific `data` payload (code, key, source,
value), asserted with try/catch. Each condition gets its own test. With the extension
off, R11 passes. O1 and O2 name the local value. A `config.worktree` edit made after a
settled gate verdict, in the same session, still refuses on the next command (freshness
outside the memo). A worktree file corrupted after open refuses with `CONFIG_PARSE_ERROR`.

**Interop** (`test/integration/sparse-checkout-worktree-config-interop.test.ts`, new;
`@proves surface: sparseCheckoutConfig`). It uses `makePeerPair` / `initBothRepos` /
`runGit` from `interop-helpers.ts`, and `indexState` / `listing` from
`occupant-displacement-fixtures.ts` to rebuild git's `ls-files -s -t` view from structured
state (ADR-249).

- Reader rows: git prepares the config shape (T0, R2–R5, R13, V1, D1, X1, L2), then
  tsgit and git each run the same verb. The rows compare `indexState` and `listing`. Verbs:
  `checkout other`, `reset --hard`, `reset --mixed`, ff `merge`, ff `pull`.
- `list` rows (R6–R9): `{ cone, patterns }` against `git sparse-checkout list` lines.
- Writer rows: tsgit `set` / `disable` / `add`, then byte-compare `config` and
  `config.worktree` with git's twin (B1–B6, S1–S6, L3). Then git `checkout other` on the
  tsgit-written repo, to prove git reads what tsgit wrote (W-dis, TS-set).
- Refusal rows: R10, R12, O1, O2 on tsgit `status`, checked against git's exit 128 and
  key. M1 / O3 as an `openRepository` refusal against git's exit 128 (regression rows:
  already green).

Mutation: Stryker scoped to `read-sparse-config.ts`, `enable-worktree-config.ts`, the
touched `sparse-checkout.ts` functions and `assertWorktreeSparseBooleansValid`, using the
narrowed per-module suites (`.claude/workflow/mutation.md`).

### Row walk (lesson 037)

Every pinned row, and the requirement that produces it:

| Row | Requirement(s) |
|---|---|
| T0, R2, R3, R5, V1, X1 | 2 + 4 |
| R4, D1 | 2 (last wins, worktree after local) |
| R6, R7, R8 | 2 (per key) + 4 (`list` cone) |
| R1, R9, R11, R13, M2 | 1 |
| R10, R12 | 5 (step 5, new) |
| O1, O2 | 5 (step 4 before step 5) + Decision 2 a |
| M1, O3, O6, O7 | 5 (steps 2–3, already produced at open; regression rows) |
| O5 | Out of scope (pre-existing open-path order, IMPACT) |
| O4 | not a requirement: the `config` porcelain is unchanged, and `getConfigValue` already returns the raw value |
| L2 | 3 |
| W-rows (reset hard/mixed, merge ff/3-way, pull, read-tree, stash) | 4 (every consumer reads the resolved pair; `stash` and `read-tree` are unaffected, see Context) |
| B1, P-nc, P-init, P-pre, B5, S3, S4 | 6 + 8 + 10 |
| S1, S2, S5 | 6 (no write when sparse is on and no flag is given) |
| B2, B3, B4 | 8 |
| P-dis, P-dis0, S6, B6 | 7 + 10 |
| P-add, P-re, B7, B8, A1 | 9 |
| L3 | 3 + 6 (writes `worktrees/<id>/config.worktree`) |
| W-dis, TS-set | 6 / 7 (git reads tsgit's write) |
| P-init, S5 | no tsgit `init` verb. The rows only show that `init` writes like `set` |
| L1, C1–C3 | Out of scope (`worktree add` copy) |
| R13 stale `S a/f`, N1 / R3 `top` | Out of scope (pre-existing, IMPACT) |
| I1 | Out of scope (other keys, IMPACT) |

Negative checks of the summaries: requirement 1 holds on R1, R9, R11, R13 and M2, where
the extension is off or false. Requirement 6's "no write" excludes S3, which passes a flag
and does write, and S4, where sparse is off and git writes. Requirement 9 is checked
against P-add / P-re, where the extension is on and the worktree file stays unchanged, and
against B7 / B8, where the extension is off and nothing is created.

## Out of scope

- **`worktree add` copying `config.worktree` and `info/sparse-checkout`** (L1, C1–C3). git
  copies the whole main `config.worktree`, sparse or not (C2), and the pattern file when
  sparse. tsgit copies neither. It is a `worktree add` behaviour with its own key filter
  (`core.bare` / `core.worktree` are skipped), so it is reported as an IMPACT line.
- **Every other key in `config.worktree`** (I1): `readConfig` is local-only for all
  48 call sites. Example: `core.ignorecase = bogus` in `config.worktree` makes git refuse
  `status`, while tsgit succeeds. IMPACT line.
- **Non-cone `/*` drops top-level files** (N1): with local
  `core.sparseCheckout = true` (no cone key) and the cone file read non-cone, git keeps
  `H top`, while tsgit marks `S top` and deletes it. This shows on local-only config, so
  it is not tied to `config.worktree`. IMPACT line.
- **Stale skip-worktree bits when sparse is off** (K1, R13): git keeps `S a/f` on a path
  it rewrites, while tsgit clears it. This shows with local `core.sparseCheckout = false`.
  IMPACT line.
- **Open-path refusal order** (O5): with local `core.bare = bogus` and a malformed
  `config.worktree`, git names `core.bare`, while tsgit's `readRepositoryFormat` names the
  worktree parse error. The cause is that it scans the scoped file
  (`read-repository-format.ts:209`) before `resolveBare` (`:212`). This is a `core.bare`
  layout-read order, not a sparse key. IMPACT line.
- `sparse-checkout list` on a non-sparse worktree: git refuses (R1, exit 128), while tsgit
  returns `{ cone: false, patterns: [] }`. This is pre-existing and does not depend on the
  file, so it is not touched here.
- `index.sparse = true` / `--sparse-index`: tsgit has no sparse index. `disable` writes
  only the `false` git writes.
- `core.bare = true` relocation in `enableWorktreeConfig`: a bare repository never
  reaches a sparse writer.
