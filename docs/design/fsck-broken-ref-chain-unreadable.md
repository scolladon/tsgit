# Design — fsck refs with a broken chain, an unreadable file or directory, and git's loose-ref grammar

> Brief: `fsck`'s refs pass reports what git 2.56 reports for a ref whose chain
> ends on a broken or unreadable ref file. That means `badRefContent` or
> `badReferentName` on the broken referent, `cannot read ref file` on an
> unreadable one, and one `invalid sha1 pointer 0000…` on **every** ref of the
> chain. The run carries on and exits with git's bits instead of throwing
> `PERMISSION_DENIED`. Backlog 32.18 and 32.39, plus the five loose-ref gaps
> ADR-1126 folds in: an unreadable ref directory, the referent of a symlinked ref,
> the direct-oid body grammar, `trailingRefContent` and `refMissingNewline`.
> Status: revised against ADRs 1121–1126 → self-reviewed ×3 → open candidates
> D7–D10 go back to the decisions flow before planning (ADR-1126).

## Context

- **Prime directive** (CLAUDE.md, ADR-226): match git's data, refusal conditions and exit
  status byte for byte. **Structured output** (ADR-249): tsgit returns findings, and the
  interop test rebuilds git's stderr lines from them.
- **The refs pass today.** `runRefsVerifyPass`
  (`src/application/commands/internal/fsck/refs-verify.ts`) runs two halves:
  - **content notices** come from `RefStore.verifyIntegrity()`
    (`src/application/primitives/ref-store.ts`, `looseBodyFinding`): `symlinkRef`, and
    `badRefContent` with a **synthesised zero pointer for the same ref only**;
  - **pointers** (`collectAbsentTargets` → `snapshotTargets`) cover every `listRefs()`
    entry plus every worktree HEAD (`snapshotWorktreeHeads`, `roots.ts`).
- **Why the rows fail.** Each one is traced to code by the tsgit twin probes below.
  1. `listRefs` drops every name whose `resolveDirect` throws a `TsgitError`
     (`resolveEntry`, ref-store.ts L1105). A `ref: x..y` referent, an unreadable file and
     garbage all disappear from the snapshot. Garbage alone gets its pointer back through
     the synthesised one.
  2. `targetOf` (refs-verify.ts L142) maps only `REF_NOT_FOUND`, cycle and depth to the zero
     oid. A chain that hits `INVALID_REF` gets **no** pointer; one that hits
     `PERMISSION_DENIED` rethrows.
  3. `verifyIntegrity` → `looseBodyFinding` → `readLooseContent` (ref-store.ts L755)
     rethrows `PERMISSION_DENIED` before the snapshot runs.
  4. `looseBodyFinding` treats any `ref: ` line as healthy and never checks the referent.
  5. `walkRefDir` (L969) and `walkLinkedRefNames` (L1149) call `ctx.fs.readdir` bare, so one
     unreadable directory under `refs/` makes **every** listing throw (rows DIR-*).
  6. `linkedRefNames` reports `symlinkRef` and nothing else: no referent check on a link.
  7. `parseLooseRef` (`src/domain/refs/loose-ref.ts` L18) trims `[\r\n]+$`, requires
     `ref: ` with one space, and hands the whole rest to `ObjectIdFactory.from`, which takes
     lower-case hex of width 40 **or** 64. `LOOSE_OID_RE` (ref-store.ts L550) repeats that
     in `looseBodyFinding`. So upper case and `<sha> <anything>` are refused, and a 64-hex
     body resolves in a SHA-1 repository (row W64).
  8. `trailingRefContent` and `refMissingNewline` are in the catalogue
     (`src/domain/fsck/msg-ids.ts` L152/L155, INFO in `docs/design/fsck.md` L367/L368) and
     never emitted.
- **The `cannotReadRef` precedent.** `UnreadableHead` (roots.ts L884) and
  `unreadableHeadFinding` (refs-verify.ts L173) report an unreadable linked-worktree HEAD as
  `{ msgId: 'cannotReadRef', path, reason: 'PERMISSION_DENIED' }`, bit 8, absolute `path`
  (pinned in `test/unit/application/commands/fsck-worktree-heads.test.ts` L249).
- **Pins in tension.** `test/unit/application/commands/fsck-symbolic-ref-fault.test.ts`
  requires a `PERMISSION_DENIED` on a symref chain read to propagate; ADR-1122 re-pins it.
  ADR-1116 (refusal for an unreadable loose *object* under `--connectivity-only`) stands:
  it is the odb's reader, not the files ref backend.
- **`git fsck` runs `git refs verify` as a child.** A death of that child (`fatal:`, 128)
  costs fsck bit 8 and every check the child had not made yet; fsck's own pointer pass
  still runs (rows L-DIE*). Pinned by running `git refs verify` directly (exit 128) beside
  `git fsck` (exit 8) on the same shape.
- **Governing docs.** `docs/design/fsck.md` (msg-id table L362–L370),
  `docs/use/commands/fsck.md` (`bad-ref` row L155, exit table L259), ADR-874 (symlinked refs),
  ADR-1072 (`UNREADABLE_REF_CODES`), ADR-1116, ADRs 1121–1126. Lessons 005, 015, 017, 022.

### How the values below were pinned

Every probe ran in a `mktemp -d` throwaway under `bash` with `set -euo pipefail` and
`env -i PATH=… HOME=<B>/home GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=<B>/gitconfig`, where
that gitconfig holds only `[user]`. Every git call passed `-c commit.gpgsign=false -c
gc.auto=0`. Each repo is `git init -b main` with one commit; every ref is a loose file under
`.git/refs/heads/` unless the row says otherwise. Oracle: **git 2.56.0** (Homebrew, macOS,
APFS, non-root). `<B>` is the throwaway root as `mktemp` printed it (`/var/…`), `<RB>` its
realpath (`/private/var/…`), `0{40}` the zero oid. The "tsgit" column is
`fsck(createNodeContext({ workDir }))` (and, for listing rows, `listRefs`, `listRefNames`,
`branchList`, `revList({ all: true, count: true })`, `resolveRef`) on this branch's base
071d8e48, run on the same directories. A cell reading "by code" is traced, not twin-run.
Rows that seed one shape seed it **first and last** in name order (`a` and `z`, lesson 022);
APFS readdir yields `z` before `a`, so git's per-ref content lines come out `z`, `a`.

## Requirements

1. **Chain pointer.** Every listed ref (loose or packed, HEAD excluded) whose resolution
   fails reports `bad-ref badRefOid` with `target` = the zero oid, bit 2: a missing end, a
   cycle or over-depth, an invalid referent, unparseable content, an unreadable file, or a
   name the walk lists but cannot stat (DIR-SRCH). Covers `a`, `b`, `c` in every chain row.
2. **`badReferentName`** (ADR-1121). A loose ref (`HEAD` included) whose body is a symref to
   a name git's referent check rejects reports `bad-ref badReferentName` with `referent` as
   read; severity `fsck.badReferentName` (default error, bit 8); gated by
   `checkReferences`. **`symrefTargetIsNotARef`** (ADR-1124): referent neither a root ref nor
   `refs/`-prefixed → info finding with `referent`, no bit unless configured error (bit 8),
   never upgraded by `--strict`, dropped when that ref's `badReferentName` is graded error.
3. **`cannotReadRef`** (ADR-1122). A loose ref **file** the refs pass cannot open for
   permission reports `{ msgId: 'cannotReadRef', path: <absolute path opened>, reason:
   'PERMISSION_DENIED' }`, error, not re-typeable, gated, bit 8. A chain read hitting it maps
   to the zero pointer. The pass never throws `PERMISSION_DENIED`; other faults propagate.
4. **Linked-worktree HEAD** (ADR-1122): its `cannotReadRef` is gated by `checkReferences`
   (W-nr) and fires only when the HEAD file itself is unreadable; a HEAD whose target is
   unreadable, or sits in an unreadable directory, is skipped (HU, DIR-HEAD).
