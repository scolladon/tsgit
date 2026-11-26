<!-- cspell:ignore memoise unforced ignorecase dtype MUSTBEDIR NODIR CMDL basebuf baselen lstat unpack untracked excludesfile memo memoised relativize relativizes gitlink gitlinks wildmatch -->
# Design — is-ignored-leading-directory

> Brief: backlog 32.92. tsgit's ignore judgement matches only the full path. git first tests each
> leading directory, root-first and as a directory, and stops at the first excluded one: that
> directory's rule decides, and nothing beneath it (a negation, a nested `.gitignore`) is read.
> The fix puts git's leading-directory walk into the one ignore judgement shared by
> `isIgnored` and the per-path probe behind every overwrite pre-flight. Folded in the same seam:
> - the backlog's claim that "only the public per-path primitive answers wrongly" is false.
>   `checkout`, `merge`, `cherry-pick`, `revert`, `rebase` (start and abort) and `stash apply`
>   refuse an untracked occupant that git overwrites, because they ask the same
>   full-path-only predicate (Matrices B, C, D, F);
> - a `.gitignore` that tsgit refuses to read (over 1 MiB, unreadable) under an excluded
>   directory makes `isIgnored` and `checkout` throw, but git never opens it (Matrix E).
>
> Status: draft → self-reviewed ×3 (2026-11-26)

## Context

### The backlog statement, re-pinned

Re-pinned on main f4b098b3 and on this branch's base 16e8b601 (2026-11-25), against git 2.56.1
(Homebrew, arm64, macOS APFS). Probes ran with `GIT_*` scrubbed, an isolated `HOME`,
`GIT_CONFIG_NOSYSTEM=1`, a user-only config file, signing off, and `core.ignorecase` set to
`false` and `true` in every repository (lesson 042). Each probe builds two copies of every repository.
git runs on one copy and tsgit on the other, through the worktree's TypeScript sources
(`openRepository`, `repo.primitives.isIgnored`, `checkout`), and the two outcomes are compared. Every
matrix was run twice with identical rows. No probe path starts with `:` (lesson 058).

- **Confirmed:** every `isIgnored` row the entry names (`ab`, `ab/`, `ab/` then `!ab/c`, a nested
  `.gitignore`, a directory absent from disk), plus 16 more rows that diverge (Matrix A).
- **Refuted:** "the walk-based commands are not affected … only the public per-path primitive
  answers wrongly". The walk callers (`status`, `add`, `stash push -u`) agree with git. But the
  per-path probe `createIgnoredProbe` wraps the same full-path-only predicate. Every overwrite
  pre-flight that uses the probe refuses an occupant that git overwrites (Matrices B, C, D, F). That is a
  data-integrity-class refusal mismatch on a well-formed repository, and it reaches
  `checkout`, `merge` (fast-forward and true merge), `cherry-pick`, `revert`, `rebase` (its
  start checkout and `abort`) and `stash apply`.
- **Widened (fault surface):** Matrix E. A `.gitignore` tsgit refuses to read, under an excluded
  directory, throws where git never opens it.

### git's rule (v2.56.1 source: `dir.c`, `unpack-trees.c`, `builtin/check-ignore.c`)

The rule below is taken from the source. The probes only confirm it (lesson 051). Line numbers
refer to tag v2.56.1.

- `last_matching_pattern` (`dir.c:1813-1829`) calls `prep_exclude(dir, istate, pathname,
  basename - pathname)`. If that leaves `dir->internal.pattern` set, it returns that pattern.
  Otherwise it returns `last_matching_pattern_from_lists` on the full path.
- `prep_exclude` (`dir.c:1654-1805`):
  - Pop (`1666-1682`): it pops the per-directory lists that are not a prefix of the new
    path, and clears `dir->internal.pattern` with them. A cached verdict therefore belongs to
    one leading-directory chain, never to a query.
  - Skip (`1684-1686`): when the retained chain already ends in an excluded directory, it
    returns at once. Nothing deeper is loaded.
  - Walk (`1704-1803`): it walks the remaining leading directories root-first. Each directory
    gets an empty list slot (`1727`). For every directory except the root (`if (stk->baselen)`,
    `1732`), it asks `last_matching_pattern_from_lists` about the directory path with
    `dt = DT_DIR` (`1733-1738`). The lists consulted are the ones loaded so far: those of the
    directories above it, plus `info/exclude` and `core.excludesFile`.
  - Negative match (`1741-1743`): a match by a negative pattern counts as no match, and the
    walk continues.
  - Positive match (`1744-1747`): the walk stops and the pattern stays cached, *before* that
    directory's `.gitignore` is read (`1749-1781`).
  - Root (`1709-1711`, `1732`): the root `.gitignore` is loaded in the first iteration.
    The root itself is never tested.
- `last_matching_pattern_from_lists` (`dir.c:1629-1648`) scans the groups in the order
  `EXC_CMDL`, `EXC_DIRS`, `EXC_FILE`. Inside a group it scans the lists last-added first, so
  the deepest directory comes first, and `info/exclude` comes before `core.excludesFile`
  (added in that order by `setup_standard_excludes`, `dir.c:3487-3505`). Inside a list the
  last pattern wins (`dir.c:1441`). The first hit returns.
- A `PATTERN_FLAG_MUSTBEDIR` pattern resolves the type of the path it is asked about through
  `resolve_dtype`: the index first, then `lstat` (`dir.c:1446-1450`). A leading directory
  arrives as `DT_DIR` by construction, whatever stands on disk (rows E and Q).
- `is_excluded` (`dir.c:1836-1844`) is `last_matching_pattern` where a negative pattern means
  "not excluded".
- Callers:
  - `builtin/check-ignore.c:112` calls `last_matching_pattern` directly. With `-v` it prints a
    negative pattern too and counts the path, so the exit code is 0 (`:114-121`).
  - `unpack-trees.c:2437-2443` (`check_ok_to_remove`) calls `is_excluded`. This is the
    untracked-occupant judgement of checkout, merge, read-tree and reset with untracked
    protection. It is armed by `setup_standard_excludes` when `!o->preserve_ignored`
    (`unpack-trees.c:1922-1926`).
  - `verify_clean_subdirectory` (`unpack-trees.c:2381-2385`) judges a directory that becomes
    a file. It runs `read_directory` with the same standard excludes, so the walk prunes at
    excluded directories.

tsgit's level order (global, info, root `.gitignore`, deeper directories appended, last match
wins) gives the same precedence as git's group scan: the deepest directory's list first, then
the root list, then `info/exclude`, then `core.excludesFile`. Only the leading-directory walk is
missing.

### Pinned matrices (git 2.56.1; tsgit 16e8b601; both `core.ignorecase` values)

#### Matrix A — `git check-ignore -v --no-index -- <q>` vs `isIgnored(ctx, [{ path: q }])`

Rows are identical under `core.ignorecase=false` and `=true` except row L. git's column shows
the `-v` line `<source>:<line>:<pattern>`, and "exit 1" means no match. The tsgit column is the
default query (`isDirectory` unset). `dir:` marks a query with `isDirectory: true` where it
differs.

