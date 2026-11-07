# Design — fsck checks every worktree's private refs and names them as git does

> Brief: backlog 32.48. `fsck` never checks another worktree's per-worktree refs, and it
> names its own without the `worktrees/<id>/` prefix. git 2.56's `refs verify` child walks
> **every** worktree's ref store from any cwd: the main store first with no prefix, then each
> `.git/worktrees/<id>` with the prefix `worktrees/<id>/`. tsgit walks only the current
> worktree's view, reads each body by name instead of at the walked path, and crashes on
> another worktree's garbage HEAD. Bring the ref-content pass to git's store-by-store walk.
> Pinned on git 2.56.0. The user's decision points: walk scope, display names, exit bits per
> fault, and whether 32.49 (`main-worktree/` resolution) folds in.
> Status: draft → self-reviewed ×3

<!-- cspell:ignore unlistable -->

## Context

- **Prime directive** (CLAUDE.md, ADR-226): match git's data, refusal conditions and exit
  status byte for byte. **Structured output** (ADR-249): tsgit returns findings, and the
  interop test rebuilds git's stderr lines from them.
- **git's model** (v2.56.0 sources, cited by symbol):
  - `builtin/fsck.c` `fsck_refs` runs `git refs verify` as a child. A non-zero child exit
    sets `ERROR_REFS` (bit 8). Pointer lines (`invalid sha1 pointer`, bit 2) come from
    `snapshot_refs`: every ref of the current worktree's view (`refs_for_each_ref_ext` on
    `get_main_ref_store`, `REFS_FOR_EACH_INCLUDE_BROKEN`), plus every worktree's HEAD.
    `strbuf_worktree_ref` names those HEADs `HEAD`, `main-worktree/HEAD` or
    `worktrees/<id>/HEAD`.
  - `builtin/refs.c` `cmd_refs_verify` loops `get_worktrees_without_reading_head` and calls
    `refs_fsck(get_worktree_ref_store(wt), …, wt)` for each one: the main worktree, then
    `.git/worktrees/*` in `readdir` order. `worktree.c` `get_linked_worktree` skips an entry
    whose `gitdir` file is missing, unreadable or empty.
  - `refs/files-backend.c` `files_fsck` runs three steps per store:
    1. `files_fsck_refs_dir` runs a `dir_iterator` over `<store gitdir>/refs`. It visits
       every file, whatever the namespace. The name is `worktrees/<id>/` (all but the main
       store) followed by `refs/<relative>`. A basename ending in `.lock` is skipped unless
       it starts with `.`. A root that cannot be begun fails one of two ways: `ENOENT` is
       silent for a linked store; anything else is `error: cannot open directory <p>:
       <error text>`. A root that opens and then cannot be read gives `warning: error
       opening directory '<p>/'` plus `error: failed to iterate over '<p>'`.
    2. `for_each_root_ref` opens the store gitdir as a directory and takes regular files (by
       `stat`) with root-ref syntax. `files_fsck_root_ref` builds the path
       `<common dir>/<prefixed name>` (the common dir as the store spells it), and the store's callback loop stops at the first
       non-zero return. If that open fails, it returns -1 and prints nothing.
    3. `packed_fsck`, for the main store only.
  - `files_fsck_ref` runs `files_fsck_refs_name` (`badRefName`, using
    `check_refname_format` on the **prefixed** name; root refs are exempt) and
    `files_fsck_refs_content`. In the second, a symlink gives `symlinkRef`, and the referent
    is the realpath with `ref_store->repo->gitdir` (the **cwd** worktree's gitdir) stripped
    off. `cannot read ref file '<p>'` is an error. The body checks are `badRefContent`,
    `refMissingNewline` and `trailingRefContent`, then `refs_fsck_symref`, which
    `parse_worktree_ref`-strips the name before applying `badHeadTarget`.
  - `loose_fill_ref_dir`, the listing side, skips every entry whose name starts with `.`
    or ends with `.lock`.
- **tsgit today.**
  - `src/application/primitives/ref-store.ts`:
    - `verifyIntegrity` (L1512) walks `refsWalkRoots()` (L1115): `[common refs/, own refs/]`,
      collapsed into one root in the main worktree. Then it runs `rootRefFindings()`
      (L1523) over the own gitdir only. It never visits another worktree's admin dir.
    - `walkIntegrityEntries` (L1331) names each entry `${prefix}/${entry.name}` and calls
      `looseBodyFindings(name)` (L1468). That reads the body **by name** through
      `readLooseContentOrRefusal` (L1438) → `readLooseContent` (L835) →
      `refDir(name)` = `perWorktreeRefDir` (L800). Two misses follow. A per-worktree name
      met under the common root is read from the own gitdir (A5 from `wt`: silent; A20 from
      `wt`: own garbage reported twice). A shared name met under the own root is read from
      the common dir (A16: silent).
    - `walkIntegrityRoot` (L1322) handles only a `PERMISSION_DENIED` root.
      `verifyIntegrity`'s `isDirectoryPath` gate (L1796) follows a symlinked root (P10) and
      drops a root that is a file (B6, S9) silently.
    - `walkRefDir` (L1065), the listing walk, skips no dot or `.lock` name (C2, Q8, Q9).
      `walkTarget` (L1209) tolerates only `PERMISSION_DENIED` on an own namespace, so a
      `refs` that is a file throws `NOT_A_DIRECTORY` from that worktree (B6 from `vt`).
    - `gitDirToStrip` (L1382) strips `ctx.layout`'s gitdir: the cwd's, which is git's rule
      (A1, A6, B12, B13).
  - `src/application/commands/internal/fsck/refs-verify.ts`:
    - `collectContentNotices` (L233) ends the root-ref check at the first error-severity
      finding, deciding "root ref" as `!ref.startsWith('refs/')`. That test misreads any
      prefixed name, and the run keeps one flag for the whole walk rather than one per
      store (P3).
    - `snapshotTargets` (L305) and `collectAbsentTargets` (L347) report an unreadable
      worktree HEAD a second time through `unreadableHeadFinding` (L325), which names the
      main HEAD `main-worktree/HEAD` (P2). git's single line comes from the `refs verify`
      child (P1 and P2, `git refs verify` run directly).
  - `src/application/commands/internal/fsck/roots.ts`:
    - `worktreeContexts` (L942) enumerates the main worktree, then `.git/worktrees/*`
      through `ctx.fs.readdir`, which is **sorted**. git uses OS order (Q7, and the reflog
      pass in R1/R2). `linkedWorktreeContext` (L921) has the `gitdir` skip rule, and
      `isUnopenableFile` (L206) its codes.
    - `worktreeRefName` (L561) prefixes per-worktree reflog names.
    - `headOf` (L907) tolerates only `isSkippedRefReadFault` (L119). A garbage HEAD throws
      `INVALID_OBJECT_ID` from `parseLooseRef` through `resolveHeadDirect`, which kills
      fsck (A7 from `w`, A8 from `wt`).
  - `src/application/commands/internal/fsck/types.ts`: `unreadable-ref-path` (L68),
    `refs-walk-failed` (L78, `reason: 'PERMISSION_DENIED'` only), `refs-verify-ended` (L86).
  - The interop suite `test/integration/fsck-broken-ref-chain-interop.test.ts` has:
    - `printedPath` (L1176), which prints every linked-admin path absolute. That is wrong
      from the main cwd for refs-walk paths (B5, A11, A13, B6, P10 print `.git/worktrees/…`).
    - `shownRef` (L1198), which rebuilds `worktrees/wt/` from tsgit's bare names, for
      `symlinkRef` only.
    - `cwdOf` (L1278) and `runTsgit` (L1294).
- **Precedent for the prefix in the data.** `unreadableHeadFinding` already reports
  `ref: 'worktrees/wt/HEAD'` (B4/P1 match git). The reflog pass reports
  `worktrees/<id>/HEAD` through `worktreeRefName`.
- **Governing docs.**
  - `docs/design/fsck.md`: msg-id table L359–L369. `badRefName`, `badRefFiletype` and
    `badHeadTarget` are catalogued in `src/domain/fsck/msg-ids.ts` but never emitted.
  - `docs/design/fsck-broken-ref-chain-unreadable.md`: the previous ref-walk design. Its
    "Assumption, unpinned" (L616) on a linked worktree's link referent is now pinned by A1,
    A6, B12 and B13: git strips the cwd's gitdir.
  - `docs/use/commands/fsck.md`: `checkReferences` L131, `bad-ref` L163,
    `refs-walk-failed` L180, exit table L270.
  - ADRs 226, 249, 294 (`commonDir` layout and the per-worktree-ref rule), 1121–1140,
    1137/1138 (unreadable refs root). Lesson 026 (git reads the OS order) and lesson 030
    (derived-context sessions).

### How the values below were pinned

Every probe ran under `bash` with `set -euo pipefail`, in a `mktemp -d` throwaway, with
`env -i PATH=… HOME=<B>/home GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=<B>/gitconfig` (that
gitconfig holds only `[user]`). Every git call passed `-c commit.gpgsign=false -c gc.auto=0`.
Oracle: **git 2.56.0** (Homebrew, macOS, APFS, non-root).

- Each shape is a fresh `git init -b main` repo `w` with one commit, plus
  `git worktree add wt -b side` (admin dir `.git/worktrees/wt`). Some shapes add a second
  linked worktree `vt`, or hand-make an admin dir (`HEAD`, `gitdir`, `commondir`).
- "from w" means the cwd is the main worktree; "from wt" the linked one.
- The tsgit column is `openRepository({ cwd }).fsck()` at the branch base adf96e8f. Listing
  rows use `getRefStore(createNodeContext({ workDir })).listRefNames()/listRefs()`.
- `<B>` is the throwaway root as `mktemp` printed it, `<RB>` its realpath, `0{40}` the zero
  oid.
- Rows marked ×3 or ×2 were re-run on fresh throwaways with the same outcome. P11 and P12
  ran git only.

### Pinned matrix

Lines are git's stderr report lines. "✓" means tsgit already matches; "✗" gives tsgit's
deviation. The **required** column is the tsgit result this change must give. It lists
findings as `type ref msgId severity` (`bad-ref` is implied when the type is omitted).

| id | shape | cwd | git line(s) | git exit | tsgit today | required |
|---|---|---|---|---|---|---|
| A0 | clean | w, wt | — | 0 | ✓ | — |
| A1 | `worktrees/wt/refs/bisect/bad` → symlink `../../../../refs/heads/main` | w | `warning: worktrees/wt/refs/bisect/bad: symlinkRef: use deprecated symbolic link for symref` | 0 | ✗ nothing | `worktrees/wt/refs/bisect/bad symlinkRef warning` (referent `refs/heads/main`, valid) |
| A1 | same | wt | the warning + `error: worktrees/wt/refs/bisect/bad: badReferentName: points to invalid refname '<RB>/A1/w/.git/refs/heads/main'` | 8 | ✗ names `refs/bisect/bad` | both findings, prefixed name, referent absolute |
| A2 | `worktrees/wt/refs/bisect/bad` = `garbage\n` | w | `error: worktrees/wt/refs/bisect/bad: badRefContent: garbage` | 8 | ✗ nothing, 0 | `worktrees/wt/refs/bisect/bad badRefContent error` |
| A2 | same | wt | the error + `error: refs/bisect/bad: invalid sha1 pointer 0{40}` | 10 | ✗ content line bare | content prefixed; pointer `refs/bisect/bad` (bare) |
| A3/A4 | same garbage at `refs/worktree/x`, `refs/rewritten/x` | w / wt | as A2 | 8 / 10 | as A2 | as A2 |
| A5 | MAIN `.git/refs/bisect/bad` garbage | w | `error: refs/bisect/bad: badRefContent: garbage` + pointer | 10 | ✓ | — |
| A5 | same | wt | `error: refs/bisect/bad: badRefContent: garbage` (no pointer) | 8 | ✗ nothing, 0 | `refs/bisect/bad badRefContent error` (main store, read at `.git/refs/bisect/bad`) |
| A6 | MAIN `.git/refs/worktree/x` → symlink `../heads/main` | w | `warning: refs/worktree/x: symlinkRef: …` | 0 | ✓ | — |
| A6 | same | wt | the warning + `error: refs/worktree/x: badReferentName: points to invalid refname '<RB>/A6/w/.git/refs/heads/main'` | 8 | ✓ | — |
| A7 | `worktrees/wt/HEAD` = `garbage\n` | w | `error: worktrees/wt/HEAD: badRefContent: garbage` | 8 | ✗ **throws** `INVALID_OBJECT_ID` | `worktrees/wt/HEAD badRefContent error`; no HEAD pointer |
| A7/A9 | same, or wt HEAD a symlink | wt | `fatal: gitfile does not point to a valid repository: …` | 128 | ✓ throws `NOT_A_REPOSITORY` | — |
| A8 | `.git/HEAD` = `garbage\n` | wt | `error: HEAD: badRefContent: garbage` | 8 | ✗ **throws** `INVALID_OBJECT_ID` | `HEAD badRefContent error`; no HEAD pointer |
| A8 | same | w | `fatal: not a git repository …` | 128 | ✓ | — |
| A9 | `worktrees/wt/HEAD` → symlink `../../refs/heads/side` | w | — (followed by `stat`: a regular file) | 0 | ✓ | — |
| A10 | hand-made admin `vt` with no `refs` dir | w, vt | — | 0 | ✓ | — |
| A11 | `worktrees/wt/refs` mode 000 | w | `warning: error opening directory '.git/worktrees/wt/refs/': Permission denied` + `error: failed to iterate over '.git/worktrees/wt/refs'` | 8 | ✗ nothing, 0 | `unreadable-ref-path` (open-directory) + `refs-walk-failed` `PERMISSION_DENIED`, both on `<RB>/A11/w/.git/worktrees/wt/refs` |
| A11 | same | wt | same two lines, path `<RB>/A11/w/.git/worktrees/wt/refs` | 8 | ✓ | — |
| A12 | `.git/worktrees/wt` mode 000 | w | — (worktree skipped) | 0 | ✓ | — |
| A13 | `worktrees/wt/refs/bisect` mode 000 | w | `warning: error opening directory '.git/worktrees/wt/refs/bisect/': Permission denied` | 0 | ✗ nothing | `unreadable-ref-path` on it |
| A13 | same | wt | same, absolute path | 0 | ✓ | — |
| A14 | packed `<oid> refs/bisect/packed` | w, wt | — | 0 | ✓ | — |
| A15 | packed `0{40} refs/worktree/zero` | w, wt | `error: refs/worktree/zero: invalid sha1 pointer 0{40}` | 2 | ✓ | — |
| A16 | `worktrees/wt/refs/heads/stray` garbage | w, wt | `error: worktrees/wt/refs/heads/stray: badRefContent: garbage` | 8 | ✗ nothing, 0 | that finding, from both working directories |
| A17 | wt `refs/bisect/bad` = `deadbeef…` (absent object) | w | — | 0 | ✓ | — |
| A17 | same | wt | `error: refs/bisect/bad: invalid sha1 pointer deadbeef…` | 2 | ✓ | — |
| A18 | wt `refs/bisect/bad` = oid, no LF | w, wt | `warning: worktrees/wt/refs/bisect/bad: refMissingNewline: misses LF at the end` | 0 | ✗ none from w; bare from wt | `worktrees/wt/refs/bisect/bad refMissingNewline info` |
| A19 | wt `refs/bisect/bad` = `ref: foo` | w | `error: worktrees/wt/refs/bisect/bad: badReferentName: points to invalid refname 'foo'` | 8 | ✗ nothing | that finding |
| A19 | same | wt | the error + pointer `refs/bisect/bad` | 10 | ✗ content bare | content prefixed, pointer bare |
| A20 | garbage in MAIN `refs/bisect/bad`, `worktrees/vt/…`, `worktrees/wt/…` | w, wt | `refs/bisect/bad`, `worktrees/vt/refs/bisect/bad`, `worktrees/wt/refs/bisect/bad` badRefContent + pointer `refs/bisect/bad` | 10 | ✗ main only (w); own one twice, bare (wt) | three content findings, one pointer |
| C4 | garbage in `wt` and `vt` bisect only | wt | `worktrees/vt/…` + `worktrees/wt/…` badRefContent + pointer `refs/bisect/bad` | 10 | ✗ one bare content line | two prefixed content findings + pointer |
| A21 | wt admin `HEAD` missing | w | — | 0 | ✓ | — |
| A22 | second linked `vt` with an empty `gitdir` + garbage bisect | w | — (skipped) | 0 | ✓ | — |
| J ×2 | the CURRENT linked worktree's own `gitdir` emptied; wt bisect garbage; a wt `logs/HEAD` entry naming `deadbeef…` | wt | `error: refs/bisect/bad: invalid sha1 pointer 0{40}` only: the own store is not walked and its reflogs are not read | 2 | ✗ bare `badRefContent` + `invalid-reflog-entry HEAD`, 10 | the pointer only: the skip rule applies to the current worktree in every `get_worktrees` consumer |
| A24 | wt `refs/bisect/a..b` = oid | w | `error: worktrees/wt/refs/bisect/a..b: badRefName: invalid refname format` | 8 | ✗ nothing | `badRefName error` on the prefixed name (DC-12) |
| A24 | same | wt | that + `error: refs/bisect/a..b: invalid sha1 pointer 0{40}` | 10 | ✗ nothing, 0 | + zero pointer on the bare name (DC-12) |
| B1 | MAIN `refs/heads/a..b` = oid | w | `error: refs/heads/a..b: badRefName: invalid refname format` + `error: refs/heads/a..b: invalid sha1 pointer 0{40}` | 10 | ✗ nothing, 0 | both (DC-12) |
| B2 | wt `HEAD` = `ref: refs/heads/side` (no LF) | w, wt | `warning: worktrees/wt/HEAD: refMissingNewline: misses LF at the end` | 0 | ✗ none from w; `HEAD` from wt | `worktrees/wt/HEAD refMissingNewline info` |
| B3 | wt `HEAD` = `ref: refs/tags/x` | w, wt | `error: worktrees/wt/HEAD: badHeadTarget: HEAD points to non-branch 'refs/tags/x'` | 8 | ✗ nothing | `worktrees/wt/HEAD badHeadTarget error` referent `refs/tags/x` (DC-10) |
| C1 | MAIN `HEAD` = `ref: refs/tags/x` | w, wt | `error: HEAD: badHeadTarget: HEAD points to non-branch 'refs/tags/x'` | 8 | ✗ nothing | `HEAD badHeadTarget error` (DC-10) |
| P1 (B4) | wt `HEAD` mode 000 | w | `error: cannot read ref file '<RB>/P1/w/.git/worktrees/wt/HEAD': Permission denied` — `git refs verify` alone prints the same line, exit 255 | 8 | ✓ but sourced from the snapshot | one `cannotReadRef` from the store walk, `ref` `worktrees/wt/HEAD` |
| P2 | MAIN `.git/HEAD` mode 000 | wt | `error: cannot read ref file '<RB>/P2/w/.git/HEAD': Permission denied` — the `refs verify` child's line | 8 | ✓ line; `ref` `main-worktree/HEAD` from the snapshot | one `cannotReadRef` from the main store's root refs, `ref` `HEAD` (DC-6) |
| P9 | MAIN `refs/heads/u` and `ORIG_HEAD` mode 000 | w | `cannot read ref file '.git/refs/heads/u'` + `'.git/ORIG_HEAD'` + pointer `refs/heads/u` | 10 | ✓ | — |
| P9 | same | wt | same lines, absolute `<RB>/P9/w/.git/…` paths | 10 | ✗ misses `ORIG_HEAD` | main store's root refs walked from `wt` |
| P3 | garbage MAIN `ORIG_HEAD`; wt admin `ORIG_HEAD` and `CHERRY_PICK_HEAD` (OS order: `CHERRY_PICK_HEAD` first) | w, wt | `error: ORIG_HEAD: badRefContent: garbage` + `error: worktrees/wt/CHERRY_PICK_HEAD: badRefContent: garbage2` | 8 | ✗ `ORIG_HEAD` only (w); `CHERRY_PICK_HEAD` bare only (wt) | both; each store's root check ends at its own first error |
| S10 | wt admin `AUTO_MERGE` (no LF), `REBASE_HEAD` garbage, `ORIG_HEAD` valid symref (OS order as listed) | w | `warning: worktrees/wt/AUTO_MERGE: refMissingNewline: …` + `error: worktrees/wt/REBASE_HEAD: badRefContent: garbage` | 8 | ✗ nothing | both |
| B5 | wt `refs/bisect/bad` mode 000 | w | `error: cannot read ref file '.git/worktrees/wt/refs/bisect/bad': Permission denied` | 8 | ✗ nothing | `cannotReadRef` `ref` `worktrees/wt/refs/bisect/bad` |
| B5 | same | wt | absolute path + pointer `refs/bisect/bad` | 10 | ✗ bare `ref` | prefixed `ref`; pointer bare |
| B6 | hand-made admin `vt` whose `refs` is a FILE | w | `error: cannot open directory .git/worktrees/vt/refs: Not a directory` | 8 | ✗ nothing, 0 | `refs-walk-failed` `NOT_A_DIRECTORY` on `<RB>/B6/w/.git/worktrees/vt/refs`, no `unreadable-ref-path` (DC-4) |
| B6 | same | vt | same, absolute | 8 | ✗ **throws** `NOT_A_DIRECTORY` from the listing | the finding; the listing treats the namespace as absent |
| P10 | wt `refs` → symlink to a dir holding `bisect/bad` garbage | w | `error: cannot open directory .git/worktrees/wt/refs: Not a directory` | 8 | ✗ nothing | `refs-walk-failed` `NOT_A_DIRECTORY` |
| P10 | same | wt | same, absolute + pointer `refs/bisect/bad` | 10 | ✗ reads through: bare `badRefContent` | the finding; the walk does not follow; the pointer stays (the listing follows the link, as git's does) |
| S9 | MAIN `.git/refs` → symlink `refs.real` | w, wt | `error: cannot open directory .git/refs: Not a directory` (absolute from wt) | 8 | ✗ nothing | `refs-walk-failed` `NOT_A_DIRECTORY` on `<common>/refs` |
| B7 | wt `refs/bisect/bad.lock` garbage | w | — | 0 | ✓ | — |
| B7 | same | wt | — | 0 | ✗ `badRefContent` + `badRefOid`, 10 | nothing (DC-11) |
| C2/Q8 | MAIN `refs/heads/x.lock` garbage, `y.lock` = oid | w | — ; `for-each-ref` and `branch` list `main`, `side` only; `rev-parse --verify refs/heads/y.lock` refused | 0 | ✗ `x.lock` content + pointer, 10; listing holds `x.lock`, `y.lock` | nothing; listing drops both (DC-11) |
| Q9 | wt `refs/bisect/.x.lock` garbage, `bad.lock` = oid | w, wt | `error: worktrees/wt/refs/bisect/.x.lock: badRefName: invalid refname format` + `error: worktrees/wt/refs/bisect/.x.lock: badRefContent: garbage` (no pointer from either cwd) | 8 | ✗ nothing (w); bare content + pointer, 10 (wt) | both content findings; no pointer (DC-11, DC-12) |
| B12 | wt `refs/bisect/bad` → symlink to `<B>/outside` | w, wt | `symlinkRef` warning + `error: worktrees/wt/refs/bisect/bad: badReferentName: points to invalid refname '<RB>/B12/outside'` | 8 | ✗ nothing (w); bare (wt) | both, prefixed |
| B13 | wt `refs/bisect/bad` → symlink `../../HEAD` | w | `symlinkRef` warning only (referent `worktrees/wt/HEAD`, relative to the MAIN gitdir) | 0 | ✗ nothing | warning only |
| B13 | same | wt | `symlinkRef` warning only (referent `HEAD`) | 0 | ✗ bare | warning, prefixed |
| P4 | MAIN `refs/heads/dead` → `nope/x` (missing dir) + wt bisect garbage | w | `symlinkRef` + `fatal: Invalid path '<RB>/P4/w/.git/refs/heads/nope': No such file or directory` — wt garbage never checked | 8 | ✓ | the run's end stops every later store |
| P4 | same | wt | the same two + pointer `refs/bisect/bad` | 10 | ✓ | — |
| P5 | MAIN `refs/heads/g` garbage + wt `refs/bisect/dead` → `nope/x` | w, wt | `refs/heads/g` badRefContent, `worktrees/wt/refs/bisect/dead` symlinkRef, `fatal: Invalid path '<RB>/P5/w/.git/worktrees/wt/refs/bisect/nope': …`, pointer `refs/heads/g` | 10 | ✗ wt part missing (w); bare (wt) | all four, prefixed |
| P6 | linked `zz`, `aa`, `mm` (OS order `zz aa mm wt`), garbage bisect in each | w | `worktrees/zz/…`, `worktrees/aa/…`, `worktrees/mm/…` badRefContent, in that order | 8 | ✗ nothing | three findings, in OS order |
| Q7 ×3 | linked `zz`, `aa` (OS order `zz aa`), a dying link in each | w | `warning: worktrees/zz/refs/bisect/dead: symlinkRef: …` + `fatal: Invalid path '<RB>/…/worktrees/zz/refs/bisect/nope': …` | 8 | ✗ nothing | `zz` dies first: stores are walked in OS order, not sorted (DC-8) |
| R1/R2 ×2 | `zz`, `aa` each with a reflog entry naming `deadbeef…` | w | `error: worktrees/zz/HEAD: invalid reflog entry deadbeef…` then `worktrees/aa/HEAD` | 2 | ✗ order `aa`, `zz` | OS order (DC-8) |
| F ×2 | wt admin dir mode 0300 + wt bisect garbage | w | `error: worktrees/wt/refs/bisect/bad: badRefContent: garbage` | 8 | ✗ nothing | the finding |
| H ×2 | wt admin dir mode 0300, nothing else | w | — (no line; `git refs verify` exits 255) | 8 | ✗ 0 | bit 8 with no git line (DC-5) |
| P11 | A2 shape, `--no-references` | w | — | 0 | n/a | every store-walk finding dropped |
| P12 | A2 shape, `-c fsck.badRefContent=warn` | w | `warning: worktrees/wt/refs/bisect/bad: badRefContent: garbage` | 0 | n/a | severity re-typed, no bit |
| A25 | `refs/heads/x` = `ref: main-worktree/HEAD` | w, wt | `warning: refs/heads/x: symrefTargetIsNotARef: points to non-ref target 'main-worktree/HEAD'` | 0 | ✗ + `badRefOid` zero, 2 | 32.49 (DC-9) |
| B8 | `refs/heads/x` = `ref: main-worktree/refs/bisect/bad` | w, wt | the same warning, that target | 0 | ✗ + `badRefOid` zero, 2 | 32.49 (DC-9) |
| A26/A27 | `ref: worktrees/wt/HEAD`, `ref: worktrees/wt/refs/bisect/bad` | w, wt | — | 0 | ✓ (the path `<common>/worktrees/wt/…` exists, which matches git's `REF_WORKTREE_OTHER` path) | — |
| B14/C3 | `rev-parse --verify`: `main-worktree/HEAD`, `worktrees/wt/HEAD`, `worktrees/wt/refs/bisect/bad` resolve; `main-worktree/refs/heads/main`, `worktrees/wt/refs/heads/side`, `worktrees/nope/HEAD` → `fatal: Needed a single revision` 128 | w, wt | — | — | ✗ `main-worktree/HEAD` throws `OBJECT_NOT_FOUND`; the rest ✓ | 32.49 (DC-9) |
| E1 | MAIN `refs/heads/a..b` = oid | w | `for-each-ref` and `branch`: `warning: ignoring ref with broken name refs/heads/a..b`, name omitted | 0 | ✗ `listRefs` includes it | out of perimeter (listing consumers) |

**Path spelling in git's lines** (the interop harness rebuilds it; tsgit always reports the
absolute path it opened):

- From a linked cwd, every path is absolute (A11, A13, B5, B6, P9, P10).
- From the main cwd:
  - main-store paths are relative to the top (`.git/refs/heads/u`, `.git/ORIG_HEAD`);
  - a linked store's `refs/` walk paths are relative too (`.git/worktrees/wt/refs/…`: A11,
    A13, B5, B6, P10);
  - a linked store's **root-ref** paths are the absolute realpath, because they are built
    from the store's common-dir spelling (P1).

## Requirements

1. **Every store, from any cwd.** The ref-content pass walks the main store, then every
   linked store `.git/worktrees/<id>` that `get_linked_worktree` accepts. It skips an entry
   whose `gitdir` file is missing, unreadable (`FILE_NOT_FOUND`, `PERMISSION_DENIED`,
   `NOT_A_DIRECTORY`) or zero bytes long (A12, A22). The current linked worktree gets no
   exemption: git skips its store and its reflogs too, while the current-view pointers stay
   (J). The walk order is the main store, then
   admin entries in the OS `readdir` order (P6, Q7). Each store gets:
   1. its `refs` root walked in full, every namespace included (A16);
   2. its root refs from the store gitdir, in OS order;
   3. nothing else: packed refs keep today's main-only handling (A14, A15).
2. **Read at the walked path.** Each file's body, its `cannotReadRef` path and its `lstat`
   are taken at `<store gitdir>/<relative>`, never re-derived from the name (A5 from `wt`,
   A16, A20, C4).
3. **Names.** A finding of the main store carries git's bare name. A finding of a linked
   store carries `worktrees/<id>/` + bare name, **including the current linked worktree's
   own refs** (A2, B2, B5 from `wt`). Pointer findings (`badRefOid`) keep the current
   worktree's view and its bare names (A2, A17, A19 from `wt`), as today.
4. **Root kinds.** Store root `<gitdir>/refs`:
   - absent → silent for a linked store (A10). The main store stays as today: silent,
     unpinned.
   - not a directory by `lstat` (a file or a symlink) → `refs-walk-failed` with
     `reason: 'NOT_A_DIRECTORY'` and no `unreadable-ref-path` (B6, P10, S9).
   - unreadable → as ADR-1138 (A11).
   - an unreadable subdirectory warns only (A13).
   - a store gitdir that cannot be listed for its root refs adds bit 8 and prints no line
     (H; shape DC-5).
5. **Exit bits per fault** (all gated by `checkReferences`, P11; the content msgIds re-typed
   by `fsck.<msg-id>`, P12):

   | fault | finding | default severity | bit |
   |---|---|---|---|
   | `badRefContent`, `badReferentName`, `badRefName`, `badHeadTarget` | `bad-ref` | error | 8 |
   | `cannotReadRef` (any store, HEAD included) | `bad-ref` | error, not re-typeable | 8 |
   | `symlinkRef` | `bad-ref` | warning | 0 |
   | `refMissingNewline`, `trailingRefContent`, `symrefTargetIsNotARef` | `bad-ref` | info | 0 |
   | unreadable subdirectory / entry whose `lstat` is refused | `unreadable-ref-path` | — | 0 |
   | root unreadable (`PERMISSION_DENIED`) or not a directory (`NOT_A_DIRECTORY`) | `refs-walk-failed` | — | 8 |
   | store gitdir not listable for root refs | DC-5 | — | 8 |
   | a link whose realpath fails | `refs-verify-ended`; every later store is skipped (P4, P5, Q7) | — | 8 |
   | pointer (`invalid sha1 pointer`) | `bad-ref badRefOid` | error | 2 |

6. **Root-ref check per store.** Each store's root-ref check ends at that store's first
   error-severity finding. Other stores are unaffected (P3, S10).
7. **Symlink referent.** It is stripped of the cwd's gitdir spelling (`gitDirToStrip`, as
   today) whichever store is walked (A1, B12, B13 from both working directories).
