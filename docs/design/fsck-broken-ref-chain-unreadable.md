# Design — fsck refs with a broken chain or an unreadable file

> Brief: `fsck`'s refs pass reports what git 2.56 reports for a ref whose chain
> ends on a broken or unreadable ref file. That means `badRefContent` or
> `badReferentName` on the broken referent, `cannot read ref file` on an
> unreadable one, and one `invalid sha1 pointer 0000…` on **every** ref of the
> chain. The run carries on and exits with git's bits instead of throwing
> `PERMISSION_DENIED`. Backlog 32.18, plus the adjacent shapes pinned below.
> Status: draft → self-reviewed ×3 → ready for decisions (ADR phase)

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
- **Why the brief's rows fail.** Each one is traced to code by the tsgit twin probes below.
  1. `listRefs` drops every name whose `resolveDirect` throws a `TsgitError`
     (`resolveEntry`, ref-store.ts L1105). A `ref: x..y` referent, an unreadable file, and
     garbage all disappear from the snapshot. Garbage alone gets its pointer back through
     the synthesised one.
  2. `targetOf` (refs-verify.ts L142) maps only `REF_NOT_FOUND`, cycle and depth to the zero
     oid. A chain that hits `INVALID_REF` (garbage or an invalid referent) is "tolerable",
     so `a` gets **no** pointer. A chain that hits `PERMISSION_DENIED` rethrows.
  3. `verifyIntegrity` → `looseBodyFinding` → `readLooseContent` (ref-store.ts L755)
     rethrows `PERMISSION_DENIED`. That is the throw in the B rows: it fires before the
     snapshot runs.
  4. `looseBodyFinding` treats any `ref: ` line as healthy and never checks the referent, so
     `badReferentName` is never produced.
- **The `cannotReadRef` precedent.** `UnreadableHead` (roots.ts L884) and
  `unreadableHeadFinding` (refs-verify.ts L173) already report an unreadable
  **linked-worktree HEAD** as a `bad-ref` finding `{ msgId: 'cannotReadRef', path, reason:
  'PERMISSION_DENIED' }` with bit 8. It is pinned in
  `test/unit/application/commands/fsck-worktree-heads.test.ts` (L249). `path` holds the
  absolute file path tsgit opened. `FsckFinding`'s `bad-ref` arm (`types.ts` L50) already
  carries `path?` and `reason?`.
- **Pins in tension.** `test/unit/application/commands/fsck-symbolic-ref-fault.test.ts`
  requires a `PERMISSION_DENIED` on a symref chain read to **propagate**. git 2.56 instead
  reports the chain broken (zero pointer) and exits 10 (B-with-a below). ADR-1116 chose
  **refusal** for an unreadable loose *object* under `--connectivity-only`, because git dies
  there with exit 128. On the *ref* surface git reports and continues in every mode,
  `--connectivity-only` included (row U-co). The two rules do not conflict: they are
  different git code paths (the odb loose-object reader versus the files ref backend's
  read-and-report).
- **Governing docs.** `docs/design/fsck.md` (msg-id table L362/L370, which lists
  `badReferentName` ERROR/bit 8 and `symrefTargetIsNotARef` INFO/bit 0),
  `docs/use/commands/fsck.md` (`bad-ref` row L155, exit table L259), ADR-874 (symlinked
  refs), ADR-1072 (`UNREADABLE_REF_CODES`), ADR-1116. Lessons 005 (a pinned row the design
  expects to pass is a probe, not a guard), 015 (a shared command-path change runs the
  command's whole interop family) and 017 (a kill test never pins a crash git does not
  have).

### How the values below were pinned

Every probe ran in a `mktemp -d` throwaway under `bash` with `set -euo pipefail` and
`env -i PATH=… HOME=<B>/home GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=<B>/gitconfig`, where
that gitconfig holds only `[user]`. Every git call passed `-c commit.gpgsign=false -c
gc.auto=0`. Each repo is `git init -b main` with one commit, and every ref is a loose file
under `.git/refs/heads/` unless the row says otherwise. Oracle: **git 2.56.0**
(the Homebrew build, macOS, APFS). `<B>` is the throwaway root and `0{40}` is the
40-char zero oid. The "tsgit" column is `fsck(createNodeContext({ workDir }))` on `main`
071d8e48, run on the same directories. The B rows were run twice with the same result.

## Requirements

1. **Chain pointer.** Every listed ref (loose or packed, HEAD excluded) whose resolution
   fails reports `bad-ref badRefOid` with `target` = the zero oid, contributing bit 2. The
   failure can be at any depth of its own chain: a missing end, a cycle or over-depth, a
   referent naming no valid ref, unparseable content, or an unreadable file. That covers
   `a`, `b` and `c` in every A, B and chain row.
