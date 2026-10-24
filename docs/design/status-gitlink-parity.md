# Design — `status` and the comparison consumers treat a gitlink as git does

> Brief: backlog 32.38, fix-only. `status` reports every tracked gitlink as `modified` with a
> worktree mode of `100755`; git 2.55 compares the submodule's checked-out HEAD
> (`ce_compare_gitlink`), and `status` then runs a dirty check inside the submodule. Pin both
> against git 2.55, fix the comparison primitive, and fold every divergence the probes of its
> consumers (status, commit/sequencer refresh, stash, checkout/merge/cherry-pick, rebase/pull,
> rm, the racy smudge) expose.
> Status: draft → self-reviewed ×3

## Context

### What exists

- `src/application/primitives/compare-working-tree-entry.ts` is the single answer to "is this
  index entry dirty in the working tree?". `compareAndRefresh(ctx, entry, scope)` (L256-270) runs
  `lstat` → `deriveWorkingMode(stat)` → `statOnlyVerdict` (L119-148) → `compareContent`
  (L203-238) → `shouldRefresh` (L245-250). For a gitlink, `statOnlyVerdict` returns `undefined`
  at L125, `compareContent` cannot read a directory, `readWorkingBytes` returns `undefined` and
  L222 answers `{ status: 'modified', worktreeMode }`. `deriveWorkingMode`
  (`src/domain/objects/file-mode.ts:110-116`) maps a directory's `0o40755` to `100755`. That
  is the whole defect: every gitlink over a directory reads `modified` / `100755`.
