<!-- cspell:ignore dwim DWIM DWIMs ignorecase lstat autosetupmerge autosetuprebase defaultremote refspec refspecs argc argv argcount configset -->
# Design — checkout-remote-branch-dwim

> Brief: backlog 32.1 row A23. `checkout <name>`, when no revision answers `<name>` and
> exactly one remote's fetch refspecs map `refs/heads/<name>` onto a ref that exists (or
> `checkout.defaultRemote` picks one of several), makes git create a local `<name>` from that
> remote-tracking ref, set up its upstream, and switch to it. tsgit throws `PATHSPEC_NO_MATCH`.
> The row's spelling `checkout <remote>/<name>` is the other case: git detaches there, and tsgit
> already matches (row R8). The fix adds git's guess in the one place tsgit gives up on a switch
> argument, and sends the guessed branch through the `-b` route `checkout` already has. Folded
> in the same seam:
> - `checkout.guess`, read and validated on every checkout as git's `git_checkout_config` does;
> - ledger row 32.1 A22 (`--detach <x>` gets git's refusal, not `PATHSPEC_NO_MATCH`);
> - the fall-through git takes after a failed guess: a switch argument that names tracked paths
>   restores them from the index (rows P1–P7), where tsgit reports `PATHSPEC_NO_MATCH` without
>   matching anything;
> - `assertBranchCreatable`'s order: git checks the new branch name before the `--detach`
>   conflict (rows B1, B2, H1d).
>
> Status: draft → self-reviewed ×3

## Context

### The backlog statement, re-pinned

Re-pinned on main d7502701 (2026-11-27) against git 2.56.1 (macOS APFS, arm64). Probes ran
with `GIT_*` scrubbed, an isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, `LANG=C`, fixed author and
committer dates, in `mktemp -d` throwaways. Every repository had `core.ignorecase` set to
`false` and then `true`. **All rows give the same result under both values.** Nothing on the
guess path reads `core.ignorecase`. The one case-sensitive row (R13c) depends on the filesystem,
not on the config, and behaves the same way in both tools (row X13c).

Fixture (all rows unless stated): an upstream `up` with `master` at c1
(`1859b13c19bfdf260dd3f7ac323813eda8cdbb10`, empty) and `feat` and `only-up` at c2
(`5e1df61848caa20fc11f60dccd4b83c59b277d4b`, adds `f.txt`). Each row works in a fresh
`git clone` of `up`, with HEAD on `master`. "+other" adds a second remote, `other`, which
is a clone of `up` holding `feat` and `only-other` at c2, and fetches it (its tracking refs
are loose; the clone's are packed).

- **Confirmed:** `checkout feat` → git creates `feat`; tsgit throws
  `{ code: 'PATHSPEC_NO_MATCH', pattern: 'feat', patterns: ['feat'] }` (R1).
- **Spelling resolved:** `checkout origin/feat` detaches in both tools (R8). Only the bare name
  is guessed.
- **Widened (same seam):** `checkout.guess` is a boolean that git validates on every
  checkout, path restores included (R24b–R24e, C1). tsgit never reads it. The A22 refusal
  (`--detach <x>`) and the path fall-through (P rows) are the two other exits of the same
  `unresolvedSwitch` arm.
- **Already right:** every step *after* the guess. Pointing tsgit's `-b` route at the
  remote-tracking ref the guess finds reproduces git's branch, upstream config, both reflogs,
  the refusal order, and the stranded branch of R17 byte-for-byte (rows X1–X22).

### git's rule (v2.56.1 source: `builtin/checkout.c`, `checkout.c`, `refspec.c`, `branch.c`)

The steps run in this order (`checkout_main` → `parse_branchname_arg` → `parse_remote_branch`
→ `unique_tracking_name` → `checkout_branch` → `switch_branches` → `update_refs_for_switch`):

| Step | Source | Rule |
|---|---|---|
| S1 | `git_checkout_config` (via `repo_config`, chained to `git_xmerge_config` → `git_default_config`) | Every `checkout.guess` entry is parsed with `git_config_bool` as it is read, so a bad value dies even if a valid one follows. The last value wins. A key with no value is true. The callback reads config entries in file order, so this refusal and the `git_default_config` refusals (`branch.autoSetupMerge`, `core.*`, …) are raised by line: the lowest line dies first. This runs for every `checkout`, path restores included. |
| S2 | `checkout_main` `dwim_ok` | The guess runs only if: `!patch_mode && dwim_new_local_branch && track == UNSPECIFIED && !new_branch`. `--[no-]guess` overrides the config. Any of `-b`/`-B`/`--orphan`/`--track`/`--no-track` turns it off. `--detach` and `-f` do **not**. |
| S3 | `parse_branchname_arg` | `-` is rewritten to `@{-1}`, and that literal string is what the guess searches for. git never guesses the branch name `@{-1}` stands for. |
| S4 | `repo_get_oid_mb(arg)` | The guess runs only when this fails. A local branch, a tag, a remote-tracking spelling or an object id wins. |
| S5 | `check_filename(prefix, arg)` | `could_be_checkout_paths`: an `lstat` of `<prefix><arg>` succeeds. Any file type counts, a directory or a dangling symlink included. This is skipped when `--` is given. |
| S6 | `no_wildcard(arg)` | An argument holding `*?[\` is never guessed. No valid refname holds those characters, so the mapped ref could never resolve anyway: this gate changes nothing observable (no row, no code). |
| S7 | `argc` shape | Only `checkout x` and `checkout x --` are guessed. With a path after the name, nothing is guessed (R9f, R9g). |
| S8 | `unique_tracking_name` | Reads `checkout.defaultRemote` from the config set (`repo_config_get_string_tmp`): the last value wins. A key with no value dies here (`missing value` + `bad config variable … at line N`), and only on this path (R27c). Then, for each remote in config order (`for_each_remote`), it runs `remote_find_tracking(refs/heads/<arg>)`: the first positive fetch refspec that maps the name. git's negative-refspec check on this source query reverses each refspec through its *destination*, so `^refs/heads/<arg>` does not exclude the name (R10c). The mapped ref must resolve (`repo_get_oid`). Each remote that resolves counts as a match. The default remote's match is kept aside. |
| S9 | `unique_tracking_name` result | Exactly one match → that ref. Several, and the default remote among them → the default's ref. Otherwise none. `checkout.defaultRemote` is compared case-sensitively (R28). |
| S10 | `parse_remote_branch` | A ref was found and S5 is true → die 128: `'<arg>' could be both a local file and a tracking branch.` |
| S11 | `parse_remote_branch` | No ref found and more than one match → advice listing the matching remotes in config order (unless `advice.checkoutAmbiguousRemoteBranchName=false`), then die 128: `'<arg>' matched multiple (<n>) remote tracking branches`. S10 is checked first but needs a ref, so with a file **and** two remotes, S11 is the error that fires (F1). |
| S12 | no guess | `parse_branchname_arg` consumes no argument, so `<arg>` becomes a pathspec. Then, in order: `-b x` → `'<arg>' is not a commit and a branch 'x' cannot be created from it`; `--detach` → `git checkout: --detach does not take a path argument '<arg>'`; otherwise `checkout_paths` restores the matched paths from the index, or reports `pathspec '<arg>' did not match`. |
| S13a | `checkout_main` | With a new branch named (`-b`, or a guessed one), `validate_new_branchname` refuses an invalid name (`'HEAD' is not a valid branch name`) or an existing branch. This runs after S12's start-point check and **before** `checkout_branch`'s `--detach` conflict (H1d, B1, B2, B3). |
| S13 | guess found | `new_branch = arg; arg = <ref>`. `setup_new_branch_info_and_source_tree(<ref>)`: a blob dies here with `reference is not a tree`. Then `checkout_branch`: `--detach` together with the guessed branch → `'--detach' cannot be used with '-b/-B/--orphan'`. The track mode comes from `branch.autoSetupMerge`. A tree dies with `Cannot switch branch to a non-commit '<ref>'` (R20). |
| S14 | `merge_working_tree` | The work tree moves first. A refusal here (local changes) leaves no branch behind (R22). |
| S15 | `create_branch(new_branch, <ref>, …, track)` | The branch reflog reads `branch: Created from <ref>`, with the full mapped ref. `setup_tracking` writes `branch.<n>.remote` / `.merge` (and `.rebase` under `branch.autoSetupRebase`). An ambiguous tracking setup dies **after** the branch was written and the work tree moved, with HEAD left where it was (R17). |
| S16 | `update_refs_for_switch` | HEAD becomes a symref to `refs/heads/<n>`. The HEAD reflog reads `checkout: moving from <old> to <n>`, where `<old>` is the branch name or the full oid when HEAD was detached (R15). |

### Pinned matrix (git 2.56.1; tsgit main d7502701; both `core.ignorecase` values identical)

"PNM" means tsgit's `{ code: 'PATHSPEC_NO_MATCH', pattern: <arg>, patterns: [<arg>] }`. Exit 0
rows of git list the state they write. Unless the row says otherwise, that state is:
`HEAD=ref: refs/heads/feat`, `branch.feat.remote=origin`, `branch.feat.merge=refs/heads/feat`,
branch reflog `branch: Created from refs/remotes/origin/feat`, HEAD reflog
`checkout: moving from master to feat` ("std").

**Guess and its gates (S1–S11, S13–S16)**

| Row | Step(s) | Setup | git | tsgit main (`checkout(...)`) |
|---|---|---|---|---|
| R1 | S8, S9, S15, S16 | one remote | 0, std | `{rev:'feat'}` → PNM |
| R1b | S8 | refs packed (`pack-refs --all`) | 0, std | PNM |
| R2 | S11 | +other | 128 `'feat' matched multiple (2) remote tracking branches`. Advice lists `origin`, `other`. | PNM |
| R2n | S11 | +other, `advice.checkoutAmbiguousRemoteBranchName=false` | 128, same fatal, no advice | PNM |
| R18 | S8 order, S11 | +other, `[remote "other"]` before `[remote "origin"]` in config | 128. Advice lists `other` then `origin`. | PNM |
| R3 | S9 | +other, `checkout.defaultRemote=other` | 0. `branch.feat.remote=other`, reflog `Created from refs/remotes/other/feat` | PNM |
| R3x | S9, S11 | +other, `defaultRemote=nope` | 128 matched multiple (2) | PNM |
| R3y | S9 | `other` configured, never fetched; `defaultRemote=other` | 0, std (one match wins over the default) | PNM |
| R3z | S9 | +other, `checkout only-other` | 0. Tracks `other`, `Created from refs/remotes/other/only-other` | PNM |
| R25 | S9 | one remote, `defaultRemote=origin` | 0, std | PNM |
| R28 | S9 | +other, `defaultRemote=OTHER` | 128 matched multiple (2): compared case-sensitively | PNM |
| C3 | S8 | +other, `defaultRemote = other` then `= origin` | 0, tracks `origin` (last value wins) | PNM |
| C2 | S8 | +other, `defaultRemote` with no value, then `= other` | 0, tracks `other` (the earlier entry is inert) | PNM |
| R27 | S8 | +other, `defaultRemote` with no value (last) | 128 `error: missing value for 'checkout.defaultremote'` / `fatal: bad config variable 'checkout.defaultremote' in file '.git/config' at line 18` | PNM |
| R27b | S8 | one remote, `defaultRemote` with no value | 128 (same pair, line 15). Read even when only one remote matches. | PNM |
| R27c | S8 laziness | `defaultRemote` with no value, `checkout origin/feat` | 0, detaches (never read) | detaches |
| C4 | S8 refspec | +other, `defaultRemote=other`, `remote.other.fetch=+refs/heads/*:refs/remotes/o2/*`, fetched | 0. Tracks `other`, `Created from refs/remotes/o2/feat` | PNM |
| R10 | S8 refspec | `remote.origin.fetch=+refs/heads/*:refs/remotes/mirror/*`, fetched | 0. Tracks `origin`, `Created from refs/remotes/mirror/feat` | PNM |
| R10b | S8 resolve | same refspec, not fetched | 1 `pathspec 'feat' did not match` | PNM |
| R10f | S8 first refspec | `origin` adds `+refs/heads/feat:refs/remotes/zz/feat`, fetched | 0, std (first refspec wins) | PNM |
| R10c | S8 negative | `origin` adds `^refs/heads/feat` | 0 **without tracking**: `Created from refs/remotes/origin/feat`, no `branch.feat.*` | PNM |
| R10d | S8 | `refs/remotes/stale/feat2`, no `stale` remote | 1 pathspec `feat2` | PNM |
| R10e | S8 | `origin` without any fetch refspec | 1 pathspec `feat` | PNM |
| R16 | S8 resolve | `remote.origin.fetch=+refs/heads/*:refs/heads/*`, `checkout only-up` | 1 pathspec `only-up` | PNM |
| R13 / R13b | S8 resolve | `checkout FEAT`, clone's packed refs / `pack-refs --all` | 1 pathspec `FEAT` | PNM |
| R13c | S8 resolve (FS) | +other (loose refs), `checkout ONLY-OTHER`, APFS | 0. Creates `ONLY-OTHER` tracking `other/ONLY-OTHER`, reflog `Created from refs/remotes/other/ONLY-OTHER`: the loose ref file matched case-insensitively | PNM |
| R17 | S15 | +other, `remote.other.fetch` maps onto `refs/remotes/origin/*`, `defaultRemote=origin` | 128 `fatal: not tracking: ambiguous information for ref 'refs/remotes/origin/feat'`. **`refs/heads/feat` is written** (reflog `Created from refs/remotes/origin/feat`), the work tree holds `f.txt` (status `A  f.txt`), HEAD stays on `master`. | PNM |
| R17b | S11 | same, no default | 128 matched multiple (2) | PNM |
| R11 | S16 | `git init`, remote added and fetched, HEAD unborn on `master` | 0, std | PNM |
| R15 | S16 | HEAD detached at c1 | 0. HEAD reflog `checkout: moving from 1859b13c19bfdf260dd3f7ac323813eda8cdbb10 to feat` | PNM |
| R9e | S2 (`-f`) | `f.txt` dirty | 0, std | `{rev:'feat',force:true}` → PNM |
| R12 | S15 | `branch.autoSetupMerge=false` | 0, no `branch.feat.*` | PNM |
| R12b | S15 | `=inherit` | 0. `warning: asked to inherit tracking from 'refs/remotes/origin/feat', but no remote is set`, no `branch.feat.*` | PNM |
| R12c / R12e | S15 | `=simple` / `=always` | 0, std | PNM |
| R12d | S15 | `branch.autoSetupRebase=always` | 0. std plus `branch.feat.rebase=true` | PNM |
| R22 | S14 | on `wip` with `f.txt` staged dirty | 1 `Your local changes … would be overwritten`. Heads: `master`, `wip` only. | PNM |
| R20 | S13 | `refs/remotes/origin/treeish` → a tree | 128 `Cannot switch branch to a non-commit 'refs/remotes/origin/treeish'` | PNM |

**What wins before the guess (S3, S4) and the order of S5/S10/S11**

| Row | Step(s) | Setup | git | tsgit main |
|---|---|---|---|---|
| R7 | S4 < S8 | local `feat` at c1 | 0, plain switch to the local branch, no config written | same |
| R21 | S4 < S8 | tag `feat` at c2 | 0, detaches at c2 | same |
| R8 | S4 | `checkout origin/feat` | 0, detaches. HEAD reflog `… to origin/feat` | same |
| R19 | S3 | previous branch `feat` deleted locally, `origin/feat` present, `checkout -` | 1 `pathspec '-' did not match` | `{rev:'-'}` → PNM `-` (same) |
| R19b | S3 | same, `checkout @{-1}` | 1 pathspec `@{-1}` | — |
| R6 | S5, S10 | untracked file `feat` | 128 `'feat' could be both a local file and a tracking branch.` | PNM |
| R32 | S5 | directory `feat/` | 128 could be both | — |
| F2 | S5 | dangling symlink `feat` | 128 could be both | — |
| F3 / F3b | S5 prefix | `sub/feat`, run from the top / from `sub/` | 0 std / 128 could be both | — |
| F1 | S10 < S11 | file `feat` + other | 128 matched multiple (2) | PNM |
| R31 | S2 < S5 | file `feat`, `checkout.guess=false` | 1 pathspec `feat` | — |
| R6a / R6d | `--` | `checkout feat --`, with / without the file | 0, std (no API counterpart in tsgit, see DC-1) | — |
| R6b | `--` first | `checkout -- feat` | 1 pathspec `feat` | — |
| R6e | `--` | `checkout nothere --` | 128 `invalid reference: nothere` | — |

**The gate (S1, S2)**

| Row | Step(s) | Setup | git | tsgit main |
|---|---|---|---|---|
| R4 | S2 | `checkout.guess=false` | 1 pathspec `feat` | PNM |
| R5 | S2 | `--no-guess` | 1 pathspec `feat` | no option |
| R5b | S2 | `checkout.guess=false`, `--guess` | 0, std | no option |
| R26 | S1 | `checkout.guess` with no value | 0, std (true) | — |
| R29 | S1 | `guess = false` then `guess = true` | 0, std (last wins) | — |
| C1 | S1 | `guess = bogus` then `guess = true`, `checkout master` | 128 `bad boolean config value 'bogus' for 'checkout.guess'` | — |
| R24b / R24c / R24d / R24e | S1 < everything | `guess=bogus`; `checkout master` / `checkout -- f.txt` / `--no-guess feat` / `origin/feat` | 128 bad boolean, all four | R24b: `{rev:'master'}` succeeds |
| O1 / O2 | S1 line order | `guess=bogus` and `branch.autoSetupMerge=bogus`, guess first / second, `checkout master` | O1: names `checkout.guess`; O2: names `branch.autosetupmerge` | — |
| R30 | S1 (eager key) | `branch.autoSetupMerge=bogus`, `checkout origin/feat` | 128 bad boolean `branch.autosetupmerge` | eager gate (existing) |
| R9a / R9b / R9d | S2 (`-b`/`-B`/`--orphan`) | `checkout -b x feat` (and `-B`, `--orphan`) | 128 `'feat' is not a commit and a branch 'x' cannot be created from it` | `{rev:'feat',createBranch:{name:'x'}}` → `CHECKOUT_START_POINT_NOT_COMMIT {revision:'feat',branch:'x'}` (same) |
| R9h / R9i | S2 (`--track`/`--no-track`) | `checkout --track feat` / `--no-track feat` | 128 `missing branch name; try -b` | no counterpart (`createBranch` always names the branch) |
| R9j | `--track` name DWIM | `checkout --track origin/feat` | 0. Tracks `origin`, reflog `Created from origin/feat` | no counterpart (Out of scope). The explicit form `{rev:'origin/feat',createBranch:{name:'feat',track:'direct'}}` writes the same bytes. |
| R9c | S2, S13 | `checkout --detach feat` | 128 `'--detach' cannot be used with '-b/-B/--orphan'` (the guess runs, then refuses) | `{rev:'feat',detach:true}` → PNM |
| H1 | S8, S13a | `git init`, origin fetched (fetch writes `refs/remotes/origin/HEAD`), unborn, `checkout HEAD` | 128 `'HEAD' is not a valid branch name`, no branch | `{rev:'HEAD'}` → PNM `HEAD` |
| H1d | S13a < S13 | same, `checkout --detach HEAD` | 128 `'HEAD' is not a valid branch name` (the name is checked before `--detach`) | PNM |
| H2 | S8 | same, `checkout @` | 1 pathspec `@` (`refs/remotes/origin/@` does not exist) | PNM `@` (same) |
| B1 | S13a < S13 (`-b`) | `checkout -b HEAD --detach` | 128 `'HEAD' is not a valid branch name` | `INVALID_OPTION {option:'createBranch',reason:'cannot be combined with detach'}` |
| B2 | S13a < S13 (`-b`) | `checkout -b master --detach` | 128 `a branch named 'master' already exists` | `INVALID_OPTION … detach` |
| B3 | S12 < S13a | `checkout -b master nothere` | 128 `'nothere' is not a commit and a branch 'master' cannot be created from it` | same code (`CHECKOUT_START_POINT_NOT_COMMIT`) |
| A22d | S11 < S13 | `--detach feat`, +other | 128 matched multiple (2) | PNM |
| A22e | S10 < S13 | `--detach feat`, file `feat` | 128 could be both | PNM |

**No guess: the fall-through (S12)**

| Row | Setup | git | tsgit main |
|---|---|---|---|
| A22a | `checkout --detach nothere` | 128 `git checkout: --detach does not take a path argument 'nothere'` | PNM |
| A22c | `checkout --detach g.txt` (tracked) | 128, same refusal naming `g.txt` | PNM (per the ledger row) |
| P1 | tracked `g.txt`, `h.txt`, both dirty; `checkout g.txt` | 0 `Updated 1 path from the index`; `g.txt` restored, `h.txt` kept | `{rev:'g.txt'}` → PNM, `g.txt` still dirty |
| P2 | same, `checkout '*.txt'` | 0, both restored | — |
| P3 | same, `checkout -f g.txt` | 0, restored | — |
| P4 | same, plus `refs/remotes/origin/g.txt` | 128 could be both | — |
| P5 | P4 with `checkout.guess=false` | 0, restored | — |
| P6 | `checkout -b x g.txt` | 128 `'g.txt' is not a commit and a branch 'x' cannot be created from it` | same code as R9a |
| P7 | unborn HEAD, `g.txt` staged, then dirtied | 0, restored from the index | — |
| U1 | `g.txt` unmerged (conflicted merge), `checkout g.txt` | 1 `error: path 'g.txt' is unmerged` | — (`{paths:['g.txt']}` refuses `path is unmerged` since #332) |
| U2 | same, `checkout -f g.txt` | 0 `warning: path 'g.txt' is unmerged`, `Updated 0 paths`; the conflict is kept | — (no forced path restore in tsgit) |
| R9f | `checkout feat f.txt` | 1 pathspec `feat` and pathspec `f.txt` | no counterpart (`rev` with `paths` is refused) |
| R9g | `checkout feat -- f.txt` | 128 `invalid reference: feat` | `{paths:['f.txt'],source:'feat'}` → `REVPARSE_UNRESOLVED {expression:'feat'}` (the existing mapping) |

**tsgit's `-b` route aimed at the guessed ref (the machinery the fix reuses)**

`{ rev: 'refs/remotes/origin/feat', createBranch: { name: 'feat' } }` on main, in the R-row layouts:

| Row | Mirrors | tsgit main |
|---|---|---|
| X1 | R1 | std, byte-identical (`Created from refs/remotes/origin/feat`) |
| X12 / X12b / X12d | R12 / R12b / R12d | no config / no config (warning through `ctx.logger`) / std plus `branch.feat.rebase true` |
| X10c | R10c | branch written, no `branch.feat.*` |
| X17 | R17 | `TRACKING_AMBIGUOUS {ref:'refs/remotes/origin/feat',remotes:['origin','other']}`; `refs/heads/feat` written, `A  f.txt`, HEAD on `master` |
| X18 | R18 order | `remotes: ['other','origin']`: the config map keeps config order |
| X22 | R22 | `CHECKOUT_OVERWRITE_DIRTY`, no branch written |
| X20 | R20 | `CHECKOUT_NON_COMMIT {revision:'refs/remotes/origin/treeish'}` |
| X9c | R9c | `INVALID_OPTION {option:'createBranch',reason:'cannot be combined with detach'}`, raised before the work tree moves |
| X13c / X13b | R13c / R13b | loose `ONLY-OTHER` resolves on APFS and writes git's bytes / packed `FEAT` does not resolve |

### Gaps in the same seam (verdicts under doctrine)

| Gap | Rows | Verdict |
|---|---|---|
| G-a: no guess at all | R1–R3z, R10*, R11–R17, R20, R22, R25–R28, C2–C4 | The subject of this change. |
| G-b: `checkout.guess` is never read or validated | R4, R24b–e, R26, R29, C1, O1 | Folded. tsgit has to read the key to gate the guess, and faithfulness covers how it reads it (ADR-1170: "faithfulness is unchanged for new work"). |
| G-c: `--detach <x>` refusal (ledger 32.1 A22) | A22a, A22c | Folded by ADR-1170's way back plus D-5: its locus is `unresolvedSwitch`, the arm this change rewrites. The ledger row is removed. |
| G-d: a switch argument naming tracked paths is never restored | P1–P3, P5, P7 | Folded by D-5. On main, `unresolvedSwitch` reports `PATHSPEC_NO_MATCH` without evaluating the pathspec. The guess's miss path *is* that line. |
| G-e: forced fall-through on an unmerged path | U2 | tsgit has no forced path restore. The extent of the fold is DC-5. |
| G-f: `checkout --track <remote>/<name>` without a name | R9j | Feature gap below the filing bar: the explicit `createBranch` form writes the same bytes. Ledger. |
| G-g: `assertBranchCreatable` checks `detach` before the name | B1, B2 on main; H1d reachable only through the guess | Folded by D-2's second clause: the guess makes H1d reachable, and H1d inherits the order `-b` already has wrong. Reorder to name validity, then existence, then `detach` (S13a before S13). |

### Code map (names, not line numbers)

- `src/application/commands/checkout.ts`
  - `CheckoutSwitchOptions`: gains the option from DC-1.
  - `CheckoutResult`: gains the field from DC-2.
  - `resolveSwitch(ctx, opts: TargetedSwitch): Promise<SwitchTarget>`: where the guess goes. Today it ends with `if (named === undefined) throw unresolvedSwitch(opts)`.
  - `unresolvedSwitch(opts: TargetedSwitch)`: today it builds `pathspecNoMatch` or `checkoutStartPointNotCommit`. It gains the A22 arm and the fall-through (§3).
  - `resolveCommitSwitch(ctx, opts): Promise<ResolvedSwitch>`, `switchToCommit`, `switchInPlace`, `finishSwitch`, `createRequestedBranch(ctx, opts, startPoint): Promise<RefName | undefined>`, `assertBranchCreatable`, `moveHeadForSwitch` (its label is `opts.createBranch?.name ?? branchName`).
  - `checkoutInScope`: the S1 gate (§4). `pathRestore(ctx, CheckoutPathsOptions)`: reused by G-d.
- `src/application/commands/branch.ts`: `branchCreate(ctx, BranchCreateInput): Promise<BranchCreateResult>` (`{ name, id, upstream? }`). Reused unchanged.
- `src/application/commands/internal/branch-tracking.ts`: `resolveTrackMode`, `trackableStartRef`, `setupTracking`, `remoteSources`, `trackingAmbiguous` (R17 already right). Unchanged.
- `src/application/commands/internal/remote-tracking-ref.ts`: `findTrackingRef(specs, ref): RefName | undefined`, git's `remote_find_tracking` for a source query, with negative refspecs judged by the reversed query. This is the S8 mapper; R10c pins that it keeps git's quirk.
- `src/application/commands/internal/misspelt-revision.ts`: `checkFilename(ctx, arg)` (module-private; git's `check_filename` with the cwd prefix, `:/` magic and dangling links). Export it for S5.
- `src/application/primitives/config-read.ts`: `readConfig` (the `remote` map in config order, as `branch-tracking.ts` uses it), `findLastEntry(ctx, section, key): LocatedConfigEntry | undefined` (config-set last value, `value: null` when there is no value), `parseGitBoolean(value)`, `findFirstInvalidBoolean(ctx, section, subsection, keys)` (every entry, file order).
- `src/application/primitives/internal/repo-state.ts`: `assertEagerConfigValid`, `EagerCandidate`, `pickLowerLine`, `throwEagerCandidate`, `assertOperationalRepository` (memoized `computeGateVerdict`). The S1 line-order merge goes here (DC-4).
- `src/domain/commands/error.ts`: `pathspecNoMatch`, `checkoutStartPointNotCommit`, `checkoutNonCommit`, `invalidOption`, `trackingAmbiguous`, `configMissingValue(key, source, line)`, `configBadBooleanValue(key, source, value)`. The new factories (DC-3) go next to `trackingAmbiguous`.
- New: `src/application/commands/internal/remote-branch-guess.ts` (§2).
- Tests: `test/unit/application/commands/checkout-switch-target.test.ts`, `checkout-create-branch.test.ts`, `checkout.test.ts`; `test/unit/application/commands/internal/remote-tracking-ref.test.ts`, `misspelt-revision.test.ts`; interop helpers in `test/integration/interop-helpers.ts` (`GIT_AVAILABLE`, `git`, `runGit`, `runGitEnv`, `tryRunGitWithExit`, `disableAutoMaintenance`); a sibling suite to model on: `test/integration/switch-and-tag-target-dwim-interop.test.ts`.
- tsgit has **no `switch` command** (`src/application/commands/` and `src/repository.ts`). git's `switch <name>` guess (`--guess` on by default, `checkout.guess` shared) has no counterpart here. Out of scope.

### Constraining ADRs, doctrine, lessons

- ADR-226 (prime directive), ADR-249 (structured output: the result carries data, never `Switched to a new branch` or the advice text).
- ADR-1170 (filing bar, net-zero cap, the way back for ledger rows a change touches).
- ADR-1257 / D-6 (fixes that only change verdicts or returned values are not breaking), D-3, D-4 (copy git's destructive arms: P1 overwrites local changes and R17 strands a branch, both as git does), D-5 (fold divergences in an edited seam: G-c, G-d), D-7 (perf gates, §6).
- ADR-1037 (`PATHSPEC_NO_MATCH` carries every unmatched pattern), ADR-1199 (the previous rewrite of this arm: unborn-HEAD codes, `rev` made optional).

## Requirements

- **R1** With no guess flag passed and `checkout.guess` unset or true, `checkout({ rev: n })`
  where no revision answers `n` follows S5–S16. Rows R1–R3z, R10*, R11–R18, R20, R22, R25–R28,
  C2–C4, F1–F3b and R6/R32 match git: the same refs, config bytes, both reflogs, refusal
  conditions, and work-tree state on refusal (R17's stranded branch included).
- **R2** The guess runs only on the miss path. Every row where S4 resolves (R7, R8, R21, any
  existing switch) reads no remote config and does no `lstat` for the guess.
- **R3** `checkout.guess` (S1): a bad value refuses every `checkout` call, path restores
  included, with `CONFIG_BAD_BOOLEAN_VALUE` keyed `checkout.guess`. Between it and the eager
  keys, the lowest line wins (O1/O2). A key with no value is true, and the last entry wins.
- **R4** The caller can turn the guess on or off per call, as `--[no-]guess` does (R5, R5b). Shape: DC-1.
- **R5** `checkout.defaultRemote` is read only on the guess path. The last entry wins, it is
  compared case-sensitively, and a last entry with no value refuses with
  `CONFIG_MISSING_VALUE { key: 'checkout.defaultremote', line }` (R27, R27b, C2, C3, R28).
- **R6** A guessed branch is created exactly as `createBranch: { name: n }` with start point
  `<mapped ref>` would create it. The result reports it as data (DC-2).
- **R7** The S12 exits: `--detach` gets git's refusal (A22a/c). A plain switch argument restores
  the tracked paths it matches from the index (P1–P3, P5, P7, U1), or refuses with
  `PATHSPEC_NO_MATCH` when it matches nothing.
- **R8** No rendered text in results or error data. Refusals carry the fields git's message is
  rebuilt from (the name, the remotes in config order, the path argument).

## Design

### 1. Flow: git's rewrite, in the one arm where tsgit gives up

```
resolveSwitch(opts)                       (S4: named / branchFor, unchanged)
  ├─ branch found ─────────────▶ switch (unchanged)
  ├─ named found ──────────────▶ detach (unchanged)
  └─ neither:
       guessAllowed(opts)?  (no createBranch, guess option ?? checkout.guess)
         └─ yes: uniqueTrackingName(ctx, arg)              (S8, S9)
              ├─ ref, and checkFilename(arg) ─▶ throw PATH_OR_TRACKING_BRANCH  (S10)
              ├─ ref ─────────────▶ return the rewritten request:            (S13)
              │                      rev: ref, createBranch: { name: arg }
              └─ none, ≥2 matches ▶ throw REMOTE_BRANCH_AMBIGUOUS             (S11)
       unresolvedSwitch(opts)                                                 (S12)
         ├─ createBranch ─▶ CHECKOUT_START_POINT_NOT_COMMIT (unchanged)
         ├─ detach ───────▶ the A22 refusal (DC-3)
         └─ otherwise ────▶ pathRestore({ paths: [opts.rev] })   (G-d; PNM comes from the restore)
```

The rewritten request then goes through the **existing** `-b` pipeline. Each git step lands on
code that already exists:

- `switchCommit`: a blob refuses as `reference is not a tree` does. A tree returns `undefined`.
- `assertBranchCreatable`, reordered by G-g: `newBranchRef` (H1, H1d), then `branchExists`,
  then `detach` with X9c's code (S13a, then S13: R9c, B1, B2). All of it runs before the work
  tree moves.
- `checkoutNonCommit(arg)`: names the mapped ref (R20, X20).
- `materializeSwitch`: refusals leave no branch (S14, R22).
- `finishSwitch` → `createRequestedBranch(ctx, request, request.arg)` → `branchCreate`:
  `Created from <ref>`, tracking from `branch.autoSetupMerge`/`autoSetupRebase`, and
  `TRACKING_AMBIGUOUS` after the write (S15, R17).
- `moveHeadForSwitch`: the label is `createBranch.name`, the guessed `n` (S16).
- The smudge metadata `checkoutMetadataFor(ctx, branchName, oid)` gets the ref as its name.
  This matches git, whose `new_branch_info->name` is still the mapped ref during
  `merge_working_tree`: `update_refs_for_switch` renames it only afterwards.

Plumbing: `resolveSwitch` returns a discriminated union,
`SwitchResolution = { kind: 'target'; request: TargetedSwitch; target: SwitchTarget } | { kind: 'restored'; result: CheckoutResult }`.
The `'restored'` kind is the §3 fall-through. The guessed target is
`{ arg: ref, branchName: ref, onBranch: undefined, object: <oid from S8> }`, so the ref is not
resolved a second time. `resolveCommitSwitch` runs `assertBranchCreatable(ctx, request)` with
that request and returns it inside `ResolvedSwitch`. `switchToCommit` then hands
`resolved.request` (not the caller's `opts`) to `switchRequestOf` and `finishSwitch`.
`switchInPlace` needs no change: `keepsWorkingTreeAsIs` requires `createBranch`, and a guess
requires its absence.

`arg` is the string after `previousCheckoutArg` (`-` → `@{-1}`), never `interpretBranchName`'s
result (S3, R19/R19b). The fall-through and the PNM name `opts.rev`, the caller's spelling
(`-` in R19).

### 2. `remote-branch-guess.ts` (new, internal)

```ts
/** git's `unique_tracking_name`: the remote-tracking ref `refs/heads/<name>` maps onto. */
export interface TrackingNameGuess {
  readonly ref: RefName | undefined;      // the chosen ref (S9), undefined when none
  readonly id: ObjectId | undefined;      // what it resolved to
  readonly remotes: ReadonlyArray<string>; // every matching remote, config order
}
export const uniqueTrackingName = (ctx: Context, name: string): Promise<TrackingNameGuess>;
```

- Walk `(await readConfig(ctx)).remote` in map order (config order, X18). For each remote,
  `findTrackingRef(entry.fetch ?? [], 'refs/heads/' + name)`. Resolve the mapped ref with
  `resolveSwitchTarget` (git's `repo_get_oid`; it must answer `undefined`, not throw, for
  `refs/remotes/origin/@{-1}`: R19b). A remote whose ref resolves is a match.
- `checkout.defaultRemote` is read **inside** the walk's caller, before the walk, as git does
  (R27b: it refuses even when only one remote matches). Use `findLastEntry(ctx, 'checkout',
  'defaultRemote')`. When the entry has no value, throw `configMissingValue('checkout.defaultremote',
  source, line)`.
- Choosing (S9): one match → that one. Otherwise the default's match (exact `===`), or `undefined`.
- `guessAllowed(ctx, opts)`: `opts.createBranch === undefined && (opts.guess ?? await readCheckoutGuess(ctx))`.
  `readCheckoutGuess` takes `parseGitBoolean` of `findLastEntry(ctx, 'checkout', 'guess')`
  (absent → true; no value → true). The bad-value refusal is S1's job (§4), so this read never refuses.

Each export stays under 20 lines. The module has no state.

### 3. The S12 arm

`unresolvedSwitch` becomes async and returns either a refusal or the fall-through result:

```ts
const unresolvedSwitch = (ctx: Context, opts: TargetedSwitch): Promise<CheckoutResult> => {
  if (opts.createBranch !== undefined)
    throw checkoutStartPointNotCommit(opts.rev, opts.createBranch.name);
  if (opts.detach === true) throw checkoutDetachPathArgument(opts.rev);   // DC-3
  return pathRestore(ctx, { paths: [opts.rev] });                         // DC-5 for `force`
};
```

The function returns a `CheckoutResult` from the switch path, so the miss short-circuits from
`resolveSwitch` up to `switchBranch` as `{ kind: 'restored'; result }` (§1).
`resolveCommitSwitch`, `switchToCommit` and `switchInPlace` pass it up unchanged. A design that throws and catches a sentinel is refused: it would be exceptions
used for control flow.

The restore runs where git runs `checkout_paths`: after `parse_branchname_arg`, under the
index lock, with the `post-checkout` file flag. That is `pathRestore`'s existing contract, so
U1 (`path is unmerged`) and P7 (unborn) come for free. `PATHSPEC_NO_MATCH` now comes from a
real pathspec evaluation (ADR-1037 shape), so R4, R10b, R10d, R10e, R13, R16 and R19 keep
their data byte for byte.

### 4. S1: `checkout.guess` validated on every checkout (DC-4)

Under `checkoutInScope`, before the mode split, whatever the mode. `assertOperationalRepository`
already raises the eager set (lowest line first). The command key has to join that race:
whichever of the eager winner and the first bad `checkout.guess` entry
(`findFirstInvalidBoolean(ctx, 'checkout', undefined, ['guess'])`) sits on the lower line is
the one refused (O1 → `checkout.guess`, O2 → `branch.autosetupmerge`). The option `guess` does
not skip the check (R24d).

### 5. Result shape (DC-2)

The recommended shape reuses `BranchCreateResult`:

```ts
export interface CheckoutResult {
  readonly branch: RefName | undefined;
  readonly id: ObjectId;
  readonly detached: boolean;
  readonly changedPaths: number;
  /** The branch this checkout created (`createBranch`, or git's remote-branch guess), with its upstream. */
  readonly createdBranch?: BranchCreateResult;
}
```

This is enough to rebuild git's two lines:

- `branch 'feat' set up to track 'origin/feat'.` comes from `upstream.remote` + `upstream.merges[0]`
  (the interop test rebuilds it, ADR-249).
- `Switched to a new branch 'feat'` comes from `createdBranch !== undefined`.

`createRequestedBranch` returns the `BranchCreateResult` instead of `.name`.

### 6. Performance (D-7)

- The miss path is new work only where main threw: no gate. The `-b` route it reuses is
  already benched by `checkout.bench.ts`.
- The hit path gains one thing: S1's `findFirstInvalidBoolean` over the epoch-cached config
  tokens (`readConfigEntry` is a WeakMap hit inside the epoch the gate opened: no I/O). It
  runs once per command, not once per entry. R2 requires no remote-config read and no `lstat`
  on the hit path, and a unit row asserts this by outcome (a remote config that would refuse
  if read). Whether D-7's bench pair applies to a once-per-command token scan is DC-6.

### 7. Public API and breaking classification

- Turning a throw into a success (G-a, G-d) and replacing one refusal with another (G-c) are
  verdict changes: D-6, `fix(checkout):`, no `!`.
- New error codes (DC-3) extend the error-data union. ADR-1196 and ADR-1199 shipped new codes
  on existing calls as fixes.
- The `guess` option and the `createdBranch` field are additive optional members. Their
  classification is DC-7.
- `docs/api.json` (or the API report the pre-push hook refreshes) changes with them. Regenerate
  it at pre-push.

### 8. Size note

The new module, three error factories, the S12 arm and the S1 merge add an estimated
0.6–1.0 kB gzip to `Browser bundle (no-build)` (cap 374.9 kB, about 20 B headroom) and to
`Command (checkout)`. Raise the caps in a `chore(size)` commit after a clean rebuild
(`rm -rf dist .wireit`). This is expected and not a decision.

### 9. Docs to update (documentation phase)

- `docs/known-divergences.md`: remove `32.1 row A22`. Add G-f (R9j, feature gap) and, if DC-5
  is B, U2 (rare config and edge input).
- `docs/BACKLOG.md`: strike `32.1` row A23 and move the release-order row 3 marker.
- `docs/spike/faithfulness-triage-2026-10.md` rows A22/A23: append "closed by <PR>".
- The checkout API docs: `guess`, `createdBranch`, the new codes, and "a `rev` that names
  tracked paths restores them".
- Filing (ADR-1170): this change closes A23 and files **0** backlog entries. G-f, and U2 if
  DC-5 is B, go to the ledger.

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| DC-1 | Per-call counterpart of `--[no-]guess` | A: `guess?: boolean` on `CheckoutSwitchOptions` (`false` = `--no-guess`, `true` overrides `checkout.guess=false`, omitted = config) · B: none, config only · C: `noGuess?: true`, styled like `createBranch.noTrack` | A | R5/R5b are observable git behaviour, and without A they cannot be expressed per call (ADR-1170 bar 2). A is the only shape that also expresses R5b. C cannot. B forces a config write to say `--no-guess`. There is no `--` counterpart: the R6 refusal is answered by `guess: false` or by an explicit `createBranch` with `rev: 'origin/<n>'` |
| DC-2 | Report the created branch | A: `createdBranch?: BranchCreateResult`, set by `createBranch` **and** the guess · B: no field (the caller compares `branch` with what it asked) · C: `guessedFrom?: RefName` for the guess only | A | git reports the creation and the upstream. Without A, a guessed switch and a plain switch return identical results, so the caller cannot tell a branch was created or what it tracks (ADR-249: ship the fields). A reuses an existing type, and `-b` gains the same fact. Cost: `-b` unit tests that `toEqual` the whole result gain the field. C leaves `-b` without it and adds a second shape |
| DC-3 | Error shapes for the new refusals | A: new codes: `CHECKOUT_REMOTE_BRANCH_AMBIGUOUS { name, remotes }`, `CHECKOUT_PATH_OR_TRACKING_BRANCH { name }`, `CHECKOUT_DETACH_PATH_ARGUMENT { argument }`; the guessed `--detach` (R9c) reuses `INVALID_OPTION { option: 'createBranch', reason: 'cannot be combined with detach' }` · B: as A, but R9c gets `INVALID_OPTION { option: 'detach', … }` · C: `INVALID_OPTION` with the argument in `reason` for all three, `TRACKING_AMBIGUOUS` for S11 | A | Each git message carries an argument that has to survive as data (R8, ADR-249). `TRACKING_AMBIGUOUS` is git's *other* refusal (R17, `not tracking: ambiguous information`), so reusing it would merge two distinct conditions. R9c prints git's `-b` message word for word, and A keeps the one code that already rebuilds that message (X9c). B splits one git message across two codes |
| DC-4 | S1 line order between `checkout.guess` and the eager keys | A: merge the command key into the eager race (the lowest line wins: O1/O2), through an `assertOperationalRepository` variant that takes command keys · B: validate `checkout.guess` after the eager gate (wrong only when two bad keys coexist; ledger row) · C: validate before the gate | A | O1/O2 are pinned. B leaves a pinned row red on new work, and ADR-1170 does not relax faithfulness for new work. C also over-refuses ahead of setup's refusals. Cost: the memoized verdict has to expose the winner's line instead of only throwing |
| DC-5 | How far the fall-through fold goes (G-d, G-e) | A: plain and forced: `force` restores with git's ignore-unmerged arm (warn and skip, U2) · B: route `force` to the plain restore (identical except on unmerged paths, where it refuses as U1 does; U2 goes to the ledger) · C: fold none of G-d; ledger it as "the API separates rev and paths" | B | D-5 makes G-d a fold, and the P rows are pinned. Only the `force` variant needs machinery tsgit's path mode lacks entirely (`checkout -f -- p` is not expressible today either), so A grows the change into a forced path restore with no caller. C contradicts D-5 |
| DC-6 | Perf gate for the hit path | A: none beyond `bench:ab` on `checkout.bench.ts` (the addition is one in-memory scan of cached config tokens per command) · B: a D-7 bench pair: a switch with a 200-entry config against a floor twin, gate measured | A | D-7 targets per-item hot-path work (a hash per entry, an `lstat` per probe). This is one constant-size scan per command, with no I/O. B can be added if `bench:ab` shows a delta |
| DC-7 | Commit classification of `guess` and `createdBranch` | A: `feat(checkout):` without `!` (additive optional members break no caller; semver minor), with the guess itself in `fix(checkout):` · B: `!` per ADR-1257's "signature or type change" wording · C: everything in one `fix(checkout):` | A | No caller compiled against the current types fails, so ADR-1257's purpose (warn the callers it breaks) is not engaged. C hides a new option inside a fix. If B is chosen, the D-6 wording should say whether additive members count |

### Settled by doctrine, not candidates

| Point | Settled by |
|---|---|
| Fold `checkout.guess` validation and reading (G-b) | ADR-1170: faithfulness unchanged for new work. The key is read by this change |
| Fold ledger row A22 (G-c) | ADR-1170 way back, D-5 (locus: `unresolvedSwitch`) |
| Fold the plain fall-through (G-d) | D-5. Its extent is DC-5 |
| Reorder `assertBranchCreatable` (G-g), for `-b` too | D-2 (a row the change makes reachable inherits a divergence the shared check has on main) |
| Copy P1's overwrite of local changes and R17's stranded branch | D-4. R17 is already tsgit's behaviour (X17) |
| `fix(checkout):` for G-a, G-c, G-d | D-6, ADR-1196/1199 precedent for new codes |
| `checkout --track origin/feat` without a name (G-f), `switch` | ADR-1170: below the bar (expressible), and no `switch` command → ledger / out |
| Size cap raise | Memory "always raise size caps": a `chore(size)` commit, not a question |

## Test strategy

### Unit (red first)

- `test/unit/application/commands/internal/remote-branch-guess.test.ts` (new, memory adapter):
  - one match / none / two (config order kept) / two with a matching default / two with an
    unmatched default / one match with the default elsewhere (R3y);
  - default compared case-sensitively; last default wins; a default with no value refuses
    `CONFIG_MISSING_VALUE` with key and line (try/catch on `.data`), also when only one remote matches;
  - a remapped refspec, the first refspec wins, a mapped ref that does not resolve, a remote with
    no `fetch`, negative refspec does not exclude (R10c), a mirror refspec (R16), `@{-1}` (R19b)
    answers no match without throwing;
  - `guessAllowed`: option over config both ways, no value = true, last entry wins, `createBranch` disables.
- `test/unit/application/commands/checkout-remote-branch-guess.test.ts` (new, command level):
  - std result, including `createdBranch.upstream`, branch reflog, HEAD reflog and config;
    unborn HEAD; detached HEAD label;
  - each refusal with its `.data` (S10, S11 with remotes in order, R9c, R20, A22a/c), and each
    guard isolated: file without remote (pathspec), file with two remotes (S11), file with
    `guess: false` (pathspec), `detach` with two remotes (S11);
  - `force: true` guesses; `createBranch` never guesses (R9a data unchanged);
  - the hit path never reaches the guess: with a `checkout.defaultRemote` that has no value
    (which refuses if read, R27b), `rev: 'origin/feat'` and `rev: <existing branch>` succeed
    (checked by outcome, as R27c is; lesson 011 bans call-count spies);
  - G-g order: `{createBranch:{name:'HEAD'},detach:true}` → `INVALID_REF`; an existing name
    with `detach` → `BRANCH_EXISTS`; a valid new name with `detach` → `INVALID_OPTION`. Plus
    the guessed H1 and H1d;
  - R17 at the unit level: `TRACKING_AMBIGUOUS`, the branch written, HEAD unchanged.
- `checkout-switch-target.test.ts`: the fall-through rows. `{rev:'g.txt'}` restores from the
  index and returns the path-restore result. A glob restores all matches. Unmerged refuses
  `path is unmerged`. Nothing matched → PNM with ADR-1037's `patterns`. `-` keeps the caller's spelling.
- `checkout.test.ts`: S1. A bad `checkout.guess` refuses `{rev}` and `{paths}`. `guess: false`
  does not skip the check. Line order against `branch.autoSetupMerge` both ways.
- `checkout-create-branch.test.ts`: `createdBranch` on `-b` (DC-2 A) and on `-b --track`.
- `misspelt-revision.test.ts`: `checkFilename` export (existing rows cover the dangling link and the prefix).
- `test/unit/domain/commands/error.test.ts`: each new factory's data, with sanitized names.
- No property sibling: the module composes `findTrackingRef` (refspec grammar already covered
  in `remote-tracking-ref` tests) with a choice rule. No round-trip or grammar lens fits
  (`.claude/workflow/property-testing.md` lens check: no parser, no serializer, no matcher of its own).

### Interop (new `test/integration/checkout-remote-branch-dwim-interop.test.ts`)

The layout follows `switch-and-tag-target-dwim-interop.test.ts`:

- One base built once with canonical git (an `up` repo plus a clone, plus the `other` remote).
  Each row copies it into a fresh `peer` (moved by git) and `ours` (moved by tsgit).
- Outer `describe.each(['false', 'true'])('Given core.ignorecase is %s')`.
- Signing off, `runGitEnv()` scrubbed env, fixed dates.

Comparisons per row: exit code against thrown `.data`. For the success rows: `.git/HEAD`,
`git config --get-regexp '^branch\.<n>\.'`, the branch reflog subject, the HEAD reflog subject,
`for-each-ref refs/heads`, and `status --porcelain`. git's display lines are rebuilt from the
result fields (ADR-249).

| Row | tsgit call | Asserts |
|---|---|---|
| R1, R1b, R11, R15, R9e | `{rev:'feat'}` (`force` for R9e) | std / detached label |
| R3, R3y, R3z, R25, C2, C3, C4 | `{rev:'feat'}` / `'only-other'` | chosen remote and `Created from` ref |
| R10, R10c, R10f | `{rev:'feat'}` | mapped ref; R10c has no `branch.feat.*` |
| R12, R12b, R12d | `{rev:'feat'}` | config per mode |
| R13c | `{rev:'ONLY-OTHER'}` | same outcome as git on the host FS (both tools share the filesystem; both no-guess on Linux) |
| R2, R18, R28, R3x, F1, A22d | `{rev:'feat'}` (`detach` for A22d) | git 128 ↔ `CHECKOUT_REMOTE_BRANCH_AMBIGUOUS`, remotes in git's advice order |
| R6, R32, F2, F3b, P4, A22e | `{rev:…}` (F3b with `cwd` in `sub/`) | git 128 ↔ `CHECKOUT_PATH_OR_TRACKING_BRANCH` |
| R27, R27b | `{rev:'feat'}` | `CONFIG_MISSING_VALUE` key and line equal git's |
| R4, R5, R5b, R26, R29, R31, R10b, R10d, R10e, R16, R13b, R19, R19b | config / `guess` option | git exit 1 pathspec ↔ PNM, or std for R5b/R26/R29 |
| R24b, R24c, C1, O1, O2 | `{rev:'master'}`, `{paths:['f.txt']}` | key named equals git's |
| R7, R8, R21 | `{rev:'feat'}` / `'origin/feat'` | unchanged switch/detach (regression guards) |
| R9a, P6 | `createBranch: {name:'x'}` | start-point refusal unchanged |
| R9c | `{rev:'feat',detach:true}` | `INVALID_OPTION createBranch`; no branch, HEAD and work tree untouched |
| H1, H1d, H2 | unborn `{rev:'HEAD'}` / `+detach` / `{rev:'@'}` | git's invalid-name refusal ↔ `INVALID_REF` (H1, H1d); pathspec ↔ PNM (H2) |
| B1, B2, B3 | `{createBranch:{name:'HEAD'},detach:true}` and the same with `'master'`;, `{rev:'nothere',createBranch:{name:'master'}}` | refusal named in git's order |
| R17 | `{rev:'feat'}` | `TRACKING_AMBIGUOUS`; branch written, `A  f.txt`, HEAD on `master`, both tools |
| R20 | `{rev:'treeish'}` | `CHECKOUT_NON_COMMIT` naming `refs/remotes/origin/treeish` |
| R22 | `{rev:'feat'}` | dirty refusal, heads unchanged |
| A22a, A22c | `{rev:…,detach:true}` | `CHECKOUT_DETACH_PATH_ARGUMENT` naming the argument |
| P1, P2, P5, P7, U1 | `{rev:'g.txt'}` / `'*.txt'` | file bytes, `ls-files -s`, exit/refusal |
| P3 | `{rev:'g.txt',force:true}` | restored (DC-5 B) |

### Perf

DC-6 A: `bench:ab` on `test/bench/checkout.bench.ts` after the commit (memory: run it after,
not before). No new gate unless DC-6 B is chosen.

### Mutation

Scoped Stryker run on `checkout.ts`, `remote-branch-guess.ts`, `misspelt-revision.ts` (export
only), `repo-state.ts` (S1 merge). Use the eponymous-suite narrowed buckets, at concurrency 1.
Every guard in §1/§3 has an isolated row above.

## Out of scope

- `switch <name>`: tsgit has no `switch` command.
- `checkout --track <remote>/<name>` without a branch name (R9j, G-f): expressible through
  `createBranch`, so below the bar. Ledger.
- `--` disambiguation (R6a/R6d/R6b/R6e): tsgit's `rev` / `paths` split already disambiguates.
  `guess: false` answers R6.
- Remotes defined in `.git/remotes/` or `.git/branches/` files: not probed, rare configuration.
- A forced path restore that skips unmerged entries (U2), unless DC-5 A is chosen. A
  `{paths}` counterpart of `-f` was already absent.
- `diff.ignoreSubmodules` and the `submodule.*` keys that `git_checkout_config` also reads:
  backlog 32.1 row D16 owns them.