5. **Severity overrides** follow the S rows: each `fsck.<msg-id>` re-types only its own line
   and only that line's bit 8. Pointer lines and bit 2 never change. `--strict` upgrades
   none of the messages this change adds or touches (each is ERROR or INFO by default);
   `symlinkRef` keeps its existing handling (ADR-874).
6. **`--no-references`** drops every content line and every walk warning, and keeps every
   pointer (N rows). **`--connectivity-only`** changes nothing on this surface.
7. **Loose-body grammar** (ADR-1125, ADR-1126 §3), binding every reader (resolution, HEAD,
   the write chain's re-read, fsck):
   - **symref:** strip trailing SP/HT/CR/LF; `ref:` followed by any run of SP/HT/CR/LF; the
     rest is the referent; empty refuses.
   - **direct:** exactly the repository's `hexLength` hex digits, **either case**, resolved
     lower-cased; the next byte is end-of-body or one of SP/HT/CR/LF, otherwise
     `badRefContent`. A 64-hex body in a SHA-1 repository is `badRefContent` (W64).
8. **`refMissingNewline` and `trailingRefContent`** (ADR-1126 §4–5): `bad-ref` info findings,
   no bit unless configured error (bit 8), not upgraded by `--strict`, gated. Direct body:
   trailer (bytes after the oid) empty → `refMissingNewline`; trailer other than exactly
   `\n` → `trailingRefContent` carrying the raw trailer. Symref body: last byte not LF →
   `refMissingNewline`; more than one trailing SP/HT/CR/LF byte → `trailingRefContent`
   (the whitespace variant, no trailer). Both precede the referent checks and survive an
   error-graded `badReferentName` (DOTS-NOLF). An unparseable body yields `badRefContent`
   only (EMPTY, GARB). A symlinked ref gets neither (git checks no body through a link).
9. **Unreadable directory** (ADR-1126 §1). The shared loose-ref walk skips a directory
   whose `readdir` fails with `PERMISSION_DENIED`, silently, for every listing consumer. The
   refs pass reports each such directory its own walk reaches (it never descends a link),
   plus each entry it lists but cannot `lstat` (DIR-SRCH), as a walk finding (shape: D7),
   no exit bit, gated by `checkReferences`. A name a skipped directory hides is absent from
   both listings, so it gets no pointer; a packed name under it keeps its packed value
   (DIR-PK).
10. **Symlinked ref referent** (ADR-1126 §2, wording amended by the pins — see D6). The
    referent of a link under `refs/**` is git's realpath of the link with the
    `<gitdir>/` prefix removed, or the absolute realpath when outside it — **not** the link
    text. It goes through requirement 2's checks (both msgIds, early return) beside
    `symlinkRef`. A link onto an unreadable file gets no `cannotReadRef` of its own; its
    referent facts and its pointer stand (L-U000, L-UOUT). A link whose realpath cannot be
    computed (missing intermediate component, more than 32 hops) ends git's `refs verify`
    child: D8.
11. **Order.** Content and walk lines in the store's walk order (readdir, depth first, the
    `refs/` walk before the root refs — ROOTORD2), then the worktree-HEAD `cannotReadRef`s,
    then every pointer in byte-wise name order, then the worktree HEADs' pointers, last
    `no-default-references`. The interop compares content and walk lines as a sorted
    multiset and pointer lines in sequence.
12. A reftable repository behaves as today: it has no loose bodies and no directory walk.

## Design

### 1. Pinned matrix (git 2.56.0)

Lines are git's stderr in order; `warning:` is noted, every other line is `error:`.
"ptr X" = `refs/heads/X: invalid sha1 pointer 0{40}`.

**Chains**

| Row | Shape | git stderr | git exit | tsgit today |
|---|---|---|---|---|
| A-garbage | `a`→`b`, `b`=`garbage\n` | `refs/heads/b: badRefContent: garbage` · ptr a · ptr b | 10 | b content + ptr b, **no a**, 10 |
| A-abc | `b`=`abc\n` | same, `badRefContent: abc` | 10 | no a, 10 |
| A-empty | `b`=empty | same, `badRefContent: ` | 10 | no a, 10 |
| A-ref-dots | `b`=`ref: x..y\n` | `refs/heads/b: badReferentName: points to invalid refname 'x..y'` · ptr a · ptr b | 10 | **nothing, 0** |
| CH3 | `a`→`b`→`c`, `c` garbage | c `badRefContent` · ptr a, b, c | 10 | c only, 10 |
| CH3-dots | `a`→`b`→`c`, `c`=`ref: x..y` | c `badReferentName` · ptr a, b, c | 10 | nothing, 0 |
| DA | `b`=`ref: x..y`, no `a` | b `badReferentName` · ptr b | 10 | nothing, 0 |
| ORDER | `z`→`b`, `b` garbage | b `badRefContent` · ptr b · ptr z | 10 | no z, 10 |
| HT | HEAD→`main`, `main` garbage, only ref | main `badRefContent` · ptr main · `notice: No default references` | 10 | matches |
| HC | HEAD→`main`→`b`, `b` garbage, healthy `keep` | b `badRefContent` · ptr b · ptr main (**no HEAD line**) | 10 | no main, 10 |
| PK-ok | loose `a`→packed `main` | — | 0 | matches |
| PK-abs | loose `a`→packed `b` = `1111…` | `refs/heads/a: invalid sha1 pointer 1111…` · same for b | 2 | matches |
| HD | HEAD=`ref: refs/heads/x..y` | `HEAD: badReferentName: … 'refs/heads/x..y'` (no HEAD pointer) | 8 | nothing, 0 |
| C-dangling | `a`→`b`, `b` absent | ptr a | 2 | matches |

**Unreadable files**

| Row | Shape | git stderr | git exit | tsgit today |
|---|---|---|---|---|
| B-with-a | `b`=HEAD sha, mode 000, `a`→`b` | `cannot read ref file '.git/refs/heads/b': Permission denied` · ptr a · ptr b | 10 | **throws** |
| B-alone | same, no `a` | cannot-read b · ptr b | 10 | throws |
| ORD-U | `z`→`b` unreadable, healthy `c` | cannot-read b · ptr b · ptr z | 10 | throws |
| TAG | `refs/tags/t` mode 000 | `cannot read ref file '.git/refs/tags/t': …` · `refs/tags/t:` pointer | 10 | throws |
| U-sym | `a`=`ref: refs/heads/main`, mode 000 | cannot-read a · ptr a | 10 | throws |
| U-shadow | loose `b` mode 000 shadowing packed `b` | cannot-read b · ptr b **0{40}** | 10 | throws |
| U-only | `main` mode 000, only ref | cannot-read main · ptr main · `notice: No default references` | 10 | throws |
| HU | HEAD→`main` mode 000, healthy `keep` | cannot-read main · ptr main (no HEAD line) | 10 | throws |
| HU-nr | HU, `--no-references` | ptr main | 2 | throws |
| U-sev | B-alone, `-c fsck.badRefContent=ignore -c fsck.badRefOid=ignore` | unchanged | 10 | throws |
| U-strict | B-alone, `--strict` | unchanged | 10 | throws |
| U-sub | B-alone, run from `<repo>/sub` or `-C <repo>` | path printed `.git/refs/heads/b` | 10 | throws |
| U-gd | B-alone, `--git-dir=<B>/…/.git` | path printed `<B>/…/.git/refs/heads/b` | 10 | throws |
| W | linked worktree HEAD mode 000, run from main | `cannot read ref file '<RB>/wt/.git/worktrees/wt-linked/HEAD': …` | 8 | matches (path `<B>/…`) |
| W-nr | W, `--no-references` | — | **0** | **cannotReadRef, 8** |
| MH | main `.git/HEAD` mode 000 | `fatal: not a git repository` | 128 | out of scope |
| ORD | `z` mode 000, `a` garbage, linked HEAD mode 000 | cannot-read z · a `badRefContent` · cannot-read linked HEAD · ptr a · ptr z | 10 | throws |

git prints the path as `<gitdir as git holds it>/<ref>`: relative `.git` once it has
chdir'd to the top level, absolute under an absolute `--git-dir`, the realpath for a
linked worktree's admin dir.