2. **`badReferentName`.** A loose ref (`HEAD` included) whose body is a symref to a name
   git's referent check rejects reports `bad-ref badReferentName` with the raw `referent`.
   The check is gated by `checkReferences`, its severity is `fsck.badReferentName`
   (default error), and at error it contributes bit 8. Under D4(a), a symref whose
   referent is outside `refs/` and is not a root ref also reports `bad-ref
   symrefTargetIsNotARef` (default info, no bit; a configured error gives bit 8, row S8).
   It is dropped when that ref's `badReferentName` is graded error.
3. **`cannotReadRef`.** A loose ref file the refs pass cannot read for permission reports
   `bad-ref cannotReadRef` with `path` and `reason: 'PERMISSION_DENIED'`. It is gated by
   `checkReferences`, it is not re-typeable by any `fsck.<msg-id>`, it is always error, and
   it contributes bit 8. The run never throws `PERMISSION_DENIED` from the refs pass.
   Unclassified read faults (EIO, …) still propagate.
4. **Linked-worktree HEAD, folded.** The existing worktree-HEAD `cannotReadRef` becomes
   gated by `checkReferences`: git under `--no-references` prints nothing and exits 0, while
   tsgit reports it today (row W-nr). It also fires only when the HEAD **file itself** is
   unreadable. A HEAD whose *target* is unreadable is skipped silently (row HU).
5. **Severity overrides.** These follow the S rows: `fsck.badRefContent` and
   `fsck.badReferentName` re-type only their own line, and only that line's bit 8. The
   pointer lines and bit 2 never change. `--strict` upgrades neither the pointer nor
   `cannotReadRef`.
6. **`--no-references`** drops every content line (`badRefContent`, `badReferentName`,
   `cannotReadRef`, `symrefTargetIsNotARef`) and keeps every pointer (rows N-*).
   **`--connectivity-only`** changes nothing on this surface (rows *-co).
7. **Symref grammar.** git reads a loose ref by stripping trailing SP/HT/CR/LF, then reading
   `ref:` followed by any run of SP/HT/CR/LF. tsgit's `parseLooseRef` and `looseBodyFinding`
   must read the same way (rows G10, G19–G22, R1–R5). Without this, requirement 1 would
   turn today's coincidental exit 0 on `ref: refs/heads/main \n` into a spurious exit 2.
8. **Order.** Content notices come first, in the store's walk order. Then come the
   worktree-HEAD `cannotReadRef` notices, then every pointer in byte-wise ref-name order
   followed by the worktree HEADs' own pointers, and last `no-default-references`. git
   prints its content lines in readdir order (row ORD: `z` before `a`), so the interop
   compares content lines as a sorted multiset and pointer lines in sequence.
9. A `--no-references` run, a `connectivityOnly` run and a reftable repository behave as
   today on every shape outside this matrix.

## Design

### 1. Pinned matrix (git 2.56.0)

Lines are git's stderr in order. A line starting `warning:` is noted; every other line is
`error:`.

**Chains (brief A rows and adjacent shapes)**

| Row | Shape | git stderr | git exit | tsgit today |
|---|---|---|---|---|
| A-garbage | `a`→`b`, `b`=`garbage\n` | `refs/heads/b: badRefContent: garbage` · `refs/heads/a: invalid sha1 pointer 0{40}` · `refs/heads/b: invalid sha1 pointer 0{40}` | 10 | b content + b pointer, **no a**, 10 |
| A-abc | `b`=`abc\n` | same, with `badRefContent: abc` | 10 | no a, 10 |
| A-empty | `b`=empty | same, with `badRefContent: ` (trailing space) | 10 | no a, 10 |
| A-ref-dots | `b`=`ref: x..y\n` | `refs/heads/b: badReferentName: points to invalid refname 'x..y'` + a and b pointers | 10 | **nothing, 0** |
| CH3 | `a`→`b`→`c`, `c` garbage | c `badRefContent` + a, b, c pointers | 10 | c only, 10 |
| CH3-dots | `a`→`b`→`c`, `c`=`ref: x..y` | c `badReferentName` + a, b, c pointers | 10 | nothing, 0 |
| DA | `b`=`ref: x..y`, no `a` | b `badReferentName` + b pointer | 10 | nothing, 0 |
| ORDER | `z`→`b`, `b` garbage | b `badRefContent` · b pointer · z pointer | 10 | no z, 10 |
| HT | HEAD→`main`, `main` garbage, only ref | main `badRefContent` · main pointer · `notice: No default references` | 10 | matches |
| HC | HEAD→`main`→`b`, `b` garbage, healthy `keep` | b `badRefContent` · b pointer · main pointer (**no HEAD line**) | 10 | no main, 10 |
| PK-ok | loose `a`→packed `main` | — | 0 | matches |
| PK-abs | loose `a`→packed `b` = `1111…` (sorted packed-refs) | `refs/heads/a: invalid sha1 pointer 1111…` · same for b | 2 | matches |
| HD | HEAD=`ref: refs/heads/x..y` | `HEAD: badReferentName: points to invalid refname 'refs/heads/x..y'` (**no HEAD pointer**) | 8 | nothing, 0 |
| HD2 | HEAD=`ref: x..y` | `fatal: not a git repository …` | 128 | out of scope (discovery) |
| C-dangling | `a`→`b`, `b` absent | a pointer only | 2 | matches |