8. **No crash on a foreign HEAD.** A garbage HEAD of another worktree (A7) or of the main
   worktree from a linked cwd (A8) gives the store walk's `badRefContent` on `worktrees/<id>/HEAD`
   or `HEAD`. The snapshot skips that HEAD with no pointer, as git's `refs_resolve_ref_unsafe`
   returning NULL does.
9. **One `cannotReadRef` per unreadable HEAD**, from the store walk (P1, P2). The snapshot
   skips the HEAD and reports nothing.
10. **Listing.** A linked worktree whose own `refs` (or namespace) is not a directory lists
    nothing there and does not throw (B6 from `vt`). The rows DC-11 governs are listed there.
11. A reftable repository behaves as today.

## Design

### Shape

```
refs-verify.ts runRefsVerifyPass
  └─ RefStore.verifyIntegrity()                       (files backend, ref-store.ts)
       stores = [main] ++ linkedWorktreeAdmins(ctx)    (OS order, gitdir skip rule)
       for store of stores (until run.ended):
         walkStoreRoot(store, run)      <gitdir>/refs  → names `${store.prefix}refs/…`
         rootRefFindings(store, run)    <gitdir>/*     → names `${store.prefix}<ROOT>`
  └─ collectContentNotices: root check reset per store prefix; new grades
  └─ collectAbsentTargets: snapshot unchanged except unreadable HEADs no longer reported
                           and bad-named refs pointed at zero (DC-12)
```