- `src/application/commands/internal/gitlink-head.ts` (from #326) reads a gitlink's checkout the
  way git does: `probeGitlinkCheckout(ctx, path): Promise<GitlinkCheckout>` (L77-103) classifies
  `<path>/.git` as `none | oversized | broken | repository{ head() }` with git's bounds
  (`MAX_GITFILE_SIZE = 1 << 20`, `HEAD_PREFIX_BYTES = 255`, `COMMONDIR_MAX_BYTES`), and
  `gitlinkHeadOf(ctx, path)` (L65-74) throws `NOT_A_REPOSITORY { path }` on `broken` and
  `GITFILE_TOO_LARGE { path }` on `oversized`. Callers: `src/application/commands/add.ts:99`,
  `src/application/commands/internal/embedded-repository.ts:6`. Its own imports are all
  primitives and domain (L1-17), but it sits under `commands/`, so the primitive cannot import it
  (dependency rule `commands → primitives`).
- Consumers of the comparison (grep of `compareAndRefresh|compareWorkingTree*|scanTrackedEntries|isWorkingTreeModified`):

  | Consumer | Call site | Uses |
  |---|---|---|
  | `status` | `src/application/commands/status.ts:257-264` `scanTrackedTree` → `src/application/primitives/internal/scan-tracked-entries.ts:34-48` `scanEntry`; index write `status.ts:247-255` `updateIndexIfAble` | delta + refresh |
  | commit, cherry-pick/revert (`replay-sequence.ts:401`), rebase `--continue` (`rebase.ts:725,1587`) | `src/application/commands/internal/write-index-cache-tree.ts:47-72` `scanQuietly` | refresh |
  | racy smudge | `src/application/primitives/internal/smudge-racily-clean.ts:22-23,120-137` | `isRacyTimestamp` already excludes `GITLINK` (git's `is_racy_timestamp` does too), so the smudge never compares a gitlink |
  | stash | `src/application/commands/stash.ts:242-253` `classifyEntry`; `:376-379` `hasLocalChanges` | enum |
  | rebase / pull pre-flight | `src/application/commands/internal/clean-work-tree.ts:35-55` `stagedDirty`, `:56-70` `unstagedDirty`, `:72` `assertCleanWorkTree`, `:109-113` `unstagedChangePaths` | enum |
  | 3-way merge / cherry-pick | `src/application/primitives/find-would-overwrite.ts:112-139` `findWouldOverwrite` (via `merge.ts:1713`, `apply-merge-to-worktree.ts:489`) | enum |
  | rm | `src/application/commands/rm.ts:201-242` `classifyEntries` / `enforceSafetyValve` | enum |

  Not a comparison consumer but on the same path in the probes: checkout's and merge's
  dirty check `src/application/primitives/apply-changeset.ts:287-305` `evaluateDirtyPath` →
  `isDirtyUnder` (L169-178) → `blobMatches` → `readWorkingBytes` (L103-122), which reads the
  gitlink directory and rethrows `PERMISSION_DENIED`; and rm's removal
  `src/application/commands/rm.ts:120-135` → `removeFile`
  (`src/application/commands/internal/working-tree.ts:87-99`), which refuses a directory.
- `status`'s structured output (`ChangedPath`, `status.ts:84-91`) has no submodule field.
  `parseGitmodules` (`src/application/primitives/parse-gitmodules.ts:62`) returns
  `GitmodulesRow { name, path?, url?, update?, branch? }`, with no `ignore`. No source file reads
  `diff.ignoreSubmodules` or `submodule.<name>.ignore` (`grep -rn -i ignoreSubmodules src` is empty).
- `createLeadingPathScanner(ctx).hasSymlinkedLeadingPath(path)`
  (`src/application/primitives/internal/symlinked-leading-path.ts:56`) already implements git's
  `has_symlink_leading_path` for apply-changeset.

### Binding decisions

- ADR-226: be git-faithful (data, on-disk state, refusals). ADR-249: structured data only; the
  interop test rebuilds git's porcelain from the fields.
- ADR-255: `type-changed` is a kind change (`file` ↔ `symlink` ↔ `gitlink`) in both columns.
  A gitlink replaced by a file or a symlink is `T` (pins ST17, ST18).
- ADR-1049: a gitlink's HEAD is read through `<path>/.git` (directory, symlink, gitfile), never
  through the `.gitmodules` name. The status pins agree: ST5, ST6 and ST4 (no `<path>/.git`,
  module directory present, even moved) are clean.
- ADR-1050: a `.git` that leads to no repository refuses `NOT_A_REPOSITORY { path }`, with `path`
  as git prints it. `status` refuses on the same shapes, but only in its dirty check, never in
  the HEAD comparison (SF rows).

### Pinning procedure used

git **2.55.0** (`<git-2.55.0-bin>`; `git --version` printed in every probe log). Each fixture was
built once in a `mktemp -d` throwaway, then copied with `cp -Rp` into a git twin and a tsgit
twin. Every git call ran under `env -i` with `PATH=<git-2.55.0-bin>:/usr/bin:/bin`, `HOME` set
to an empty temp dir, `GIT_CONFIG_NOSYSTEM=1`, `LC_ALL=C`, commit dates pinned to
`@1700000000 +0000`, and
`-c commit.gpgsign=false -c tag.gpgsign=false -c user.name=t -c user.email=t@t -c protocol.file.allow=always -c init.defaultBranch=main`.
The tsgit column was **run**: a scratch vitest file called the commands through
`createNodeContext` against the worktree at `95704e7d`, on the tsgit twin. The file was deleted
before the commit. All ST, SF and SC rows from the fixture scripts ran **three times** with
identical output, except ST/SF rows with a FIFO, which ran twice. All CO rows ran three times
with identical output. SC rows p1–p12 and q1–q4 ran once each (git only; tsgit column read,
see the note there).

Fixture **F1**: an upstream `up` with one commit (`u`). The superproject holds `k` and
`git submodule add <up> sub`, committed. The index has `160000 4f6700e… sub` (written below as
`A`) carrying the directory's stat data as `add` recorded it (`ls-files --debug sub` shows the
directory's mtime and `size: 128` on APFS — an earlier draft of this doc said all-zero, which
the implementation twin refuted). `sub/.git` holds `gitdir: ../.git/modules/sub`. "Moved" means a
commit `z` made inside `sub`, so its HEAD becomes `319a957…` (`C`).
Fixture **F2** = F1 plus branch `other`, where `sub` is at the upstream's second commit
`958e500…` (`B`), and branch `side`, which adds a file `o`, both cut from `main`.
Fixture **F3** = F2 plus a commit `m` on `main`, so merging `other` is not a fast-forward.

## Requirements

- **R1** `compareAndRefresh` on a stage-0 gitlink whose working path is a directory answers
  `unchanged` when the HEAD resolved through `<path>/.git` equals `entry.id`, and also when no
  HEAD can be resolved (nothing checked out, empty directory, broken or oversized `.git`). It
  answers `modified` when the HEAD resolves to another commit. `worktreeMode` is `160000`
  (ST1–ST10, SF rows under `--ignore-submodules=dirty`).
- **R2** A gitlink whose working path is a regular file or a symlink is `type-changed`. Its
  `worktreeMode` is the stat-derived mode (`100644` / `100755` / `120000`). An absent path is
  `absent` (ST17–ST19).
- **R3** A path below a symlinked leading directory is `absent`, for gitlinks and for files
  alike (ST20, ST21).
- **R4** A gitlink is never refreshed: its stat data stays as recorded, and an unchanged
  gitlink never makes `status`, commit or the sequencer write the index (SX1–SX3).
- **R5** `status` adds git's dirty check over every non-absent, non-skip-worktree,
  non-assume-valid gitlink whose ignore mode is `none` or `untracked`:
  - a symlink at the path refuses (SF9);
  - `<path>/.git` is read with git's dying gitfile reader: `GITFILE_TOO_LARGE` or
    `NOT_A_REPOSITORY` with git's path (SF1–SF7);
  - a checked-out submodule's own status yields "tracked changes" and "untracked files" flags
    (ST11–ST16). The submodule's index is refreshed and written as git's child does (SX4), and
    a failing child status refuses (SF10).

  `unstaged` is `modified` when the HEAD moved or either flag is set (`SC..`, `S.M.`, `S..U`).
- **R6** `status` resolves the ignore mode per gitlink as git does. The sources are
  `.git/config` `submodule.<name>.ignore`, then `.gitmodules` `submodule.<name>.ignore` (the
  working-tree file, or the index blob when that file is absent), then `diff.ignoreSubmodules`.
  `<name>` is the `.gitmodules` section whose `path` is the entry's path. `all` hides the
  gitlink. `dirty` keeps only the HEAD comparison. `untracked` drops the untracked flag. Any
  other value refuses (SC rows). `diff.ignoreSubmodules` is validated on every `status` run,
  gitlink or not, as git parses it at config load (r1–r3); the per-name key and `.gitmodules`
  are consulted only for a gitlink the index holds (r5).
- **R7** stash, the rebase/pull pre-flight, `findWouldOverwrite` and apply-changeset's dirty
  check ignore gitlinks, as git does. A moved, dirty or staged submodule never blocks
  `stash`/`checkout`/`merge`/`cherry-pick`/`rebase`, and never gets stashed. The submodule's
  HEAD and files are never touched (CO1–CO20).
- **R8** `rm` of a gitlink follows git. The valve refuses a moved, dirty, untracked-holding or
  type-changed submodule (`RM_LOCAL_MODIFICATIONS`), and an oversized gitfile refuses
  `GITFILE_TOO_LARGE`. A clean submodule is removed from the working tree, the
  `.gitmodules` section is removed and staged, and `.git/modules/<name>` is kept. `--cached`
  touches the index only (CO21–CO30). A working `.gitmodules` whose content differs from the
  index refuses before anything is removed or unstaged, under `--cached` and `-f` too; an absent
  working file or a same-bytes rewrite proceeds (CO31–CO37).
- **R9** No `add`, `ls-files`, `diff` or checkout-write behaviour changes beyond what R1–R8 name.
  Every existing interop suite stays green.

## Design

### Pin matrix (git 2.55.0)

Notation: `v2` is `git status --porcelain=v2` (the `1 …` line, with the two oids written
`A`/`C`), `v1` is `--porcelain`, and `dirty=` is the same status run with
`--ignore-submodules=dirty`, which shows the HEAD comparison alone. "tsgit (run)" is
`status(ctx)`'s `changes` entry for `sub`. Every tsgit row has `head`/`index` = `160000 A`.
Classes: **ok** = tsgit matches; **fold** = divergence fixed here; **fold-dirty** = tsgit
matches only by accident today, and the HEAD comparison alone would break it, so R5 is what
keeps it; **no twin** = git hangs.

#### ST — `status` over a tracked gitlink (fixture F1)

| # | Setup | git: exit · v2 · stderr | git `dirty=` | tsgit (run) | Class |
|---|---|---|---|---|---|
| ST1 | populated, unmoved (hypothesis a) | 0 · none | 0 · none | `unstaged: modified`, `worktree 100755`, `clean: false` | fold |
| ST2 | `submodule deinit -f sub` (empty dir, hypothesis b) | 0 · none | 0 · none | modified · 100755 | fold |
| ST3 | `sub` emptied and `.git/modules` removed | 0 · none | 0 · none | modified · 100755 | fold |
| ST4 | empty `sub`, `.git/modules/sub` moved | 0 · none | 0 · none | modified · 100755 | fold |
| ST5 | `sub/.git` removed, `sub/u` kept, module dir kept | 0 · none | 0 · none | modified · 100755 | fold |
| ST6 | ST5 with the module HEAD moved | 0 · none (no `.gitmodules`-name fallback) | 0 · none | modified · 100755 | fold |
| ST7 | moved (hypothesis c) | 0 · `1 .M SC.. 160000 160000 160000 A A sub`; v1 ` M sub` | ` M sub` | modified · 100755 | fold (mode) |
| ST8 | moved to a commit fetched from an unrelated repository | as ST7 | ` M sub` | modified · 100755 | fold (mode) |
| ST9 | `sub` detached at `A` | 0 · none | none | modified · 100755 | fold |
| ST10 | embedded `.git` directory (the module dir moved into `sub/.git`), moved | as ST7 | ` M sub` | modified · 100755 | fold (mode) |
| ST11 | `sub/u` edited, HEAD unmoved | 0 · `1 .M S.M. …`; v1 ` M sub` | none | modified · 100755 | fold-dirty |
| ST12 | untracked `sub/n` | 0 · `1 .M S..U …` | none | modified · 100755 | fold-dirty |
| ST13 | ST11 + ST12 | 0 · `1 .M S.MU …` | none | modified · 100755 (read: the ST11 arm) | fold-dirty |
| ST14 | moved + `sub/u` edited | 0 · `1 .M SCM. …` | ` M sub` | modified · 100755 (read) | fold (mode) |
| ST15 | `sub` on an orphan branch (unborn HEAD, index kept) | 0 · `1 .M S.M. …` | none | modified · 100755 | fold-dirty |
| ST16 | nested submodule `sub/in` moved, `sub` HEAD unmoved | 0 · `1 .M S.M. 160000 160000 160000 07e4fcd 07e4fcd sub` | none | modified · 100755 | fold-dirty |
| ST17 | `sub` replaced by a file `f` | 0 · `1 .T S... 160000 160000 100644 A A sub` | ` T sub` | modified · 100644 | fold (`type-changed`) |
| ST18 | `sub` replaced by an executable file | 0 · `1 .T S... 160000 160000 100755 …` | ` T sub` | not run (ST17 arm) | fold |
| ST19 | `sub` removed | 0 · `1 .D S... 160000 160000 000000 A A sub` | ` D sub` | `deleted`, no `worktree` | ok |
| ST20 | gitlink `d/sub`, then `d` moved out and replaced by a symlink to it | 0 · `1 .D S... … d/sub` + `? d` | same | `d/sub` modified · 100755, untracked `d` | fold |
| ST21 | regular `d/f`, then `d` replaced by a symlink to a copy | 0 · `1 .D N... 100644 100644 000000 … d/f` + `? d` | same | `changes: []`, untracked `d` | fold |
| ST22 | moved, `update-index --skip-worktree sub` | 0 · none | none | `changes: []` | ok |
| ST23 | ST22 with `sub/u` edited | 0 · none | none | `changes: []` | ok |
| ST24 | moved, `update-index --assume-unchanged sub` | 0 · none | none | modified · 100755 | fold |
| ST25 | assume-unchanged with `sub/u` edited | 0 · none | none | modified · 100755 | fold |
| ST26 | untracked `sub/n` ignored by the submodule's `info/exclude` | 0 · none | none | modified · 100755 | fold |

Worktree mode (hypothesis e): git's `mW` for a gitlink over a directory is `160000` (ST7,
ST11–ST16), and over a file or symlink it is the stat-derived mode (ST17, ST18, SF9). The pin
confirms the hypothesis.

