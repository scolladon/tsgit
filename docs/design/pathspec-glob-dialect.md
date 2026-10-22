# Design — pathspec glob dialect, unmatched-glob refusal, `describe`/`name-rev` patterns

> Brief: backlog 32.11, non-breaking head only. (a) pathspecs in `add`/`rm`/`checkout`/`grep`
> match with git's default dialect: `wildmatch(pattern, path, 0)` after a verbatim-prefix check;
> (b) a positive pathspec that matches nothing refuses atomically, before any write, per git's
> per-command rule; (c) `describe --match`/`--exclude` use the same flags-0 dialect on the short
> tag name; (d) `name-rev --refs`/`--exclude` match every `/`-suffix of the refname and expose
> git's abbreviation signal; (e) docs fold-in, carried by the plan. Magic pathspecs, `:(exclude)`,
> the `!` alias and the ADR superseding 038 are 32.11b, out.
> Status: draft → self-reviewed ×3 → accepted

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
- R5. An unmatched glob whose verbatim body exists on disk is not refused by `add` (B11:
  git's `file_exists` escape; scope: candidate 4).
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
| D6 | `a*b aXb` | `a\*b` | 0 · — · `a*b` | ✗ nothing |
| D7 | `dir/f d.txt` | `d*/` | 128 · `fatal: pathspec 'd*/' did not match any files` · empty | ✗ no error |
| D8a | `a[ ab` | `a[` | 0 · — · `a[` (verbatim; wildmatch aborts) | ok (literal) |
| D8b | `a\ ab` | `a\` | 0 · — · `"a\\"` | ok (literal) |
| D8c | `ab` | `a[[:foo:]]` | 128 · `fatal: pathspec 'a[[:foo:]]' did not match any files` · empty | ok (literal refusal) |
| D9 | `a?/f ab` | `a?` | 0 · — · `a?/f ab` (verbatim-recursive + wildmatch) | ✗ `ab` only |
| D10 | `dir/file` | `di?` | 128 · `fatal: pathspec 'di?' did not match any files` · empty | ✗ no error |
| D11 | `é.txt a.txt` | `?.txt` | 0 · — · `a.txt` (`?` = one byte) | ✗ also stages `é.txt` |
| D11b | same | `??.txt` | 0 · — · `"\303\251.txt"` | ✗ nothing |
| D12 | `x.txt d/x.txt` | `**/x.txt` | 0 · — · `d/x.txt` | ✗ also `x.txt` |
| D13 | `a/b/c a/d` | `a/**` | 0 · — · `a/b/c a/d` | ok |
| D14 | `d/a.txt e.txt` | `d/*` | 0 · — · `d/a.txt` | ok |
| D16 | `a ] b` | `[]a]` | 0 · — · `] a` | ✗ refuses (read as a literal) |
| D17 | `a?b axb` | `a\?b` | 0 · — · `a?b` | ✗ nothing |
| E1 | `a\b ab` | `a\b` | 0 · — · `"a\\b" ab` | ✗ `a\b` only |
| E2 | `ab` | `a\b` | 0 · — · `ab` | ✗ refuses |
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
| B3l | same | `add x.log` | 1 · `The following paths are ignored by one of your .gitignore files:` / `x.log` / 2 `hint:` lines · empty | out of scope (literal) |
| B3m | `x.log real.txt`, same ignore | `add x.log real.txt` | 1 · same advice · `real.txt` | out of scope |
| B3x | `x.log`, same ignore | `add 'x*'` | 128 · `… 'x*' …` · empty | ✗ |
| B3d | `d/x.log d/y.txt`, same ignore | `add 'd/*.log'` | 128 · `… 'd/*.log' …` · empty | ✗ |
| B4 | `x.log real.txt`, same ignore | `add '*.log' real.txt` | 128 · `… '*.log' …` · empty · 0 | ✗ stages `real.txt` |
| B4b | same | `add real.txt '*.log' 'nomatch*'` | 128 · `… '*.log' …` (first unmatched) · empty | ✗ |
| B4c | `d/x.log real.txt`, `.gitignore: d/` | `add '*.log'` | 128 · `… '*.log' …` · empty | ✗ |
| B6 | tracked clean `t.txt` | `add 't*'` | 0 · — · `t.txt` | ok |
| B7 | tracked `t.txt u.txt`, `t.txt` deleted | `add 't*'` | 0 · — · `u.txt` (deletion staged) | ok |
| B8 | tracked `x.log` modified, now ignored | `add '*.log'` | 0 · — · `M  x.log` | ok |
| B9 | `a` | `add 'n1*' 'n2*'` | 128 · `… 'n1*' …` | ✗ no error |
| B10 | `a` | `add missing 'n1*'` | 128 · `… 'missing' …` | ok (literal refusal) — but after the walk, see below |
| B10b | `a` | `add 'n1*' missing` | 128 · `… 'n1*' …` | ✗ names `missing` |
| B11 | file named `nomatch*`, `.gitignore: nomatch[*]` | `add 'nomatch*'` | 0 · — · empty | ok by accident (no error, nothing staged) |
| B12 | `a.txt` | `add . 'nomatch*'` | 128 · `… 'nomatch*' …` · empty | ✗ stages `a.txt` |
| RN1 | tracked `a.txt` | `add --renormalize 'nomatch*'` | 128 · `… 'nomatch*' …` | ✗ no error |
| RN2 | same | `add --renormalize 'a*' 'nomatch*'` | 128 · `… 'nomatch*' …` | ✗ |
| RN3 | same | `add --renormalize 'a*'` | 0 | ok |

**Refuted brief hypothesis:** `git add '*.log'` where every match is ignored is the plain
`did not match` refusal (exit 128, B3/B3x/B3d/B4c), **not** the "paths are ignored" advice. That
advice (exit 1) is the literal-path behaviour (B3l/B3m). (b) therefore needs no ignored-path scan.

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

tsgit today: `add` and `rm` lock first (ok). `checkout.pathRestore` checks the pathspec before
`acquireIndexLock` (`checkout.ts:344-358`), so K1 diverges, for literals too. For a tree source it
never reads the index on a zero-match glob, so K4 diverges (no-op success; the test at
`checkout.test.ts:992` pins that divergence).

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

**Row count** (D 23 + E 5 + L 6 + B 22 + R 11 + C 10 + G 5 + K 5 + DS 14 + N 28 = 129; B3l/B3m are
pinned for the out-of-scope follow-up and counted).

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
  `containsGlob` and sets `isLiteral = !hasGlobSpecial(body)`, so E1/E2 behave as git.
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
The interop renderer (`renderNameRev`) shortens with `git rev-parse --abbrev-ref <ref>` when it is
set. N21 (`--tags --name-only`) stays the caller's own `tags && nameOnly` rule, as today.

### Part e — docs fold-in (documentation phase)

`docs/BACKLOG.md` release-order row 1 still reads "6.0.0 — ship now". v6.0.0 shipped on
2026-10-21 (#315, `8dd442ee`). The documentation phase replaces the row with the user's text,
minus the 5.0.1 hotfix parenthesis the user dropped in the decisions phase (the "why here" cell
ends after "was a reported user failure"), strikes the four delivered sub-items of 32.11 and
leaves 32.11b open.

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
  spellings; the `hasGlob` relaxation tests are re-pinned (B rows).
- `add.test.ts`: re-pin "Given a glob with no match" (`:1652`) → B9 refusal. Add B1/B2 with an
  object-store spy asserting no `writeObject` before the throw. Add B11 and RN1/RN2.
- `rm.test.ts`: re-pin "Given a glob \"*.nope\" with no matches" (`:405`). Add R1, R2, R4, R4b, R6.
- `checkout.test.ts`: re-pin `:967`, `:992` (becomes K4: the corrupt index refuses on the read),
  `:1380`, `:1557`. Add C1b, C4/C5 `patterns`, C8, K1.
- `name-rev*.test.ts`: `abbreviated` on N2/N5; `test/unit/application/commands/name-rev-tip-table.test.ts`
  keeps its name forms (the ref chosen does not change).

**Integration — interop** (`test/integration/interop-helpers.js` `GIT_AVAILABLE`, `git`,
`runGit`, `tryRunGitWithExit`; scrubbed env, pinned dates for commits):

- New `test/integration/pathspec-glob-dialect-interop.test.ts`: the D/E/B/R/C/G/K rows. Each runs
  real git and tsgit on twin repos and compares `ls-files -s` / file bytes / loose-object count /
  error code + pattern(s). Wording is reconstructed per command from the code.
- L rows: build the lossy index with `git update-index --cacheinfo` (works on APFS). The
  worktree-side lossy `add` row is gated to Linux (`process.platform === 'linux'`).
- Extend `test/integration/describe-interop.test.ts` (DS rows) and
  `test/integration/name-rev-interop.test.ts` (N rows: `renderNameRev` gains the `abbreviated`
  branch using `git rev-parse --abbrev-ref <ref>` as the shortening oracle).
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

## Out of scope

- Magic pathspecs `:(…)`, `:!`/`:^`, `:(exclude)`, the `!` alias question, ADR superseding 038:
  backlog 32.11b (breaking).
- `add --ignore-missing` and the `rm` option that ignores unmatched pathspecs: not in the brief.
- The ignored-literal report (B3l/B3m: "The following paths are ignored…", exit 1, the rest still
  staged): a literal-path behaviour, not part of glob refusal. Pinned here for the follow-up.
- Sparse / skip-worktree seen rules (git's `PS_IGNORE_SKIP_WORKTREE` and the sparse advice): no
  sparse row pinned. To prove a gap: twin `git add 'x*'` where `x*` matches only a skip-worktree
  entry.
- The gitignore/gitattributes dialect's own `[…]`/`\` support: R9 keeps it unchanged. Unproven
  hunch; to prove it, pin `printf '[ab].log\n' > .gitignore` against `git check-ignore`.
- The `MAX_PATHSPEC_PATTERN_BYTES` / `**`-count budget: kept unless candidate 11 B is chosen.