`IntegrityStore` is internal to `createFilesRefStore`:

```ts
/** One ref store git's `refs verify` checks: the main one, or a linked worktree's own. */
interface IntegrityStore {
  readonly gitDir: string; // <common> for the main store, <common>/worktrees/<id> otherwise
  readonly prefix: string; // '' for the main store, `worktrees/<id>/` otherwise
  readonly linked: boolean;
}
```

The walk keeps one `IntegrityRun` across stores, so a `refsVerifyEnded` in one store skips
the rest (P4, P5, Q7). `looseBodyFindings` becomes `looseBodyFindingsAt(name, path)`, and
`readLooseContentOrRefusal` takes the path. `refDir`/`perWorktreeRefDir` are no longer
consulted on this route, which fixes A5, A16 and A20 together.

### The store root

```ts
type RootKind = 'directory' | 'absent' | 'not-a-directory';
// lstat <gitdir>/refs: FILE_NOT_FOUND → absent; !isDirectory (file, symlink) → not-a-directory
```

- `absent` adds nothing (A10, and the main store as today).
- `not-a-directory` pushes `{ msgId: 'refsWalkFailed', path, reason: 'NOT_A_DIRECTORY' }`
  (B6, P10, S9).
- `directory` takes today's `walkIntegrityRoot`: `PERMISSION_DENIED` gives
  `unreadableRefPath` + `refsWalkFailed` `reason: 'PERMISSION_DENIED'` (A11).