**Unreadable files (brief B rows and adjacent shapes)**

| Row | Shape | git stderr | git exit | tsgit today |
|---|---|---|---|---|
| B-with-a | `b`=HEAD sha, mode 000, `a`→`b` | `cannot read ref file '.git/refs/heads/b': Permission denied` · a pointer · b pointer | 10 | **throws** |
| B-alone | same, no `a` | cannot-read b · b pointer | 10 | throws |
| ORD-U | `z`→`b` unreadable, healthy `c` | cannot-read b · b pointer · z pointer | 10 | throws |
| TAG | `refs/tags/t` mode 000 | `cannot read ref file '.git/refs/tags/t': …` · `refs/tags/t:` pointer | 10 | throws |
| U-sym | `a`=`ref: refs/heads/main`, mode 000 | cannot-read a · a pointer | 10 | throws |
| U-shadow | loose `b` mode 000 shadowing a packed `b` | cannot-read b · b pointer **0{40}** (the packed value is not used) | 10 | throws |
| U-only | `main` mode 000, the only ref | cannot-read main · main pointer · `notice: No default references` | 10 | throws |
| HU | HEAD→`main` mode 000, healthy `keep` | cannot-read main · main pointer (no HEAD line) | 10 | throws |
| HU-nr | HU, `--no-references` | main pointer | 2 | throws |
| U-sev | B-alone, `-c fsck.badRefContent=ignore -c fsck.badRefOid=ignore` | unchanged | 10 | throws |
| U-strict | B-alone, `--strict` | unchanged | 10 | throws |
| U-sub | B-alone, run from `<repo>/sub` or `-C <repo>` | path printed `.git/refs/heads/b` | 10 | throws |
| U-gd | B-alone, `--git-dir=<B>/…/.git` (absolute) | path printed `<B>/…/.git/refs/heads/b` | 10 | throws |
| W | linked worktree HEAD mode 000, run from main | `cannot read ref file '/private<B>/wt/.git/worktrees/wt-linked/HEAD': …` | 8 | matches (path is `<B>/…`, not realpath) |
| W-nr | W, `--no-references` | — | **0** | **cannotReadRef, 8** |
| MH | main `.git/HEAD` mode 000, run from main | `fatal: not a git repository` | 128 | out of scope |
| MH-l | the same repo, run from the linked worktree | `cannot read ref file '/private<B>/mh/.git/HEAD': …` | 8 | not run |
| ORD | `z` mode 000, `a` garbage, linked HEAD mode 000 (created main, z, a) | cannot-read z · a `badRefContent` · cannot-read linked HEAD · a pointer · z pointer | 10 | throws |

git prints the path as `<gitdir as git holds it>/<ref>`: relative `.git` once it has
chdir'd to the top level, absolute under an absolute `--git-dir`, and the realpath for a
linked worktree's admin dir.

**Severity and gating (A-garbage shape `a`→`b` garbage, and A-ref-dots shape `a`→`b`=`ref: x..y`)**

The same results hold for `-c fsck.X=Y` and for a repo-config `fsck.X Y`; both were pinned.

| Row | Override | garbage shape | dots shape |
|---|---|---|---|
| S1 | `fsck.badRefContent=ignore` | a, b pointers; exit **2** | unchanged; 10 |
| S2 | `fsck.badRefContent=warn` | `warning: … badRefContent: garbage` + pointers; exit **2** | unchanged; 10 |
| S3 | `fsck.badReferentName=warn` | unchanged; 10 | `warning: … badReferentName: …'x..y'` · `warning: refs/heads/b: symrefTargetIsNotARef: points to non-ref target 'x..y'` + pointers; exit **2** |
| S4 | `fsck.badReferentName=ignore` | unchanged; 10 | `warning: … symrefTargetIsNotARef: …'x..y'` + pointers; exit 2 |
| S5 | `badReferentName=warn` + `symrefTargetIsNotARef=ignore`, b alone | — | warning badReferentName + b pointer; 2 |
| S6 | `badReferentName=warn` + `--strict`, b alone | — | both warnings stay warnings; 2 |
| S7 | `fsck.badReferentName=warn` on HD | — | `warning: HEAD: badReferentName: …`; exit 0 |
| S8 | `fsck.symrefTargetIsNotARef=error`, `b`=`ref: foo/bar` alone | — | `error: … symrefTargetIsNotARef: …'foo/bar'` + b pointer; exit **10** (`--no-references`: pointer only, 2) |
| S9 | `fsck.badReferentName=warn`, `b`=`ref: FETCH_HEAD` alone | — | warning badReferentName · warning symrefTargetIsNotARef · b pointer; 2 |
| N | `--no-references` | a, b pointers; 2 | a, b pointers; 2 (and B-with-a: a, b pointers; 2) |
| co | `--connectivity-only` | as default; 10 | as default; 10 (and B-with-a as default; 10) |