| id | rule files | query | git 2.56.1 | tsgit today | agree |
|---|---|---|---|---|---|
| A1 | `.gitignore`: `ab` | `ab/c` | `.gitignore:1:ab` | not ignored | NO |
| A2 | | `ab` | `.gitignore:1:ab` | `gitignore '' 1 ab` | yes |
| B1 | `.gitignore`: `ab/` | `ab/c` | `.gitignore:1:ab/` | not ignored | NO |
| B2 | | `ab` (directory on disk) | `.gitignore:1:ab/` | not ignored · dir: `1:ab/` | yes when the caller says directory |
| B3 | | `ab/c/d` | `.gitignore:1:ab/` | not ignored | NO |
| C1 | `.gitignore`: `ab/`, `!ab/c` | `ab/c` | `.gitignore:1:ab/` | not ignored | NO |
| D1 | `.gitignore`: `ab/` ; `ab/.gitignore`: `!c` | `ab/c` | `.gitignore:1:ab/` | not ignored | NO |
| D2 | | `ab/.gitignore` | `.gitignore:1:ab/` | not ignored | NO |
| E1 | `.gitignore`: `ab/` ; nothing at `ab` | `ab/c` | `.gitignore:1:ab/` | not ignored | NO |
| E2 | | `ab` | exit 1 | not ignored · dir: `1:ab/` | yes for a file query |
| F1 | `.gitignore`: `x/y/` | `x/y/z/w` | `.gitignore:1:x/y/` | not ignored | NO |
| F2 | | `x/y/z` | `.gitignore:1:x/y/` | not ignored | NO |
| F3 | | `x/q` | exit 1 | not ignored | yes |
| G1 | `.gitignore`: `ab/`, `!ab/` | `ab/c` | exit 1 | not ignored | yes |
| H1 | `.gitignore`: `*`, `!ab/` | `ab/c` | `.gitignore:1:*` | `gitignore '' 1 *` | yes |
| I1 | `.gitignore`: `ab`, `*.log` | `ab/x.log` | `.gitignore:1:ab` | `gitignore '' 2 *.log` | NO (`source`) |
| J1 | `a/.gitignore`: `b/` | `a/b/c` | `a/.gitignore:1:b/` | not ignored | NO |
| K1 | `.git/info/exclude`: `ab/` | `ab/c` | `.git/info/exclude:1:ab/` | not ignored | NO |
| L1 | `.gitignore`: `AB/` | `ab/c` | false: exit 1 · true: `.gitignore:1:AB/` | not ignored (both) | NO under `true` |
| N1 | `.gitignore`: `a/b/` ; `a/.gitignore`: `!b/` | `a/b/c` | exit 1 | not ignored | yes |
| O1 | `.gitignore`: `a/` ; `a/.gitignore`: `!b/`, `!b/c` | `a/b/c` | `.gitignore:1:a/` | not ignored | NO |
| P1 | `.gitignore`: `ab/*`, `!ab/c` | `ab/c` | `.gitignore:2:!ab/c` (exit 0, verbose prints the negation) | not ignored | yes (ADR-163: a negation is "not ignored", no `source`) |
| P2 | | `ab/d` | `.gitignore:1:ab/*` | `gitignore '' 1 ab/*` | yes |
| Q1 | `.gitignore`: `ab/` ; a FILE at `ab` | `ab/c` | `.gitignore:1:ab/` | not ignored | NO |
| Q2 | | `ab` | exit 1 | not ignored | yes |
| R1 | `.gitignore`: `**/build/` | `p/build/o/f` | `.gitignore:1:**/build/` | not ignored | NO |
| R2 | | `p/build` (directory on disk) | `.gitignore:1:**/build/` | not ignored · dir: ignored | yes when the caller says directory |
| S1 | `core.excludesFile`: `ab/` (file kept under `.git/`) | `ab/c` | `<file>:1:ab/` | not ignored | NO |

22 of the 28 rows diverge. The `source` shape `{ kind, basedir, line, pattern }` already holds
everything git prints for a directory's rule (row J1 needs `basedir: 'a'`). No field is
missing, only values change.

#### Matrix B — `git checkout other` vs `checkout(ctx, { rev: 'other' })`

`main` commits `.gitignore` and `f`. `other` also tracks the path, added with `git add -f`.
Back on `main`, an untracked `ab/c` holding `mine` is laid down. The rows are identical under
both `core.ignorecase` values.

| id | `.gitignore` | shape | git 2.56.1 | tsgit today | agree |
|---|---|---|---|---|---|
| T0 | (empty) | `other` tracks `ab/c` | exit 1, "untracked working tree files would be overwritten", stays on main | `CHECKOUT_OVERWRITE_DIRTY` | yes |
| T1 | `ab/` | `other` tracks `ab/c` | exit 0, on `other`, `ab/c` = theirs | `CHECKOUT_OVERWRITE_DIRTY` | NO |
| T2 | `ab` | `other` tracks `ab/c` | exit 0, `ab/c` = theirs | `CHECKOUT_OVERWRITE_DIRTY` | NO |
| T3 | `ab/c` | `other` tracks `ab/c` | exit 0, overwritten | ok, overwritten | yes |
| T4 | `ab/`, `!ab/c` | `other` tracks `ab/c` | exit 0, overwritten | `CHECKOUT_OVERWRITE_DIRTY` | NO |
| T5 | `ab/` | `other` tracks a FILE `ab`; main holds an untracked directory `ab/` | exit 0, `ab` is the file | `CHECKOUT_OVERWRITE_DIRTY` | NO |
| T6 | (empty) | as T5 | exit 1, "Updating the following directories would lose untracked files" | `CHECKOUT_OVERWRITE_DIRTY` | yes |
| T7 | `ab/c` | as T5 | exit 0, `ab` is the file | ok | yes |

#### Matrix C — the other pre-flights over the same occupant

These rows use the same rules and occupant as Matrix B. `U*` rows: the incoming side tracks
`ab/c`, and the untracked `ab/c` holds `mine`. `V*` rows: the incoming side tracks a FILE `ab`,
and the untracked directory `ab/` holds `c` and `sub/d`. For `U*`, `0` = no rule, `1` = `ab/`,
`3` = `ab/c` (control), `4` = `ab/` then `!ab/c`. For `V*`, `1` = `ab/`, `6` = no rule,
`7` = `ab/c` and `ab/sub/d` (control). The rows are identical under both `core.ignorecase`
values.

Commands (git · tsgit):
- `merge-ff`: `git merge other` on a `main` behind `other` · `merge.run({ rev: 'other' })`.
- `merge`: `git merge --no-edit other` after one more commit on `main` · the same tsgit call.
- `cherry-pick`: `git cherry-pick other` · `cherryPick.run({ commits: ['other'] })`.
- `revert`: `git revert --no-edit HEAD`, where `HEAD` deleted `ab/c` · `revert.run({ commits: ['HEAD'] })`.
- `rebase`: `git rebase other` from a diverged `main` · `rebase.run({ upstream: 'other' })`.
- `stash`: `git stash apply` of a stash that adds `ab/c` · `stash.apply()`.

| command | 0 | 1 | 3 | 4 |
|---|---|---|---|---|
| `merge-ff` | git exit 1 · tsgit `WORKING_TREE_DIRTY` (agree) | git 0, theirs · tsgit `WORKING_TREE_DIRTY` (NO) | both overwrite (agree) | git 0 · tsgit throws (NO) |
| `merge` | git 2 · tsgit throws (agree) | git 0 · tsgit throws (NO) | both overwrite (agree) | git 0 · tsgit throws (NO) |
| `cherry-pick` | git 128 · tsgit throws (agree) | git 0 · tsgit throws (NO) | agree | git 0 · tsgit throws (NO) |
| `revert` | git 128 · tsgit throws (agree) | git 0 · tsgit throws (NO) | agree | git 0 · tsgit throws (NO) |
| `rebase` | git 1 · tsgit throws (agree) | git 0 · tsgit throws (NO) | agree | git 0 · tsgit throws (NO) |
| `stash` | git 128 · tsgit `STASH_APPLY_WOULD_OVERWRITE` (agree) | git 0 · tsgit throws (NO) | agree | git 0 · tsgit throws (NO) |

