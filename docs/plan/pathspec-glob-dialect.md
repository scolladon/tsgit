# Plan — pathspec glob dialect, unmatched-pathspec refusal, describe/name-rev patterns

> Source: design doc `docs/design/pathspec-glob-dialect.md` · ADRs 1033–1062 (binding; 1046–1053 drive the fold revision, Parts 13–22; 1054–1062 the embedded-repository revision, Parts 23–29); pre-existing 038, 077, 226, 249, 866, 980, 1000, 1012
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

## Facts the planner established (beyond the design)

Each was probed against git 2.55.0 in a `mktemp -d` throwaway (scrubbed `GIT_*`, empty `HOME`,
`GIT_CONFIG_NOSYSTEM=1`, `LC_ALL=C`, signing off) or read from the code at `8dd442ee`.

1. **tsgit refused every pathspec holding a backslash before any matching** (base `8dd442ee`).
   `resolvePathspec` runs `validatePath` (= `validateWorkingTreePath`, src/domain/working-tree-path.ts:71
   `if (input.includes('\\')) reject(input)`) on every body. Probe through the real module:
   `resolvePathspec(['a\\b'])`, `(['a\\*b'])`, `(['a\\'])` each throw
   `{"code":"PATHSPEC_OUTSIDE_REPO","path":…}`; `(['[ab].txt'])` is accepted.
   **Decided: ADR-1044, option B** (candidate 1) — on a host without Windows path syntax the
   pathspec intake accepts `\` for matching only; Part 10 lands it. D6, D17 and E2 get command-level
   interop rows on POSIX hosts; D8b and E1 stay pinned follow-ups (they need a `\`-named
   working-tree file, which `validateWalkedEntryPath` refuses).
2. **B11 as designed is unreachable**: its `.gitignore: nomatch[*]` needs `[…]` in the gitignore
   dialect, which tsgit does not have (src/domain/pathspec/compile-glob.ts header; R9 keeps it so).
   Re-pinned variant **B11′**: file `nomatch*`, `.gitignore: nomatch?`, `git add 'nomatch*'` →
   exit 0, index empty, 0 loose objects.
3. **The name-rev abbreviation oracle is `git rev-parse --abbrev-ref=loose <ref>`, not plain
   `--abbrev-ref`.** Probe (tag `x` at c1, branch `x` at c2): `name-rev --refs x HEAD` → `heads/x`,
   `name-rev --refs x HEAD~1` → `x`; `rev-parse --abbrev-ref refs/tags/x` → `tags/x` (strict, wrong
   for N28); `rev-parse --abbrev-ref=loose refs/tags/x` → `x`, `=loose refs/heads/x` → `heads/x`
   (both right). git's name-rev calls `refs_shorten_unambiguous_ref(path, 0)` — non-strict.
4. Extra pins: **RN4** untracked file named `nomatch*`, `add --renormalize 'nomatch*'` → exit 0,
   index unchanged; **RN5** untracked `untracked.txt`, `add --renormalize untracked.txt` → exit 0;
   **RN6** `add --renormalize 'untr*'` where `untr*` names only an untracked file → 128
   `fatal: pathspec 'untr*' did not match any files`; **K1L** held `index.lock`,
   `checkout -- missing` (unmatched literal) and `checkout -- a.txt` (tracked literal) → 128 lock
   refusal; **B12r** `add 'zz*' .` → 128 naming
   `'zz*'`.
5. git's `subpath_matches` returns the FIRST offset that matches (full ref first), so an include
   abbreviates only when its first match is at a suffix (N15: `*1.0` matches the full
   `refs/tags/v1.0` → `tags/v1.0^0`, not abbreviated).
6. git's per-path match levels order as `RECURSIVE < FNMATCH < EXACT` and `rm` keeps the maximum
   per pathspec item, so one wildcard match lifts an item out of the `-r` refusal (R4 vs R4b).
   An empty match (the whole tree, `.`) is `RECURSIVE` for every path.
7. `add`'s walk is already fully buffered before any staging (`walkedTrackedFirst`,
   src/application/commands/add.ts:647 collects every walked entry into a Map before yielding),
   so collecting the walk before the refusal costs no walk/hash overlap.

8. **Pre-existing (reproduced identically on `main` 8dd442ee): `add` never stages a tracked file
   that ignore rules hide from the walk.** Session pins, git 2.55.0 vs tsgit at HEAD:
   tracked `x.log`, `.gitignore` `*.log`, `x.log` modified, `add '*.log'` → git `M  x.log`, tsgit
   stages nothing (` M x.log`); same fixture `add 'x.log'` → both `M  x.log` (the literal fast
   path reads the index); tracked `d/x.txt` + `k`, `.gitignore` `d/`, `d/x.txt` modified:
   `add '.'` → git `A  .gitignore` + `M  d/x.txt`, tsgit only `.gitignore`; `add '*.txt'` → git
   `M  d/x.txt`, tsgit nothing; `add 'd'` → git prints the ignored-paths advice, exits 1 AND
   stages `M  d/x.txt`, tsgit nothing (the advice/exit is out of scope, B3l/B3m). Root cause:
   git's `add_files_to_cache` runs `run_diff_files` over the index entries the pathspec matches,
   whatever the ignore rules say; tsgit stages only the ignore-pruned walk. Part 9 fixes it; its
   Context holds the planner's exception pins (skip-worktree, intent-to-add, gitlink, `-A`,
   symlink, file→dir, clean).

Fold revision (2026-10-23, Parts 13–22). Probed against git 2.55.0 in `mktemp -d` throwaways with
the same scrubbed procedure, or read from the code at `039599ad`:

9. **I13, I14 and I16 on the full I fixture also stage `y.log`.** The design's index column for
   I12–I16 omits it (those rows ran on a fixture without `y.log`). Probe on `.gitignore` = `*.log`
   + `d/`, untracked `x.log y.log real.txt d/q.txt`: `add -f '*.log'` → exit 0, `x.log y.log`;
   `add -f .` → `.gitignore d/q.txt real.txt x.log y.log`. Interop twins compare against git, so
   only the unit rows must spell the full list.
10. **Sparse report order** (S fixture plus `y.log`, both skip-worktree and rewritten):
    P1 `add 'y*' 'x*' '*.log' x.log` → exit 1, advice lists `y*`, `x*`, `*.log`, `x.log` in
    argument order. P2 `add '*.log' '*.log'` → `*.log` listed twice (duplicates kept).
    P3 a repo whose only tracked file `x.log` is skip-worktree and rewritten: `add .` → exit 1,
    advice lists `.`. git checks skip-worktree before its "don't complain at `add .`" rule, so the
    whole-tree positive is reported and only the refusal skips it.
11. **Ignored report order and the interim re-pin.** P4 tracked `k`, `.gitignore` `build/`,
    untracked build/x, `k` rewritten: `add build/x 'k*'` → exit 1, advice lists `build`, status
    `M  k`. This re-pins add.test.ts "add of a literal beneath an ignored directory" (today a
    `PATHSPEC_NO_MATCH 'build/x'` refusal, the ADR-1045 interim that ADR-1046 supersedes).
    P5 I fixture, `add y.log x.log y.log d/q.txt d` → advice lists `d`, `x.log`, `y.log`: sorted
    and deduplicated.
12. **Broken gitlink variants** (GL fixture, `add .`): G1 `sub/.git` holding `garbage` → 128
    `fatal: invalid gitfile format: sub/.git`; G2 `sub/.git` an empty directory → 128
    `fatal: 'sub/.git' not recognized as a git repository`; G3 `sub/.git` a directory whose HEAD is
    `garbage` → 128, same line; G4 `gitdir: /nonexistent/abs` → 128
    `fatal: not a git repository: /nonexistent/abs`; G5 GL20's broken pointer with `add k` and
    `add 'k*'` → exit 0 (the check runs only for a gitlink the pathspec matches). Index unchanged
    in every refusal. Under ADR-1050 all four refusals are `NOT_A_REPOSITORY { path }`, `path`
    being the path git prints (`sub/.git` for G1–G3, the absolute pointer verbatim for G4); the
    message wording is display.
13. **A path that holds an index entry is never reported ignored.** GL7–GL10 (`.gitignore: sub`
    over a tracked gitlink) exit 0 with no advice. git's `dir_add_ignored` drops a path
    `index_name_is_other` says is tracked. Part 17's collector applies that rule to directories
    and leaves alike.
14. **Anchors moved since the design's `98c84b01`.** At `039599ad` (add.ts): `AddOptions` :139,
    `AddResult` :146, `add` :168, `addInScope` :200, `dispatchPathspec` :230, `addLiteralOnly`
    :243, `stageLiteralsOver` :275, `stageLiterals` :323, `literalStats` :567,
    `lstatOrBeneathFile` :587, `stageWalkedEntries` :638, `addByPathspec` :736,
    `addRenormalized` :792, `collectWalk` :820, `isNarrowerThanWholeTree` :829, `indexSees` :833,
    `verdictsOf` :837, `indexVerdicts` :843, `namesOnDisk` :850, `refuseUnseenRenormalized` :857,
    `refuseUnseenWalked` :873, `namesUnignoredDiskPath` :899, `ignoredWithAncestors` :915,
    `hiddenTracked` :995, `isHiddenCandidate` :1016, `stageIgnoredWalk` :1057, `withPathspec`
    :1107, `tallyWalkOutcomes` :1142, `sortedResult` :1195, `addAll` :1213, `WalkOutcome` :1264,
    `collectRemovedEntries` :1302, `readExistingEntries` :1369. checkout.ts: `restoreUnderIndexLock`
    :372, `selectFromUniverse` :394, `refuseUnmatched` :408, `enumerateSourcePaths` :482. Each part
    shifts them again: grep the symbol name before editing.
15. **The design's two fast-path bench rows already exist** in test/bench/add.bench.ts:
    "When add() re-stages one modified tracked file" and "When add() stages one new file" (both a
    single literal over a 10 000-file index). Part 18 adds no bench row; the session runs
    `bench:ab` on them after Part 18's commit.
16. **Only add.test.ts asserts the whole `AddResult`**: nine `toEqual({ … eolNotices: [] })`
    sites (grep `eolNotices: \[\]`) plus the `NOTHING_STAGED` constant in "add of an unseen pathspec
    whose spelled path exists on disk". Each new result field adds `[]` there. The fold's new
    suites assert fields one by one, so a later field never breaks them.

Review round (2026-10-23, after Parts 13–22). Pinned against git 2.55.0 by the implementers and
reviewers, each in the interop suite named, with the same procedure. The documentation revision
re-took the rows marked "throwaway" as git-and-tsgit twins, with tsgit run through jiti.

17. **A literal's sparse report is exact-path only** (test/integration/add-interop.test.ts, the
    replaced-directory table). Tracked `a/b a/c a/x/y real/b top` with `a/b` skip-worktree, then
    `a` replaced by a symlink to `real`. `add a` exits 0 with no advice and stages `120000 a`.
    `a/b`, `a/c` and `a/x/y` all leave the index. `-v` prints `remove` for `a/c` and `a/x/y`
    only, so tsgit's `removed` is `[a/c, a/x/y]`. Re-taken in a throwaway: same.
18. **`sub/` reaches a gitlink** (add-gitlink-interop.test.ts). git's `ce_path_match` passes
    `is_dir` for a gitlink, so a directory-only body matches `<path>/`. Shipped as
    `selectsGitlink` in add.ts.
19. **`<path>/.git` is read with a stat that follows symlinks** (add-gitlink-interop.test.ts).
    These stage the checkout's HEAD:
    - an absolute gitfile pointer outside the superproject;
    - a symlink to a repository directory, inside `.git` or outside (relative in the unit row);
    - two hops, or a symlink to a gitfile (throwaway: git stages).
    A dangling or self-looping `.git` symlink is "nothing checked out": exit 0, entry unchanged.
    The suite's upstream is one empty commit, so its `sub` holds no file. With files committed in
    `sub` (throwaway), git keeps `160000 sub` in every one of these cases. tsgit drops the gitlink
    and stages `sub/<file>`, because the walk's `isEmbeddedGitMarker` does not treat a `.git`
    symlink as a marker and descends. That rule predates the fold (same at `8dd442ee`).
20. **A gitlink under a symlinked parent** (add-gitlink-interop.test.ts, plus a throwaway for
    `-A`). Gitlink `d/sub`, then `d -> ../out` holding a moved clone. `add '*sub'` gives
    `D  d/sub` with `d` untracked; `add .` gives `A  d` and `D  d/sub`; `add -A` gives
    `120000 d` with `d/sub` dropped. This is git's `has_symlink_leading_path`.
21. **Common dir and `is_git_directory`** (add-gitlink-interop.test.ts).
    - A gitfile to a linked worktree's admin dir reads HEAD's branch from `commondir` and stages
      it, on a reftable repository too. An embedded `--ref-format=reftable` clone stages.
    - These refuse 128 `fatal: not a git repository: sub/../.git/modules/sub`, tsgit
      `NOT_A_REPOSITORY` with that path: a `commondir` naming `/nonexistent`, `/`, an empty
      directory, a refs-only or objects-only directory, or a regular file; a module missing
      `objects/` or `refs/`.
    - A zero-byte `commondir` also refuses 128, with git's wording
      `fatal: failed to read sub/../.git/modules/sub/commondir: No such file or directory`; tsgit
      reports the same `NOT_A_REPOSITORY` path. A bare-newline `commondir` is ignored: exit 0.
    - A `.git` symlink to a directory with no HEAD refuses 128
      `fatal: 'sub/.git' not recognized as a git repository`.
22. **Repository-format gate** (add-gitlink-interop.test.ts, gitlink-ref-storage.test.ts). Every
    pinned layout dies with exit 128: `.git/modules`, an embedded directory, a linked worktree.
    - `refStorage = bogus` or valueless, at any version: `CONFIG_INVALID_ENUM_VALUE` /
      `CONFIG_MISSING_VALUE`.
    - v0 plus any v1-only extension: "repo version is 0, but v1-only extension found".
    - v2: "Expected git repo version <= 1, found 2".
    - An unknown extension at v1, or a subsectioned `[extensions "x"] refStorage` at v1:
      "unknown repository extension found", `x.refstorage`.
    - A valueless or malformed `repositoryformatversion`: "bad numeric config value".
    The first malformed entry by line is the one reported. Accepted, exit 0:
    - no version key with `refStorage = reftable` (the extension is ignored and files refs are
      read);
    - an unknown extension at v0 and `noop` at v1 (throwaway twins).
    The refusals reuse the main repository's existing codes, so no error-union member is added.
23. **An unresolvable HEAD keeps the recorded commit** (add-gitlink-interop.test.ts). Once the
    repository is usable, these exit 0 with the gitlink as recorded and no error:
    - a reftable `tables.list` naming a missing table, a garbage `tables.list`, a 4-byte table;
    - `chmod 000 refs/heads`;
    - a loose ref that is a symlink to non-ref content.
24. **Size and bench, measured.** Part 22 (`01162abc`) raised the caps for +1 042 B gzip on the
    browser bundle (`add` 4 983 → 5 693 B). The review round added +587 B (`2ccbbffd`; domain
    +719 B for the hoisted format scan, commands-internal +458 B for the gitlink rules), and
    `add` ended at 5 712 B. `bench:ab` on fact 15's literal rows moved at most 0.12 ms on about
    16 ms, because the ignore predicate is lazy. A literal plus an exclusion now walks: 18–19 →
    35–37 ms on a flat 10k repository, accepted under ADR-1053.
25. **checkout restores a skip-worktree path from a differing tree** (checkout-skip-worktree
    suites). `checkout HEAD~1 -- sw.txt`, where `HEAD~1` holds another blob, exits 0. The file
    is written at v1, the index takes the v1 blob, and the bit is cleared (`H`). The same holds
    for `sw*`, for `sw.txt n.txt`, and for a mode-only difference (index `100755`, tree
    `100644`, result `H 100644`). Equal (mode, id) still refuses `PATHSPEC_NO_MATCH` and keeps
    `S`. The index source drops every skip-worktree path.
26. **Ignored report order and `?`** (add-ignored-report-interop.test.ts). The list is sorted by
    bytes on both routes: `！.log` before `😀.log`, and `！` before `😀`. `add '?'` on the full I
    fixture (untracked only) is refused 128, as is tsgit's `PATHSPEC_NO_MATCH '?'` (throwaway). It
    exits 0 only on fixture D, where `?` also matches the tracked `k`.
27. **`!x x` (exclusion before the positive) is not delivered.** git stages nothing. tsgit stages
    `x`, because `matchesPathspec`/`pathspecVerdict` are last-match-wins (ADR-038). The same
    holds for `rm`, `checkout` and `grep`. Superseding ADR-038 is the `!` alias question, fenced
    out to 32.11b, so the suites dropped design rows X7 and X14.
28. **git 2.56 rewords one broken-gitlink shape** (throwaway against
    `git version 2.56.0`). `not a git repository: <pointer>` becomes
    `gitfile does not point to a valid repository: sub/.git` for a pointer to nothing, a garbage
    module HEAD and a `commondir` naming `/nonexistent`. `invalid gitfile format`,
    `not recognized as a git repository` and the zero-byte `commondir` line keep their wording.
    The suites pin 2.55, and the wording is display.
29. **The refusal's `path` is git's spelling** (ADR-1057). `NO_COMMIT_CHECKED_OUT.path` is
    'sub/', as in git's `error: 'sub/' does not have a commit checked out`. Design candidate 23
    wrote "without the trailing `/`"; the ADR binds.
30. **The walk gate at `a85a6386`.** `enterSubdirectory` (walk-working-tree.ts :64–77) returns
    `undefined` when `frame.entries.some(isEmbeddedGitMarker)` (:206–219: a `.git` directory, or
    a `.git` regular file that is no symlink). `stepEntry` (:90–125) runs the directory's ignore
    check (:105) before it, and the root frame never passes through it. `WalkWorkingTreeOptions`
    (types.ts :267–282) reaches the package through `export type *` (primitives/index.ts :101 →
    public-types.ts :10) and the facade (repository.ts :1085 forwards `options` as is). A new
    option therefore changes reports/api.json and nothing else.
31. **An unmerged gitlink is not pruned.** `pruneGitlinkDirectories` keeps out stage-0 gitlinks
    only. The rows "add over an unmerged gitlink" (add-gitlink.test.ts :1084) hold a checkout at
    'sub', so a walk given the hook lists 'sub' as a repository leaf beside R15's
    `stagedGitlinks` outcome for the same path. Those rows are the guard for candidate 32. git's
    `directory_exists_in_index` answers `index_gitdir` for a gitlink at any stage and lists
    nothing there (dir.c, read, not probed).
32. **Seen is decided after exclusion.** EM61 (`add sub '!sub'`) exits 0 only through the
    `file_exists` escape, and EM62 (`add 's*' '!sub'`) refuses `s*`. So `unseenWalked` must see the
    SELECTED repository leaves only, spelled `<dir>/`. The walked files already are post-exclusion
    (`withPathspec` drops the leaves the matcher does not select).
33. **The index pass drops every walked key** (`hiddenTracked`, add.ts :1148). If an unselected
    repository leaf reached it, EM67 (`add '*b'` over a tracked file 'sub' turned repository)
    would lose its index pass and stage the removal. The pass gets the files plus the selected
    leaves.
34. **`addAll` removes what it did not see.** `collectRemovedEntries` → `presentOnDisk` (add.ts
    :1579–1619) treats a directory over a non-gitlink entry as gone unless its key is in `seen`,
    and `processWalkEntry` is the only writer of `seen`. Every gitlink outcome that replaces a
    tracked file must be marked: the walk leaf (EM66 under `-A`) and the index pass (EM69 under
    `-A`).
35. **Three rows pin today's skip; the design names two.** add.test.ts :933 (`vendor/lib/.git/HEAD`
    alone) and test/integration/add-all.test.ts :19 (the same shape) hold no `objects/` or `refs/`,
    so neither is a repository by git's test (EM33 class): 'vendor/lib/src/x.ts' is staged once
    `addAll` passes the hook. add.test.ts :1239 (`gitdir: /elsewhere`) is EM36: 'sub/normal.txt'
    is staged. add.test.ts :1261 (a dangling `.git` symlink, EM28) and the walk rows :210, :651,
    :827 and :847 (hook unset) stay green.
36. **Classification is cheaper than HEAD.** The probe's repository test is `locateCheckout` →
    `hasUsableHead` → `reaching` → `holdsObjectsAndRefs`, git's test for a non-bare repository directory.
    `refStorageOf` (the format gate, GL39–GL44) and `resolveGitlinkHead` run only when HEAD is
    asked for. A format git refuses is still a repository (EM42 and EM43 refuse "no commit", not
    the format), so the embedded reader maps a TsgitError from the HEAD read to "no commit", while
    `gitlinkHeadOf` keeps throwing it.
37. **Three JSDoc sentences go stale.** `add` (add.ts :174, "`.git` and embedded repositories are
    skipped"), `walkWorkingTree` (walk-working-tree.ts :140–143) and `status` (status.ts :130–137,
    `untracked` holds paths). Each is in reports/api.json, so the part that changes the behaviour
    rewrites the sentence and regenerates the report.
38. **plan-lint counts every span in backticks holding a `/` as a file** (craft plan-lint
    `isPathShaped`). Part 19's as-shipped note was re-spelled for that reason; Parts 23–29 quote
    fixture paths ('sub/u') instead of putting them in backticks.
39. **Size before Part 23.** The session reports four size rows 10–42 B over their caps after the
    triage and refactor commits. Part 29 measures both the pre-Part-23 overage and this round's
    delta from clean builds and raises once.

## Requirement map

| Req | Part(s) |
|---|---|
| R1 dialect (verbatim first, flags-0 wildmatch over bytes) | 1, 2 (fast paths), 10 (`\` bodies at command level, ADR-1044) |
| R2 add / add --renormalize / rm refuse the first unmatched, before any write | 6 (rm), 7 (add); helpers: 5 |
| R3 checkout refuses every unmatched, lock + index read first | 8; helpers: 5 |
| R4 rm -r by match level | 6 |
| R5 unmatched glob whose verbatim body exists is not refused | 7 |
| R6 grep never refuses | 1 (GUARD rows) |
| R7 describe flags-0 on the short name | 3 |
| R8 name-rev suffix matching + abbreviation as data | 3 (filter), 11 (result field, every N interop row) |
| R9 gitignore/attributes/sparse unchanged | 4 |
| R10 linear matchers, size, add-glob bench | 2, 12 |
| R12 add (pathspec and `-A`) stages tracked entries that ignore rules hide from the walk, as git's index-side pass does | 9 |
| R13 add leaves skip-worktree entries unstaged and reports pathspecs only they match | 14 (walk, `addAll`, the `sparse` field), 15 (literal route, `--renormalize`) |
| R14 checkout leaves skip-worktree paths out of the path-restore universe | 16 |
| R15 add stages a gitlink whose checkout HEAD moved; a broken `<path>/.git` refuses | 19 |
| R16 add reports ignored entries a pathspec reaches; `force` is git's `-f` | 17 (walk route, `addAll`, the `ignored` field), 18 (literal route) |
| R17 the walk admits `\`-named entries on POSIX; rm removes them | 20 (walk), 21 (rm) |
| R18 a literal-only add honours exclusions | 13 |
| Fold size caps | 22 |
| R19 add stages an untracked repository as a gitlink (walk route, `-A`, literals beneath it, the no-commit refusal) | 23 (walk hook), 24 (probe as data, reader), 25 (error member), 26 (pathspec route), 27 (`-A`, literal ancestors) |
| R20 a tracked file or symlink turned repository is a type change to a gitlink | 26 (the walk lists it), 27 (the index pass, `-A`) |
| ADR-1061 status lists an untracked repository as `sub/` | 28 |
| Embedded-repository size caps | 29 |

## Decision candidates

Candidate 1 is decided (ADR-1044, B); candidates 2–5 were adopted as recommended. The rows stay
as the audit trail.

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| 1 | Backslash in a pathspec body (fact 1) | **A** keep `validateWorkingTreePath`'s refusal: D6/D8b/D17/E1/E2 stay divergent at command level, pinned as a follow-up; the matcher keeps `\` glob-special · **B** accept `\` in pathspec bodies on non-Windows hosts, matcher-only: a `\`-holding body never reaches `lstat`, the symlink scan or `literalStats` (needs a security review of the relaxed validator) · **C** accept `\` everywhere | **Decided: ADR-1044, B** (recommendation was A) | The refusal is a path-traversal defence shared with tree/index boundaries; relaxing it is a security-surface change the design never weighed. B is a separate part (validator split + the five rows) if chosen. |
| 2 | Testing the Part 2 fast paths under mutation | **A** export the shape classifier and the one-star evaluator (internal) and unit-test them directly; the dispatch `if` that falls back to the byte DP stays an equivalent mutant, triaged at validation with no suppression comment unless the user approves one · **B** ship Part 1 without fast paths; add them only if `bench:ab` on the add-by-glob row regresses beyond noise | A | The design and ADR-1033 admit the fast paths and the hot path (`add '*.ts'`) is the common call; A leaves at most a handful of provably equivalent dispatch mutants. |
| 3 | `add` walk-seen source when a `!` element is present | **A** test each positive element against the leaves the walk yields (already filtered by the whole spec) · **B** test against every non-ignored leaf before the pathspec filter (git's positive pass marks `seen` before excludes) | A | Only specs combining `!` with an otherwise-unmatched element differ; `!` semantics are backlog 32.11b. |
| 4 | On-disk escape scope under `add --renormalize` | **A** every unseen positive (literal or wildcard) whose verbatim body `lstat`s is accepted — git's `file_exists` (RN4, RN5) · **B** wildcard only, as ADR-1036 states for the walk | A | RN5 is today's pinned literal behaviour and RN4 is git's; ADR-1036's literal exclusion exists because the walk's ignored-literal advice is unbuilt, which `--renormalize` never prints. |
| 5 | checkout when every positive is seen but the spec selects nothing (a `!` removes all) | **A** release the lock without writing the index (today's no-op, now under the lock) · **B** commit the index as git's `checkout_paths` does after taking the lock | A | Unpinned; only reachable through `!` (32.11b). |

Fold revision candidates (Parts 13–22). Parts 13–22 are written to the recommendation; the session
may override any of them before implementation starts.

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| 6 | Where the fold's interop rows live | **A** one new focused file per part (add-skip-worktree, checkout-skip-worktree, add-ignored-report, add-gitlink, pathspec-literal-exclusion) · **B** extend the files the design names (add-tracked-under-ignore-interop, pathspec-glob-dialect-interop) | A | The file ceiling (6 per part) and the 926-line dialect file. The design-named files stay green untouched. pathspec-backslash-interop (104 lines) is extended, as designed. |
| 7 | How a gitlink's repository is judged valid (GL20, GL21, G1–G4) | **A** export `hasUsableHead` from primitives/internal/repo-state.ts (git's `validate_headref`) and refuse when it is false · **B** infer from `resolveRef` errors | A | G2 (empty `.git` directory) refuses in git, but `resolveRefOrMissing` would read it as unborn and stage nothing. git's gate is `is_git_directory` → `validate_headref`; A reuses the predicate discovery already applies. |
| 8 | The child context's ref storage | **A** `refStorage: 'files'`, as `buildChildContext` sets it · **B** read the child's `extensions.refStorage` | A | B needs src/repository/read-repository-format.ts, which commands may not import (dependency rule). No GL row uses reftable; out-of-scope line below. |
| 9 | Which refusal wins when several matched gitlinks are broken | **A** the first in index order: settle every probe, then `firstFailureOrValues` · **B** whichever rejects first (`boundedMapFor`'s plain contract) | A | git walks the index in order and dies at the first. B makes the error depend on I/O timing. Unpinned with two broken gitlinks. |
| 10 | When the result fields land | **A** `sparse` in Part 14 and `ignored` in Part 17, each with its api.json regeneration · **B** both in Part 14, `ignored` always `[]` until Part 17 | A | B ships a field that misreports for three commits. A costs one extra `docs:json` run. |
| 11 | Shape of rm's host-gated validator (ADR-1052) | **A** a new `validateWorkingTreePathOn(input, host)`; `validateWorkingTreePath` keeps refusing `\` for every other caller · **B** an optional `host` parameter on `validateWorkingTreePath` | A | ADR-1052 scopes the gate to `removeFile`. A required host on a separately named function cannot widen to `mv` or `materializeFile` by accident. |
| 12 | How the walk route learns which ignored entries a positive reached | **A** a recording ignore predicate wrapped around `repoIgnore` inside `withPathspec`, local to one `stageIgnoredWalk` call · **B** a second pass over the pruned directories | A | Design Part h: the walk prunes at the shallowest ignored directory, so the predicate sees exactly git's reported entry with no ancestor loop. B re-reads directories. |

Embedded-repository candidates (Parts 23–29). The parts are written to the recommendation; the
session may override any of them before Part 23 starts.

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| 29 | Shape of the non-throwing probe (design Part k: "for example") | **A** `none` · `broken { shown }` · `repository { head: () => Promise<ObjectId \| undefined> }`; `head()` reads the format and HEAD on demand, a refused format throws from it · **B** the head resolved eagerly in the union, plus a fourth `refused { error }` kind for the format · **C** two exports, `locateGitlinkRepository` returning the internal `Located` record and `headOfRepository(located)` | A | The design wants HEAD paid only for a selected repository (Size and hot path), and status never needs it. B resolves HEAD for every probed directory. C exports the internal record. A keeps `gitlinkHeadOf`'s format refusal where it is today. |
| 30 | The public walk option's name and type | **A** `isNestedRepository?: (directory: FilePath) => boolean \| Promise<boolean>`, inline, like `ignore` may be sync or async · **B** a named exported `WalkNestedRepositoryPredicate` type · **C** `nestedRepository` (the design's placeholder) | A | A predicate reads as a question. A named type adds a public name to api.json and every `export type *` consumer for no caller need. |
| 31 | Where the per-call reader lives | **A** src/application/commands/internal/embedded-repository.ts, shared by `add` and `status` · **B** inside add.ts (the design's sketch), with `status` repeating it · **C** primitives/internal | A | `status` needs the same hook (ADR-1061). The index search and the probe are command concerns (gitlink-head.ts already lives in commands/internal). |
| 32 | A walk leaf at a path whose index entry is a gitlink at a conflict stage (fact 31) | **A** the embedded step skips it; `stagedGitlinks` (R15) owns that path · **B** widen `pruneGitlinkDirectories` to every stage · **C** have the hook answer false there | A | git lists nothing at `index_gitdir`. B changes a file the design keeps unchanged and also changes `status`. C walks into the submodule and stages its files. |
| 33 | Where the status rows live | **A** new focused files status-embedded-repository.test.ts and status-embedded-repository-interop.test.ts · **B** the design-named status.test.ts (1 700 lines) and status-interop.test.ts | A | Candidate 6's precedent. status-interop compares plain `--porcelain`, while these rows need `-uall`. |

## Deferred to documentation phase

- Design part e: `docs/BACKLOG.md` release-order row 1 and the 32.11 sub-items (strike a–d, keep
  32.11b) — no part carries it.
- User docs that state the old behaviour (documentation phase rewrites them):
  docs/use/commands/add.md lines 42 and 60, docs/use/commands/rm.md line 77,
  docs/use/commands/checkout.md line 92, docs/use/recipes.md line 71, docs/use/errors.md line 130
  (`patterns`), docs/use/commands/name-rev.md (result shape gains `abbreviated`; line 40 says
  "full-refname glob"), docs/use/commands/describe.md (`match`/`exclude` dialect).
- docs/use/errors.md line 131 (`PATHSPEC_OUTSIDE_REPO`): on a POSIX host a pathspec holding `\` is
  no longer refused (ADR-1044); the row's wording and the pathspec mentions in
  docs/use/commands/add.md, rm.md and checkout.md need the Windows-only qualifier.
- `docs/design/pathspec-glob-dialect.md` Test strategy names `rev-parse --abbrev-ref`; fact 3
  corrects it to `--abbrev-ref=loose`.
- Fold docs/use targets (Parts 13–21):
  - docs/use/commands/add.md: `AddResult.sparse` (pathspecs as typed, argument order, duplicates
    kept) and `AddResult.ignored` (paths, sorted). A non-empty list is git's exit 1, and the caller
    rebuilds the advice text from it (ADR-1046). `force` is git's `-f` on every route, no longer a
    no-op (ADR-1047). An ignored untracked literal is reported, not staged: name this for consumers
    who relied on the bypass, and point them to `force` (ADR-1048). Skip-worktree entries are never
    restaged. A gitlink whose checkout HEAD moved is staged. `!` exclusions apply to literal-only
    calls.
  - docs/use/commands/rm.md: on a POSIX host a `\`-named working-tree file is removed (ADR-1052).
  - docs/use/commands/checkout.md: a path restore leaves skip-worktree paths alone. A pathspec that
    matches only such paths refuses `PATHSPEC_NO_MATCH`.
  - docs/use/errors.md: `NOT_A_REPOSITORY` from `add` for a matched gitlink whose `<path>/.git`
    leads to no repository, with `path` as git prints it (ADR-1050). `PATHSPEC_OUTSIDE_REPO` is no
    longer raised by the working-tree walk (add, status, stash) or by rm's removal for a `\`-named
    entry on POSIX hosts (ADR-1051, ADR-1052).
  - docs/use/commands/status.md: check for wording that says a `\`-named file is refused (W7, W16).
- `docs/design/pathspec-glob-dialect.md` I12–I16 index column: fact 9 adds `y.log` on the full
  fixture. Its fold test table names add-tracked-under-ignore-interop and pathspec-glob-dialect-interop;
  decision candidate 6 moved those rows to new files.
- Embedded-repository docs/use targets (Parts 23–28):
  - docs/use/primitives/walk-working-tree.md: the `isNestedRepository` option (ADR-1059).
  - docs/use/commands/add.md: an untracked repository is staged as a `160000` gitlink in `added`;
    a tracked file or symlink turned repository is a type change in `modified` (ADR-1058); a literal
    inside an untracked repository stages nothing and is not refused (ADR-1060); a selected
    repository with no commit refuses `NO_COMMIT_CHECKED_OUT` before any write (ADR-1057, 1062);
    no hint field: a caller derives git's embedded-repository hint from the staged entry's mode
    (ADR-1056).
  - docs/use/commands/status.md: `untracked` lists an untracked repository once, as 'sub/'
    (ADR-1061).
  - docs/use/errors.md: the `NO_COMMIT_CHECKED_OUT` row, `path` spelled 'sub/'.

## Out of scope, proven (one line each, not acted on)

- tsgit's gitignore dialect has no `[…]` (compile-glob.ts header, R9): git ignores `nomatch*` under
  `nomatch[*]`, tsgit does not — prove with a twin `git check-ignore nomatch*` against tsgit's
  ignore predicate.
- `add` never stages a gitlink whose submodule checkout moved (git 2.55: `add s`, `add .` and
  `add '*'` all stage `M s`, ignored or not) — hunch for tsgit; prove with a twin where the
  submodule commits after the superproject records it, then `add s` on both.
- `rm` tolerates an unreadable index (`isIndexMissingCode`, src/application/commands/rm.ts:53)
  where git dies on it — hunch; prove with a twin `git rm 'x*'` over a 3-byte `.git/index`.
- A reftable submodule's HEAD (candidate 8 A reads it as `files`): no GL row covers it. Hunch; to
  prove it, twin GL1 with `git -c init.defaultRefFormat=reftable` inside the submodule, then
  `add .` on both.
- A symlinked `<path>/.git` over a tracked gitlink: unpinned. Part 19 reads it as a gitfile. To
  prove a gap, twin GL1 with `sub/.git` replaced by a symlink to `../.git/modules/sub`.
- EM78, EM79 and EM81 (status v2 worktree mode of a gitlink, `checkout -- sub` over a directory):
  proven in the design's Out of scope, one backlog line each, not planned.
- `stash -u` over an untracked repository: unpinned (design Out of scope); the walk default stays
  unchanged for `stash` under ADR-1059.

## Fold revision — house rules for Parts 13–22

Parts 1–12 are landed. Parts 13–22 implement design Parts f–j (R13–R18) under ADRs 1046–1053, in
this order: 13 (R18) → 14, 15 (R13) → 16 (R14) → 17, 18 (R16) → 19 (R15) → 20, 21 (R17) → 22
(size). Each builds on the previous ones in one working tree.

- **Environment.** git 2.55.0 first on PATH for every interop run:
  `PATH="$HOME/.local/git-2.55.0/bin:$PATH"`. Pass `--no-ext-diff` to every `git diff`/`git show`.
  Implementers have no MCP tools: re-anchor each symbol with `grep -n '<name>'` (fact 14), and never
  trust a line number blindly.
- **One RED per function per step.** Write the step's row, run it, see it fail for the stated
  reason, then write the code. A row that passes at its step is a GUARD. Never batch several steps'
  REDs behind one GREEN.
- **Re-pinning rule.** When an existing row breaks, decide whether the old expectation encoded the
  contract. If it did, fix the code. A changed row is re-pinned against git 2.55 (cite the design
  row or the planner fact), never rewritten to match new code. Each part lists the rows it expects
  to re-pin.
- **Every pinned row is a cross-tool interop row** (scrubbed env via `runGit`, `runGitEnv`,
  `tryRunGitWithExit` from test/integration/interop-helpers.ts; pinned commit dates
  `@1700000000 +0000`), plus memory-adapter unit rows in the part's focused suite. add.test.ts is
  already 4766 lines, and a 256 MiB row there times out under load, so new add rows go in the new
  sibling suites, never in add.test.ts. add.test.ts is touched only for re-pins and the whole-result
  sites (fact 16).
- **Test conventions** (`check:test-pyramid`): `describe('Given …')` > `describe('When …')` >
  `it('Then …')`, AAA comments, `const sut = add` (bind the function, never a call result:
  `sutBindsResult`), no `describe.each<T>` generic, no row ids (S1, GL4, …) or ADR numbers in test
  titles or code. Every new interop file opens with a `@proves` header (surface, bucket
  `cross-tool-interop`, a `unique:` line no other file uses, interopSurface). Copy the header and
  twin builder from test/integration/add-tracked-under-ignore-interop.test.ts (`twins`,
  `writeFiles`, `commitAll`, `snapshotOf`). Assert result fields one by one, never the whole
  `AddResult`.
- **Mutation-resistant asserts.** Assert error data with try/catch (`refusalOf` /
  `expectError` shape), never `toThrow(Class)` alone.
- **No suppression directives, no provenance ids in code, no swallowed errors.** Commit only the
  part's files, one `fix(<scope>): …` commit, subject ≤ 100 characters.
- **Public surface.** `AddResult` and `AddOptions` are public: they are re-exported by
  src/application/commands/index.ts:23 and reach the package entry. A part that changes either
  type, or the JSDoc of `add`, `AddOptions` or `AddResult`, regenerates `reports/api.json` with
  `npm run docs:json` and commits it. `check:doc-typedoc` is a prepush gate, not a validate gate.
  The huge typedoc-id diff is normal. No fold part adds a command, a barrel name or an
  error-union member: ADR-1050 reuses `NOT_A_REPOSITORY`. So the facade, the
  `Object.keys(sut)` snapshot, `check:doc-coverage`, `audit-browser-surface`, the README count and
  the exhaustiveness switches are untouched. Every other new symbol is internal.
- **Size caps** sit at the headroom floor. Parts 13–21 never touch them. Part 22 measures once
  from a clean build and raises by the measured delta (lesson 006).
- **Never run `npm run validate`.** The session owns it. Never run two `npm run` scripts at once.
- **Why parts share files** (plan-lint's overlap warnings). add.ts, add.test.ts and api.json are
  the one command's surface, edited by sequential parts that the 6-file ceiling keeps apart. Parts
  20 and 21 share working-tree-path.ts and its test because the ceiling splits the walk from rm,
  and ADR-1051 and ADR-1052 are separate decisions. Part 22 repeats Part 12's size procedure over
  the fold's bytes. Parts 10 and 14 share pathspec-intake.test.ts: Part 10 is landed.

## Embedded-repository revision — house rules for Parts 23–29

Parts 1–22 are landed, with the review, triage and refactor commits on top; the plan was revised
at `a85a6386`. Parts 23–29 implement design Part k (R19, R20, rows EM1–EM82) under ADRs
1054–1062, in this order: 23 (walk hook) → 24 (probe as data, reader) → 25 (error member) → 26
(pathspec route) → 27 (`-A`, the index pass, literals) → 28 (status) → 29 (size). Each builds on
the previous ones in one working tree.

- **Every fold house rule above applies**: environment, one RED per function per step, the
  re-pinning rule, interop twins plus memory-adapter rows in focused suites, test conventions,
  mutation-resistant asserts, no suppression, no provenance ids, never `npm run validate`.
- **Line numbers are at `a85a6386`.** Re-anchor every symbol with `command grep -n '<name>'`
  before editing; earlier parts of this round move them.
- **Fixtures.** The design's "Repo": the superproject holds `k`, committed; the repository is
  `git init -q -b main <dir>` with `u` committed inside, dates pinned to `@1700000000 +0000`.
  Build each twin by running the same setup in it (pinned env and identity give both twins the
  same ids), as add-gitlink-interop.test.ts `twins` does; copy its `commitIn`, `writeFiles`,
  `looseCountOf` and pinned env. Memory rows lay a repository out as gitlink-head.test.ts
  `layOutRepository` does ('sub/.git/HEAD' = 'ref: refs/heads/main\n', 'objects' and 'refs'
  directories, the branch file holding a 40-hex id); an unborn repository omits the branch file.
- **What a twin compares.** `ls-files -s` and git's exit code. A refusal compares the error code
  and `path` with the path in git's `error: '<dir>/' does not have a commit checked out` line,
  and both indexes unchanged. Under ADR-1062, EM45 and EM60 do not compare loose-object counts:
  git writes the blobs that sort before the repository, tsgit writes none. The tsgit twin's count
  stays at its pre-call value (ADR-1035), and memory rows prove an untracked file's blob was not
  written (`blobExists` in add-gitlink.test.ts :746).
- **Positive controls.** Every "stages nothing" row has a sibling on the same fixture that does
  stage: EM37 for EM8, EM75 for EM74, EM66 for EM71, EM61's `add .` over EM1 without the
  exclusion.
- **`-f` and `:!`.** git's `add -f` is `{ force: true }`; git's `:!sub` is tsgit's `!sub`
  (ADR-038).
- **Public surface.** Part 23 (the walk option and its JSDoc), Part 25 (the union member), Part 27
  (the `add` JSDoc) and Part 28 (the `status` JSDoc) regenerate reports/api.json with
  `npm run docs:json` and commit it. Every other new symbol is internal. No part adds a command, a
  barrel name or a facade binding, so the `Object.keys` snapshot, check:doc-coverage,
  audit-browser-surface and the README count are untouched.
- **Why parts share files.** add.ts and the two add-embedded-repository suites are edited by 26
  and 27: the 6-file ceiling puts the re-pinned suites and the `add` JSDoc in 27. reports/api.json
  is regenerated by each part that changes the public surface.
- **Session-owned, not part steps:** mutation (narrowed buckets gain walk-working-tree.ts,
  gitlink-head.ts, embedded-repository.ts and the touched add.ts and status.ts functions) and
  `bench:ab` on add.bench.ts (the untracked single-literal rows and an `add -A` row), after Part
  27's commit.

## Part 1 — Pathspec wildcards match with git's flags-0 wildmatch over the path's bytes

### Context
**Status: landed as 63451e93.** Its file paths below are plain text: the part is history, not a pending unit of work.


Files this part creates or edits (exactly these):
- src/domain/refs/ref-glob.ts — add the bytes-taking compile.
- test/unit/domain/refs/ref-glob.test.ts — rows for it.
- src/domain/pathspec/wildcard.ts — CREATED: match levels, verbatim rule, glob-special test,
  the wildcard matcher. Part 2 adds the fast paths to it (a new module, so the two parts share no
  pre-existing file).
- test/unit/domain/pathspec/wildcard.test.ts — CREATED; Part 2 extends it.
- src/domain/pathspec/compile-pathspec.ts — `compileOne` delegates to wildcard.ts. This part is
  its only editor in the run.
- test/integration/pathspec-glob-dialect-interop.test.ts — CREATED here; Parts 6, 7, 8, 9 extend it
  (one interop file per pinned matrix, one twin-repo builder).

Read-only references: src/domain/objects/encoding.ts (encodeEscaped at :205, encode),
src/domain/git-index/index-path-key.ts (escapedPathOf, IndexPath),
src/domain/pathspec/match-pathspec.ts, src/domain/pathspec/matching-path.ts,
test/unit/domain/pathspec/compile-pathspec.test.ts and matching-path.test.ts (existing rows stay
green unchanged here — Part 2 retitles two of them), test/integration/pathspec-dot-interop.test.ts
(twin-repo and createNodeContext template, the `@proves` header shape),
test/integration/interop-helpers.ts (GIT_AVAILABLE, runGit, runGitEnv, runGitBytes,
tryRunGitWithExit, stageRaw, hashBlob, pathHexOfRecords, lsFilesPathHex, hex).

Current code (at the base):
- ref-glob.ts: private `tokenize(bytes, dialect)`, `matchTokens(tokens, text: Uint8Array)`,
  `REF_DIALECT` (flags 0), `compileWith(pattern, dialect): (text: string) => boolean`
  (encodes the pattern once and the text per call), exports `compileRefGlob(pattern)`,
  `compilePathnameGlob(pattern)`, `matchRefGlob(pattern, ref)`. Shared with
  src/application/commands/internal/merge-message.ts and src/domain/reflog/expire-policy.ts: those
  three exports keep their contracts. Keep the four `Stryker disable next-line` equivalence lines
  (:112, :140, :284, :295) byte-identical.
- compile-pathspec.ts: `compileOne` → literal (`!containsGlob(body)`) uses `compileLiteral`
  (`''` → WHOLE_TREE, trailing "/" → `compileDirectory` = startsWith, else
  `compileGlob(body, { anchored: true, withDirSuffix: true })`); glob uses
  `compileGlob(body, { anchored: body.includes('/') })` (gitignore anchoring: "foo*" is tried at
  every depth, `*` stops at "/", no brackets, no escapes, `?` is one UTF-16 unit).
  `PathspecEntry` = { pattern, body, negated, isLiteral, compiled: GlobMatcher } — the public
  `Pathspec` type (src/public-types.ts:85); keep the shape.
- matching-path.ts: `matchesIndexPath(spec, entry) = matchesPathspec(spec, escapedPathOf(entry))` —
  the escape view (a non-UTF-8 byte is a lone U+DC80..U+DCFF); unchanged.

Target shape (internal exports, not barrelled, not public):

    // wildcard.ts
    export const MATCH_LEVEL = { NONE: 0, RECURSIVE: 1, FNMATCH: 2, EXACT: 3 } as const;
    export type MatchLevel = (typeof MATCH_LEVEL)[keyof typeof MATCH_LEVEL];
    export const hasGlobSpecial = (body: string): boolean  // any of * ? [ \
    export const verbatimLevel = (body: string, path: string): MatchLevel
      // '' → RECURSIVE (git: an empty match covers every path)
      // !path.startsWith(body) → NONE; same length → EXACT;
      // body ends in '/' or path[body.length] === '/' → RECURSIVE; else NONE
    export const compileWildcard = (body: string): GlobMatcher
      // const wild = compileRefGlobBytes(body);
      // test = verbatimLevel(body, p) !== NONE || wild(encodeEscaped(p))
    // compile-pathspec.ts — compileOne: isLiteral = !hasGlobSpecial(body)
    //   literal: '' → WHOLE_TREE, else test = verbatimLevel(body, p) !== NONE
    //   wildcard: compileWildcard(body)
    // ref-glob.ts
    export const compileRefGlobBytes = (pattern: string): ((text: Uint8Array) => boolean)
      // tokenize(encode(pattern), REF_DIALECT) once; abort → () => false; reuses matchTokens;
      // compileWith is rewritten on top of it (no second DP)

wildcard.ts imports `GlobMatcher` as a type from compile-glob.ts; compile-pathspec.ts imports
wildcard.ts (no import back — no cycle). The level ordering mirrors git
(`RECURSIVE < FNMATCH < EXACT`) so Part 6 can take a max. Never `TextEncoder` a path:
`encodeEscaped` turns each lone U+DC80..U+DCFF back into its raw byte.

Matrix rows this part makes pass (design `## Pin matrix (git 2.55.0)`): D2, D3, D5a–D5e, D9, D11,
D11b, D12, D16, E4, E5, C6, L1–L3, L5, L6, G3, R2, R4, R5, R6. GUARD rows (design marks them ok):
D1, D4, D8a, D13, D14, E3, G1, G2, G4, G5, L4, R3. Not here: D7, D8c, D10 (refusals, Part 7).
The matcher behaviour of D6, D17, E1, E2 (bodies holding a backslash) IS unit-tested here through
`compileWildcard`; their command-level rows (D6, D17, E2) land in Part 10 once the intake accepts
the backslash on POSIX hosts (ADR-1044); D8b/E1 stay follow-ups.