### Entry skips (DC-11)

The integrity walk skips a non-directory entry whose basename ends in `.lock` and does not
start with `.` (`files_fsck_refs_dir`). The listing walk `walkRefDir` skips any entry whose
basename starts with `.` or ends in `.lock` (`loose_fill_ref_dir`). Both rules are pure
predicates in a new `src/domain/refs/loose-entry-name.ts`.

### Content checks added (DC-10, DC-12)

- `badRefName`: for a non-root entry, `!isSafeRefName(prefixedName)` (Q9, A24, B1). This is
  the predicate `badReferentName` already uses. Both checks run, as `files_fsck_ref` runs
  both functions (Q9).
- `badHeadTarget`: a symbolic body on a store's `HEAD` (bare name `HEAD`) whose referent
  does not start with `refs/heads/` (B3, C1). `{ ref, msgId: 'badHeadTarget', referent }`.
  When it is graded error, the fsck layer drops that ref's `badReferentName` and
  `symrefTargetIsNotARef`, mirroring `refs_fsck_symref`'s early `return -1`. This extends the
  existing `shadowed` rule.

### fsck layer

- **`collectContentNotices`** decides a root ref on the bare name: the finding's `ref` with a
  leading `worktrees/<id>/` removed (a domain helper beside `isPerWorktreeRef`). It keeps
  `rootCheckEnded` per store prefix.