#### SF — `<path>/.git` and HEAD shapes (fixture F1; lesson 008)

| # | Setup | git: exit · stderr | git `dirty=` | tsgit (run) | Class |
|---|---|---|---|---|---|
| SF1 | `sub/.git` a sparse file of exactly `1 << 20` bytes | 128 · `fatal: invalid gitfile format: sub/.git` | 0 · none | modified · 100755 | fold → `NOT_A_REPOSITORY { path: 'sub/.git' }` |
| SF2 | `sub/.git` sparse, `(1 << 20) + 1` bytes (hypothesis d) | 128 · `fatal: too large to be a .git file: 'sub/.git'` | 0 · none | modified · 100755 | fold → `GITFILE_TOO_LARGE { path: 'sub/.git' }` |
| SF3 | SF2 with the module HEAD moved | 128 · same | 0 · none (the HEAD comparison treats it as matching) | modified · 100755 | fold |
| SF4 | `sub/.git` an empty directory | 128 · `fatal: 'sub/.git' not recognized as a git repository` | 0 · none | modified · 100755 | fold → `NOT_A_REPOSITORY { path: 'sub/.git' }` |
| SF5 | gitfile `gitdir: ../.git/modules/nowhere` | 128 · `fatal: not a git repository: sub/../.git/modules/nowhere` | 0 · none | modified · 100755 | fold → `NOT_A_REPOSITORY` |
| SF6 | gitfile `garbage` | 128 · `fatal: invalid gitfile format: sub/.git` | 0 · none | modified · 100755 | fold |
| SF7 | module HEAD `garbage`; or module `objects/` missing | 128 · `fatal: not a git repository: sub/../.git/modules/sub` | 0 · none | modified · 100755 | fold |
| SF8 | `sub/.git` a FIFO | 0 · none (×2) | 0 · none | modified · 100755 | fold |
| SF9 | `sub` a symlink to a directory or to `k` | 128 · `error: expected submodule path 'sub' not to be a symbolic link` | 0 · ` T sub` (`mW 120000`) | modified · 120000 | fold |
| SF10 | the submodule's index truncated to `junk\n` | 128 · `fatal: <abs>/.git/modules/sub/index: index file smaller than expected` then `fatal: 'git status --porcelain=2' failed in submodule sub` | 0 · none | modified · 100755 | fold |
| SF11 | module HEAD `ref: refs/heads/<5000 digits>` | 0 · `1 .M S.M. …` | none | modified · 100755 | fold-dirty |
| SF12 | module HEAD a FIFO | killed after 10 s in both modes (git blocks opening HEAD) | killed | modified · 100755 | no twin |

Hypothesis (d) holds for the default `status`. The refusal comes from the dirty check, though,
not from `ce_compare_gitlink`: with `ignore=dirty` or `ignore=all` the same SF2 fixture is clean
at exit 0 (SC q2, q2b), and with `ignore=untracked` it still dies (q2c). The hypothesis did not
cover the exact-bound row SF1, where git dies with `invalid gitfile format`. SF12 gets no twin:
the tsgit row asserts that the call settles within a timeout and that the outcome is the one
`probeGitlinkCheckout` already gives `add` for that shape.

#### SX — index writes (fixture F1, index settled by two `status` runs > 1 s apart)

| # | Setup | git | tsgit | Class |
|---|---|---|---|---|
| SX1 | `sub/x` created then removed, `touch sub` (directory stat drifts) | `status`: `.git/index` bytes unchanged (×3); `update-index --refresh`: unchanged | today: the gitlink is never refreshed (`compare-working-tree-entry.test.ts:1361-1369`, green at base). After R1 the entry reads `unchanged`, and without R4's guard `shouldRefresh` would refresh it (zero stat ≠ directory stat) and write the index | guard (fold) |
| SX2 | moved, then `status` | index unchanged (×3) | today unchanged (no refresh of a `modified` entry) | ok |
| SX3 | `k` staged, `sub` moved, `commit -m` | commit ok, tree `sub` = `A`, `ls-files --debug sub` byte-identical before and after (the directory stat `add` recorded, `size: 128`, is kept; an earlier draft claimed zeros) | ok (run): tree `sub` = `A`, `ls-files --debug sub` identical before and after | ok, guard keeps it |
| SX4 | `sub/u` touched with the same bytes, > 1 s | super `status` clean; the submodule's index rewritten (`ce5a337a22 → e5e57ba785`); under `--ignore-submodules=dirty` it stays unchanged | today: the submodule's index is never touched | fold (R5) |

#### SC — ignore configuration (fixture F1; git only, run once each)