| command | V1 (`ab/`) | V6 (no rule) | V7 (control) |
|---|---|---|---|
| `merge` | git 0: `ab` is the file, `ab/sub/d` **deleted** · tsgit `WORKING_TREE_DIRTY`, all kept (NO) | git 2, all kept · tsgit throws (agree) | both: `ab` is the file, `sub/d` deleted (agree) |
| `cherry-pick` | git 0: `ab` is the file, `ab/sub/d` **deleted** · tsgit throws (NO) | git 128 · tsgit throws (agree) | not run |

On the V1 rows git deletes `ab/c` and `ab/sub/d` along with the directory, because they count as ignored. That is
data-destroying, and D-4 binds tsgit to it.

#### Matrix D — an ignored FILE standing where a leading directory is due

`other` tracks `x/ab/c`, and `main` holds an untracked FILE `x/ab` (`mine`). This shape reaches
`classifyLeadingObstruction`, `clearOccupants` (via `displaceFile`) and merge's
`displaceIgnoredLeadingFiles`. The rows are identical under both values.

| id | `.gitignore` | `git checkout other` | tsgit `checkout` | `git merge --no-edit other` | tsgit `merge.run` |
|---|---|---|---|---|---|
| Z0 | (empty) | exit 1, file kept | `CHECKOUT_OVERWRITE_DIRTY` (agree) | exit 2 | `WORKING_TREE_DIRTY` (agree) |
| Z1 | `x/` | exit 0, `x/ab/c` = theirs | `CHECKOUT_OVERWRITE_DIRTY` (NO) | exit 0, `x/ab/c` = theirs | `WORKING_TREE_DIRTY` (NO) |
| Z3 | `x/ab` | exit 0 | ok (agree) | exit 0 | ok (agree) |

#### Matrix E — a refused `.gitignore` under the excluded directory

`.gitignore` holds `ab/` (X1 to X3) or nothing (X4, X5). `ab/.gitignore` is the faulty file. The
untracked `ab/c` and the `other` branch are set up as in T1. The rows are identical under both
values.

| id | `ab/.gitignore` | `git check-ignore -v --no-index ab/c` | `isIgnored` | `git checkout other` | tsgit `checkout` |
|---|---|---|---|---|---|
| X1 | 1 MiB + 1 byte | `.gitignore:1:ab/` | throws `GITIGNORE_FILE_TOO_LARGE` | exit 0, overwritten | throws `GITIGNORE_FILE_TOO_LARGE` |
| X2 | mode 000 | `.gitignore:1:ab/` | throws `PERMISSION_DENIED` | exit 0 | throws `PERMISSION_DENIED` |
| X3 | a directory | `.gitignore:1:ab/` | not ignored | exit 0 | `CHECKOUT_OVERWRITE_DIRTY` |
| X4 | 1 MiB + 1 byte, `ab` not excluded | exit 1 | throws `GITIGNORE_FILE_TOO_LARGE` | exit 1, refuses | throws `GITIGNORE_FILE_TOO_LARGE` |
| X5 | mode 000, `ab` not excluded | exit 1, `warning: unable to access 'ab/.gitignore': Permission denied` | throws `PERMISSION_DENIED` | exit 1, the same warning, refuses | throws `PERMISSION_DENIED` |

X1 to X3 are in scope: once the walk stops at `ab`, `ab/.gitignore` is never opened and all
three rows agree. X4 is ADR-036's bounded read, a recorded divergence that this change leaves alone. X5 is
out of scope (§Out of scope, DC-5).

#### Matrix F — `rebase --abort` restoring `ab/c` over an untracked occupant

`main` deleted the tracked `ab/c`, and the stop is a conflict on `f`. An untracked `ab/c`
(`mine`) is laid down at the stop. The rows are identical under both values.

| id | `.gitignore` | `git rebase --abort` | tsgit `rebase.abort()` | agree |
|---|---|---|---|---|
| Y0 | (empty) | exit 128, "would be overwritten by reset", still rebasing | `WORKING_TREE_DIRTY`, still rebasing | yes |
| Y1 | `ab/` | exit 0, `ab/c` = theirs | `WORKING_TREE_DIRTY` | NO |
| Y3 | `ab/c` | exit 0 | ok | yes |
| Y4 | `ab/`, `!ab/c` | exit 0 | `WORKING_TREE_DIRTY` | NO |

#### Unaffected, pinned

`git sparse-checkout disable` re-materialising a tracked `ab/c` over an untracked `ab/c`, with
no rule, `ab/` or `ab/c`: both tools exit 0 and keep `mine` (a present file is kept, ADR-1236
family). The ignore probe does not decide this path.

### Consumers of the full-path judgement (code map, names not line numbers)

- `src/application/primitives/is-ignored.ts`: `isIgnored(ctx, queries)`, `IsIgnoredQuery`,
  `IsIgnoredMatch`, `IsIgnoredMatchSource`, the local `ancestorsOf`, and the closure
  `ensureAncestorRules`. That closure loads every ancestor's `.gitignore`, then makes one
  `matchInStackVerbose(stack, query.path, isDir)` call.
- `src/application/primitives/internal/ignore-evaluator.ts`:
  - `buildIgnoreEvaluator(ctx) → { base, loadDirRules }`. `base` is global → info → root, and
    `caseFold` comes from `core.ignoreCase`.
  - `buildRepoIgnorePredicate(ctx) → IgnorePredicate`. It has the same load-all-then-match
    shape and its own `ancestorsOf` twin.
  - Both are re-exported by `src/application/commands/internal/build-ignore-evaluator.ts`.
- `src/application/primitives/internal/occupant-clash.ts`:
  - `createIgnoredProbe(ctx)` wraps `buildRepoIgnorePredicate` in a `lazily` build and a
    one-at-a-time limiter.
  - It is used by `childSurvives` / `holdsSurvivor` (a directory at an added or deleted path),
    `classifyLeadingObstruction` (Matrix D) and `classifyAddedPath`.
- Probe call sites:
  - `src/application/primitives/find-would-overwrite.ts` (`clashScopeOf`): merge, cherry-pick,
    revert and stash apply, through `apply-merge-to-worktree.ts` and `merge.ts`.
  - `src/application/primitives/apply-changeset.ts`:
    - the clash scope (`NEVER_IGNORED` when `ignoredOccupants === 'protect'`, the
      `pull-into-void` case);
    - `clearOccupants` → `clearDirectoryAt` → `removeIgnoredBelow` (what is deleted when a
      directory becomes a file: V1, T5).
    - These are reached by checkout, rebase start and `reset-worktree.ts`
      (`untrackedOccupants: 'protect'`: rebase abort and skip, merge abort).
  - `src/application/commands/merge.ts`: `displaceIgnoredLeadingFiles` (Matrix D, merge
    column).
- Walk consumers of `buildRepoIgnorePredicate`:
  - `status.ts`, through `pruneGitlinkDirectories`.
  - `stash.ts` `listUntracked`, through `gitlinkPrunedIgnore`.
  - `add.ts`: the walk, through `collectIgnored` / `withPathspec`, and the literals, through
    `splitIgnoredLiterals`.

**Can a walk caller's verdict change?** No. Proof from the code:
- `walkEntries` / `stepEntry` (`src/application/primitives/walk-working-tree.ts`) starts at the
  root frame `''`. It asks every directory `config.ignore(path, true)` before
  `enterSubdirectory` and skips it when the answer is yes. A symlink is asked as a leaf.
