# Design — pathspec glob dialect, unmatched-glob refusal, `describe`/`name-rev` patterns

> Brief: backlog 32.11, non-breaking head only. (a) pathspecs in `add`/`rm`/`checkout`/`grep`
> match with git's default dialect: `wildmatch(pattern, path, 0)` after a verbatim-prefix check;
> (b) a positive pathspec that matches nothing refuses atomically, before any write, per git's
> per-command rule; (c) `describe --match`/`--exclude` use the same flags-0 dialect on the short
> tag name; (d) `name-rev --refs`/`--exclude` match every `/`-suffix of the refname and expose
> git's abbreviation signal; (e) docs fold-in, carried by the plan. Magic pathspecs, `:(exclude)`,
> the `!` alias and the ADR superseding 038 are 32.11b, out.
> Status: draft → self-reviewed ×3 → accepted → revised against ADR-1044 (2026-10-22) → folded the tracked-under-ignore staging gap (2026-10-22) → review pins folded: empty-directory literal, hidden conflicted path (2026-10-22) → folded the
> skip-worktree, gitlink, ignored-report and backslash-name gaps: R13–R17, Parts f–i, candidates 13–19 (2026-10-23) → folded literal positives
> honouring exclusions: R18, Part j, candidate 20 (2026-10-23)

## Context

### What exists