| # | Setup | git: exit · v2 |
|---|---|---|
| n1 | `.gitmodules` `ignore = dirty` (committed), `sub/u` edited | 0 · none |
| n2 | `.git/config` `submodule.sub.ignore = untracked`, untracked `sub/n` | 0 · none |
| n3 | `diff.ignoreSubmodules = all`, moved | 0 · none (`dirty=`: ` M sub`) |
| n4 | `.gitmodules` `ignore = all` (committed), moved | 0 · none (`dirty=`: ` M sub`) |
| p1 | `.gitmodules` `all`, `.git/config` `none`, moved | 0 · `SC..` line shown (config beats `.gitmodules`) |
| p2 | `diff.ignoreSubmodules = all`, `.git/config` `submodule.sub.ignore = none`, moved | 0 · `SC..` shown |
| p2b | `diff.ignoreSubmodules = all`, `.gitmodules` `none`, moved | 0 · `SC..` shown (`.gitmodules` beats `diff.*`) |
| p3 | `diff.ignoreSubmodules = dirty`, `sub/u` edited | 0 · none |
| p4 | `.gitmodules` `untracked`, untracked `sub/n` | 0 · `sub` absent (only `.gitmodules` `.M`) |
| p5 | `.git/config` `submodule.sub.ignore = bogus` (or `diff.ignoreSubmodules = bogus`), moved | 128 · `fatal: bad --ignore-submodules argument: bogus`; `diff-files` 128 too; `update-index --refresh` 0 |
| p6 | `.gitmodules` section renamed to `nm` (`path = sub`, `ignore = all`), moved | 0 · `sub` absent (the name comes from `path`) |
| p7 | index `.gitmodules` `all`, worktree `.gitmodules` `none`, moved | 0 · `SC..` shown (the working-tree file wins) |
| p8 | worktree `.gitmodules` deleted, index and HEAD `all`, moved | 0 · `sub` absent (falls back to the index blob) |
| p9 | `.gitmodules` `dirty`, untracked `sub/n` | 0 · `sub` absent |
| p12 | `status.submoduleSummary = true`, moved | 0 · `SC..` (no data change) |
| q2 / q2b / q2c | `ignore = all` / `dirty` / `untracked` over SF2 | 0 · none / 0 · none / 128 · `too large to be a .git file` |
| q3 | the submodule's own `status.showUntrackedFiles = no`, untracked `sub/n` | 0 · none |
| q4 | `ignore = dirty`, `sub` a symlink | 0 · `1 .T S... 160000 160000 120000 …` |
| r1 | no submodule at all, `.git/config` `diff.ignoreSubmodules = bogus`, a staged file (×3) | 128 · `fatal: bad --ignore-submodules argument: bogus` (`diff-files` and `add` exit 0: only `status` parses the key) |
| r2 | submodule present, `.git/config` `submodule.sub.ignore = none` + `diff.ignoreSubmodules = bogus` | 128 · same (the own key does not shield a bogus `diff` value) |
| r3 | submodule present, `.gitmodules` `ignore = none` + `diff.ignoreSubmodules = bogus` | 128 · same |
| r4 | submodule present, unmoved, `submodule.sub.ignore = bogus`, `diff` key unset | 128 · same (the resolver runs for every stage-0 gitlink, moved or not) |
| r5 | no submodule, dangling `.git/config` `submodule.sub.ignore = bogus` | 0 · staged rows shown (a per-name key is read only for a gitlink the index holds) |
| r6 | `.gitmodules` `ignore = bogus`, moved | 0 · `warning: Invalid parameter 'bogus' for config option 'submodule.sub.ignore'`, `SC..` row shown (reads as unset) |
| r7 | `.git/config` `[submodule "sub"] ignore` with no value (valueless), moved | 128 · `error: missing value for 'submodule.sub.ignore'` then `fatal: bad config variable 'submodule.sub.ignore' in file '.git/config' at line <N>`; valueless `[diff] ignoreSubmodules` the same (git spells the key lower-case in its message) |
| r8 | `ignore = all`, gitlink staged via `update-index --cacheinfo` (`git add sub` refuses: "Skipping submodule due to ignore=all") | 0 · `1 M. S... 160000 160000 160000 <A> <C> sub` (the staged column stays; only the worktree column is hidden) |
| r9 | `ignore = all`, `sub` replaced by a file; `sub` removed | 0 · no line for either |

r1–r5 were pinned by the orchestrator after Part 8 (same procedure; r1 ran three times); r6–r9 by the
Part 8 implementer. tsgit after Part 8: r1 answered clean (fold in Part 9: the `diff` key is
validated on every run); r2–r9 match.

tsgit today, n1–n4 and o1–o3 (run): `modified · 100755` in every row. p- and q-rows (read,
not run): tsgit reads no ignore key, so every directory-backed row is the ST1 arm.

#### CO — consumers (fixtures F2/F3; each row ran three times)