tsgit today: S1 and S2 match on b but drop a. S3, S4 and S7 report nothing and exit 0.
N-dots exits 0 and N-unread throws. co matches the default (equally wrong).

**Referent grammar.** Body `ref: <R>\n` on `b`, nothing else in the repo. "flag" means
`badReferentName` with `'<R>'` + b pointer, exit 10. "ptr" means b pointer only, exit 2.

| <R> | git | <R> | git |
|---|---|---|---|
| `foo`, `main`, `refs` | flag | `refs/foo`, `refs/heads/@` | ptr (format OK, absent) |
| `HEAD` | — (resolves), 0 | `ORIG_HEAD`, `FOO_HEAD`, `A_HEAD`, `_HEAD`, `FO-O_HEAD`, `BISECT_HEAD` | ptr |
| `FETCH_HEAD`, `MERGE_HEAD` (pseudorefs) | flag | `FOO1_HEAD`, `Foo_HEAD` (not root-ref syntax) | flag |
| `AUTO_MERGE`, `BISECT_EXPECTED_REV`, `MERGE_AUTOSTASH`, `NOTES_MERGE_PARTIAL`, `NOTES_MERGE_REF` | ptr | `refs/heads/x.lock`, `refs/heads/`, `refs/heads/.x`, `refs/heads/a b`, `refs/heads/ma*n`, `@`, empty | flag |
| `refs/heads/x..y`, `x..y` | flag | `refs/heads/main\nextra` (two lines) | flag, referent printed with the raw LF |
| `foo/bar` | `warning: … symrefTargetIsNotARef: points to non-ref target 'foo/bar'` + ptr; 2, and 2 under `--strict` | `head` (lower case) | flag, **exit 8, no ptr**: APFS resolves `head` to `HEAD`. Excluded from the interop matrix as filesystem-dependent. |

Root-ref syntax as pinned: `[A-Z_-]+` that is `HEAD`, ends in `_HEAD`, or is one of the five
irregular names above, and is not the pseudoref `FETCH_HEAD`/`MERGE_HEAD`. Anything else
must pass the ref-name format check **with at least two components**.

**Symref whitespace (resolution and verify).**

| Row | Body of `b` | `rev-parse --symbolic-full-name b` | fsck |
|---|---|---|---|
| R1 / G20 | `ref:refs/heads/main\n` | `refs/heads/main` | 0, nothing (tsgit: `badRefContent` + pointer, **10**) |
| R2 / G21 | `ref:  refs/heads/main\n` | `refs/heads/main` | 0 (tsgit: 0, but only because `listRefs` drops b) |
| R3 | `ref:\trefs/heads/main\n` | `refs/heads/main` | 0 |
| R4 / G19 | `ref: refs/heads/main \n` | `refs/heads/main` | 0 + `warning: trailingRefContent: has trailing whitespaces or newlines` |
| R5 / G10 | `ref: refs/heads/main\r\n` | `refs/heads/main` | 0 + the same warning |
| G22 | `ref: refs/heads/main\n\n` | — | 0 + the same warning |
| V1 | `ref:\vrefs/heads/main\n` (and `\f`) | fails | flag `'?refs/heads/main'` (git prints the control byte as `?`), 10 |
| V3 | `ref: refs/heads/main\v\n` | fails | flag, 10 |
| R6 | `ref: refs/heads/main\nextra\n` | dangling | flag + pointer, 10 |

So the whitespace class is exactly SP, HT, CR and LF.

**Adjacent gaps found, outside the perimeter** (see Out of scope; tsgit twin in brackets):

| Shape | git | tsgit |
|---|---|---|
| `refs/heads/d/` mode 000 | `warning: error opening directory '.git/refs/heads/d/': Permission denied`, exit 0 (gone under `--no-references`). `for-each-ref`, `branch`, `show-ref` and `rev-list --all` skip it silently, exit 0. | throws `PERMISSION_DENIED` (`data.path` = `<B>/…/refs/heads/d`) |
| `b` a symlink to a file holding `ref: x..y`, or to a mode-000 file | `symlinkRef` warning · `badReferentName: points to invalid refname '<link text>'` · b pointer, exit 10 | `symlinkRef` only, exit 0 / throws |
| `<sha> \n`, `<sha> garbage\n` | 0 + `warning: trailingRefContent: has trailing garbage: …` | `badRefContent` + pointer, 10. D5's SP/HT/CR/LF trim fixes `<sha> \n` (bar the warning); `<sha> garbage` stays (its twin was not run) |
| `<SHA>` in upper case | 0 | `badRefContent` + pointer, 10 |
| `<sha>` with no LF, `ref: …` with no LF | 0 + `warning: refMissingNewline: misses LF at the end` | 0, no warning |

### 2. The model: git's two halves, kept as tsgit's two halves