| Surface | File / symbol | Dialect today |
|---|---|---|
| Pathspec compile | `src/domain/pathspec/compile-pathspec.ts` `compilePathspec` / `compileOne` / `compileLiteral` | literal (`!containsGlob`) → `compileGlob(body, { anchored: true, withDirSuffix: true })`; glob → `compileGlob(body, { anchored: body.includes('/') })` — gitignore anchoring, so `foo*` is tried at every directory depth |
| Glob engine | `src/domain/pathspec/compile-glob.ts` `compileGlob` | UTF-16 code units; `*`/`?` never cross `/` outside `pathname`; no `[…]`, no `\`; `containsGlob` = `*` or `?` |
| Match | `src/domain/pathspec/match-pathspec.ts` `matchesPathspec` (last match wins, ADR-038), `withoutExactly`, `matchesUnmergedPath` (ADR-1000); `matching-path.ts` `matchesIndexPath` via `escapedPathOf` (ADR-980) | — |
| Resolve | `src/application/commands/internal/resolve-pathspec.ts` `resolvePathspec` → `{ matcher, literalMustMatch, literalSpellings, hasGlob, symlinkScanTargets }`; `enforceLiteralMustMatch`; `enforcePatternBudget` | only literals must match; `hasGlob` relaxes the no-match check |
| wildmatch port | `src/domain/refs/ref-glob.ts` `compileRefGlob` (flags 0), `compilePathnameGlob` (`WM_PATHNAME`), `matchRefGlob` | UTF-8 bytes via `encode(text)` per call; `[…]`, POSIX classes, `\x`, abort → match nothing; linear DP |
| `describe` | `src/domain/describe/match.ts` `buildNameFilter` | `compileGlob(pattern, { anchored: true })` on the short tag name |
| `name-rev` | `src/domain/name-rev/ref-pattern.ts` `buildRefFilter` | `matchRefGlob` on the FULL refname only |

`compileGlob` call sites (every one, with options):

| Caller | Options |
|---|---|
| `src/domain/ignore/parse-gitignore.ts:101` | `{ anchored, pathname: true }` |
| `src/domain/attributes/parse-gitattributes.ts:125` | `{ anchored, pathname: true }` |
| `src/domain/sparse/non-cone.ts:29` | `{ anchored, withDirSuffix: recursive, pathname: true }` |
| `src/domain/pathspec/compile-pathspec.ts:51` (literal) | `{ anchored: true, withDirSuffix: true }` — the body holds no `*`/`?`, so only `literal` tokens |
| `src/domain/pathspec/compile-pathspec.ts:66` (glob) | `{ anchored: body.includes('/') }` |
| `src/domain/describe/match.ts:13` | `{ anchored: true }` |

The non-`pathname` star path (`scanStar`) is reached only by the last two rows.

Consumers of the compiled `Pathspec` (all inherit the dialect change): `add.ts`, `rm.ts`,
`checkout.ts`, `grep.ts`, `primitives/snapshot/tree-snapshot.ts:57`,
`primitives/snapshot/index-snapshot.ts:66`, `adapters/snapshot-resolvers/fs-workdir-enumerator.ts:79`.
`compilePathspec` and `compileGlob` are not public; the `Pathspec` type is (`src/public-types.ts:85`),
so the `PathspecEntry` shape (`pattern`, `body`, `negated`, `isLiteral`, `compiled.test`) is kept.

### Binding decisions

- ADR-226 / CLAUDE.md prime directive — byte-for-byte git behaviour; ADR-249 — structured data, the
  caller renders.
- ADR-037 (auto-detect; its text counts `[`, `containsGlob` does not), ADR-040 (shared
  `compileGlob`) — amended in the decisions phase from candidates 1, 2 and 9.
- ADR-077 + `docs/design/compile-glob-redos.md` — matchers are linear, no backtracking, no `RegExp`.
- ADR-980 — lossy entries match through the surrogate-escape view. Option 3 there (a byte-level
  matcher) was rejected; its Consequences leave "valid multi-byte `?`" open. Candidate 1 reopens
  that choice for the wildcard part only.
- ADR-038 (`!` negation) stays. ADR-1000 (`withoutExactly`) is untouched.

### Pinning procedure used

git **2.55.0** (`<git-2.55.0-bin>`, `git --version` printed in every probe log).
Each scenario ran in its own `mktemp -d` repo. The environment had every `GIT_*` variable unset,
`HOME` set to an empty temp dir, `GIT_CONFIG_NOSYSTEM=1` and `LC_ALL=C`, and git ran with
`-c commit.gpgsign=false -c tag.gpgsign=false -c user.name=Ada -c user.email=ada@example.com` and
`git init -q -b main`. Fixture files contain their own name. The dialect, refusal and
rm/checkout/grep scripts were re-run with `-c core.ignorecase=false`, and their output was
identical (macOS APFS defaults `core.ignorecase=true`). B1 was run three times, all `exit=128`.
The "tsgit today" column comes from **reading the code** (compile path above), not from running
tsgit.

Fold rows (S, SC, GL, I, W; 2026-10-22/23) used the same procedure, plus
`-c protocol.file.allow=always` for the submodule fixtures. Their tsgit column was **run**, not
read. A jiti script called the command functions through `createNodeContext` on the same
fixture, against `git archive 98c84b01 src` extracted to a scratch directory, because the shared
working tree held another agent's uncommitted edits. I13–I30, GL20, GL21, GL23, W6 and W10 ran once,
against the snapshot. Every other fold row ran twice, once against the working tree and once
against the snapshot, with identical results.

## Requirements

- R1. A pathspec entry selects path `p` iff git's `match_pathspec_item` does:
  1. verbatim first, byte-compared: `body === p` (exact), or `p` starts with `body` and either
     `body` ends in `/` or `p[body.length] === '/'` (recursive);
  2. else, if `body` holds a glob-special byte (`*`, `?`, `[`, `\`),
     `wildmatch(body, p, 0)`: `*`/`?` cross `/`, `[…]` with `!`/`^`, ranges and the twelve classes,
     `\x` escape, matched on both ends, abort cases match nothing. Matching runs over **bytes**
     (D11, L1–L5).
- R2. `add`, `add --renormalize`, `rm` refuse with `PATHSPEC_NO_MATCH { pattern }` naming the
  **first** unmatched positive pathspec in argument order. Nothing is staged, removed, rewritten
  or written to the object store: zero loose objects (B1, B2).
- R3. `checkout <source> -- <pathspec>` refuses when any positive pathspec matches nothing in the
  source universe (the index, or the source tree only: C8) and rewrites nothing. git names
  **every** unmatched pathspec in argument order (C4, C5; data shape: candidate 5). git takes the
  index lock before the check (K1; candidate 6).
- R4. `rm` without `recursive` refuses `RM_RECURSIVE_WITHOUT_R` for a pathspec whose best match
  level over the index is "recursive". This covers globs reaching a directory verbatim (R4b), and
  it does not fire when a wildcard match also exists (R4).
- R5. An unmatched pathspec whose verbatim body exists on disk is not refused by `add` (B11/B11′:
  git's `file_exists` escape). On the walk path the escape covers wildcard bodies only (candidate
  4, ADR-1036). Under `add --renormalize` it covers literal and wildcard bodies (RN4, RN5). A body
  holding `\` never takes either escape (R11).
  Review pin (git 2.55): an unseen literal naming an empty directory is not refused either (`add e`
  exits 0; `add e 'k*'` stages `k`); a literal naming an ignored path keeps refusing until the
  ignored-paths report exists (ADR-1045 supersedes ADR-1036's wildcard-only scope). R16 builds
  that report and retires the interim.
- R6. `grep` never refuses an unmatched pathspec (G1, G5).
- R7. `describe` include/exclude = `wildmatch(pattern, shortTagName, 0)` (DS rows).
- R8. `name-rev` include/exclude = git's `subpath_matches`: the full refname, then each suffix after
  a `/`. Excludes are tested first. Whether an include matched only through a suffix (git's
  `can_abbreviate_output`) reaches the caller as data (candidate 8); the library does not shorten
  the name itself.
- R9. Gitignore, gitattributes and sparse rules are unchanged (`pathname` dialect).
- R10. Every matcher stays linear (ADR-077). The browser bundle stays under its cap or the cap
  change is a user decision (candidate 11). The `add` glob path regresses by no more than
  `bench:ab` noise on the add bench.
- R11. When the context does not set `windowsPathSyntax`, `resolvePathspec` accepts a pathspec
  body holding `\` (D6, D17, E2). The body is used for matching only: it is never `lstat`ed, never
  the subject of an on-disk escape, and the symlink scan covers only its no-wildcard prefix. Under
  Windows path syntax the body is refused `PATHSPEC_OUTSIDE_REPO`, as today. Every other
  `validateWorkingTreePath` caller keeps refusing `\` (ADR-1044).
- R12. `add` stages every tracked stage-0 entry that the pathspec matches and ignore rules hide
  from the walk, as git's index-side pass does (B8, B14, B15, B16's staging). The same holds for
  `add({ all: true })`. Pinned against git 2.55 on B8's fixture (`.gitignore: *.log`, tracked
  `x.log` modified):
  - `add -A` stages `M  x.log`; on B14's fixture it stages `M  d/x.txt`. `add -u` also stages
    `M  x.log`, but tsgit has no `-u`.
  - Intent-to-add `x.log` (`add -N`, then ignored): `add .` and `add '*.log'` both stage it
    (`A  x.log`, blob of the content). It is **not** an exception.
  - Gitlink `sub`, ignored, with a new commit inside: `add .` and `add 's*'` both stage the new
    commit (`M  sub`). It is **not** an exception.
  - Skip-worktree `x.log`, modified: `add .` leaves it unstaged (only `A  .gitignore`). `add '*.log'`
    exits 1 with the sparse-checkout advice and stages nothing. Skip-worktree **is** the exception.
    Its report is R13.
  - To pin in the part: an unmerged (stage 1–3) path under an ignore rule.
- R13. `add` never restages, removes or clears the bit of a skip-worktree entry, whatever its file
  on disk holds: the walk, the literal fast path and `add({ all: true })` leave it (S1, S8, S10,
  S11, S13); `--renormalize` already does (S14). A positive pathspec that no other index entry and
  no walk leaf reached, but that matches a skip-worktree entry, is not refused: it is **reported**
  by its spelling (S2–S7, S12, S15). git exits 1 and still stages every other match (S5–S7). A
  pathspec some other path also reached is silent (S8). The unmatched-pathspec refusal (R2) wins
  over the report, and nothing is staged (S9). Report shape: candidate 13. This replaces R12's
  "the advice stays out of scope".
- R14. `checkout [<source>] -- <pathspec>` leaves out of its path universe every path whose
  current index entry has the skip-worktree bit, for the index and the tree source alike (SC1–SC12).
  Such a path is never written and keeps its bit. A pathspec that only matches such paths refuses
  `PATHSPEC_NO_MATCH` under R3, with the same all-or-nothing outcome (SC1–SC4, SC9–SC12).
- R15. `add` stages a stage-0 gitlink entry whose submodule checkout HEAD differs from the index
  id, ignored or not, by `.`, `<path>`, `<path>/`, a glob or `add({ all: true })` (GL1–GL10). The
  HEAD is the repository `<path>/.git` leads to, a directory or a gitfile, not the `.gitmodules`
  name (GL17–GL19). The path lands in `modified`. Nothing is staged when HEAD equals the index id,
  when the directory is empty, or when the repository there has no commit (GL11–GL13, GL16). A
  skip-worktree gitlink is left (GL23) and `--renormalize` leaves gitlinks alone (GL22). A
  `<path>/.git` that leads to no repository is a refusal in git (GL20, GL21; candidate 17).
- R16. `add` **reports** every ignored entry its walk prunes that a positive pathspec reaches.
  Nothing untracked beneath a reported entry is staged. An ignored entry is an ignored directory,
  whatever it holds, or an ignored untracked file. A tracked file is never one (B13, I27). A
  positive reaches entry `E` when its no-wildcard prefix `P` (the bytes before the first
  `* ? [ \`, Part a's literal-prefix helper) equals `E` or starts with `E/`. So `x.log`, `d`,
  `d/`, `d/q.txt`, `d*`, `d/*.txt` and `d/x*` report (I1–I4, I7–I10, I17–I23, I29), and `*`, `?`,
  `*.log` and `?.log` do not (I25–I28, I30). That rule is inferred from these rows, not from git's
  source. The listed path is the pruned entry (`d` for `d/q.txt`, I9), sorted (I4). git exits 1
  and still stages every other match, tracked files beneath the reported directory included (I2,
  I3, I10, I17, I19–I23). The unmatched-pathspec refusal runs first: nothing is reported or staged
  (I5, I6, I24). Every literal naming something on disk takes git's `file_exists` escape, ignored
  or not (I1, I7). B11′ stays exit 0 with no report (`P` = `nomatch` ≠ `nomatch*`). This retires
  R5's and ADR-1045's "a literal naming an ignored path keeps refusing" interim. With
  `force: true` nothing is ignored, so nothing is reported (I12–I16). Report shape: candidate 13;
  `force`: candidate 14; release class: candidate 15.
- R17. On a host without Windows path syntax, the working-tree walk yields an entry whose name holds
  `\`, as git's walk does (W1–W5, W7, W16): `add`, `status` and every other `walkWorkingTree`
  consumer see it. Under Windows path syntax the walk keeps refusing it (candidate 18). `rm`'s
  working-tree removal of such a path is candidate 19 (W8, W9).
- R18. When every positive pathspec is a literal, `add` applies the `!` exclusions (git's `:!`)
  exactly as the walk route does. An excluded path is neither staged nor restaged, and no blob is
  written for it, whether it is untracked or tracked and modified (X1–X3, X5, X7–X10, X12, X14).
  An exclusion that reaches nothing changes nothing (X4, X11). An argument-order swap changes
  nothing (X7, X14). A literal whose every match is excluded is not refused when its path exists
  on disk: exclusion runs before the seen-marking and git's `file_exists` escape runs after it
  (X1, X15). A wildcard positive whose matches are all excluded still refuses (X16, X17). `rm`
  and `checkout` already honour exclusions on literals (X20–X26).

## Design

### Pin matrix (git 2.55.0)

Notation: `ok` = tsgit today gives git's result; `✗` = it diverges (consequence noted). "index" is
`git ls-files` after the command. "loose" counts loose objects (`.git/objects/??/*`).

#### A — dialect (`git add <spec>` on untracked files)

| # | Files | Spec | git: exit · stderr · index | tsgit today |
|---|---|---|---|---|
| D1 | `a/b/c.txt top.txt other.md` | `*.txt` | 0 · — · `a/b/c.txt top.txt` | ok (unanchored `(.*/)?` coincides) |
| D2 | `src/a/b.ts src/x.ts y.ts` | `src/*.ts` | 0 · — · `src/a/b.ts src/x.ts` | ✗ `src/x.ts` only |
| D3 | `dir/foobar foo1 keep` | `foo*` | 0 · — · `foo1` | ✗ also stages `dir/foobar` (wrong file) |
| D4 | `a/x bx x` | `?x` | 0 · — · `bx` | ok |
| D5a | `a.txt b.txt d.txt 1.txt` | `[a-c].txt` | 0 · — · `a.txt b.txt` | ✗ stages nothing, no error |
| D5b | same | `[!a].txt` | 0 · — · `1.txt b.txt d.txt` | ✗ nothing |
| D5c | same | `[^a].txt` | 0 · — · `1.txt b.txt d.txt` | ✗ nothing |
| D5d | same | `[[:digit:]].txt` | 0 · — · `1.txt` | ✗ nothing |
| D5e | `a/b x` | `[/a]*` | 0 · — · `a/b` | ✗ nothing |
| D6 | `a*b aXb` | `a\*b` | 0 · — · `a*b` (re-run 2026-10-22: same) | ✗ refuses `PATHSPEC_OUTSIDE_REPO` at intake (probed: `resolvePathspec`). ADR-1044 delivers it on POSIX |
| D7 | `dir/f d.txt` | `d*/` | 128 · `fatal: pathspec 'd*/' did not match any files` · empty | ✗ no error |
| D8a | `a[ ab` | `a[` | 0 · — · `a[` (verbatim; wildmatch aborts) | ok (literal) |
| D8b | `a\ ab` | `a\` | 0 · — · `"a\\"` (re-run 2026-10-22: same) | ✗ refuses `PATHSPEC_OUTSIDE_REPO` at intake (probed: `resolvePathspec`). Follow-up: needs a `\`-named file, which the walk refuses (Out of scope) |
| D8c | `ab` | `a[[:foo:]]` | 128 · `fatal: pathspec 'a[[:foo:]]' did not match any files` · empty | ok (literal refusal) |
| D9 | `a?/f ab` | `a?` | 0 · — · `a?/f ab` (verbatim-recursive + wildmatch) | ✗ `ab` only |
| D10 | `dir/file` | `di?` | 128 · `fatal: pathspec 'di?' did not match any files` · empty | ✗ no error |
| D11 | `é.txt a.txt` | `?.txt` | 0 · — · `a.txt` (`?` = one byte) | ✗ also stages `é.txt` |
| D11b | same | `??.txt` | 0 · — · `"\303\251.txt"` | ✗ nothing |
| D12 | `x.txt d/x.txt` | `**/x.txt` | 0 · — · `d/x.txt` | ✗ also `x.txt` |
| D13 | `a/b/c a/d` | `a/**` | 0 · — · `a/b/c a/d` | ok |
| D14 | `d/a.txt e.txt` | `d/*` | 0 · — · `d/a.txt` | ok |
| D16 | `a ] b` | `[]a]` | 0 · — · `] a` | ✗ refuses (read as a literal) |
| D17 | `a?b axb` | `a\?b` | 0 · — · `a?b` (re-run 2026-10-22: same) | ✗ refuses `PATHSPEC_OUTSIDE_REPO` at intake (probed: `resolvePathspec`). ADR-1044 delivers it on POSIX |
| E1 | `a\b ab` | `a\b` | 0 · — · `"a\\b" ab` (re-run 2026-10-22: same) | ✗ refuses `PATHSPEC_OUTSIDE_REPO` at intake (probed: `resolvePathspec`). Follow-up: needs a `\`-named file, which the walk refuses (Out of scope) |
| E2 | `ab` | `a\b` | 0 · — · `ab` (re-run 2026-10-22: same) | ✗ refuses `PATHSPEC_OUTSIDE_REPO` at intake (probed: `resolvePathspec`). ADR-1044 delivers it on POSIX |
| E3 | `a[b ab` | `a[b` | 0 · — · `a[b` (abort; verbatim only) | ok |
| E4 | tracked `a?/f ab` | `git grep -l . -- 'a?'` | 0 · out `a?/f`, `ab` | ✗ `ab` only |
| E5 | tracked `a?/f`, dirty | `git checkout -- 'a?'` | 0 · — · `a?/f` restored | ✗ zero-match glob no-op, file stays dirty |

#### L — byte semantics on index entries (`git update-index --add --cacheinfo`, no file needed, so these run on APFS)

Index: `a\377` (lossy), `a\303\251` (`aé`), `ab`.

| # | Command | git output (`ls-files -z`, bytes) | tsgit today (escape view) |
|---|---|---|---|
| L1 | `ls-files -- 'a?'` | `ab`, `a\377` | ✗ also `aé` (`?` on one code unit) |
| L2 | `ls-files -- 'a??'` | `a\303\251` | ✗ none |
| L3 | `ls-files -- 'a[^b]'` | `a\377` | ✗ none (`[` literal) |
| L4 | `ls-files -- 'a*'` | all three | ok |
| L5 | `ls-files -- 'a[[:alpha:]]'` | `ab` | ✗ none |
| L6 | `rm --cached -q 'a?'` | exit 0; index left: `a\303\251` | ✗ removes `aé` too |

A lossy *file name* (`printf x > $'a\377'`) cannot be created on APFS (`Illegal byte sequence`).
The worktree-side lossy rows (`add` of a lossy file) need the Linux CI leg. L1–L6 cover the
matcher itself.

#### B — `add` refusal

| # | Setup | Command | git: exit · stderr · index · loose | tsgit today |
|---|---|---|---|---|
| B1 | `real.txt` | `add 'nomatch*' real.txt` | 128 · `fatal: pathspec 'nomatch*' did not match any files` · empty · 0 | ✗ stages `real.txt` |
| B2 | `a.txt` | `add 'a*' 'nomatch*'` | 128 · `… 'nomatch*' …` · empty · 0 | ✗ stages `a.txt` |
| B2b | `a.txt` | `add 'nomatch*' 'a*'` | 128 · `… 'nomatch*' …` · empty · 0 | ✗ |
| B3 | `x.log`, `.gitignore: *.log` | `add '*.log'` | 128 · `fatal: pathspec '*.log' did not match any files` · empty · 0 | ✗ no error |
| B3l | same | `add x.log` | 1 · `The following paths are ignored by one of your .gitignore files:` / `x.log` / 2 `hint:` lines · empty | ✗ stages `x.log` (run; I1, Part h) |
| B3m | `x.log real.txt`, same ignore | `add x.log real.txt` | 1 · same advice · `real.txt` | ✗ stages both (run; I2, Part h) |
| B3x | `x.log`, same ignore | `add 'x*'` | 128 · `… 'x*' …` · empty | ✗ |
| B3d | `d/x.log d/y.txt`, same ignore | `add 'd/*.log'` | 128 · `… 'd/*.log' …` · empty | ✗ |
| B4 | `x.log real.txt`, same ignore | `add '*.log' real.txt` | 128 · `… '*.log' …` · empty · 0 | ✗ stages `real.txt` |
| B4b | same | `add real.txt '*.log' 'nomatch*'` | 128 · `… '*.log' …` (first unmatched) · empty | ✗ |
| B4c | `d/x.log real.txt`, `.gitignore: d/` | `add '*.log'` | 128 · `… '*.log' …` · empty | ✗ |
| B6 | tracked clean `t.txt` | `add 't*'` | 0 · — · `t.txt` | ok |
| B7 | tracked `t.txt u.txt`, `t.txt` deleted | `add 't*'` | 0 · — · `u.txt` (deletion staged) | ok |
| B8 | tracked `x.log` modified, now ignored | `add '*.log'` | 0 · — · `M  x.log` (re-run 2026-10-22: same) | ✗ stages nothing, ` M x.log` (pre-existing; the walk prunes tracked-but-ignored paths) |
| B9 | `a` | `add 'n1*' 'n2*'` | 128 · `… 'n1*' …` | ✗ no error |
| B10 | `a` | `add missing 'n1*'` | 128 · `… 'missing' …` | ok (literal refusal) — but after the walk, see below |
| B10b | `a` | `add 'n1*' missing` | 128 · `… 'n1*' …` | ✗ names `missing` |
| B11 | file named `nomatch*`, `.gitignore: nomatch[*]` | `add 'nomatch*'` | 0 · — · empty | ok by accident (no error, nothing staged) |
| B11′ | file named `nomatch*`, `.gitignore: nomatch?` | `add 'nomatch*'` | 0 · — · empty · 0 (re-run 2026-10-22: same) | ok by accident. Test fixture for B11: tsgit's gitignore dialect has no `[…]`, so B11 cannot be twinned |
| B12 | `a.txt` | `add . 'nomatch*'` | 128 · `… 'nomatch*' …` · empty | ✗ stages `a.txt` |
| B12r | `a.txt` | `add 'zz*' .` | 128 · `fatal: pathspec 'zz*' did not match any files` · empty · 0 (re-run 2026-10-22: same) | ✗ stages `a.txt` |
| B13 | B8's fixture | `add x.log` | 0 · — · `M  x.log` (re-run 2026-10-22: same) | ok (`modified: ['x.log']`; the literal fast path reads the index) |
| B14 | tracked `d/x.txt k`, then `.gitignore: d/`, `d/x.txt` modified | `add .` | 0 · — · `A  .gitignore`, `M  d/x.txt` (re-run 2026-10-22: same) | ✗ stages `.gitignore` only, ` M d/x.txt` kept |
| B15 | same | `add '*.txt'` | 0 · — · `M  d/x.txt` (re-run 2026-10-22: same) | ✗ stages nothing |
| B16 | same | `add d` | 1 · `The following paths are ignored by one of your .gitignore files:` / `d` / 2 `hint:` lines · `M  d/x.txt` (re-run 2026-10-22: same) | staging: ✗ stages nothing. Advice and exit 1: Part h (I20) |
| RN1 | tracked `a.txt` | `add --renormalize 'nomatch*'` | 128 · `… 'nomatch*' …` | ✗ no error |
| RN2 | same | `add --renormalize 'a*' 'nomatch*'` | 128 · `… 'nomatch*' …` | ✗ |
| RN3 | same | `add --renormalize 'a*'` | 0 | ok |
| RN4 | tracked `a.txt`, untracked file named `nomatch*` | `add --renormalize 'nomatch*'` | 0 · — · `a.txt`, unchanged (re-run 2026-10-22: same) | ok (no error today) |
| RN5 | tracked `a.txt`, untracked `untracked.txt` | `add --renormalize untracked.txt` | 0 · — · `a.txt`, unchanged (re-run 2026-10-22: same) | ok (`literalsOnDisk`) |
| RN6 | same | `add --renormalize 'untr*'` | 128 · `fatal: pathspec 'untr*' did not match any files` · unchanged (re-run 2026-10-22: same) | ✗ no error |

**Refuted brief hypothesis:** `git add '*.log'` where every match is ignored is the plain
`did not match` refusal (exit 128, B3/B3x/B3d/B4c), **not** the "paths are ignored" advice. That
advice (exit 1) is the literal-path behaviour (B3l/B3m). (b) therefore needs no ignored-path scan.
The fold's R16 adds that report as its own part (Part h). Rows I17–I30 pin which pathspecs
reach it.

Loose objects: tsgit's `addByPathspec` stages (hashes and `writeObject`s) every walked leaf in
`stageIgnoredWalk` (`add.ts:883`, write at `add.ts:1414`). It runs `enforceLiteralMustMatch`
only after that (`add.ts:748`). A refusal on that path leaves loose blobs where git leaves 0
(B1/B2 `loose`). This also applies today to a literal that is refused on the walk path (B10).

#### R — `rm` refusal

| # | Setup (all tracked) | Command | git: exit · stdout/stderr · index | tsgit today |
|---|---|---|---|---|
| R1 | `tracked.txt` | `rm 'nomatch*' tracked.txt` | 128 · `fatal: pathspec 'nomatch*' did not match any files` · `tracked.txt`, file kept | ✗ removes `tracked.txt` |
| R1b | same | `rm tracked.txt 'nomatch*'` | 128 · same · unchanged | ✗ |
| R2 | `dir/foobar foo1` | `rm 'foo*'` | 0 · `rm 'foo1'` · `dir/foobar` | ✗ also removes `dir/foobar` (data loss) |
| R3 | `a/b/c.txt top.txt k.md` | `rm '*.txt'` | 0 · `rm 'a/b/c.txt'`, `rm 'top.txt'` · `k.md` | ok |
| R4 | `a?/f ab` | `rm 'a?'` | 0 · `rm 'a?/f'`, `rm 'ab'` · empty | ✗ removes `ab` only |
| R4b | `a?/f zz` | `rm 'a?'` | 128 · `fatal: not removing 'a?' recursively without -r` · unchanged | ✗ silent no-op |
| R4c | same | `rm --cached 'a?/'` | 128 · `fatal: not removing 'a?/' recursively without -r` | ok (literal) |
| R5 | `a?/f ab` | `rm -r 'a?'` | 0 · both removed | ✗ `ab` only |
| R6 | `dir/f` | `rm 'd*'` | 0 · `rm 'dir/f'` (fnmatch, no `-r` needed) | ✗ silent no-op |
| R7 | `x.txt`, untracked `untracked.txt` | `rm 'untr*'` | 128 · `… 'untr*' …` | ✗ no error |
| R8 | `a.txt` | `rm --cached 'n1*' 'n2*'` | 128 · `… 'n1*' …` | ✗ |

#### C — `checkout -- <spec>` refusal

| # | Setup (all tracked) | Command | git: exit · stderr · tree | tsgit today |
|---|---|---|---|---|
| C1 | `dirty.txt` modified | `checkout -- 'nomatch*' dirty.txt` | 1 · `error: pathspec 'nomatch*' did not match any file(s) known to git` · still dirty | ✗ restores `dirty.txt` |
| C1b | same | `checkout -- 'd*' 'nomatch*'` | 1 · same line · still dirty | ✗ restores |
| C2 | `a/b/c.txt` modified | `checkout -- '*.txt'` | 0 · — · restored | ok |
| C3 | `dirty.txt` modified | `checkout HEAD -- 'nomatch*' dirty.txt` | 1 · same line · still dirty | ✗ |
| C4 | `a.txt` | `checkout -- 'n1*' 'n2*'` | 1 · `error: pathspec 'n1*' did not match any file(s) known to git` then the same for `'n2*'` | ✗ no-op success |
| C5 | `a.txt` | `checkout -- 'n1*' missing` | 1 · two lines, `'n1*'` then `'missing'` | ✗ names `missing` only |
| C6 | `dir/foobar foo1` both modified | `checkout -- 'foo*'` | 0 · `foo1` restored, ` M dir/foobar` kept | ✗ restores `dir/foobar` too (discards a change) |
| C7 | `x.txt`, untracked `untracked.txt` | `checkout -- 'untr*'` | 1 · `… 'untr*' did not match any file(s) known to git` | ✗ |
| C8 | `a.txt`; `new.txt` staged, not in HEAD | `checkout HEAD -- 'new*'` | 1 · `error: pathspec 'new*' did not match any file(s) known to git` · index unchanged (seen = source tree only) | ✗ no-op success |
| C9 | same | `checkout HEAD -- new.txt` | 1 · same line for `'new.txt'` | ok (tree universe) |

#### G — `grep` (no refusal)

| # | Setup (tracked) | Command | git | tsgit today |
|---|---|---|---|---|
| G1 | `a.txt` | `grep a -- 'nomatch*'` | exit 1, no output | ok |
| G2 | `a/b/c.txt top.txt` | `grep txt -- '*.txt'` | 0 · both files | ok |
| G3 | `dir/foobar foo1` | `grep o -- 'foo*'` | 0 · `foo1:foo1` only | ✗ also `dir/foobar` |
| G4 | `a.txt` | `grep a -- 'nomatch*' a.txt` | 0 · `a.txt:a.txt` | ok |
| G5 | `a.txt` | `grep a -- missing` | exit 1, no output | ok |

#### K — refusal precedence against a held `index.lock`

| # | Command | git |
|---|---|---|
| K1 | `checkout -- 'nomatch*'` | 128 · `fatal: Unable to create '<repo>/.git/index.lock': File exists.` + blank + `Another git process …` — the lock is taken before the pathspec check |
| K2 | `add 'nomatch*'` | same lock refusal |
| K3 | `rm 'nomatch*'` | same lock refusal |
| K4 | index replaced by 4 NUL bytes; `checkout HEAD -- '*.nomatch'` | 128 · `fatal: .git/index: index file smaller than expected` — the index is read before the pathspec check, even for a tree source |
| K5 | same; `checkout -- '*.nomatch'` | 128 · same |
| K1L | tracked `a.txt`; `checkout -- missing` (unmatched literal), then `checkout -- a.txt` (tracked literal) | 128 · the K1 lock refusal, both (re-run 2026-10-22: same) |

tsgit today: `add` and `rm` lock first (ok). `checkout.pathRestore` checks the pathspec before
`acquireIndexLock` (`checkout.ts:344-358`), so K1 diverges, for literals too: K1L's `missing`
refuses `PATHSPEC_NO_MATCH` instead of the lock, while its tracked `a.txt` passes the check and
reaches the lock (ok). For a tree source it never reads the index on a zero-match glob, so K4
diverges (no-op success; the test at `checkout.test.ts:992` pins that divergence). K5 is ok today:
the index source reads the index before its check and errors on the corrupt file.

#### DS — `describe` (`--tags --abbrev=0`; `v1.0` annotated + `w2` light on c1, `v1/rc1` annotated on c2, HEAD c3)

| # | Options | git | tsgit today |
|---|---|---|---|
| DS1 | none | `v1/rc1` | ok |
| DS2 | `--match 'v*'` | `v1/rc1` | ✗ `v1.0` (`*` stops at `/`) |
| DS3 | `--match 'v[0-9].*'` | `v1.0` | ✗ `[` read literally → no names → refusal |
| DS4 | `--match 'v1?rc1'` | `v1/rc1` | ✗ no names |
| DS5 | `--match 'v1\.*'` | `v1.0` | ✗ no names |
| DS6 | `--match 'v1\/*'` | `v1/rc1` | ✗ no names |
| DS7 | `--match '[v]1.0'` | `v1.0` | ✗ no names |
| DS8 | `--match 'v*' --exclude 'v1/*'` | `v1.0` | ok |
| DS9 | `--match 'v*' --exclude 'v1*'` | 128 · `fatal: No names found, cannot describe anything.` | ok |
| DS10 | `--match 'v1['` | 128 · same | ok |
| DS11 | `--match 'v1\'` | 128 · same | ok |
| DS12 | `--match '*/*'` | `v1/rc1` | ok |
| DS13 | `--match 'refs/tags/v*'` | 128 · same (short name only) | ok |
| DS14 | (annotated only) `--match 'v*'` | `v1/rc1` | ✗ `v1.0` |

#### N — `name-rev` (c1 holds `v1.0` (annotated) and `w2`; c2 holds `v1/rc1` (annotated); `main` at c3; target c1 unless noted)

| # | Options | git name printed | tsgit today (`ref`) |
|---|---|---|---|
| N1 | none | `tags/v1.0^0` | ok |
| N2 | `--refs 'v*'` | `v1.0^0` (subpath, abbreviated) | ✗ `undefined` |
| N3 | `--refs 'v1.0'` | `v1.0^0` | ✗ `undefined` |
| N4 | `--refs 'tags/*'` | `v1.0^0` | ✗ `undefined` |
| N5 | `--refs 'refs/tags/*'` | `tags/v1.0^0` (full match, not abbreviated) | ok |
| N6 | `--refs 'refs/tags/v*' --refs 'v1.*'` | `v1.0^0` (any subpath include abbreviates) | ✗ form (`tags/…`) |
| N7 | `--refs 'heads/*'` | `main~2` | ✗ `undefined` |
| N8 | `--refs 'main'` | `main~2` | ✗ `undefined` |
| N9 | `--refs 'refs/heads/*'` | `main~2` | ok |
| N10 | `--exclude 'tags/*'` | `main~2` | ✗ `tags/v1.0^0` |
| N11 | `--exclude 'v*'` | `tags/w2` | ✗ `tags/v1.0^0` |
| N12 | `--exclude 'v*' --exclude 'w*'` | `main~2` | ✗ |
| N13 | `--refs 'v*' --exclude 'v1.0'` | `v1/rc1~1` | ✗ `undefined` |
| N14 | `--refs 'ags/v1.0'` | `undefined` (suffixes start after a `/`) | ok |
| N15 | `--refs '*1.0'` | `tags/v1.0^0` (full match wins first) | ok |
| N16 | `--refs 'v1?0'` | `v1.0^0` | ✗ `undefined` |
| N17 | target c2, `--refs 'v1/*'` | `v1/rc1^0` | ✗ `undefined` |
| N18 | target c2, `--refs 'rc1'` | `v1/rc1^0` (last suffix; shortened, not the suffix) | ✗ `undefined` |
| N19 | `--name-only --refs 'v*'` | `v1.0^0` | ✗ |
| N20 | `--tags` | `tags/v1.0^0` | ok |
| N21 | `--tags --name-only` | `v1.0^0` (`tags_only && name_only` abbreviates) | ok (caller strips) |
| N22 | `--tags --refs 'refs/tags/w*'` | `tags/w2` | ok |
| N23 | + branch `v1.0` at c1; `--refs 'v1.0'` | `v1.0^0` (tag wins; `refs/tags/v1.0` shortens unambiguously) | ✗ |
| N24 | same; `--refs 'refs/tags/v1.0'` | `tags/v1.0^0` | ok |
| N25 | new repo: tag `x` at c1, branch `x` at c2; target c2, `--refs 'x'` | `heads/x` (shorten-unambiguous keeps `heads/`) | ✗ `undefined` |
| N26 | same; `--refs 'heads/x'` | `heads/x` | ✗ |
| N27 | same; `--refs 'refs/heads/x'` | `x` (full match; default `refs/heads/` strip) | ok |
| N28 | same; `--refs 'x'`, target c1 | `x` (tag `x`, shortened) | ✗ |

N25 versus N27 shows the abbreviation is `refs_shorten_unambiguous_ref`, not a fixed prefix strip.
That needs ref-existence lookups, so it is display work for the caller (ADR-249). tsgit already
has the primitive: `src/application/commands/internal/shorten-ref.ts` `shortenUnambiguousRef`.

#### S — `add` over a skip-worktree entry (no ignore rules)

Fixture: tracked `x.log k s.txt` committed (5 loose objects), then
`git update-index --skip-worktree x.log`, `x.log` rewritten to `changed\n`, `s.txt` rewritten to
`s2\n`. "S" / "H" is the `ls-files -v` tag. The sparse advice is these exact stderr lines, with
`<spec>` the pathspec **as spelled**:

```
The following paths and/or pathspecs matched paths that exist
outside of your sparse-checkout definition, so will not be
updated in the index:
<spec>
hint: If you intend to update such entries, try one of the following:
hint: * Use the --sparse option.
hint: * Disable or modify the sparsity rules.
hint: Disable this message with "git config set advice.updateSparsePath false"
```

| # | Command | git: exit · stderr · index · loose | tsgit at HEAD (run) |
|---|---|---|---|
| S1 | `add .` | 0 · — · `S x.log` (old blob), `M  s.txt` · 6 | ✗ `modified: [s.txt, x.log]`, `x.log` restaged with the bit cleared (`H`) · 7 |
| S2 | `add '*.log'` | 1 · advice, `<spec>` = `*.log` · unchanged · 5 | ✗ success, `x.log` restaged, bit cleared · 6 |
| S3 | `add x.log` | 1 · advice `x.log` · unchanged · 5 | ✗ same (literal fast path) |
| S4 | `add 'x*'` | 1 · advice `x*` · unchanged · 5 | ✗ same |
| S5 | `add '*.log' s.txt` | 1 · advice `*.log` · `M  s.txt` only · 6 | ✗ both restaged, bit cleared · 7 |
| S6 | `add x.log s.txt` | 1 · advice `x.log` · `M  s.txt` only · 6 | ✗ same |
| S7 | `add 'x*' 's*'` | 1 · advice `x*` · `M  s.txt` only · 6 | ✗ same |
| S8 | `add '*'` | 0 · — (the spec also reached `k`, `s.txt`) · `M  s.txt`, `S x.log` kept · 6 | ✗ `x.log` restaged too · 7 |
| S9 | `add x.log 'nomatch*'` | 128 · `fatal: pathspec 'nomatch*' did not match any files` only, no advice · unchanged · 5 | ok (`PATHSPEC_NO_MATCH 'nomatch*'`, nothing written) |
| S10 | `add -A` | 0 · — · `M  s.txt`, `S x.log` kept · 6 | ✗ `x.log` restaged, bit cleared · 7 |
| S11 | `x.log` deleted from disk instead; `add .` | 0 · — · `M  s.txt`, `S x.log` kept | ok |
| S12 | same; `add x.log` | 1 · advice `x.log` · unchanged | index ok; ✗ success, no report |
| S13 | same; `add -A` | 0 · — · `M  s.txt`, `S x.log` kept | ok |
| S14 | `add --renormalize .` | 0 · — · `M  s.txt`, `S x.log` kept · 6 | ok |
| S15 | `add --renormalize x.log` | 1 · advice `x.log` · unchanged · 5 | index ok; ✗ success, no report |

The existing interop rows with the same entry **under an ignore rule**
(`add-tracked-under-ignore-interop.test.ts:170`, `:196`) pass today: the walk prunes the ignored
`x.log` before the skip-worktree question arises. The rows above have no ignore rule.

#### SC — `checkout -- <spec>` over a skip-worktree entry

Fixture: tracked `sw.txt n.txt`, `sw.txt` skip-worktree, then `sw.txt` rewritten to `sw-dirty`
and `n.txt` to `n-dirty`. Every row was run with no source and with `HEAD`; both gave the same
result, so each row covers both.

| # | Spec (`checkout [HEAD] -- …`) | git: exit · stderr · disk · bit | tsgit at HEAD (run) |
|---|---|---|---|
| SC1/SC2 | `'sw*'` | 1 · `error: pathspec 'sw*' did not match any file(s) known to git` · both dirty · `S` | ✗ success, `sw.txt` restored to `sw` (local change lost), bit cleared |
| SC3/SC4 | `sw.txt` | 1 · same line for `'sw.txt'` · both dirty · `S` | ✗ same |
| SC5/SC6 | `'*.txt'` | 0 · — · `n.txt` restored, `sw.txt` still `sw-dirty` · `S` | ✗ both restored, bit cleared |
| SC7/SC8 | `.` | 0 · — · same as SC5 | ✗ same |
| SC9/SC10 | `sw.txt n.txt` | 1 · error for `'sw.txt'` · **both** still dirty | ✗ both restored, bit cleared |
| SC11/SC12 | `'sw*' 'n*'` | 1 · error for `'sw*'` · both still dirty | ✗ same |

#### GL — `add` over a gitlink

Fixture: an upstream repo with one commit; the superproject holds `k` and
`git -c protocol.file.allow=always submodule add <up> sub`, committed (index gitlink `2a17918`).
"moved" = a new commit `u2` inside `sub` (its HEAD becomes `5fb1a1e`); commit dates pinned to
`@1700000000 +0000` so the ids are stable across twins. GL7–GL10 and GL11–GL12 ran without
pinned dates; their git column reads "the sub HEAD" (whatever `git -C sub rev-parse HEAD` printed).

| # | Setup | Command | git: exit · index `sub` | tsgit at HEAD (run) |
|---|---|---|---|---|
| GL1 | moved | `add .` | 0 · `160000 5fb1a1e` (`M  sub`) | ✗ `2a17918` kept, `modified: []` |
| GL2 | moved | `add sub` | 0 · `5fb1a1e` | ✗ |
| GL3 | moved | `add 's*'` | 0 · `5fb1a1e` | ✗ |
| GL4 | moved | `add -A` | 0 · `5fb1a1e` | ✗ |
| GL5 | moved | `add sub/` | 0 · `5fb1a1e` | ✗ |
| GL6 | moved, `k` modified | `add sub k` | 0 · `5fb1a1e`, `k` staged | ✗ `k` only |
| GL7 | moved, `.gitignore: sub` | `add .` | 0 · `A  .gitignore`, `M  sub` (the sub HEAD) | ✗ `.gitignore` only |
| GL8 | same | `add sub` | 0 · the sub HEAD | ✗ |
| GL9 | same | `add 's*'` | 0 · the sub HEAD | ✗ |
| GL10 | same | `add -A` | 0 · `A  .gitignore`, `M  sub` | ✗ `.gitignore` only |
| GL11 | file edited inside `sub`, HEAD not moved | `.`, `sub`, `'s*'`, `-A` | 0 · `2a17918` (unchanged) | ok |
| GL12 | untouched | same four | 0 · unchanged | ok |
| GL13 | `submodule deinit -f sub` (empty directory) | same four | 0 · unchanged | ok |
| GL14 | `sub` replaced by a regular file | same four | 0 · `100644 f8dc9f2` (`T  sub`) | ok (`modified: [sub]`) |
| GL15 | `sub` replaced by a symlink to `k` | same four | 0 · `120000` (`T  sub`) | ok |
| GL16 | `sub` replaced by `git init` with no commit | same four | 0 · unchanged | ok |
| GL17 | embedded clone (`.git` directory, no `.gitmodules`), moved | `add .` | 0 · `5fb1a1e` | ✗ |
| GL18 | `submodule add --name other` (gitfile `gitdir: ../.git/modules/other`), moved | `add .` | 0 · `5fb1a1e` | ✗ |
| GL19 | `sub` replaced by an unrelated repository with one commit `2a46b3d` | `add .` | 0 · `2a46b3d` | ✗ |
| GL20 | `sub/.git` rewritten to `gitdir: ../.git/modules/nowhere` | `add .` | 128 · `fatal: not a git repository: sub/../.git/modules/nowhere` · unchanged | ✗ success, unchanged |
| GL21 | `.git/modules/sub/HEAD` rewritten to `garbage` | `add .` | 128 · `fatal: not a git repository: sub/../.git/modules/sub` · unchanged | ✗ success, unchanged |
| GL22 | moved | `add --renormalize .` | 0 · unchanged | ok |
| GL23 | moved, `update-index --skip-worktree sub` | `add .` | 0 · `S` unchanged | ok |

#### I — `add` of an ignored untracked literal

Fixture: `.gitignore` = `*.log` and `d/`; untracked `x.log y.log real.txt d/q.txt`. The ignored
report is these exact stderr lines, one path per line, sorted:

```
The following paths are ignored by one of your .gitignore files:
<path>
hint: Use -f if you really want to add them.
hint: Disable this message with "git config set advice.addIgnoredFile false"
```

| # | Command | git: exit · reported · index · loose | tsgit at HEAD (run) |
|---|---|---|---|
| I1 | `add x.log` (= B3l) | 1 · `x.log` · empty · 0 | ✗ stages `x.log` (the literal fast path never consults ignore rules; `add.test.ts:1728` pins that) · 1 |
| I2 | `add x.log real.txt` (= B3m) | 1 · `x.log` · `real.txt` · 1 | ✗ stages both · 2 |
| I3 | `add real.txt x.log` | 1 · `x.log` · `real.txt` · 1 | ✗ stages both |
| I4 | `add y.log x.log` | 1 · `x.log`, `y.log` (sorted) · empty | ✗ stages both |
| I5 | `add x.log 'nomatch*'` | 128 · `fatal: pathspec 'nomatch*' did not match any files`, no report · empty · 0 | ✗ `PATHSPEC_NO_MATCH` naming `x.log` |
| I6 | `add x.log missing` | 128 · `… 'missing' …`, no report · empty · 0 | ✗ names `x.log` |
| I7 | `add d` | 1 · `d` · empty | ✗ `PATHSPEC_NO_MATCH 'd'` (ADR-1045 interim) |
| I8 | `add d/` | 1 · `d` · empty | ✗ `PATHSPEC_NO_MATCH 'd/'` |
| I9 | `add d/q.txt` | 1 · `d` (the ignored ancestor, not the file) · empty | ✗ stages `d/q.txt` |
| I10 | `add x.log '*.txt'` | 1 · `x.log` · `real.txt` · 1 | ✗ `PATHSPEC_NO_MATCH 'x.log'`, nothing staged |
| I11 | `add 'x.lo?'` | 128 · `… 'x.lo?' …` · empty | ok (B3 class) |
| I12 | `add -f x.log` | 0 · — · `x.log` | ok (`force: true`; also stages without it, I1) |
| I13 | `add -f '*.log'` | 0 · — · `x.log` | ✗ `PATHSPEC_NO_MATCH '*.log'`: `AddOptions.force` is declared and never read |
| I14 | `add -f .` | 0 · — · `.gitignore d/q.txt real.txt x.log` | ✗ `.gitignore real.txt` |
| I15 | `add -f d` | 0 · — · `d/q.txt` | ✗ `PATHSPEC_NO_MATCH 'd'` |
| I16 | `add -A -f` | 0 · — · `.gitignore d/q.txt real.txt x.log` | ✗ `.gitignore real.txt` (`{ all: true, force: true }`) |

Second fixture "D": tracked `d/x.txt k` committed, then `.gitignore` = `d/`, `d/x.txt`
rewritten, untracked `d/new.txt`. Third fixture "T": tracked `t.log k` committed, then
`.gitignore` = `*.log`, `t.log` rewritten, untracked `u.log`. Status shown as `--porcelain`.

| # | Fixture · command | git: exit · reported · status | tsgit at HEAD (run) |
|---|---|---|---|
| I17 | D · `add d/x.txt` | 1 · `d` · `M  d/x.txt` | index ok; ✗ no report |
| I18 | D · `add d/new.txt` | 1 · `d` · nothing staged | ✗ stages `d/new.txt` |
| I19 | D · `add d/x.txt d/new.txt` | 1 · `d` · `M  d/x.txt` only | ✗ also stages `d/new.txt` |
| I20 | D · `add d` (B16 plus an untracked file) | 1 · `d` · `M  d/x.txt` | index ok; ✗ no report |
| I21 | D · `add 'd/*.txt'` | 1 · `d` · `M  d/x.txt` | index ok; ✗ no report |
| I22 | D · `add 'd*'` | 1 · `d` · `M  d/x.txt` | index ok; ✗ no report |
| I23 | D · `add 'd/x*'` | 1 · `d` · `M  d/x.txt` | index ok; ✗ no report |
| I24 | D · `add 'd/n*'` | 128 · `fatal: pathspec 'd/n*' did not match any files` · unchanged | ok |
| I25 | D · `add '?'` | 0 · — · unchanged (` M d/x.txt`) | ok |
| I26 | D · `add '*'` | 0 · — · `A  .gitignore`, `M  d/x.txt` | ok |
| I27 | T · `add '*.log'` | 0 · — · `M  t.log` | ok |
| I28 | T · `add .` | 0 · — · `A  .gitignore`, `M  t.log` | ok |
| I29 | T · `add t.log u.log` | 1 · `u.log` · `M  t.log` | ✗ also stages `u.log` |
| I30 | T · `add '?.log'` | 0 · — · `M  t.log` | ok |

The tracked-file twin is B13 (`add x.log` on a tracked ignored file): no report, ok today.

#### W — working-tree entries named with `\` (POSIX; run on macOS APFS)

Untracked fixture: files `a\b` (content `a`), `ab`, `k`. Tracked fixture: the same three
committed, then `a\b` rewritten to `dirty`. `ls-files` quotes the name as `"a\\b"`.

| # | Fixture | Command | git: exit · result | tsgit at HEAD (run) |
|---|---|---|---|---|
| W1 | untracked | `add .` | 0 · `"a\\b" ab k` | ✗ `PATHSPEC_OUTSIDE_REPO { path: 'a\\b' }` from the walk, nothing staged |
| W2 | untracked | `add 'a\\b'` (escaped) | 0 · `"a\\b"` | ✗ same |
| W3 | untracked | `add 'a?'` | 0 · `ab` | ✗ same (the walk aborts before matching) |
| W4 | untracked | `add 'a\b'` (= E1) | 0 · `"a\\b" ab` | ✗ same |
| W5 | untracked | `add -A` | 0 · `"a\\b" ab k` | ✗ same |
| W6 | untracked | `add ab` | 0 · `ab` | ok (literal fast path, no walk) |
| W7 | untracked | `status --porcelain` | 0 · `?? "a\\b"`, `?? ab` | ✗ `status()` throws `PATHSPEC_OUTSIDE_REPO` |
| W8 | tracked | `rm -f 'a\\b'` | 0 · index `ab k`, file deleted | ✗ `PATHSPEC_OUTSIDE_REPO` from `removeFile`; index and file unchanged |
| W9 | tracked | `rm -f 'a??'` | 0 · index `ab k` | ✗ same |
| W10 | tracked | `rm --cached 'a\\b'` | 0 · index `ab k` | ok |
| W11 | tracked | `rm -f 'a?'` | 0 · removes `ab` only | ok |
| W12 | tracked | `checkout -- 'a\\b'` | 0 · `a\b` back to `a` | ok |
| W13 | tracked | `checkout -- 'a?'` | 0 · `a\b` stays `dirty` | ok |
| W14 | tracked | `grep -l . -- 'a??'` | 0 · `"a\\b"` | ok |
| W15 | tracked | `grep -l .` | 0 · `"a\\b"`, `ab`, `k` | ok |
| W16 | tracked | `status --porcelain` | 0 · ` M "a\\b"` | ✗ throws `PATHSPEC_OUTSIDE_REPO` |

#### X — literal positives with exclusions (tsgit spells git's `:!p` as `!p`, ADR-038)

Fixture "U": untracked `x y d/x a.txt`. Fixture "M": the same four committed, then each one
rewritten. Status is `--porcelain`; "loose" counts loose objects (U starts at 0, M at 7). Run
against git 2.55 and tsgit at `569c5b89`, once each.

| # | Fixture · command | git: exit · status · loose | tsgit at HEAD (run) |
|---|---|---|---|
| X1 | U · `add x ':!x'` | 0 · `?? x` (nothing staged) · 0 | ✗ `added: [x]` · 1 |
| X2 | U · `add d/x ':!d'` | 0 · nothing staged · 0 | ✗ `added: [d/x]` · 1 |
| X3 | U · `add a.txt ':!*.txt'` | 0 · nothing staged · 0 | ✗ `added: [a.txt]` · 1 |
| X4 | U · `add x ':!y'` | 0 · `A  x` · 1 | ok |
| X5 | U · `add x y ':!x'` | 0 · `A  y` only · 1 | ✗ stages `x` and `y` · 2 |
| X6 | U · `add x '*.txt' ':!x'` (walk route) | 0 · `A  a.txt` · 1 | ok |
| X7 | U · `add ':!x' x` | 0 · nothing staged · 0 | ✗ `added: [x]` · 1 |
| X8 | M · `add x ':!x'` | 0 · ` M x` kept · 7 | ✗ `modified: [x]`, `M  x` · 8 |
| X9 | M · `add d/x ':!d'` | 0 · ` M d/x` kept · 7 | ✗ `M  d/x` · 8 |
| X10 | M · `add a.txt ':!*.txt'` | 0 · ` M a.txt` kept · 7 | ✗ `M  a.txt` · 8 |
| X11 | M · `add x ':!y'` | 0 · `M  x` · 8 | ok |
| X12 | M · `add x y ':!x'` | 0 · `M  y` only · 8 | ✗ `M  x`, `M  y` · 9 |
| X13 | M · `add x '*.txt' ':!x'` (walk route) | 0 · `M  a.txt` · 8 | ok |
| X14 | M · `add ':!x' x` | 0 · ` M x` kept · 7 | ✗ `M  x` · 8 |
| X15 | U · `add missing ':!missing'` | 128 · `fatal: pathspec 'missing' did not match any files` · 0 | ok (`PATHSPEC_NO_MATCH 'missing'`) |
| X16 | U · `add 'x*' ':!x'` | 128 · `… 'x*' …` · 0 | ok |
| X17 | U · `add 'q*' ':!q*'` | 128 · `… 'q*' …` · 0 | ok |
| X18 | U · `add x ':!x' 'nomatch*'` | 128 · `… 'nomatch*' …` · 0 | ok |
| X19 | U · `add d ':!d/x'` | 0 · nothing staged · 0 | ok |
| X20 | M · `rm --cached x ':!x'` | 0 · index unchanged | ok (`removed: []`) |
| X21 | M · `rm --cached x y ':!x'` | 0 · `y` removed | ok |
| X22 | M · `rm --cached d/x ':!d'` | 0 · unchanged | ok |
| X23 | M · `rm --cached a.txt ':!*.txt'` | 0 · unchanged | ok |
| X24 | M · `checkout -- x ':!x'` | 0 · `x` stays `x2` | ok (`changedPaths: 0`) |
| X25 | M · `checkout -- x y ':!x'` | 0 · `y` restored, `x` stays `x2` | ok |
| X26 | M · `checkout -- x ':!y'` | 0 · `x` restored, `y` stays `y2` | ok |

Only `add`'s literal fast path diverges. `rm` and `checkout` select through the whole matcher,
and so does `add`'s walk route (X6, X13).

**Row count** (D 23 + E 5 + L 6 + B 31 + R 11 + C 10 + G 5 + K 6 + DS 14 + N 28 = 139, plus the
fold: S 15 + SC 12 + GL 23 + I 30 + W 16 + X 26 = 122; total 261. B3l/B3m are counted once, in B; I1/I2
repeat them with the tsgit column run). B8 and B13–B16 were re-run on 2026-10-22 with
the same procedure. Their tsgit column comes from a session pin that ran tsgit through jiti at
this branch's HEAD and at `main` (`8dd442ee`). Both gave the same result, so the gap predates this
change. B11′, B12r, RN4–RN6 and K1L were pinned by the
planner and re-run once on 2026-10-22 with the procedure above, as were D6, D8b, D17, E1 and E2;
every re-run gave the recorded output.

### Part a — the pathspec dialect

**Matcher.** `compileOne` (`compile-pathspec.ts`) compiles every non-empty, non-trailing-`/`
body to one `GlobMatcher`:

```ts
// shape, not final code
test(path) =
  verbatimLevel(body, path) !== NONE ||
  (hasGlobSpecial(body) && wildcard(path));
```

- `verbatimLevel(body, path)` returns `EXACT`, `RECURSIVE` or `NONE`. It compares strings with
  git's `match_pathspec_item` prefix rule. This replaces `compileLiteral` / `compileDirectory` /
  `withDirSuffix` for pathspecs (`''` stays `WHOLE_TREE`).
  On the escape view, the string-prefix relation equals the byte-prefix relation: a well-formed
  pattern ends on a code-point boundary, and a complete UTF-8 sequence decodes the same whatever
  follows it.
- `hasGlobSpecial(body)` is git's `is_glob_special` set `* ? [ \` (candidate 2). It replaces
  `containsGlob` and sets `isLiteral = !hasGlobSpecial(body)`, so E2 behaves as git once the
  intake admits `\` (below). E1 also needs a `\`-named file: Out of scope.
- `wildcard(path)` is the flags-0 wildmatch from `ref-glob.ts`, run over the **raw bytes**
  `encodeEscaped(path)` (`src/domain/objects/encoding.ts:205`). The view is the ADR-980 escape
  view, so the bytes are exactly git's, lossy entries included (L1–L6). `TextEncoder` would turn
  lone surrogates into `EF BF BD`; `encodeEscaped` does not.
- Fast paths, all linear and allocation-free, with results identical to the byte DP:
  1. **Literal-prefix prefilter** (git's no-wildcard prefix length): when the body's glob-special-free
     prefix is not a string prefix of `path`, return false before encoding. `src/*.ts` against a
     50k-path tree rejects everything outside `src/` with one `startsWith`.
  2. **One-star** (git's single-star pathspec flag): for `<prefix>*<suffix>` with no other special byte
     (`*.ts`, `src/*.ts`, `foo*`), the result is `startsWith(prefix) && endsWith(suffix) &&
     length >= prefix + suffix`. The same boundary argument as above covers the suffix.
  3. Otherwise run the DP over `encodeEscaped(path)`.
- `ref-glob.ts` gains one export: a bytes-taking compile (`compileWith` already holds the token
  list; add `compileRefGlobBytes(pattern): (text: Uint8Array) => boolean` built on the same
  `tokenize`/`matchTokens`). No second DP is written.

**Match level.** rm (R4) and seen-tracking (b) need git's `MATCHED_EXACTLY` / `RECURSIVELY` /
`FNMATCH`. A new `pathspecMatchLevel(entry, path)` in `match-pathspec.ts` returns
`verbatimLevel(...)` if that is not `NONE`, else `FNMATCH` if `entry.compiled.test(path)`, else
`NONE`. The `PathspecEntry` shape is unchanged, so the public `Pathspec` type does not change.
`matchesPathspec`, `withoutExactly` and `matchesUnmergedPath` keep their code.

**`compileGlob` after the move** (candidate 9): no pathspec or `describe` caller is left. Its
remaining callers all pass `pathname: true`. The literal compile no longer uses it, so
`scanStar`, the `pathname` option and the `options.pathname === true ?` branch in `scanToken`
become dead. Remove them; the three remaining callers drop `pathname: true`. `containsGlob` is
deleted. The header comment loses "`compilePathspec`" and "`[abc]` not supported in v1" (still
true for the gitignore dialect; reword to say so).

**Auto-detection (ADR-037).** `looksLikePathspec` (`looks-like-pathspec.ts`, git's
`looks_like_pathspec` for argument disambiguation) is a different git function and stays as is.
`hasGlobSpecial` is git's `is_glob_special` used by `simple_length` and the no-wildcard prefix length. ADR-037's
"`*`, `?`, or `[`" becomes "`*`, `?`, `[`, `\`".

**Backslash intake (ADR-1044).** Today `collapsePattern` (`resolve-pathspec.ts:108-118`) runs
`validatePath` (= `validateWorkingTreePath`) on every body at `:111` and `:115`, and
`rejectInputShape` (`src/domain/working-tree-path.ts:71`) refuses any `\` with
`PATHSPEC_OUTSIDE_REPO`. So D6, D17 and E2 never reach the matcher.

- `working-tree-path.ts`: the `\` test moves out of `rejectInputShape` into `rejectBackslash`.
  `validateWorkingTreePath` and `validateWalkedEntryPath` call both, so their verdicts do not
  change. A new export `validatePathspecBody` runs every `validateWorkingTreePath` rule except
  `rejectBackslash`: empty, absolute, NUL, control bytes, `.`/`..`/empty components, `.git`
  aliases, leading `:`, length caps.
- `resolve-pathspec.ts`: `resolvePathspec(patterns)` becomes
  `resolvePathspec(patterns, host: Pick<Context, 'windowsPathSyntax'>)`. `collapsePattern` gets
  the body validator from the host: `host.windowsPathSyntax === true ? validatePath :
  validatePathspecBody`. The field is `Context.windowsPathSyntax` (`src/ports/context.ts:358`),
  the same one `gitPathSyntaxOf(ctx)` reads. ADR-1044's "`PathPolicy.windowsPathSyntax`" is this
  field: the node adapter fills it from `PathPolicy.windowsSyntax`
  (`src/adapters/node/path-policy.ts:72`, true only on `win32`). Callers pass `ctx`: `add.ts:223`, `add.ts:784`, `rm.ts:80`, `checkout.ts:344`,
  `grep.ts:198`. The module-level `WHOLE_TREE_MATCHER` (`add.ts:186`) compiles `.`, which holds
  no `\`, and passes an empty host. `windowsIndexPaths` alone does not gate. A Windows host on a
  non-native filesystem (`windowsIndexPaths` set, `windowsPathSyntax` absent) therefore accepts
  the body as POSIX does, as ADR-1044 words it.
- The body is never a filesystem path. `\` is glob-special (ADR-1034), so the entry has
  `isLiteral: false`. It never enters `literalMustMatch`, `literalSpellings` or the literal
  `lstat` in `add` (`add.ts:552`). Both on-disk escapes (the walk's R5 escape and the
  `--renormalize` escape) skip a body holding `\`. On POSIX a component such as `..\x` passes,
  because it is not `..`. It is harmless because nothing resolves it on disk.
- `symlinkScanTargets` (`resolve-pathspec.ts:65`) passes whole bodies today. For a body holding
  `\` it passes the no-wildcard prefix instead: the bytes before the first `* ? [ \` (git's no-wildcard
  prefix length), through the same helper as the literal-prefix prefilter. An empty prefix is
  dropped, as `WHOLE_TREE` is. Every other body is passed whole, as today. The scanner `lstat`s
  only the leading segments of what it receives (`symlinked-leading-path.ts:126-131`), so
  `a\*b` scans nothing and `d/a\*b` scans `d`.
- Windows: a unit row in `resolve-pathspec.test.ts` with `{ windowsPathSyntax: true }` pins the
  `PATHSPEC_OUTSIDE_REPO { path }` refusal on every OS. An integration row on the existing
  `windows-latest` CI leg (`.github/workflows/ci.yml:257`) runs tsgit through the node adapter,
  which sets `windowsPathSyntax` (`node-adapter.ts:155`). It pins the same refusal for
  `add(['a\\*b'])`. That row has no git twin: git for Windows reads `\` as a separator
  (ADR-1044 option 3, out of scope).

**Stale text to fix in passing** (touched files only): `resolve-pathspec.ts:17-23,54-56` ("compiled
to RegExp"); `compile-pathspec.ts:28-36` (anchoring comment); `describe/match.ts:1-6`;
`name-rev/ref-pattern.ts:1-8`; `checkout.ts:349-350,361` ("Glob with zero matches → no-op").

### Part b — unmatched-pathspec refusal

`resolvePathspec` gains `positives: ReadonlyArray<{ entry: PathspecEntry; spelling: string }>`:
every non-negated entry, in argument order, with its raw spelling. `literalSpellings` is derived
from it or retired, and `hasGlob` keeps only its dispatch role in `add`. A shared helper in
`resolve-pathspec.ts`:

```ts
// shape
firstUnmatched(positives, seen: (entry) => boolean): string | undefined
everyUnmatched(positives, seen): ReadonlyArray<string>
```

`enforceLiteralMustMatch` stays for `addLiteralOnly`, the pure-literal fast path (unchanged
behaviour). The whole-tree positive (`.` collapsed to `''`) keeps today's handling: `add` never
refuses it, `rm`/`checkout` refuse it only when nothing matched. Negated (`!`) entries are never
in `positives`. Per command, the refusal point is:

| Command | Function | Refusal point (before any write) | Seen from |
|---|---|---|---|
| `add` (walk) | `add.ts:720` `addByPathspec` | after `acquireIndexLock` + `readExistingEntries`, **before** `stageWalkedEntries` (no blob written yet) | (1) index entries: `pathspecMatchLevel` over `sorted` (every entry; skip-worktree rules out of scope); (2) only for entries still unseen, the non-ignored walk leaves (`withPathspec` predicate) — see candidate 3; (3) R5 escape: an unseen glob whose verbatim body `lstat`s is dropped |
| `add --renormalize` | `add.ts:778` `addRenormalized` | after the lock + `readIndexOrEmpty`, **before** `renormalizeEntries` (which writes blobs); the literal `literalsOnDisk` check moves up with it | index entries only (git runs no `fill_directory` under `--renormalize`) |
| `rm` | `rm.ts:72` | where `enforceLiteralMatches` runs today (after `groupByPath`, before `enforceSafetyValve` and any `removeFile`) | per positive entry, max `pathspecMatchLevel` over index paths; `NONE` → `pathspecNoMatch(spelling)`; `RECURSIVE` && !`recursive` → `rmRecursiveWithoutR(spelling)`; first failing entry in argument order wins |
| `checkout` paths | `checkout.ts:339` `pathRestore` | after the lock and the index read (candidate 6; K1, K4, K5), after `enumerateSourcePaths`, before `materialize*` | the source universe: the index, or the source tree only (C8) |
| `grep` | `grep.ts:198` | none | — |

`PATHSPEC_NO_MATCH` (`src/domain/commands/error.ts:41`, factory `pathspecNoMatch` at :592,
message `src/domain/error.ts:454`) is reused for all three. Git's per-command wording and exit
status (`fatal: … did not match any files` / 128 for add/rm, `error: … did not match any file(s)
known to git` / 1 for checkout) are display. The caller knows which command it called and renders
that wording from the code (ADR-249). Checkout's multi-line report needs the full list:
candidate 5.

**Index-side pass (tracked entries the walk never reaches).** git's `add` runs
`add_files_to_cache`. That is `run_diff_files` over the index entries the pathspec matches, and it
stages modified tracked entries whatever the ignore rules say. tsgit's `stageIgnoredWalk`
(`add.ts:933`) stages only what the ignore-pruned walk yields. `addAll` (`add.ts:1079`) has the
same shape (read from the code). Deletions are already right: `collectRemovedEntries` decides by
presence on disk, not by the ignore filter (B7).

- Where: in `stageIgnoredWalk`, after `collectWalk` and `refuseUnseenWalked` and before
  `stageWalkedEntries`. `addAll` gets the same step with `WHOLE_TREE_MATCHER`, before its
  `stageWalkedEntries`.
- What: walk the `sorted` entries from `readExistingEntries`. Keep each entry that is stage 0,
  not `skipWorktree`, matched (`matchesIndexPath`) and absent from the walked set. `lstatOrMissing`
  it. When it is a regular file or symlink, or a directory for a gitlink entry, append a walked
  record built from that stat. `walkedTrackedFirst` then yields it in index order, and
  `stageWalkedEntries` → `processWalkEntry` stages it through the walked-entry path: same
  conversion, same `seen` marking, same modified tally. Intent-to-add entries go through the same
  path (R12). The gitlink case reuses whatever the walk does for a submodule checkout; the part
  confirms that path stages a new submodule commit.
- Not staged here: a missing file stays with the removal path (`collectRemovedEntries`). A
  skip-worktree entry is skipped (R12). A path whose leading component is now a file or symlink
  is also left to the removal path, as `presentOnDisk` already decides.
- The refusal is unaffected: `refuseUnseenWalked` already counts index-seen entries
  (`indexSees`).
- Review pin (git 2.55): a conflicted path the rules hide is resolved to stage 0 from the file on
  disk by `add <glob>`, `add .` and `add -A`, like a walked conflicted path; the pass selects it
  under the conflict rule (`matchesUnmergedIndexPath`).

Atomicity proof obligations (tests): B1/B2 `loose = 0` and index unchanged. R1 leaves the file on
disk and in the index. C1/C1b/C3 leave `dirty.txt` dirty. RN2 leaves no index change.

### Part c — `describe`

`src/domain/describe/match.ts`: `anchored` becomes `compileRefGlob(pattern)` (flags 0, on the
short name `describe.ts` already passes). The `buildNameFilter` include/exclude logic is unchanged.
Git tests exclude first, but the result is order-independent because both must hold. Patterns go
through `compileRefGlob`'s `encode(text)`. Tag names are few and `describe` is not on a per-path
hot path. `describe --contains` maps patterns to `refs/tags/<pat>` and goes through `name-rev`
(Part d), as git does.

### Part d — `name-rev`

`src/domain/name-rev/ref-pattern.ts`:

```ts
// shape — git's subpath_matches: -1 none, 0 full, >0 matched at a suffix
const subpathMatch = (matcher, ref) => { /* try ref, then after each '/' */ };
interface RefFilter {
  qualifies(ref: string): boolean;          // unchanged contract
  abbreviates(ref: string): boolean;        // some include matched only via a suffix
}
```

Each pattern is compiled once per `buildRefFilter` (`compileRefGlob`), not per ref as
`matchRefGlob` does today. Excludes test every suffix (N10/N11). `src/application/commands/name-rev.ts`
sets `abbreviated: filter.abbreviates(ref)` on the result in `nameCommit` and `exactRefMatch`
(candidate 8). `NameRevResult` gains `readonly abbreviated: boolean`, an additive public field.
The interop renderer (`renderNameRev`) shortens with `git rev-parse --abbrev-ref=loose <ref>` when it is
set. N21 (`--tags --name-only`) stays the caller's own `tags && nameOnly` rule, as today.

### Part e — docs fold-in (documentation phase)

`docs/BACKLOG.md` release-order row 1 still reads "6.0.0 — ship now". v6.0.0 shipped on
2026-10-21 (#315, `8dd442ee`). The documentation phase replaces the row with the user's text,
minus the 5.0.1 hotfix parenthesis the user dropped in the decisions phase (the "why here" cell
ends after "was a reported user failure"), strikes the four delivered sub-items of 32.11 and
leaves 32.11b open.

### Part f — skip-worktree entries in `add` and `checkout` (R13, R14)

Line numbers in Parts f–i are at `98c84b01`. Later commits on this branch move `add.ts` and
`checkout.ts`, so re-anchor each symbol by name (serena `find_symbol`) before editing.

**`add`, report side.** One rule for every route: a skip-worktree index entry neither marks a
positive seen nor is staged; a positive left unseen that matches one is reported, not refused.

- `src/application/commands/internal/pathspec-intake.ts` `trackPositives` (`PositiveTracker`):
  unchanged. A new pure helper beside `unmatchedPositives`,
  `reachesSkipWorktree(positive, skipped: ReadonlyArray<IndexEntry>): boolean`, tests
  `positive.entry.compiled.test(escapedPathOf(entry))`. It runs only over the unseen positives,
  so it costs nothing on the common path.
- `add.ts:1059-1107` `stageIgnoredWalk`: `verdictsOf(existing, tracker.observe)` observes every
  entry today, skip-worktree ones included, so S2 counts as seen. Observe only
  `!entry.flags.skipWorktree` entries, and give skip-worktree keys a non-matching verdict so
  `collectMatchedRemovals` and `hiddenTracked` keep ignoring them. Then drop every walked leaf
  whose `existing` entry is skip-worktree, before `refuseUnseenWalked` and `stageWalkedEntries`.
  The walk still yields `x.log`: a skip-worktree file on disk is an ordinary leaf to
  `walkWorkingTree`.
- `add.ts:875-899` `refuseUnseenWalked`: before refusing, split the unseen positives into
  `reported` (`reachesSkipWorktree`) and the rest. The rest refuses as today (S9: nothing
  staged, no report). The reported spellings flow out to the result (candidate 13).
- `add.ts:243-273` `addLiteralOnly` / `:323-344` `stageLiterals`: a literal whose stage-0 entry is
  skip-worktree is dropped from `ordered` and reported (S3, S6). A literal is seen only by itself,
  so no tracker is needed here.
- `add.ts:1215-1276` `addAll`: drop skip-worktree leaves from `walkedEntries` (S10). `addAll`
  has no positives, so it never reports. `add.ts:1304-1318` `collectRemovedEntries` already skips
  them (S11, S13).
- `add.ts:792-820` `addRenormalized` → `:857-871` `refuseUnseenRenormalized`: `indexSees` counts
  skip-worktree entries; exclude them there and report the unseen positives `reachesSkipWorktree`
  accepts (S15). `isRecleaned` (`:930`) already skips them (S14).
- Not touched: `isHiddenCandidate` (`:1018`, already excludes skip-worktree),
  `src/application/commands/internal/apply-sparse-checkout.ts` (sparse patterns stay as they are,
  R9).

**`checkout`.** `checkout.ts:376-397` `restoreUnderIndexLock` reads `currentIndex`, then
`enumerateSourcePaths` (`:487`) returns the index entries or the source tree's paths. Filter
that universe before `selectFromUniverse` (`:399`): drop every path whose stage-0 entry in
`currentIndex` is skip-worktree. Key the lookup by `indexPathKey` over the entries, compared
through the same `escapedPathOf` view `selectFromUniverse` already uses, so a lossy name
behaves. Then `refuseUnmatched` (`:413`) refuses SC1–SC4 and SC9–SC12 through the existing
path, and `materializePathRestore*` never sees the path (SC5–SC8). `materializeTree`'s own
skip-worktree carry (`materialize-tree.ts:250`, `:298`) is unchanged.

Tests to extend: `test/unit/application/commands/add.test.ts` (fixtures `seedFreshRepo`
`:54`, the `STAGE0_FLAGS` overrides used at `:3306`, `expectError` `:85`; the existing
skip-worktree rows at `:830` and `:3300` stay green), `test/unit/application/commands/checkout.test.ts`
(`refusalOf` `:40`; the sparse rows at `:1318-1430` stay green), and the interop file
`test/integration/add-tracked-under-ignore-interop.test.ts` (`twins`, `trackedThen`,
`snapshotOf`; its skip-worktree rows at `:170`/`:196` stay).

### Part g — gitlinks in `add` (R15)

Today a gitlink never reaches staging. The walk's embedded-repository gate
(`walk-working-tree.ts:206` `isEmbeddedGitMarker`) yields nothing for `sub`;
`isHiddenCandidate` (`add.ts:1018-1027`) excludes `FILE_MODE.GITLINK`; `hiddenWalkEntryOf`
(`:1041`) drops directories; `presentOnDisk` (`:1278-1291`) keeps the entry present. The
equivalence mark in `restagesAsIs` (`:1562-1571`, "deriveWorkingMode never returns GITLINK")
stays true, because gitlinks do not go through `stagePromisorChecked`.

- New step `stagedGitlinks(ctx, existing, verdicts)` in `add.ts`, called by `stageIgnoredWalk`
  (with the tracker's verdicts) and `addAll` (with `indexVerdicts(WHOLE_TREE_MATCHER, existing)`).
  It runs after `refuseUnseenWalked` and **before** `stageWalkedEntries`, so a refusal (candidate
  17) leaves zero loose objects, as ADR-1035 requires of every `add` refusal. Candidates: stage-0,
  `FILE_MODE.GITLINK`, not skip-worktree (GL23), not lossy, `verdicts.get(key)?.matched`.
- Per candidate, bounded by `limiterFor(ctx, 'ioBound')`: `lstatOrBeneathFile` (`:587`). If the
  path is not a real directory, do nothing: the walk already yields the file or symlink that
  replaced it, and stages it (GL14, GL15 ok today). If `<path>/.git` is absent (GL13), do nothing.
  Otherwise resolve HEAD (candidate 16). Unborn (GL16): do nothing. Different from `entry.id`:
  emit `{ kind: 'modified', path, entry: indexEntryFromStat(stat, FILE_MODE.GITLINK, head, path) }`.
  That is the shape `submodule.ts:628` (`stageSubmodule`) already builds.
- The outcomes join `stageWalkedEntries`'s before `tallyWalkOutcomes` (`:1144`), so
  `modified`, `restagedPaths` and the index commit need no new code. `--renormalize` is not
  touched (GL22; `RECLEANED_MODES` excludes gitlinks).
- Literal routing needs nothing: `literalStats` (`:567`) sends a directory literal (`add sub`,
  GL2) and a `sub/` literal (GL5) to the walk route.
- HEAD resolution building blocks: `src/domain/worktree/gitfile.ts` `parseGitfilePointer`;
  `src/application/primitives/derive-context.ts:61` `deriveContext`, as
  `src/application/primitives/internal/submodule-context.ts` `buildChildContext` uses it (that
  helper is keyed on the `.gitmodules` name, which GL17/GL18 rule out); `resolveRef(child, HEAD)`
  as in `submodule.ts:757`.
- The pathspec refusal needs nothing: the index pass already sees `sub`.

Tests to extend: `add.test.ts`. The memory adapter can hold `sub/.git` as a gitfile plus
`.git/modules/sub/{HEAD,refs/heads/main}`. Next to the existing `Given a gitlink entry` row at
`:3341`, write a moved, an unchanged, an empty-directory and a broken-gitfile row. The
embedded-repository row at `:927` stays green: it has no index gitlink. Interop: a new
`describe` in `add-tracked-under-ignore-interop.test.ts` (ignored and plain gitlinks share its
`twins`). The setup uses `git -c protocol.file.allow=always submodule add`, as
`submodule-init-sync-deinit-interop.test.ts:40` does, with pinned dates.

### Part h — the ignored report and `force` (R16)

- `add.ts:139-151` `AddOptions` / `AddResult`: `force` is declared and read nowhere today
  (grep). Candidate 14 wires it. The report fields come from candidate 13.
- **Walk route.** `add.ts:1109-1121` `withPathspec` wraps `repoIgnore` for the walk. Wrap it once
  more, outside `withPathspec`, with a collector. When `repoIgnore(path, isDirectory)` is true for a
  directory, or for a leaf with no `existing` entry, and some positive's no-wildcard prefix `P`
  satisfies `P === path || P.startsWith(path + '/')`, record `path`. The prefix helper is Part a's
  literal-prefix bytes. Compute each positive's `P` once per call. The walk prunes at the
  shallowest ignored directory, so `d/q.txt` records `d` (I9) with no ancestor loop. The
  collector only observes: what the walk yields does not change.
- **Escape.** `add.ts:875-899` `refuseUnseenWalked` → `:901-915` `namesUnignoredDiskPath`: drop the
  ignored-literal exclusion. An unseen literal whose path exists on disk takes git's `file_exists`
  escape whether ignored or not (I1, I7). The collector reports it. Classify every unseen positive
  before throwing: if any refuses, throw `PATHSPEC_NO_MATCH` for the first in argument order and
  report nothing (I5, I6, I24). Today's loop is already ordered; it changes only by losing the
  ignored branch.
- **Literal fast path** (`add.ts:230-241` `dispatchPathspec` → `:567-581` `literalStats` →
  `:243` `addLiteralOnly`): there is no walk, so for each literal compute the shallowest ignored
  proper ancestor directory, and for an untracked literal also the literal itself. Record it under
  the same rule. Drop an untracked literal that has such an entry from staging (I1–I4, I18,
  I19, I29). Keep a tracked one (I17).
  `add.ts:917-928` `ignoredWithAncestors` returns a boolean today. Add
  `firstIgnoredOf(repoIgnore, path, isDirectory): FilePath | undefined` (shallowest ignored
  ancestor-or-self) and express `ignoredWithAncestors` through it, so the loop exists once. The
  predicate (`buildRepoIgnorePredicate`,
  `src/application/primitives/internal/ignore-evaluator.ts:56`) is built lazily, only when
  `force` is off. `add <tracked literal>` still has to pay it, because I17 reports `d` for a tracked
  literal under an ignored directory. The bench row below measures that.
- `force: true`: `addByPathspec` (`:736`), `addAll` (`:1215`, which already takes an
  `ignoreOverride`) and the fast path get a never-ignoring predicate, so nothing is pruned and
  nothing is reported (I12–I16). The walk's `.git` exclusion (`isDotGitWalkEntry`) is not an
  ignore rule and stays.
- `addAll` has no positives, so it never reports. Neither does `.` (`P` = `''`), which matches
  B14 and I28.
- Report order: sorted by path (I4), deduplicated.

Tests to re-pin, never edit to fit: `add.test.ts:1728` ("Given a literal path that .gitignore
would exclude", which pins staging today) becomes I1. `add.test.ts:1750` ("Given a missing
literal and a gitignored existing literal", which pins `keep.txt` as the refused pattern) becomes
I6 and names `gone.txt`. The B3l/B3m/B16 advice rows join the interop suite
`pathspec-glob-dialect-interop.test.ts` (its `rows` table at `:662` and `snapshotOf`).

### Part i — `\`-named working-tree entries (R17)

- `src/domain/working-tree-path.ts:52` `validateWalkedEntryPath` calls `rejectInputShape`
  (`:71-79`), whose `input.includes('\\')` test refuses on every host. Split that test into
  `rejectBackslash`. ADR-1044's design named this split, but the shipped intake put its
  Windows refusal in `pathspec-intake.ts` `refuseBackslash` instead, and `rejectInputShape` still
  holds the test. `validateWorkingTreePath` keeps calling both.
  `validateWalkedEntryPath(input, host: { readonly windowsPathSyntax?: boolean })` calls
  `rejectBackslash` only under Windows path syntax (candidate 18).
- Call site `src/application/primitives/walk-working-tree.ts:102` in `stepEntry` (`:90`):
  `WalkConfig` (`:15`) gains the host flag, filled once in `walkWorkingTree` (`:157`) from
  `ctx.windowsPathSyntax`. The flag is a single boolean read per entry.
- Consumers that inherit the change: `add.ts`, `status.ts:303`, `stash.ts`,
  `adapters/snapshot-resolvers/fs-workdir-enumerator.ts`, `repository.ts`. Once the walk admits
  the name, `add` stages it through `stageFromStat` → `validateIndexPath`, which admits `\` on
  POSIX. Probed at `98c84b01`: `indexPathRulesOf({}).validateIndexPath('a\\b', 0, '100644')`
  accepts; with `{ windowsPathSyntax: true }` it refuses `INVALID_INDEX_ENTRY`.
- `rm` (W8, W9): `src/application/commands/internal/working-tree.ts:84` `removeFile` →
  `validatePath` (= `validateWorkingTreePath`) refuses. Candidate 19 decides whether the gate
  reaches it.
- Windows: the gate keeps the refusal. NTFS cannot hold the name, so only a non-native mount
  reaches it, and ADR-1044 keys the same question on `windowsPathSyntax`.

Tests to extend: `test/unit/domain/working-tree-path.test.ts` (both hosts),
`test/unit/application/primitives/walk-working-tree.test.ts` (an adapter returning `a\b`). The
interop file `test/integration/pathspec-backslash-interop.test.ts` (`snapshotOf`, `namesOf`) gets
W1–W5, W7, W16 and D8b/E1 under its POSIX `describe.skipIf` at `:31`. Its Windows block at
`:76` gets the walk refusal.
### Part j — exclusions on the literal route (R18)

Line numbers at `569c5b89`.

- `src/application/commands/internal/resolve-pathspec.ts:55-62` `resolvePathspec` builds
  `literalMustMatch` from `isPositiveLiteral` (`:178`) and `hasGlob` from `isPositiveGlob`
  (`:179`). Negated entries are in `matcher` and in neither list, so a call whose positives
  are all literal sets `hasGlob: false` whatever its exclusions say.
- `src/application/commands/add.ts:230-241` `dispatchPathspec`: when `hasGlob` is false and
  every literal `lstat`s as a file (`literalStats`, `:567`), the call goes to `addLiteralOnly`
  (`:243`) → `stageLiteralsOver` (`:275`) → `stageLiterals` (`:323`), which stages every entry of
  `literalMustMatch`. The matcher is consulted only in `dropBeneathInserted` (`:405`), so
  exclusions never apply there.
- The walk route already gives git's result (X6, X13, X16–X19). Its pieces: the `withPathspec`
  leaf filter, `trackPositives` in `src/application/commands/internal/pathspec-intake.ts:78`
  (seen-marking through `pathspecVerdict`, which applies exclusions), and the escape through
  `namesOnDisk` (`add.ts:850`) or `namesUnignoredDiskPath` (`:902`), both gated by
  `PositivePathspec.probesDisk` (`pathspec-intake.ts:21`, `:32`). That escape order is what X1
  and X15 pin: exclusion before seen, the on-disk escape after.
- Change: candidate 20. Under 20A it is one predicate in `dispatchPathspec`: a call holding any
  negated entry takes `addByPathspec` (`:736`).
- `rm.ts` and `checkout.ts` need no change (X20–X26).

Tests to extend: `test/unit/application/commands/add.test.ts`, with X1–X5, X7–X12 and X14 on
the memory adapter, asserting the result and no `writeObject` for the excluded path. Interop:
`test/integration/pathspec-glob-dialect-interop.test.ts`, where tsgit `!p` is twinned with
git `:!p`, X1–X19.

### Size and hot path

- Removed: `scanStar`, the `pathname` option, `containsGlob`, `compileLiteral`/`compileDirectory`,
  the `describe` `compileGlob` import, and per-ref recompilation in `buildRefFilter`.
- Added: `verbatimLevel`, `hasGlobSpecial`, the prefix and one-star fast paths, the bytes export,
  `subpathMatch`, the refusal helpers, and the `add` seen pre-check. `ref-glob.ts` is already in
  the browser bundle (merge, reflog expire, name-rev), so the wildmatch engine costs nothing new.
- Net: **not measured.** It cannot be measured before code exists, and nothing was built in this
  phase. Estimate: +150 to +300 B gzip, more than the 0.1 kB headroom → candidate 11.
- Hot path: the common `add '*.ts'` and `checkout -- 'src/*.ts'` take the one-star or prefix path
  with no encoding. The DP path encodes once per tested path. That is one `Uint8Array(n)` against
  the `tokens × Uint8Array(n+1)` layers the DP already allocates, so it is not the dominant cost.
- Fold (Parts f–i), estimated before any code exists: f +80 to +150 B gzip (two filters, the
  report split, the checkout universe filter); g +150 to +300 B (the gitlink step and gitfile →
  child-context resolution; `deriveContext`, `resolveRef` and `parseGitfilePointer` are already
  bundled); h +150 to +250 B (the lazy ignore split, `firstIgnoredOf`, `force` wiring, the result
  fields); i +20 to +40 B. Total +400 to +740 B against caps raised to the floor by `0287b658`,
  so candidate 11's route applies again: measure, then raise by the measured delta. Under the
  recommendations no error-union member is added (13A adds result fields; 17A reuses
  `NOT_A_REPOSITORY`). 13B would add two members, about 30 B gzip each.
- Fold hot paths: the literal fast path (`add <file>`) now builds the repo ignore predicate unless
  `force` is set. I17 makes that necessary even for a tracked literal: git reports the ignored
  directory above it. This is the one new per-call cost on a path that skipped ignore rules
  before. Bench it with new `add.bench.ts` rows ("When add() stages one tracked literal" / "one
  untracked literal") under `bench:ab`. If the delta exceeds noise, review decides. The walk pays one boolean read per entry (i) and one map lookup per walked
  leaf (f; `walkedTrackedFirst` already does that lookup, so the filter can sit there). The
  gitlink step is one pass over the index entries already in memory, plus one `lstat` and one
  HEAD read per gitlink, and a superproject holds few gitlinks.

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| 1 | Pathspec wildcard engine | **A** flags-0 wildmatch from `ref-glob.ts` over `encodeEscaped(path)` bytes, behind verbatim-first + prefix/one-star fast paths (amends ADR-040, ADR-980 option 3) · **B** a code-unit variant of the same tokenizer/DP over the escape view (no encoding) · **C** extend `compileGlob` with `[…]`, `\`, crossing stars | A | Only A matches D11/D11b/L1–L3/L5/L6: git's `?` and `[…]` take one **byte**. B and C keep the multi-byte divergence ADR-980 left open and would need their own bracket parser (C also grows the bundle). A reuses an engine already in the bundle and already mutation-tested. |
| 2 | Glob-special set deciding literal vs wildcard | **A** git's `is_glob_special`: `* ? [ \` · **B** ADR-037's `* ? [` · **C** today's `* ?` | A | E1/E2 (`a\b` stages `ab`) and D6/D17 need `\` to enter wildmatch. D5*/D16 need `[`. Verbatim-first keeps D8a/D8b/E3 (`a[`, `a\`, `a[b`) matching their literal files under A. |
| 3 | `add` refusal before any object write | **A** under the lock: seen from the index first; when every positive entry is index-seen, stream the staging walk as today; otherwise buffer the one walk (paths + stats, no hashing), mark seen, refuse, then stage from the buffer · **B** keep refusing after the staging walk, before the index commit · **C** always buffer the walk | A | B leaves loose blobs (B1/B2 pin `loose = 0`). C costs the walk/hash overlap on every glob add. A costs nothing when the index already sees every pathspec (B6/B7/B8) and adds no second `readdir` pass when it does not. |
| 4 | git's `file_exists` escape for an unmatched pathspec (B11) | **A** globs only: skip the refusal when the verbatim body `lstat`s · **B** globs and literals (an ignored existing literal stops refusing, with no ignored report) · **C** not replicated | A | B11 pins exit 0 for the glob. Applying it to literals swaps one divergence for another until the ignored-path report (B3l/B3m) exists, which is out of scope. |
| 5 | Checkout naming several unmatched pathspecs (C4/C5) | **A** `PATHSPEC_NO_MATCH` gains an additive `patterns: ReadonlyArray<string>` (every unmatched spelling in order; `pattern` = first) · **B** name the first only · **C** a separate checkout error code | A | A keeps C4/C5's data (two lines) without breaking `code` consumers. B drops a pinned line. C breaks callers matching `PATHSPEC_NO_MATCH` from checkout today. |
| 6 | Checkout refusal vs `index.lock` precedence (K1) | **A** take the lock in `pathRestore`, read the index (both sources), then enumerate, refuse and materialize under it (`materializePathRestore*` receive the held lock and the read index) · **B** keep the pre-lock refusal; log K1 as a follow-up | A | K1 pins lock-first and K4/K5 index-read-first, which already hold for add/rm (K2/K3). The brief asks for refusal "on the same lock path". The universe read moves under the lock, which also closes the pre-lock snapshot race the comment at `checkout.ts:346-352` describes. |
| 7 | `describe --match`/`--exclude` matcher | **A** `compileRefGlob` (flags 0) on the short name · **B** the new pathspec matcher | A | Same dialect (DS2–DS7). Ref names cannot hold `* ? [ \`, so verbatim-first adds nothing, and the plain ref-glob compile is smaller. |
| 8 | Exposing name-rev's abbreviation (N2–N28) | **A** `NameRevResult.abbreviated: boolean` (git's `can_abbreviate_output` from a suffix-only include match); the caller shortens with shorten-unambiguous · **B** no field; callers recompute suffix matching from their own patterns · **C** return a pre-shortened name | A | ADR-249: data, not rendering. C renders and needs ref lookups in the library's result. B duplicates the matcher in every caller. N25/N27 show the form depends on match kind, which only the library knows cheaply. |
| 9 | `compileGlob`'s non-`pathname` mode once (a) and (c) move | **A** remove `scanStar`, the `pathname` option and the branch (pathname-only engine for ignore/attributes/sparse) · **B** keep it | A | After candidates 1A and 7A it has no caller; keeping it is dead code. It is also the size offset for candidate 11. |
| 10 | `rm -r` rule for pathspecs that are not literals | **A** per-entry max match level over the index, checked in argument order with the no-match check · **B** keep the `-r` check for literals only | A | R4b refuses in git; under B, verbatim-first would silently remove `a?/f` without `-r` (data loss). R4/R6 show `FNMATCH` never needs `-r`. |
| 11 | Browser-bundle cap (342.1 kB, ~0.1 kB headroom) | **A** offset first (candidate 9 removals); if still over, raise the cap by the measured delta in this PR · **B** also drop `MAX_DOUBLE_STAR_PER_PATTERN` / `countDoubleStars` from `resolve-pathspec.ts`: its stated reason (RegExp blow-up) is gone under ADR-077, and git has no such cap · **C** hold the PR until another change frees bytes | A, with B as a separate user call | A is the measured route. B is also a behaviour change, since git accepts patterns tsgit refuses with `INVALID_OPTION`; it is faithful but out of the brief's literal scope, so it needs a yes. |
| 12 | Backslash in a pathspec body (`resolvePathspec` refuses it today; the design missed it, the planner found it) | **A** keep the refusal: D6/D8b/D17/E1/E2 stay command-level follow-ups, and the matcher keeps `\` glob-special · **B** accept `\` on hosts without Windows path syntax, for matching only · **C** accept `\` everywhere | planner: A | **Decided: ADR-1044, B** (user-ratified). D6, D17 and E2 match git on POSIX. The security dimension reviews the relaxed intake. D8b and E1 stay follow-ups under the walk validator. |
| 13 | How `add` reports what git lists and exits 1 for while still staging the rest: ignored entries a pathspec reaches (I1–I10, I17–I23, I29) and skip-worktree-only pathspecs (S2–S7, S12, S15) | **A** return normally with additive `AddResult` fields `ignored: ReadonlyArray<FilePath>` (the paths git lists, sorted) and `sparse: ReadonlyArray<string>` (the spellings git lists), both `[]` when nothing is reported. Every other match is staged and committed, as git does. The caller derives git's exit 1 from a non-empty list (ADR-249) · **B** refuse atomically with new error members `PATHSPEC_IGNORED { paths }` / `PATHSPEC_SPARSE { patterns }` (about 30 B gzip each), nothing staged · **C** stage and commit the rest, then throw an error that carries the report and the `AddResult` | A | A is the only shape whose index matches git on the mixed rows (I2, I3, I10, I17, I19–I23, S5–S7: git stages the rest). B would also turn I20–I23, whose index is right today, into refusals. It leaves ADR-1035 untouched: that ADR's atomic refusal covers unmatched pathspecs, which still refuse first (I5, I6, S9). B diverges on every mixed row's index. C throws after a durable write, which breaks the "a throw means nothing changed" contract every `add` refusal keeps (ADR-1035) and CQS. A's cost: a caller that ignores the fields misses git's failure exit. The documentation phase must say so. |
| 14 | `AddOptions.force`, declared and never read today (I13–I16) | **A** wire it as git's `-f`: no ignore rule applies on any route (literal split, walk, `addAll`) · **B** wire it for the literal report only · **C** leave it unread | A | With R16 and C together, an ignored untracked file could no longer be staged through `add` at all: today's literal bypass is the only route, and R16 closes it. B keeps I13–I16 divergent. A is git's flag as pinned. |
| 15 | Release class of R16: `add(['ignored.txt'])` stops staging the file without `force` (I1; `add.test.ts:1728` pins today's staging) | **A** ship as a `fix`, as this PR already ships other git-faithful refusal and staging changes (B1, R2, C6) · **B** ship R16's report on the walk route only and keep the fast-path literal bypass until a major (I1–I4 and I9 stay divergent) · **C** hold all of R16 for the breaking batch (32.11b) | A, user call | The brief excludes breaking changes, and only the user can say whether a consumer staging ignored files by literal counts as one. B splits behaviour by route: `add x.log` would stage while `add x.log '*.txt'` reports. C keeps I1–I16 open. |
| 16 | How `add` resolves a gitlink's checkout HEAD (R15) | **A** read `<path>/.git`: a directory is the gitdir; a gitfile goes through `parseGitfilePointer`, resolved relative to `<path>`. Derive a child `Context` on that gitdir (`deriveContext`, as `buildChildContext` does) and call `resolveRef(child, HEAD)`, which covers packed refs, symbolic HEAD and reftable · **B** reuse `deriveSubmoduleContext` (`.gitmodules` name → `.git/modules/<name>`) · **C** a minimal reader: HEAD file, loose ref, `packed-refs`, no reftable | A | B misses GL17 (embedded clone, no `.gitmodules`) and GL18 (`--name other`), both pinned to stage, and GL19 (a replaced repository). C reimplements ref resolution and misses a reftable submodule. A reuses bundled code. The security review must look at it: the gitfile may point outside the work tree, as it may for git, and the read stays read-only. |
| 17 | A `<path>/.git` that leads to no repository (GL20 broken gitfile, GL21 corrupt HEAD) | **A** refuse with the existing `NOT_A_REPOSITORY { path }` (`src/domain/repository/error.ts`), the path being git's `<path>/<gitdir as written>`, before any blob write (the gitlink step runs before `stageWalkedEntries`) · **B** leave the entry unchanged and succeed (today's outcome) · **C** a new member `SUBMODULE_NOT_A_REPOSITORY { path }` | A | git dies with exit 128 and the index unchanged, and A matches both with no new union member. B is a refusal-condition mismatch. C costs about 30 B gzip for a distinction `path` already carries. |
| 18 | Admitting a `\`-named entry in the working-tree walk (R17) | **A** host-gate it: `validateWalkedEntryPath` refuses `\` only under `windowsPathSyntax`, the key ADR-1044 uses · **B** admit it on every host · **C** keep refusing, but skip the entry instead of throwing | A | A matches W1–W5, W7 and W16 on POSIX and keeps ADR-1044's Windows stance in one place. B admits a separator-bearing name under Windows path syntax, which ADR-1044 refused. C stops `status` from throwing but still hides the file from `add` (W1–W5 stay divergent), against git. |
| 19 | `rm` removing a `\`-named working-tree file (W8, W9) | **A** extend the same host gate to `removeFile` (`internal/working-tree.ts:84`), the only writer these rows reach · **B** leave `rm` as a pinned follow-up (its refusal is atomic: index and file unchanged) · **C** gate `validateWorkingTreePath` itself for every caller (`mv`, `materializeFile`, the pathspec intake) | A | W8/W9 are a refusal-condition mismatch on POSIX, and A closes them with the gate Part i already builds. C widens the change to `mv` and `materializeFile`, which nothing here pinned. B is the fallback if the security review rejects A. |
| 20 | How the literal fast path honours exclusions (R18) | **A** route every call that holds a negated entry to the walk route (`addByPathspec`), which already matches X6/X13/X15–X19 · **B** keep the fast path and filter `literalMustMatch` through the full matcher, then refuse or escape each fully-excluded literal in the fast path · **C** lift the exclusion check into `resolvePathspec`, so `literalMustMatch` arrives pre-filtered | A | A reuses the one implementation of git's exclusion, seen and escape order, so X1/X15 cannot drift between routes. Its cost is a walk for literal-plus-exclusion calls, which are rare, and the size cost is a few bytes. B duplicates the refusal and escape logic in a second route. C gives resolve-pathspec knowledge of the disk (the escape), which belongs to the command. |

**Blockers:** none. None of the four IN parts needs magic pathspecs, `:(exclude)` or a change to
the `!` alias to match the pinned rows.

## Test strategy

**Unit — domain** (extend; re-pin any row that changes against the matrix, never edit to fit):

- `test/unit/domain/pathspec/compile-pathspec.test.ts`: D/E rows as `compilePathspec([spec])[0].compiled.test(path)`.
  Existing rows that change: "Given a glob \"*.ts\"" (`anchored` wording), "Given an anchored glob
  \"src/**\"".
- `test/unit/domain/pathspec/match-pathspec.test.ts`: `pathspecMatchLevel` for EXACT /
  RECURSIVE / FNMATCH / NONE (R4, R4b, R6 shapes).
- `test/unit/domain/pathspec/matching-path.test.ts`: L1–L6 through `matchesIndexPath` with
  `pathBytes`.
- `test/unit/domain/pathspec/compile-glob.test.ts`: drop the non-`pathname` rows with the dead
  mode. Keep every `pathname` row, renamed to say gitignore dialect.
- `test/unit/domain/refs/ref-glob.test.ts`: the bytes export agrees with `compileRefGlob` on
  well-formed input and matches raw invalid bytes.
- `test/unit/domain/describe/match.test.ts`: DS2–DS7, DS12.
- `test/unit/domain/name-rev/ref-pattern.test.ts`: suffix matching (N2–N4, N7, N8, N14–N18),
  exclude through suffixes (N10–N13), `abbreviates` (N2, N5, N6).

**Property tests** (per `.claude/workflow/property-testing.md`):

- New `test/unit/domain/pathspec/compile-glob.properties.test.ts`: still missing for a matcher.
  Lens 3 (total over ASCII no-NUL patterns, returns a callable) and lens 2 (a pattern with no
  special characters matches exactly itself under `anchored`).
- `compile-pathspec.properties.test.ts` (extend). Lens 3: total over arbitrary bodies, `\`/`[`
  included. Fast-path ≡ DP: for arbitrary `(prefix, suffix, path)` the one-star and prefix paths
  return the same as the bytes export run on `encodeEscaped(path)`. The oracle is the
  independently tested ref-glob DP, not a copy. Arbitrary paths include escape-view lossy bytes.
  Verbatim: `test(body)` is true for every body; `test(body + '/' + x)` is true.
- `ref-pattern` gets no property sibling: the inputs are a small ref/pattern grammar and the
  example sweep covers it (lens fit is weak; state it in review).

**Unit — application:**

- `test/unit/application/commands/internal/resolve-pathspec.test.ts`: `positives` order and
  spellings; the `hasGlob` relaxation tests are re-pinned (B rows). Backslash intake (R11): with
  a POSIX host, `a\*b`, `a\?b`, `a\b` are accepted as non-literal entries and their
  `symlinkScanTargets` are the no-wildcard prefixes; with `{ windowsPathSyntax: true }` each
  refuses `PATHSPEC_OUTSIDE_REPO { path }`.
- `test/unit/domain/working-tree-path.test.ts`:
  `validatePathspecBody` accepts `\` and keeps every other refusal; `validateWorkingTreePath` and
  `validateWalkedEntryPath` still refuse `\`.
- `add.test.ts`: re-pin "Given a glob with no match" (`:1652`) → B9 refusal. Add B1/B2 with an
  object-store spy asserting no `writeObject` before the throw. Add B11 with the B11′ fixture
  (`.gitignore: nomatch?`; tsgit's gitignore dialect has no `[…]`), B12r, and RN1/RN2/RN4–RN6.
  Memory-adapter rows for the index-side pass: B8, B14, B15 and B16's staging flip; B13 is a
  guard. Also the R12 cases: `all: true` on B8's and B14's fixtures, intent-to-add staged, the
  skip-worktree entry left unstaged, and a missing ignored tracked file still removed (B7 shape).
- `rm.test.ts`: re-pin "Given a glob \"*.nope\" with no matches" (`:405`). Add R1, R2, R4, R4b, R6.
- `checkout.test.ts`: re-pin `:967`, `:992` (becomes K4: the corrupt index refuses on the read),
  `:1380`, `:1557`. Add C1b, C4/C5 `patterns`, C8, K1, K1L. K5 is a guard (it passes today).
- `name-rev*.test.ts`: `abbreviated` on N2/N5; `test/unit/application/commands/name-rev-tip-table.test.ts`
  keeps its name forms (the ref chosen does not change).

**Integration — interop** (`test/integration/interop-helpers.js` `GIT_AVAILABLE`, `git`,
`runGit`, `tryRunGitWithExit`; scrubbed env, pinned dates for commits):

- New `test/integration/pathspec-glob-dialect-interop.test.ts`: the D/E/B/R/C/G/K rows, with
  B11′, B12r, RN4–RN6 and K1L. B8 comes back (Part 7 held it back), together with B13–B16 (B16
  compares the index only, not the advice or exit code). Each runs real git and tsgit on twin repos and compares
  `ls-files -s` / file bytes / loose-object count / error code + pattern(s). Wording is
  reconstructed per command from the code.
- D6, D17 and E2 run at command level under
  `describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')`, the repo's convention (for
  example `gitmodules-symlink-alias-interop.test.ts:239`). Windows cannot hold the `a*b`/`a?b`
  fixtures, and its `\` refusal is the tsgit-only Windows row in Part a. The same gate covers
  every row whose fixture name holds `*`, `?` or `\` (RN4, B11′). D8b and E1 are not
  interop rows: they need a `\`-named file (Out of scope).
- L rows: build the lossy index with `git update-index --cacheinfo` (works on APFS). The
  worktree-side lossy `add` row is gated to Linux (`process.platform === 'linux'`).
- Extend `test/integration/describe-interop.test.ts` (DS rows) and
  `test/integration/name-rev-interop.test.ts` (N rows: `renderNameRev` gains the `abbreviated`
  branch using `git rev-parse --abbrev-ref=loose <ref>` as the shortening oracle. Plain
  `--abbrev-ref` is strict: with a tag and a branch both named `x`, it prints `tags/x` where git's
  `name-rev` prints `x` (N28). `=loose` prints `x` and `heads/x` (N25), re-run 2026-10-22).
- `test/integration/glob-double-star-interop.test.ts` must stay green unchanged (R9).

**Perf / size:**

- `test/perf/domain/refs/ref-glob.perf.test.ts`: the bytes export holds linear on `a*a*…*b`.
- `test/bench/add.bench.ts`: add a row "When add() stages by glob `*.txt`" on the existing
  fixture. Run `bench:ab` after the implementation commit (house rule).
- `npm run check:size` after `rm -rf dist .wireit`; record the delta for candidate 11.

**Mutation:** narrowed Stryker buckets per `.claude/workflow/mutation.md` over
`src/domain/pathspec`, `src/domain/refs/ref-glob.ts`, `src/domain/describe/match.ts`,
`src/domain/name-rev/ref-pattern.ts`, `resolve-pathspec.ts`, and the touched functions in
`add.ts`/`rm.ts`/`checkout.ts`. Keep the existing equivalence marks on the DP loops intact.

**Fold (Parts f–i)** — every row below is a matrix row; re-pin, never edit to fit:

| Layer | File | Rows |
|---|---|---|
| unit | `test/unit/application/commands/add.test.ts` | S1–S15 (memory adapter, `skipWorktree` override as at `:3306`; assert `sparse`, index flags and no `writeObject` for the skipped entry). GL1–GL6, GL11–GL13, GL16, GL20–GL23 (a gitfile `sub/.git` plus `.git/modules/sub` in the memory adapter). I1–I30 (re-pin `:1728` → I1 and `:1750` → I6) |
| unit | `test/unit/application/commands/checkout.test.ts` | SC1–SC12, both sources; assert the file bytes, the bit and the `PATHSPEC_NO_MATCH` `patterns` |
| unit | `test/unit/application/commands/internal/pathspec-intake.test.ts` | `reachesSkipWorktree` |
| unit | `test/unit/domain/working-tree-path.test.ts` | `validateWalkedEntryPath('a\\b')` accepted without Windows syntax, refused with it; `validateWorkingTreePath` unchanged |
| unit | `test/unit/application/primitives/walk-working-tree.test.ts` | a `\`-named dirent is yielded (POSIX host) and refused (`windowsPathSyntax`) |
| unit | `test/unit/application/commands/rm.test.ts` | W8/W9 under candidate 19A |
| interop | `test/integration/add-tracked-under-ignore-interop.test.ts` | S1–S15 (new `describe`, no ignore rule), GL1–GL23 (gitlink fixtures, `protocol.file.allow=always`, pinned dates); compare `ls-files -s -v` and, for the report rows, git's exit code against the structured fields (the advice text is rebuilt from `sparse`) |
| interop | `test/integration/pathspec-glob-dialect-interop.test.ts` | SC1–SC12 (disk bytes, `ls-files -v`, refusal patterns); I1–I30 and B3l/B3m/B16 (index + the ignored report rebuilt from `ignored`) |
| interop | `test/integration/pathspec-backslash-interop.test.ts` | W1–W16, D8b, E1 under the POSIX `describe.skipIf` at `:31`; the Windows block at `:76` gains the walk refusal |
| unit + interop | `add.test.ts`, `pathspec-glob-dialect-interop.test.ts` | X1–X19 (Part j); X20–X26 as `rm`/`checkout` guards in the same interop file |
| bench | `test/bench/add.bench.ts` | "When add() stages one tracked literal" and "… one untracked literal" (Part h's ignore build on the fast path), `bench:ab` after the implementation commit |

Mutation: the narrowed buckets gain `src/domain/working-tree-path.ts`,
`src/application/primitives/walk-working-tree.ts` and the touched `checkout.ts` functions. No
property sibling: none of the four parts adds a parser, decoder or matcher grammar (the report
split and the gate are predicates over existing matchers).

## Out of scope

- Magic pathspecs `:(…)`, `:!`/`:^`, `:(exclude)`, the `!` alias question, ADR superseding 038:
  backlog 32.11b (breaking).
- `add --ignore-missing` and the `rm` option that ignores unmatched pathspecs: not in the brief.
- Folded in on 2026-10-23, no longer out of scope: the ignored report with B16's advice (R16,
  Part h), skip-worktree seen rules and the sparse report (R13, R14, Part f), gitlink staging (R15,
  Part g), `\`-named working-tree entries with D8b/E1 (R17, Part i).
- The rendered advice text and its `advice.addIgnoredFile` / `advice.updateSparsePath` switches:
  display, rebuilt by the caller from `ignored` / `sparse` (ADR-249).
- `add --sparse`, `add -n`, `checkout --ignore-skip-worktree-bits`: options tsgit does not
  have. Pinned in passing: `git add --sparse x.log` on S's fixture exits 0 and leaves `S x.log`
  unchanged.
- `status` for a moved submodule: not pinned here. To prove a gap, twin GL1's fixture through
  `git status --porcelain` and tsgit `status()`.
- An untracked embedded repository under `add({ all: true })`: `add.test.ts:927` pins no
  gitlink. To prove a gap, twin `git add -A` over an untracked clone.
- The gitignore/gitattributes dialect's own `[…]`/`\` support: R9 keeps it unchanged. Unproven
  hunch; to prove it, pin `printf '[ab].log\n' > .gitignore` against `git check-ignore`.
- The `MAX_PATHSPEC_PATTERN_BYTES` / `**`-count budget: kept unless candidate 11 B is chosen.
- `mv` and `materializeFile` on a `\`-named path: `validateWorkingTreePath` callers outside
  candidate 19's reach. Nothing here pinned them. To prove a gap, twin `git mv 'a\b' c`.