| # | Setup | Command | git: exit · result | tsgit today (run) | Class |
|---|---|---|---|---|---|
| CO1 | F2 unmoved | `checkout other` | 0 · index `sub` = `B`, sub HEAD `A` untouched, ` M sub` | `PERMISSION_DENIED { path: <abs>/sub }` from `apply-changeset.ts:112` (`readWorkingBytes` on the directory) | fold |
| CO2 | moved | `checkout other` | 0 · index `B`, sub HEAD `C` | same throw | fold |
| CO3 | `sub/u` edited | `checkout other` | 0 · index `B`, edit kept | same throw | fold |
| CO4 | moved | `checkout side` (does not touch `sub`) | 0 · ` M sub` | ok | ok |
| CO5 | F2 unmoved | `checkout --detach HEAD~1` (no `sub` there) | 0 · `warning: unable to rmdir 'sub': Directory not empty`; `sub/` left, untracked | `PERMISSION_DENIED` (apply-changeset) | fold |
| CO6 | deinit (empty `sub`) | same | 0 · `sub` removed | `PERMISSION_DENIED` | fold |
| CO7 | on a branch without `sub`, no `sub` directory | `checkout main` | 0 · empty `sub` created | ok · empty `sub` | ok |
| CO8 | moved / `sub/u` edited | `merge --no-edit other` (fast-forward) | 0 · index `B`, sub untouched | `PERMISSION_DENIED` | fold |
| CO9 | moved | `merge side` (fast-forward, not touching `sub`) | 0 | ok | ok |
| CO10 | F3 unmoved / moved / edited | `merge --no-edit other` (ort) | 0 · merge commit, index `B`, sub untouched | `PERMISSION_DENIED` (apply-changeset) | fold |
| CO11 | F3 unmoved / moved | `cherry-pick other` | 0 · index `B`, sub untouched | `WORKING_TREE_DIRTY { localChanges: ['sub'] }` from `replay-sequence.ts:186` (`findWouldOverwrite`) | fold |
| CO12 | moved | `cherry-pick side` | 0 | ok | ok |
| CO13 | moved / edited | `rebase side` | 0 · ` M sub` / clean | `WORKING_TREE_DIRTY { localChanges: ['sub'] }` from `clean-work-tree.ts:83` | fold |
| CO14 | F2 (nothing to replay), moved, `git add sub` (staged gitlink) | `rebase side` | 0 · the staged `C` kept in the index (no pick runs) | `WORKING_TREE_DIRTY { localChanges: ['sub'] }` | fold |
| CO14b | F3 (a commit `m` to replay), moved, `git add sub`, `side` and `main` agree on `sub` | `rebase side` | 1 · `error: your local changes would be overwritten by rebase.` (git's `do_pick_commit` → `index_differs_from(HEAD)`, gitlinks counted, before every pick); rebase left in progress — on-disk state to pin git-first in Part 18 (`.git/rebase-merge/*`, HEAD detached at onto, `ORIG_HEAD`, index `sub` = `C`), `--abort` restores | after Part 11: rebases, the staged `C` dropped from the index by `detachHead`'s hard reset (before Part 11: refused by accident) | fold (Part 18) — regression introduced by this branch |
| CO14c | as CO14b but onto `other` holds `sub` = `B` ≠ HEAD's `A` | `rebase other` | to pin git-first (expected `error: Entry 'sub' would be overwritten by merge. Cannot merge.` + `fatal: Could not detach HEAD`, exit 128, nothing written — `checkout_onto`'s two-way merge, two-way merge reject arm) | as CO14b | fold (Part 18) |
| CO15 | conflicted rebase resolved, then moved | `rebase --continue` | 0 · ` M sub` | not run (the `unstagedChangePaths` arm of CO13) | fold |
| CO16 | F2 unmoved | `stash push` | 0 · `No local changes to save` | `PERMISSION_DENIED` from `stash.ts:203` (hashing the directory) | fold |
| CO17 | moved / edited / untracked `sub/n` | `stash push` | 0 · `No local changes to save`, sub untouched | `PERMISSION_DENIED` | fold |
| CO18 | moved, `git add sub` | `stash push` | 0 · `No local changes to save`, index keeps `C` | `PERMISSION_DENIED` | fold |
| CO19 | moved + `k` edited | `stash push` | 0 · stash made; `stash@{0}:sub` = `stash@{0}^2:sub` = `A`; sub HEAD `C` kept; ` M sub` after | `PERMISSION_DENIED` | fold |
| CO20 | `k` staged, moved | `commit` | 0 · tree `sub` = `A` | ok | ok |
| CO21 | F2 unmoved | `rm sub` | 0 · `sub` removed, `.gitmodules` emptied and staged (`M  .gitmodules`, `D  sub`), `.git/modules/sub` kept | `RM_LOCAL_MODIFICATIONS { paths: ['sub'] }` | fold |
| CO22 | deinit | `rm sub` | 0 · as CO21 | `RM_LOCAL_MODIFICATIONS` | fold |
| CO23 | `.git` directory in `sub` | `rm sub` | 0 · stderr `Migrating git directory of 'sub' from '<abs>/sub/.git' to '<abs>/.git/modules/sub'`; as CO21 | `RM_LOCAL_MODIFICATIONS` | fold (candidate 4) |
| CO24 | moved | `rm sub` | 1 · `error: the following file has local modifications:` / `    sub` / `(use --cached to keep the file, or -f to force removal)` | `RM_LOCAL_MODIFICATIONS { paths: ['sub'] }` | ok |
| CO25 | `sub/u` edited | `rm sub` | 1 · as CO24 | as CO24 | fold-dirty |
| CO26 | untracked `sub/n` | `rm sub` | 1 · as CO24 | as CO24 | fold-dirty |
| CO27 | `sub` replaced by a file | `rm sub` | 1 · as CO24 | as CO24 | ok |
| CO28 | SF2 | `rm sub` | 128 · `fatal: too large to be a .git file: 'sub/.git'` | `RM_LOCAL_MODIFICATIONS` | fold |
| CO29 | moved | `rm --cached sub` | 0 · `D  sub`, `?? sub/`, `.gitmodules` untouched | ok | ok |
| CO30 | moved | `rm -f sub` | 0 · `sub` removed, `M  .gitmodules`, `D  sub`, `.git/modules/sub` kept | `CHECKOUT_OVERWRITE_DIRTY { localChanges: ['sub'] }` from `working-tree.ts:97` | fold |
| CO31 | F1, working `.gitmodules` with an unstaged comment appended (×3) | `rm sub` | 128 · `fatal: please stage your changes to .gitmodules or stash them to proceed`; nothing removed, ` M .gitmodules` | `RM_LOCAL_MODIFICATIONS` (valve first) | fold → `GITMODULES_NOT_STAGED` (ADR-1071) |
| CO32 | as CO31 | `rm --cached sub` | 128 · same message; index untouched | `D  sub` (no check) | fold |
| CO33 | as CO31 | `rm -f sub` | 128 · same message | `CHECKOUT_OVERWRITE_DIRTY` | fold |
| CO34 | `.gitmodules` edited then `git add .gitmodules` | `rm sub` | 0 · `M  .gitmodules`, `D  sub`; `.gitmodules` ends empty, staged blob empty | `RM_LOCAL_MODIFICATIONS` | fold (CO21 arm) |
| CO35 | `.gitmodules` rewritten with identical bytes (stat drift only) | `rm sub` | 0 · as CO21 | `RM_LOCAL_MODIFICATIONS` | fold (CO21 arm) |
| CO36 | working `.gitmodules` deleted, not staged | `rm sub` | 0 · ` D .gitmodules` stays unstaged, `D  sub`; no section edit, nothing staged for `.gitmodules` | `RM_LOCAL_MODIFICATIONS` | fold |
| CO37 | second submodule `sub2` committed | `rm sub` | 0 · `.gitmodules` keeps only `[submodule "sub2"]` (`path`, `url`), `M  .gitmodules`, `D  sub` | `RM_LOCAL_MODIFICATIONS` | fold (CO21 arm) |

CO14's exit 0 holds only when nothing is to replay (F2: `side` is cut from `main` and `main` has no commit of its own): the pre-flight ignores the staged gitlink, `checkout_onto` keeps it (HEAD and onto agree on `sub`, two-way merge cases 14/15) and no pick runs. The Part 11 implementer's git twins (×3) exposed the difference; the design's expectation was over-general. Pinned 2026-10-24.