```
verifyIntegrity()  [gated: checkReferences]           snapshot  [never gated]
  per loose file in the walk (HEAD included):           every listed name, by name:
    unreadable (EACCES)  → cannotReadRef                  resolves → its oid (absent → pointer)
    body not oid/symref  → badRefContent                  fails    → zero oid → pointer
    symref, bad referent → badReferentName              then every worktree HEAD:
    symref, outside refs/→ symrefTargetIsNotARef*         resolves → its oid; fails → skipped
  per linked-worktree HEAD (snapshotWorktreeHeads):
    its own file EACCES  → cannotReadRef
```

`*` is emitted when the referent is not a root ref and does not start with `refs/`, and
`badReferentName` was not graded at error. git returns early on an error-graded
`badReferentName` (S3, S4, S6). This applies under D4's fold only.

The pointer is **resolution**-driven and the notices are **grammar**-driven, which is why
they reach different names. Row `head` shows them separate: a flagged referent that still
resolves has no pointer. The redesign drops the synthesised pointer in
`collectBadContentNotices`: the snapshot now emits that pointer itself, in name order,
which is git's order.

### 3. Finding shapes (public `FsckFinding`, `bad-ref` arm)

`src/application/commands/internal/fsck/types.ts` L50. One finding per git line (D1
recommendation):

```ts
| {
    readonly type: 'bad-ref';
    readonly ref: RefName;
    readonly msgId: string;
    readonly severity: FsckSeverity;
    readonly target?: ObjectId;
    readonly path?: string;
    readonly reason?: 'PERMISSION_DENIED';
    /** The name a symbolic ref's body points to, as written — present on
     *  `badReferentName` and `symrefTargetIsNotARef`. Not a `RefName`:
     *  it is exactly the name that failed the check. */
    readonly referent?: string;          // NEW
  }
```

| git line | finding |
|---|---|
| `<ref>: badRefContent: <content>` | `{ ref, msgId: 'badRefContent', severity }` (unchanged; `<content>` is not carried, see D1) |
| `<ref>: badReferentName: points to invalid refname '<R>'` | `{ ref, msgId: 'badReferentName', severity, referent: R }` |
| `<ref>: symrefTargetIsNotARef: points to non-ref target '<R>'` | `{ ref, msgId: 'symrefTargetIsNotARef', severity: 'info', referent: R }` (D4) |
| `cannot read ref file '<path>': Permission denied` | `{ ref, msgId: 'cannotReadRef', severity: 'error', path, reason: 'PERMISSION_DENIED' }` (existing shape; now for any loose ref) |
| `<ref>: invalid sha1 pointer <oid>` | `{ ref, msgId: 'badRefOid', severity: 'error', target }` (unchanged) |

`path` holds the absolute path tsgit opened (`<gitDir>/refs/heads/b`), matching the existing
worktree-HEAD finding (D2). The interop rebuilds git's text as
`path.relative(realpath(workDir), realpath(finding.path))` for a main-repo ref and as
`realpath(finding.path)` for a linked-worktree HEAD.

**Exit bits** (`exit-codes.ts`, comment only): bit 8 gains "`badReferentName` at error,
`cannotReadRef`, and a configured-error `symrefTargetIsNotARef`" (row S8).

### 4. Parts (pre-chewed for the planner)

**P1 — domain: symref grammar and referent check.**
- `src/domain/refs/loose-ref.ts` `parseLooseRef(content: string): LooseRef` (L18): replace
  the `[\r\n]+$` trim with a trailing `[ \t\r\n]+` trim, and replace the `'ref: '` prefix
  with `ref:` followed by any run of `[ \t\r\n]`. An empty remainder still throws `invalidRef('empty symbolic ref
  target')`. The direct branch keeps `ObjectIdFactory.from(trimmed)`; whether a direct body
  with interior trailing garbage or upper-case hex is accepted stays out of scope.
  Callers that inherit the change: `ref-store.ts` `fromLooseContent` (L558, both HEAD's
  file arm and loose refs) and `internal/ref-write-chain.ts`. The change is git-faithful
  for every command (R1–R5 are `rev-parse` pins).
- New pure predicate `isValidSymrefReferent(referent: string): boolean` in a new
  `src/domain/refs/symref-referent.ts`. It accepts a root ref (`/^[A-Z_-]+$/`, and `HEAD`,
  a `_HEAD` suffix, or one of `AUTO_MERGE`, `BISECT_EXPECTED_REV`, `NOTES_MERGE_PARTIAL`,
  `NOTES_MERGE_REF`, `MERGE_AUTOSTASH`, and neither `FETCH_HEAD` nor `MERGE_HEAD`). It also
  accepts a name containing `/` that `isSafeRefName` accepts (`ref-validation.ts` L67).
  Sibling `isOutsideRefsNamespace(referent)` (D4): not a root ref and not `refs/`-prefixed.
  Export both through `src/domain/refs/index.ts`, and use named constants for the irregular
  set and the pseudorefs.