Interop file guidance: copy the header and the twin-repo builder shape from
pathspec-dot-interop.test.ts (`@proves` surface/bucket/unique/interopSurface: add, rm, checkout,
grep). One builder writes the same files into a git-initialised `git-<slug>` and `tsgit-<slug>`
repo (`runGit(['init','-q','-b','main', dir])`); tracked fixtures commit on the git side with
`GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` pinned (as pathspec-dot-interop does) and on the tsgit twin
with the same git commands (the twin is set up by git; only the Act step runs tsgit). Compare
`git ls-files -s` (or `lsFilesPathHex` for non-UTF-8 names), file bytes, loose-object counts.
Keep rows table-driven (`describe.each` / `it.each`) — `check:duplicates` (jscpd, 5 lines /
50 tokens) runs in validate. L rows: build the index with `stageRaw` (bytes via
`update-index -z --index-info`; works on APFS): entries `a\377` (bytes 61 ff), `aé`
(61 c3 a9), `ab`, each pointing at a `hashBlob` oid; git side `runGitBytes(['-C', dir,
'ls-files','-s','-z','--', spec])` → `pathHexOfRecords`; tsgit side `readIndex` +
`matchesIndexPath(compilePathspec([spec]), entry)` → hex of `entry.pathBytes ?? encode(entry.path)`.
L6: tsgit `rm(ctx, ['a?'], { cached: true })` vs `git rm --cached -q 'a?'`, compare
`lsFilesPathHex`. A worktree-side lossy row (`add 'a?'` with files `a\377`, `aé`, `ab`; git stages
`a\377` and `ab`) is gated with `describe.skipIf(!GIT_AVAILABLE || process.platform !== 'linux')`
— APFS refuses the name.

Environment: anything running real git needs git 2.55.0 first on PATH:
`PATH="$HOME/.local/git-2.55.0/bin:$PATH"` (the default git 2.56 fails ~100 interop tests on
`main` for unrelated reasons). Probes that write git state go in a `mktemp -d` throwaway.
Implementers have no MCP tools: use Bash (grep/sed) over the paths above.

Windows: no file name there can hold `*`, `?`, `:` or a backslash, so every interop row whose
FIXTURE creates such a name (not merely a pathspec spelling) sits under
`describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')` (the repo convention, e.g.
test/integration/filter-clean-smudge-interop.test.ts:1377); the unit rows (memory adapter) cover
those shapes on every OS.