- **New grades:** `badRefName` and `badHeadTarget`, defaults error, through `retypeSeverity`.
- **`failsRefsVerify`** also counts the DC-5 finding.
- **`snapshotWorktreeHeads`** stops collecting `unreadable`, and `unreadableHeadFinding` is
  removed (DC-6). `headOf` also treats `INVALID_OBJECT_ID` as "names nothing" (DC-7).
- **`snapshotTargets`** gives a listed name failing `isSafeRefName` the zero oid (DC-12, B1,
  A24 from `wt`).
- **`types.ts`:** `refs-walk-failed.reason` widens to
  `'PERMISSION_DENIED' | 'NOT_A_DIRECTORY'`; the DC-5 arm is added.
- **`roots.ts`:** `worktreeContexts` builds on `linkedWorktreeAdmins`, so the reflog pass,
  the index pass, `rev-list`'s other-HEAD tips and the snapshot all take OS order (DC-8).

### Parts

**Part 1 — domain predicates.**

| | |
|---|---|
| Files | `src/domain/refs/per-worktree-ref.ts`; new `src/domain/refs/loose-entry-name.ts`; `src/domain/refs/symref-referent.ts` |
| Add | `linkedWorktreeRefPrefix(id: string): string` → `` `worktrees/${id}/` ``; `bareStoreRefName(name: string): string` (strips one leading `worktrees/<id>/`, else identity); `isSkippedByRefsVerify(basename: string): boolean` (`!startsWith('.') && endsWith('.lock')`); `isSkippedByLooseIterator(basename: string): boolean` (`startsWith('.') \|\| endsWith('.lock')`); `isBranchReferent(referent: string): boolean` (`startsWith('refs/heads/')`) |
| Tests | `test/unit/domain/refs/per-worktree-ref.test.ts`, new `loose-entry-name.test.ts`, `symref-referent.test.ts` (one row per branch of each predicate; `.lock`, `.x.lock`, `x.locked`, `.hidden`). Property lenses: these are not parsers and have no round-trip, so no `*.properties.test.ts`. Record why in the PR. |