- Tests: `test/unit/domain/refs/loose-ref.test.ts` (extend) and a new
  `test/unit/domain/refs/symref-referent.test.ts` holding the referent-grammar table above,
  minus `head`. A new `loose-ref.properties.test.ts` covers the round-trip lens
  (`serializeSymbolicRef` → `parseLooseRef` is the identity on valid names) and the
  whitespace-insensitivity lens (any SP/HT/CR/LF run after `ref:` and at the end parses to
  the same target).

**P2 — ref store: integrity facts.**
- `RefIntegrityFinding` (ref-store.ts L229) gains three arms:
  ```ts
  | { readonly ref: RefName; readonly msgId: 'badReferentName'; readonly referent: string;
      readonly throughSymlink: boolean }
  | { readonly ref: RefName; readonly msgId: 'symrefTargetIsNotARef'; readonly referent: string;
      readonly throughSymlink: boolean }
  | { readonly ref: RefName; readonly msgId: 'cannotReadRef'; readonly path: string;
      readonly reason: 'PERMISSION_DENIED'; readonly throughSymlink: boolean }
  ```
  The store reports two independent facts per symref body: the referent is invalid
  (`badReferentName`), and the referent is outside `refs/` and not a root ref
  (`symrefTargetIsNotARef`). fsck applies severity and git's early-return rule: it drops a
  ref's `symrefTargetIsNotARef` when that ref's `badReferentName` is graded error.
- `looseBodyFinding(name, throughSymlink)` (L1180) uses the P1 grammar. Its symref branch
  runs `isValidSymrefReferent` and `isOutsideRefsNamespace`; its `badRefContent` test reads
  the SP/HT/CR/LF-trimmed body. A `PERMISSION_DENIED` from `readLooseContent` (L755)
  becomes the `cannotReadRef` arm, with `path` = `looseRefPath(refDir(name), name)`. Every
  other read fault still propagates. The return type becomes `ReadonlyArray<…>`, because a
  symref can yield both `badReferentName` and `symrefTargetIsNotARef`.
- `verifyIntegrity` (L1199): no change beyond consuming the array.
- `reftable-ref-store.ts` `verifyIntegrity` (L267): unchanged, since reftable has no loose
  bodies.
- Tests: `test/unit/application/primitives/ref-store.test.ts` (L2657 block, `verifyIntegrity`).
  Use the spy pattern `vi.spyOn(ctx.fs, 'readUtf8')` throwing `permissionDenied(path)` from
  `fsck-worktree-heads.test.ts` L240. Also pin that an EIO-like plain `Error` propagates.

**P3 — refs-verify: snapshot and notices** (`src/application/commands/internal/fsck/refs-verify.ts`).
- `snapshotTargets(ctx, entries)` (L161) takes `names = refStore.listRefNames()` alongside
  `entries = refStore.listRefs()`. Every name in `names` that is absent from `entries` and
  is not `HEAD` gets `{ ref, id: zeroOid }`. The listed and broken sets are merged in
  `compareRefNames` order, which equals the ref store's `byName`. Row U-shadow holds by
  construction: `listRefs` already refuses the packed fallback for a name it walked as loose
  (L1131–1136).
- `targetOf` (L142): the broken set becomes `UNREADABLE_REF_CODES` (resolve-ref.ts L28)
  plus `REF_NOT_FOUND` and `PERMISSION_DENIED`, as a named fsck-local set. Every member
  maps to the zero oid. The `isTolerableRefFault` branch becomes unreachable and is
  removed, so `targetOf` returns `ObjectId`. Every other error rethrows.