House rules: one RED per function, run it and watch it fail for the stated reason before writing
its code; a row that already passes is a GUARD, never a RED. After any scripted edit, confirm
`git diff --no-ext-diff --stat` shows it before trusting a gate. Poll background processes, never
end a turn waiting on one. Commit only this part's files (explicit `git add <file>…`). No phase,
ADR, backlog or matrix-row ids in source or test text (titles describe behaviour; "pinned against
git 2.55" is fine). No suppression directives.

Re-pinning rule: When an existing test row breaks, decide whether the OLD expectation encoded the
contract. If it did, fix the code, not the row, and say so. A changed row is re-pinned against real
git 2.55 (or the design's matrix row id), never rewritten to match the new code.
The design names compile-pathspec.test.ts "Given a glob \"*.ts\"" (D1) and "Given an anchored glob
\"src/**\"" (D13): their verdicts do not change, they stay green here, and Part 2 retitles them.
Consumer suites the gate sweeps (add, rm, checkout, grep, snapshot, workdir enumerator, the
existing pathspec suites) must stay green; any row there that breaks goes through the rule above.

### TDD steps

1. RED — `ref-glob.test.ts`, new describe "compileRefGlobBytes": Given well-formed refs, its verdict
   equals `compileRefGlob(pattern)(text)` for "refs/tags/*" vs "refs/tags/rel/v1", "m[a-z]in" vs
   "main", "m\\*in" vs "m*in", "m[a" vs "main" (abort → false); Given raw bytes: "a?" accepts
   `[0x61,0xff]` and rejects the bytes of "aé"; "a??" accepts "aé"; "a[^b]" accepts `[0x61,0xff]`;
   "a[[:alpha:]]" rejects `[0x61,0xff]`. Fails: `compileRefGlobBytes` is not exported (import is
   undefined → "is not a function").
   GREEN — add `compileRefGlobBytes`; rebuild `compileWith` on it; existing exports unchanged.
2. RED — `wildcard.test.ts` (create), describes "verbatimLevel" (rows: "src"/"src" EXACT,
   "src"/"src/a" RECURSIVE, "src"/"src2" NONE, "d/"/"d/x" RECURSIVE, "a?"/"a?/f" RECURSIVE,
   ""/"x" RECURSIVE, "src/a"/"src" NONE) and "hasGlobSpecial" ("*.ts", "a?", "[ab]", "a\\b" true;
   "plain.ts", "a]b", "" false). Fails: the module does not exist.
   GREEN — create wildcard.ts with `MATCH_LEVEL`, `MatchLevel`, `verbatimLevel`, `hasGlobSpecial`.
3. RED — `wildcard.test.ts`, describe "compileWildcard" over `compileWildcard(body).test(path)`:
   "src/*.ts": "src/a/b.ts" true, "src/x.ts" true, "y.ts" false · "foo*": "foo1" true,
   "dir/foobar" false · "[a-c].txt": "a.txt" true, "d.txt" false · "[!a].txt" and "[^a].txt":
   "b.txt" true, "a.txt" false · "[[:digit:]].txt": "1.txt" true · "[/a]*": "a/b" true, "x" false ·
   "a\\*b": "a*b" true, "aXb" false · "a\\?b": "a?b" true, "axb" false · "a\\b": "a\\b" true,
   "ab" true · "a?": "a?/f" true, "ab" true · "di?": "dir/file" false · "**/x.txt": "d/x.txt"
   true, "x.txt" false · "[]a]": "]" true, "a" true, "b" false · "?.txt": "é.txt" false ·
   "??.txt": "é.txt" true · "d*/": "dir/f" false · "a[": "a[" true, "ab" false · escape-view
   paths "a" followed by the escape of byte 0xff, "aé", "ab": "a?" → [true,false,true]; "a??" →
   [false,true,false]; "a[^b]" → [true,false,false]; "a[[:alpha:]]" → [false,false,true]; "a*" →
   all true. Fails: `compileWildcard` is not exported.
   GREEN — add `compileWildcard`.
4. RED — `pathspec-glob-dialect-interop.test.ts` (create): `add` rows D2, D3, D5a–D5e, D9, D11,
   D11b, D12, D16 (git vs tsgit `ls-files -s`); E4 and G3 through tsgit `grep`; E5 and C6 through
   tsgit `checkout`; R2, R4, R5, R6 through tsgit `rm`; L1–L3, L5, L6 as described in Context;
   the Linux-only lossy `add` row. They fail today because `compileOne` still uses `compileGlob`
   (D16 is even refused, read as a missing literal). GUARD rows in the same tables: D1, D4, D8a,
   D13, D14, E3, G1, G2, G4, G5, L4, R3 — run them now; each must pass before the GREEN (a GUARD
   that fails is a RED).
   GREEN — rewrite `compileOne` to the target shape; delete `compileLiteral`/`compileDirectory`
   and the `compileGlob`/`containsGlob` import (`containsGlob` stays exported until Part 4).
5. REFACTOR — rewrite the header comment of compile-pathspec.ts (lines 28-36: drop the anchoring
   and RegExp story; say verbatim first, then git's wildmatch over the path's bytes; name no ADR);
   update the `isLiteral` doc (`* ? [ \`). Gate.

### Gate

```bash
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/unit/domain/refs test/unit/domain/pathspec test/unit/application/commands/add.test.ts test/unit/application/commands/rm.test.ts test/unit/application/commands/checkout.test.ts test/unit/application/commands/grep.test.ts test/unit/application/primitives/snapshot test/unit/adapters/snapshot-resolvers test/integration/pathspec-glob-dialect-interop.test.ts test/integration/glob-double-star-interop.test.ts test/integration/add-interop.test.ts test/integration/rm-interop.test.ts test/integration/grep-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/domain/refs/ref-glob.ts test/unit/domain/refs/ref-glob.test.ts src/domain/pathspec/wildcard.ts test/unit/domain/pathspec/wildcard.test.ts src/domain/pathspec/compile-pathspec.ts test/integration/pathspec-glob-dialect-interop.test.ts \
  && npm run check:spelling && npm run check:test-pyramid; echo "gate exit=$?"
```

Run after the last edit; the printed exit code must be 0. Wireit caveat: `npm run check:types` /
`check:spelling` can print `Ran 0 scripts and skipped 1` on a cached result — the bare oracles are
`npx tsc --noEmit -p tsconfig.json` and `npx cspell --no-progress <touched-files>`.

### Commit

`fix(pathspec): match wildcards with git's wildmatch over the path's bytes`

## Part 2 — Allocation-free wildcard fast paths and the pathspec property suite

### Context
**Status: landed as e36108bb.** Its file paths below are plain text: the part is history, not a pending unit of work.


Files this part creates or edits (exactly these):
- src/domain/pathspec/wildcard.ts — fast paths inside `compileWildcard` (created by Part 1; a
  module new to this run, so the two parts share no pre-existing file).
- test/unit/domain/pathspec/wildcard.test.ts — rows for the shape classifier and evaluator.
- test/unit/domain/pathspec/compile-pathspec.test.ts — `isLiteral` and dialect rows through
  `compilePathspec`, and the two retitles. This part is the file's only editor in the run.
- test/unit/domain/pathspec/compile-pathspec.properties.test.ts — extended.
- test/unit/domain/pathspec/arbitraries.ts — new generators.

Read-only references: src/domain/pathspec/compile-pathspec.ts (Part 1's `compileOne`),
src/domain/refs/ref-glob.ts (`compileRefGlobBytes`, Part 1), src/domain/objects/encoding.ts
(`encodeEscaped`), .claude/workflow/property-testing.md (lenses, `numRuns` tiers: 200 cheap
round-trip, 100 invariant/composition, 50 filter-heavy; generators live in arbitraries.ts; never
commit a seed), test/unit/domain/pathspec/match-pathspec.properties.test.ts (style).

State after Part 1: `compileWildcard(body).test(p) = verbatimLevel(body, p) !== NONE ||
wild(encodeEscaped(p))` — it encodes every tested path.

Target (all internal, not barrelled; decision candidate 2, option A):

    export type WildcardShape =
      | { readonly kind: 'one-star'; readonly prefix: string; readonly suffix: string }
      | { readonly kind: 'general'; readonly literalPrefix: string };
    export const wildcardShape = (body: string): WildcardShape
      // one-star: exactly one '*' and no other of * ? [ \ ; general: literalPrefix = body up to
      // the first glob-special character
    export const oneStarMatches = (prefix: string, suffix: string, path: string): boolean
      // path.startsWith(prefix) && path.endsWith(suffix) && path.length >= prefix.length + suffix.length
    // compileWildcard, after the verbatim check (shape computed once per body):
    //   one-star → oneStarMatches(...)            (no encoding)
    //   general  → !path.startsWith(literalPrefix) ? false : wild(encodeEscaped(path))

Why the string compares equal the byte DP (the property suite proves it; ADR-1033 admits a fast
path only on that condition): prefix and suffix are well-formed strings, so they start and end on
code-point boundaries; the escape view decodes every valid UTF-8 sequence to its character and
every invalid byte to one lone low surrogate, so string prefix/suffix relations and the
non-overlap length test coincide with the byte relations.

Property lenses (name them in each describe): totality (lens 3) — `compilePathspec` over arbitrary
bodies drawn from letters, "/", `é`, `*`, `?`, `[`, `]`, a backslash, `!`, `^`, `-`, `:` returns
one entry per input whose `test` returns a boolean for arbitrary escape-view paths (letters, "/",
`é`, `\uDC80` and the escape of byte 0xff), numRuns 100; fast path ≡ DP (oracle delegated to the
independently tested `compileRefGlobBytes` + `verbatimLevel`, not a copy of the production loop)
— for arbitrary one-star bodies and arbitrary general bodies, `compiled.test(path) ===
(verbatimLevel(body, path) !== MATCH_LEVEL.NONE || compileRefGlobBytes(body)(encodeEscaped(path)))`,
numRuns 100; verbatim invariant (lens 4) — for every non-empty body not ending in "/",
`test(body)` and `test(body + '/' + segment)` are true, numRuns 100. Generators (`arbGlobBody`,
`arbOneStarBody`, `arbEscapedPath`) go in arbitraries.ts. The existing two properties stay.

House rules: one RED per function, run before its code; GUARD = already passes.
`git diff --no-ext-diff --stat` after scripted edits. Poll, never wait. Commit only these files.
No provenance ids in code. No suppression directives — a dispatch mutant that survives is triaged
at validation (candidate 2).

Re-pinning rule: When an existing test row breaks, decide whether the OLD expectation encoded the
contract. If it did, fix the code, not the row, and say so. A changed row is re-pinned against real
git 2.55 (or the design's matrix row id), never rewritten to match the new code.
Rows the design names: compile-pathspec.test.ts "Given a glob \"*.ts\"" (verdicts unchanged —
D1; "non-anchored" is now false wording) and "Given an anchored glob \"src/**\"" (verdicts
unchanged — D13; "anchored" goes) — GUARDs retitled in REFACTOR.

### TDD steps

1. GUARD — `compile-pathspec.test.ts`: `isLiteral` false for "a[", "a\\", "[]a]", "a\\b", true for
   "src/foo.ts"; `compilePathspec(["foo*"])[0].compiled.test("dir/foobar")` false and
   `compilePathspec(["src/*.ts"])[0].compiled.test("src/a/b.ts")` true (Part 1 made these pass —
   run to confirm).
2. RED — `wildcard.test.ts`, describes "wildcardShape" ("*.ts" → one-star "" / ".ts"; "src/*.ts"
   → one-star "src/" / ".ts"; "foo*" → one-star "foo" / ""; "a*b*" → general "a"; "src/[ab]*" →
   general "src/"; "a\\*" → general "a") and "oneStarMatches" ("", ".ts", ".ts" true; "a", "a",
   "a" false (overlap); "src/", ".ts", "src/a/b.ts" true; "src/", ".ts", "lib/x.ts" false; "a", "",
   "a" followed by the escape of byte 0xff true). Fails: not exported.
   GREEN — add both (pure, no wiring yet).
3. GUARD — `compile-pathspec.properties.test.ts`: the three properties of Context, written and run
   against the Part 1 code (no fast path wired: they hold by construction). Generators in
   `arbitraries.ts`.
4. REFACTOR — wire the shape into `compileWildcard`; re-run the properties and every pathspec row:
   all green. Retitle the two named rows.

### Gate

```bash
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/unit/domain/pathspec test/unit/domain/refs test/unit/application/commands/add.test.ts test/unit/application/commands/rm.test.ts test/unit/application/commands/checkout.test.ts test/unit/application/commands/grep.test.ts test/integration/pathspec-glob-dialect-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/domain/pathspec/wildcard.ts test/unit/domain/pathspec/wildcard.test.ts test/unit/domain/pathspec/compile-pathspec.test.ts test/unit/domain/pathspec/compile-pathspec.properties.test.ts test/unit/domain/pathspec/arbitraries.ts \
  && npm run check:spelling; echo "gate exit=$?"
```

Run after the last edit; exit code must be 0. Wireit caveat: `check:types` / `check:spelling` can
print `Ran 0 scripts and skipped 1` on a cached result — bare oracles: `npx tsc --noEmit -p
tsconfig.json`, `npx cspell --no-progress <touched-files>`.

### Commit

`fix(pathspec): match one-star and literal-prefix wildcards without encoding the path`

## Part 3 — describe and name-rev patterns use git's wildmatch dialect

### Context
**Status: landed as 6d5c93bf.** Its file paths below are plain text: the part is history, not a pending unit of work.


Files this part creates or edits (exactly these):
- src/domain/describe/match.ts — flags-0 matcher on the short tag name.
- test/unit/domain/describe/match.test.ts
- test/integration/describe-interop.test.ts — DS rows.
- src/domain/name-rev/ref-pattern.ts — every-suffix matching, compile once, `abbreviates`.
- test/unit/domain/name-rev/ref-pattern.test.ts

Every N interop row (name-rev-interop.test.ts) lands in Part 11, the run's only editor of that
file: most N rows need the `abbreviated` field Part 11 adds, and one owner keeps the twin
fixtures in one place. This part proves its filter with unit rows.

Read-only references: src/domain/refs/ref-glob.ts (`compileRefGlob`), src/application/commands/
describe.ts (`buildNameFilter` caller at :193, `describeContains` at :113 maps patterns to
refs/tags/<pat>), src/application/commands/internal/describe-options.ts (`match`, `exclude`:
string or array), src/application/commands/name-rev.ts (`buildRefFilter` caller at :92 —
`filter.qualifies` only, unchanged here), src/application/commands/internal/name-rev-options.ts
(`refs`, `exclude`, `tags`), test/unit/domain/describe/match.properties.test.ts (GUARD, unchanged).

Current code:
- describe/match.ts: `anchored = (p) => compileGlob(p, { anchored: true })`; `buildNameFilter(include,
  exclude): NameFilter { matches(name) }` (include any-of, exclude wins); `tagNameMatches`.
- name-rev/ref-pattern.ts: `RefFilter { qualifies(ref) }`; `buildRefFilter({ tags, refs, exclude })`
  tests `matchRefGlob(pattern, ref)` on the FULL ref, recompiling per ref; HEAD never qualifies;
  `tags` gate = starts with "refs/tags/".

Target:
- describe/match.ts: include/exclude matchers = `compileRefGlob` (flags 0, `*`/`?` cross "/",
  `[…]`, `\x`); logic unchanged; drop the `compileGlob` import (Part 4 depends on this).
- ref-pattern.ts (internal; `RefFilter` is not barrelled; `buildRefFilter` is exported from
  src/domain/name-rev/index.ts, which no public entry re-exports):

      export interface RefFilter { qualifies(ref: string): boolean; abbreviates(ref: string): boolean }
      // git's subpath_matches: the first offset (0, then after each '/') whose suffix matches
      const subpathOffset = (matches: (text: string) => boolean, ref: string): number | undefined
      // buildRefFilter compiles every include/exclude ONCE with compileRefGlob
      // qualifies: HEAD → false; tags gate; any exclude with an offset → false;
      //            includes empty or any include with an offset → true
      // abbreviates: some include whose FIRST matching offset is > 0 (fact 5)

  Leave `matchRefGlob` exported in ref-glob.ts (its contract is kept; tests use it).

Matrix rows: DS2–DS7, DS14 flip; DS1, DS8–DS13 GUARD. The N rows this filter flips (N7, N8,
N10, N11, N12) are pinned at command level in Part 11.

Fixtures: DS — `v1.0` annotated + `w2` lightweight on c1, "v1/rc1" annotated on c2, HEAD c3; git
side `describe --tags --abbrev=0 [opts]` (DS14: no `--tags`); compare the tag name tsgit reports
(read DescribeResult in describe.ts) or the refusal (git 128 `fatal: No names found, cannot
describe anything.` ↔ tsgit's no-names error code, read `noNames` in describe.ts).

Environment: git 2.55.0 first on PATH for interop: `PATH="$HOME/.local/git-2.55.0/bin:$PATH"`.

House rules: one RED per function, run before its code; GUARD = already passes. `git diff --no-ext-diff --stat`
after scripted edits. Poll, never wait. Commit only these files. No provenance ids in code. Rewrite
the stale headers (describe/match.ts:1-6 says "anchored compileGlob … no character classes";
ref-pattern.ts:1-8 says "matches the full refname") without naming ADRs.

Re-pinning rule: When an existing test row breaks, decide whether the OLD expectation encoded the
contract. If it did, fix the code, not the row, and say so. A changed row is re-pinned against real
git 2.55 (or the design's matrix row id), never rewritten to match the new code.
Row the design names: match.test.ts "* does not cross the slash" ("release/v1" with `release*` →
false) is re-pinned to true (DS2: `--match 'v*'` names "v1/rc1").

### TDD steps

1. RED — `match.test.ts`: re-pin the slash row; add "v1.0" with "v[0-9].*" true, "v1/rc1" with
   "v1?rc1" true, "v1.0" with "v1\\.*" true, "v1/rc1" with "v1\\/*" true, "v1.0" with "[v]1.0"
   true; GUARDs "v1.0" with "v1[" false and "v1.0" with "v1\\" false (no match today either).
   In the same step, `describe-interop.test.ts`: the DS1–DS14 table (DS2–DS7, DS14 red today;
   DS1, DS8–DS13 GUARDs). Run: the flips fail because `compileGlob` keeps `*` inside a segment
   and reads `[`/`\` verbatim.
   GREEN — switch describe/match.ts to `compileRefGlob`.
2. RED — `ref-pattern.test.ts`: include through a suffix — refs ["v*"] qualifies
   "refs/tags/v1.0"; ["tags/*"] qualifies it; ["main"] qualifies "refs/heads/main"; GUARD
   ["ags/v1.0"] does not; exclude through a suffix — exclude ["tags/*"] drops "refs/tags/v1.0";
   exclude ["v*"] drops it. Fails: only the full ref is matched.
   GREEN — `subpathOffset` + compile-once in `buildRefFilter`.
3. RED — `ref-pattern.test.ts`, "abbreviates": ["v*"] → true for "refs/tags/v1.0";
   ["refs/tags/*"] → false; ["refs/tags/v*", "v1.*"] → true; ["*1.0"] → false (first offset 0);
   no includes → false. Fails: the method does not exist.
   GREEN — add `abbreviates`.
4. REFACTOR — rewrite both stale headers; gate.

### Gate

```bash
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/unit/domain/describe test/unit/domain/name-rev test/unit/application/commands/describe.test.ts test/unit/application/commands/describe.properties.test.ts test/unit/application/commands/name-rev.test.ts test/unit/application/commands/name-rev-tip-table.test.ts test/unit/application/commands/name-rev-skip.test.ts test/integration/describe-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/domain/describe/match.ts test/unit/domain/describe/match.test.ts test/integration/describe-interop.test.ts src/domain/name-rev/ref-pattern.ts test/unit/domain/name-rev/ref-pattern.test.ts \
  && npm run check:spelling; echo "gate exit=$?"
```

Run after the last edit; exit code must be 0. Wireit caveat: `check:types` / `check:spelling` can
print `Ran 0 scripts and skipped 1` on a cached result — bare oracles: `npx tsc --noEmit -p
tsconfig.json`, `npx cspell --no-progress <touched-files>`.

### Commit

`fix(describe): match tag and ref patterns as git's wildmatch does, on every ref suffix`

## Part 4 — compileGlob keeps only the gitignore dialect

### Context
**Status: landed as bfb299eb.** Its file paths below are plain text: the part is history, not a pending unit of work.


Files this part creates or edits (exactly these):
- src/domain/pathspec/compile-glob.ts — remove the dead mode.
- test/unit/domain/pathspec/compile-glob.test.ts — drop the removed mode's rows and `containsGlob`.
- test/unit/domain/pathspec/compile-glob.properties.test.ts — CREATED (property sibling).
- src/domain/ignore/parse-gitignore.ts — line 101 drops `pathname: true`.
- src/domain/attributes/parse-gitattributes.ts — line 125 drops `pathname: true`.
- src/domain/sparse/non-cone.ts — line ~29 drops `pathname: true`.

Read-only references: test/unit/domain/pathspec/arbitraries.ts (`arbLiteralPattern`,
`arbCandidatePath`), test/perf/domain/pathspec/compile-glob.perf.test.ts (uses
`{ anchored: true }` only — still compiles), .claude/workflow/property-testing.md,
test/integration/glob-double-star-interop.test.ts (must stay green unchanged — R9).

Precondition (verify with grep before editing): after Parts 1 and 3 no caller passes a
`compileGlob` options object without `pathname: true`:
`grep -rn "compileGlob(" src` lists only parse-gitignore.ts, parse-gitattributes.ts, non-cone.ts.

Current compile-glob.ts: `CompileGlobOptions { anchored; withDirSuffix?; pathname? }`;
`scanToken(pattern, i, options)` dispatches `*` to `scanPathnameStar` when `options.pathname === true`
else `scanStar`; `tokenize(pattern, options)`; `containsGlob` exported; header says it serves
`compilePathspec` and "[abc] NOT supported in v1". Six `Stryker disable next-line` equivalence
lines (:122, :131, :143, :154, :166, :199) — keep them byte-identical.

Target (ADR-1041): `CompileGlobOptions { anchored; withDirSuffix? }`; `scanToken(pattern, i)` sends
every `*` to `scanPathnameStar`; delete `scanStar` and `containsGlob`; `tokenize(pattern)`. Header:
the gitignore-family dialect (gitignore, gitattributes, non-cone sparse) = git's WM_PATHNAME star
rule; `[…]` and `\` are matched verbatim in this dialect; no mention of pathspecs or "v1". The
exported names `compileGlob`, `GlobMatcher`, `CompileGlobOptions` stay (src/domain/pathspec/index.ts
barrel unchanged; internal).

Test file: the regex oracle loses `oracleStar` and the `pathname` branch (always
`oraclePathnameStar`); `arbOptions` loses `pathname`. The `pathname` const block loses its
`pathname: true` and is retitled "Given the gitignore dialect". Rows set without `pathname`
whose verdict depended on the removed star mode fail once the mode goes — they are the removed
mode's own rows and are deleted with it (ADR-1041), not re-pinned; rows that still pass stay. Expect
"Given a `**` NOT followed by "/"" and "Given a `***` run" among them; let the run decide. Delete the
`containsGlob` describe.

Property sibling (lenses): totality (lens 3) — for arbitrary printable-ASCII, NUL-free patterns and
options `{ anchored, withDirSuffix }`, `compileGlob(...).test(path)` returns a boolean for arbitrary
paths, numRuns 100; self-match (lens 2 identity) — a special-free pattern (segments from
`arbLiteralPattern` joined by "/") under `{ anchored: true }` matches exactly itself and rejects
itself + "x", numRuns 100.

House rules: GUARD = already passes; this part has no new behaviour, so it is GUARD + REFACTOR.
`git diff --no-ext-diff --stat` after scripted edits. Commit only these files. No provenance ids in code.

Re-pinning rule: When an existing test row breaks, decide whether the OLD expectation encoded the
contract. If it did, fix the code, not the row, and say so. A changed row is re-pinned against real
git 2.55 (or the design's matrix row id), never rewritten to match the new code. Exception named by
ADR-1041: rows of the removed non-gitignore star mode are deleted with the mode.

### TDD steps

1. GUARD — create `compile-glob.properties.test.ts` with the two properties; they pass on the
   current code (pathname mode already behaves so).
2. REFACTOR — remove `pathname` from the three callers and the options type, route every `*` to
   `scanPathnameStar`, delete `scanStar` and `containsGlob`; update the oracle, delete the failing
   removed-mode rows and the `containsGlob` describe; retitle; rewrite the header. Every
   gitignore/attributes/sparse suite stays green unchanged.

### Gate

```bash
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/unit/domain/pathspec test/unit/domain/ignore test/unit/domain/attributes test/unit/domain/sparse test/integration/glob-double-star-interop.test.ts \
  && npx vitest run --config vitest.perf.config.ts test/perf/domain/pathspec/compile-glob.perf.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/domain/pathspec/compile-glob.ts test/unit/domain/pathspec/compile-glob.test.ts test/unit/domain/pathspec/compile-glob.properties.test.ts src/domain/ignore/parse-gitignore.ts src/domain/attributes/parse-gitattributes.ts src/domain/sparse/non-cone.ts \
  && npm run check:spelling; echo "gate exit=$?"
```

Run after the last edit; exit code must be 0. Wireit caveat: `check:types` / `check:spelling` can
print `Ran 0 scripts and skipped 1` on a cached result — bare oracles: `npx tsc --noEmit -p
tsconfig.json`, `npx cspell --no-progress <touched-files>`. If a listed test directory does not
exist, drop it from the command (do not invent files).

### Commit

`fix(pathspec): keep only the gitignore dialect in compileGlob`

## Part 5 — One command pathspec intake: positives in argument order, unmatched helper

### Context
**Status: landed as 313eacae.** Its file paths below are plain text: the part is history, not a pending unit of work.


Files this part creates or edits (exactly these):
- src/application/commands/internal/pathspec-intake.ts — CREATED: the intake every command uses.
- test/unit/application/commands/internal/pathspec-intake.test.ts — CREATED.
- src/application/commands/grep.ts — switch its one `resolvePathspec` call (:198) to the intake.
- test/unit/application/commands/checkout-switch-target.test.ts — shape assertion at :57.
- test/unit/application/commands/switch-and-tag-target-dwim.test.ts — shape assertion at :168.
- test/integration/pathspec-dot-interop.test.ts — shape assertions at :115 and :169.

Why a new module instead of new `ResolvedPathspec` fields: src/application/commands/internal/
resolve-pathspec.ts then has exactly one editor in the run (Part 10, which relaxes its validator and
deletes the helpers this run retires), and the host policy enters through one function that every
command already calls from its own part (rm 6, add 7, checkout 8, grep here) — Part 10 changes no
command file.

Why the shape edits live here: Part 8 adds `patterns` to `PATHSPEC_NO_MATCH`, which breaks every
`toEqual({ code: 'PATHSPEC_NO_MATCH', pattern })`. Each single-pattern assertion is rewritten to
`toEqual(pathspecNoMatch(<same pattern>).data)` (import from src/domain/commands/error.ts) —
identical today, still exact once the factory fills `patterns`. Parts 6, 7, 8 convert the rows in
the files they own (rm.test.ts, add.test.ts, add-directory-file.test.ts, checkout.test.ts).

Read-only references: src/application/commands/internal/resolve-pathspec.ts
(`resolvePathspec(patterns): ResolvedPathspec { matcher, literalMustMatch, literalSpellings,
hasGlob, symlinkScanTargets }`; `matcher` is index-aligned with the input patterns; whole tree =
body `''`), src/domain/objects/encoding.ts (`wellFormed`), src/domain/pathspec/compile-pathspec.ts
(`PathspecEntry`), src/domain/commands/error.ts (`pathspecOutsideRepo(path)`), src/ports/context.ts
(`Context.windowsPathSyntax?: boolean` at :358 — "the filesystem reads paths the Windows way";
set by the node adapter on Windows, src/adapters/node/node-adapter.ts:155; absent on memory and
browser), src/application/primitives/internal/git-path-syntax.ts:98 and index-path-rules.ts:8
(how primitives read the flag: they take `ctx` structurally as `{ readonly windowsPathSyntax?:
boolean }` — follow the same shape).

Target (internal; not barrelled):

    export interface PathspecHost { readonly windowsPathSyntax?: boolean }   // a Context satisfies it
    export interface PositivePathspec {
      readonly entry: PathspecEntry;
      readonly spelling: string;      // the well-formed raw pattern as typed ('./d', '.', 'nomatch*')
      readonly probesDisk: boolean;   // false for a body holding a backslash (ADR-1044: matching only)
    }
    export interface CommandPathspec extends ResolvedPathspec {
      readonly positives: ReadonlyArray<PositivePathspec>;   // non-negated, argument order, duplicates kept
    }
    export const resolveCommandPathspec = (host: PathspecHost, paths: ReadonlyArray<string>): CommandPathspec
      // 1. under host.windowsPathSyntax === true: the first pattern whose body (leading '!'
      //    stripped) holds a backslash → throw pathspecOutsideRepo(body)  — git for Windows reads
      //    '\' as a separator; tsgit keeps refusing it there (ADR-1044)
      // 2. resolvePathspec(paths), then positives from matcher + wellFormed(paths[i])
    export const unmatchedPositives = (
      positives: ReadonlyArray<PositivePathspec>,
      isSeen: (positive: PositivePathspec) => boolean,
    ): ReadonlyArray<PositivePathspec>   // argument order

Step 1 runs before `resolvePathspec`, so on a Windows host the intake — not the general validator —
is what refuses a backslash; today the general validator also refuses it on every host (Part 10
relaxes that for POSIX). The refusal data stays `{ code: 'PATHSPEC_OUTSIDE_REPO', path }`.

House rules: one RED per function, run before its code; GUARD = already passes.
`git diff --no-ext-diff --stat` after scripted edits. Poll, never wait. Commit only these files.
No provenance ids in code.

Re-pinning rule: When an existing test row breaks, decide whether the OLD expectation encoded the
contract. If it did, fix the code, not the row, and say so. A changed row is re-pinned against real
git 2.55 (or the design's matrix row id), never rewritten to match the new code. No row is expected
to change: grep's behaviour is identical through the intake (G rows stay green).

### TDD steps

1. RED — `pathspec-intake.test.ts`, "positives": `resolveCommandPathspec({}, ['src/foo', '*.ts',
   '!*.test.ts', './d', 'src/foo'])` → spellings `['src/foo', '*.ts', './d', 'src/foo']`, bodies
   `['src/foo', '*.ts', 'd', 'src/foo']`, every `probesDisk` true; `['.']` → one positive, body `''`,
   spelling `.`; `['!x']` → none; the other `ResolvedPathspec` fields equal `resolvePathspec`'s.
   Fails: the module does not exist. GREEN — create it (steps 1–2 of the target, no host check yet).
2. RED — "probesDisk": the positive built from the entry `compilePathspec(['a\\*b'])[0]` (call the
   exported builder directly — the intake still refuses a backslash on every host until Part 10)
   has `probesDisk` false. Export the per-entry builder (`positiveOf(entry, spelling)`) for this.
   Fails: always true. GREEN — `probesDisk = !entry.body.includes('\\')`.
3. GUARD — "Windows host": `resolveCommandPathspec({ windowsPathSyntax: true }, ['ok', '!a\\b'])`
   throws PATHSPEC_OUTSIDE_REPO with `path: 'a\\b'`; a backslash-free spec resolves. It passes
   today through the general validator (collapsePattern refuses every backslash before the budget
   check). REFACTOR under this GUARD: add the host check (target step 1) so the Windows refusal is
   the intake's own; it becomes the only refusal once Part 10 relaxes the general validator, and
   Part 10's POSIX-accept rows are the RED that make it observable (until then its mutants are
   equivalent — say so in the part report, add no suppression).
4. RED — "unmatchedPositives": three positives, `isSeen` true for the second → first and third in
   order; all seen → empty. Fails: not exported. GREEN — add it.
5. GUARD — grep.ts calls `resolveCommandPathspec(ctx, opts.paths)`; the grep suite and G interop
   rows stay green. Convert the three shape assertions to `pathspecNoMatch(…).data`; green.

### Gate

```bash
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/unit/application/commands/internal/pathspec-intake.test.ts test/unit/application/commands/internal/resolve-pathspec.test.ts test/unit/application/commands/grep.test.ts test/unit/application/commands/checkout-switch-target.test.ts test/unit/application/commands/switch-and-tag-target-dwim.test.ts test/integration/pathspec-dot-interop.test.ts test/integration/grep-interop.test.ts test/integration/pathspec-glob-dialect-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/commands/internal/pathspec-intake.ts test/unit/application/commands/internal/pathspec-intake.test.ts src/application/commands/grep.ts test/unit/application/commands/checkout-switch-target.test.ts test/unit/application/commands/switch-and-tag-target-dwim.test.ts test/integration/pathspec-dot-interop.test.ts \
  && npm run check:spelling; echo "gate exit=$?"
```

Run after the last edit; exit code must be 0. Wireit caveat: `check:types` / `check:spelling` can
print `Ran 0 scripts and skipped 1` on a cached result — bare oracles: `npx tsc --noEmit -p
tsconfig.json`, `npx cspell --no-progress <touched-files>`.

### Commit

`fix(pathspec): resolve command pathspecs through one intake that keeps positives in argument order`

## Part 6 — rm refuses by match level

### Context
**Status: landed as 165fafac.** Its file paths below are plain text: the part is history, not a pending unit of work.


Files this part creates or edits (exactly these):
- src/application/commands/rm.ts
- test/unit/application/commands/rm.test.ts — this part is its only editor in the run (it also
  converts the shape row at :125, see Part 5).
- src/domain/pathspec/match-pathspec.ts — `pathspecMatchLevel`.
- test/unit/domain/pathspec/match-pathspec.test.ts
- test/integration/pathspec-glob-dialect-interop.test.ts — extend with the R refusal rows
  (created by Part 1; a file new to this run).

Read-only references: src/application/commands/internal/pathspec-intake.ts
(`resolveCommandPathspec(ctx, paths)`, `positives`), src/domain/pathspec/wildcard.ts
(`MATCH_LEVEL`: NONE 0 < RECURSIVE 1 < FNMATCH 2 < EXACT 3, `verbatimLevel`),
src/domain/git-index/index-path-key.ts (`escapedPathOf`), src/domain/commands/error.ts
(`pathspecNoMatch`, `rmRecursiveWithoutR(pattern)`), src/domain/pathspec/compile-pathspec.ts
(`PathspecEntry`).

Current rm.ts (:72): `resolvePathspec(paths)` → `{ matcher, literalSpellings }`; lock; read index
(tolerating `isIndexMissingCode`); `groupByPath`; removal set by `matchesIndexPath(matcher,
first)`; `enforceLiteralMatches(literalSpellings, removed, reach)` (:~176, literals only:
no-match, then `rmRecursiveWithoutR(spelled)` when the literal did not name a path itself); then
the safety valve and removals.

Target (ADR-1042, fact 6):

    // match-pathspec.ts (internal)
    export const pathspecMatchLevel = (entry: PathspecEntry, path: FilePath): MatchLevel
      // verbatimLevel(entry.body, path) if not NONE; else FNMATCH if entry.compiled.test(path);
      // else NONE. matchesPathspec, withoutExactly, matchesUnmergedPath keep their code (ADR-1000).
    // rm.ts: resolveCommandPathspec(ctx, paths); replace enforceLiteralMatches with, at the same
    // point (before enforceSafetyValve and any removeFile), in argument order:
    for p of positives:
      level = max over byPath groups of pathspecMatchLevel(p.entry, escapedPathOf(first stage))
      level === NONE                       → throw pathspecNoMatch(p.spelling)
      level === RECURSIVE && !recursive    → throw rmRecursiveWithoutR(p.spelling)

The whole tree (`.`, body `''`) is RECURSIVE for every path, so `rm .` without `recursive` still
refuses naming `.` and an empty index refuses it as unmatched (rows at rm.test.ts:136-156 stay
GUARDs). rm no longer calls `enforceLiteralMustMatch`; Part 10 deletes it once Parts 7 and 8 drop
the other callers.

Matrix rows: R1, R1b, R4b, R7, R8 flip; R4c, R2–R6 GUARD (R2–R6 landed in Part 1; R4 stays green
because FNMATCH outranks RECURSIVE), K3 GUARD (rm already locks first). ADR-1012 (resolve-undo,
pending operations) is untouched — its rows in rm.test.ts are GUARDs. Interop asserts git's 128 +
`fatal: pathspec '<p>' did not match any files` or `fatal: not removing '<p>' recursively without
-r`, the index, and that the working-tree file still exists (R1).

Environment: git 2.55.0 first on PATH for interop: `PATH="$HOME/.local/git-2.55.0/bin:$PATH"`.

Windows: no file name there can hold `*`, `?`, `:` or a backslash, so every interop row whose
FIXTURE creates such a name (R4b's `a?/f`) sits under
`describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')`; the unit rows (memory adapter)
cover those shapes on every OS.

House rules: one RED per function, run before its code; GUARD = already passes.
`git diff --no-ext-diff --stat` after scripted edits. Poll, never wait. Commit only these files.
No provenance ids in code.

Re-pinning rule: When an existing test row breaks, decide whether the OLD expectation encoded the
contract. If it did, fix the code, not the row, and say so. A changed row is re-pinned against real
git 2.55 (or the design's matrix row id), never rewritten to match the new code.
Rows that change here: rm.test.ts:405 "Given a glob \"*.nope\" with no matches" (`removed: []`) →
refuses PATHSPEC_NO_MATCH '*.nope' (R7/R8 shape); :455 and :474 (corrupt index tolerated, `*.nope`
→ `removed: []`) and :505 (readIndex racing to FILE_NOT_FOUND) → now throw PATHSPEC_NO_MATCH
'*.nope' — the tolerance they exist to prove still shows (the parse error does not surface);
:560 (PERMISSION_DENIED propagates) stays a GUARD. :391 "both are removed (no PATHSPEC_NO_MATCH for
globs)" keeps its verdict; only the parenthetical in its title is false — retitle. :125 shape row
→ `toEqual(pathspecNoMatch('./nomatch').data)` (same expectation, Part 8-proof).

### TDD steps

1. RED — `match-pathspec.test.ts`, describe "pathspecMatchLevel": "src" vs "src" EXACT, vs
   "src/a" RECURSIVE; "a?" vs "a?/f" RECURSIVE, vs "ab" FNMATCH, vs "zz" NONE; "d*" vs "dir/f"
   FNMATCH; "" (whole tree) vs "x" RECURSIVE; "!src" negated entry vs "src" EXACT (the level ignores
   negation — callers pass positives). Fails: not exported. GREEN — add it.
2. RED — rm.test.ts R1: `rm(ctx, ['nomatch*', 'tracked.txt'])` throws PATHSPEC_NO_MATCH
   'nomatch*', `tracked.txt` stays in the index and on disk; R1b with the order swapped, same.
   Re-pin :405, :455, :474, :505 here. Interop R1, R1b, R7, R8. Fails: globs never refuse.
   GREEN — intake + per-positive levels, NONE branch.
3. RED — R4b: index `a?/f`, `zz`, `rm(ctx, ['a?'])` → RM_RECURSIVE_WITHOUT_R 'a?', nothing removed;
   with `recursive: true` removes `a?/f`. Interop R4b (R4c GUARD). Fails: the `-r` check covers
   literals only. GREEN — RECURSIVE branch; delete `enforceLiteralMatches`.
4. REFACTOR — convert :125; retitle :391. Gate.

### Gate

```bash
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/unit/application/commands/rm.test.ts test/unit/domain/pathspec test/unit/application/commands/internal test/integration/pathspec-glob-dialect-interop.test.ts test/integration/rm-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/commands/rm.ts test/unit/application/commands/rm.test.ts src/domain/pathspec/match-pathspec.ts test/unit/domain/pathspec/match-pathspec.test.ts test/integration/pathspec-glob-dialect-interop.test.ts \
  && npm run check:spelling; echo "gate exit=$?"
```

Run after the last edit; exit code must be 0. Wireit caveat: `check:types` / `check:spelling` can
print `Ran 0 scripts and skipped 1` on a cached result — bare oracles: `npx tsc --noEmit -p
tsconfig.json`, `npx cspell --no-progress <touched-files>`.

### Commit

`fix(rm): refuse an unmatched or directory-reaching pathspec by match level`

## Part 7 — add refuses an unmatched pathspec before any object write

### Context
**Status: landed as 830924e8.** Its file paths below are plain text: the part is history, not a pending unit of work.


Files this part creates or edits (exactly these):
- src/application/commands/add.ts
- test/unit/application/commands/add.test.ts
- test/unit/application/commands/add-directory-file.test.ts — the shape assertion at :1064 only.
- test/integration/pathspec-glob-dialect-interop.test.ts — extend with the B, D7/D8c/D10, RN, K2
  rows (created by Part 1; a file new to this run).

Read-only references: src/application/commands/internal/pathspec-intake.ts
(`resolveCommandPathspec(ctx, paths)`, `positives`, `PositivePathspec { entry, spelling,
probesDisk }`, `unmatchedPositives`), src/application/commands/internal/resolve-pathspec.ts
(`namesWholeTree`, `ResolvedPathspec`), src/domain/pathspec/match-pathspec.ts
(`pathspecMatchLevel`, Part 6), src/domain/pathspec/wildcard.ts (`MATCH_LEVEL`),
src/domain/git-index/index-path-key.ts (`escapedPathOf`), src/domain/commands/error.ts
(`pathspecNoMatch(pattern)`), src/application/primitives/walk-working-tree.ts (`walkWorkingTree`
yields `WalkWorkingTreeEntry { path, … }`).

Current add.ts anchors (unchanged by Parts 1–6):
- `dispatchPathspec` :218 — `hasGlob` or a missing/directory literal → `addByPathspec`; else
  `addLiteralOnly` (every literal is an existing file; no refusal needed there, unchanged).
- `addByPathspec` :720 — `buildRepoIgnorePredicate`, `acquireIndexLock`, then
  `stageIgnoredWalk(ctx, repoIgnore, matcher, scope, guard)` which hashes and writes blobs, then
  `enforceLiteralMustMatch(mustMatch, [...matched, ...settled.everyRemoval], literalSpellings)` at
  :748 — the refusal comes after the writes (B1/B2 leave loose blobs).
- `stageIgnoredWalk` :883 — `readExistingEntries(ctx)` (:1174, gives `sorted`: every index entry,
  one per stage), `withPathspec(repoIgnore, matcher, unmergedStages)`, then
  `stageWalkedEntries(ctx, walkWorkingTree(ctx, { ignore }), …)`.
- `stageWalkedEntries` :622 (also called by `addAll` :1043) takes `walk: AsyncIterable<WalkWorkingTreeEntry>`
  and passes it to `walkedTrackedFirst` :647 (`for await`, buffers everything in a Map first —
  fact 7). `dispatchInCleanOrder` already accepts `AsyncIterable<T> | Iterable<T>`.
- `addRenormalized` :778 — lock, `readIndexOrEmpty`, `renormalizeEntries` (writes blobs), then
  `literalsOnDisk(ctx, literalMustMatch)` :811 + `enforceLiteralMustMatch(mustMatch, onDisk, …)`
  :799; the `Stryker disable next-line MethodExpression` at :797 sits on the `mustMatch` line that
  this part deletes — the mark goes with its line; add no new mark.
- `lstatOrBeneathFile` :573 (a NOT_A_DIRECTORY probe → undefined) and `lstatOrMissing` :592.

Target:
- `stageWalkedEntries` and `walkedTrackedFirst` accept `AsyncIterable<WalkWorkingTreeEntry> |
  Iterable<WalkWorkingTreeEntry>`.
- `dispatchPathspec` (:223) and `addRenormalized` (:783) call `resolveCommandPathspec(ctx, paths)`
  instead of `resolvePathspec(paths)`; `WHOLE_TREE_MATCHER` (:186) keeps `resolvePathspec` (it only
  ever resolves '.').
- `addByPathspec` reads `{ matcher, positives }`; `stageIgnoredWalk` (gains `positives`) reads the
  index, collects the walk into an array, runs the refusal, then stages from the array. Delete the
  post-staging `enforceLiteralMustMatch` and `mustMatch` in `addByPathspec`.
- Refusal for the walk (git's `seen`, ADR-1035/1036, candidate 3 A):

      candidates = positives minus whole-tree bodies (add never refuses '.')
      seen(p) = sorted.some(e => p.entry.compiled.test(escapedPathOf(e)))
             || walked.some(w => p.entry.compiled.test(w.path))
      for p of unmatchedPositives(candidates, seen):            // argument order
        if (!p.entry.isLiteral && p.probesDisk && await lstatOrBeneathFile(ctx, body) !== undefined) continue
        throw pathspecNoMatch(p.spelling)

  (`compiled.test` true ⇔ `pathspecMatchLevel` ≠ NONE; use whichever reads clearer.)
- `addRenormalized`: `{ matcher, positives, symlinkScanTargets }`; after the lock and
  `readIndexOrEmpty`, BEFORE `renormalizeEntries`: seen = index entries only (git runs no directory
  fill under `--renormalize`); an unseen positive whose verbatim body `lstat`s (literal OR wildcard —
  candidate 4 A; RN4, RN5) and whose `probesDisk` is true is accepted; else `pathspecNoMatch(spelling)`. Delete `literalsOnDisk`
  if nothing else calls it.
- The escape probe uses `lstatOrBeneathFile` (a body beneath a regular file is "missing", not a
  NOT_A_DIRECTORY throw). On Windows a name holding `*` or `?` is an invalid name; libuv reports it
  as ENOENT, which the node adapter maps to FILE_NOT_FOUND — if the Windows CI leg shows another
  code, report it as a blocker rather than widening the catch.
- The shape assertions in add.test.ts (:160, :176, :3433, :4025) and add-directory-file.test.ts
  (:1064) become `toEqual(pathspecNoMatch(<pattern>).data)` (see Part 5 for why; Part 8 adds `patterns`).

Matrix rows: B1, B2, B2b, B3, B3x, B3d, B4, B4b, B4c, B9, B10b, B12, B12r (fact 4), B11′ (fact 2),
D7, D8c, D10, RN1, RN2, RN4, RN6 flip; B6, B7, B8, B10, RN3, RN5, K2 GUARD. B3l/B3m are out of scope.
Interop asserts git's exit 128 + stderr `fatal: pathspec '<p>' did not match any files`
reconstructed from `err.data.pattern`, the index (`git ls-files -s`) and the loose-object count
(`.git/objects/??/*`) on both twins. Unit atomicity: the existing `blobExists(ctx, content)` helper
(add.test.ts:2884) is false after the refusal, and `readIndex` is unchanged.

Environment: git 2.55.0 first on PATH for interop: `PATH="$HOME/.local/git-2.55.0/bin:$PATH"`.

Windows: no file name there can hold `*`, `?`, `:` or a backslash, so every interop row whose
FIXTURE creates such a name (not merely a pathspec spelling) sits under
`describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')`; the unit rows (memory adapter)
cover those shapes on every OS.

House rules: one RED per function, run before its code; GUARD = already passes. `git diff --no-ext-diff --stat`
after scripted edits. Poll, never wait. Commit only these files. No provenance ids in code.

Re-pinning rule: When an existing test row breaks, decide whether the OLD expectation encoded the
contract. If it did, fix the code, not the row, and say so. A changed row is re-pinned against real
git 2.55 (or the design's matrix row id), never rewritten to match the new code.
Rows that change here: add.test.ts:1652 "Given a glob with no match" (`add(['*.ts'])` over
README.md → `added: []`) is re-pinned to refuse `PATHSPEC_NO_MATCH` '*.ts' with the index
unchanged (B9 shape); add.test.ts:296 "Given a glob whose magic sits in the leading path
component…" (`add(['li*/x.ts'])` on an empty repo → empty result) is re-pinned to refuse
`PATHSPEC_NO_MATCH` 'li*/x.ts' — its own title records that git 2.55 "falls through to a plain
no-match"; it must still NOT be PATHSPEC_BEYOND_SYMLINK.

### TDD steps

1. RED — add.test.ts: Given `real.txt`, `add(['nomatch*', 'real.txt'])` throws
   PATHSPEC_NO_MATCH naming 'nomatch*', the index stays empty and `blobExists(ctx, <real.txt
   content>)` is false. Fails: today it stages real.txt and writes its blob. Re-pin the two rows
   named in Context in the same step. Add the interop rows B1, B2, B2b, B3, B3x, B3d, B4, B4b,
   B4c, B9, B10b, B12, B12r, D7, D8c, D10 (red today) with B6, B7, B8, B10, K2 as GUARDs; run.
   GREEN — iterable widening, collect-then-refuse in `stageIgnoredWalk`, delete the post-staging
   check.
2. GUARD — add.test.ts: index-only seen (tracked `gone.txt` deleted from disk, `add(['gone*'])`
   stages the deletion, no refusal); B10b order (`add(['n1*', 'missing'])` names 'n1*'); B12
   (`add(['.', 'nomatch*'])` names 'nomatch*'). They pass on step 1's code — run to confirm.
3. RED — B11′: file `nomatch*`, `.gitignore` `nomatch?`, `add(['nomatch*'])` → no error, index
   empty (unit + interop). Fails: step 1 refuses it. GREEN — the verbatim-body `lstat` escape for
   wildcard entries.
4. RED — RN1 `add(['nomatch*'], RENORMALIZE)` on tracked `a.txt` refuses 'nomatch*'; RN2
   `add(['a*', 'nomatch*'], RENORMALIZE)` refuses with the index unchanged and no new blob; RN6
   `untr*` naming only an untracked file refuses (unit + interop). Fails: globs never refuse
   under renormalize. GREEN — move the check before `renormalizeEntries`, index-only seen, on-disk
   escape for any unseen positive. RN3, RN4, RN5 and the existing renormalize refusal rows
   (add.test.ts:3416, :3443) are GUARDs.
5. REFACTOR — convert the five shape assertions; update the `addByPathspec` comment (:715-719) if
   it mentions the old refusal. Gate.

### Gate

```bash
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/unit/application/commands/add.test.ts test/unit/application/commands/add-directory-file.test.ts test/unit/application/commands/add-unmerged.test.ts test/unit/application/commands/add-clean-order.test.ts test/unit/application/commands/add-big-file-threshold.test.ts test/unit/application/commands/internal/resolve-pathspec.test.ts test/integration/pathspec-glob-dialect-interop.test.ts test/integration/add-interop.test.ts test/integration/add-all.test.ts test/integration/add-unmerged-interop.test.ts test/integration/pathspec-dot-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/commands/add.ts test/unit/application/commands/add.test.ts test/unit/application/commands/add-directory-file.test.ts test/integration/pathspec-glob-dialect-interop.test.ts \
  && npm run check:spelling; echo "gate exit=$?"
```

Run after the last edit; exit code must be 0. Wireit caveat: `check:types` / `check:spelling` can
print `Ran 0 scripts and skipped 1` on a cached result — bare oracles: `npx tsc --noEmit -p
tsconfig.json`, `npx cspell --no-progress <touched-files>`.

### Commit

`fix(add): refuse an unmatched pathspec before any object write, as git does`

## Part 8 — checkout locks and reads the index first, then names every unmatched pathspec

### Context

Files this part creates or edits (exactly these):
- `src/domain/commands/error.ts` — `PATHSPEC_NO_MATCH` gains `patterns`.
- `test/unit/domain/commands/error.test.ts`
- `src/application/commands/checkout.ts`
- `test/unit/application/commands/checkout.test.ts`
- `test/integration/pathspec-glob-dialect-interop.test.ts` — extend with C and K rows (created by
  Part 1; a file new to this run).

Read-only references: src/application/commands/internal/pathspec-intake.ts
(`resolveCommandPathspec(ctx, paths)`, `positives`, `unmatchedPositives`),
src/domain/git-index/index-path-key.ts (`escapedPathOf`).

Public surface (decided here): `PATHSPEC_NO_MATCH` is a member of the public `CommandError` union
(reachable through `TsgitError.data`). Adding `patterns` is an additive member change:
- exhaustiveness switches: none change — the code string is unchanged; the message switch in
  src/domain/error.ts:454 keeps `pathspec did not match any files: ${data.pattern}`;
- barrel-surface/error-code set tests: the set of codes is unchanged, nothing to update;
- every `toEqual({ code: 'PATHSPEC_NO_MATCH', pattern })` was converted in Parts 5, 6 and 7; the
  remaining ones are in this part's files (checkout.test.ts:1870, error.test.ts:147 and the
  `CommandError`-typed message table at error.test.ts:1706, which needs `patterns` to type-check);
- reports/api.json changes — regenerated ONCE in Part 11 (which also changes the public surface),
  before any push; api.json is a prepush gate, not a validate gate.

Target type and factory (ADR-1037; the tuple type makes "non-empty, `patterns[0] === pattern`"
a compile-time fact):

    | { readonly code: 'PATHSPEC_NO_MATCH'; readonly pattern: string;
        readonly patterns: readonly [string, ...string[]] }
    export const pathspecNoMatch = (pattern: string, ...others: string[]): TsgitError =>
      new TsgitError({ code: 'PATHSPEC_NO_MATCH', pattern, patterns: [pattern, ...others] });

Existing one-argument callers (add, submodule.ts:156, checkout.ts:143 for an unresolvable switch
target, renormalize) keep compiling and get a one-entry `patterns`.

Current checkout.ts `pathRestore` (:339): resolves the source, `resolvePathspec`, then
`enumerateSourcePaths` (:466; the index source reads the index BEFORE any lock), filters `matched`,
`enforceLiteralMustMatch(literalMustMatch, …)`, returns a no-op when `pathSet` is empty ("Glob with
zero matches → no-op"), and only then `materializePathRestoreFromIndex` (:397) /
`materializePathRestoreLocked` (:425), each acquiring its own lock and reading the index again.
The post-checkout hook runs after the lock is released.

Target (ADR-1038, candidate 5 A):

    source = await pathSourceFor(...)                 // an unresolvable rev still refuses first
    { matcher, positives } = resolveCommandPathspec(ctx, paths)   // pathspec intake still before the lock
    lock = await acquireIndexLock(ctx)
    try:
      currentIndex = await readIndex(ctx)            // K4/K5: a corrupt index refuses here
      universe = source === undefined ? currentIndex.entries : <tree walk of source.tree>  (C8)
      unmatched = unmatchedPositives(positives, p => universe.some(e => p.entry.compiled.test(escapedPathOf(e))))
      if unmatched non-empty: throw pathspecNoMatch(unmatched[0].spelling, ...rest spellings)
      pathSet = matched paths; if empty: return no-op (lock released by finally, no index write)
      materialize with the held lock and currentIndex; lock.commit(...)
    finally: lock.release()
    then the post-checkout hook, outside the lock, as today

`materializePathRestoreFromIndex` / `materializePathRestoreLocked` take `(ctx, lock,
currentIndex, …)` instead of acquiring and reading; `enumerateSourcePaths` takes the read index for
the index source. Keep the existing `Stryker disable next-line` lines in checkout.ts (:389
ArithmeticOperator on `changedPaths`, :477 ConditionalExpression in `enumerateSourcePaths`)
byte-identical with their code. Fix the stale comments at :345-352 (pre-lock read) and :361
("Glob with zero matches → no-op"); the materialize comment that cites the "L145 guard" is reworded
to the new guard.

Matrix rows: C1, C1b, C3, C4, C5, C7, C8, K1, K1L (fact 4), K4 flip; C2, C9 GUARD; K5 GUARD
(the index source already reads the index before its check today, and errors on the corrupt file). Interop
reconstructs git's report from `err.data.patterns`: one line per pattern,
`error: pathspec '<p>' did not match any file(s) known to git`, exit 1; K rows: git 128
`fatal: Unable to create '…/index.lock': File exists.` ↔ tsgit RESOURCE_LOCKED; K4/K5: git 128
`fatal: .git/index: index file smaller than expected` ↔ the error `readIndex` throws for a
4-NUL-byte index (read it from the existing row at checkout.test.ts:992 by running it). C rows
check `dirty.txt` bytes and `git ls-files -s` on both twins.

Environment: git 2.55.0 first on PATH for interop: `PATH="$HOME/.local/git-2.55.0/bin:$PATH"`.

House rules: one RED per function, run before its code; GUARD = already passes. `git diff --no-ext-diff --stat`
after scripted edits. Poll, never wait. Commit only these files. No provenance ids in code.

Re-pinning rule: When an existing test row breaks, decide whether the OLD expectation encoded the
contract. If it did, fix the code, not the row, and say so. A changed row is re-pinned against real
git 2.55 (or the design's matrix row id), never rewritten to match the new code.
Rows that change here: checkout.test.ts:967 "Given a glob with no match on the index source"
(no-op, changedPaths 0) → refuses PATHSPEC_NO_MATCH '*.nomatch' (C7 shape); :992 "Given a
zero-match glob from HEAD AND a corrupted index" (no-op that never reads the index) → refuses with
the index read error and leaves no index.lock (K4); :1380 "Given a glob pathspec with no match"
(HEAD source, no-op) → refuses '*.nope'; :1557 "Given a path restore whose glob matches nothing" →
refuses '*.nomatch' and post-checkout still does not fire; :1870 shape row gains `patterns`.
:509 (held lock, literal `a.txt`) stays a GUARD.

### TDD steps

1. RED — error.test.ts: `pathspecNoMatch('a').data` equals
   `{ code: 'PATHSPEC_NO_MATCH', pattern: 'a', patterns: ['a'] }`; `pathspecNoMatch('n1*', 'n2*')`
   gives `pattern: 'n1*'`, `patterns: ['n1*', 'n2*']`; message still names the first. Fails: no
   `patterns`. GREEN — type + factory; update error.test.ts:147 and the :1706 table literal.
2. RED — checkout.test.ts K1: held `index.lock`, `checkout(ctx, { paths: ['nomatch*'] })` →
   RESOURCE_LOCKED with the lock bytes intact; K1L: same with `paths: ['missing']`. Fails: today
   the pathspec check runs before the lock (no-op success / PATHSPEC_NO_MATCH). Re-pin :992 to K4 in
   this step. Add the interop K1, K1L, K4, K5 rows. GREEN — lock and read first, both materialize functions take
   the held lock.
3. RED — checkout.test.ts C4 `paths: ['n1*', 'n2*']` → `patterns ['n1*','n2*']`; C5
   `['n1*', 'missing']` → `pattern 'n1*'`, `patterns ['n1*','missing']`; C1b `['d*', 'nomatch*']`
   leaves `dirty.txt` dirty; C8 `source: 'HEAD'`, `['new*']` with `new.txt` staged but not in HEAD
   → refuses, index unchanged. Re-pin :967, :1380, :1557, :1870 here. Interop C1, C1b, C3, C4, C5,
   C7, C8 with C2, C9 as GUARDs. Fails: globs never refuse; literals name one. GREEN —
   `unmatchedPositives` over the universe, `pathspecNoMatch(first, ...rest)`; drop
   `enforceLiteralMustMatch`/`literalMustMatch`/`literalSpellings` use in checkout.ts.
4. REFACTOR — comments; keep functions under 20 lines (extract the locked body). Gate.

### Gate

```bash
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/unit/domain/commands/error.test.ts test/unit/application/commands/checkout.test.ts test/unit/application/commands/checkout-switch-target.test.ts test/unit/application/commands/checkout-prior.test.ts test/unit/application/commands/checkout-branch-state.test.ts test/unit/application/commands/switch-and-tag-target-dwim.test.ts test/unit/application/commands/add.test.ts test/unit/application/commands/rm.test.ts test/unit/application/commands/add-directory-file.test.ts test/integration/pathspec-glob-dialect-interop.test.ts test/integration/pathspec-dot-interop.test.ts test/integration/checkout-leading-symlink-interop.test.ts test/integration/blob-streaming-checkout-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/domain/commands/error.ts test/unit/domain/commands/error.test.ts src/application/commands/checkout.ts test/unit/application/commands/checkout.test.ts test/integration/pathspec-glob-dialect-interop.test.ts \
  && npm run check:spelling; echo "gate exit=$?"
```

Run after the last edit; exit code must be 0. Wireit caveat: `check:types` / `check:spelling` can
print `Ran 0 scripts and skipped 1` on a cached result — bare oracles: `npx tsc --noEmit -p
tsconfig.json`, `npx cspell --no-progress <touched-files>`. `check:types` also proves no other
`CommandError` literal lacks `patterns`.

### Commit

`fix(checkout): lock and read the index before refusing every unmatched pathspec`

## Part 9 — add stages tracked files that ignore rules hide from the walk

### Context

A pre-existing data-integrity gap (fact 8: reproduced identically on `main` 8dd442ee), surfaced by
Part 7. git's `add` runs an index-side pass (`add_files_to_cache` → `run_diff_files` over the
index entries the pathspec matches) that stages modified tracked entries whatever the ignore rules
say; tsgit stages only what the ignore-pruned walk yields, so a tracked file that is ignored, or
sits under an ignored directory, is silently left unstaged (` M` where git shows `M `). Deletions
are already handled by the removal set (B7 passes).

Files this part creates or edits (exactly these):
- `src/application/commands/add.ts`
- `test/unit/application/commands/add.test.ts` — unit rows, `add` and `addAll` (memory adapter).
- `test/integration/add-tracked-under-ignore-interop.test.ts` — CREATED. A file of its own (not
  pathspec-glob-dialect-interop.test.ts) so no pending part shares an interop file: Part 8
  extends the dialect file right now, and plan-lint flags a file shared by pending parts. Copy the
  `@proves` header and twin builder from test/integration/pathspec-glob-dialect-interop.test.ts
  (surface/interopSurface: add); the design's row ids (B8, B13–B16 once the designer's revision
  lands) go in this plan and the commit report, never in test text.

Read-only references: src/application/primitives/types.ts:253 (`WalkWorkingTreeEntry { path,
isFile, isDirectory, isSymbolicLink, stat: () => Promise<FileStat> }`),
src/domain/git-index/index-entry.ts (`flags.stage`, `flags.skipWorktree`, `flags.intentToAdd`),
src/domain/objects/file-mode.ts (`FILE_MODE.GITLINK`), src/domain/pathspec/matching-path.ts
(`matchesIndexPath`), src/application/primitives/internal/symlinked-leading-path.ts
(`createLeadingPathScanner`), src/application/commands/internal/pathspec-intake.ts.

add.ts as landed by Part 7 (830924e8) — anchors:
- `addByPathspec` :729 → `stageIgnoredWalk(ctx, repoIgnore, { matcher, positives }, scope, guard)`
  then `tallyWalkOutcomes`, `collectMatchedRemovals` (:763), `settleWalkRemovals`, `commitStaged`.
- `stageIgnoredWalk` :933 — `readExistingEntries` (:1226; gives `entries` = `existing`, one per
  path, and `sorted`), `withPathspec(repoIgnore, matcher, unmergedStages)` (:973), `walked = await
  collectWalk(walkWorkingTree(ctx, { ignore }))` (:812), `refuseUnseenWalked(ctx, positives,
  sorted, walked)` (:853), then `stageWalkedEntries(ctx, walked, existing, new Set(), …)` (:631).
- `stageWalkedEntries` → `walkedTrackedFirst` (:656: index order first, then walk order) →
  `processWalkEntry` (:1175: marks `seen`, `stageFromStat(ctx, path, { isFile, isDirectory,
  isSymbolicLink }, …)` (:1329) re-lstats and hashes through the EOL/attribute/promisor path,
  returns added/modified/unchanged).
- `addAll` :1079 (`-A`) streams `walkWorkingTree(ctx, { ignore })` straight into
  `stageWalkedEntries`, then `collectRemovedEntries(ctx, existing, seen)` (:1159).
- `presentOnDisk` :1133 (symlinked leading path → gone; missing → gone; a directory → gone unless
  gitlink), `collectRemovedEntries` skips skip-worktree and lossy (`isLossy`) entries,
  `lstatOrBeneathFile` :580, `lstatOrMissing` :598.

Target — one helper chain, every function under ~20 lines:

    // the stage-0 tracked entries the walk did not yield that the pass must still stage
    const hiddenTracked = async (ctx, existing, matcher, walked): Promise<WalkWorkingTreeEntry[]>
      // candidates: entry.flags.stage === 0 && !entry.flags.skipWorktree && !isLossy(entry)
      //   && entry.mode !== FILE_MODE.GITLINK && matchesIndexPath(matcher, entry)
      //   && its key is not among the walked paths
      // per candidate (named helper `hiddenWalkEntryOf`): a symlinked leading path → skip;
      //   stat = await lstatOrBeneathFile(ctx, path); missing or a directory → skip (the removal
      //   pass owns it); else { path, isFile: stat.isFile, isDirectory: false,
      //   isSymbolicLink: stat.isSymbolicLink, stat: () => Promise.resolve(stat) }
    // stageIgnoredWalk: after refuseUnseenWalked, stage [...walked, ...hidden]
    // addAll: collect its walk (collectWalk), append hiddenTracked(…, WHOLE_TREE_MATCHER, …)

The hidden entries go through `processWalkEntry` exactly as walked ones (same hashing, EOL,
attributes, promisor guard, `seen` marking — so the removal pass no longer sees them as missing);
`walkedTrackedFirst` puts them in index order. Intent-to-add entries are stage-0 entries and are
included (git stages their content); the staged entry is built from the stat, so its
`intentToAdd` flag clears.

git 2.55 pins (planner, scrubbed env, one `mktemp -d` twin per row; fact 8 holds the five
session pins):
- skip-worktree (SW2): tracked `x.log`, `k`; `update-index --skip-worktree x.log`, modify,
  `add .` → exit 0, nothing staged. SW3 with `.gitignore` `*.log`: `add .` → only `A .gitignore`.
  SW1 `add '*.log'` with the ignore → exit 1 with the sparse "outside of your sparse-checkout
  definition" advice, nothing staged — the advice/exit is out of scope (sparse seen rules); the
  row asserts only that nothing is staged.
- intent-to-add (ITA): `add -N x.log`, `.gitignore` `*.log`, `add '*.log'` → exit 0, index
  `100644 2e65efe… 0 x.log` (the real blob), status `A  x.log`. ITA2 under an ignored dir
  `d/` with `add .` → `A  d/x.txt`.
- gitlink (SUB): a submodule `s` whose checkout moved, `.gitignore` `s`; `add '*'`, `add .` and
  `add s` all stage `M s`. tsgit does not stage gitlinks through `add` at all — a separate gap
  (out-of-scope line below); this pass excludes gitlinks so it changes nothing there.
- `add -A` (A1): tracked `d/x.txt`, `.gitignore` `d/`, modify → `M  d/x.txt`; (A2) tracked
  `x.log`, `.gitignore` `*.log`, modify → `M  x.log`. Same gap in tsgit's `addAll` (same
  ignore-pruned walk, :1079) — in scope.
- symlink (MODE): tracked symlink `l.log` retargeted under `*.log` → `M  l.log`.
- file→dir (TYPE): tracked `x.log` replaced by a directory under `*.log` → `D  x.log` (the
  removal pass already does this — GUARD).
- clean (CLEAN): an unmodified tracked ignored file → nothing staged (GUARD).

Windows: symlink and `*`-free names only; the symlink rows sit under
`describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')`.

Environment: git 2.55.0 first on PATH for interop: `PATH="$HOME/.local/git-2.55.0/bin:$PATH"`.

House rules: One RED per function, run before its code. A row that already passes is a GUARD,
never a RED. Write each step's rows, run them, see them fail for the stated reason, then write the
code — never batch several steps' REDs behind one GREEN. `git diff --no-ext-diff --stat` after
scripted edits. Poll, never wait. Commit only these files. No provenance ids in code. No
suppression directives.

Re-pinning rule: When an existing test row breaks, decide whether the OLD expectation encoded the
contract. If it did, fix the code, not the row, and say so. A changed row is re-pinned against real
git 2.55 (or the design's matrix row id), never rewritten to match the new code.
Expected: an existing add.test.ts or add-interop row that asserts a tracked ignored file stays
unstaged encoded the gap, not git — re-pin it to git's `M` (cite the pin above).

### TDD steps

1. GUARD — add.test.ts, written and run before any code (all pass today because nothing hidden is
   staged): skip-worktree entry modified, `add(['.'])` leaves its index entry unchanged; clean
   tracked ignored file, `add(['*.log'])` → `modified: []`; tracked `x.log` replaced by a
   directory under `*.log` → `removed: ['x.log']`; a lossy tracked entry under an ignored dir is
   neither staged nor removed; a gitlink entry under an ignored path is left as it is. Interop:
   SW2, SW3, SW1 (index only), TYPE, CLEAN.
2. RED — `hiddenWalkEntryOf` / `hiddenTracked` through `add` (add.test.ts): B8 — tracked `x.log`,
   `.gitignore` `*.log`, `x.log` modified, `add(['*.log'])` → `modified: ['x.log']` and the index
   blob is the new content; `add(['.'])` over tracked `d/x.txt` + `k` with `.gitignore` `d/` →
   `added: ['.gitignore']`, `modified: ['d/x.txt']`; `add(['*.txt'])` same fixture →
   `modified: ['d/x.txt']`; `add(['d'])` → `modified: ['d/x.txt']`; a retargeted tracked symlink
   under `*.log` → modified; an intent-to-add `x.log` under `*.log` → staged with the file's
   blob and `intentToAdd` false. Interop rows for the same six shapes. Run: all fail —
   `stageIgnoredWalk` stages only walked leaves. The literal `add(['x.log'])` row is a GUARD
   (the literal fast path already stages it).
   GREEN — `hiddenWalkEntryOf`, `hiddenTracked`, appended in `stageIgnoredWalk`. Step 1's GUARDs
   stay green.
3. RED — `addAll` (add.test.ts, via the `addAllInternal` import): A1 (`d/x.txt` under `d/`) and
   A2 (`x.log` under `*.log`) → modified; interop `add -A` rows. Run: fail — `addAll` streams the
   pruned walk. GREEN — `addAll` collects its walk and appends `hiddenTracked` with
   `WHOLE_TREE_MATCHER`.
4. REFACTOR — named helpers, comments say why (git's index-side pass). Gate.

### Gate

```bash
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/unit/application/commands/add.test.ts test/unit/application/commands/add-directory-file.test.ts test/unit/application/commands/add-unmerged.test.ts test/unit/application/commands/add-clean-order.test.ts test/unit/application/commands/add-big-file-threshold.test.ts test/integration/add-tracked-under-ignore-interop.test.ts test/integration/pathspec-glob-dialect-interop.test.ts test/integration/add-interop.test.ts test/integration/add-all.test.ts test/integration/add-unmerged-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/commands/add.ts test/unit/application/commands/add.test.ts test/integration/add-tracked-under-ignore-interop.test.ts \
  && npm run check:spelling && npm run check:test-pyramid; echo "gate exit=$?"
```

Run after the last edit; exit code must be 0. Wireit caveat: `check:types` / `check:spelling` can
print `Ran 0 scripts and skipped 1` on a cached result — bare oracles: `npx tsc --noEmit -p
tsconfig.json`, `npx cspell --no-progress <touched-files>`.

### Commit

`fix(add): stage tracked files that ignore rules hide from the walk, as git's index pass does`

## Part 10 — A pathspec may hold a backslash on POSIX hosts, for matching only

### Context

ADR-1044 (user-ratified, candidate 1 B). This part lands after the `rm` part (Part 6) and after
add (7) and checkout (8), so every command already resolves pathspecs through Part 5's intake.

Files this part creates or edits (exactly these):
- `src/application/commands/internal/resolve-pathspec.ts` — relax the body validation; scan
  prefix; delete the retired helpers. This part is the file's only editor in the run.
- `test/unit/application/commands/internal/resolve-pathspec.test.ts` — likewise its only editor.
- `test/unit/application/commands/internal/pathspec-intake.test.ts` — POSIX-accept rows (created
  by Part 5; a file new to this run).
- `test/integration/pathspec-backslash-interop.test.ts` — CREATED (its own file so no pending part
  shares an interop file; copy the header and twin builder from
  test/integration/pathspec-glob-dialect-interop.test.ts) — D6, D17, E2 rows and the Windows
  refusal row (created by Part 1; a file new to this run).

Read-only references: src/application/commands/internal/pathspec-intake.ts (Part 5:
`resolveCommandPathspec(host, paths)` already refuses a backslash body when
`host.windowsPathSyntax === true`, before calling `resolvePathspec`; `PositivePathspec.probesDisk`
is false for a backslash body), src/domain/working-tree-path.ts (`validateWorkingTreePath`: :71
refuses any backslash; `validateWalkedEntryPath`), src/application/commands/internal/working-tree.ts
(`validatePath = validateWorkingTreePath`, used at :44, :85, :116-117), src/application/commands/
mv.ts:120/:125, src/application/commands/blame.ts:223, src/ports/context.ts:358
(`Context.windowsPathSyntax`), test/unit/domain/working-tree-path.test.ts:145 ("Given a
backslash in the path … Then rejects" — stays as-is: the general validator is unchanged).

How the host policy reaches the intake: there is no `PathPolicy` object on `Context`; the flag is
the optional field `Context.windowsPathSyntax` (context.ts:358), set by the node adapter on Windows
(src/adapters/node/node-adapter.ts:155, src/index.node.ts:171) and absent on memory/browser.
Primitives read it by passing `ctx` structurally (`gitPathSyntaxOf(ctx)`,
src/application/primitives/internal/git-path-syntax.ts:98; `indexPathRulesOf(ctx)`,
index-path-rules.ts:8). The commands pass `ctx` to `resolveCommandPathspec(ctx, paths)`: rm.ts
(Part 6), add.ts `dispatchPathspec` and `addRenormalized` (Part 7), checkout.ts `pathRestore`
(Part 8), grep.ts (Part 5). `grep -rn "resolveCommandPathspec\|resolvePathspec(" src` must show
exactly those call sites plus add.ts's `WHOLE_TREE_MATCHER` (`resolvePathspec(['.'])`).

Current resolve-pathspec.ts gate point: `collapsePattern` (:107-118) calls `validatePath(body)`
for an empty or "/"-led body (:111) and `validatePath(kept)` on the collapsed body (:115);
`validatePath` refuses any backslash. `symlinkScanTargets` (:65) passes every whole body to
`assertNoSymlinkedLeadingPath` (:185, a `createLeadingPathScanner` lstat walk).

Target (ADR-1044):
- `collapsePattern` validates the collapsed body with every backslash read as an ordinary byte
  (e.g. a private `validatePathspecBody(kept)` that runs `validatePath` on the body with each
  backslash replaced by a byte the validator accepts, returning the original body) — every other
  rule (traversal components, control bytes, `.git` aliases, leading `/`, length in bytes) still
  applies. The intake (Part 5) keeps the refusal under Windows path syntax; `validateWorkingTreePath`
  itself is NOT changed, so `mv`, `blame`, working-tree.ts:44 and every other caller keep refusing a
  backslash, and `validateWalkedEntryPath` is unchanged.
- A backslash body is a wildcard (`hasGlobSpecial`, Part 1), so it is never in `literalMustMatch`,
  never `literalStats`-probed by add's dispatch, never the on-disk escape subject (Part 5's
  `probesDisk` false, read by Part 7's escape) — verify each with a row, not by assumption.
- `symlinkScanTargets`: for a body holding a backslash, the target is its no-wildcard prefix — the
  bytes before the first glob-special byte (`* ? [ \`), git's no-wildcard prefix length — never the
  whole body; empty prefixes are dropped. Other bodies keep today's whole-body target (ADR-1044
  scopes the change to backslash bodies; the existing add rows "link/*.ts", "li*/x.ts",
  "realdir/*.ts" stay GUARDs).
- Delete the helpers this run retired, after `grep -rn "enforceLiteralMustMatch\|literalSpellings"
  src` shows no caller outside this file (Parts 6, 7, 8 removed them): `enforceLiteralMustMatch`,
  `literalSpellings`/`spellLiterals`, `NO_SPELLINGS`, `descendantPrefix`, `WHOLE_TREE_SPELLING` if
  unused; keep `namesWholeTree`, `namesDirectoryOnly`, `literalMustMatch`, `hasGlob` (add's dispatch).
  Delete their describes in resolve-pathspec.test.ts (`describe('enforceLiteralMustMatch'` at
  :324-458 at the base; locate by name).
- Fix the stale comments: lines 17-23 and 54-56 ("compiled to RegExp", "cost of the compiled
  regex") — the matcher is linear; the byte and `**` caps stay as a bound on the work a hostile
  pattern can request (name no ADR); the `hasGlob` doc becomes its dispatch role ("routes add away
  from the literal-only fast path").

Matrix rows: D6 (`a*b`, `aXb`; `add 'a\*b'` stages `a*b`), D17 (`a?b`, `axb`; `add 'a\?b'` stages
`a?b`), E2 (`ab`; `add 'a\b'` stages `ab`) flip at command level on POSIX hosts, interop rows
under `describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')` (repo convention, e.g.
test/integration/commit-cache-tree-interop.test.ts:571). The Windows CI leg pins the refusal with
a tsgit-only row under `describe.skipIf(process.platform !== 'win32')`: `add(ctx, ['a\\b'])`
through `createNodeContext` → PATHSPEC_OUTSIDE_REPO. D8b and E1 stay pinned follow-ups: they need a
working-tree entry whose name holds a backslash, which `validateWalkedEntryPath` refuses (ADR-1044
Consequences).

Environment: git 2.55.0 first on PATH for interop: `PATH="$HOME/.local/git-2.55.0/bin:$PATH"`.
This part relaxes a path-traversal defence: the review phase's security dimension reviews it
explicitly (ADR-1044) — keep the change confined to `collapsePattern` and the scan targets.

House rules: one RED per function, run before its code; GUARD = already passes.
`git diff --no-ext-diff --stat` after scripted edits. Poll, never wait. Commit only these files.
No provenance ids in code. No suppression directives.

Re-pinning rule: When an existing test row breaks, decide whether the OLD expectation encoded the
contract. If it did, fix the code, not the row, and say so. A changed row is re-pinned against real
git 2.55 (or the design's matrix row id), never rewritten to match the new code.
Rows that change here: any resolve-pathspec.test.ts row expecting PATHSPEC_OUTSIDE_REPO for a
backslash body (grep the file for a backslash in a pattern) is re-pinned to acceptance (D6/D17/E2,
git accepts the pathspec); rows refusing traversal, NUL or a leading "/" stay GUARDs.

### TDD steps

1. RED — written together and run red before any code:
   - `resolve-pathspec.test.ts`, "Given a pattern holding a backslash": `resolvePathspec(['a\\*b'])`
     resolves to one wildcard entry (`isLiteral` false) with `literalMustMatch` empty; GUARDs
     `['../a\\b']` and `['a\\b/../x']` still throw PATHSPEC_OUTSIDE_REPO.
   - `pathspec-intake.test.ts`, "POSIX host": `resolveCommandPathspec({}, ['a\\*b'])` resolves and
     its positive has `probesDisk` false; GUARD: Part 5's Windows-host row still refuses.
   - `pathspec-backslash-interop.test.ts`: D6, D17, E2 (POSIX only) and the Windows-only
     refusal row.
   Fails: `validatePath` refuses every backslash body. GREEN — relaxed body validation in
   `collapsePattern`. Part 5's host check is now the only Windows refusal (its mutants now die).
2. RED — `resolve-pathspec.test.ts`: `['d/a\\b']` → `symlinkScanTargets` `['d/a']`; `['a\\b']` →
   `['a']`; `['\\x']` → `[]` (empty prefix dropped); `['link/*.ts']` → `['link/*.ts']` (GUARD:
   other bodies unchanged). Fails: whole bodies are passed. GREEN — the scan-prefix rule.
3. REFACTOR — `grep` that no caller of `enforceLiteralMustMatch`/`literalSpellings` remains, delete
   them and their describes; comments. GUARD: test/unit/domain/working-tree-path.test.ts and the mv
   and blame suites stay green unchanged. Gate.

### Gate

```bash
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/unit/application/commands/internal test/unit/domain/working-tree-path.test.ts test/unit/application/commands/add.test.ts test/unit/application/commands/rm.test.ts test/unit/application/commands/checkout.test.ts test/unit/application/commands/grep.test.ts test/unit/application/commands/mv.test.ts test/unit/application/commands/blame.test.ts test/integration/pathspec-backslash-interop.test.ts test/integration/pathspec-glob-dialect-interop.test.ts test/integration/pathspec-dot-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/commands/internal/resolve-pathspec.ts test/unit/application/commands/internal/resolve-pathspec.test.ts test/unit/application/commands/internal/pathspec-intake.test.ts test/integration/pathspec-backslash-interop.test.ts \
  && npm run check:spelling && npm run check:test-pyramid; echo "gate exit=$?"
```

Run after the last edit; exit code must be 0. Drop a listed suite only if the file does not exist
(do not invent files). Wireit caveat: `check:types` / `check:spelling` can print `Ran 0 scripts
and skipped 1` on a cached result — bare oracles: `npx tsc --noEmit -p tsconfig.json`,
`npx cspell --no-progress <touched-files>`.

### Commit

`fix(pathspec): accept a backslash in a pathspec on POSIX hosts, for matching only`

## Part 11 — name-rev reports suffix-matched abbreviation as data

### Context

Files this part creates or edits (exactly these):
- `src/application/commands/name-rev.ts` — `NameRevResult.abbreviated`.
- `test/unit/application/commands/name-rev.test.ts`
- `test/unit/application/commands/name-rev-tip-table.test.ts` — whole-result `toEqual` rows gain
  `abbreviated: false` (:150-156, :191-197, :214-220, :235, :271-277, :293).
- `test/unit/application/commands/describe.test.ts` — `describe --contains` returns a
  `NameRevResult`: rows at :1034-1040 and :1082 gain `abbreviated: false`.
- `test/integration/name-rev-interop.test.ts` — every N row; this part is the file's only editor
  in the run (Part 3 changed the filter with unit rows only).
- `reports/api.json` — regenerated with `npm run docs:json`, committed.

Public surface (decided here): `NameRevResult` is public (src/application/commands/index.ts:215,
`Repository.nameRev`). `readonly abbreviated: boolean` is an additive public field. Gates: no new
command, barrel entry, facade method or error code, so `check:doc-coverage`, the repository
surface snapshot and `audit-browser-surface` are untouched; `reports/api.json` changes and is a
prepush gate — regenerate it here with `npm run docs:json` (it also captures Part 8's
`PATHSPEC_NO_MATCH.patterns`; the large typedoc-id diff is normal) and commit it. The user doc
(docs/use/commands/name-rev.md) is the documentation phase's.

Read-only references: src/domain/name-rev/ref-pattern.ts (`RefFilter.abbreviates(ref)`, Part 3),
src/application/commands/describe.ts (`describeContains` passes the result through),
test/parity/scenarios/name-rev.scenario.ts (maps fields explicitly — unaffected).

Current name-rev.ts: `NameRevResult { oid, ref, tagDeref, steps }` (:42); `nameRevOf` (:83) builds
`filter = buildRefFilter(…)` and calls `exactRefMatch(ctx, refs, id)` (:117) or
`nameCommit(ctx, refs, id)` (:102); both build results in three places (named, unnamed).

Target: `/** True when an include pattern matched the naming ref only through a suffix — git then
prints the ref shortened (the caller shortens; the library returns the full ref). */ readonly
abbreviated: boolean`; pass `filter` (or `filter.abbreviates`) into `nameCommit` and
`exactRefMatch`; `abbreviated: filter.abbreviates(ref)` for a named result, `false` when `ref` is
undefined. `--tags --name-only` stays the caller's own rule (N21).

Interop renderer: add a sibling of `renderNameRev` that, when `r.abbreviated`, takes the base name
from `git(dir, 'rev-parse', '--abbrev-ref=loose', r.ref).trim()` (fact 3 — NOT plain
`--abbrev-ref`), then applies the existing `^0` / step suffix; otherwise defers to `renderNameRev`.
Fixture: c1 holds `v1.0` (annotated) and `w2`; c2 holds "v1/rc1" (annotated); `main` at c3;
target c1 unless noted. Reuse `datedEnv`, `gitNameRev`, `renderNameRev` in the file.
Rows flipped by Part 3's filter, rendered by the existing `renderNameRev` (no abbreviation): N7,
N8, N10, N11, N12; GUARDs N1, N5, N9, N14, N15, N20, N22. Abbreviated rows: N2, N3, N4, N6, N13,
N16, N17, N18, N19 on that fixture; N23, N24 with an added branch
`v1.0` at c1; N25–N28 on a new repo (tag `x` at c1, branch `x` at c2). N21 GUARD (existing row at
name-rev-interop.test.ts:~353).

Environment: git 2.55.0 first on PATH for interop: `PATH="$HOME/.local/git-2.55.0/bin:$PATH"`.

House rules: one RED per function, run before its code; GUARD = already passes. `git diff --no-ext-diff --stat`
after scripted edits (api.json is huge — check it appears in the stat, never read it whole). Poll,
never wait. Commit only these files. No provenance ids in code.

Re-pinning rule: When an existing test row breaks, decide whether the OLD expectation encoded the
contract. If it did, fix the code, not the row, and say so. A changed row is re-pinned against real
git 2.55 (or the design's matrix row id), never rewritten to match the new code.
The whole-result rows listed above encode the contract minus the new field: add
`abbreviated: false`, change nothing else (the naming ref does not change — ADR-1040).

### TDD steps

1. GUARD — name-rev-interop.test.ts: the fixture plus N7, N8, N10, N11, N12, N1, N5, N9, N14, N15,
   N20, N22 through `renderNameRev` — they pass since Part 3's filter (run to confirm; one that
   fails is a RED and is reported).
2. RED — written together and run red before any code:
   - name-rev.test.ts: refs ["v*"] on a tag `v1.0` → `{ …, ref: 'refs/tags/v1.0', abbreviated:
     true }`; refs ["refs/tags/*"] → `abbreviated: false`; unnamed → `false`. Fails: no field.
   - name-rev-interop.test.ts: the abbreviated rows with the new renderer. Fail: tsgit's default
     rendering prints `tags/v1.0^0` where git prints `v1.0^0`.
   GREEN — thread the filter, set the field; add `abbreviated: false` to the listed whole-result
   rows in name-rev.test.ts, name-rev-tip-table.test.ts, describe.test.ts.
3. REFACTOR — `npm run docs:json`; confirm `git diff --no-ext-diff --stat reports/api.json` shows
   the change. Gate.

### Gate

```bash
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/unit/application/commands/name-rev.test.ts test/unit/application/commands/name-rev-tip-table.test.ts test/unit/application/commands/name-rev-skip.test.ts test/unit/application/commands/describe.test.ts test/unit/domain/name-rev test/integration/name-rev-interop.test.ts test/integration/describe-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/commands/name-rev.ts test/unit/application/commands/name-rev.test.ts test/unit/application/commands/name-rev-tip-table.test.ts test/unit/application/commands/describe.test.ts test/integration/name-rev-interop.test.ts \
  && npm run check:spelling && npm run check:doc-typedoc; echo "gate exit=$?"
```

Run after the last edit; exit code must be 0. Wireit caveat: `check:types` / `check:spelling` can
print `Ran 0 scripts and skipped 1` on a cached result — bare oracles: `npx tsc --noEmit -p
tsconfig.json`, `npx cspell --no-progress <touched-files>`. `check:doc-typedoc` regenerates
reports/api.json and runs `git diff --exit-code -- reports/api.json`, so stage this part's files
(`git add` of exactly the six files) before running the gate; it then passes only when the staged
api.json is current.

### Commit

`fix(name-rev): report a suffix-matched ref abbreviation as data`

## Part 12 — Bundle-size measurement, add-by-glob bench, byte-matcher linearity guard

### Context

No src/ delta: a test-infra and config part, standalone by the sizing rules. Runs after every
source part, before review (ADR-1043).

Files this part creates or edits:
- `test/perf/domain/refs/ref-glob.perf.test.ts` — linearity row for `compileRefGlobBytes`; its
  header's "the same ReDoS class compile-glob.perf.test.ts closes for pathspecs" now reads "for
  gitignore rules".
- `test/bench/add.bench.ts` — one new scenario.
- `.size-limit.json` — only if `check:size` is red.
- `docs/design/bundle-size-optimization.md` — a raise section, only if a cap is raised.
- `tooling/verify-tarball.sh` — cap + attribution comment, only if `check:tarball` is red.

Read-only references: docs/lessons/006-size-caps-at-the-headroom-floor-trip-again-on-the-review-round.md
(read first), docs/design/bundle-size-optimization.md (raise-section format, e.g. "Size-limit raise
— gc refuses a size-lying loose blob as git does"), test/bench/support/write-scratch.ts
(`buildAddManyScratch(count)`: `.txt` files across `dir<n>` and `dir<n>/nested`),
test/bench/support/bench-dsl.ts (`benchScenario(given, when, setup)`), vitest.perf.config.ts.

Perf row: Given an adversarial `a*a*…*b` pattern (`'a*'.repeat(64) + 'b'`), When
`compileRefGlobBytes` matches 10 000 bytes of `a`, Then false within 1000 ms — same shape as the
existing `compileRefGlob` row.

Bench row: `benchScenario('Given a freshly built scratch repo with 200 unstaged files across nested
directories', 'When add() stages them by the glob "*.txt", Then measure tsgit', …)` with
`scratch.repo.add(['*.txt'])` (exercises the one-star fast path). Do NOT run `bench:ab` here: the
session runs it after this commit (house rule — never inside a tree where wireit is running).

Size procedure (lesson 006 + ADR-1043):
1. `rm -rf dist .wireit && npm run check:size` then `npm run check:tarball`; read EVERY row of the
   output, not only the browser bundle (stale dist/ chunks fake reds — the clean rebuild is the
   measurement).
2. Main baseline the same way, without touching repo state: `base=$(mktemp -d)`,
   `git archive 8dd442ee | tar -x -C "$base"`, `ln -s "$PWD/node_modules" "$base/node_modules"`,
   then in `$base`: `npm run build && npx size-limit --json > <scratch>/main-size.json`.
3. For each red row: delta = branch − main (gzip bytes); raise that row's limit by exactly the
   delta, rounded up to the next 0.1 kB (ADR-1043), and confirm the new limit is ≥ the branch
   measurement. Record each raise (row, main, branch, delta, attribution: the dialect matcher,
   fast paths, refusal helpers and `subpathOffset`, offset by the removed `scanStar`,
   `containsGlob`, `compileLiteral`/`compileDirectory` and `enforceLiteralMustMatch`) in a new
   section of docs/design/bundle-size-optimization.md, and in the tarball cap comment if that cap
   moved. Lesson 006: the review round will likely add bytes and re-trip a cap raised to the floor;
   the session re-measures after review and asks the user once, listing every failing row.
4. No row red → edit neither `.size-limit.json` nor the design doc.

api.json drift check: `npm run docs:json && git diff --no-ext-diff --stat reports/api.json` must print nothing
(Part 11 regenerated it after the last public change). A diff here means a later part changed the
public surface — stop and report `{ unit: Part 12, reason, options }`, do not commit api.json.

House rules: `git diff --no-ext-diff --stat` after edits. Poll, never wait (`check:size` builds — poll its
output). Commit only this part's files. Never run two `npm run` scripts at once.

Re-pinning rule: When an existing test row breaks, decide whether the OLD expectation encoded the
contract. If it did, fix the code, not the row, and say so. A changed row is re-pinned against real
git 2.55 (or the design's matrix row id), never rewritten to match the new code. No existing row is
expected to change here.

### TDD steps

1. GUARD — perf row for `compileRefGlobBytes` (linear by construction since Part 1; passes).
2. GUARD — the bench scenario type-checks and biome-checks (benches are not run here).
3. Measure per the size procedure; raise only the red rows by the measured delta; record.
4. api.json drift check.

### Gate

```bash
npx vitest run --config vitest.perf.config.ts test/perf/domain/refs/ref-glob.perf.test.ts test/perf/domain/pathspec/compile-glob.perf.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check test/perf/domain/refs/ref-glob.perf.test.ts test/bench/add.bench.ts \
  && npm run check:spelling \
  && rm -rf dist .wireit && npm run check:size && npm run check:tarball; echo "gate exit=$?"
```

Add `.size-limit.json`, `tooling/verify-tarball.sh` and the design doc to the biome/cspell
arguments only when edited (biome checks JSON; cspell the markdown). Run after the last edit; exit
code must be 0. Wireit caveat: `check:types` / `check:spelling` can print `Ran 0 scripts and
skipped 1` on a cached result — bare oracles: `npx tsc --noEmit -p tsconfig.json`,
`npx cspell --no-progress <touched-files>`.

### Commit

Exactly one commit, one of:
- no cap raised: `test(pathspec): bench add by glob and guard the byte matcher's linearity`
- a cap raised: `fix(pathspec): raise the size caps by the measured glob-dialect delta`

## Part 13 — A literal-only add holding an exclusion takes the walk route

### Context

R18, ADR-1053 (candidate 20 A). This part is first because it narrows the literal fast path that
Parts 15 and 18 extend. Read "Fold revision — house rules" above.

Files this part creates or edits (exactly these):
- `src/application/commands/add.ts` — `dispatchPathspec` only.
- `test/unit/application/commands/add-literal-exclusion.test.ts` — CREATED (memory adapter).
- `test/integration/pathspec-literal-exclusion-interop.test.ts` — CREATED. `@proves` surface and
  interopSurface `add, rm, checkout`; unique line "literal pathspecs honour exclusions as git's :!
  does". Gate it with `describe.skipIf(!GIT_AVAILABLE)` (no special characters in the names).

Read-only references: src/application/commands/internal/resolve-pathspec.ts (`ResolvedPathspec`:
`matcher: Pathspec`, `literalMustMatch`, `hasGlob`; `isPositiveGlob` sets `hasGlob` from positive
entries only, so `['x', '!x']` has `hasGlob: false`), src/domain/pathspec/index.ts
(`PathspecEntry { pattern, body, negated, isLiteral, compiled }`),
src/application/commands/internal/pathspec-intake.ts (`trackPositives`: exclusions apply before a
positive is marked seen), test/unit/application/commands/fixtures.ts (`seedRepo(ctx, { workingTree })`),
test/unit/application/commands/add.test.ts :2903 (`blobExists` — copy it locally: hash the content
with `serializeAndHash` and probe the loose path), test/integration/pathspec-glob-dialect-interop.test.ts
:515 (`looseCountOf`) and :545 (`refusalOf`).

Current code (add.ts `dispatchPathspec`, :230 at `039599ad`):

    const resolved = resolveCommandPathspec(ctx, paths);
    const { literalMustMatch } = resolved;
    await assertNoSymlinkedLeadingPath(ctx, resolved.symlinkScanTargets);
    const stats = resolved.hasGlob ? undefined : await literalStats(ctx, literalMustMatch);
    if (stats !== undefined) return addLiteralOnly(ctx, resolved, stats, scope);
    return addByPathspec(ctx, resolved, scope);

`addLiteralOnly` stages every `literalMustMatch` entry, and the matcher is read only by
`dropBeneathInserted`, so exclusions never apply there. Target: a named predicate
`holdsExclusion(matcher) = matcher.some((entry) => entry.negated)`; the call skips `literalStats`
and walks when `hasGlob || holdsExclusion(matcher)`. The comment above `dispatchPathspec` already
says negations walk, and this makes it true. Do not touch resolve-pathspec.ts: `hasGlob` keeps
its meaning.

The walk route already gives git's result (X6, X13, X15–X19): exclusion runs before seen-marking
(`trackPositives`), and git's `file_exists` escape (`namesOnDisk` / `namesUnignoredDiskPath`) runs
after it. That order is why X1 is not refused and X15 is.

Pins (design matrix X; tsgit `!p` ≡ git `:!p`). Fixture U: untracked `x`, `y`, 'd/x', `a.txt`,
0 loose objects. Fixture M: the same four committed, then each rewritten, 7 loose objects.

| Row | Fixture · args | git |
|---|---|---|
| X1 | U · `x !x` | exit 0, nothing staged, 0 loose |
| X2 | U · `d/x !d` | nothing staged |
| X3 | U · `a.txt !*.txt` | nothing staged |
| X4 | U · `x !y` | `A  x`, 1 loose |
| X5 | U · `x y !x` | `A  y` only |
| X6 | U · `x *.txt !x` | `A  a.txt` |
| X7 | U · `!x x` | nothing staged |
| X8–X10 | M · as X1–X3 | ` M` kept, 7 loose |
| X11 | M · `x !y` | `M  x`, 8 loose |
| X12 | M · `x y !x` | `M  y` only |
| X13 | M · `x *.txt !x` | `M  a.txt` |
| X14 | M · `!x x` | ` M x` kept |
| X15 | U · `missing !missing` | 128 `fatal: pathspec 'missing' did not match any files` |
| X16 / X17 / X18 | U · `x* !x` / `q* !q*` / `x !x nomatch*` | 128 naming `x*` / `q*` / `nomatch*` |
| X19 | U · `d !d/x` | exit 0, nothing staged |
| X20–X23 | M · `rm --cached` with `x !x` / `x y !x` / `d/x !d` / `a.txt !*.txt` | index unchanged / `y` removed / unchanged / unchanged |
| X24–X26 | M · `checkout --` with `x !x` / `x y !x` / `x !y` | `x` stays rewritten / `y` restored, `x` kept / `x` restored, `y` kept |

Interop shape: twin repos built by the same git commands. Compare `ls-files -s`,
`status --porcelain --untracked-files=all`, the loose-object count, and on refusal the
`PATHSPEC_NO_MATCH` data against git's `fatal:` line. X20–X26 call `rm(ctx, paths, { cached: true })`
and `checkout(ctx, { paths })`. They are GUARDs that pin the other two commands.

No public-surface change: behaviour only, no type or JSDoc edit, no api.json.

### TDD steps

1. RED: X1 in add-literal-exclusion.test.ts, through `dispatchPathspec`. `add(ctx, ['x', '!x'])`
   over fixture U gives `added: []`, an empty index, and no loose blob for `x`'s content. Add the
   X1 interop row in the same step. Fails: the fast path stages `x` (`added: ['x']`, one blob).
   GREEN: `holdsExclusion` routes the call to `addByPathspec`.
2. GUARD (unit rows and interop rows): X2–X5 and X7 on U, X8–X12 and X14 on M (the walk route
   applies the matcher), X6 and X13, and the refusals X15–X18 (refusal data plus zero loose
   objects). X19. X20–X26 interop only. They pass because the walk route already holds git's
   order.
3. REFACTOR: the predicate is named; `dispatchPathspec` stays under 20 lines.

### Gate

```bash
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/unit/application/commands/add-literal-exclusion.test.ts test/unit/application/commands/add.test.ts test/unit/application/commands/add-directory-file.test.ts test/integration/pathspec-literal-exclusion-interop.test.ts test/integration/pathspec-glob-dialect-interop.test.ts test/integration/add-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/commands/add.ts test/unit/application/commands/add-literal-exclusion.test.ts test/integration/pathspec-literal-exclusion-interop.test.ts \
  && npm run check:spelling && npm run check:test-pyramid; echo "gate exit=$?"
```

Exit code must be 0. Wireit caveat: a cached `check:types` / `check:spelling` prints
`Ran 0 scripts and skipped 1`. The bare oracles are `npx tsc --noEmit -p tsconfig.json` and
`npx cspell --no-progress <touched-files>`.

### Commit

`fix(add): honour exclusions when every positive pathspec is a literal, as git does`

## Part 14 — add leaves skip-worktree entries alone on the walk and in addAll, and reports sparse-only pathspecs

### Context

R13 (walk route and `add({ all: true })`), ADR-1046 (the `sparse` field), ADR-1048 (ships as
`fix`). Part 15 covers the literal route, `--renormalize` and the interop file. Read "Fold revision —
house rules" above.

Files this part creates or edits (exactly these):
- `src/application/commands/add.ts`
- `src/application/commands/internal/pathspec-intake.ts` — new `reachesSkipWorktree`.
- `test/unit/application/commands/internal/pathspec-intake.test.ts`
- `test/unit/application/commands/add-skip-worktree.test.ts` — CREATED.
- `test/unit/application/commands/add.test.ts` — only the whole-result sites (fact 16) gain
  `sparse: []`. That is additive under ADR-1046, not a re-pin.
- `reports/api.json` — regenerated (`npm run docs:json`).

Public-surface decisions:
- `AddResult.sparse: ReadonlyArray<string>` is PUBLIC. Gate to pre-pay here: api.json. There is no
  new export name, so the barrel, facade, doc-coverage, browser-surface and README count are
  untouched. JSDoc: "Pathspecs, as typed and in argument order, that matched only skip-worktree
  entries. git lists them under 'outside of your sparse-checkout definition' and exits 1. Empty
  when none." docs/use/commands/add.md is deferred.
- `reachesSkipWorktree` is INTERNAL (pathspec-intake.ts, consumed by add.ts).

Read-only references: src/domain/git-index/index.ts (`IndexEntry.flags.skipWorktree`,
`flags.stage`), src/domain/git-index/index-path-key.ts (`escapedPathOf`, `keyOfPath`,
`indexPathKey`), test/unit/application/commands/add-index-fixtures.ts (`seedIndex(ctx, rows)` with
`{ path, text, skipWorktree: true }` writes a version-3 index with zeroed stats; `stagesOf`),
test/unit/application/commands/fixtures.ts (`seedRepo`), add.test.ts :4403 (`rewriteEntries`,
`flagged`) and :2903 (`blobExists`) as shapes to copy, and its skip-worktree rows "Given a
skip-worktree entry absent from disk and all: true" (:830) and "add over tracked entries that
ignore rules hide from the walk" (:4418), which must stay green.

Current walk route (add.ts at `039599ad`):
- `stageIgnoredWalk` (:1057) reads `existing` (one entry per path), builds
  `tracker = trackPositives(matcher, positives)` and `verdicts = verdictsOf(existing, (path) =>
  tracker.observe(path))`. That observes skip-worktree entries too, so `*.log` counts as seen
  (S2). Then `walked = await collectWalk(walkWorkingTree(ctx, { ignore }))`, then
  `refuseUnseenWalked(ctx, repoIgnore, positives, (positive) => tracker.seen(positive), walked)`,
  then `hiddenTracked` (already skips skip-worktree through `isHiddenCandidate`), then
  `stageWalkedEntries([...walked, ...hidden], …)`. The walk yields the skip-worktree file `x.log`
  as an ordinary leaf, so it is restaged with its bit cleared (S1).
- `refuseUnseenWalked` (:873) computes `unmatchedPositives(positives.filter(isNarrowerThanWholeTree), …)`,
  then throws `pathspecNoMatch(spelling)` for the first one that `namesUnignoredDiskPath` does not
  escape.
- `addAll` (:1213) stages `collectWalk(…)` plus `hiddenTracked`. `collectRemovedEntries` already
  skips skip-worktree (S11, S13 pass today).
- Every result is built by `sortedResult(tally, removed)` (:1195), by `addLiteralOnly`'s
  `{ added, modified, removed, eolNotices }`, or by `addRenormalized`'s literal object. All three
  gain `sparse` (`[]` on the literal and renormalize routes until Part 15).

Target (every function under ~20 lines, named for git's rule):

    // pathspec-intake.ts — git's matches_skip_worktree: the positive's own matcher, no exclusions
    export const reachesSkipWorktree = (positive, skipped: ReadonlyArray<IndexEntry>): boolean =>
      skipped.some((entry) => positive.entry.compiled.test(escapedPathOf(entry)))
    // add.ts
    skipWorktreeOf(existing): IndexEntry[]           // stage 0 with flags.skipWorktree
    withoutSkipWorktree(walked, existing)            // drop leaves whose existing entry has the bit
    // stageIgnoredWalk: verdicts only over entries without the bit (absent key = not matched, so
    //   collectMatchedRemovals and hiddenTracked keep leaving them); walked = withoutSkipWorktree(…)
    //   unseen = unseenWalked(positives, seenByIndexPass, walked)        query, ALL positives
    //   sparse = unseen.filter((p) => reachesSkipWorktree(p, skipped))  query
    //   await refuseUnseenWalked(ctx, repoIgnore, rest narrower than the whole tree)  command
    // addAll: walkedEntries = withoutSkipWorktree(…); never reports (no positives)

git checks skip-worktree BEFORE its "don't complain at `add .`" rule (fact 10, P3). So `sparse`
is computed over every unseen positive, the whole-tree `.` included, and only the refusal keeps the
`isNarrowerThanWholeTree` filter. CQS: the refusal stays a command that throws, and the report is a
query result that `stageIgnoredWalk` returns beside `outcomes`. `addByPathspec` passes it to
`sortedResult`.

Pins (design S; fixture: tracked `x.log`, `k`, `s.txt`; `x.log` skip-worktree and rewritten to
`changed\n`; `s.txt` rewritten to `s2\n`). The sparse advice text, for the interop file in Part 15,
is in the design's S section.

| Row | args | git |
|---|---|---|
| S1 | `.` | exit 0; `x.log` keeps the bit and its old blob; `M  s.txt` |
| S2 / S4 | `*.log` / `x*` | exit 1; reports the spelling; index unchanged; no new blob |
| S5 / S7 | `*.log s.txt` / `x* s*` | exit 1; reports `*.log` / `x*`; `M  s.txt` only |
| S8 | `*` | exit 0; no report (the spec also reached `k`, `s.txt`); `x.log` kept |
| S9 | `x.log nomatch*` | 128 naming `nomatch*`, no report, nothing written |
| S10 | `-A` | exit 0; `M  s.txt`; `x.log` kept |
| S11 / S13 | `x.log` deleted; `.` / `-A` | exit 0; `x.log` kept (pass today) |
| S12 | `x.log` deleted; `x.log` | exit 1; reports `x.log` (the literal misses on disk, so it walks) |
| P1 / P2 / P3 | fact 10 | argument order; duplicates kept; `.` reported when only skip-worktree entries match |

Expected re-pins: none. The whole-result sites gain a field; they keep their meaning.

### TDD steps

1. RED: `reachesSkipWorktree` (pathspec-intake.test.ts). Given positive `*.log` (built with
   `positiveOf`) and a stage-0 skip-worktree entry `x.log`, it returns true. Fails: not exported.
   GREEN: the helper. GUARD: positive `k*` returns false.
2. RED: S1 in add-skip-worktree.test.ts. `add(ctx, ['.'])` gives `modified: ['s.txt']`, and the
   `x.log` entry keeps `flags.skipWorktree === true` and its old id, with no blob for `changed\n`.
   Fails: `x.log` is restaged with its bit cleared (`modified: ['s.txt', 'x.log']`). GREEN:
   `withoutSkipWorktree` plus bit-free verdicts in `stageIgnoredWalk`. GUARD: S8, S11.
3. RED: S2. `add(ctx, ['*.log'])` gives `sparse: ['*.log']`, the index unchanged and no new blob.
   Fails: after step 2 the walk no longer sees `x.log`, so it refuses
   `PATHSPEC_NO_MATCH '*.log'`. GREEN: the unseen split, the `sparse` field on every result
   builder, the fact-16 sites, and `npm run docs:json`. GUARD: S4, S5, S7, S9 (refusal data, no
   new blob), S12, P1, P2, P3.
4. RED: S10. `add(ctx, [], { all: true })` gives `modified: ['s.txt']`, and `x.log` keeps the bit
   and its id. Fails: `addAll` restages it. GREEN: `withoutSkipWorktree` in `addAll`. GUARD: S13.
5. REFACTOR: name the helpers, and write comments that say why (git's sparse rule). Regenerate
   api.json if the JSDoc moved.

### Gate

```bash
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/unit/application/commands/internal/pathspec-intake.test.ts test/unit/application/commands/add-skip-worktree.test.ts test/unit/application/commands/add.test.ts test/unit/application/commands/add-directory-file.test.ts test/unit/application/commands/add-unmerged.test.ts test/unit/application/commands/add-clean-order.test.ts test/unit/application/commands/add-big-file-threshold.test.ts test/unit/application/commands/add-literal-exclusion.test.ts test/integration/add-tracked-under-ignore-interop.test.ts test/integration/pathspec-glob-dialect-interop.test.ts test/integration/add-interop.test.ts test/integration/add-all.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/commands/add.ts src/application/commands/internal/pathspec-intake.ts test/unit/application/commands/internal/pathspec-intake.test.ts test/unit/application/commands/add-skip-worktree.test.ts test/unit/application/commands/add.test.ts \
  && npm run check:spelling && npm run check:test-pyramid; echo "gate exit=$?"
```

Exit code must be 0 (wireit caveat as in Part 13). Before committing, `npm run docs:json`, then
check that `git diff --no-ext-diff --stat` lists `reports/api.json`.

### Commit

`fix(add): leave skip-worktree entries unstaged on the walk and report sparse-only pathspecs`

## Part 15 — add reports a skip-worktree literal and leaves it alone under --renormalize too

### Context

R13 (literal fast path and `--renormalize`), plus the S interop file for every S row. It needs
Part 14's `reachesSkipWorktree` and `sparse` field. Read "Fold revision — house rules" above.

Files this part creates or edits (exactly these):
- `src/application/commands/add.ts`
- `test/unit/application/commands/add-skip-worktree.test.ts`
- `test/integration/add-skip-worktree-interop.test.ts` — CREATED. `@proves` surface and
  interopSurface `add`; unique line "skip-worktree entries stay unstaged and sparse-only pathspecs
  are reported as git does". Gate it with `describe.skipIf(!GIT_AVAILABLE)`: no fixture name
  holds `*`, `?` or `\`, and wildcards appear only in arguments.

No public-surface change: the field exists, so no api.json, unless the `add` JSDoc is edited, in
which case regenerate.

Read-only references: Part 14's helpers in add.ts (`skipWorktreeOf`, `withoutSkipWorktree`, the
unseen split), src/application/commands/internal/pathspec-intake.ts (`CommandPathspec.positives`,
`PositivePathspec.spelling`, `reachesSkipWorktree`), test/integration/add-tracked-under-ignore-interop.test.ts
(`twins`, `trackedThen`, `snapshotOf`).

Current code (re-anchor by name):
- `dispatchPathspec` passes the whole `CommandPathspec` as `resolved` to
  `addLiteralOnly(ctx, resolved: ResolvedPathspec, stats, scope)`, which reads the index
  (`readExistingEntries` → `entries`) and calls `stageLiteralsOver(staging, sorted, resolved, stats)`
  → `stageLiterals(staging, literalMustMatch, stats)`. Every literal is staged, the skip-worktree
  one included (S3, S6).
- `addRenormalized` → `refuseUnseenRenormalized(ctx, positives, entries)`.
  `indexSees(positive, entries)` counts skip-worktree entries, so S15's literal is seen and nothing
  is reported. `isRecleaned` already skips skip-worktree (S14 passes).

Target:
- `addLiteralOnly` takes `CommandPathspec`. After reading the index, the literal positives whose
  body is the exact path of a stage-0 skip-worktree entry give `sparse` (their spellings, argument
  order, duplicates kept). Corrected after the fact: the planned test was
  `reachesSkipWorktree(positive, skipWorktreeOf(entries))`, on the premise that "a fast-path
  literal names a file, so it matches only itself". That premise is wrong. A literal naming a
  symlink that replaced a directory reaches the skip-worktree entries beneath it, and git stages
  their removal with no advice (design S16, fact 17). Shipped as `splitSparseLiterals`. Their bodies are dropped from `literalMustMatch` before
  `stageLiteralsOver`. When every literal is dropped, nothing is staged, and the index commit must
  leave `ls-files -s -v` unchanged (S3).
- `--renormalize`: split as on the walk route. `unseen` comes from `indexSees` over the entries
  without the bit. `sparse = unseen.filter(reachesSkipWorktree)`. The rest refuses or escapes
  through `namesOnDisk` as today. git checks skip-worktree before `file_exists`, so S15 reports
  even though `x.log` is on disk. `addRenormalized` returns `sparse`.

Pins (fixture as in Part 14): S3 `add x.log` → exit 1, reports `x.log`, index unchanged, no new blob.
S6 `add x.log s.txt` → exit 1, reports `x.log`, `M  s.txt` only. S14 `add --renormalize .` →
exit 0, `M  s.txt`, `x.log` kept. S15 `add --renormalize x.log` → exit 1, reports `x.log`, index
unchanged.

Interop (all of S1–S15 and P1–P3): each twin is built by git (commit, then
`git update-index --skip-worktree x.log`, then the rewrites). Compare `ls-files -s -v` (the
`S`/`H` tags), `status --porcelain` and the loose count. For report rows, git's exit code 1 ↔
`result.sparse.length > 0`. git's stderr equals the advice rebuilt from `sparse`:

    The following paths and/or pathspecs matched paths that exist
    outside of your sparse-checkout definition, so will not be
    updated in the index:
    <one spelling per line>
    hint: If you intend to update such entries, try one of the following:
    hint: * Use the --sparse option.
    hint: * Disable or modify the sparsity rules.
    hint: Disable this message with "git config set advice.updateSparsePath false"

S9 compares the refusal data with `fatal: pathspec 'nomatch*' did not match any files`, with no
advice.

### TDD steps

1. RED: S3 (add-skip-worktree.test.ts, plus its interop row). `add(ctx, ['x.log'])` with `x.log`
   on disk gives `sparse: ['x.log']`, an unchanged entry and no blob for `changed\n`. Fails: the
   fast path restages `x.log` with its bit cleared, and `sparse` is `[]`. GREEN: the fast-path
   split. GUARD: S6 (unit and interop).
2. RED: S15 (unit and interop). `add(ctx, ['x.log'], { renormalize: true })` gives
   `sparse: ['x.log']` and an unchanged index. Fails: `sparse` is `[]` (`indexSees` counts the
   skip-worktree entry). GREEN: the renormalize split. GUARD: S14.
3. GUARD: interop rows S1, S2, S4, S5, S7–S13 and P1–P3. They pass since Part 14.
4. REFACTOR.

### Gate

```bash
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/unit/application/commands/add-skip-worktree.test.ts test/unit/application/commands/add.test.ts test/unit/application/commands/add-literal-exclusion.test.ts test/unit/application/commands/add-directory-file.test.ts test/integration/add-skip-worktree-interop.test.ts test/integration/add-tracked-under-ignore-interop.test.ts test/integration/pathspec-glob-dialect-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/commands/add.ts test/unit/application/commands/add-skip-worktree.test.ts test/integration/add-skip-worktree-interop.test.ts \
  && npm run check:spelling && npm run check:test-pyramid; echo "gate exit=$?"
```

### Commit

`fix(add): report a skip-worktree literal instead of restaging it, under --renormalize too`

## Part 16 — checkout leaves skip-worktree paths out of a path restore

### Context

R14. Independent of Parts 13–15 except for the shared working tree. Read "Fold revision — house
rules" above.

Files this part creates or edits (exactly these):
- `src/application/commands/checkout.ts`
- `test/unit/application/commands/checkout-skip-worktree.test.ts` — CREATED (memory adapter).
- `test/integration/checkout-skip-worktree-interop.test.ts` — CREATED. `@proves` surface and
  interopSurface `checkout`; unique line "a path restore leaves skip-worktree paths as git does".

No public-surface change (behaviour only).

Read-only references: test/unit/application/commands/checkout.test.ts :40 (`refusalOf`), :48
(`seedWithBranches`: `init`, `add`, `commit` with a fixed `author`), its sparse rows (:1318–:1430,
switch-side, must stay green). Also test/unit/application/primitives/fixtures.ts
(`serializeIndexFixtureAsync`) to rewrite the index with `flags.skipWorktree` set, as add.test.ts
:4403 `rewriteEntries` does. src/domain/commands/error.ts :595
(`pathspecNoMatch(pattern, ...others)` → `{ code, pattern, patterns }`),
src/domain/git-index/index-path-key.ts (`indexPathKey`, `IndexPathKey`; checkout.ts imports
`escapedPathOf` and `IndexPath` from it at :11).

Current code (checkout.ts at `039599ad`): `restoreUnderIndexLock` (:372) takes the lock, then
`currentIndex = await readIndex(ctx)`, then
`universe = await enumerateSourcePaths(ctx, source, currentIndex)` (:482; the index entries, or
the source tree's non-directory entries). Then `selectFromUniverse(pathspec, universe)` (:394) →
`refuseUnmatched(unmatched)` (:408) → `materializePathRestoreFromIndex` /
`materializePathRestoreLocked` with `pathSet`.

Target: a pure helper `outsideSkipWorktree(universe, currentIndex)`. It builds the
`Set<IndexPathKey>` of `currentIndex.entries` that carry `flags.skipWorktree` (key with
`indexPathKey`, so a lossy name compares through the same view `selectFromUniverse` uses), then
drops every universe entry whose `indexPathKey` is in the set. Apply it to the universe whatever
the source. `refuseUnmatched` then refuses SC1–SC4 and SC9–SC12, and neither `materializePathRestore*` function sees
the path (SC5–SC8). `materializeTree`'s own skip-worktree carry is unchanged.

Pins (design SC; fixture: tracked `sw.txt`, `n.txt` committed; `sw.txt` skip-worktree; `sw.txt` →
`sw-dirty`, `n.txt` → `n-dirty`. Each row runs with no source and with `HEAD`, same result):

| Rows | args | git |
|---|---|---|
| SC1/SC2 | `sw*` | exit 1 `error: pathspec 'sw*' did not match any file(s) known to git`; both files dirty; `S` kept |
| SC3/SC4 | `sw.txt` | same, for `'sw.txt'` |
| SC5/SC6 | `*.txt` | exit 0; `n.txt` restored, `sw.txt` still `sw-dirty`, `S` kept |
| SC7/SC8 | `.` | as SC5 |
| SC9/SC10 | `sw.txt n.txt` | exit 1, error for `'sw.txt'`; both still dirty |
| SC11/SC12 | `sw* n*` | exit 1, error for `'sw*'`; both still dirty |

tsgit's refusal: `PATHSPEC_NO_MATCH` with `patterns` equal to every unmatched spelling (git prints
one `error:` line per unmatched pathspec). Interop compares file bytes, `ls-files -v` and the
patterns against git's `error:` lines.

### TDD steps

1. RED: SC1 (checkout-skip-worktree.test.ts, plus the SC1 interop row). `checkout(ctx, { paths:
   ['sw*'] })` refuses with `pathspecNoMatch('sw*').data`, `sw.txt` still reads `sw-dirty`, and its
   entry keeps `flags.skipWorktree`. Fails: today `sw.txt` is restored to `sw` and its bit cleared.
   GREEN: `outsideSkipWorktree` in `restoreUnderIndexLock`.
2. GUARD (unit and interop): SC2 (`source: 'HEAD'`), SC3–SC12. They pass because the filter applies
   to both sources.
3. REFACTOR.

### Gate

```bash
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/unit/application/commands/checkout-skip-worktree.test.ts test/unit/application/commands/checkout.test.ts test/integration/checkout-skip-worktree-interop.test.ts test/integration/pathspec-glob-dialect-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/commands/checkout.ts test/unit/application/commands/checkout-skip-worktree.test.ts test/integration/checkout-skip-worktree-interop.test.ts \
  && npm run check:spelling && npm run check:test-pyramid; echo "gate exit=$?"
```

### Commit

`fix(checkout): leave skip-worktree paths out of a path restore, as git does`

## Part 17 — add reports the ignored entries a pathspec reaches on the walk, and force is git's -f there

### Context

R16 on the walk route and in `addAll`. Covers ADR-1046 (the `ignored` field; it retires
ADR-1045's ignored-literal interim), ADR-1047 (`force`) and ADR-1048 (`fix`). Part 18 covers the
literal fast path. Read "Fold revision — house rules" above.

Files this part creates or edits (exactly these):
- `src/application/commands/add.ts`
- `test/unit/application/commands/add.test.ts`. Two re-pins (below), plus `ignored: []` on the
  whole-result sites (fact 16).
- `test/unit/application/commands/add-ignored-report.test.ts` — CREATED (memory adapter).
- `test/integration/add-ignored-report-interop.test.ts` — CREATED. `@proves` surface and
  interopSurface `add`; unique line "add reports ignored entries a pathspec reaches as git does".
  Gate it with `describe.skipIf(!GIT_AVAILABLE)`.
- `reports/api.json` — regenerated.

Public-surface decisions:
- `AddResult.ignored: ReadonlyArray<FilePath>` is PUBLIC. JSDoc: "Ignored entries a positive
  pathspec reached, sorted and deduplicated. git lists them under 'The following paths are ignored
  by one of your .gitignore files' and exits 1. A tracked path is never listed. Always empty with
  `force`."
- The `AddOptions.force` JSDoc changes from a declared no-op to "git's `-f`: no ignore rule applies,
  on any route." It is PUBLIC; api.json is the only gate to pre-pay, and
  docs/use/commands/add.md is deferred.
- `NEVER_IGNORED`, the collector and `repoIgnoreOf` are INTERNAL (add.ts module scope).

Read-only references: src/domain/pathspec/wildcard.ts :24 (`globSpecialIndex(body)`, -1 when the
body holds no `* ? [ \`), src/application/commands/internal/add-ignore.ts (`IgnorePredicate =
(path, isDirectory) => boolean | Promise<boolean>`), src/application/commands/internal/build-ignore-evaluator.ts
(`buildRepoIgnorePredicate`), src/application/commands/internal/resolve-pathspec.ts
(`namesDirectoryOnly`), test/integration/pathspec-glob-dialect-interop.test.ts :515 / :545.

Current code (re-anchor by name):
- `addByPathspec` builds `repoIgnore = await buildRepoIgnorePredicate(ctx)` before taking the lock
  (keep that order), then calls `stageIgnoredWalk(ctx, repoIgnore, …)`, which builds
  `ignore = withPathspec(repoIgnore, matcher, unmergedStages)`. `withPathspec` calls
  `ignore(path, isDirectory)` first for every directory and leaf.
- `refuseUnseenWalked(ctx, repoIgnore, …)` → `namesUnignoredDiskPath(ctx, repoIgnore, positive)`.
  An unseen literal naming an ignored path is refused (the ADR-1045 interim), through
  `ignoredWithAncestors` (:915).
- `addInScope` reads `opts.all` / `opts.renormalize`. `opts.force` is read nowhere.
  `addAll(ctx, ignoreOverride?, givenScope?)`.

Target:
- `NEVER_IGNORED: IgnorePredicate = () => false`.
  `repoIgnoreOf(ctx, opts) = opts.force === true ? NEVER_IGNORED : buildRepoIgnorePredicate(ctx)`.
  The predicate is built only when `force` is off. `dispatchPathspec` receives `opts`, and
  `addByPathspec` takes the predicate instead of building it. `addInScope` passes
  `opts.force === true ? NEVER_IGNORED : undefined` to `addAll`. The walk's .git exclusion
  (`isDotGitWalkEntry`) is not an ignore rule and stays.
- Escape: `namesUnignoredDiskPath` becomes "names something on disk". Its stat must exist, and a
  trailing-slash literal must name a directory. Drop the `repoIgnore` parameter and the
  ignored-literal branch, then delete `ignoredWithAncestors` (dead; Part 18 adds
  `firstIgnoredOf`). Bodies holding `\` still never probe (`probesDisk`).
- Collector (decision candidate 12 A), built inside `stageIgnoredWalk`. It wraps `repoIgnore`,
  and the wrapper goes into `withPathspec`. Each positive's no-wildcard prefix `P` is computed once:
  `index === -1 ? body : body.slice(0, index)` over `positive.entry.body`. When
  `repoIgnore(path, isDirectory)` is true, `existing` holds no entry at `keyOfPath(path)` (fact 13,
  directories and leaves alike), and some `P === path || P.startsWith(path + '/')`, the wrapper
  records `path` and returns the verdict unchanged. The walk prunes at the shallowest ignored
  directory, so a literal like 'd/q.txt' records `d` with no ancestor loop. `.` has `P = ''`
  and never reports. `stageIgnoredWalk` returns `ignored` = the recorded paths, deduplicated and
  sorted (`[...set].sort()`, as `sortedResult` sorts). On a refusal it throws first, so nothing is
  reported (I5, I6, I24). `addAll` (no positives) and `addRenormalized` always return
  `ignored: []`; `addLiteralOnly` does until Part 18.

Pins. Fixture I: .gitignore = `*.log` and `'d/'`; untracked `x.log`, `y.log`, `real.txt`, 'd/q.txt'.
Fixture D: tracked 'd/x.txt' and `k` committed, then .gitignore = `'d/'`, 'd/x.txt' rewritten,
untracked 'd/new.txt'. Fixture T: tracked `t.log` and `k`, then .gitignore = `*.log`, `t.log`
rewritten, untracked `u.log`. These walk-route rows belong here: I5 (128 `nomatch*`, no report),
I6 (128 `missing`), I7 (`d` → reports `d`, nothing staged), I8 (`'d/'` → `d`), I10 (`x.log *.txt`
→ reports `x.log`, stages `real.txt`), I11 (128 `x.lo?`), I13 (`-f *.log` → `x.log y.log`, fact 9),
I14 (`-f .` → .gitignore, 'd/q.txt', `real.txt`, `x.log`, `y.log`), I15 (`-f d` → 'd/q.txt'), I16
(`-A -f` → as I14), and on D: I20 (`d` → reports `d`, `M` on 'd/x.txt'), I21 (`'d/*.txt'`), I22
(`d*`), I23 (`'d/x*'`) all report `d` and stage 'd/x.txt'. I24 (`'d/n*'` → 128). I25 (`?` → nothing),
I26 (`*` → `A .gitignore`, `M` 'd/x.txt'), and on T: I27 (`*.log` → `M  t.log`, no report), I28
(`.`), I30 (`?.log`). Plus fact 11's P4 and P5. The report text git prints is:

    The following paths are ignored by one of your .gitignore files:
    <one path per line>
    hint: Use -f if you really want to add them.
    hint: Disable this message with "git config set advice.addIgnoredFile false"

Interop: twins, then compare `ls-files -s`, `status --porcelain --untracked-files=all`, the loose
count, and on report rows git's exit 1 ↔ `ignored.length > 0` with git's stderr equal to the
rebuilt text. A tsgit `{ force: true }` ↔ git `-f`. B16 is I20.

Expected re-pins in add.test.ts (each encoded ADR-1045's interim, which ADR-1046 supersedes):
- "Given a missing literal and a gitignored existing literal" (`keep.txt` ignored, `gone.txt`
  missing). Re-pin to I6: the refusal names `gone.txt`.
- "add of a literal beneath an ignored directory" ('build/x' with `k*`). Re-pin to fact 11's P4:
  no refusal, `modified: ['k']`, `ignored: ['build']`.

### TDD steps

1. RED: I10 (add-ignored-report.test.ts, plus the interop row). `add(ctx, ['x.log', '*.txt'])`
   on fixture I gives `added: ['real.txt']` with no refusal. Fails: `PATHSPEC_NO_MATCH 'x.log'`
   (the interim). GREEN: the escape drops the ignored branch; delete `ignoredWithAncestors`.
   Re-pin the two add.test.ts rows above (the P4 row asserts `ignored` from step 2 on). GUARD:
   I5, I6, I11, I24 (refusal data, zero loose objects).
2. RED: I7. `add(ctx, ['d'])` gives `ignored: ['d']` and an empty index. Fails: `result.ignored`
   is undefined (no such field). GREEN: the collector, the field on every result builder, the
   fact-16 sites, `npm run docs:json`. GUARD: I8, I10's `ignored: ['x.log']`, I20–I23, I25–I28,
   I30, P4, P5, and a tracked gitlink the walk prunes (index entry `sub` with mode
   `FILE_MODE.GITLINK`, a 'sub/f' file, .gitignore `sub`, `add(ctx, ['sub'])` gives
   `ignored: []`, fact 13).
3. RED: I13. `add(ctx, ['*.log'], { force: true })` gives `added: ['x.log', 'y.log']` and
   `ignored: []`. Fails: `PATHSPEC_NO_MATCH '*.log'` (force unread). GREEN: `repoIgnoreOf` on the
   walk route. GUARD: I14, I15.
4. RED: I16. `add(ctx, [], { all: true, force: true })` stages .gitignore, 'd/q.txt',
   `real.txt`, `x.log`, `y.log`. Fails: only .gitignore and `real.txt`. GREEN: `addInScope`
   passes `NEVER_IGNORED` to `addAll`.
5. REFACTOR: the force JSDoc, comments that say why, `npm run docs:json`.

### Gate

```bash
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/unit/application/commands/add-ignored-report.test.ts test/unit/application/commands/add.test.ts test/unit/application/commands/add-skip-worktree.test.ts test/unit/application/commands/add-literal-exclusion.test.ts test/unit/application/commands/add-directory-file.test.ts test/unit/application/commands/add-unmerged.test.ts test/integration/add-ignored-report-interop.test.ts test/integration/add-tracked-under-ignore-interop.test.ts test/integration/pathspec-glob-dialect-interop.test.ts test/integration/add-skip-worktree-interop.test.ts test/integration/add-interop.test.ts test/integration/add-all.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/commands/add.ts test/unit/application/commands/add.test.ts test/unit/application/commands/add-ignored-report.test.ts test/integration/add-ignored-report-interop.test.ts \
  && npm run check:spelling && npm run check:test-pyramid; echo "gate exit=$?"
```

### Commit

`fix(add): report ignored entries a pathspec reaches and honour force on the walk, as git does`

## Part 18 — add reports an ignored untracked literal instead of staging it; force still stages it

### Context

R16 on the literal fast path. Covers ADR-1046 and ADR-1047, and ADR-1048: this is the behaviour
change a consumer may notice, so the commit subject names it. It needs Part 17's `ignored` field,
`NEVER_IGNORED` and `repoIgnoreOf`. Read "Fold revision — house rules" above.

Files this part creates or edits (exactly these):
- `src/application/commands/add.ts`, including the `add` JSDoc. Its "Literal-path mode" bullet says
  every path is staged; it must now say that an untracked path the ignore rules exclude is reported
  in `ignored` instead, unless `force`.
- `test/unit/application/commands/add.test.ts` — one re-pin (below).
- `test/unit/application/commands/add-ignored-report.test.ts`
- `test/integration/add-ignored-report-interop.test.ts`
- `reports/api.json` — regenerated (the `add` JSDoc is public).

Public-surface decisions: no new symbol is public. `firstIgnoredOf` and `firstIgnoredAncestorOf`
are INTERNAL (add.ts). The `add` JSDoc change is the only public delta, and api.json is its gate.

Read-only references: Part 17's `repoIgnoreOf`, the collector's prefix rule and
`SEPARATOR = '/'` in add.ts, test/bench/add.bench.ts (fact 15: the two rows that measure this path
already exist).

Current code (re-anchor by name): `dispatchPathspec` → `literalStats` (every literal `lstat`s as a
file or symlink) → `addLiteralOnly(ctx, resolved, stats, scope)`. It never consults ignore rules,
so I1–I4, I9, I18, I19 and I29 stage the ignored file, and I17 and I29 report nothing.

Target:
- `firstIgnoredAncestorOf(repoIgnore, path)`: the shallowest proper ancestor directory that
  `repoIgnore(ancestor, true)` ignores, else `undefined`. `firstIgnoredOf(repoIgnore, path,
  isDirectory)`: that ancestor, else `path` itself when `repoIgnore(path, isDirectory)`. Two
  functions, no boolean parameter.
- The fast path gets `repoIgnore = await repoIgnoreOf(ctx, opts)`. With `force` it is
  `NEVER_IGNORED`, so nothing is built and nothing is reported. After reading the index, for each
  literal in `literalMustMatch`:
  - a literal whose path holds an index entry (tracked) reports `firstIgnoredAncestorOf` and is
    still staged (I17; B13: a tracked ignored file itself is never reported);
  - an untracked literal reports `firstIgnoredOf(path, false)` and is dropped from staging when it
    has one (I1, I9 → `d`).
  `ignored` is deduplicated and sorted, as in Part 17. A skip-worktree literal is tracked: Part 15
  already drops it into `sparse`.
- Hot path: the fast path now builds the repo ignore predicate unless `force` (I17 makes that
  necessary even for a tracked literal). Fact 15: the session runs `npm run bench:ab` on the rows
  "When add() re-stages one modified tracked file" and "When add() stages one new file" after this
  commit. Do not run it inside the part.

Pins (fixtures I, D, T as in Part 17):

| Row | args | git |
|---|---|---|
| I1 | `x.log` | 1 · reports `x.log` · index empty · 0 loose |
| I2 / I3 | `x.log real.txt` / `real.txt x.log` | 1 · `x.log` · `real.txt` staged |
| I4 | `y.log x.log` | 1 · `x.log`, `y.log` sorted · index empty |
| I9 | 'd/q.txt' | 1 · `d` (the ignored ancestor) · index empty |
| I12 | `-f x.log` | 0 · stages `x.log` |
| I17 | D · 'd/x.txt' | 1 · `d` · `M` on 'd/x.txt' |
| I18 / I19 | D · 'd/new.txt' / both | 1 · `d` · nothing / only 'd/x.txt' staged |
| I29 | T · `t.log u.log` | 1 · `u.log` · `M  t.log` |
| B13 | tracked ignored `x.log` modified · `x.log` | 0 · no report · `M  x.log` |

B3l = I1 and B3m = I2: one interop row each.

Expected re-pin in add.test.ts: "Given a literal path that .gitignore would exclude" (~:1728). It
pins the literal bypass that ADR-1046/1048 retire. Re-pin it to I1's shape: `added: []`,
`ignored: ['ignored.txt']`, empty index.

### TDD steps

1. RED: I1 (add-ignored-report.test.ts, plus the I1 interop row). `add(ctx, ['x.log'])` on
   fixture I gives `added: []`, `ignored: ['x.log']` and no blob for `x.log`'s content. Fails: the
   fast path stages it. GREEN: the fast path takes `repoIgnoreOf(ctx, opts)` (Part 17), and
   untracked literals go through `firstIgnoredOf`. Re-pin the add.test.ts row. GUARD: I2, I3, I4,
   I9, I18, I19, I29 (`t.log` has no ignored ancestor), B13, and I12 (`force` yields
   `NEVER_IGNORED`, so `x.log` is staged with `ignored: []`).
2. RED: I17 on fixture D. `add(ctx, ['d/x.txt'])` gives `modified: ['d/x.txt']` and
   `ignored: ['d']`. Fails: `ignored` is `[]`, because tracked literals skip the ignore check.
   GREEN: tracked literals report `firstIgnoredAncestorOf` and stay staged.
3. GUARD interop rows: I2, I3, I4, I9, I12, I17 (written with step 2, before its GREEN), I18, I19,
   I29, B13.
4. REFACTOR: the `add` JSDoc, then `npm run docs:json`.

### Gate

```bash
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/unit/application/commands/add-ignored-report.test.ts test/unit/application/commands/add.test.ts test/unit/application/commands/add-skip-worktree.test.ts test/unit/application/commands/add-literal-exclusion.test.ts test/unit/application/commands/add-directory-file.test.ts test/unit/application/commands/add-clean-order.test.ts test/unit/application/commands/add-big-file-threshold.test.ts test/integration/add-ignored-report-interop.test.ts test/integration/add-skip-worktree-interop.test.ts test/integration/pathspec-glob-dialect-interop.test.ts test/integration/add-interop.test.ts test/integration/eol-conversion-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/commands/add.ts test/unit/application/commands/add.test.ts test/unit/application/commands/add-ignored-report.test.ts test/integration/add-ignored-report-interop.test.ts \
  && npm run check:spelling && npm run check:test-pyramid; echo "gate exit=$?"
```

### Commit

`fix(add): report an ignored untracked literal instead of staging it; force still stages it`

## Part 19 — add stages a gitlink whose submodule checkout moved; a broken one refuses

### Context

R15. Covers ADR-1049 (HEAD read through `<path>/.git` and a child Context) and ADR-1050 (a
`<path>/.git` that leads to no repository refuses `NOT_A_REPOSITORY { path }` before any write).
Decision candidates 7, 8 and 9 apply. Read "Fold revision — house rules" above.

Files this part creates or edits (exactly these):
- `src/application/commands/add.ts`
- `src/application/commands/internal/gitlink-head.ts` — CREATED.
- `src/application/primitives/internal/submodule-context.ts`. Extract the body of the private
  `buildChildContext(ctx, name, treeRelPath)` into an exported
  `deriveGitlinkContext(ctx, gitDir, treeRelPath)`; `buildChildContext` then calls it with
  the modules/<name> gitdir. Behaviour is unchanged: `refStorage: 'files'`, `promisor` and
  `hooks` dropped, a fresh session through `deriveContext`.
- `src/application/primitives/internal/repo-state.ts` — export the existing `hasUsableHead(ctx)`
  (:142, git's `validate_headref`: a symlinked HEAD by its link text, a file by its content).
- `test/unit/application/commands/add-gitlink.test.ts` — CREATED (memory adapter).
- `test/integration/add-gitlink-interop.test.ts` — CREATED. `@proves` surface and interopSurface
  `add`; unique line "add stages a moved gitlink and refuses a broken one as git does". Gate it
  with `describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')` (GL15 needs a symlink).

Public-surface decisions: every new symbol is INTERNAL (`gitlinkHeadOf`, `deriveGitlinkContext`,
the `hasUsableHead` export, `stagedGitlinks`). No type or JSDoc change, so no api.json.
`NOT_A_REPOSITORY` already exists (src/domain/repository/error.ts :25 `notARepository(path)`), so
no error-union member is added.

Read-only references: src/domain/worktree/gitfile.ts :30 (`parseGitfilePointer(content)` →
`{ kind: 'ok', path } | { kind: 'invalid-format' } | { kind: 'no-path' }`),
src/domain/worktree/resolve-path.ts (`resolveWorktreePath(cwd, input)`: an absolute input wins,
a relative one is joined and collapsed), src/application/primitives/resolve-ref.ts :105
(`resolveRefOrMissing(ctx, 'HEAD')` → `undefined` for an unborn HEAD),
src/application/primitives/internal/head-file.ts :131 (`validateHead`),
src/application/primitives/internal/clean-order.ts :173 (`Settled<R>`) and :200
(`firstFailureOrValues`), src/application/primitives/internal/concurrency.ts :53
(`boundedMapFor`: rejection propagates by timing, hence candidate 9),
src/application/commands/submodule.ts (`stageSubmodule`: the
`indexEntryFromStat(stat, FILE_MODE.GITLINK, head, path)` shape), add.test.ts :3917 (a hand-built
gitlink `IndexEntry` serialized with `serializeIndexFixtureAsync`; copy the shape),
test/integration/submodule-init-sync-deinit-interop.test.ts :40
(`git -c protocol.file.allow=always`).

Current code (re-anchor by name): no gitlink reaches staging. The walk's embedded-repository gate
yields nothing under 'sub'. `isHiddenCandidate` excludes `FILE_MODE.GITLINK`, and
`presentOnDisk` keeps the entry. `--renormalize` excludes gitlinks (`RECLEANED_MODES`; GL22 stays
green). The equivalence comment in `restagesAsIs` ("deriveWorkingMode never returns GITLINK")
stays true, because gitlinks never go through `stagePromisorChecked`.

Target:

    // gitlink-head.ts — the commit checked out at a gitlink, undefined when nothing is
    export const gitlinkHeadOf = async (ctx, path: FilePath): Promise<ObjectId | undefined>
      // lstat <workDir>/<path>/.git; FILE_NOT_FOUND -> undefined (GL13: deinit left it empty)
      // a directory -> gitDir is that directory, shown as path + '/.git'
      // otherwise read it as a gitfile: parseGitfilePointer; not 'ok' -> notARepository(path + '/.git') (G1)
      //   'ok' -> gitDir = resolveWorktreePath(joinPath(workDir, path), pointer)
      //           shown = pointer when absolute (G4), else path + '/' + pointer (GL20, GL21)
      // child = deriveGitlinkContext(ctx, gitDir, path)
      // !(await hasUsableHead(child)) -> notARepository(shown)        (GL20, GL21, G2, G3, G4)
      // return resolveRefOrMissing(child, 'HEAD')                     (GL16: unborn -> undefined)
    // add.ts
    const stagedGitlinks = async (ctx, existing, verdicts): Promise<WalkOutcome[]>
      // candidates: stage 0, FILE_MODE.GITLINK, !flags.skipWorktree (GL23), !isLossy, verdict matched
      // boundedMapFor(ctx, 'ioBound', candidates, settle(movedGitlinkOf)) then firstFailureOrValues
    const movedGitlinkOf = async (ctx, entry): Promise<WalkOutcome | undefined>
      // stat = lstatOrBeneathFile; not a real directory -> undefined (GL14, GL15: the walk stages it)
      // head = gitlinkHeadOf; undefined or head === entry.id -> undefined (GL11, GL12, GL16)
      // { kind: 'modified', path, entry: indexEntryFromStat(stat, FILE_MODE.GITLINK, head, path) }

`stageIgnoredWalk` calls `stagedGitlinks(ctx, existing, verdicts)` after `refuseUnseenWalked` and
before `stageWalkedEntries`, so a refusal leaves zero loose objects (ADR-1035).
`addAll` calls it with the `indexVerdicts(WHOLE_TREE_MATCHER, existing)` it already builds for
`hiddenTracked`: hoist that value into a const. Prepend the outcomes to the staged ones before
`tallyWalkOutcomes`, so `modified`, `restagedPaths` and the index commit need no new code. Literal
routing needs nothing: `literalStats` sends a directory literal ('sub', 'sub/') to the walk. The
security review checks that a pointer outside the work tree is followed read-only; nothing here
writes through the child context. Every path segment comes from the index entry or the gitfile, as
in git.

As shipped (corrected after the review round, facts 19–23). The target above landed in Part 19.
The review fixes then added these rules:
- Reftable: the child's ref backend is its own `extensions.refStorage`, read from its common
  dir's config (primitives/internal/gitlink-ref-storage.ts `refStorageOf`), not the fixed
  `refStorage: 'files'` above. `deriveGitlinkContext` takes `fs`, `commonDir` and `refStorage`
  options.
- 'sub/' reaches the gitlink only through the directory form of the matcher (`selectsGitlink`
  tests `<path>/` for a directory-only body). The bare `verdict matched` filter missed it (fact
  18).
- `<path>/.git` as a symlink is followed with a stat, and a dangling or looping one is "nothing
  checked out". `commondir` is honoured. A gitdir whose common dir lacks objects/ or refs/
  refuses `NOT_A_REPOSITORY`. Once the repository is usable, an unresolvable HEAD keeps the
  recorded commit. The repository-format scan is shared with the main repository through
  src/domain/config/repository-format-scan.ts. None of this was in this part. Each rule landed
  in a review fix commit (`b14394b3`, `21ef755a`, `30cc573f`, `e9d58e0b`, `a0296ca4`,
  `b67bcb41`, `8c464a5c`). The rows are design GL24–GL51.

Pins (design GL plus fact 12). Fixture: an upstream repo with one commit, and a superproject
holding `k` and `git -c protocol.file.allow=always submodule add <up> sub`, committed, with commit
dates pinned to `@1700000000 +0000`. "Moved" means a new commit inside 'sub'.

| Rows | Setup · args | git |
|---|---|---|
| GL1–GL6 | moved · `.` / `sub` / `s*` / `-A` / `'sub/'` / `sub k` | 0 · `M  sub` at the new HEAD (GL6 also stages `k`) |
| GL7–GL10 | moved, a `sub` ignore rule · `.` / `sub` / `s*` / `-A` | 0 · `M  sub`, no ignored report (fact 13) |
| GL11 / GL12 | file edited inside, HEAD not moved / untouched · the four | 0 · unchanged |
| GL13 | `submodule deinit -f sub` | 0 · unchanged |
| GL14 / GL15 | 'sub' replaced by a file / a symlink to `k` | 0 · `T  sub` (passes today) |
| GL16 | 'sub' replaced by `git init` with no commit | 0 · unchanged |
| GL17 / GL18 / GL19 | embedded clone (a .git directory, no .gitmodules) / `--name other` / an unrelated repo with one commit | 0 · the repository's HEAD staged |
| GL20 / GL21 | pointer to '../.git/modules/nowhere' / the module HEAD is `garbage` | 128 · `NOT_A_REPOSITORY` with path 'sub/../.git/modules/nowhere' / 'sub/../.git/modules/sub' · unchanged |
| GL22 | moved · `--renormalize .` | 0 · unchanged |
| GL23 | moved, `update-index --skip-worktree sub` · `.` | 0 · `S` unchanged |
| G1–G5 | fact 12 | G1–G4 refuse with the path git prints; G5 (`k`, `k*`) succeed |

Interop: build `up` once per test with pinned dates, and clone it into both twins so the ids
match. Compare `ls-files -s` (plus `-v` for GL23), git's exit code, and for refusals the
`NOT_A_REPOSITORY` path against the path in git's `fatal:` line. Unit fixture (memory adapter):
'sub/.git' holds `gitdir: ../.git/modules/sub` plus a newline; under the gitdir, a HEAD holds
`ref: refs/heads/main` plus a newline, and refs/heads/main holds a 40-hex id. The index is a
hand-built gitlink entry 'sub' at another id. A directory-.git variant covers GL17.

### TDD steps

1. RED: GL1 (add-gitlink.test.ts, plus the interop row). `add(ctx, ['.'])` gives
   `modified: ['sub']` and the 'sub' entry at the module HEAD id with mode `FILE_MODE.GITLINK`.
   Fails: `modified: []`, because gitlinks never stage. GREEN: `gitlinkHeadOf` WITHOUT the
   usable-HEAD check (a pointer that does not parse, or a HEAD that does not resolve, leaves the
   entry), plus `deriveGitlinkContext` and `stagedGitlinks` in `stageIgnoredWalk`. GUARD: GL2, GL3,
   GL5, GL6, GL7–GL9, GL11–GL17, GL18, GL19, GL22, GL23, and G5.
2. RED: GL4. `add(ctx, [], { all: true })` gives `modified: ['sub']`. Fails: `addAll` never runs
   the step. GREEN: `addAll` calls `stagedGitlinks`. GUARD: GL10.
3. RED: GL20. `add(ctx, ['.'])` throws `NOT_A_REPOSITORY` with
   `path: 'sub/../.git/modules/nowhere'`; also lay down an untracked `n` and prove its blob was not
   written. Fails: no `NOT_A_REPOSITORY` (the entry is left unchanged, or a
   different error surfaces from the missing gitdir). GREEN: export `hasUsableHead`, add the
   usable-HEAD check, and refuse a pointer that does not parse; settle the probes and use
   `firstFailureOrValues`. GUARD: GL21, G1, G2, G3, G4.
4. REFACTOR: comments that say why (git's `resolve_gitlink_ref` through `<path>/.git`).

### Gate

```bash
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/unit/application/commands/add-gitlink.test.ts test/unit/application/commands/add.test.ts test/unit/application/commands/add-ignored-report.test.ts test/unit/application/commands/add-skip-worktree.test.ts test/unit/application/primitives/internal/submodule-context.test.ts test/unit/application/commands/submodule.test.ts test/integration/add-gitlink-interop.test.ts test/integration/add-tracked-under-ignore-interop.test.ts test/integration/submodule-init-sync-deinit-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/commands/add.ts src/application/commands/internal/gitlink-head.ts src/application/primitives/internal/submodule-context.ts src/application/primitives/internal/repo-state.ts test/unit/application/commands/add-gitlink.test.ts test/integration/add-gitlink-interop.test.ts \
  && npm run check:spelling && npm run check:test-pyramid; echo "gate exit=$?"
```

### Commit

`fix(add): stage a gitlink whose submodule checkout moved, and refuse a broken one, as git does`

## Part 20 — the working-tree walk yields a backslash-named entry on POSIX hosts

### Context

R17 for the walk. Covers ADR-1051 (decision candidate 18 A): `validateWalkedEntryPath` refuses `\`
only under `windowsPathSyntax`. Every `walkWorkingTree` consumer inherits the change: `add`,
`status`, `stash`, the snapshot enumerator and the repository facade. Read "Fold revision — house
rules" above.

Files this part creates or edits (exactly these):
- `src/domain/working-tree-path.ts`
- `test/unit/domain/working-tree-path.test.ts`
- `src/application/primitives/walk-working-tree.ts` — the one call site, in `stepEntry` (:102 at
  `039599ad`).
- `test/unit/application/primitives/walk-working-tree.test.ts`
- `test/integration/pathspec-backslash-interop.test.ts` — extend the POSIX block (:31) and its
  header's unique line. The Windows block (:76) is unchanged, because NTFS cannot hold `a\b`; the
  unit row pins the Windows walk refusal.

Public-surface decisions: `PathSyntaxHost` and the new `validateWalkedEntryPath` signature are
INTERNAL. src/domain/working-tree-path.ts is not re-exported by src/domain/index.ts or the package
entry. No api.json.

Read-only references: src/ports/context.ts :358 (`windowsPathSyntax?: boolean`; a `Context`
satisfies the host shape), src/application/commands/internal/pathspec-intake.ts (`PathspecHost`,
the same shape on the application side; the domain cannot import it),
src/application/primitives/internal/index-path-rules.ts (`validateIndexPath` already admits `\` on
POSIX, so `add` stages the entry), test/integration/status-interop.test.ts (how status output is
compared with `git status --porcelain`).

Current code (working-tree-path.ts at `039599ad`): `validateWorkingTreePath` (:28) and
`validateWalkedEntryPath` (:52) both call `rejectInputShape` (:71), whose
`if (input.includes('\\')) reject(input)` refuses on every host. Keep the existing
equivalent-mutant comments on the other guards in `rejectInputShape` intact, and add none.

Target:

    /** What path validation reads of the host: a Context satisfies it. */
    export interface PathSyntaxHost { readonly windowsPathSyntax?: boolean }
    const rejectBackslash = (input) => { if (input.includes(BACKSLASH)) reject(input) }
    // rejectInputShape loses the backslash test.
    // validateWorkingTreePath calls rejectBackslash itself (unchanged for every caller).
    export const validateWalkedEntryPath = (input: string, host: PathSyntaxHost): FilePath
      // rejectBackslash only when host.windowsPathSyntax === true, then the rest as today

The host parameter is required (types over runtime). The walk passes `config.ctx`
(`validateWalkedEntryPath(path, config.ctx)`), which is one property read per entry, so `WalkConfig`
needs no new field. In the test file, `expectWalkedEntryReject` and every direct call pass a POSIX
host `{}`.

Pins (design W; POSIX, run on macOS APFS). Untracked fixture: files `a\b` (content `a`), `ab`,
`k`. Tracked fixture: the same three committed, then `a\b` rewritten to `dirty`. `ls-files` quotes
the name as `"a\\b"`.

| Row | Fixture · command | git |
|---|---|---|
| W1 / W5 | untracked · `add .` / `add -A` | 0 · `a\b`, `ab`, `k` staged |
| W2 | untracked · `add 'a\\b'` (escaped) | 0 · `a\b` |
| W3 | untracked · `add 'a?'` | 0 · `ab` (today the walk aborts first) |
| W4 (= E1) | untracked · `add 'a\b'` | 0 · `a\b`, `ab` |
| D8b | files `a\` and `ab` · `add 'a\'` | 0 · `a\` |
| W6 | untracked · `add ab` | 0 · `ab` (literal fast path; passes today) |
| W7 | untracked · `status --porcelain` | `?? "a\\b"`, `?? ab`, `?? k` |
| W12 / W13 | tracked · `checkout -- 'a\\b'` / `'a?'` | `a\b` back to `a` / stays `dirty` (pass today) |
| W14 / W15 | tracked · `grep -l . -- 'a??'` / `grep -l .` | lists `a\b` (pass today) |
| W16 | tracked · `status --porcelain` | ` M "a\\b"` |

Today tsgit throws `PATHSPEC_OUTSIDE_REPO { path: 'a\\b' }` from the walk for W1–W5, D8b, W7
and W16.

### TDD steps

1. RED: working-tree-path.test.ts. `validateWalkedEntryPath('a\\b', {})` returns `'a\\b'`. Fails:
   it throws `PATHSPEC_OUTSIDE_REPO`. GREEN: split out `rejectBackslash` and add the host
   parameter. Re-pin the existing walked row "Given a backslash in the path" (ADR-1051): it now
   passes `{ windowsPathSyntax: true }` and still refuses. GUARD: `validateWorkingTreePath('a\\b')`
   still refuses (unchanged).
2. RED: walk-working-tree.test.ts. A memory working tree holding a file named `a\b` and `ab` is
   walked to both paths. If the memory adapter cannot hold that name, wrap `ctx.fs` so `readdir`
   returns a `DirEntry` named `a\b` (a Proxy, as add.test.ts :65 `staleLockCtx` wraps `lstat`).
   JS source doubles every backslash: the file is `'a\\b'`, and W2's escaped pathspec is
   `'a\\\\b'`. Fails: the walk throws `PATHSPEC_OUTSIDE_REPO`. GREEN: the call site
   passes `config.ctx`. GUARD: the same tree under `{ ...ctx, windowsPathSyntax: true }` throws
   `PATHSPEC_OUTSIDE_REPO` with path `'a\\b'`.
3. GUARD (interop, POSIX block): W1–W7, D8b, W12–W16. They pass after step 2; W6 and W12–W15
   passed already. For W7 and W16, compare tsgit `status()` (`untracked`, `changes[].path`) with
   the paths of `git status --porcelain -z`.
4. REFACTOR.

### Gate

```bash
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/unit/domain/working-tree-path.test.ts test/unit/application/primitives/walk-working-tree.test.ts test/unit/application/primitives/walk-working-tree.properties.test.ts test/unit/application/commands/stash.test.ts test/unit/application/commands/add.test.ts test/integration/pathspec-backslash-interop.test.ts test/integration/status-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/domain/working-tree-path.ts src/application/primitives/walk-working-tree.ts test/unit/domain/working-tree-path.test.ts test/unit/application/primitives/walk-working-tree.test.ts test/integration/pathspec-backslash-interop.test.ts \
  && npm run check:spelling && npm run check:test-pyramid; echo "gate exit=$?"
```

### Commit

`fix(walk): yield working-tree entries named with a backslash on POSIX hosts, as git does`

## Part 21 — rm removes a backslash-named working-tree file on POSIX hosts

### Context

R17 for `rm`. Covers ADR-1052 (decision candidate 19 A) and decision candidate 11 A. It needs
Part 20's `PathSyntaxHost` and `rejectBackslash`. Read "Fold revision — house rules" above.

Files this part creates or edits (exactly these):
- `src/domain/working-tree-path.ts` — new `validateWorkingTreePathOn(input, host)`.
- `test/unit/domain/working-tree-path.test.ts`
- `src/application/commands/internal/working-tree.ts` — `removeFile` (:84 at `039599ad`) only.
- `test/unit/application/commands/internal/working-tree.test.ts` — the `removeFile` describe
  (:472).
- `test/unit/application/commands/rm.test.ts`
- `test/integration/pathspec-backslash-interop.test.ts` — the W8–W11 rows (POSIX block).

Public-surface decisions: `validateWorkingTreePathOn` is INTERNAL. The `validatePath` alias
(working-tree.ts :19, `= validateWorkingTreePath`) keeps refusing `\` for every other caller:
`mv`, `materializeFile` and the pathspec intake. ADR-1052 scopes the gate to `removeFile`. The
existing working-tree.test.ts row that expects `validatePath('a\\b')` to refuse stays as it is.

Read-only references: src/application/commands/rm.ts :126 (`removeFile(ctx, path)` for each
removed, non-lossy entry; FILE_NOT_FOUND tolerated), test/unit/application/commands/rm.test.ts :95
(`seedAndStage(workingTree)`).

Current code: `removeFile(ctx, rawPath)` starts with `const path = validatePath(rawPath)`.

Target:

    // working-tree-path.ts
    export const validateWorkingTreePathOn = (input: string, host: PathSyntaxHost): FilePath
      // every validateWorkingTreePath rule, with the backslash refusal only under host.windowsPathSyntax
    // working-tree.ts removeFile
    const path = validateWorkingTreePathOn(rawPath, ctx)

Share the component checks with `validateWorkingTreePath`, without a boolean parameter. For
example, `validateWorkingTreePath = (input) => { rejectBackslash(input); return
validateWorkingTreePathOn(input, POSIX_HOST) }`, where `POSIX_HOST` is a named `{}`.

Pins (design W, tracked fixture as in Part 20):

| Row | command | git |
|---|---|---|
| W8 | `rm -f 'a\\b'` | 0 · index `ab k`, file deleted (today `PATHSPEC_OUTSIDE_REPO` from `removeFile`, index and file unchanged) |
| W9 | `rm -f 'a??'` | 0 · index `ab k`, file deleted (same today) |
| W10 | `rm --cached 'a\\b'` | 0 · index `ab k` (passes today) |
| W11 | `rm -f 'a?'` | 0 · removes `ab` only (passes today) |

### TDD steps

1. RED: working-tree-path.test.ts. `validateWorkingTreePathOn('a\\b', {})` returns `'a\\b'`.
   Fails: no such export. GREEN: the function. GUARD: under `{ windowsPathSyntax: true }` it
   refuses `PATHSPEC_OUTSIDE_REPO`; a '.git' component and a leading `:` still refuse on a POSIX
   host.
2. RED: working-tree.test.ts. `removeFile(ctx, 'a\\b')` on a memory context holding that file
   removes it. Fails: `PATHSPEC_OUTSIDE_REPO { path: 'a\\b' }`. GREEN: `removeFile` uses
   `validateWorkingTreePathOn(rawPath, ctx)`. GUARD: `{ ...ctx, windowsPathSyntax: true }` still
   refuses.
3. GUARD: W8 and W9 in rm.test.ts (`rm(ctx, ['a\\\\b'], { force: true })` gives
   `removed: ['a\\b']` and the file is gone), plus interop W8–W11. Seed the tracked `a\b` with
   `add(ctx, ['.'])` (the walk admits it since Part 20) or `seedIndex`, never with the pathspec
   `'a\\b'`: that spelling is a wildcard that also matches `ab` (E1).
4. REFACTOR.

### Gate

```bash
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/unit/domain/working-tree-path.test.ts test/unit/application/commands/internal/working-tree.test.ts test/unit/application/commands/rm.test.ts test/unit/application/commands/mv.test.ts test/integration/pathspec-backslash-interop.test.ts test/integration/pathspec-glob-dialect-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/domain/working-tree-path.ts src/application/commands/internal/working-tree.ts test/unit/domain/working-tree-path.test.ts test/unit/application/commands/internal/working-tree.test.ts test/unit/application/commands/rm.test.ts test/integration/pathspec-backslash-interop.test.ts \
  && npm run check:spelling && npm run check:test-pyramid; echo "gate exit=$?"
```

### Commit

`fix(rm): remove a backslash-named working-tree file on POSIX hosts, as git does`

## Part 22 — Raise the size caps by the measured delta of the fold

### Context

There is no src/ delta: this is a config and docs part, standalone under the sizing rules. It runs
after Parts 13–21 and before the review round. Lesson 006 says the opposite: measure after the
review round. Placing the part here went against it, and the lesson held again. Part 22 landed
at `01162abc` (+1 042 B gzip on the browser bundle). The review round's fixes then crossed the
caps a second time (+587 B on the browser bundle, domain +719 B, commands-internal +458 B), and
a second raise landed at `2ccbbffd` (fact 24). The design estimates +400 to +740 B gzip
against caps that commit `0287b658` raised to the floor.

Files this part creates or edits (each only if its check is red):
- `.size-limit.json`
- `tooling/verify-tarball.sh` — the cap and its attribution comment.
- `docs/design/bundle-size-optimization.md` — a new "Size-limit raise — …" section, in the format
  of "Size-limit raise — the pathspec glob dialect" (:673).

Read-only references: docs/lessons/006-size-caps-at-the-headroom-floor-trip-again-on-the-review-round.md
(read it first), commit `0287b658` (`git show --no-ext-diff 0287b658` shows the last raise across
all three files), Part 12 above (the same procedure).

Procedure:
1. `rm -rf dist .wireit && npm run check:size`, then `npm run check:tarball`. Read EVERY row of
   both outputs, not only the browser bundle; stale dist chunks fake reds, and the clean rebuild is
   the measurement.
2. Baseline = the tree just before Part 13:
   `pre=$(git log --format=%h -1 --grep='honour exclusions when every positive pathspec')^`.
   Without touching repo state: `base=$(mktemp -d)`,
   `git archive "$pre" | tar -x -C "$base"`, `ln -s "$PWD/node_modules" "$base/node_modules"`, then
   in `$base` run `npm run build && npx size-limit --json > <scratch>/pre-fold-size.json`.
3. For each red row: delta = fold − baseline (gzip bytes). Raise that row's limit by exactly the
   delta, rounded up to the next 0.1 kB, and confirm the new limit is ≥ the fold measurement.
   Record each raise (row, baseline, fold, delta, attribution: the skip-worktree filters and the
   sparse split, the checkout universe filter, the ignored collector and `force` wiring,
   `firstIgnoredOf`, the gitlink step and `gitlinkHeadOf`, the host-gated validators) in the design
   doc, and in the tarball cap comment if that cap moved.
4. No row red → edit nothing and commit nothing; report the measured headroom per row instead.
5. api.json drift check: `npm run docs:json && git diff --no-ext-diff --stat reports/api.json` must
   print nothing (Parts 14, 17 and 18 regenerated it). A diff means a part changed the public
   surface without regenerating: stop and report `{ unit: Part 22, reason, options }`.

House rules: poll, never wait (`check:size` builds). Never run two `npm run` scripts at once.
Commit only this part's files.

### TDD steps

1. Measure per the procedure (no test rows: config only).
2. Raise only the red rows by the measured delta; record each raise.
3. api.json drift check.

### Gate

```bash
rm -rf dist .wireit && npm run check:size && npm run check:tarball \
  && ./node_modules/.bin/biome check .size-limit.json \
  && npx cspell --no-progress docs/design/bundle-size-optimization.md; echo "gate exit=$?"
```

Drop a file from the biome/cspell arguments when this part did not edit it.

### Commit

`fix(pathspec): raise the size caps by the measured delta of the folded add, checkout and rm fixes`

## Part 23 — The working-tree walk yields a nested repository as one directory leaf when asked

### Context

R19's walk half. Covers ADR-1059 (an opt-in hook on the public walk options; every caller that
does not pass it keeps today's gate) and ADR-1055's half that binds the walk: a .git symlink is
never walked through, the walk only asks. Decision candidate 30 fixes the name. Facts 30 and 37.
Read both house-rules sections above.

Files this part creates or edits (exactly these):
- `src/application/primitives/types.ts` — `WalkWorkingTreeOptions` (:267–282).
- `src/application/primitives/walk-working-tree.ts` — `WalkConfig` (:15–25), `enterSubdirectory`
  (:64–77), `stepEntry` (:90–125), `walkWorkingTree` (:157–186) and its JSDoc (:127–156).
- `test/unit/application/primitives/walk-working-tree.test.ts` — a new top-level describe at the
  end (the file is 883 lines); reuse `seedFs`, `collect` and `expectError` (:13–44).
- `reports/api.json` — regenerate with `npm run docs:json`.

Public-surface decisions: `WalkWorkingTreeOptions.isNestedRepository` is PUBLIC (ADR-1059).
Its surface gates: reports/api.json, and nothing else. The options type is public through
`export type *` and the facade forwards options as they are (fact 30). The function type is inline,
so there is no new type name, barrel entry or `Object.keys` change. check:doc-coverage counts
pages per binding, not options. docs/use/primitives/walk-working-tree.md is the documentation
phase's.

Read-only references: src/domain/path/verify-path.ts `isDotGitWalkEntry` (the case-folded .git
name test the main loop already skips with),
test/unit/application/primitives/walk-working-tree.properties.test.ts (its oracle is a verbatim
copy of the pre-rewrite walk and takes no hook; run it as a GUARD and leave it unedited),
src/ports/file-system.ts `DirEntry`.

Current code: `enterSubdirectory(config, prefix, depth)` reads the frame and returns `undefined`
when `frame.entries.some(isEmbeddedGitMarker)`; `stepEntry` maps that to `skip`. A file or symlink
leaf goes through the shared counter and the `maxEntries` refusal (:111–114), then a `yield` step
whose `stat` is `lazyStat(config, path)`.

Target:

    // types.ts, inside WalkWorkingTreeOptions
    /**
     * Asked about each directory below the root whose entries hold a .git entry of any
     * kind (directory, file or symlink), once `ignore` has kept the directory. `true` yields
     * the directory as one leaf (`isDirectory: true`, counted against `maxEntries`) and walks
     * nothing beneath it; `false` walks into it, .git still skipped. Unset, a directory
     * holding a .git directory or regular file yields nothing, as before.
     */
    readonly isNestedRepository?: (directory: FilePath) => boolean | Promise<boolean>;

    // walk-working-tree.ts
    // WalkConfig gains `isNestedRepository` (undefined when unset).
    // enterSubdirectory(config, counter, prefix, depth): Promise<StackStep>
    //   frame = await readDirectoryFrame(config, prefix, depth)   (depth guard and readdir unchanged)
    //   hook unset              -> today: some(isEmbeddedGitMarker) ? skip : push
    //   no entry named .git     -> push
    //   await hook(prefix)      -> the leaf step for prefix (isFile false, isDirectory true, isSymbolicLink false)
    //   otherwise               -> push
    // The leaf step (counter, maxEntries refusal, lazyStat) is shared with files and symlinks:
    // extract it, for example leafStep(config, counter, path, kind), never copy it.

The root frame never reaches `enterSubdirectory`, so the hook is never asked about the work tree
itself. Rewrite the JSDoc sentence "Embedded repositories ... are skipped entirely" (:140–143) to
say what the hook changes.

### TDD steps

1. RED: walk-working-tree.test.ts. A tree holding 'a.txt', 'vendor/lib/.git/HEAD' and
   'vendor/lib/src/x.ts', walked with `isNestedRepository: async () => true`, yields 'a.txt' and
   one entry 'vendor/lib' with `isDirectory: true`, `isFile: false`, `isSymbolicLink: false`
   (assert each entry's kind bits, not only the paths). Fails: it yields 'a.txt' only; the option
   is ignored and the gate collapses 'vendor/lib'. GREEN: the narrowest change: ask the hook where
   `isEmbeddedGitMarker` holds; `true` gives the leaf step, `false` pushes the frame. GUARD:
   `async () => false` yields 'a.txt' and 'vendor/lib/src/x.ts' and nothing under '.git'; a .git
   regular file ('sub/.git' holding 'gitdir: /elsewhere\n') asks the hook too; a sync
   `() => true` works; the leaf's `stat()` reports a directory.
2. RED: a directory 'sub' holding 'keep.txt' and a .git symlink
   (`ctx.fs.symlink('/elsewhere', <workDir>/sub/.git)`), walked with a hook answering true,
   yields the leaf 'sub' only. Fails: the hook is never asked, because a symlink is no marker, and
   the walk yields 'sub/keep.txt'. GREEN: with the hook set, find the .git entry by name alone
   (`isDotGitWalkEntry`), whatever its kind.
3. GUARD rows, each isolated: a recording hook is asked about exactly the non-root directories
   that hold .git, never the root and never a directory without one; a directory the `ignore`
   predicate drops is never asked; `maxEntries: 1` over 'a.txt' plus a repository leaf refuses
   `TREE_ENTRY_LIMIT_EXCEEDED` (assert the count and the limit in `data`); with the hook unset,
   rows :210, :651, :827 and :847 stay green; the properties suite stays green.
4. REFACTOR: the JSDoc. Regenerate api.json (`npm run docs:json`); the option and the JSDoc are
   the expected diff, beside the usual typedoc-id churn.

### Gate

```bash
npx vitest run test/unit/application/primitives/walk-working-tree.test.ts test/unit/application/primitives/walk-working-tree.properties.test.ts test/unit/adapters/snapshot-resolvers/fs-workdir-enumerator.test.ts test/unit/application/commands/stash.test.ts test/unit/application/commands/add.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/primitives/types.ts src/application/primitives/walk-working-tree.ts test/unit/application/primitives/walk-working-tree.test.ts \
  && npm run check:spelling && npm run check:test-pyramid; echo "gate exit=$?"
```

### Commit

`fix(walk): yield a nested repository as one directory leaf when the caller asks for it`

## Part 24 — A nested repository's checkout is read as data, and one reader answers the walk hook

### Context

R19's classification. Covers ADR-1054 ("a .git that leads to no repository makes the directory
ordinary"), ADR-1055 (a .git symlink is classified by one read-only stat through the facade's
path probe: the probe's existing `symlinkCheckout` → `statOrUnreachable` →
`metadataOf(ctx, dotGit).stat`, kept as is) and design Part k's probe that returns data. Decision
candidates 29 and 31; facts 31 and 36. `gitlinkHeadOf`'s contract (GL20–GL51) does not change.

Files this part creates or edits (exactly these):
- `src/application/commands/internal/gitlink-head.ts`
- `test/unit/application/commands/internal/gitlink-head.test.ts` — reuse `layOutRepository`,
  `confiningOutside` and `failingLstatOfDotGit` (:9–56); one new describe per new export.
- `src/application/commands/internal/embedded-repository.ts` — CREATED.
- `test/unit/application/commands/internal/embedded-repository.test.ts` — CREATED (memory
  adapter).

Public-surface decisions: every new symbol is INTERNAL (`GitlinkCheckout`,
`probeGitlinkCheckout`, `EmbeddedRepositories`, `embeddedRepositories`). commands/internal is not
re-exported: src/application/commands/index.ts re-exports commands only. No api.json.

Read-only references: add.ts `movedGitlinkOf` (the one `gitlinkHeadOf` caller);
src/domain/git-index/directory-file-conflict.ts :21 `entriesBeneath(sorted, path)` (a lower-bound
search over the byte-sorted index, every stage, lossy-aware); src/application/primitives/internal/gitlink-ref-storage.ts
:49 `refStorageOf` (throws the format refusals); add-gitlink.test.ts (the GL rows that must stay
green).

Current code (gitlink-head.ts at `a85a6386`): `gitlinkHeadOf(ctx, path)` (:41–60) throws
`notARepository(shown)` from four sites: `gitfileCheckout` (:178, a gitfile that does not parse,
shown as path + '/.git'), the usable-HEAD check (:51), `reaching` (:88, a zero-byte `commondir`)
and `holdsObjectsAndRefs` (:53). `refStorageOf` (:57) throws a refused format.
`resolveGitlinkHead` (:68) maps every TsgitError of the HEAD resolution to `undefined`.

Target:

    // gitlink-head.ts
    /** What <path>/.git leads to: nothing, a repository git refuses to read (named as git names it), or one whose HEAD is read on demand. */
    export type GitlinkCheckout =
      | { readonly kind: 'none' }
      | { readonly kind: 'broken'; readonly shown: FilePath }
      | { readonly kind: 'repository'; readonly head: () => Promise<ObjectId | undefined> };
    export const probeGitlinkCheckout = async (ctx: Context, path: FilePath): Promise<GitlinkCheckout>
      // the four refusal sites become { kind: 'broken', shown }, each with today's shown spelling
      // head(): refStorageOf (a refused format throws, as today), then resolveGitlinkHead
    export const gitlinkHeadOf = async (ctx: Context, path: FilePath): Promise<ObjectId | undefined>
      // broken -> throw notARepository(shown); none -> undefined; repository -> head()

    // embedded-repository.ts
    /** The repositories one command call meets, each classified once. */
    export interface EmbeddedRepositories {
      /** The walk hook: no index entry lies beneath `directory`, and its .git leads to a repository. */
      readonly holds: (directory: FilePath) => Promise<boolean>;
      /** The commit checked out there; undefined when it is no repository, its HEAD does not resolve, or git refuses its format. */
      readonly headOf: (directory: FilePath) => Promise<ObjectId | undefined>;
    }
    export const embeddedRepositories = (ctx: Context, sorted: ReadonlyArray<IndexEntry>): EmbeddedRepositories
      // a Map<FilePath, Promise<GitlinkCheckout>> local to the call memoises the probe
      // holds: entriesBeneath(sorted, directory).length === 0 first (no probe), then kind === 'repository'
      // headOf: a repository's head(); a TsgitError there -> undefined (an unborn branch, an
      //         unparsable ref and a refused format are all git's "no commit checked out": EM40-EM44);
      //         anything else rethrows

`entriesBeneath` slices the entries beneath a directory, once per directory that holds .git.
A non-allocating "any entry beneath" test is a refactoring for a profile to justify, not for this
part.

### TDD steps

1. RED: gitlink-head.test.ts. `probeGitlinkCheckout(ctx, 'sub')` over a laid-out repository
   returns `kind: 'repository'`, and its `head()` resolves to the branch id. Fails: no such
   export. GREEN: extract the probe; its broken arms may still throw for now; `gitlinkHeadOf`
   delegates to it. GUARD: no .git gives `{ kind: 'none' }`, and so does a dangling .git
   symlink; every existing gitlink-head row; add-gitlink.test.ts as a whole.
2. RED: one row per refusal site, each returning `{ kind: 'broken', shown }` instead of throwing:
   a gitfile holding 'garbage\n' (shown 'sub/.git'); a .git directory whose HEAD holds
   'garbage\n' ('sub/.git'); a gitfile to an admin dir whose `commondir` is zero bytes; a .git
   directory with no 'objects'. Fails: the probe throws `NOT_A_REPOSITORY`. GREEN: each site
   returns data. GUARD: `gitlinkHeadOf` still throws `NOT_A_REPOSITORY` with the same paths
   (add-gitlink GL20, GL21, GL46–GL51), and still throws `REPOSITORY_FORMAT_VERSION_UNSUPPORTED`
   for `core.repositoryformatversion = 2`.
3. RED: embedded-repository.test.ts. `holds('sub')` is true for a repository at 'sub' and an
   empty index. Fails: no module. GREEN: the module, with the memoised probe. GUARD: `none` and each
   `broken` layout answer false (the EM28 and EM31–EM36 shapes); a .git symlink to a repository
   directory answers true (EM24's shape, through the memory adapter's symlink).
4. RED: with `sorted` holding 'sub/u', `holds('sub')` is false and 'sub/.git' is never
   `lstat`ed (wrap `ctx.fs.lstat` to count). Fails: true, because nothing reads the index. GREEN:
   the `entriesBeneath` test, ahead of the probe.
5. RED: `headOf('sub')` gives the branch id; an unborn branch gives `undefined`; a repository
   whose config holds `[core]\n\trepositoryformatversion = 2\n` gives `undefined` instead of
   throwing. Fails: no `headOf`. GREEN: `headOf`. GUARD: `holds` then `headOf` `lstat`
   'sub/.git' once (the memo); a non-TsgitError thrown by the HEAD read propagates (message
   asserted); `headOf` of a directory that is no repository gives `undefined`.
6. REFACTOR: comments that say why (git's test for a non-bare repository directory, and its "no commit checked out"
   for every HEAD it cannot resolve).

### Gate

```bash
npx vitest run test/unit/application/commands/internal/gitlink-head.test.ts test/unit/application/commands/internal/embedded-repository.test.ts test/unit/application/commands/add-gitlink.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/commands/internal/gitlink-head.ts src/application/commands/internal/embedded-repository.ts test/unit/application/commands/internal/gitlink-head.test.ts test/unit/application/commands/internal/embedded-repository.test.ts \
  && npm run check:spelling && npm run check:test-pyramid; echo "gate exit=$?"
```

### Commit

`fix(add): read a nested repository's checkout as data, without refusing`

## Part 25 — NO_COMMIT_CHECKED_OUT joins the error union

### Context

ADR-1057 and fact 29. The member's surface gates are separate tooling, so it lands in its own
slice before Part 26 throws it. It earns the slice: the union, two exhaustive switches, the
message table and api.json are five files that would push Part 26 past the ceiling.

Files this part creates or edits (exactly these):
- `src/domain/repository/error.ts` — the member in `RepositoryError` (:4–23), beside
  `NOT_A_REPOSITORY`, and the factory `noCommitCheckedOut(path)` beside `notARepository` (:25).
- `src/domain/error.ts` — the message case beside `case 'NOT_A_REPOSITORY'` (:428). The switch
  ends in an exhaustive `never` (:822).
- `test/unit/domain/exhaustiveness.ts` — the case beside `'NOT_A_REPOSITORY'` (:92).
- `test/unit/domain/repository/error.test.ts` — a factory describe (copy the `notARepository` one
  at :22) and a row in the table "extractDetail message formatting (exact match)" (:205).
- `reports/api.json` — regenerate with `npm run docs:json`.

Public-surface decisions: the union member is PUBLIC: `RepositoryError` is part of
`TsgitErrorData`, which reports/api.json lists, and a consumer switches on `code`. Its gates: the
union, the message switch, the test exhaustiveness switch, the message table and api.json. The
factory is INTERNAL: do NOT add it to src/domain/repository/index.ts, a barrel that reaches the
package through src/domain/index.ts. Part 26 imports it from the module, as gitlink-head.ts
imports `notARepository`. docs/use/errors.md is the documentation phase's.

Target:

    // RepositoryError
    | { readonly code: 'NO_COMMIT_CHECKED_OUT'; readonly path: FilePath }   // git's spelling: 'sub/'
    // beside notARepository
    export const noCommitCheckedOut = (path: FilePath): TsgitError =>
      new TsgitError({ code: 'NO_COMMIT_CHECKED_OUT', path });
    // message switch
    case 'NO_COMMIT_CHECKED_OUT':
      return `does not have a commit checked out: ${data.path}`;

The path is repo-relative and never absolute, so the message carries it whole, as
`PATHSPEC_NO_MATCH` carries its pattern. `basename` would drop both the slash and the parent
('d/sub/' → 'sub').

### TDD steps

1. RED: error.test.ts. `noCommitCheckedOut('d/sub/' as FilePath).data` equals
   `{ code: 'NO_COMMIT_CHECKED_OUT', path: 'd/sub/' }`, and the table row renders
   `'NO_COMMIT_CHECKED_OUT: does not have a commit checked out: d/sub/'`. Fails: no such export,
   and the type rejects the code. GREEN: the member, the factory, the message case and the
   exhaustiveness case. GUARD: the rest of error.test.ts and every domain suite that calls
   `assertExhaustiveSwitch`.
2. REFACTOR: `npm run docs:json`; the member is the expected diff.

### Gate

```bash
npx vitest run test/unit/domain/repository/error.test.ts test/unit/domain/error.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/domain/repository/error.ts src/domain/error.ts test/unit/domain/exhaustiveness.ts test/unit/domain/repository/error.test.ts \
  && npm run check:spelling; echo "gate exit=$?"
```

### Commit

`fix(repository): add the refusal git raises for a repository with no commit checked out`

## Part 26 — add stages an untracked repository a pathspec reaches as a gitlink, and refuses one with no commit

### Context

R19 on the pathspec (walk) route, and R20 where the walk lists the replaced path. Covers ADR-1054
(stage, match as `<dir>/`, nothing beneath, refusal order), ADR-1055 (through Part 24's reader),
ADR-1056 (no hint field, so `AddResult` is unchanged), ADR-1057, ADR-1058 (a type change reports
in `modified`) and ADR-1062. Decision candidate 32; facts 31–33. Needs Parts 23–25.

Files this part creates or edits (exactly these):
- `src/application/commands/add.ts`
- `test/unit/application/commands/add-embedded-repository.test.ts` — CREATED (memory adapter).
- `test/integration/add-embedded-repository-interop.test.ts` — CREATED. `@proves` surface and
  interopSurface `add`; unique line "add stages an untracked repository as a gitlink and refuses
  one with no commit as git does". Gate the whole file with
  `describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')` (EM24–EM29 need symlinks).

Public-surface decisions: no new public symbol. `AddResult`, `AddOptions` and the `add` JSDoc do
not change in this part (Part 27 rewrites the JSDoc), so no api.json. INTERNAL:
`stagedEmbeddedRepositories`, `embeddedOutcomeOf`, the leaf partition and the `<dir>/` spelling
helper.

Read-only references: Part 24's `embeddedRepositories` (embedded-repository.ts) and Part 25's
`noCommitCheckedOut` (src/domain/repository/error.ts); in add.ts, `stagedGitlinks` (:1307),
`settled` (:1327) and `movedGitlinkOf` (:1351) for the settle-then-`firstFailureOrValues` shape
and the `indexEntryFromStat(stat, FILE_MODE.GITLINK, head, path)` entry; add-gitlink.test.ts
(`layOutModule` :62, `blobExists` :746, `refusalOf`, and the rows "add over an unmerged gitlink"
:1084); test/unit/application/commands/fixtures.ts `seedRepo`; add-index-fixtures.ts `seedIndex`;
add-gitlink-interop.test.ts (`commitIn`, `writeFiles`, `twins`, `looseCountOf`, pinned env).

Current code (add.ts at `a85a6386`): `stageIgnoredWalk` (:1211–1253) collects the walk with
`{ ignore }`, drops skip-worktree leaves (`withoutSkipWorktree`), settles the unseen positives
(`settleUnseenPositives` :1255 → `unseenWalked` :1027, which tests
`positive.entry.compiled.test(path)` on each walked path) and calls `stageSelectedEntries`
(:1281–1301): `stagedGitlinks`, then `hiddenTracked(..., walked, ...)`, then
`stageWalkedEntries([...walked, ...hidden])`.

Target:

    // stageIgnoredWalk
    const repositories = embeddedRepositories(ctx, sorted);
    const walked = withoutSkipWorktree(
      await collectWalk(walkWorkingTree(ctx, { ignore, isNestedRepository: repositories.holds })),
      existing,
    );
    // partition: a repository leaf is isDirectory && !isSymbolicLink. Drop a leaf whose index
    //   entry is a gitlink at any stage: R15 owns it (candidate 32, fact 31).
    // selected = the leaves pathspecVerdict(matcher, `${path}/`).matched (EM5-EM7, EM22, EM23, EM61)
    // settleUnseenPositives and unseenWalked take the walked spellings: each file's path, and
    //   each SELECTED leaf as `${path}/` (fact 32)
    // stageSelectedEntries: stagedGitlinks -> stagedEmbeddedRepositories(selected)
    //   -> hiddenTracked(files and selected leaves: fact 33) -> stageWalkedEntries(files and hidden)
    //   outcomes = [...gitlinks, ...embedded, ...staged]

    const stagedEmbeddedRepositories = async (ctx, repositories, leaves, existing): Promise<WalkOutcome[]>
      // leaves in path order (comparePaths), probed through boundedMapFor + settled,
      // then firstFailureOrValues; the first leaf in path order whose head is undefined
      // refuses noCommitCheckedOut(`${path}/`) (EM50, EM72)
    const embeddedOutcomeOf = async (repositories, leaf, existing): Promise<WalkOutcome | undefined>
      // head = await repositories.headOf(leaf.path); undefined -> undefined
      // { kind: existing.has(keyOfPath(path)) ? 'modified' : 'added', path,
      //   entry: indexEntryFromStat(await leaf.stat(), FILE_MODE.GITLINK, head, path) }

Refusal order (ADR-1054, ADR-1035): the unmatched pathspec (`settleUnseenPositives`), then R15
(`stagedGitlinks`), then this refusal, then the first blob write in `stageWalkedEntries`.
`tallyWalkOutcomes`, the removal pass (`collectMatchedRemovals` skips the matched path) and the
index commit need no change. `addAll`, `hiddenWalkEntryOf` and the literal route belong to Part 27.

Pins (design EM; walk-route arguments only; `-A` rows are Part 27's):

| Rows | Setup · args | git 2.55 |
|---|---|---|
| EM1–EM3, EM5, EM6 | repo 'sub' · `.`, `sub`, 'sub/', `s*`, `su?/` | 0 · `160000 <HEAD> sub`, `added: ['sub']` |
| EM7 | same · `*b`; `su?` | 128 · `PATHSPEC_NO_MATCH` with that pattern |
| EM13–EM20 | only .git with one empty commit; gitfile absolute; gitfile relative; detached; reftable; linked worktree; a branch naming a missing object; 'sub' and 'sub2' | 0 · each repository's HEAD staged, no object check (EM19) |
| EM21–EM23 | repo 'd/sub' beside 'd/f' · `.`, `d`, 'd/sub'; `s*`, `sub`, `*sub`; `*sub*`, '*sub/' | 0 · 'd/f' and the gitlink ('d/sub' alone for `add d/sub`); 128 no match; 0 · the gitlink |
| EM24–EM26 | .git a symlink to a repository, a relative one, one to a gitfile | 0 · the gitlink |
| EM27 | .git a symlink to a repository with no commit | 128 · `NO_COMMIT_CHECKED_OUT` 'sub/' |
| EM28, EM29, EM31–EM36, EM39 | dangling link; link to a file; empty .git dir; HEAD 'garbage'; no 'objects'; gitfile 'garbage'; empty gitfile; gitfile to nothing; admin files at the top | 0 · `A sub/u` (EM39: every file) |
| EM40–EM44 | `git init` with 'sub/u'; `git init` only; format v2; unknown v1 extension; branch 'garbage' · `.`, `sub`, 'sub/', `s*` | 128 · `NO_COMMIT_CHECKED_OUT` 'sub/', index unchanged |
| EM45 / EM46 / EM47 / EM48 | EM40 plus untracked 'a', 'z' · `.`, `a sub z` / `a z` / `. nomatch*` / `. !sub` | 128 refusal, no blob written / 0 · 'a', 'z' / 128 `PATHSPEC_NO_MATCH` 'nomatch*' / 0 · nothing |
| EM50 | repos 'a' and 'b', no commit · `.`; `b a` | 128 · 'a/' both times |
| EM51 | tracked gitlink 'tail' whose gitfile names nothing, plus EM50's 'a' · `.` | 128 · `NOT_A_REPOSITORY` 'tail/../.git/modules/nowhere' |
| EM53–EM55 | ignore rule 'sub/' (or `sub`) · `.`; `sub`; repo 'd/sub' with rule 'd/' | 0 .gitignore only; `ignored: ['sub']`; as design |
| EM56 (`add -f .` only), EM57, EM58 | the ignored repository · `{ force: true }` with `.`, `sub`, `d` | 0 · the gitlink |
| EM59, EM60 | EM40 with rule 'sub/' · `.`, `sub`; `-f .` | 0 · .gitignore, `ignored: ['sub']`; 128 refusal |
| EM61, EM62 | EM1 · `. !sub`, `sub !sub`; `s* !sub` | 0 · nothing; 128 `PATHSPEC_NO_MATCH` 's*' |
| EM63, EM64 | repo 'sub/inner' inside EM1's 'sub' · `.`; 'sub/inner' | 0 · the outer HEAD only; 0 · nothing |
| EM66, EM68 | tracked file / symlink 'sub' replaced by EM1's repo · `.`, `sub`, 'sub/', `s*` | 0 · `T sub`: `modified: ['sub']`, `removed: []` |
| EM70, EM72 | tracked file replaced by EM40's repo · `.`, `sub`; plus repo 'a' (or 'z') with no commit | 128 · 'sub/'; 'a/' (with 'z': 'sub/') |
| EM74–EM76 | tracked 'sub/u', then a repository made inside 'sub' · `.`, `sub` (EM75 'sub/u' rewritten, EM76 untracked 'sub/new') | 0 · unchanged; `M sub/u`; `A sub/new` |
| EM10–EM12, EM52, EM80, EM82 | rm, checkout, `--renormalize` over EM1 or EM40 | interop rows only: these routes do not change |

### TDD steps

1. RED: EM1 (add-embedded-repository.test.ts, plus the interop row). `add(ctx, ['.'])` gives
   `added: ['sub']`, and the 'sub' entry has mode `FILE_MODE.GITLINK` and the repository's branch
   id. Fails: `added: []`, because the walk is not given the hook and collapses 'sub'. GREEN: wire
   the reader, partition the walk, select the leaves as `${path}/`, and add
   `stagedEmbeddedRepositories` WITHOUT the refusal (a leaf with no head is left out for now).
   Feed `hiddenTracked` the files and the selected leaves, and `stageWalkedEntries` the files.
   GUARD: EM2, EM3, EM5, EM13–EM21 (`add d/sub` included), EM24–EM26, EM28, EM29, EM31–EM36,
   EM39, EM46, EM48, EM51, EM53–EM58, EM61, EM63, EM64, EM66, EM68, EM74–EM76, and the rows "add
   over an unmerged gitlink" (one 'sub' outcome, not two).
2. RED: EM6 and EM7. `add(ctx, ['su?/'])` stages the gitlink; `add(ctx, ['su?'])` refuses
   `PATHSPEC_NO_MATCH` with pattern 'su?'. Fails: 'su?/' refuses, because `unseenWalked` tests
   the bare 'sub'; 'su?' succeeds and stages nothing, because the bare 'sub' satisfies it. GREEN:
   `settleUnseenPositives` and `unseenWalked` take the walked spellings. GUARD: EM22, EM23, EM62.
3. RED: EM40. `add(ctx, ['.'])` over 'sub' (a repository with no commit, plus 'sub/u') and an
   untracked 'a' throws `NO_COMMIT_CHECKED_OUT` with `path: 'sub/'` (try/catch, assert `data`),
   the index is unchanged and the blob of 'a' was not written (`blobExists`). Fails: it succeeds
   and stages 'a'. GREEN: the refusal for the first head-less leaf in path order. GUARD: EM27,
   EM41–EM45, EM47, EM50, EM59, EM60, EM70, EM72.
4. GUARD (interop): every row of the table above against git 2.55. EM45 and EM60 compare the
   index and the refusal, not loose counts (ADR-1062). EM10–EM12, EM52, EM80 and EM82 call tsgit's
   `rm`, `checkout` and `add({ renormalize: true })` (EM80 and EM82 stage 'sub' with tsgit's `add`
   first).
5. REFACTOR: comments that say why (git matches a repository as a directory; it dies at the
   first one with no commit, in path order).

### Gate

```bash
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/unit/application/commands/add-embedded-repository.test.ts test/unit/application/commands/add.test.ts test/unit/application/commands/add-gitlink.test.ts test/unit/application/commands/add-ignored-report.test.ts test/unit/application/commands/add-skip-worktree.test.ts test/integration/add-embedded-repository-interop.test.ts test/integration/add-gitlink-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/commands/add.ts test/unit/application/commands/add-embedded-repository.test.ts test/integration/add-embedded-repository-interop.test.ts \
  && npm run check:spelling && npm run check:test-pyramid; echo "gate exit=$?"
```

### Commit

`fix(add): stage an untracked repository a pathspec reaches as a gitlink, as git does`

## Part 27 — add -A stages repositories too, the index pass stages a type change, and a literal inside a repository stages nothing

### Context

R19 under `add({ all: true })` and on the literal route, and R20 on the index pass. Covers
ADR-1054, ADR-1058 and ADR-1060 (the ancestor probe runs only for untracked literals). Facts 33–35
and 37. Needs Part 26's partition, `stagedEmbeddedRepositories` and `embeddedOutcomeOf`.

Files this part creates or edits (exactly these):
- `src/application/commands/add.ts` — `addAll` (:1510), `hiddenTracked` (:1138),
  `hiddenWalkEntryOf` (:1182), `stageSelectedEntries` (:1281), `addLiteralOnly` (:276), and the
  `add` JSDoc (:171–186, fact 37).
- `test/unit/application/commands/add-embedded-repository.test.ts`
- `test/integration/add-embedded-repository-interop.test.ts`
- `test/unit/application/commands/add.test.ts` — re-pins only: :933 and :1239 (fact 35).
- `test/integration/add-all.test.ts` — the re-pin at :19 (fact 35).
- `reports/api.json` — regenerate with `npm run docs:json` after the JSDoc change.

Public-surface decisions: no new public symbol. The `add` JSDoc changes, so api.json is
regenerated. INTERNAL: the literal split and the ancestor search.

Read-only references: add.ts `splitReportedLiterals` (:314) and `firstIgnoredAncestorOf` (:373,
the shallowest-first ancestor loop to mirror), `collectRemovedEntries` (:1605), `presentOnDisk`
(:1579), `processWalkEntry` (:1621, the only writer of `seen` today); Part 24's
`embeddedRepositories`.

Current code: `addAll` collects the walk with `{ ignore: walkIgnore }`, runs `hiddenTracked`
with `WHOLE_TREE_MATCHER`, then `stagedGitlinks`, then `stageWalkedEntries(..., seen, ...)`, then
`collectRemovedEntries(ctx, existing, seen)`. `hiddenWalkEntryOf` returns `undefined` for a real
directory. `addLiteralOnly` reads the index (`sorted` included), splits the sparse and ignored
literals, and stages the rest.

Target:

    // addAll
    // const repositories = embeddedRepositories(ctx, sorted); the walk gets isNestedRepository
    // the same partition as Part 26; every leaf is selected (the whole tree)
    // order: stagedGitlinks -> stagedEmbeddedRepositories(leaves) -> hiddenTracked(files and leaves)
    //        -> stageWalkedEntries(files and hidden files)
    // mark each embedded outcome's key, and each index-pass gitlink outcome's key, in `seen` (fact 34)

    // hiddenWalkEntryOf, for a real directory: `await repositories.holds(path)` gives
    //   { path, isFile: false, isDirectory: true, isSymbolicLink: false, stat: () => Promise.resolve(stat) };
    //   anything else stays undefined (EM71, EM73 keep the removal)
    // the callers (stageSelectedEntries, addAll) split the hidden entries: the directories go
    //   through embeddedOutcomeOf, dropping undefined, and never refuse (git's index pass does
    //   not: EM71); the files go to stageWalkedEntries as today
    // hiddenTracked gains the reader; if its parameter list passes six, fold verdicts and
    //   unmergedStages into one record

    // addLiteralOnly, after splitReportedLiterals
    // drop each UNTRACKED literal with a proper ancestor, shallowest first, that
    //   repositories.holds; it is neither staged, nor reported, nor refused (EM8, EM49, EM65)
    // a tracked literal is never probed (ADR-1060)

    // add JSDoc: ".git and embedded repositories are skipped" becomes: .git is skipped; an
    // untracked repository is staged as a gitlink and nothing beneath it is; a literal inside
    // an untracked repository stages nothing.

Re-pins (each against its design row, never to fit the code):
- add.test.ts :933 "Given an embedded.git subdirectory (nested repo) and all: true":
  'vendor/lib/.git/HEAD' alone has no objects or refs directory, so it is no repository by git's
  test (EM33 class). The index becomes 'a.txt' and 'vendor/lib/src/x.ts', still with no 160000
  entry. Retitle it to say so.
- add.test.ts :1239 "Given a plain regular file literally named.git …": 'gitdir: /elsewhere' names
  nothing (EM36), so 'sub/normal.txt' is staged.
- add-all.test.ts :19: the same shape as :933, so 'vendor/lib/src/x.ts' joins `added` and the
  index; still no 160000 entry.
- add.test.ts :1261 (a dangling .git symlink, EM28) stays green unchanged.

Pins (design EM):

| Rows | Setup · args | git 2.55 |
|---|---|---|
| EM4, and EM13–EM29 under `-A` | the Part 26 fixtures · `{ all: true }` | as the `.` rows |
| EM40, EM41, EM45 under `-A` | no commit | 128 · `NO_COMMIT_CHECKED_OUT` 'sub/' |
| EM53, EM59 under `-A`; EM56 under `-A -f` | the ignored repository | .gitignore only; with force, plus the gitlink |
| EM63, EM74–EM76 under `-A` | nested; tracked directory turned repository | the outer HEAD only; unchanged, `M sub/u`, `A sub/new` |
| EM66, EM68 under `-A` | tracked file / symlink turned repository | `T sub`: `modified: ['sub']`, `removed: []` |
| EM67 | tracked file turned repository · `*b` | `T sub` (the index pass matches 'sub') |
| EM69 | EM66 plus rule `sub` · `.`, `sub`, `-A` | `T sub`, no ignored report |
| EM70 under `-A` | tracked file turned EM40's repository | 128 · 'sub/' |
| EM71 | EM70 plus rule `sub` · `.`; `sub` | 0 · `D sub` (and `A .gitignore`); never refuses |
| EM73 | tracked file turned a directory with an empty .git and 'u' · `.`, `sub` | 0 · `D sub`, `A sub/u` |
| EM77 | tracked file 'f' turned symlink to 'k' (report-shape control) · `.`, `f` | `modified: ['f']` |
| EM8, EM49, EM65 | literal inside EM1 / EM40 / the nested repo · 'sub/u', 'sub/inner/u' | 0 · nothing staged, no refusal |
| EM37 | EM32 (broken HEAD) · 'sub/u' | 0 · `A sub/u` (positive control) |
| EM46 | EM40 plus 'a', 'z' · `a z` | 0 · 'a', 'z' |
| EM75, EM76 literal controls | 'sub/u' tracked and rewritten; untracked 'sub/new' | `M sub/u`; `A sub/new` (entries beneath: no probe) |

### TDD steps

1. RED: EM4. `add(ctx, [], { all: true })` gives `added: ['sub']` and the gitlink entry. Fails:
   `added: []`, because `addAll` passes no hook. GREEN: `addAll` builds the reader, passes the
   hook, partitions the walk, and runs `stagedEmbeddedRepositories` after `stagedGitlinks`. The
   files and leaves go to `hiddenTracked`, the files to `stageWalkedEntries`. Re-pin :933, :1239 and
   add-all.test.ts :19. GUARD: EM13–EM29, EM40, EM41, EM45, EM53, EM56, EM59, EM63 and EM74–EM76
   under `-A`, and :1261.
2. RED: EM66 under `-A`. `add(ctx, [], { all: true })` gives `modified: ['sub']`, `removed: []`
   and a 160000 'sub'. Fails: `removed: ['sub']` as well, and the index loses 'sub', because
   `presentOnDisk` treats the directory over the 100644 entry as gone (fact 34). GREEN: mark each
   embedded outcome's key in `seen`. GUARD: EM68 and EM70 under `-A`.
3. RED: EM67. `add(ctx, ['*b'])` gives `modified: ['sub']` and the gitlink entry. Fails:
   `removed: ['sub']`, because the walk's leaf is not selected by '*b' and the index pass drops a
   directory. GREEN: the directory arm of `hiddenWalkEntryOf`, the split in both callers, and
   `seen` marking for the index-pass outcomes in `addAll`. GUARD: EM69 (`.`, `sub`, `-A`), EM71,
   EM73, EM77.
4. RED: EM8. `add(ctx, ['sub/u'])` over EM1 returns empty `added`, `modified` and `removed`,
   leaves the index unchanged, and does not throw. Fails: `added: ['sub/u']` (the literal route
   stages it). GREEN: the untracked-literal ancestor drop in `addLiteralOnly`. GUARD: EM49, EM65,
   EM37, EM46, and the EM75 and EM76 literal controls.
5. REFACTOR: the `add` JSDoc (fact 37); `npm run docs:json`.

### Gate

```bash
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/unit/application/commands/add-embedded-repository.test.ts test/unit/application/commands/add.test.ts test/unit/application/commands/add-gitlink.test.ts test/unit/application/commands/add-ignored-report.test.ts test/unit/application/commands/add-skip-worktree.test.ts test/integration/add-all.test.ts test/integration/add-embedded-repository-interop.test.ts test/integration/add-gitlink-interop.test.ts test/integration/add-tracked-under-ignore-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/commands/add.ts test/unit/application/commands/add-embedded-repository.test.ts test/integration/add-embedded-repository-interop.test.ts test/unit/application/commands/add.test.ts test/integration/add-all.test.ts \
  && npm run check:spelling && npm run check:test-pyramid; echo "gate exit=$?"
```

### Commit

`fix(add): stage repositories under -A and over tracked files, and skip literals inside them`

## Part 28 — status lists an untracked repository as its directory

### Context

ADR-1061 (design candidate 27 A): `status` passes the same hook and lists a repository directory
once, spelled as git's `-uall` porcelain spells it ('sub/'); a directory whose .git leads to no
repository, or one with index entries beneath it, is walked. Decision candidate 33; facts 37 and
38. Needs Parts 23 and 24.

Files this part creates or edits (exactly these):
- `src/application/commands/status.ts` — `scanUntracked` (:298–309) and the `status` JSDoc
  sentence on `untracked` (:130–137).
- `test/unit/application/commands/status-embedded-repository.test.ts` — CREATED (memory adapter).
- `test/integration/status-embedded-repository-interop.test.ts` — CREATED. `@proves` surface and
  interopSurface `status`; unique line "status lists an untracked repository as its directory as
  git does". Gate it with `describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')` (EM30
  needs a symlink).
- `reports/api.json` — regenerate with `npm run docs:json` after the JSDoc change.

Public-surface decisions: no new symbol. `StatusResult.untracked` keeps its type
(`ReadonlyArray<FilePath>`); only its content and the JSDoc change, hence api.json. The new
spelling helper is INTERNAL.

Read-only references: Part 24's `embeddedRepositories`; status.ts `pruneGitlinkDirectories`
use (:303) and the `trackedPaths` filter (:306); test/integration/status-interop.test.ts (helpers
`git`, the scrubbed env), test/integration/git-parity-containment-interop.test.ts :1234 (a `-uall`
comparison that must stay green); test/unit/application/commands/status.test.ts `seedClean` (:43).

Current code: `scanUntracked(ctx, index, trackedPaths)` walks with `{ ignore }` and pushes every
walked path that is not tracked; it never reads `stat`.

Target:

    const repositories = embeddedRepositories(ctx, index.entries);   // the index is byte-sorted
    for await (const entry of walkWorkingTree(ctx, { ignore, isNestedRepository: repositories.holds })) {
      if (!trackedPaths.has(keyOfPath(entry.path))) untracked.push(untrackedSpelling(entry));
    }
    // untrackedSpelling: a directory leaf (isDirectory && !isSymbolicLink) is `${path}/`, else path

A tracked file that became a repository is listed by the walk as 'sub' and dropped by
`trackedPaths`, so it is never untracked (EM78's worktree column is out of scope). The JSDoc says
that a directory holding another repository is listed once, with a trailing slash.

Pins (design EM, compared with `git status --porcelain -uall -z`, the `??` entries):

| Row | Setup | git 2.55 |
|---|---|---|
| EM9 | EM1 (repository 'sub' with 'sub/u' committed inside) | `?? sub/` |
| EM30 | 'sub/.git' a symlink to an outside repository, 'sub/u' beside it | `?? sub/` |
| EM38 | EM32 (HEAD 'garbage') | `?? sub/u` |
| EM76 | tracked 'sub/u', a repository made inside 'sub', untracked 'sub/new' | `?? sub/new` |
| EM74 | tracked 'sub/u', a repository made inside 'sub' | clean |
| EM53 | EM1 plus rule 'sub/' | `?? .gitignore` only |
| EM66 | tracked file 'sub' turned EM1's repository | 'sub' is not untracked (control) |

### TDD steps

1. RED: EM9 (status-embedded-repository.test.ts plus the interop row). `status(ctx)` gives
   `untracked: ['sub/']` and `clean: false`. Fails: `untracked: []`, because the default gate
   collapses 'sub'. GREEN: the reader, the hook and the spelling. GUARD: EM30 ('sub/', not
   'sub/u'), EM38, EM76, EM74 (`clean: true`), EM53, EM66; status.test.ts, status-interop and the
   git~1 containment row stay green.
2. REFACTOR: the JSDoc; `npm run docs:json`.

### Gate

```bash
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/unit/application/commands/status-embedded-repository.test.ts test/unit/application/commands/status.test.ts test/integration/status-embedded-repository-interop.test.ts test/integration/status-interop.test.ts test/integration/git-parity-containment-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/commands/status.ts test/unit/application/commands/status-embedded-repository.test.ts test/integration/status-embedded-repository-interop.test.ts \
  && npm run check:spelling && npm run check:test-pyramid; echo "gate exit=$?"
```

### Commit

`fix(status): list an untracked repository as its directory, as git does`

## Part 29 — Raise the size caps by the measured delta of embedded-repository staging

### Context

No src/ delta: a config and docs part, standalone under the sizing rules, after Parts 23–28 and
before the review round (lesson 006 says the review round may cross the caps again; the session
re-runs this procedure then if it does). The design estimates +300 to +500 B gzip (Part k, size).
Fact 39: four rows were already 10–42 B over their caps before Part 23.

Files this part creates or edits (each only if its check is red):
- `.size-limit.json`
- `tooling/verify-tarball.sh` — the cap and its attribution comment, in the format of the last
  raise there.
- `docs/design/bundle-size-optimization.md` — a new "Size-limit raise — …" section after "Size-limit
  raise — the pathspec glob dialect" (:673), in its format.

Read-only references: docs/lessons/006-size-caps-at-the-headroom-floor-trip-again-on-the-review-round.md
(read it first); commit `2ccbbffd` (`git show --no-ext-diff 2ccbbffd` shows the last raise across
the three files); Part 22 (the same procedure).

Procedure:
1. `rm -rf dist .wireit && npm run check:size`, then `npm run check:tarball`. Read EVERY row of
   both outputs. Stale dist chunks fake reds, so the clean rebuild is the measurement.
2. Baseline = the tree just before Part 23:
   `pre=$(git log --format=%h -1 --grep='nested repository as one directory leaf')^`. Without
   touching repo state: `base=$(mktemp -d)`, `git archive "$pre" | tar -x -C "$base"`,
   `ln -s "$PWD/node_modules" "$base/node_modules"`, then in `$base` run
   `npm run build && npx size-limit --json > <scratch>/pre-embedded-size.json`, and the tarball
   check the same way.
3. For each red row, take three numbers in gzip bytes: the cap, the baseline and this round's
   measurement. The raise is measurement − cap, rounded up to the next 0.1 kB. Record it as two
   parts: the baseline − cap overage (the triage and refactor commits before Part 23) and the
   measurement − baseline delta (this round: the walk hook and leaf, the probe split, the reader,
   the error member and its message, the embedded step and the index-side type change, the literal
   ancestor probe, the status spelling). Confirm each new limit is ≥ the measurement.
4. No row red → edit nothing and commit nothing; report the measured headroom per row instead.
5. api.json drift: `npm run docs:json && git diff --no-ext-diff --stat reports/api.json` prints
   nothing (Parts 23, 25, 27 and 28 regenerated it). A diff means a part changed the public
   surface without regenerating: stop and report `{ unit: Part 29, reason, options }`.

House rules: poll, never wait (`check:size` builds). Never run two `npm run` scripts at once.
Commit only this part's files.

### TDD steps

1. Measure per the procedure (no test rows: config only).
2. Raise only the red rows by the measured amount; record both parts of each raise.
3. The api.json drift check.

### Gate

```bash
rm -rf dist .wireit && npm run check:size && npm run check:tarball \
  && ./node_modules/.bin/biome check .size-limit.json \
  && npx cspell --no-progress docs/design/bundle-size-optimization.md; echo "gate exit=$?"
```

Drop a file from the biome/cspell arguments when this part did not edit it.

### Commit

`fix(add): raise the size caps by the measured delta of embedded-repository staging`