- So every path it asks has had each leading directory asked, root-first, as a directory, and
  answered "no".
- That full-path directory question uses the same levels git's leading test uses:
  - `ancestorsOf(dir)` loads only the proper ancestors.
  - `relativize` drops a level whose `basedir` is the directory itself or lies beneath it, or
    is unrelated.
  - A negative leading verdict means "continue", in git and in the new code alike.
- The gitlink wrappers only add early `true` answers.
- `add`'s literal path walks `firstAncestorWhere` root-first with `repoIgnore(ancestor, true)`
  before the leaf.

The new walk is therefore redundant on every walk-caller path, and its verdicts equal today's.
The cost is §6.

### Constraining ADRs, doctrine, lessons

- ADR-163: the `isIgnored` result shape. `source` only when `ignored`, and a negation collapses
  to "not ignored" (row P1).
- ADR-249: structured data only. The interop test rebuilds git's `-v` line from `source`.
- ADR-226: prime directive.
- ADR-036: the 1 MiB `.gitignore` cap (row X4 stays).
- ADR-1170: the filing bar. This run closes 32.92 and may file at most one entry.
- DOCTRINE:
  - D-2: fold the shared half, with unit rows for it and an interop pin per consumer.
  - D-4: copy git's deletion (V1, T5).
  - D-5: fold X1 to X3 (the edited seam).
  - D-6: no `!`.
  - D-7: perf gate form.
- Lessons:
  - 033 (re-pin a backlog symbol): applied above, the walk claim is refuted.
  - 042 / 045: both `core.ignorecase` values set explicitly. The twin wrapper is the Given.
  - 051: the rule comes from the source.
  - 057: count oracle yes-rates.
  - 058: no colon-led paths.
  - 011: no call-count spies. Perf-only gates are equivalent.

## Requirements

- **R1.** For every row of Matrix A, under both `core.ignorecase` values, `isIgnored` returns
  git's verdict. When git prints a non-negative pattern, `source` rebuilds git's `-v` line
  `<file>:<line>:<pattern>`, with `<file>` derived from `{ kind, basedir }`.
- **R2.** A query whose leading directory is excluded reports that directory's rule. It
  never reports a rule from a deeper level, nor a later rule in the same file (rows C1, D1, I1, O1).
- **R3.** A leading directory is tested as a directory whatever stands on disk (E1, Q1). The
  query's own `isDirectory` stays caller-declared and defaults to `false` (B2, E2, R2 unchanged).
- **R4.** The `.gitignore` of an excluded directory, or of anything beneath it, is never read
  (D1, O1, X1 to X3). The rule never throws because of such a file.