**Part 2 — linked worktree enumeration in OS order.**

| | |
|---|---|
| Files | new `src/application/primitives/internal/linked-worktrees.ts`; `src/application/commands/internal/fsck/roots.ts` |
| Add | `linkedWorktreeAdmins(ctx: Context): Promise<ReadonlyArray<{ readonly id: string; readonly adminDir: string; readonly gitdirPointer: string }>>`. It reads `<commonGitDir>/worktrees` with `ctx.fs.readdirInOsOrder ?? ctx.fs.readdir` (lesson 026), and returns `[]` when that directory is absent. Per entry it reads `<adminDir>/gitdir`, skipping on `isUnopenableFile` or `''`. Move `isUnopenableFile` (roots.ts L206) and `UNOPENABLE_FILE_CODES` here; roots.ts re-imports them. |
| Change | `worktreeContexts` (roots.ts L942) maps `linkedWorktreeAdmins` through `linkedWorktreeContext` (L921), which drops its own `gitdir` read. Its `adminDir === ctx.layout.gitDir` shortcut now runs after the skip rule, so a current worktree with an empty `gitdir` is skipped too (J: no reflog finding, as git). |
| Tests | new `test/unit/application/primitives/internal/linked-worktrees.test.ts` (absent root, empty/whitespace/unreadable `gitdir`, an entry that is a file, OS order through a fake `readdirInOsOrder`); `test/unit/application/commands/fsck-worktree-reflogs-index.test.ts` (R1 order; J from the linked cwd: no `invalid-reflog-entry`), `fsck-worktree-heads.test.ts` (unchanged rows stay green) |

**Part 3 — the per-store integrity walk.**