**Unreadable directories (gap 1)**

| Row | Shape | git | tsgit today |
|---|---|---|---|
| DIR | `refs/heads/d/` mode 000 holding `d/x` | `fsck`, `--strict`, `--connectivity-only`: `warning: error opening directory '.git/refs/heads/d/': Permission denied`, exit 0. `--no-references`: nothing, 0. `for-each-ref`, `branch -a`, `show-ref`: `main` only, 0. `rev-list --all --count`: 1. `log --all`: main's commit only | `fsck` (all four modes), `listRefs`, `listRefNames`, `branchList`, `revList({all})` all **throw** `PERMISSION_DENIED`, `data.path` = `<B>/D/.git/refs/heads/d`; `packRefs` → `packableEntries` → `listRefs` throws (by code) |
| DIR-PR | DIR, `pack-refs --all` | exit 0; `packed-refs` holds `main` only; `d/` stays | throws (by code) |
| DIR-AZ | `a/` and `z/` mode 000 | two warnings, readdir order (`z/` then `a/`), exit 0; `for-each-ref`: main | throws (by code) |
| DIR-N | `d/e/` mode 000, `d/y` readable | `warning: error opening directory '.git/refs/heads/d/e/': …`, 0; listings show `d/y` and `main` | throws (by code) |
| DIR-T | `refs/tags/td/` and `refs/remotes/o/` mode 000 | one warning each (`'.git/refs/tags/td/'`, `'.git/refs/remotes/o/'`), 0; every listing shows `main` | everything throws except `branchList` (its prefix push-down never walks `refs/remotes`) |
| DIR-ONLY | the only ref is `d/x` in a mode-000 `d/`, HEAD unborn | warning · `notice: No default references` · `dangling commit …`, 0; `--no-references`: notice + dangling, 0; `for-each-ref`: empty; `rev-list --all --count`: 0 | throws (by code) |
| DIR-HEAD | HEAD=`ref: refs/heads/d/x`, `d/` mode 000 | warning · `notice: No default references` (no HEAD line), 0; `rev-parse HEAD`: 128 unknown revision | throws; `resolveRef(HEAD)` throws `PERMISSION_DENIED` (`…/d/x`) |
| DIR-HEADS | `refs/heads/` itself mode 000 | `warning: error opening directory '.git/refs/heads/': …` · `notice: No default references`, 0; `--no-references`: notice, 0; `for-each-ref`: empty | throws (`…/refs/heads`) |
| DIR-PK | packed `refs/heads/d/x`; loose `d/` mode 000 holding `d/y` | warning, 0 (**no pointer** for `d/x`); `for-each-ref`: `d/x` (packed value), `main`; `rev-parse refs/heads/d/x`: 128 | throws |
| DIR-CH | `a`=`ref: refs/heads/d/x`, `d/` mode 000 | warning · ptr a, **2**; `--no-references`: ptr a, 2; `for-each-ref`: main | throws |
| DIR-SRCH | `d/` mode 0400 (listable, not searchable) | `warning: failed to stat '.git/refs/heads/d/x': Permission denied` · `refs/heads/d/x: invalid sha1 pointer 0{40}`, **2**; `--no-references`: the pointer, 2; `for-each-ref`, `branch`: `main`, 0; `rev-list --all`: `fatal: bad object refs/heads/d/x`, 128; `show-ref`: 128 | `fsck` throws (`…/d/x`); `listRefs` drops `d/x`; `listRefNames` lists it; `branchList` ok; `revList` throws `PERMISSION_DENIED` |
| DIR-300 | `d/` mode 0300 (searchable, not listable) | as DIR | as DIR (by code) |
| DIR-LINK | `refs/heads/L` → `<B>/outdir`, a mode-000 directory | `warning: refs/heads/L: symlinkRef: …` · `refs/heads/L: badReferentName: points to invalid refname '<RB>/outdir'`, **8** (no directory warning: git's walk does not descend links); `--no-references`: 0; `for-each-ref`: main | throws (`…/refs/heads/L`) |
| DIR-LINK-in | `L` → `real`, `real/` mode 000 under `refs/heads/` | `warning: error opening directory '.git/refs/heads/real/': …` · `symlinkRef` L, 0 | throws (by code) |
| DIR-REFS | `.git/refs` itself mode 000 | `fatal: not a git repository`, 128, for every command | out of scope (discovery, as MH) |

The warning is git's dir-iterator text, not an fsck msg-id: `fsck.<id>` cannot re-type it,
`--strict` leaves it a warning, and it sets no bit. git prints the directory with a
trailing `/`, relative to the gitdir it holds (as `cannot read ref file`).

**Symlinked refs (gap 2).** `b` is a symlink under `refs/heads/`; every row's first line is
`warning: refs/heads/b: symlinkRef: use deprecated symbolic link for symref`. Fixtures also
hold `c` (healthy), `.git/foo/bar` (healthy oid), `<B>/outside` (healthy oid).
tsgit today: `symlinkRef` only, exit 0, unless noted (twin-run on L-REL, L-OUT, L-GITFOO,
L-DIE-mid, L-DIE-refs, L-U000; by code elsewhere).

| Row | Link text | git, after `symlinkRef` | exit |
|---|---|---|---|
| L-REL | `main` | — | 0 |
| L-RELUP | `../heads/main` | — | 0 |
| L-ABS-own | `<B>/repo/.git/refs/heads/main` (own repo, through `/var`) | — | 0 |
| L-ABS-other | `<B>/REL/.git/refs/heads/main` (another repo) | `badReferentName: points to invalid refname '<RB>/REL/.git/refs/heads/main'` | 8 |
| L-DANG | `ghost` (absent) | — (realpath keeps a missing last component: `refs/heads/ghost`, valid; the link is unlisted, so no pointer) | 0 |
| L-DANG-abs | `<B>/nowhere` | `badReferentName … '<RB>/nowhere'` (no pointer) | 8 |
| L-OUT | `<B>/outside` | `badReferentName … '<RB>/outside'` | 8 |
| L-OUTDOTS | `<B>/outside-dots` (holds `ref: x..y`) | `badReferentName … '<RB>/outside-dots'` · ptr b | 10 (tsgit: 0) |
| L-GITFOO | `../../foo/bar` | `warning: … symrefTargetIsNotARef: points to non-ref target 'foo/bar'` | 0 |
| L-GITDOTS | `../../x..y` | `badReferentName … 'x..y'` | 8 |
| L-ROOT | `../../ORIG_HEAD_X` | `badReferentName … 'ORIG_HEAD_X'` | 8 |
| L-WARN | `<B>/outside` holding `x`, `fsck.badReferentName=warn` | `warning: … badReferentName … '<RB>/outside'` · `warning: … symrefTargetIsNotARef … '<RB>/outside'` · ptr b | 2 |
| L-CHAIN | `<B>/hop`, itself a link to own `…/refs/heads/main` | — (realpath follows every hop) | 0 |
| L-ORDER | `z` and `a` both → `<B>/outside` | per ref: `symlinkRef` then `badReferentName`, `z` first | 8 |
| L-U000 | `c`, with `c` mode 000 | `cannot read ref file '.git/refs/heads/c'` (before `symlinkRef` b) · ptr b · ptr c; `--no-references`: ptr b · ptr c, 2 | 10 (tsgit: throws) |
| L-UOUT | `<B>/out000`, a mode-000 file | `badReferentName … '<RB>/out000'` · ptr b; `--no-references`: ptr b, 2 | 10 (tsgit: throws, by code) |
| L-GD | `main`, run as `--git-dir=<B>/GD/.git` (not real) | `badReferentName … '<RB>/GD/.git/refs/heads/main'`; with `--git-dir=<RB>/GD/.git`: — , 0 | 8 / 0 |
| L-DIE-mid | `nodir/x` | `fatal: Invalid path '<RB>/…/.git/refs/heads/nodir': No such file or directory`; `git refs verify` alone: 128 | 8 |
| L-DIE-abs | `<B>/nodir/x` | `fatal: Invalid path '<RB>/nodir': No such file or directory` | 8 |
| L-DIE-refs | `refs/heads/main` (ADR-874's symref link text) | `fatal: Invalid path '<RB>/…/.git/refs/heads/refs': …`. Resolution still reads it as a symref (`symbolic-ref refs/heads/b` → `refs/heads/main`), and `for-each-ref` omits `b` | 8 |
| L-LOOP | `b` (itself) | `fatal: More than 32 nested symlinks on path '.git/refs/heads/b'` | 8 |
| L-DIE-lost | `z` → `nodir/x` (first in readdir), `a`=`garbage`, `refs/tags/t`=`garbage` | `symlinkRef` z · `fatal: Invalid path …` · ptr a · `refs/tags/t:` pointer — **both `badRefContent` lines are lost**; `--no-references`: the two pointers, 2 | 10 |
| ROOTORD | `z` → `nodir/x`, `main`=`<sha>` without LF, HEAD=`ref: refs/heads/main` without LF, `BAR_HEAD`=`garbage` | `symlinkRef` z · `fatal: …` — main's, HEAD's and BAR_HEAD's notices are all lost | 8 |
| ROOTORD2 | `a`=`garbage`, `BAR_HEAD`=`garbage` | `refs/heads/a: badRefContent` · `BAR_HEAD: badRefContent` · ptr a (root refs come after the `refs/` walk) | 10 |

The referent rule as pinned: `realpath(<abs gitdir>/<ref>)`, minus the
`<abs gitdir>/` prefix when it starts with it. `<abs gitdir>` is git's absolute but
**not** resolved gitdir, which equals the realpath under discovery (git chdirs to the top
level, and `getcwd` is physical), so L-GD's non-real `--git-dir` is invocation-dependent and,
like U-gd, stays out of the interop. git runs no body, newline or trailing check on a link.

**Direct-oid grammar, `trailingRefContent`, `refMissingNewline` (gaps 3–5).** Body written
to both `a` and `z`; one line per ref, `z` first. `rp` = `rev-parse --verify -q refs/heads/a`.
The fsck cell reads default `fsck` / `--strict` / `-c fsck.trailingRefContent=error` /
`-c fsck.refMissingNewline=error` where the four differ; `--no-references` keeps the
pointers only. `TR(x)` = `warning: refs/heads/<r>: trailingRefContent: has trailing
garbage: '<x>'` (raw bytes, LF inside the quotes; git prints CR as `?`), `TW` =
`…: trailingRefContent: has trailing whitespaces or newlines`, `NL` = `…: refMissingNewline:
misses LF at the end`, `BC(x)` = `error: …: badRefContent: <x>` + ptr, exit 10 in every
column.

| Row | Body | rp | fsck | tsgit today |
|---|---|---|---|---|
| UP | `<SHA>\n` (upper) | `<sha>` (lower) | — 0 everywhere; `for-each-ref` prints `<sha>` lower | BC + ptr, 10; `resolveRef` `INVALID_REF` |
| MIX | first 20 hex upper | `<sha>` | — 0 everywhere | BC, 10 (by code) |
| UPSPG | `<SHA> garbage\n` | `<sha>` | `TR( garbage\n)` 0 | BC, 10 (by code) |
| GARB | `<sha>garbage\n` | fails | `BC(<sha>garbage)` | matches |
| SPG | `<sha> garbage\n` | `<sha>` | `TR( garbage\n)` 0 / warning 0 / **error 8** / warning 0 | BC + ptr, 10 |
| TABG | `<sha>\tgarbage\n` | `<sha>` | `TR(\tgarbage\n)`, as SPG | BC, 10 (by code) |
| SP2 | `<sha>  \n` | `<sha>` | `TR(  \n)`, as SPG | BC, 10 (by code) |
| SPN | `<sha> \n` | `<sha>` | `TR( \n)`, as SPG | BC + ptr, 10 |
| CRLF | `<sha>\r\n` | `<sha>` | `TR(\r\n)`, as SPG | 0, nothing |
| NN | `<sha>\n\n` | `<sha>` | `TR(\n\n)`, as SPG | 0, nothing (by code) |
| TWO | `<sha>\n<sha>\n` | `<sha>` | `TR(\n<sha>\n)`, as SPG | BC + ptr, 10 |
| H39 | 39 hex `\n` | fails | `BC(<h39>)` | matches (by code) |
| H41 | `<sha>0\n` | fails | `BC(<sha>0)` | matches |
| W64 | 64 hex `\n`, SHA-1 repo | fails | `BC(<64 hex>)` | **resolves** to the 64-char id; `badRefOid` ptr, 2 |
| VT | `<sha>\v\n` | fails | `BC(<sha>?)` | BC, 10 (by code) |
| NOLF | `<sha>` | `<sha>` | `NL` 0 / warning 0 / warning 0 / **error 8** | 0, nothing |
| UPNOLF | `<SHA>` | `<sha>` | `NL`, as NOLF | BC, 10 (by code) |
| SPGNOLF | `<sha> garbage` | `<sha>` | `TR( garbage)` only (no `NL`), as SPG | BC, 10 (by code) |
| EMPTY | empty | fails | `BC()` only (no `NL`) | matches |
| SYMNOLF | `ref: refs/heads/main` | ok | `NL`, as NOLF | 0, nothing |
| SYMSP | `ref: refs/heads/main \n` | ok | `TW`, as SPG | 0, nothing (and `resolveRef` `INVALID_REF`) |
| SYMCRLF | `ref: refs/heads/main\r\n` | ok | `TW` | 0 (by code) |
| SYMNN | `ref: refs/heads/main\n\n` | ok | `TW` | 0 (by code) |
| SYMTABLF | `ref: refs/heads/main\t\n` | — | `TW` | 0 (by code) |
| SYMSPNOLF | `ref: refs/heads/main ` | ok | `NL` only | 0 (by code) |
| SYM2SPNOLF | `ref: refs/heads/main  ` | — | `NL` · `TW` | 0 (by code) |
| SYMG | `ref: refs/heads/main garbage\n` | fails | `badReferentName … 'refs/heads/main garbage'` + ptr, 10 | nothing, 0 (by code) |
| FOO-NOLF | `ref: foo/bar` | — | `NL` · `symrefTargetIsNotARef … 'foo/bar'` · ptr, 2 | — |
| FOO-SP | `ref: foo/bar \n` | — | `TW` · `symrefTargetIsNotARef` · ptr, 2 | — |
| DOTS-NOLF | `ref: x..y` | — | `NL` · `error: badReferentName … 'x..y'` · ptr, 10; with `badReferentName=warn`: `NL` · warning `badReferentName` · `symrefTargetIsNotARef` · ptr, 2 | nothing, 0 (by code) |
| HEADTRAIL | HEAD=`<sha> garbage\n` | `rev-parse HEAD` → `<sha>` | `HEAD: trailingRefContent: has trailing garbage: ' garbage\n'`, 0 | **`fsck` throws** `INVALID_OBJECT_ID`; `resolveRef(HEAD)` throws |
| HEADNOLF | HEAD=`ref: refs/heads/main` | — | `HEAD: refMissingNewline`, 0 | 0, nothing (by code) |
| PKT | a packed ref | — | nothing (packed refs are not body-checked) | matches |

Derived rule (the requirement-7/8 grammar): direct = `hexLength` hex digits of either case,
then end-of-body or SP/HT/CR/LF; the trailer is every byte after the oid. Symref per
ADR-1125; its notices compare the body's length before and after the trailing strip.
Message order per symref body: `refMissingNewline`, `trailingRefContent`,
`badReferentName`, `symrefTargetIsNotARef`.

**Severity and gating (A-garbage `a`→`b` garbage, A-ref-dots `a`→`b`=`ref: x..y`)**

Both `-c fsck.X=Y` and a repo-config `fsck.X Y` were pinned, with the same results.

| Row | Override | garbage shape | dots shape |
|---|---|---|---|
| S1 | `fsck.badRefContent=ignore` | ptr a, b; exit **2** | unchanged; 10 |
| S2 | `fsck.badRefContent=warn` | `warning: … badRefContent: garbage` + pointers; **2** | unchanged; 10 |
| S3 | `fsck.badReferentName=warn` | unchanged; 10 | `warning: … badReferentName …` · `warning: … symrefTargetIsNotARef: points to non-ref target 'x..y'` + pointers; **2** |
| S4 | `fsck.badReferentName=ignore` | unchanged; 10 | `warning: … symrefTargetIsNotARef …` + pointers; 2 |
| S5 | `badReferentName=warn` + `symrefTargetIsNotARef=ignore`, b alone | — | warning badReferentName + ptr b; 2 |
| S6 | `badReferentName=warn` + `--strict`, b alone | — | both stay warnings; 2 |
| S7 | `fsck.badReferentName=warn` on HD | — | `warning: HEAD: badReferentName: …`; 0 |
| S8 | `fsck.symrefTargetIsNotARef=error`, `b`=`ref: foo/bar` alone | — | `error: … symrefTargetIsNotARef …` + ptr b; **10** (`--no-references`: 2) |
| S9 | `fsck.badReferentName=warn`, `b`=`ref: FETCH_HEAD` | — | warning badReferentName · warning symrefTargetIsNotARef · ptr b; 2 |
| N | `--no-references` | ptr a, b; 2 | ptr a, b; 2 (B-with-a: 2) |
| co | `--connectivity-only` | as default | as default |

**Referent grammar.** Body `ref: <R>\n` on `b` alone. "flag" = `badReferentName '<R>'` + ptr
b, 10. "ptr" = ptr b only, 2.

| <R> | git | <R> | git |
|---|---|---|---|
| `foo`, `main`, `refs` | flag | `refs/foo`, `refs/heads/@` | ptr |
| `HEAD` | resolves, 0 | `ORIG_HEAD`, `FOO_HEAD`, `A_HEAD`, `_HEAD`, `FO-O_HEAD`, `BISECT_HEAD` | ptr |
| `FETCH_HEAD`, `MERGE_HEAD` | flag | `FOO1_HEAD`, `Foo_HEAD` | flag |
| `AUTO_MERGE`, `BISECT_EXPECTED_REV`, `MERGE_AUTOSTASH`, `NOTES_MERGE_PARTIAL`, `NOTES_MERGE_REF` | ptr | `refs/heads/x.lock`, `refs/heads/`, `refs/heads/.x`, `refs/heads/a b`, `refs/heads/ma*n`, `@`, empty | flag |
| `refs/heads/x..y`, `x..y` | flag | `refs/heads/main\nextra` | flag, raw LF in the referent |
| `foo/bar` | `symrefTargetIsNotARef` warning + ptr; 2 (also under `--strict`) | `head` | flag, exit 8, no ptr (APFS folds `head` to `HEAD`): excluded as filesystem-dependent |

Root-ref syntax: `[A-Z_-]+` that is `HEAD`, ends in `_HEAD`, or is one of the five irregular
names, and is not `FETCH_HEAD`/`MERGE_HEAD`. Anything else must pass the ref-name format
check with at least two components.

**Symref whitespace (resolution and verify, ADR-1125).**

| Row | Body of `b` | `rev-parse --symbolic-full-name b` | fsck |
|---|---|---|---|
| R1 | `ref:refs/heads/main\n` | `refs/heads/main` | 0 (tsgit: `badRefContent` + ptr, **10**) |
| R2 | `ref:  refs/heads/main\n` | `refs/heads/main` | 0 |
| R3 | `ref:\trefs/heads/main\n` | `refs/heads/main` | 0 |
| R4 | `ref: refs/heads/main \n` | `refs/heads/main` | 0 + `TW` (= SYMSP) |
| R5 | `ref: refs/heads/main\r\n` | `refs/heads/main` | 0 + `TW` |
| V1 | `ref:\vrefs/heads/main\n` (and `\f`) | fails | flag `'?refs/heads/main'`, 10 |
| V3 | `ref: refs/heads/main\v\n` | fails | flag, 10 |
| R6 | `ref: refs/heads/main\nextra\n` | dangling | flag + ptr, 10 |

### 2. The model

```
verifyIntegrity()  [gated: checkReferences]                  snapshot  [never gated]
  one lstat-style walk of refs/** (readdir order,              every listRefNames() name:
  never through a link), then HEAD:                              in listRefs → its oid
    dir, readdir EACCES   → walk fault 'open-directory' (D7)       (absent → pointer)
    symlink               → symlinkRef                           not in listRefs → 0{40}
                            referent = realpath − <gitdir>/        (HEAD excluded)
                              → badReferentName / NotARef*       then every worktree HEAD:
                            realpath fails → refs-verify end (D8)  resolves → its oid
    file, read EACCES     → lstat EACCES → walk fault 'stat' (D7)  fails → skipped
                            lstat ok     → cannotReadRef
    file, body:
      unparseable         → badRefContent
      direct              → refMissingNewline | trailingRefContent(trailer); badRefOid (loose)
      symref              → refMissingNewline, trailingRefContent, badReferentName, NotARef*
  per linked-worktree HEAD: its own file EACCES → cannotReadRef

listing walk (walkRefDir, every consumer): readdir EACCES → skip that directory silently
```

`*` `symrefTargetIsNotARef` is dropped for a ref whose `badReferentName` is graded error
(ADR-1124); the store reports both facts, fsck applies severities and the rule.

The pointer is **resolution**-driven and the notices **grammar**-driven, so they reach
different names (row `head`, L-U000, DIR-SRCH). D3's listing difference is well-defined
only because both listings run the same skip (ADR-1123): a name hidden by an unreadable
directory is in neither (DIR, DIR-CH's `d/x`), a name the walk lists but cannot read is in
`listRefNames` only (DIR-SRCH, B rows).

### 3. Finding shapes (public `FsckFinding`)

`src/application/commands/internal/fsck/types.ts` L50, `bad-ref` arm, one finding per git
line (ADR-1121):

```ts
| {
    readonly type: 'bad-ref';
    readonly ref: RefName;
    readonly msgId: string;
    readonly severity: FsckSeverity;
    readonly target?: ObjectId;
    readonly path?: string;
    readonly reason?: 'PERMISSION_DENIED';
    /** The name a symbolic ref points to, exactly as read — on `badReferentName` and
     *  `symrefTargetIsNotARef`. For a symlinked ref, git's realpath form. Not a `RefName`. */
    readonly referent?: string;          // NEW (ADR-1121)
    /** The bytes after the object name — on a direct body's `trailingRefContent`. */
    readonly trailing?: string;          // NEW (D10 recommendation)
  }
```

| git line | finding |
|---|---|
| `<ref>: badRefContent: <content>` | `{ ref, msgId: 'badRefContent', severity }` (content not carried, ADR-1121) |
| `<ref>: badReferentName: points to invalid refname '<R>'` | `{ ref, msgId: 'badReferentName', severity, referent: R }` |
| `<ref>: symrefTargetIsNotARef: points to non-ref target '<R>'` | `{ ref, msgId: 'symrefTargetIsNotARef', severity, referent: R }` (default `'info'`) |
| `<ref>: trailingRefContent: has trailing garbage: '<T>'` | `{ ref, msgId: 'trailingRefContent', severity, trailing: T }` (default `'info'`) |
| `<ref>: trailingRefContent: has trailing whitespaces or newlines` | `{ ref, msgId: 'trailingRefContent', severity }` (no `trailing`) |
| `<ref>: refMissingNewline: misses LF at the end` | `{ ref, msgId: 'refMissingNewline', severity }` (default `'info'`) |
| `cannot read ref file '<path>': Permission denied` | `{ ref, msgId: 'cannotReadRef', severity: 'error', path, reason: 'PERMISSION_DENIED' }` |
| `<ref>: invalid sha1 pointer <oid>` | `{ ref, msgId: 'badRefOid', severity: 'error', target }` |
| `warning: error opening directory '<dir>/': Permission denied` | **D7** |
| `warning: failed to stat '<path>': Permission denied` | **D7** |
| `fatal: Invalid path '<p>': …` / `fatal: More than 32 nested symlinks …` (child death) | **D8** |

`path` is absolute, as tsgit opened it (ADR-1122). The interop rebuilds git's text as
`path.relative(realpath(workDir), realpath(finding.path))` for a main-repo file (plus a
trailing `/` for a directory) and as `realpath(finding.path)` for a linked-worktree HEAD.
`info` and `warning` render as `warning:`, `error` as `error:`.

**Exit bits** (`exit-codes.ts`, comment only): bit 8 gains `badReferentName` at error,
`cannotReadRef`, a configured-error `symrefTargetIsNotARef`, `trailingRefContent` or
`refMissingNewline`, and (D8) a refs-verify end. Walk faults (D7) set none.

### 4. Parts (pre-chewed for the planner)

Line numbers are on base fb771235. Everything in `ref-store.ts` lives inside
`createRefStore(ctx: Context): RefStore` (L616) unless marked module-level.

**P1 — domain: one loose-body grammar** (gaps 3–5, ADR-1125).
- `src/domain/refs/loose-ref.ts`: new pure `readLooseBody(content: string, hexLength: 40 | 64):
  LooseBody`:
  ```ts
  export type LooseBody =
    | { readonly kind: 'unparseable' }
    | { readonly kind: 'direct'; readonly id: ObjectId; readonly missingNewline: boolean;
        readonly trailing?: string }                 // set only when the trailer is not exactly '\n'
    | { readonly kind: 'symbolic'; readonly referent: string; readonly missingNewline: boolean;
        readonly trailingWhitespace: boolean };      // raw referent, not validated
  ```
  Direct arm: `content.slice(0, hexLength)` all `[0-9a-fA-F]`, `content[hexLength]` absent or
  in SP/HT/CR/LF, `id = ObjectIdFactory.from(hex.toLowerCase())`; trailer `''` →
  `missingNewline`. Symref arm: the ADR-1125 strip; `missingNewline` = last byte is not LF;
  `trailingWhitespace` = more than one byte stripped. Named constants for the whitespace
  class and `ref:`. `ObjectIdFactory.from` (`src/domain/objects/object-id.ts` L42) is
  **unchanged**: lower-casing happens before it, so its accept set for every other caller
  stays.
- `parseLooseRef(content: string): LooseRef` (L18) → `parseLooseRef(content: string,
  hexLength: 40 | 64): LooseRef`, built on `readLooseBody`: `unparseable` / empty referent
  throw `invalidRef` as today; `symbolic` runs `validateRefName(referent)`.
  Callers that change: module-level `fromLooseContent` (ref-store.ts L558), `fromNamedContent`
  (L583) and `fromFollowedContent` (L596) gain `hexLength`; their call sites pass
  `ctx.hashConfig.hexLength` — `resolveHeadDirect` (L784), `resolveDirect` (L948),
  `resolveFollowed` (L813). `src/application/primitives/internal/ref-write-chain.ts` re-reads
  through the store's resolution (L61 comment) and inherits the grammar. Export
  `readLooseBody`/`LooseBody` from `src/domain/refs/index.ts` (L6).
- New `src/domain/refs/symref-referent.ts`: `isValidSymrefReferent(referent: string): boolean`
  (root ref per the pinned syntax, or a `/`-containing name `isSafeRefName` accepts —
  `ref-validation.ts` L67) and `isOutsideRefsNamespace(referent: string): boolean`. Named
  constants for the five irregular root refs and the two pseudorefs.
- Tests: `test/unit/domain/refs/loose-ref.test.ts` (extend with every grammar row);
  new `test/unit/domain/refs/symref-referent.test.ts` (the referent table minus `head`);
  new `loose-ref.properties.test.ts` and `symref-referent.properties.test.ts` (see Test
  strategy).

**P2 — ref store: the listing walk skips an unreadable directory** (gap 1, ADR-1123).
- `walkRefDir(dir: string, prefix: string): Promise<ReadonlyArray<RefName>>` (L969): a
  `PERMISSION_DENIED` from `ctx.fs.readdir(dir)` returns `[]`; every other code rethrows.
  This reaches `walkRefsRoot` (L1038, the root itself: DIR-HEADS) → `walkAllLooseRefNames`
  (L1067) → `collectCandidateNames` (L1087) / `listRefNames` (L1142) / `listRefs` (L1128) /
  `packableEntries` (L1986, `packRefs` L2094). A symlinked directory goes through
  `followedEntryKind` (L957) → `walkRefDir`, so DIR-LINK skips the same way.
- Consumers (reference search on `listRefs`/`listRefNames`/`enumerateRefs`), each inheriting
  the skip: `commands/branch.ts` L114 (`branchList`), `commands/tag.ts` L76,
  `commands/fetch.ts` L520/L639/L790, `commands/internal/local-push-refs.ts` L27,
  `commands/internal/rebase-merges-todo.ts` L30, `commands/internal/fsck/refs-verify.ts`
  L237, `primitives/enumerate-refs.ts` L17 → `enumerateRefs` in `bundle-create.ts`,
  `describe.ts`, `internal/commit-message-search.ts`, `internal/fsck/packed-ref-tips.ts`,
  `internal/fsck/roots.ts`, `name-rev.ts`, `push.ts`, `reflog.ts`, `remote.ts`,
  `rev-list.ts` L103, `primitives/internal/commit-graph-compatible.ts`,
  `primitives/internal/ref-decorations.ts`, `primitives/write-commit-graph.ts`
  (all under `src/application/`).
- Tests: `test/unit/application/primitives/ref-store.test.ts` (`listRefs`/`listRefNames`
  blocks) with `vi.spyOn(ctx.fs, 'readdir')` throwing `permissionDenied(path)` for one
  directory, each position (first, last, nested, root `refs/heads`, under a link), plus an
  isolated test that a non-permission fault propagates; `enumerate-refs.test.ts`,
  `branch.test.ts`, `rev-list.test.ts`, `tag.test.ts` one row each.

**P3 — ref store: the integrity walk** (gaps 1, 2, 4, 5; ADRs 1121, 1122, 1124).
- `RefIntegrityFinding` (ref-store.ts L229) becomes:
  ```ts
  | { readonly ref: RefName; readonly msgId: 'badRefContent' | 'symlinkRef' | 'refMissingNewline' }
  | { readonly ref: RefName; readonly msgId: 'badRefOid'; readonly target: ObjectId }
  | { readonly ref: RefName; readonly msgId: 'badReferentName' | 'symrefTargetIsNotARef';
      readonly referent: string }
  | { readonly ref: RefName; readonly msgId: 'trailingRefContent'; readonly trailing?: string }
  | { readonly ref: RefName; readonly msgId: 'cannotReadRef'; readonly path: string;
      readonly reason: 'PERMISSION_DENIED' }
  | { readonly walkFault: 'open-directory' | 'stat'; readonly path: string }   // D7 input
  | { readonly ref: RefName; readonly verifyEnd: 'FILE_NOT_FOUND' | 'SYMLINK_LOOP';
      readonly path: string }                                                // D8 input
  | { readonly table: string; readonly msgId: 'badReftableTable'; readonly check: ReftableCheck }
  ```
  `throughSymlink` goes: the new walk never reads through a link, which is git's walk, so
  nothing under a link is ever body-checked; the pointer for such a name comes from the
  snapshot (P4). Its readers: refs-verify.ts L109, ref-store.ts L1182–L1204,
  `ref-store.test.ts` (five assertions).
- Replace `walkLinkedRefNames` (L1149), `linkedRefNames` (L1164), `readThroughLink` (L1196)
  and the loop in `verifyIntegrity` (L1199) with one `walkIntegrity(dir, prefix)` over
  `refsWalkRoots()` (L1019): per `readdir` entry, in order — a symlink → `symlinkRef` then
  `linkReferentFindings(name, path)`; a directory → recurse (its `readdir`
  `PERMISSION_DENIED` → `{ walkFault: 'open-directory', path: dir }`); otherwise
  `looseBodyFindings(name)`. `HEAD` is checked after the walk (ROOTORD2).
- `looseBodyFinding` (L1180) → `looseBodyFindings(name): Promise<ReadonlyArray<…>>`: reads via
  `readLooseContent` (L755); on `PERMISSION_DENIED` it `ctx.fs.lstat`s the path — `lstat`
  `PERMISSION_DENIED` → `{ walkFault: 'stat', path }` (DIR-SRCH), else `cannotReadRef` with
  `path = looseRefPath(refDir(name), name)`. The fault-free path pays no extra call. Then
  `readLooseBody(raw, ctx.hashConfig.hexLength)`: `unparseable` → `badRefContent`; `direct` →
  `refMissingNewline` / `trailingRefContent { trailing }`, then the loose-object probe as
  today with the lower-cased id (`badRefOid`); `symbolic` → `refMissingNewline`,
  `trailingRefContent`, then `isValidSymrefReferent` / `isOutsideRefsNamespace` facts. Order
  inside one ref is git's (Derived rule). `LOOSE_OID_RE` (L550) and the local
  `SYMBOLIC_PREFIX` (L548) are deleted.
- `linkReferentFindings(name, path)`: `referent = linkReferent(realpathOf(path),
  realpathOf(ctx.layout.gitDir))` — D9 decides how `realpathOf` is computed; a failure (a
  missing non-final component, more than 32 hops) yields `verifyEnd` and **ends the walk**
  under D8's recommendation. Then the two referent facts; no body or newline facts.
- `reftable-ref-store.ts` `verifyIntegrity` (L267): unchanged.
- Tests: `ref-store.test.ts` `verifyIntegrity` block (L2657) — each new arm, each walk
  fault, readdir order kept, HEAD last, spies on `readUtf8`/`lstat`/`readdir` throwing
  `permissionDenied(path)` (pattern: `fsck-worktree-heads.test.ts` L240) and a plain
  `Error('EIO')` that propagates; `ref-store-symlinked-refs.test.ts` for the referent rows.

**P4 — refs-verify: snapshot and notices** (`src/application/commands/internal/fsck/refs-verify.ts`).
- `snapshotTargets(ctx, entries)` (L161) gains `names = refStore.listRefNames()`; a name absent
  from `entries`, not `HEAD`, gets `{ ref, id: zeroOid }`; merged in `compareRefNames` order
  (ADR-1123). U-shadow and DIR-PK hold by construction (`listRefs` L1131–L1136).
- `targetOf` (L142): `UNREADABLE_REF_CODES` (resolve-ref.ts L28) + `REF_NOT_FOUND` +
  `PERMISSION_DENIED` → zero oid, as a named fsck-local set; everything else rethrows; the
  `isTolerableRefFault` branch goes and the return type is `ObjectId`.
- `collectBadContentNotices` (L97) → a content-notices collector over the P3 arms:
  `badRefContent`/`badReferentName` (base error), `symrefTargetIsNotARef`/`trailingRefContent`/
  `refMissingNewline` (base info) through `retypeSeverity`; `cannotReadRef` error, not
  re-typed; the ADR-1124 early-return rule; the synthesised pointer is dropped. All gated by
  `checkContentFormat`; bit 8 for each error-graded notice. Walk faults map to D7's shape,
  gated, no bit; `verifyEnd` maps to D8's shape, gated, bit 8.
- `collectSymlinkNotices` (L64): unchanged except it reads the new union.
- `collectAbsentTargets` (L186) gains `checkContentFormat: boolean`: worktree-HEAD
  `cannotReadRef` only when it holds (ADR-1122).
- `runRefsVerifyPass` (L226) adds `listRefNames()` to its `Promise.all`; public signature
  unchanged; doc comment rewritten.

**P5 — roots: a HEAD whose target is unreadable** (`roots.ts` `headOf`, L897).
`PERMISSION_DENIED` maps to `{ kind: 'unreadable', path }` only when `err.data.path ===
\`${worktreeCtx.layout.gitDir}/HEAD\``; any other one → `NO_HEAD` (HU, DIR-HEAD). Callers:
refs-verify and `worktreeHeads` (L975). Test: `fsck-worktree-heads.test.ts` next to L249.

**P6 — the pin in tension** (`fsck-symbolic-ref-fault.test.ts`): the permission row becomes
a zero pointer and exit 2 (the fault is synthetic, the file readable, so no
`cannotReadRef`); a new row keeps propagation for `new Error('EIO: i/o error')`, mirroring
`fsck-worktree-heads.test.ts` L276.

**P7 — public types and docs.**
- `types.ts` L50: `referent?`, `trailing?` (D10), the D7 and D8 shapes.
- `docs/use/commands/fsck.md`: `bad-ref` row (L155) gains `referent?`, `trailing?` and the
  new msgIds; the D7/D8 rows; the exit table (L259). `exit-codes.ts` bit-8 comment.
  `docs/design/fsck.md` msg-id table unchanged (already right).
- `docs/BACKLOG.md` L687 (32.39) is delivered here.

**P8 — interop.**
- New `test/integration/fsck-broken-ref-chain-interop.test.ts` (kept out of the 4423-line
  `fsck-interop.test.ts`): one table-driven `describe.each` per matrix group above; roots
  via `realpathSync(mkdtempSync(…))`; `runGit`/`tryRunGitWithExit`/`SAFE_ENV`; permission and
  symlink rows guarded by `process.platform !== 'win32' && process.getuid?.() !== 0`, as
  `alternates-interop.test.ts` L51. Each row asserts exit-code equality, content and walk
  lines as a sorted multiset, pointer lines in sequence, all rebuilt from findings. Seeds
  first-and-last (lesson 022).
- Line rebuilders in `test/integration/fsck-line-helpers.ts`: `refLine(f)` per msgId,
  `walkFaultLine(f)` (D7), and the `fatal:` line for D8.
- Resolution rows (UP, MIX, SPG, TABG, SPN, CRLF, NN, TWO, NOLF, GARB, H39, H41, W64, VT,
  HEADTRAIL, R1–R6): `test/integration/loose-ref-interop.test.ts`, comparing `rev-parse` with
  `resolveRef`.
- Listing rows (DIR, DIR-AZ, DIR-N, DIR-T, DIR-ONLY, DIR-HEADS, DIR-PK, DIR-SRCH):
  `test/integration/ref-listing-interop.test.ts` — `for-each-ref` ↔ `listRefs`, `branch` ↔
  `branchList`, `rev-list --all --count` ↔ `revList` (DIR-SRCH: refusal on both),
  `pack-refs --all` ↔ `packRefs` (packed-refs bytes).

### 5. Edge behaviour

- A packed ref is never in the broken set and is never body-checked (PKT). A walked name
  never yields the `blocked` leaf (`NOT_A_DIRECTORY`, L862): it came from a `readdir`.
- An unreadable directory that is the only thing under `refs/heads/` (DIR-ONLY) or is
  `refs/heads/` itself (DIR-HEADS): the snapshot is empty, so `no-default-references` fires
  (`findings.length === targets.length`, refs-verify.ts L203), as git prints it.
- An unreadable directory reached through a link (DIR-LINK) is skipped by the listing walk and
  never visited by the integrity walk, so it yields no walk fault — git's line set.
- A link whose target is an unreadable file (L-U000, L-UOUT): the link gets `symlinkRef`
  and its referent facts; the file's own `cannotReadRef` comes from the file's own walk entry
  (L-U000) or not at all (L-UOUT, outside `refs/`); the pointer comes from the snapshot.
- An unreadable `.git/refs`: git refuses discovery (DIR-REFS); the walk skip would let tsgit
  continue, which is the open path's concern, not this change's (Out of scope).
- `connectivityOnly` / `--no-full` / promisor: the zero oid is never held or promised, so the
  pointer always stands.
- Assumption, guarded by the unit table only: `isSafeRefName` agrees with git's
  `check_refname_format(…, 0)` on two-plus-component names.
- Assumption: Node's `fs.readdir` returns the OS order unsorted, as git's `readdir` does, so
  D8's lost-line set matches on the same filesystem (Linux CI included); the memory adapter's
  order is the unit tests' only.
- Assumption, unpinned: for a linked worktree, git's link referent strips the worktree's
  own gitdir; P3 uses `ctx.layout.gitDir`, which is that dir. No row exercises a symlinked
  per-worktree ref.

## Decision candidates

| # | Choice | Status / alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| D1 | Finding shape per git line | decided — ADR-1121 | — | — |
| D2 | Unreadable ref file | decided — ADR-1122 | — | — |
| D3 | Broken names for the snapshot | decided — ADR-1123 (needs P2's skip) | — | — |
| D4 | `symrefTargetIsNotARef` | decided — ADR-1124 | — | — |
| D5 | Loose-body grammar | decided — ADR-1125 (direct arm per ADR-1126) | — | — |
| D6 | Fold the five gaps | decided — ADR-1126. **Its §2 wording needs amending**: the pins (L-OUT, L-ABS-other, L-GITFOO, L-DIE-refs) show git's referent is the link's realpath relative to the gitdir, not the link text; this design follows the pins. | — | — |
| D7 | Shape of git's two walk warnings (`error opening directory '<dir>/'`, `failed to stat '<path>'`); neither is a msg-id, git exits 0 | (a) a new `FsckFinding` arm `{ type: 'unreadable-ref-path'; path: string; operation: 'open-directory' \| 'stat'; reason: 'PERMISSION_DENIED' }`, no exit bit, gated by `checkReferences`. (b) the `bad-ref` arm with a tsgit-invented msgId (`cannotOpenRefDir`/`cannotStatRef`), `ref` = the directory's ref-path name, severity `'warning'`. (c) reuse `cannotReadRef` at `'warning'` with an `operation` discriminant. | (a) | (b) puts non-catalogue ids beside git's in a field every consumer filters as git's msgId, lets `fsck.<id>` config appear to re-type them, and needs a `RefName` for a directory. (c) overloads a fixed-error git message with a warning that has different text and no bit. (a) follows the path-keyed arms' precedent (`pack-inaccessible`) and keeps `bad-ref` git's catalogue. Either way DIR-SRCH refines ADR-1122: a read fault whose `lstat` also fails is git's `failed to stat`, not `cannotReadRef`. Exit bit: none in every option (git exits 0). |
| D8 | git's `refs verify` child dies on a link whose realpath fails (L-DIE-*, L-LOOP): fsck gets bit 8 and loses every check after it, root refs included | (a) faithful: one terminal finding `{ type: 'refs-verify-ended'; ref; path; reason: 'FILE_NOT_FOUND' \| 'SYMLINK_LOOP' }`, gated, bit 8, and the integrity walk stops there (later content findings dropped, pointers kept). (b) the same finding, but the walk carries on: an ADR diverges on the lost lines. (c) no finding: `symlinkRef` alone, exit 0, under an ADR that diverges. | (a) | git's lost lines follow readdir order, and tsgit's walk uses the same `readdir` order on the same filesystem, so (a) reproduces them (L-DIE-lost, ROOTORD). (b) and (c) need a divergence ADR for a reachable shape (ADR-874's own `refs/…` link text dies: L-DIE-refs). Lesson 017 is not engaged: the parent process does not crash, it reports and exits 8. |
| D9 | How the store computes git's realpath referent | (a) a userland resolver in `src/application/primitives/internal/` over `lstat` + `readlink`: per component, at most 32 hops, a missing final component kept, a missing earlier one → `FILE_NOT_FOUND`; the gitdir resolved by the same function. (b) an optional `realpath` on the `FileSystem` port (node: `fs.promises.realpath`; memory/browser: absent → no referent check). (c) lexical normalisation of the link text against the link's directory. | (a) | (b) widens the port and leaves memory/browser without the check, and Node's `realpath` refuses a missing final component that git keeps (L-DANG). (c) misreads every path with a linked component (`/var` → `/private/var` on macOS: L-OUT, L-ABS-own) and never sees L-CHAIN's hops. (a) runs on every adapter with `readlink` and costs nothing on a repo with no symlinked refs. |
| D10 | Carrying `trailingRefContent`'s trailer | (a) `trailing?: string` on the `bad-ref` arm, present on the direct-body variant only; its absence marks git's whitespace variant. (b) no field: the interop takes the trailer from the fixture, as `badRefContent`'s content today. (c) `trailing?` plus an explicit `form: 'direct' \| 'symbolic'`. | (a) | git prints the trailer, and a caller cannot recover it by resolving: the ref resolves fine. (a) mirrors ADR-1121's `referent?`, one optional datum per msgId. (c) adds a field whose value is already implied. (b) hides data, against ADR-249's "ship the fields". |

## Test strategy

- **Interop (P8)**: every matrix row except HD2, MH, DIR-REFS, `head`, L-GD and U-gd
  (invocation- or filesystem-dependent). Permission and symlink rows POSIX non-root only.
  Lesson 015 / ADR-1126: P1 changes resolution for every command and P2 changes every
  listing, so the gate runs every `fsck*-interop` suite plus the `loose-ref`, `ref-listing`,
  `packed-refs`, `pack-refs`, `symbolic-ref`, `head-symlink`, `ref-symlinked-directory`,
  `ref-transaction`, `ref-write-verification`, `symref-write-depth`, `branch-*`, `tag-*`,
  `rev-list-objects`, `log`, `describe`, `name-rev`, `bundle`, `fetch-tracking-refs`,
  `push-tracking-refs`, `rebase-merges`, `reftable-ref-storage`, `alternates-gc-fsck`,
  `midx-fsck` and `rev-bitmap-fsck` interop suites.
- **Unit**: through `fsck` on the memory adapter with `readUtf8`/`lstat`/`readdir` spies:
  each walk fault, each new arm, the early-return rule, `checkContentFormat` off, each
  severity value per msgId, `--strict` not upgrading any of them, the D8 stop (a finding
  after the dying link is absent). Guard clauses get isolated tests; error data asserted
  through try/catch on `.data`.
- **Properties**:
  - `loose-ref.properties.test.ts`: round-trip (`serializeSymbolicRef`/`serializeDirectRef`
    → `readLooseBody` is the identity, `missingNewline` false, no trailer); symref
    whitespace insensitivity (any SP/HT/CR/LF run after `ref:` and at the end gives the
    same referent); **direct case insensitivity** (any case mix of a valid hex gives the
    lower-case id); **trailer lens** (oid + a trailer starting with SP/HT/CR/LF keeps the id,
    and `trailing` equals the trailer unless it is exactly `\n`; a trailer starting with any
    other byte is `unparseable`); **newline lens** (`missingNewline` iff the last byte is not
    LF, on both arms).
  - `symref-referent.properties.test.ts`: every `refs/<a>/<b>` of safe components is valid;
    every `[A-Z_-]+_HEAD` but the two pseudorefs is a root ref.
  - The D9 resolver, if extracted: a lexical chain of links resolves to the same path as
    following them one by one (memory adapter).
- **Mutation** (narrowed buckets, eponymous suites): `loose-ref` (grammar), `symref-referent`,
  `ref-store` walk slice (`walkRefDir`, `walkRefsRoot`), `ref-store` integrity slice
  (`walkIntegrity`, `looseBodyFindings`, `linkReferentFindings`), the D9 resolver module,
  `refs-verify`, `roots` (`headOf`). `targetOf`'s removed branch must not come back as an
  equivalent survivor.

## Out of scope

- **HD2 / MH / DIR-REFS**: an invalid or unreadable main `.git/HEAD`, or an unreadable
  `.git/refs`: git refuses discovery (128). The repository-open surface.
- **`head` (lower case)** on a case-folding filesystem: filesystem-dependent.
- **The `?` rendering** of control bytes (CR, VT) in git's lines: display only (ADR-249).
- **`badRefContent`'s content field**: a symmetric follow-up (ADR-1121).
- **Root refs other than `HEAD`** (`ORIG_HEAD`, `*_HEAD`) in the content walk, and
  **resolution through an unreadable directory** (DIR-HEAD's `rev-parse`, DIR-PK,
  DIR-SRCH's `rev-list --all`): pinned divergences outside ADR-1126's five; reported to the
  caller with their proof, not folded here.