- **R5.** Verdicts and `source` within one `isIgnored` batch (and one probe's lifetime) do not
  depend on the order of the queries.
- **R6.** Every probe consumer of Matrices B, C, D and F returns git's outcome, both values:
  - refusal turns into overwrite on T1, T2, T4, T5, U1, U4 (every command), V1, Z1 and Y1, Y4;
  - V1 and T5 delete the ignored contents of the replaced directory as git does;
  - every agreeing row stays agreeing.
- **R7.** Walk callers (`status`, `add`, `stash push -u`) return the same results as on main
  on every existing interop row. Their cost stays within the D-7 gate (§6).
- **R8.** No exported signature or type changes. Nothing that returns today throws after the fix.

## Design

### 1. The rule, as a pure domain function (DC-1)

The rule lives in `src/domain/ignore/matcher-stack.ts`, next to `matchInStackVerbose`, and is
exported through `src/domain/ignore/index.ts`:

```ts
/** Each proper leading directory of `path`, root-first: `a/b/c` → `['a', 'a/b']`. */
export const leadingDirectoriesOf = (path: FilePath): ReadonlyArray<FilePath> =>
  path.split('/').slice(0, -1).map((_, depth, segments) => segments.slice(0, depth + 1).join('/') as FilePath);

/** git's prep_exclude test for one directory: the positive match that excludes it, if any. */
export const directoryExclusion = (
  stack: ReadonlyArray<IgnoreLevel>,
  directory: FilePath,
): VerboseMatch | undefined => {
  const match = matchInStackVerbose(stack, directory, true);
  return match.verdict === 'ignored' ? match : undefined;
};

/** git's last_matching_pattern: the first excluded leading directory decides, else the full path. */
export const matchBeneathLeadingDirectories = (
  stack: ReadonlyArray<IgnoreLevel>,
  path: FilePath,
  isDir: boolean,
  exclusionOf: (directory: FilePath) => VerboseMatch | undefined,
): VerboseMatch => {
  for (const directory of leadingDirectoriesOf(path)) {
    const exclusion = exclusionOf(directory);
    if (exclusion !== undefined) return exclusion;
  }
  return matchInStackVerbose(stack, path, isDir);
};
```

- `leadingDirectoriesOf` replaces both `ancestorsOf` twins, and the array is built without a
  literal (lesson 011: a value-free form, so no `ArrayDeclaration` or `<= 1` mutants). The slice
  over `segments` drops the last segment, so the root and the path itself are never included
  (`dir.c:1732`).
- **Why testing against the whole stack is git's "lists loaded so far".** `relativize` returns
  `undefined` for a level whose `basedir` is the directory itself, a directory beneath it, or an
  unrelated directory. So only the proper ancestors' levels and the base levels can match, and
  those are exactly git's `EXC_DIRS` lists above the directory plus `EXC_FILE`. Precedence is
  unchanged: last match wins over global → info → root → deeper. A stack holding *extra* levels
  (unrelated directories, or directories beneath the one tested) therefore gives the same answer.
  Property P3 pins this.
- `exclusionOf` is injected so that the application can memoise per directory (§2). The domain
  never sees I/O. Properties pass `(d) => directoryExclusion(stack, d)`.

### 2. One lazy session shared by `isIgnored` and the predicate (DC-1, DC-3)

In `src/application/primitives/internal/ignore-evaluator.ts`:

```ts
export interface IgnoreSession {
  /** git's verdict for one path, with the rule that decided it. */
  readonly match: (path: FilePath, isDirectory: boolean) => Promise<VerboseMatch>;
}

export const createIgnoreSession = async (ctx: Context): Promise<IgnoreSession> => {
  const evaluator = await buildIgnoreEvaluator(ctx);
  const stack: IgnoreLevel[] = [...evaluator.base];
  const entered = new Map<FilePath, Promise<VerboseMatch | undefined>>();
  const resolved = new Map<FilePath, VerboseMatch | undefined>();
  const enter = async (directory: FilePath): Promise<VerboseMatch | undefined> => {
    const exclusion = directoryExclusion(stack, directory);
    if (exclusion === undefined) await pushDirRules(directory);   // an excluded one is never read
    resolved.set(directory, exclusion);
    return exclusion;
  };
  const pushDirRules = async (directory: FilePath): Promise<void> => {
    const rules = await evaluator.loadDirRules(directory);
    if (rules.length > 0) stack.push({ basedir: directory, rules, kind: 'gitignore' });
  };
  const exclusionOf = (directory: FilePath): Promise<VerboseMatch | undefined> => {
    const known = entered.get(directory);
    if (known !== undefined) return known;
    const entry = enter(directory);
    entered.set(directory, entry);
    return entry;
  };
  // Root-first, stopping at the first excluded directory: decides what is read.
  const settleLeadingDirectories = async (path: FilePath): Promise<void> => {
    for (const directory of leadingDirectoriesOf(path)) {
      if ((await exclusionOf(directory)) !== undefined) return;
    }
  };
  return {
    match: async (path, isDirectory) => {
      await settleLeadingDirectories(path);
      return matchBeneathLeadingDirectories(stack, path, isDirectory, (d) => resolved.get(d));
    },
  };
};

export const buildRepoIgnorePredicate = async (ctx: Context): Promise<IgnorePredicate> => {
  const session = await createIgnoreSession(ctx);
  return async (path, isDirectory) => (await session.match(path, isDirectory)).verdict === 'ignored';
};
```

(Planning places the helpers as named module-level functions over a small session record, so
each stays under 20 lines.)

- **Root-first, stop at the first excluded directory.** `settleLeadingDirectories` decides what
  is *read*. The domain function decides the *verdict*, from the session-wide `resolved`
  verdicts. The settle loop stops at the first exclusion, so no deeper `.gitignore` is loaded
  (R4, X1 to X3). The domain loop also stops there, so it only asks about directories already
  in `resolved`. No allocation per query.
- **Memo soundness.** A directory's verdict depends only on the levels of its proper ancestors
  and on the base. All of them are on the stack before its first `enter`, because the loop is
  root-first and every ancestor was entered first. Levels pushed later belong to the directory
  itself, to directories beneath it, or to unrelated directories, and `relativize` ignores them
  all. So one verdict per directory per session is git's verdict for every later query. This
  is git's own caching (`dir.c:1666-1686`), held per directory instead of per chain.
- **Batch-order independence (R5).** Every verdict is a function of (path, `isDir`, the levels
  of its non-excluded leading directories). Those levels are fixed by the repository, not by
  which query loaded them first. The shared stack only ever holds levels of directories whose
  ancestors are all non-excluded. The R5 order rows (Test strategy) and property P4 pin it.
- **Promise memo.** Storing the promise makes two overlapping calls for one new directory share
  one `enter`, so a level can never be pushed twice. `createIgnoredProbe`'s one-at-a-time
  limiter stays (no scope change). Its comment remains true.
- **`isIgnored`** becomes `createIgnoreSession` + `session.match(query.path, query.isDirectory
  === true)` per query. The existing `VerboseMatch` → `source` mapping is unchanged, and an
  exclusion is an ordinary `'ignored'` `VerboseMatch` carrying its level and rule index. Its
  local `ancestorsOf` and `ensureAncestorRules` are deleted.
- **`createIgnoredProbe`** is unchanged. It keeps wrapping `buildRepoIgnorePredicate`, which now
  carries the rule. That one line is the D-2 fold of every probe consumer.

### 3. What each consumer does after the fix

| consumer | path into the rule | outcome change |
|---|---|---|
| `isIgnored` | `session.match` | 22 Matrix A rows flip to git's. I1 changes `source` only. X1/X2 return instead of throwing. X3 becomes ignored. |
| `checkout` (`materializeTreeJudging` → `apply-changeset` clash scope) | probe | T1, T2, T4 overwrite the file. T5 replaces the directory with the file and deletes its ignored contents (`removeIgnoredBelow`: `ab/c` is now ignored, so it is `rmRecursive`'d). Z1 displaces `x/ab` (`classifyLeadingObstruction` → `CLEAR`, then `clearOccupants` → `displaceFile`). X1/X2 switch. |
| `merge` (ff and true), `cherry-pick`, `revert`, `stash apply` (`findWouldOverwrite` / `apply-merge-to-worktree`) | probe | U1, U4 overwrite. V1 replaces the directory and deletes `ab/c`, `ab/sub/d`. Z1 merge column: `displaceIgnoredLeadingFiles` removes `x/ab`. |
| `rebase` start | checkout path | U1, U4 overwrite |
| `rebase.abort` / `skip`, `merge.abort` (`reset-worktree.ts`, `untrackedOccupants: 'protect'`) | probe (ignored occupants are still overwritten) | Y1, Y4 overwrite. `merge.abort` and `rebase.skip` are reached by the same scope but not pinned. Planning pins one row each (Test strategy). |
| `pull` into an unborn branch (`ignoredOccupants: 'protect'` → `NEVER_IGNORED`) | none | none |
| `status`, `add`, `stash push -u` | walk predicate | none (proof in Context). Cost: §6. |

Two existing equivalence proofs still hold. merge's `displaceIgnoredLeadingFiles` guard holds
because the pre-flight and the displacement ask the same probe. `removeIgnoredBelow` holds
because the clash check and the clear use one probe per run.

### 4. Equivalent-mutant comments in the touched code

| site | today's proof | fate |
|---|---|---|
| `is-ignored.ts` `ancestorsOf` `segments.length <= 1` | zero-iteration loop | removed with the function. `leadingDirectoriesOf` has no guard |
| `is-ignored.ts` `out` seed `[]` | "a placeholder names a directory loadDirRules cannot find" | **the proof stops holding**: a placeholder would now be *tested* as a directory, and a `*` rule excludes it. Removed: the value-free `map` form has no literal |
| `is-ignored.ts` `i < segments.length` | "a level whose basedir is the path is always skipped" | **the proof stops holding**: `<=` would test the path itself as a leading *directory*. Rows B2/E2 (file query, `ab/` rule) kill it in its new home. No loop remains |
| `is-ignored.ts` `stackedDirs.has` skip | duplicate levels shadowed | replaced by the promise memo. Its skip mutant (always `enter`) makes every query re-append its own non-excluded chain root-first. A stale duplicate (say `a` pushed again after `a/b`) is then always followed by a fresh `a`, `a/b` in ancestor order before any match, so last-match-wins sees today's precedence. Verdict and `source` are unchanged (identical level values). Equivalent (lesson 011), marked inline with that proof. Planning hand-verifies it on a precedence row (`a/.gitignore` `*.log`, `a/b/.gitignore` `!keep.log`, queries `a/b/c`, `a/x`, `a/b/keep.log`) |
| `is-ignored.ts` and evaluator `rules.length > 0` | empty levels match nothing | moved into `enter`. Still equivalent, re-marked with the same proof. It stays because, without it, every walked directory adds a level and `matchInStack` becomes O(directories) per entry |
| `is-ignored.ts` `rule === undefined` `BooleanLiteral` | type-narrowing guard | unchanged |
| evaluator `new Set<string>([])` | phantom seed | removed with the Set |
| evaluator `ancestorsOf` twin (two comments) | as above | removed |

Two new branches change only what is *read*, never the verdict, because the domain loop still
returns the first exclusion: the settle loop's early `return` and `enter`'s
`exclusion === undefined` guard. Both are killable through I/O, not through a verdict:
- dropping the early `return` enters `ab/x` beneath an excluded `ab`;
- forcing the guard true reads `ab/.gitignore` itself.

Either way an oversized `.gitignore` there throws `GITIGNORE_FILE_TOO_LARGE`. The X1 rows (one
at `ab/.gitignore`, one at `ab/x/.gitignore`, query `ab/x/y`) kill both. No spy is needed.

### 5. Edge behaviour

- A root-level path has no leading directory: only its full-path match decides (A2, Q2).
- A query whose path *is* an excluded directory (`ab`, dir) is decided by its full-path match,
  as git does (`prep_exclude` is given `basename - pathname = 0`).
- Under `core.ignorecase=true` the leading test uses the same case-folded compiled rules (L1).
  The memo key is the path as asked. Two case variants of one directory each get their own
  verdict, and both are git's (no folding of the key is needed, since the verdict is computed,
  not assumed).
- Abort: `isIgnored` keeps its signal checks at entry and between queries. A session `match` is
  not abortable mid-walk (as today).

### 6. Performance (D-7)

- **Work added.**
  - Per distinct directory, one `matchInStackVerbose(stack, dir, true)` per session.
  - Per query, two `Map` lookups per leading directory (`entered`, then `resolved`), replacing
    today's `Set.has`. Nothing is allocated per query beyond `leadingDirectoriesOf`'s array,
    which replaces `ancestorsOf`'s.
  - git does the same work: `treat_path` → `is_excluded(dir)`, then `prep_exclude` on the way
    in. Main skipped the leading test. So D-7 applies to the walk callers.
- **Not added.** No extra `.gitignore` read. Strictly fewer reads on probe paths.
- **Bench pair.** New `test/bench/ignore-leading-directory.bench.ts`, on the
  `ignore-match.bench.ts` shape: 200 directories × 100 files at depth 2, the same
  `RULES_PLAIN` root rules, and a memory-adapter context.
  - Row: `buildRepoIgnorePredicate` asked about every directory, as a directory, then every
    file, in walk order.
  - Floor twin, same process: one `matchInStack` per entry over the pre-loaded stack (main's
    settled cost), plus one `matchInStack(stack, dir, true)` per distinct directory (the work
    no implementation can avoid).
  - The defect the gate guards is a memo that does not hold: each file re-testing its 2
    leading directories, about 3× the twin.
  - Measure both before setting the gate. Put the gate between the measured ratio and ~3×. Do
    not gate against main.
- **Other benches.** `status.bench.ts`, `status-dirty.bench.ts`, `add.bench.ts`,
  `checkout.bench.ts`, `stash.bench.ts`: judge with `npm run bench:ab` after the commit and
  `bench:check` on the baselines (house practice). A quiet machine is checked first.

### 7. Public API and breaking classification

No exported signature or type changes (R8). Verdicts and returned values change. Calls that
threw (`CHECKOUT_OVERWRITE_DIRTY`, `WORKING_TREE_DIRTY`, `STASH_APPLY_WOULD_OVERWRITE`,
`GITIGNORE_FILE_TOO_LARGE`, `PERMISSION_DENIED` on X1/X2) now return. No returning call starts
throwing: the rule reads only files today's code also reads, and fewer of them. D-6 settles it as a plain
`fix(ignore): …`, without `!`. D-3's case does not occur.

### 8. Size note

The caps sit within about 100 B of the measurement.
- Added: `leadingDirectoriesOf`, `directoryExclusion`, `matchBeneathLeadingDirectories`, and
  `createIgnoreSession` with its memo (~40 source lines).
- Deleted: both `ancestorsOf`, `ensureAncestorRules`, and the predicate's own loop (~35 lines).
- Expected net: about +0.1 to +0.3 kB gzipped on the rows that bundle the ignore evaluator.

The caps are raised once, after review, on a clean build (`rm -rf dist .wireit`), in a
`chore(size)` commit.

### 9. Docs to update (documentation phase)

- `docs/use/primitives/is-ignored.md` Behaviour:
  - add the leading-directory rule. A path beneath an excluded directory reports that
    directory's rule, a negation beneath it cannot re-include it, and the directory is tested
    as a directory whatever is on disk;
  - reword the "loaded lazily" line: only `.gitignore` files on the chain above the first
    excluded directory are read;
  - add "never throws on a `.gitignore` inside an excluded directory".
- `docs/use/primitives/internals.md` (ignore-evaluator paragraph): the session, its
  per-directory verdict, and that the probe and the walk share it.
- `docs/use/commands/checkout.md` ("Refusal classes", "File and directory swaps"):
  - "unless ignored" now covers a path beneath an excluded directory;
  - a directory becoming a file deletes every file a leading rule ignores.
- `docs/use/commands/rebase.md` (start checkout; abort/skip "Ignored occupants are
  overwritten"), `docs/use/commands/merge.md` (pre-flight and `merge.abort` paragraphs), and
  `stash.md`, `cherry-pick.md`, `revert.md`: wherever "ignored" qualifies an occupant, state the
  leading-directory rule once and link to `is-ignored.md`.
- `docs/BACKLOG.md`: tick 32.92, correct its "only the public per-path primitive" sentence, and
  update the Release order table.

### 10. What implementation measured, and what it changed (ADR-1278)

§1 and §2 above describe the session as first landed. The measurements below replaced its
shape; the rule, the requirements and every matrix are unchanged.

**Plan deviations already landed.** The three domain functions are exported from
`matcher-stack.ts` only, not from the `domain/ignore` barrel, because that barrel is a typedoc
entry point and R8 forbids a new public symbol. The memo lookup is written with `??`, and the
empty-ruleset guard carries no suppression comment (§4 planned both otherwise). The
`merge.abort` and `rebase.skip` pins use a path the stopped operation had removed cleanly:
git refuses to restore it over an untracked occupant with no rule (exit 128) and restores it
under `ab/`, under `ab/` then `!ab/c`, and under `ab/c`, both `core.ignorecase` values, run
twice.

**Bench pair on the session as first landed** (§6; Apple M3 Pro, Node 22.22.3, git 2.56.1,
load 5.7 to 6.0; means in ms; the third column is a session that tests the leading directories
of every file again, measured and not committed):

| run | session row | floor twin | re-testing session | fix ratio | defect ratio |
|---|---|---|---|---|---|
| 1 | 39.3 | 19.2 | 82.6 | 2.05 | 4.32 |
| 2 | 42.0 | 19.0 | 91.2 | 2.21 | 4.81 |
| 3 | 40.6 | 20.0 | 91.8 | 2.02 | 4.58 |

**Command benches, main against the branch** (`bench:ab`, best of three alternated rounds):

| bench | main | branch | delta |
|---|---|---|---|
| `status`, 20 000 files, settled | 96.5 ms | 100.5 ms | +4.2 % |
| `status`, 20 000 files, stat-invalid | 565.7 ms | 558.6 ms | −1.2 % |
| `status`, 200 files, settled | 1.30 ms | 1.26 ms | −3.2 % |
| `status-dirty` | 0.65 ms | 0.64 ms | −1.6 % |
| `add`, nine rows | | | −3.2 % to +3.8 % |
| `stash` push and pop | 41.3 ms | 34.9 ms | −15.6 % |

`checkout` flagged three forced rows in that run (+11.1 %, +10.7 %, +54.4 %). On a five-round
repeat the two 500-directory rows read −2.4 % and −0.9 %. The third, a forced checkout of
`HEAD` on the 200-file tree, has rounds at about 3 ms and rounds at about 7 ms on main and on
the branch alike. A forced checkout runs no pre-flight, so it never builds the predicate.

**The predicate alone**, three variants in one process over the bench's 20 220 entries, median
of 41 rounds, three runs, load 5, same count of ignored entries from all three:

| tree | main's predicate | session as first landed | one outcome per chain |
|---|---|---|---|
| entries two levels deep | 24.3 to 26.7 ms | 33.3 to 37.5 ms (1.37 to 1.41 × main) | 21.1 to 23.1 ms (0.87 × main) |
| entries five levels deep | 33.5 to 38.9 ms | 52.5 to 63.2 ms (1.57 to 1.63 × main) | 23.4 to 26.8 ms (0.69 × main) |

The first session paid a string build, two lookups and an `await` per leading directory of
every entry. git pays the leading directories once per directory: `prep_exclude` keeps its
stack for the directory it is in.

**The change.** In `src/domain/ignore/matcher-stack.ts`, replacing `leadingDirectoriesOf` and
`matchBeneathLeadingDirectories` (`directoryExclusion` stays):

```ts
/** The directory holding `path`, or `''` for a root-level path. */
export const parentDirectoryOf = (path: FilePath): FilePath | '' =>
  path.slice(0, Math.max(path.lastIndexOf('/'), 0)) as FilePath | '';

/** git's prep_exclude step: an excluded chain above decides, else the directory's own test. */
export const chainExclusion = (
  stack: ReadonlyArray<IgnoreLevel>,
  directory: FilePath,
  above: VerboseMatch | undefined,
): VerboseMatch | undefined => above ?? directoryExclusion(stack, directory);

/** git's last_matching_pattern: the exclusion of the leading chain decides, else the full path. */
export const matchBeneathChain = (
  stack: ReadonlyArray<IgnoreLevel>,
  path: FilePath,
  isDir: boolean,
  chain: VerboseMatch | undefined,
): VerboseMatch => chain ?? matchInStackVerbose(stack, path, isDir);
```

In `ignore-evaluator.ts` the session keeps one promise per directory, the outcome of its
chain, and no second map:

```ts
const resolveChain = async (state, directory) => {
  const above = await chainOf(state, parentDirectoryOf(directory));   // ancestors first
  const exclusion = chainExclusion(state.stack, directory, above);
  if (exclusion === undefined) await pushDirRules(state, directory);  // an excluded chain reads nothing
  return exclusion;
};
const chainOf = (state, directory) =>
  state.chains.get(directory) ?? rememberChain(state, directory);
// chains starts as new Map([['', Promise.resolve(undefined)]]): the root has no exclusion
// match: matchBeneathChain(stack, path, isDirectory, await chainOf(state, parentDirectoryOf(path)))
```

**Why every verdict is the same.** A directory's chain outcome is the first excluded
directory among it and its leading directories, root-first, by induction on depth: the
parent's outcome when there is one, else the directory's own test. The parent's promise
settles after the parent's rules are pushed, so the directory is tested against the levels of
every directory above it, as before. An excluded chain pushes nothing and reads nothing at or
beneath its first excluded directory (R4). A path's verdict is its parent's chain outcome,
else its full-path match: the same value `matchBeneathLeadingDirectories` returned.
Order independence (R5) holds for the same reason as in §2: an outcome depends on the
repository, not on which query asked first.

**Mutants.** The settle loop and its early return are gone. `exclusion === undefined` keeps
its two killers (the oversized `.gitignore` at the excluded directory, and any nested-rule
row). The root's seeded entry removes the only special case: without it the root's chain asks
for itself before it is stored, and every row fails on a stack overflow. Each `??` loses a
whole class of rows when it becomes `&&`. `Math.max` turned into `Math.min` makes every path
root-level. `rules.length > 0` stays as §4 has it.

**Gate.** The bench pair measured again on the landed chain session (same machine, load 5.5 to
5.8, means in ms):

| run | session row | floor twin | ratio |
|---|---|---|---|
| 1 | 21.4 | 17.0 | 1.26 |
| 2 | 21.4 | 16.6 | 1.29 |
| 3 | 21.6 | 16.4 | 1.32 |

The defect the gate guards is now the session this one replaces, which did the leading
directories of every entry again: 2.02 to 2.21 times the twin. The gate is 1.7, the midpoint
of 1.32 and 2.02: the session answering a walk costs at most 1.7 times the floor twin.

The landed session against main's predicate, in the one-process comparison above: 0.92 to 0.93
times main two levels deep, 0.73 to 0.74 times main five levels deep, two runs, same counts.

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| DC-1 | Where git's rule lives | A: pure domain `leadingDirectoriesOf` / `directoryExclusion` / `matchBeneathLeadingDirectories` (exclusion lookup injected) + one application `createIgnoreSession` (lazy load, per-directory memo) behind both `isIgnored` and `buildRepoIgnorePredicate` · B: the whole walk inside the application session, no domain function · C: fix `isIgnored` and the predicate separately | A | One rule for every consumer (D-2), and both `ancestorsOf` twins removed. The verdict is pure and property-testable without I/O (P1 to P4), and the loading stays in the application (hexagonal rule). B forces properties through a memory adapter, which property-testing.md classes as unfit. C keeps two copies of a rule that has already drifted once |
| DC-2 | Walk callers (`status`, `add`, `stash push -u`) | A: share the session predicate, with the D-7 bench pair · B: keep today's full-path predicate as a separate walk predicate, justified by root-first pruning · C: share, and seed the directory memo from the walk's own directory question (no second match per directory) | A | Verdicts are identical either way (Context proof). A costs one match per directory, as git pays. B leaves two predicates that agree only while every walk caller prunes root-first. Nothing enforces that, and a future caller asking un-pruned would silently diverge. C saves that match through a perf-only branch: lesson 011 equivalent survivors, plus a memo keyed on a caller's `isDirectory` claim |
| DC-3 | Stack shape | A: keep the shared append-only stack and gate pushes by the per-directory memo · B: build a per-query chain (base + the levels of the path's non-excluded leading directories) from a per-directory level memo | A | A is the minimal diff, and its order independence is proven (§2). B is order-independent by construction and makes `matchInStack` O(depth) instead of O(levels in the session), which is a perf change this fix does not need. Revisit only if the D-7 bench shows the shared stack's scan dominating |
| DC-4 | Interop file layout | A: `test/integration/is-ignored-leading-directory-interop.test.ts` (Matrices A and E, `check-ignore`) + `test/integration/ignored-leading-directory-occupant-interop.test.ts` (Matrices B, C, D, F, one `describe.each` per command) · B: Matrix A rows appended to `glob-double-star-interop.test.ts`, occupant rows to `checkout-occupant-displacement-interop.test.ts` · C: one file for everything | A | Each `@proves` surface names one judgement (per-path primitive vs overwrite pre-flight). The existing files' surfaces are glob dialect and occupant displacement, and these rows test neither. The posix-only X2 row goes under `test/integration/posix-only/` |
| DC-5 | Row X5: an unreadable `.gitignore` in a *non-excluded* directory. git warns `unable to access` and reads no rules from it. tsgit throws `PERMISSION_DENIED` (every ignore consumer) | A: ledger row in `docs/known-divergences.md` ("corrupt, forged or unreadable input", beside 32.71's attributes twin) · B: file a backlog entry (the run's one slot) · C: fold here: treat as no rules and surface a structured warning | A | Below the ADR-1170 bar: unreadable input, not a well-formed repository. It is not in the edited seam: the refusal is in `loadCappedUtf8`, which this change does not touch. C needs a warning surface that the ignore path does not have (a new public shape). The one backlog slot is better unused |

### Settled by doctrine, not candidates

| Point | Settled by |
|---|---|
| Fold the probe/pre-flight half (Matrices B, C, D, F) in this change | D-2 (the second half sits in the shared predicate) |
| Overwrite the occupant and delete the replaced directory's ignored contents (T5, V1) | D-4 |
| X1 to X3: never read, never throw | D-5 (edited seam) + R4 follows from git's rule |
| Commit type `fix(ignore): …`, no `!` | D-6 (values and verdicts only; throwing calls now return) |
| Bench pair + same-process floor twin, ratio measured first | D-7 |
| `source` shape unchanged; the negation in P1 stays "not ignored" | ADR-163 |
| The interop test rebuilds `-v` lines; no display string in the library | ADR-249 |
| X4 (1 MiB cap) untouched | ADR-036 |

## Test strategy

### Unit (red first, GWT titles, AAA, `sut`)

- `test/unit/domain/ignore/matcher-stack.test.ts`:
  - `leadingDirectoriesOf`: `a` → `[]`, `a/b` → `['a']`, `a/b/c` → `['a', 'a/b']`.
  - `directoryExclusion`: a positive rule, a negation as the last match (G1, N1 shapes), a
    `directoryOnly` rule (tested as a directory), and a level at the directory itself (ignored).
  - `matchBeneathLeadingDirectories`, one row per Matrix A shape that does not need I/O:
    C1, F1/F2, G1, H1, I1 (`source` = line 1), J1, L1 (case-folded rules), O1, R1, and K1/S1
    (base kinds).
  - **Isolated guards.** The loop returns the *first* exclusion: F1 with a second rule
    excluding `x/y` from a different line; the result names `x/y/`'s line, not a shallower
    negation. "No exclusion" falls through to the full-path match (F3, P1, P2).
- `test/unit/application/primitives/is-ignored.test.ts` (memory adapter):
  - Every Matrix A row, under a `describe.each` `Given core.ignorecase=%s` twin (lesson 045:
    inner describes are `When …`).
  - The R5 order rows: `[ab/c, ab]` and `[ab, ab/c]` give the same per-path answers, and so do
    `[a/x, a/b/c]` and its reverse with `a/.gitignore` rules.
  - X1 to X3 in memory: an oversized `ab/.gitignore` and a directory at `ab/.gitignore`, under
    `ab/`. No throw, and `.gitignore:1:ab/`.
  - The settle-loop killer: X1 shape, where `ab/` is excluded and `ab/x/.gitignore` is
    oversized, query `ab/x/y`.
- `test/unit/application/commands/internal/build-ignore-evaluator.test.ts`: the predicate's
  booleans for A1, B1, C1, D1 and X1. The probe-shaped call order is a file under an excluded
  directory asked before the directory.
- `test/unit/application/primitives/internal/occupant-clash.test.ts`:
  - `classifyAddedPath` over T1 (CLEAR);
  - `holdsSurvivor` over the V1 directory (no survivor);
  - `classifyLeadingObstruction` over Z1 (CLEAR).
  - Each has a T0/Z0 twin that still clashes.
- `apply-changeset` unit: `removeIgnoredBelow` under a leading rule deletes `c` and `sub/d`
  (V1). Unignored siblings are kept as before.

### Property sibling (`test/unit/domain/ignore/matcher-stack.properties.test.ts`, lens 2)

- **P1 (derived input, lesson 057).** Generate a directory `d`, a rule excluding it (a literal
  `d/`, `d`, or a glob built from it), any trailing rules (including `!d/<x>` negations), and
  deeper levels. For any path under `d`, the result is `'ignored'` with the exclusion's level
  and rule index. The yes-rate is 100% by construction, and the property counts and asserts it.
- **P2 (oracle).** When no leading directory is excluded, the result equals
  `matchInStackVerbose(stack, path, isDir)`, an independently tested sibling, not a copy of the
  SUT. Paths and rules come from `arbitraries.ts`, with patterns derived from path segments so
  the full-path match fires. Before relying on it, count the oracle's `'ignored'` answers once
  outside the suite, and record the rate in the test's header. If the rate is below about 20%,
  derive more patterns from the path.
- **P3 (laziness is invisible).** Adding levels whose `basedir` lies beneath the first excluded
  leading directory, or in an unrelated directory, never changes the result. This is the
  property the lazy loader relies on (R4).
- **P4 (order independence, through the pure function).** For a fixed level set, building the
  stack in any order that respects ancestor-before-descendant gives the same results for a
  query list and any permutation of it. `numRuns` 100 (composition tier). No committed seed.

### Interop (DC-4 A; both `core.ignorecase` values, set explicitly, git's answer is the expectation)

- `is-ignored-leading-directory-interop.test.ts`:
  - One `it` per Matrix A row, comparing `git check-ignore -v --no-index` with
    `<file>:<line>:<pattern>` rebuilt from `source` (`kind` `gitignore` + `basedir` →
    `<basedir>/.gitignore`, `info` → `.git/info/exclude`, `global` → the configured path) and
    with the exit code.
  - X1 and X3 rows.
  - X2 under `test/integration/posix-only/` (chmod 000; skipped as root).
  - Helpers: `runGit`, `tryRunGitWithExit` and `git` from `interop-helpers.ts`, and the repo
    builder pattern of `glob-bracket-class-interop.test.ts`.
- `ignored-leading-directory-occupant-interop.test.ts`: one `describe.each` per consumer, each
  comparing exit/throw, HEAD, the occupant's bytes and `ab/sub/d`'s presence with git's:
  - `checkout`: Matrix B rows T0 to T7, Z0/Z1/Z3, and X1 (the posix-only X2 row is a sibling);
  - `merge.run` (ff and true): U0, U1, U3, U4, V1, V6, V7, Z0, Z1, Z3;
  - `cherryPick.run`, `revert.run`, `rebase.run` (start), `stash.apply`: U0, U1, U3, U4, plus
    `cherry-pick` V1 and V6;
  - `rebase.abort`: Y0, Y1, Y3, Y4;
  - **to pin in planning** (the code says they are reached, not yet run against git):
    `merge.abort` (an unmerged path whose `ORIG_HEAD` entry is absent, with an untracked
    occupant under an `ab/` rule) and `rebase.skip` (Y shape, skip instead of abort).
- Existing interop that must stay green unchanged: `glob-bracket-class-interop`,
  `glob-double-star-interop`, `add-ignored-report-interop`, `add-tracked-under-ignore-interop`,
  `gitignore-end-to-end`, `checkout-occupant-displacement-interop`, and the
  status/stash/sparse suites (R7).

### Mutation hot spots

- `leadingDirectoriesOf` (`slice(0, -1)`, `depth + 1`): rows `a` / `a/b` / `a/b/c`.
- `directoryExclusion` (`=== 'ignored'`, and `true` as `isDir`): the G1 and N1 negation rows,
  and a `directoryOnly` rule against a directory with no `/` in the path.
- The domain loop's early return: F1 with two excluding rules.
- `enter`'s `exclusion === undefined` guard: the X1 row (an oversized `ab/.gitignore` must not be
  read). D1 does not kill it: the verdict is the same.
- The settle loop's early `return`: the deeper X1 row (`ab/x/.gitignore` oversized, query
  `ab/x/y`).
- The memo and `rules.length > 0`: equivalent, marked inline with the §4 proofs. No call-count
  spies (lesson 011).
- Every Stryker timeout is hand-verified against its full covering set (house practice).

## Out of scope

- **X4.** A `.gitignore` over 1 MiB in a non-excluded directory throws where git reads it. This
  is ADR-036's deliberate cap, unchanged. Proof: Matrix E row X4.
- **X5.** An unreadable `.gitignore` in a non-excluded directory throws where git warns and
  continues (DC-5). Proof: Matrix E row X5, both values, run twice.
- **`git check-ignore` without `--no-index`.** It reports a tracked path as not ignored.
  `isIgnored` has no index consult by ADR-163, and the interop keeps `--no-index` as the
  existing suites do. Not a defect of this change.
- **Linux and Windows.** Every matrix ran on macOS only. CI runs the interop files on all three.
  A platform-only red is triaged when it appears.
- **`add`'s own leading-directory walk (`firstIgnoredAncestorOf`).** It becomes redundant with
  the shared rule but stays: same verdicts, and removing it is a refactor this fix does not need.