- `collectBadContentNotices` (L97) becomes a content-notices collector:
  - `badRefContent` is unchanged except the synthesised pointer is dropped;
  - `badReferentName` uses `retypeSeverity(severities, 'badReferentName', 'error')`;
  - `symrefTargetIsNotARef` uses base `'info'` and the early-return rule;
  - `cannotReadRef` is error and not re-typed.

  All four are gated by `checkContentFormat`, and none is emitted when `throughSymlink`
  (git's verify stops at links; see Out of scope for what git does there instead). Bit 8
  is set for each error-graded notice.
- `collectAbsentTargets` (L186): the unreadable worktree heads are emitted only when
  `checkContentFormat` holds, and the current worktree's `HEAD` is never one, since the
  walk already reports it (requirement 4). The signature gains `checkContentFormat:
  boolean`.
- `runRefsVerifyPass` (L226) gains `listRefNames()` in its `Promise.all`. The public
  signature is unchanged. The doc comment on the two sub-checks is rewritten.

**P4 — roots: a HEAD whose target is unreadable** (`roots.ts` `headOf`, L897).
`PERMISSION_DENIED` maps to `{ kind: 'unreadable', path }` only when `err.data.path ===
\`${worktreeCtx.layout.gitDir}/HEAD\``. Any other `PERMISSION_DENIED` means a target in the
chain is unreadable, and maps to `NO_HEAD` (row HU: git prints no HEAD line). This changes
`snapshotWorktreeHeads`, whose callers are refs-verify and `worktreeHeads` (L975, the
retention and audit roots), and the change is faithful for both. Test:
`fsck-worktree-heads.test.ts` (extend next to L249).

**P5 — the pin in tension.** In `fsck-symbolic-ref-fault.test.ts`, the
`PERMISSION_DENIED`-propagates row becomes the B-with-a behaviour: the symref
`refs/remotes/origin/HEAD` gets a zero pointer and the run exits 2, because the fault is
synthetic and the file itself is readable, so no `cannotReadRef` fires. A new row keeps the
propagation guarantee for an unclassified fault (`new Error('EIO: i/o error')`), mirroring
`fsck-worktree-heads.test.ts` L276.

**P6 — interop.** A new suite `test/integration/fsck-broken-ref-chain-interop.test.ts`, kept
out of the 4423-line `fsck-interop.test.ts`. It uses `runGit`/`tryRunGitWithExit`/`SAFE_ENV`,
`realpathSync(mkdtempSync(…))` roots, and permission rows guarded by `process.platform !==
'win32' && process.getuid?.() !== 0`, as `alternates-interop.test.ts` L51 does. One
table-driven `describe.each` over the chain, unreadable, severity (repo-config `fsck.*`)
and grammar rows. Each row asserts exit-code equality, content lines as a sorted multiset,
and pointer lines in sequence, all rebuilt from findings. Line rebuild helpers go in
`test/integration/fsck-line-helpers.ts`: `refLine(f)` maps msgId to git's text, with
`'warning'`/`'info'` → `warning:` and `'error'` → `error:`. Every fixture seeds each shape
both first and last in name order (lesson 022: `a`→`b` and `z`→`b`).

**P7 — docs.** In `docs/use/commands/fsck.md`: the `bad-ref` row (L155) gains `referent?`,
`badReferentName`, `symrefTargetIsNotARef`, and `cannotReadRef` for any loose ref; the exit
table (L259) also changes. Fix the bit-8 comment in `exit-codes.ts`. The
`docs/design/fsck.md` msg-id table stays as it is (it is already right).

### 5. Edge behaviour

- A `badRefContent` body read through a symlink still gets its pointer under the linked
  name, because `listRefNames` walks through links (`followedEntryKind`). This keeps
  `fsck-symlinked-ref.test.ts` green, with array order following requirement 8.
- A packed ref is never in the broken set: `listRefs` always yields it. A walked name
  cannot yield the `blocked` leaf (`NOT_A_DIRECTORY`, ref-store.ts L862), because it came
  from a `readdir`.
- A symlinked ref onto a mode-000 file: `readLooseContent` follows the link, so the
  `cannotReadRef` fact carries `throughSymlink: true` and is suppressed. git prints no
  cannot-read line there (adjacent table); its pointer stands.
- Assumption, pinned only by the referent table: `isSafeRefName` agrees with git's
  `check_refname_format(…, 0)` on every two-plus-component name. The unit table is the
  guard, and any further divergence is a ref-validation finding, not this change's.
- With `--no-full` / `connectivityOnly` / promisor, the zero oid is never held or promised,
  so the pointer always stands, as today.
- `no-default-references` is unchanged: it fires when every snapshotted target is a
  pointer (rows HT, U-only).

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| D1 | Finding shape for git's up-to-three lines per broken chain | (a) one `bad-ref` per git line, an existing msgId each, and a new `referent?: string` for `badReferentName`/`symrefTargetIsNotARef`. (b) one finding per broken chain: `{ ref: <referent>, cause, chain: RefName[] }`, with the interop expanding it to lines. (c) as (a) without `referent`, the interop taking the referent from the fixture, as the `badRefContent` row does today with `BAD_CONTENT`. | (a) | It matches git's per-ref data one to one and reuses the union every consumer already filters on (`msgId === 'badRefOid'`). (b) invents a grouping git does not have and breaks the existing `badRefOid` consumers. (c) hides data a caller cannot recover by resolving, because the ref does not parse. `badRefContent`'s `<content>` is not carried, as today: it is outside the brief, and a `content?` field would be the symmetric follow-up. The ref store's "no reader echoes loose bytes" rule (ref-store.ts L582) binds error messages, not findings. |
| D2 | Unreadable ref file: finding or refusal, and `path` form | (a) finding `cannotReadRef` with an **absolute** `path` (as tsgit opened it) and `reason: 'PERMISSION_DENIED'`, gated by `checkReferences`, bit 8; a chain read hitting `PERMISSION_DENIED` → zero pointer; `fsck-symbolic-ref-fault.test.ts` re-pinned to an unclassified fault. (b) the same finding with a gitdir-relative `path` (`refs/heads/b`) plus a scope tag. (c) refusal: keep throwing, under an ADR that diverges. | (a) | git reports, continues and exits 10 in default, `--strict` and `--connectivity-only` alike, so a refusal would diverge, and ADR-1116's refusal rule is the odb's, not the ref backend's. The absolute path is the existing worktree-HEAD precedent, and git's own text depends on how it was invoked (`.git/…`, an absolute `--git-dir`, the realpath for worktrees), so no relative form is "git's". |
| D3 | Where the snapshot finds broken names | (a) `listRefNames() − listRefs()` names → zero pointer, no re-read. (b) `resolveRef` every listed name, catching the broken set. (c) a new `RefStore` method yielding `{ name, broken: true }` entries (both backends and every test double). | (a) | No port change and no extra file reads: one more readdir walk (`collectCandidateNames`), plus the `packed-refs` snapshot `listRefs` already loaded. (b) re-reads every loose file and pays a loose-miss probe per packed name, which hurts on large ref spaces. (c) widens the port for one caller. |
| D4 | `symrefTargetIsNotARef` (S3/S4/S6, and `ref: foo/bar` by default) | (a) fold: emit it as a `bad-ref` info finding under git's early-return rule. (b) out of scope: the S3/S4 rows are pinned minus that line and an IMPACT line is filed. | (a) | It is one rule in the same git check (the symref target check) that the change already implements for `badReferentName`. Without it, the severity-override rows the brief asks for cannot match git. |
| D5 | Symref whitespace grammar (R1–R5) | (a) fold into `parseLooseRef` and `looseBodyFinding`, git-faithful for every command. (b) fsck-only: exclude git-accepted bodies from the broken set. (c) leave it, accepting the regression of G19/G21/G22/G10 from exit 0 to 2. | (a) | Requirement 1 makes these bodies broken under today's grammar, a new divergence the change itself would create. (b) forks the grammar, which breeds divergence. R1–R5 are `rev-parse` pins, so the fix is faithful beyond fsck. |
| D6 | Adjacent gaps outside the two bullets: unreadable ref directory, symlinked-ref `badReferentName` on link text, direct-oid grammar (`<sha> garbage`, upper case), `trailingRefContent`/`refMissingNewline` | (a) out of scope: IMPACT lines, and the user decides whether to file them. (b) fold all of them now. | (a) | Each one needs its own pin matrix and touches a different contract. The unreadable directory changes the shared ref walk for every command (`for-each-ref`, `branch`, `show-ref` and `rev-list --all` all skip silently in git). The link-text case sits in ADR-874's link-text normalisation. The direct-oid case changes resolution for every command. None is made worse by this change. |

## Test strategy

- **Interop (P6)**: every row of the matrix except HD2, MH, `head` (filesystem-dependent)
  and the adjacent-gap table. That covers chains, unreadable files (POSIX, non-root),
  severity via repo config, `--no-references`, `--connectivity-only`, `--strict`, the
  referent grammar, and the R whitespace rows (`rev-parse` + fsck). W, W-nr and MH-l use a
  real `git worktree add`. Lesson 015: the gate runs every `fsck*-interop` suite plus every
  suite that resolves a ref body, because P1 changes resolution grammar for all commands.
  The planner lists them through serena's references to `parseLooseRef`/`fromLooseContent`.
- **Unit**:
  - `refs-verify` behaviour through `fsck` on the memory adapter with `readUtf8` spies:
    `PERMISSION_DENIED` on a loose ref, on a chain target, and on a worktree HEAD's target
    (P4). Each guard gets its own isolated test: `checkContentFormat` off, `throughSymlink`,
    each severity value, and the early-return rule.
  - Error-data assertions use try/catch on `.data`. Each new arm of `RefIntegrityFinding`
    gets a test in `ref-store.test.ts`.
- **Properties**: `loose-ref.properties.test.ts` (round-trip and whitespace lenses), plus a
  property in `symref-referent.test.ts`'s sibling `symref-referent.properties.test.ts`:
  every `refs/<a>/<b>` built from safe components is valid, and every `[A-Z_-]+_HEAD` other
  than the pseudorefs is valid.
- **Mutation**: the narrowed buckets are `refs-verify`, `roots`, `ref-store` (integrity
  slice), `loose-ref` and `symref-referent`. `targetOf`'s removed branch must not come back
  as an equivalent survivor.

## Out of scope

- **Unreadable ref directory** (`refs/heads/d/` mode 000). tsgit throws where git warns and
  exits 0, and every git listing command skips it. This is the shared walk
  (`walkRefDir`, ref-store.ts), not this pass (D6).
- **A symlinked ref whose link text is not a valid referent.** git reports `badReferentName`
  on the link text. This depends on ADR-874's normalisation and needs its own matrix (D6).
- **Direct-oid body grammar**: `<sha> garbage` and upper-case hex are accepted by git and
  are `badRefContent` in tsgit (D6).
- **`trailingRefContent` and `refMissingNewline` warnings**: catalogued git messages tsgit
  never emits. They have no exit bit (D6).
- **An unreadable or invalid main `.git/HEAD`**: git refuses discovery (HD2, MH). That is
  the repository-open surface, not fsck.
- **The `?` rendering of control bytes** in git's `badReferentName` line: display only
  (ADR-249). The finding carries the raw referent.