| CO38 | tracked `d/f`, `d` replaced by a symlink to a copy (×3) | `stash push` (and `push -u`) | 1 · `error: 'd/f' is beyond a symbolic link` / `fatal: Unable to process path d/f` / `Cannot save the current worktree state`; nothing created; status ` D d/f` + `? d` unchanged | after Part 12 (run by its implementer): a stash is saved (the Part 4 `absent` verdict flows into W) | fold (Part 20) → `PATHSPEC_BEYOND_SYMLINK { path: 'd/f' }`, the code `add` already uses |
| CO39 | F1, `sub` replaced by a regular file, not staged | `stash push` | 0 · `No local changes to save` (`diff-files --ignore-submodules` zeroes every change on a gitlink index entry, a type change included); status `1 .T S... 160000 160000 100644 A A sub` | no local changes (Part 12's `classifyEntry`) | ok |
| CO40 | CO39 then `git add sub` (index `100644 <blob> sub`) | `stash push` | 0 · saved; afterwards status clean, `sub` an empty directory, `stash@{0}^2:sub` = `stash@{0}:sub` = the file blob | stash saved, then `FILE_EXISTS` at `mkdir sub` restoring the gitlink over the file (pre-existing write-path gap, also reachable by `checkout`) | fold (Part 19) |

CO38–CO40 were pinned by the orchestrator after Part 12 (same procedure; CO38 ×3). The design's
earlier wording "a gitlink↔file type change still counts" holds for the staged side only
(`diff-index --cached --ignore-submodules` skips a change whose both sides are gitlinks); on the
worktree side git's `match_stat_with_submodule` zeroes any change on a gitlink index entry.

CO31–CO37 were pinned by the orchestrator after planning (git 2.55.0, `env -i`, same
procedure as the CO rows; CO31 ran three times, the others once), for the planner's D3 question.

#### LH — a HEAD whose target's loose path is too long (orchestrator, after Part 6)

Fixture: a plain repository with one commit on `main` and a staged `u`, then `.git/HEAD` rewritten
to `ref: refs/heads/<name>`. `v2b` is `git status --porcelain=v2 --branch`. git 2.55.0, `env -i`,
same procedure as the CO rows.

| # | Setup | git: exit · output | tsgit (run, Part 6 implementer) | Class |
|---|---|---|---|---|
| LH1 | `<name>` = 5000 digits (×3) | 0 · `# branch.oid (initial)`, `# branch.head (unknown)`, every index entry `1 A. N... 000000 100644 100644 <0×40> <id> <path>` | `status` rejects `UNSUPPORTED_OPERATION { operation: 'filesystem', reason: 'ENAMETOOLONG' }` from the loose-ref probe | fold |
| LH2 | `<name>` = 300 chars (over `NAME_MAX`) | as LH1 | as LH1 | fold |
| LH3 | `<name>` = `none` (plain unborn branch, contrast) | 0 · `# branch.oid (initial)`, `# branch.head none`, same `A.` rows | `branch: 'refs/heads/none'`, initial | ok |
| LH4 | LH1, `rev-parse HEAD` | 128 · `fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.` | to pin: refuses | fold (refusal kept, code recorded) |
| LH5 | LH1, `log -1` | 128 · `fatal: your current branch appears to be broken` | to pin: refuses | fold (refusal kept, code recorded) |
| LH6 | LH1, `symbolic-ref HEAD` | 128 · (25-byte stderr; the implementing part pins the text) | to pin | pin |
| LH7 | = SF11: module HEAD `ref: refs/heads/<5000 digits>`, superproject `status` | 0 · `1 .M S.M. 160000 160000 160000 <A> <A> sub` | child `status` rejects as LH1 | fold |
| LH8 | HEAD → `refs/heads/a..b` (a name git rejects) and HEAD → a symref cycle, `v2b` | to pin git-first (expected `(unknown)` + initial, the same NULL path in `refs_resolve_ref_unsafe`) | today: `INVALID_REF` / `REF_CYCLE_DETECTED` escape `status` | pin, fold if git agrees |

What the pins say: git's files backend `lstat`s the loose path; an errno other than `ENOENT`
leaves `packed-refs` unread and `refs_resolve_ref_unsafe` returns NULL. `status` then takes
`s->branch = NULL` (`branch.head (unknown)`) and `is_initial = 1`; `log` and `rev-parse` refuse.
An unborn branch (`ENOENT`) keeps its name. The user ratified folding this (ADR-1072).

### What the pins say git does

From the `dirty=` columns, git's `status` has two layers:

```
lstat(path)
  ├─ leading symlink / missing ........................ D           (ST19–ST21)
  ├─ not a directory .................................. T, mW=stat   (ST17, ST18, q4)
  └─ directory → HEAD via <path>/.git, gently
        unresolvable or == entry.id ................... match       (ST1–ST6, ST9, SF1–SF8 dirty=)
        != entry.id ................................... M  (S C . .)
dirty check  [status only; ignore ∉ {dirty, all}; not skip-worktree / assume-valid]
  ├─ path is a symlink ................................ refuse      (SF9)
  ├─ <path>/.git read with the dying reader ........... refuse      (SF1–SF7)
  ├─ nothing checked out .............................. no flags    (ST2–ST6, SF8)
  └─ child status (refreshes the child index) ......... M flag / U flag, or refuse  (ST11–ST16, SX4, SF10)
```

Every other consumer stops at the first layer, and even there git skips gitlinks: stash
(CO16–CO19), the rebase pre-flight (CO13–CO15) and checkout/merge/cherry-pick (CO1–CO11)
never refuse on a gitlink. `rm` uses the first layer plus the dirty check (CO24–CO28).

### Part a — HEAD comparison in the primitive (R1, R2)

`compare-working-tree-entry.ts`, new internal arm, reached from `compareAndRefresh` before
`statOnlyVerdict`:

```ts
const gitlinkDelta = async (ctx: Context, entry: IndexEntry, stat: FileStat): Promise<WorkingTreeDelta> => {
  if (!stat.isDirectory) return { status: 'type-changed', worktreeMode: deriveWorkingMode(stat) };
  const head = await checkedOutHead(ctx, entry.path);   // undefined: none | broken | oversized | no HEAD
  const status = head === undefined || head === entry.id ? 'unchanged' : 'modified';
  return { status, worktreeMode: FILE_MODE.GITLINK };
};
```

- `checkedOutHead` = `probeGitlinkCheckout` with `broken`/`oversized`/`none` mapped to
  `undefined` and `repository` to `head()`. No refusal is raised here: git's
  `ce_compare_gitlink` never dies (SF `dirty=` column). The reader's `resolveGitlinkHead` already
  maps a `TsgitError` during resolution to `undefined`. Where `refStorageOf` raises a
  repository-format error (GL39–GL44 in `add`), the primitive maps that to `undefined` too,
  because the gentle path never dies (candidate 3 records where the mapping lives).
- Assume-valid with an armed `indexMtime`: `isEntryStatClean` already returns `true` for
  `assumeValid`. The gitlink arm checks `entry.flags.assumeValid && scope.indexMtime !== undefined`
  first and returns `unchanged` without probing (ST24, ST25; git's `CE_VALID` short-circuit).
- `statOnlyVerdict` loses its L125 guard (gitlinks no longer reach it). `compareContent` is
  never reached for a gitlink.
- `isLossy` and `absent` keep their place before the arm.

Placement (candidate 3, recommended): move
`src/application/commands/internal/gitlink-head.ts` → `src/application/primitives/internal/gitlink-head.ts`
unchanged, and rewrite the two importers (`add.ts:99`, `embedded-repository.ts:6`) plus its unit
suite path. Its imports move from `../../primitives/…` to `./…` / `../…`.
`requireWorkTree(ctx, 'add')` at L81 is unreachable from the primitive, because
`compareAndRefresh` calls `requireWorkTree(ctx, 'compareWorkingTreeEntry')` first. It stays
as is.

### Part b — gitlinks are never refreshed (R4)

`shouldRefresh(entry, stat)` gains `entry.mode !== FILE_MODE.GITLINK`. The L240-244 comment
changes to the reason: git's `refresh_cache_ent` returns a matching gitlink without
`ce_mark_uptodate` or `fill_stat_cache_info`. `verifiedBy` (`scan-tracked-entries.ts:103-106`)
would now report an unchanged gitlink as `CE_UPTODATE` to the racy smudge. That has no effect,
because `isRacyTimestamp` excludes gitlinks before the verdict is consulted
(`smudge-racily-clean.ts:22-23`). `updateIndexIfAble` (`status.ts:247-255`) stays as it is:
with no gitlink in `refreshed` and gitlinks never racy, SX1 holds.

### Part c — symlinked leading path (R3)

In `compareAndRefresh`, after `isLossy` and before the `lstat` verdict, an entry whose path
has a symlinked leading directory is `absent` (git's `check_removed` →
`has_symlink_leading_path`). This applies to every mode: ST20 and ST21 prove the defect for
files too, in the same function, so it is folded. The hot path cost is candidate 5.

### Part d — `status`'s dirty check (R5, R6), if candidate 1 = A

New `src/application/commands/internal/submodule-dirt.ts` (name for the ADR phase), called by
`status.ts` after `scanTrackedTree` for each stage-0 gitlink entry that is not skip-worktree,
not assume-valid, and whose delta is not `absent`:

```ts
type SubmoduleIgnore = 'none' | 'untracked' | 'dirty' | 'all';
interface SubmoduleState { readonly commitChanged: boolean; readonly trackedChanges: boolean; readonly untrackedChanges: boolean }

submoduleState(ctx, entry, delta, ignore): Promise<SubmoduleState | undefined>   // undefined ⇔ ignore === 'all'
```

1. `ignore === 'all'` → the entry leaves `workingMap` (n3, n4, q2). `'dirty'` → only the
   HEAD comparison (n1, p3, q2b, q4).
2. `lstat` shows a symlink → refuse (SF9; candidate 7).
3. `gitlinkHeadOf`-style dying classification: `oversized` → `GITFILE_TOO_LARGE { path: '<p>/.git' }`,
   `broken` → `NOT_A_REPOSITORY { path }` (SF1–SF7, the same paths `add` prints, GL51).
   `none` → no flags (ST2–ST6, ST17: a file at `sub` makes `<p>/.git` unreadable, so nothing
   is checked out).
4. `repository` → the child status: `deriveGitlinkContext(ctx, gitDir, path, { fs, commonDir, refStorage })`
   (`src/application/primitives/internal/submodule-context.ts:44`) runs the same scan as
   `statusInScope`, with refresh on (SX4), recursively (ST16). `trackedChanges` = any staged,
   unstaged or unmerged entry other than a nested gitlink whose only flag is untracked.
   `untrackedChanges` = any untracked path or a nested `S..U`, dropped when
   `ignore === 'untracked'` (n2, p4). The child's refusal propagates unchanged (SF10;
   candidate 8).
5. `unstaged` is `modified` when `commitChanged || trackedChanges || untrackedChanges`. A
   `type-changed` delta keeps `T`. A clean state removes the entry.

Ignore resolution (R6): the per-path name comes from `.gitmodules` (`parseGitmodules` rows whose
`path` equals the entry path; the working-tree file, else the index blob, p7/p8).
`GitmodulesRow` gains `ignore?: string` (`parse-gitmodules.ts:12-18`, `SubmoduleKeys`). The
precedence is `.git/config submodule.<name>.ignore` → `.gitmodules` → `diff.ignoreSubmodules`
→ `none`. A value outside the four refuses (p5; candidate 6). It is read only when the index
holds a stage-0 gitlink, so a repository without submodules pays nothing.

The structured surface is candidate 2.

### Part e — consumers ignore gitlinks (R7)

| File · symbol | Change | Pins |
|---|---|---|
| `src/application/commands/stash.ts` `classifyEntry` (L242-253) | a gitlink entry → `{ entry, state: 'unchanged' }` (its index id rides into W, CO19) | CO16, CO17, CO19 |
| `stash.ts` `hasLocalChanges` (L376-379) | `found.iTree !== base.bTree` compares the trees with gitlink-only differences ignored: an index differing from HEAD only at gitlinks is "no local changes" | CO18 |
| `src/application/commands/internal/clean-work-tree.ts` `unstagedDirty` (L56-70), `stagedDirty` (L35-55) | skip `entry.mode === GITLINK` (and a HEAD-side gitlink with no index entry: `stagedDirty`'s second loop) | CO13, CO14, CO15 |
| `src/application/primitives/find-would-overwrite.ts` `findWouldOverwrite` (L112-139) | a stage-0 gitlink entry never enters `localChanges` (git's `verify_uptodate_1`) | CO11 |
| `src/application/primitives/apply-changeset.ts` `evaluateDirtyPath` (L287-305) | an `update`/`delete` whose `previousMode` is `GITLINK` is not dirty | CO1–CO3, CO5, CO6, CO8, CO10 |
| `apply-changeset.ts` delete arm for a gitlink | `rmdir` when empty, leave a populated directory (git warns; tsgit returns no display string) | CO5, CO6 |

The CO5/CO6 delete arm was never reached in tsgit, because the dirty check threw first. Its
shipped behaviour is pinned by the twin row once the dirty check passes. A divergence found
there is folded in the same part.

### Part f — `rm` over a gitlink (R8), scope per candidate 4

- `classifyEntries` (`rm.ts:201-224`): for a gitlink, `local` = the Part a verdict is
  `modified`/`type-changed` **or** `submoduleState` (Part d, `ignore` forced to `none`, as git's
  `bad_to_remove_submodule` counts untracked files) has a flag set. The dying reader runs here
  (CO28).
- Removal (`rm.ts:120-135`): a gitlink entry does not go through `removeFile`. A gitfile-based
  or empty directory is removed recursively (CO21, CO22, CO30). A `.git`-directory submodule is
  migrated into `.git/modules/<name>` first (CO23). `.gitmodules` loses the section whose
  `path` matches and is staged (CO21: the file ends empty). `--cached` changes the index only
  (CO29).

### Part g — a loose path too long resolves as unreadable; `status` reports a broken HEAD as unknown (LH rows; ADR-1072)

- `src/adapters/node/node-file-system.ts` `mapErrno`: `ENAMETOOLONG` → a new `AdapterError`
  member `PATH_TOO_LONG { path }` (constructor `pathTooLong` in `src/domain/error.ts`, message
  case, exhaustiveness case, `docs/use/errors.md` "Adapters & I/O" row). The memory and browser
  adapters never produce it.
- `src/application/primitives/resolve-ref.ts` `UNREADABLE_REF_CODES` gains `PATH_TOO_LONG`: every
  "for reading" resolution treats the fault as git's NULL, and `resolveRef` still throws it (a
  refusal where git refuses: LH4, LH5).
- `src/application/commands/status.ts`: the HEAD state is read once for the report — a symbolic
  HEAD whose target resolves for reading or is missing keeps today's `branch`/`detached`/head
  tree; a target whose resolution throws an `UNREADABLE_REF_CODES` fault is broken:
  `branch: undefined`, `detached: false`, no head tree (every index entry a staged add), as git's
  `(unknown)` + initial. The pair `branch: undefined, detached: false` is the structured form of
  `(unknown)`; `docs/use/commands/status.md` says so.
- No change to `ResolveDirectResult`; the ref store keeps surfacing the fault.
- Out of scope, by pin: how `checkout`, `commit` and `branch` treat a broken HEAD (git dies at lock
  time with the same errno); not probed.

### Old unit rows — verdicts

| Row | Today pins | Verdict |
|---|---|---|
| `test/unit/application/primitives/compare-working-tree-entry.test.ts:282-297` "returns 'modified', not 'type-changed'" | an empty directory gitlink → `modified` | re-pin: `unchanged`, `worktreeMode: '160000'` (ST2); add siblings for a moved HEAD → `modified` (ST7) and a file → `type-changed` / `100644` (ST17) |
| same file `:371-401` size shortcut skips the gitlink → `modified` | the size arm is not taken for a gitlink | re-pin: `unchanged` with the spy asserting no `read` of the directory (the gitlink arm precedes `statOnlyVerdict`) |
| same file `:574-590` assume-valid gitlink → `modified` | stat cache bypassed | re-pin: `unchanged` and no `<path>/.git` probe (ST24, ST25) |
| same file `:1361-1369` "a gitlink is modified and never refreshed" | `modified`, `refreshed` undefined | re-pin: "a gitlink whose HEAD matches is unchanged and never refreshed" (SX1) |
| `test/unit/application/primitives/internal/smudge-racily-clean.test.ts` gitlink rows (5 hits) | gitlink never racy | unchanged: `isRacyTimestamp` is untouched |
| `test/unit/application/primitives/apply-changeset.test.ts` gitlink rows (16 hits: add arm, forced add, smudge, wave order) | the add arm creates a directory and leaves occupants | unchanged: Part e touches only the dirty check and the delete arm |
| `scan-tracked-entries`, `status`, `stash`, `clean-work-tree`, `find-would-overwrite`, `rm` unit suites | no gitlink row (0 hits for `GITLINK|160000|gitlink`) | new rows per Part |

### Comment lines to rewrite

`compare-working-tree-entry.ts` L6-7 ("gitlink/submodule entries are excluded — git reports them
as `M`"), L109-118 (`statOnlyVerdict` doc: the gitlink stance), L240-244 (`shouldRefresh`: "A
submodule never reaches here"), L14-16 (consumer list). Each must state git's HEAD comparison and
never-refresh rule. No ADR, backlog or phase reference goes into source or test.

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| 1 | How much of git's submodule awareness `status` gains | A. HEAD comparison + dirty check (child status, recursion, child index write, dying reader) + ignore configuration (Parts a–d). B. A without the ignore configuration (an ADR records the divergence on n1–n4, p-rows). C. HEAD comparison only; `status` behaves as git's `--ignore-submodules=dirty` (an ADR diverges; SF1–SF10 and ST11–ST16 go from accidental match to divergence; hypothesis d is not met) | A | ADR-226. C makes six rows that match today diverge (fold-dirty). B leaves a proven, config-driven divergence. A is the only option with no ADR divergence |
| 2 | Structured surface for git's `S<c><m><u>` | A. `ChangedPath.submodule?: { commitChanged, trackedChanges, untrackedChanges }`, present only on gitlink rows (additive, optional). B. No new field: the flags fold into `unstaged: 'modified'`, and porcelain v1 can be rebuilt but v2's sub field cannot. C. A, with the field also on `UnmergedEntry` | A | ADR-249: the v2 sub field is data git reports. B loses it. Gitlinks were never unmerged in the pins, so C is speculative. A adds a field in a `fix:` run; the commit type is the user's call |
| 3 | Where the gitlink reader lives so a primitive can use it | A. Move `gitlink-head.ts` to `src/application/primitives/internal/` unchanged, rewrite 2 importers. B. Inject a `gitlinkHead` reader through `ComparisonScope` from each command. C. Duplicate a minimal reader in the primitive | A | It already depends only on primitives and domain. B makes every consumer wire a reader, and a consumer that forgets keeps the defect. C forks lesson-008 bounds that #326 pinned |
| 4 | `rm` removal of a clean gitlink | A. Full: remove the directory, migrate a `.git` directory into `.git/modules/<name>` (CO23), remove and stage the `.gitmodules` section. B. A without the migration: a `.git`-directory submodule refuses (ADR divergence on CO23). C. Valve parity only: a clean gitlink still fails at `removeFile` (`CHECKOUT_OVERWRITE_DIRTY`, CO30) | A | C trades one wrong refusal for another. B is a proven divergence. A is git 2.55's pinned behaviour. Size cost: the migration writes `core.worktree` and a gitfile, so it is the largest piece; flag it for the plan |
| 5 | Cost of the symlinked-leading-path check on the `status` hot path | A. One `createLeadingPathScanner` per scan (it memoizes directory verdicts), passed through `ComparisonScope`. B. A fresh scanner per `compareAndRefresh` call. C. Check only when `lstat` succeeds and the parent chain contains a known symlink from the untracked walk | A | B repeats `lstat`s per sibling. C couples the tracked scan to the walk's order. A is the shape apply-changeset already uses; bench with `npm run bench:ab` after the commit |
| 6 | Error for an invalid ignore value (p5) | A. Reuse `CONFIG_INVALID_ENUM_VALUE { key, source, value, line }`. B. New `SUBMODULE_IGNORE_INVALID { value }`. C. Ignore the value (treat it as `none`) | A | git dies at exit 128 (C is a refusal mismatch). A carries more than git's message and adds no union member |
| 7 | Error for a symlink at a submodule path in the dirty check (SF9) | A. New `SUBMODULE_PATH_IS_SYMLINK { path }`. B. Reuse `NOT_A_REPOSITORY { path }`. C. No refusal (report `T`) | A | git refuses at exit 128 (C diverges). B names a different condition. A costs one union member (~30 B gzip) |
| 8 | A failing child status (SF10) | A. Propagate the child's `TsgitError` unchanged. B. Wrap it in a new `SUBMODULE_STATUS_FAILED { path, cause }`. C. Treat the submodule as dirty | A | git prints the child's own fatal first. The second line names the path, which the caller already knows. C hides a corrupt repository |

## Test strategy

- **Interop (twins, git 2.55, pinned dates, a fresh tsgit `Context` built after the git writes):**
  - new `test/integration/status-gitlink-interop.test.ts`: ST1–ST26, SF1–SF11, SX1, SX2, SX4 and
    the SC rows. It rebuilds `git status --porcelain=v2`'s `1 .M S<c><m><u> 160000 160000 <mW> A A sub`
    from `ChangedPath` (and `submodule` per candidate 2) and compares it with git's line.
    Refusal rows assert `.data` (code + path) with try/catch. The SX rows compare `.git/index`
    bytes before and after, and the submodule's index for SX4. Every row with a FIFO or an
    oversized file gets a timeout (lesson 008), and sparse files come from `makeSparseFile` /
    `OVERSIZED_GITFILE_BYTES` (`test/integration/interop-helpers.ts`). SF12 is tsgit-only, with a
    timeout.
  - consumers: CO1–CO30 as twins in the existing suites where they exist (rm, stash,
    checkout, merge, cherry-pick, rebase interop suites; grep `test/integration/*-interop.test.ts`)
    or in one new `test/integration/gitlink-consumers-interop.test.ts`. Each asserts exit/refusal
    data, the index entry for `sub`, the submodule HEAD and the files under `sub` after the run.
  - Reuse `runGit`, `runGitEnv`, `GIT_AVAILABLE`, `pinnedEnv()` and `commitIn` from
    `test/integration/status-embedded-repository-interop.test.ts` /
    `add-embedded-repository-interop.test.ts`. Submodules are made with
    `git -c protocol.file.allow=always submodule add`.
- **To pin while implementing** (not run at design time): a repository-format error inside a
  checked-out submodule (GL39–GL44 shapes) under `status` (expected: the child status
  refuses, as SF10); CO15 on tsgit; CO5/CO6 once the dirty check passes; a staged gitlink plus
  another change under `stash push` (what lands in the I tree); a `T` or `D` gitlink under `ignore = all`; Part c through `rm` and `stash` (a tracked file under a symlinked directory).
- **Unit:** the re-pinned rows above. Per Part, Given/When/Then rows for: gitlink over a
  directory (HEAD equal / moved / unresolvable / probe classes), over a file or symlink,
  assume-valid, the refresh guard, the leading symlink for a file and a gitlink, the ignore
  precedence table (one row per source pair), each consumer's gitlink skip, and rm's classes.
- **Properties:** the only new parsing is the four-value ignore enum and the `ignore` key in
  `parseGitmodules`. The existing `parse-gitmodules` property sibling (if present) gains the
  key. The enum fails the round-trip lens (closed set, no serializer), so it gets example rows
  only.
- **Mutation:** scoped Stryker per touched file (`.claude/workflow/mutation.md`). The gitlink
  arm's three-way verdict and the precedence chain need isolated rows per branch.

## Out of scope

- `status.showUntrackedFiles` is read by no tsgit command (`grep -rn -i showUntrackedFiles src` is
  empty). git honours it in the superproject (q3b: `-uno` hides a submodule's untracked
  files) and in the submodule (q3). This is a pre-existing gap of `status` as a whole, not of
  the gitlink comparison.
- A `--ignore-submodules` option on `status`: git's CLI flag has no tsgit counterpart today, and
  R6 covers the configuration. Adding the option is new surface, not a fix.
- `status.submoduleSummary` (p12): no data change, display only (ADR-249).