| | |
|---|---|
| Files | `src/application/primitives/ref-store.ts` |
| Change | `verifyIntegrity` (L1512) → loop over `integrityStores()` = main `{ gitDir: commonGitDir(ctx), prefix: '' }` ++ `linkedWorktreeAdmins(ctx)`; `walkIntegrityRoot` (L1322) gains the `RootKind` lstat and the `NOT_A_DIRECTORY` finding; `walkIntegrityEntries` (L1331) names `${prefix}${relative}` and calls `looseBodyFindingsAt(name, path)`; `looseBodyFindings` (L1468) → `looseBodyFindingsAt(name: RefName, path: string)`; `readLooseContentOrRefusal` (L1438) takes `path`; `rootRefFindings` (L1523) takes the store (`readdirInOsOrder(store.gitDir)`; a `PERMISSION_DENIED` listing pushes the DC-5 finding); `isSkippedByRefsVerify` on non-directory entries. Remove `refsWalkRoots` (L1115) once unused. |
| Types | `RefIntegrityFinding` (L247): `refsWalkFailed` gains `reason: 'PERMISSION_DENIED' \| 'NOT_A_DIRECTORY'`; add the DC-5 arm `{ msgId: 'rootRefsUnlisted'; path: string }` |
| Keep | `gitDirToStrip` (L1382) and `linkReferentFindings` (L1393) unchanged: they already strip the cwd's gitdir (requirement 7) |
| Tests | `test/unit/application/primitives/ref-store.test.ts` (main/linked naming, read-at-path for A5/A16/A20, root kinds B6/P10/S9/A10/A11, root refs P3/S10/P2, run end across stores P4/P5/Q7, `.lock` B7); `ref-store-symlinked-refs.test.ts` (A1/B12/B13 from both working directories, foreign store stripped by the cwd's gitdir) |

**Part 4 — `badRefName` and `badHeadTarget` facts.**

| | |
|---|---|
| Files | `src/application/primitives/ref-store.ts` (`walkIntegrityEntries`, `looseBodyFindingsAt`, `referentFindings` L1501) |
| Add | `{ ref; msgId: 'badRefName' }` before the body facts for a non-root entry; `{ ref; msgId: 'badHeadTarget'; referent }` when `bareStoreRefName(ref) === 'HEAD'` and `!isBranchReferent(referent)`, ahead of the referent facts |
| Tests | `ref-store.test.ts` (Q9 both facts, A24 prefixed, B1, B3, C1, a detached HEAD gets none) |

**Part 5 — listing skips and the own-namespace `ENOTDIR`.**

| | |
|---|---|
| Files | `src/application/primitives/ref-store.ts` `walkRefDir` (L1065), `walkTarget` (L1209) |
| Change | `walkRefDir` drops entries matching `isSkippedByLooseIterator`; `walkTarget` treats `NOT_A_DIRECTORY` on an `ownNamespace` target like `PERMISSION_DENIED` (`[]`) |
| Tests | `ref-store.test.ts` (Q8 `listRefNames`/`listRefs` drop `x.lock` and `y.lock`; Q9 `.x.lock` unlisted; B6 from `vt`: no throw, namespace empty); `ref-store-file-in-ref-path.test.ts` for the `ENOTDIR` row |

**Part 6 — the fsck layer.**

| | |
|---|---|
| Files | `src/application/commands/internal/fsck/refs-verify.ts`, `roots.ts`, `types.ts` |
| Change | `collectContentNotices` (L233): per-store `rootCheckEnded` keyed on the `worktrees/<id>/` prefix, root test on `bareStoreRefName`; `CONTENT_MSG_IDS`, `ContentFinding`, `ContentGrades`/`gradesOf`, `ownGrade`, `contentFinding` gain `badRefName` and `badHeadTarget`; `badHeadTarget` (error) shadows the same ref's referent facts; `walkNoticeOf` (L212) maps `rootRefsUnlisted`; `refsWalkFailedFinding` copies `reason`; `failsRefsVerify` (L222) counts the DC-5 arm; `snapshotTargets` (L305) zero-points a listed name failing `isSafeRefName`; delete `unreadableHeadFinding` (L325) and `RefSnapshot.unreadable`; `headOf` (roots.ts L907) returns `NO_HEAD` on `INVALID_OBJECT_ID` and drops the `unreadable` read; `WorktreeHeadSnapshot.unreadable` and `UnreadableHead` go. `types.ts` L78 widens `reason`; add the DC-5 arm |
| Tests | `test/unit/application/commands/fsck-worktree-heads.test.ts` (L250 block: P1 `ref` unchanged, now from the walk; P2's `ref` becomes `HEAD`; A7, A8 no throw), `fsck-broken-ref-chain.test.ts` (per-store root stop P3), `fsck-configured-severity.test.ts` (P12, `fsck.badRefName`, `fsck.badHeadTarget`), `fsck-symlinked-ref.test.ts` (prefixed names), `fsck.test.ts` (P11) |

**Part 7 — interop.**

| | |
|---|---|
| Files | new `test/integration/fsck-worktree-private-refs-interop.test.ts`; `test/integration/fsck-broken-ref-chain-interop.test.ts` |
| New suite | Its own seeder: main repo + N linked worktrees in a given creation order + hand-made admin dirs + `files`/`links`/`restricted` keyed by gitdir-relative path; cwd `w` or a named worktree. One row per required-column row above. Content and walk lines compared as a sorted multiset, pointer lines in sequence (house rule); the die rows (P4, P5, Q7) compare the whole multiset, so a lost store shows. Store order (P6, Q7) is derived from git's own output on the same throwaway, never hard-coded (lesson 026). Every `openRepository`/`createNodeContext` goes through `test/integration/repository-lifecycle.ts` `trackedRepositories`/`trackedContexts` from the first draft. Rows needing `chmod` are POSIX + non-root only, as `UNPRIVILEGED` gates them today. |
| Old suite | `shownRef` (L1198) is deleted: tsgit now carries the prefix. `printedPath` (L1176) follows the spelling rule above (linked cwd: absolute; main cwd: relative except a linked store's root-ref path). The body lookup in `rebuiltLines` strips the prefix before indexing `row.refs`/`row.root`. |

**Part 8 — docs.**

| | |
|---|---|
| Files | `docs/use/commands/fsck.md` (L131, L163, L180, L270, new arm row); `docs/design/fsck.md` msg-id table (`badRefName`, `badHeadTarget` now emitted); `docs/design/fsck-broken-ref-chain-unreadable.md` L616 (replace the unpinned assumption with a pointer to this design's A1/B12/B13) |

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| DC-1 | Walk scope and store enumeration | (a) every store from any cwd; a lightweight primitive `linkedWorktreeAdmins` (id, admin dir, OS order, `gitdir` skip rule) that `worktreeContexts` also builds on; (b) every store through `worktreeContexts`' derived Contexts and `getRefStore(worktreeCtx)` per store; (c) the current worktree only, prefix added | **(a)** | git walks every store from any cwd (A1, A2, A16, A20, C4). (b) needs the cwd's gitdir for stripping (A1 from `w` would turn into an error), mints a Context per store (lesson 030) and pulls a command-layer helper into primitives. (c) stays red on A1, A2, A16, A20 and C4 from `w`. |
| DC-2 | Where the store loop lives | (a) inside `verifyIntegrity()`, no signature change, one `IntegrityRun` across stores; (b) `verifyIntegrity(store)` per store, looped in `refs-verify.ts` | **(a)** | `RefStore.verifyIntegrity` keeps meaning "git's `refs verify`". The run's end crosses stores for free (P4, P5, Q7). The reftable backend keeps its no-argument method and is not walked N times. |
| DC-3 | Display names | (a) prefix in `ref` (`worktrees/<id>/…` for every linked store, the current one included; bare for main), as git's refname namespace and `unreadableHeadFinding` already do; (b) bare `ref` + `worktree?: string`; (c) both | **(a)** | git's name is the datum (A2 from `wt`). Names are unique across stores. The interop drops `shownRef`. Consequence: from a linked cwd, the own garbage ref reports `worktrees/wt/refs/bisect/bad badRefContent` beside `refs/bisect/bad badRefOid`, exactly git's pair. This changes the `ref` a consumer sees on a linked cwd today: a breaking data change to name in the changelog. |
| DC-4 | A store root that is not a directory (B6, P10, S9) | (a) `refs-walk-failed` with `reason: 'NOT_A_DIRECTORY'`, no `unreadable-ref-path`, rendered `error: cannot open directory <p>: Not a directory`; (b) a new arm `refs-root-not-directory` | **(a)** | It is the same git outcome (the iteration over a root failed, bit 8). The reason already discriminates the line. One arm stays one arm. |
| DC-5 | A store gitdir whose root refs cannot be listed (H: bit 8, no line) | (a) a new arm `{ type: 'unlistable-root-refs'; path; reason: 'PERMISSION_DENIED' }`, bit 8, gated, rendered as no line; (b) bit 8 with no finding (the cache-tree precedent in the exit table); (c) map it onto `refs-walk-failed` | **(a)** | ADR-249 wants the data behind every bit. (b) leaves an exit code no finding explains. (c) would render `failed to iterate over`, which git never prints here. |
| DC-6 | The source of an unreadable HEAD's `cannotReadRef` | (a) the store walk's root refs; the snapshot's `UnreadableHead` is retired; P2's `ref` becomes `HEAD`; (b) keep the snapshot as the source and skip `HEAD` in the root-ref walk | **(a)** | git's line is the child's (`git refs verify` alone prints it: P1, P2). Under (a) the error also ends that store's root check as git's does. (b) would let later root refs of that store report where git stops. |
| DC-7 | Garbage foreign HEAD in the snapshot (A7, A8) | (a) `headOf` treats `INVALID_OBJECT_ID` as "names nothing"; (b) the HEAD reader (`resolveHeadDirect` → `parseLooseRef`) throws `INVALID_REF` for an unparseable body | **(a)** | It is local to fsck's snapshot. (b) changes a shared reader on every HEAD route (gc retention, rev-list, …), none of them pinned for this. |
| DC-8 | Worktree order | (a) OS `readdir` order in `linkedWorktreeAdmins`, which every `worktreeContexts` caller inherits (the reflog pass, the index pass, `rev-list` other-HEAD tips, the snapshot); (b) OS order for the store walk only, `worktreeContexts` stays sorted | **(a)** | Q7 (×3) pins it for the store walk and R1/R2 (×2) for the reflog pass. git has one `get_worktrees`. (b) keeps a proven wrong order (R1) and two enumerations. Risk: `rev-list`'s "first absent other HEAD dies" now follows OS order. That is git's order, but no row pins it. |
| DC-9 | 32.49 (`main-worktree/` resolution) | (a) keep it separate: ship next in the same release-order row; (b) fold the read side: `resolveDirect` maps `main-worktree/<per-worktree>` to the main worktree's store (and its HEAD reader), plus the A25/B8/B14 interop rows | **(a)** | Its locus is the shared resolver, which reaches `rev-parse`, `log`, symbolic-ref chains and the write routes (`perWorktreeRefDir` serves writes too), and each needs pins of its own. `worktrees/<id>/…` already resolves where git does (A26, A27, B14). This change shares no code with it: the store walk knows each bare name without parsing. |
| DC-10 | `badHeadTarget` (B3 in family, C1 the main-store twin) | (a) fold: one fact in the walk, a grade, a shadow rule; (b) leave it out | **(a)** | It is the same code line for every store's `HEAD`, so folding B3 folds C1. The cost is one msgId already catalogued, plus 2 unit and 3 interop rows. |
| DC-11 | `.lock` and dot names (B7 in family; C2, Q8 and Q9 the rest) | (a) fold both halves: the integrity walk skips `*.lock` unless dot-led, and the listing skips dot-led and `*.lock`; (b) the walk only; (c) leave it out | **(a)** | (b) leaves B7 at exit 2, because the listing still zero-points `bad.lock`. The listing half is git's `loose_fill_ref_dir`: `for-each-ref` and `branch` hide `y.lock` (Q8). It reaches every listing consumer, faithfully. The cost is two predicates and two call sites. |
| DC-12 | `badRefName` (A24 in family; B1 and Q9 the rest) | (a) fold: the content fact on the prefixed name with `isSafeRefName`, plus a zero pointer in fsck's snapshot for a listed name failing it; (b) the content fact only; (c) leave it out | **(a)** | Both halves are fsck-local. (b) leaves A24 from `wt` and B1 at 8 where git gives 10. Hiding broken names from `branch`/`for-each-ref` (E1) is outside the perimeter and stays out. Risk: `isSafeRefName` also rejects the Unicode direction overrides, which git's `check_refname_format` may accept (see Risks). |
| DC-13 | Interop layout | (a) a new suite `fsck-worktree-private-refs-interop.test.ts` with a multi-worktree seeder, plus the minimal harness edits to the old one; (b) extend `fsck-broken-ref-chain-interop.test.ts` | **(a)** | The old suite (1461 lines) seeds one linked worktree. These rows need several, in a set creation order, plus hand-made admin dirs. The old suite still has to drop `shownRef` and fix `printedPath`, because its linked rows change names. |

Pinned, no choice left (recorded so the decisions phase does not reopen them):

- the cwd-relative referent strip (requirement 7: A1, A6, B12, B13);
- the exit bits of requirement 5;
- the snapshot's pointer scope (A17 from `w`: another worktree's refs get no pointer);
- the main store's packed-refs-only `packed_fsck` (A14, A15).

## Test strategy

- **Unit (memory adapter, TDD per part).** Every required-column row whose shape the memory
  file system can express: symlinks, files in place of directories, mode refusals through
  the adapter's permission hooks, as the existing `ref-store-symlinked-refs` and
  `fsck-worktree-heads` suites already do. `sut` is the store or `fsck`; GWT titles; AAA.
  - Each refusal-guard branch gets its own test (`FILE_NOT_FOUND` vs `NOT_A_DIRECTORY` vs
    `PERMISSION_DENIED` at the root, the subdirectory, the `gitdir` file and the admin-dir
    listing).
  - Error assertions read `.data`.
- **Order tests** use a fake `readdirInOsOrder` that returns a non-sorted order, and assert
  that the findings follow it (DC-8). One more test proves the fallback to `readdir` when
  the capability is absent.
- **Interop** (Part 7). Every row of the matrix that is not n/a, from each cwd it was pinned
  from. Git's lines are the oracle; tsgit's are rebuilt from structured fields (ADR-249).
  OS-order rows derive their expectation from git's output on the same throwaway, and run on
  fresh fixtures several times per lesson 022/023 (the suite's `it` repeats the arrange; no
  hard-coded order).
- **Mutation.** Run Stryker narrowed per mutated file, on its own suites
  (`.claude/workflow/mutation.md`). The likely survivors are the prefix-key reset in
  `collectContentNotices` and the dot-led exception in `isSkippedByRefsVerify`; each has an
  isolated test.
- **Coverage** 100% on the touched files; no ignore directives.

## Risks

- **Breaking data change** for linked-cwd consumers: `ref` gains `worktrees/<id>/` on content
  findings, P2's `ref` changes from `main-worktree/HEAD` to `HEAD`, and `UnreadableHead`
  leaves the `snapshotWorktreeHeads` result (internal; `worktreeHeads` keeps its shape).
- **`isSafeRefName` vs `check_refname_format`.** `validateRefName` also rejects
  U+202A–U+202E and U+2066–U+2069. Proof route: seed `refs/heads/a<U+202E>b` and compare
  `git fsck` with tsgit. If git accepts the name, DC-12's predicate needs git's grammar,
  and `badReferentName` has the same gap.
- **The main store's absent `refs`** stays silent: git errors there, but no route opens such
  a repository. Unpinned.
- **Platform.** Every row was pinned on APFS. OS order differs on ext4, and the interop derives
  it from git on the same directory. Windows has no 000 modes, so the chmod rows are POSIX-only.
- **Cost.** One `readdir` of `.git/worktrees`, one `gitdir` read per entry, and one walk per
  linked store's `refs`. Linked stores hold few refs; the main-store walk is unchanged.

## Out of scope

- `main-worktree/` and `worktrees/<id>/` resolution in the shared resolver (32.49, DC-9).
- `branch` and `for-each-ref` hiding broken-named refs with `ignoring ref with broken name`
  (E1): a listing-consumer change outside fsck.
- `badRefFiletype` (a FIFO or socket under `refs/`): unpinned here, same pass, no row needs it.
- Reftable linked-worktree stores: tsgit's reftable `verifyIntegrity` is unchanged.
- The fsck file-system call count (32.50).
