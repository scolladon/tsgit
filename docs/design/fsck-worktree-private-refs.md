# Design — fsck checks every worktree's private refs and names them as git does

> Brief: backlog 32.48. `fsck` never checks another worktree's per-worktree refs, and it
> names its own without the `worktrees/<id>/` prefix. git 2.56's `refs verify` child walks
> **every** worktree's ref store from any cwd: the main store first with no prefix, then each
> `.git/worktrees/<id>` with the prefix `worktrees/<id>/`. tsgit walks only the current
> worktree's view, reads each body by name instead of at the walked path, and crashes on
> another worktree's garbage HEAD. Bring the ref-content pass to git's store-by-store walk.
> Pinned on git 2.56.0. The read side of 32.49 (`main-worktree/` and `worktrees/<id>/` names
> in the shared resolver) folds in (ADR-1158), so this change ticks backlog rows 32.48 and
> 32.49; the write side stays out.
> Status: draft → self-reviewed ×3 → revised against ADRs 1150–1162 (self-reviewed ×3)

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
  - `refs.c` `parse_worktree_ref` and `files-backend.c` `files_ref_path` locate every loose
    read **and** write. `is_current_worktree_ref` is root-ref syntax or `refs/bisect/`,
    `refs/worktree/`, `refs/rewritten/`.
    - `worktrees/<id>/<bare>`, `<bare>` per-worktree (`REF_WORKTREE_OTHER`) →
      `<common>/worktrees/<id>/<bare>`.
    - `main-worktree/<bare>`, `<bare>` per-worktree (`REF_WORKTREE_MAIN`) → `<common>/<bare>`.
    - any other name: the own gitdir when it is per-worktree (`REF_WORKTREE_CURRENT`), else
      `<common>/<full name>` (`REF_WORKTREE_SHARED`), so `main-worktree/refs/heads/main` is
      looked up at `<common>/main-worktree/refs/heads/main` and misses.
    - `read_ref_internal` falls back to `packed-refs` on a loose `ENOENT`, under the **full**
      name.
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
  - The shared resolver, `src/application/primitives/resolve-ref.ts`:
    - `resolveDirectChain` (L205) follows every hop through `RefStore.resolveDirect`.
      `readRefCandidate` (L159: the `rev-parse` ladder at rev-parse.ts L519/L533,
      `internal/revision-name.ts`, `rev-list.ts`) and `resolveRef` (fsck's `targetOf`,
      refs-verify.ts L287) sit on it.
    - The write side shares the same reader: `internal/ref-write-chain.ts`
      (`walkSymbolicChain`, `readReferentValue` through `resolveDirectChain`,
      `resolveWithoutDeref`) and the store's own `checkExpected` (ref-store.ts L1533),
      `refIsPresent` (L2132) and `stillHoldsPackedValue` (L2377).
    - The files `resolveDirect` (ref-store.ts L1018) reads at `looseRefPath(refDir(name), name)`,
      with `refDir` = `perWorktreeRefDir` (path-layout.ts L48): the own gitdir for a
      per-worktree name, the common dir for any other. `readLooseContent` (L835), reached from
      `leafAfterRefusedOpen` (L947), re-derives the same path from the name. The write routes
      build their paths with the same `refDir` (L1832, L2071, …).
    - Hence `main-worktree/HEAD` is looked up at `<common>/main-worktree/HEAD` and misses
      (C3 `OBJECT_NOT_FOUND`; A25 and B8, where `targetOf` zero-points `refs/heads/x`).
      `worktrees/<id>/<name>` lands at `<common>/worktrees/<id>/<name>`. For a per-worktree
      `<name>` that is git's `REF_WORKTREE_OTHER` path, and for any other `<name>` it is git's
      `REF_WORKTREE_SHARED` path. The two spellings are the same string, which is why A26, A27
      and the `worktrees/` half of B14/C3 already match.
    - The reftable backend locates names with `perWorktreeRefDir` too
      (reftable-ref-store.ts L166).
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
  rows use `getRefStore(createNodeContext({ workDir })).listRefNames()/listRefs()`. C3 uses
  `revParse(name)`; W14 uses `primitives.updateRef(name, oid, {})`.
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
| A25 | `refs/heads/x` = `ref: main-worktree/HEAD` | w, wt | `warning: refs/heads/x: symrefTargetIsNotARef: points to non-ref target 'main-worktree/HEAD'` | 0 | ✗ + `badRefOid` zero, 2 | `refs/heads/x symrefTargetIsNotARef info` only, exit 0: the chain resolves at `<common>/HEAD` (ADR-1158) |
| B8 | `refs/heads/x` = `ref: main-worktree/refs/bisect/bad` | w, wt | the same warning, that target | 0 | ✗ + `badRefOid` zero, 2 | that finding only, exit 0: the chain resolves at `<common>/refs/bisect/bad` (ADR-1158) |
| A26/A27 | `ref: worktrees/wt/HEAD`, `ref: worktrees/wt/refs/bisect/bad` | w, wt | — | 0 | ✓ (the path `<common>/worktrees/wt/…` exists, which matches git's `REF_WORKTREE_OTHER` path) | — |
| B14/C3 | `rev-parse --verify`: `main-worktree/HEAD`, `worktrees/wt/HEAD`, `worktrees/wt/refs/bisect/bad` resolve; `main-worktree/refs/heads/main`, `worktrees/wt/refs/heads/side`, `worktrees/nope/HEAD` → `fatal: Needed a single revision` 128 | w, wt | — | — | ✗ `main-worktree/HEAD` throws `OBJECT_NOT_FOUND`; the rest ✓ | the three resolve to git's oid from both working directories; the three refused throw `OBJECT_NOT_FOUND` (ADR-1158) |
| B15 | MAIN loose `refs/bisect/bad`; `packed-refs` holds `refs/bisect/packed` and `main-worktree/refs/bisect/fullname`; `rev-parse --verify` of `main-worktree/refs/bisect/bad`, `…/packed`, `…/fullname`, `main-worktree/ORIG_HEAD` (absent), `worktrees/wt` | w, wt | — ; `bad` and `fullname` resolve; `packed`, `ORIG_HEAD` and `worktrees/wt` → `fatal: Needed a single revision` 128: the packed fallback uses the full name | — | ✗ `bad` throws `OBJECT_NOT_FOUND`; the rest ✓ | `bad` resolves; the rest as today (ADR-1158) |
| E1 | MAIN `refs/heads/a..b` = oid | w | `for-each-ref` and `branch`: `warning: ignoring ref with broken name refs/heads/a..b`, name omitted | 0 | ✗ `listRefs` includes it | out of perimeter (listing consumers) |
| W14 | `update-ref <name> <older oid>` for `main-worktree/HEAD`, `main-worktree/refs/bisect/x`, `worktrees/wt/refs/bisect/y` (write side, git and tsgit each on a fresh throwaway) | wt | — ; git moves `refs/heads/main` through the main HEAD, writes `<common>/refs/bisect/x`, writes `<common>/worktrees/wt/refs/bisect/y` | 0 | ✗ the first two write the stray files `<common>/main-worktree/HEAD` and `<common>/main-worktree/refs/bisect/x`; the third ✓ | unchanged: the write side is out of this change (ADR-1158) and must not see the read-side mapping (DC-14) |
| X1 | linked admin dir renamed to `w:t` (its work tree's `.git` file rewritten) holding `refs/bisect/good`, `ORIG_HEAD`, `BISECT_HEAD`, all valid ids | w, wt | `error: worktrees/w:t/refs/bisect/good: badRefName: invalid refname format` and `error: worktrees/w:t/BISECT_HEAD: badRefName: invalid refname format` (`ORIG_HEAD` unreported: the per-store root-ref check stops at its first error, `BISECT_HEAD` listed first) | 8 | ✗ no name fact on a root ref | `badRefName` on the prefixed name of a linked store's root ref, before its body facts; the main store's bare root names are exempt |
| X2 | `mkfifo worktrees/wt/refs/bisect/bad` | w, wt | `error: worktrees/wt/refs/bisect/bad: badRefFiletype: unexpected file type` (never opened; name and content checks do not run) | 8 | ✗ opens it, hangs | `worktrees/wt/refs/bisect/bad badRefFiletype error`, never read, never listed |
| X3 | `mkfifo BISECT_HEAD` in the main gitdir and in `worktrees/wt` | w, wt | — | 0 | ✗ opens it, hangs | nothing: a root ref that is not a regular file is passed over |
| X4 | main gitdir `BISECT_HEAD` a symbolic link to a named pipe | w | — | 0 | ✗ opens it, hangs | nothing: a root-ref link is followed by a stat, and a target that is not a regular file is passed over |
| X5 | `mkfifo refs/bisect/bad` in the main store | w | `error: refs/bisect/bad: badRefFiletype: unexpected file type` | 8 | ✗ opens it, hangs | `refs/bisect/bad badRefFiletype error` |

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
12. **Read-side worktree ref namespace** (ADR-1158). On the files backend, every read through
    `RefStore.resolveDirect` locates `main-worktree/<bare>` with a per-worktree `<bare>`
    (`isPerWorktreeRef`) at `<common>/<bare>`. A loose miss there falls back to `packed-refs`
    under the full name, as git's does (B15). `worktrees/<id>/<bare>` keeps today's
    `<common>/worktrees/<id>/<bare>`, which is git's path for either kind of `<bare>`. Every
    other name keeps today's location. So:
    - `revParse` resolves `main-worktree/HEAD`, and `main-worktree/refs/bisect/bad` when the
      main worktree holds it (B15), from either working directory. From the main one `<common>` is its
      own gitdir (B14, C3).
    - `main-worktree/refs/heads/main`, `worktrees/wt/refs/heads/side` and
      `worktrees/nope/HEAD` stay unresolved (B14, C3).
    - A symref chain through `ref: main-worktree/<per-worktree name>` resolves, so fsck's
      snapshot adds no pointer (A25, B8).
13. **Write side unchanged.** No write route sees requirement 12's mapping. Each one reads and
    writes at today's location: the store's compare-and-swap and presence reads, and
    the write chain in `ref-write-chain.ts` (DC-14). W14 stays as it is today.

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

resolve-ref.ts resolveDirectChain ── RefStore.resolveDirect(name)
                                       read locator: main-worktree/<pw> → <common>/<pw>
ref-write-chain.ts, checkExpected,  ── RefStore.resolveDirectForWrite(name)   (DC-14 (a))
refIsPresent                           write locator: refDir(name), as today
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

### Read-side worktree ref namespace (ADR-1158)

The domain gets git's `REF_WORKTREE_MAIN` arm of `parse_worktree_ref`:

```ts
// src/domain/refs/per-worktree-ref.ts
/** The name `main-worktree/<bare>` stands for in the main worktree's store, when `<bare>` is
 *  per-worktree; `undefined` for every other name, which git looks up as spelled. */
export const mainWorktreeBareName = (name: RefName): RefName | undefined
```

The files store keeps two loose locators:

```ts
interface LooseLocation {
  readonly dir: string;  // the git dir the name is stored under (packed-refs probe, ENOTDIR climb root)
  readonly path: string; // the loose file
}
writeLocation(name) = { dir: refDir(name), path: looseRefPath(refDir(name), name) }  // today
readLocation(name)  = mainWorktreeBareName(name) === undefined
  ? writeLocation(name)
  : { dir: commonGitDir(ctx), path: looseRefPath(commonGitDir(ctx), bare) }
```

- **Reads.** Today's `resolveDirect` body becomes `resolveDirectAt(name, location)`.
  `RefStore.resolveDirect(name)` = `resolveDirectAt(name, readLocation(name))`. `HEAD` keeps
  `resolveHeadDirect` before either locator. `readLooseContentAt(path)` (Part 3) already
  serves `leafAfterRefusedOpen` with the path it was given, so the read locator reaches the
  plain-reader fallback too. The packed fallback keeps the full name (`resolveAfterLooseMiss(name, dir, path)`).
- **No `worktrees/<id>/` branch.** Today's location already spells git's path for both kinds
  of `<bare>`, so a branch for it would only add an equivalent mutant. The B14, C3, A26 and A27
  unit and interop rows pin the path.
- **Writes: the guard** (DC-14, written here as its recommendation (a); the planning phase
  takes the ratified option). `RefStore` gains `resolveDirectForWrite(name)` =
  `resolveDirectAt(name, writeLocation(name))`. It is the only reader on a write route:
  - the store's `checkExpected` and `refIsPresent`, which take names from the caller's
    updates;
  - `ref-write-chain.ts`: `walkSymbolicChain` and `resolveWithoutDeref` call it, and
    `readReferentValue` hands `resolveDirectChain` the write view
    `{ resolveDirect: store.resolveDirectForWrite }`.

  `resolveDirectChain`'s first parameter narrows to `Pick<RefStore, 'resolveDirect'>`, so
  the write chain can hand it the write view. The guard is those call sites, pinned by the
  fake-store test in Part 7; nothing in the type system stops a new write route from calling
  `resolveDirect`, so the doc comment on `resolveDirectForWrite` names the rule. The reftable store sets
  `resolveDirectForWrite: resolveDirect`, and `withPseudoRefFiles` routes both methods.
  Readers on a write route whose names the read locator never maps stay on `resolveDirect`:
  `stillHoldsPackedValue` (names from the loose walk under `refs/`), `update-ref.ts` L255
  (`HEAD`) and `branch.ts` L315/L529 (`refs/heads/*`).
- **fsck and rev-parse need no code.** fsck's `targetOf` → `resolveRef`, and `revParse` →
  `readRefCandidate`, both reach the read locator through `resolveDirectChain`. The
  `symrefTargetIsNotARef` info on `main-worktree/…` referents stays as it is today.
- **From the main worktree,** `main-worktree/HEAD` is read at `<common>/HEAD` (its own HEAD)
  by the loose reader, not by `resolveHeadDirect`. Both readers apply `resolveSymlinkedRef`'s
  rule, so the value is the same. No row pins a symlinked main HEAD read through the
  namespace.

### Parts

**Part 1 — domain predicates.**

| | |
|---|---|
| Files | `src/domain/refs/per-worktree-ref.ts`; new `src/domain/refs/loose-entry-name.ts`; `src/domain/refs/symref-referent.ts` |
| Add | `linkedWorktreeRefPrefix(id: string): string` → `` `worktrees/${id}/` ``; `bareStoreRefName(name: string): string` (strips one leading `worktrees/<id>/`, else identity); `isSkippedByRefsVerify(basename: string): boolean` (`!startsWith('.') && endsWith('.lock')`); `isSkippedByLooseIterator(basename: string): boolean` (`startsWith('.') \|\| endsWith('.lock')`); `isBranchReferent(referent: string): boolean` (`startsWith('refs/heads/')`); `mainWorktreeBareName(name: RefName): RefName \| undefined` (the remainder after `main-worktree/` when `isPerWorktreeRef` accepts it, else `undefined`) |
| Tests | `test/unit/domain/refs/per-worktree-ref.test.ts`, new `loose-entry-name.test.ts`, `symref-referent.test.ts` (one row per branch of each predicate; `.lock`, `.x.lock`, `x.locked`, `.hidden`). `mainWorktreeBareName`: `main-worktree/HEAD` → `HEAD`, `main-worktree/ORIG_HEAD`, `main-worktree/refs/bisect/bad`, `main-worktree/refs/worktree/x`, `main-worktree/refs/rewritten/x` → the remainder; `main-worktree/refs/heads/main`, `refs/heads/main`, `HEAD`, `worktrees/wt/HEAD`, `main-worktreeX/HEAD` → `undefined`. Property lenses: the four predicates are not parsers and have no round-trip, so they get no property. `mainWorktreeBareName` is a name parser: new `per-worktree-ref.properties.test.ts`, built on `test/unit/domain/refs/arbitraries.ts`. Round-trip: `mainWorktreeBareName('main-worktree/' + n) === n` for every per-worktree `n`. Totality: `undefined` for every shared `n`, and for any name without the prefix. |

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
| Change | `verifyIntegrity` (L1512) → loop over `integrityStores()` = main `{ gitDir: commonGitDir(ctx), prefix: '' }` ++ `linkedWorktreeAdmins(ctx)`; `walkIntegrityRoot` (L1322) gains the `RootKind` lstat and the `NOT_A_DIRECTORY` finding; `walkIntegrityEntries` (L1331) names `${prefix}${relative}` and calls `looseBodyFindingsAt(name, path)`; `looseBodyFindings` (L1468) → `looseBodyFindingsAt(name: RefName, path: string)`; `readLooseContentOrRefusal` (L1438) takes `path`; `readLooseContent(name)` (L835) → `readLooseContentAt(path)`, its other caller `leafAfterRefusedOpen` (L947) passing the path it holds; `rootRefFindings` (L1523) takes the store (`readdirInOsOrder(store.gitDir)`; a `PERMISSION_DENIED` listing pushes the DC-5 finding); `isSkippedByRefsVerify` on non-directory entries. Remove `refsWalkRoots` (L1115) once unused. |
| Types | `RefIntegrityFinding` (L247): `refsWalkFailed` gains `reason: 'PERMISSION_DENIED' \| 'NOT_A_DIRECTORY'`; add the DC-5 arm `{ msgId: 'rootRefsUnreadable'; path: string }` |
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
| Change | `collectContentNotices` (L233): per-store `rootCheckEnded` keyed on the `worktrees/<id>/` prefix, root test on `bareStoreRefName`; `CONTENT_MSG_IDS`, `ContentFinding`, `ContentGrades`/`gradesOf`, `ownGrade`, `contentFinding` gain `badRefName` and `badHeadTarget`; `badHeadTarget` (error) shadows the same ref's referent facts; `walkNoticeOf` (L212) maps `rootRefsUnreadable` to the new `unreadable-root-refs` arm; `refsWalkFailedFinding` copies `reason`; `failsRefsVerify` (L222) counts the DC-5 arm; `snapshotTargets` (L305) zero-points a listed name failing `isSafeRefName`; delete `unreadableHeadFinding` (L325) and `RefSnapshot.unreadable`; `headOf` (roots.ts L907) returns `NO_HEAD` on `INVALID_OBJECT_ID` and drops the `unreadable` read; `WorktreeHeadSnapshot.unreadable` and `UnreadableHead` go. `types.ts` L78 widens `reason`; add the DC-5 arm `{ type: 'unreadable-root-refs'; path: string; reason: 'PERMISSION_DENIED' }` |
| Tests | `test/unit/application/commands/fsck-worktree-heads.test.ts` (L250 block: P1 `ref` unchanged, now from the walk; P2's `ref` becomes `HEAD`; A7, A8 no throw), `fsck-broken-ref-chain.test.ts` (per-store root stop P3), `fsck-configured-severity.test.ts` (P12, `fsck.badRefName`, `fsck.badHeadTarget`), `fsck-symlinked-ref.test.ts` (prefixed names), `fsck.test.ts` (P11) |

**Part 7 — the read-side worktree ref namespace.**

| | |
|---|---|
| Files | `src/application/primitives/ref-store.ts`; `src/application/primitives/resolve-ref.ts`; `src/application/primitives/internal/ref-write-chain.ts` |
| Decision | DC-14 must be ratified first; the rows below assume its recommendation (a). Under (b), `resolveDirectForWrite` and the `Pick` narrowing drop out and the write-route rows change |
| Change | In `createFilesRefStore` (L797): add `writeLocation`/`readLocation` (see "Read-side worktree ref namespace"); today's `resolveDirect` (L1018) body becomes `resolveDirectAt(name, location)`; `resolveDirect` uses `readLocation`; new `resolveDirectForWrite` uses `writeLocation`; `checkExpected` (L1533) and `refIsPresent` (L2132) call `resolveDirectForWrite`; `stillHoldsPackedValue` (L2377) stays on `resolveDirect` (walked names only). `RefStore` (L93) gains `resolveDirectForWrite(name: RefName): Promise<ResolveDirectResult>`; `withPseudoRefFiles` (L694) routes it as it routes `resolveDirect`; `createReftableRefStore` returns `resolveDirectForWrite: resolveDirect`. `resolveDirectChain(refStore: Pick<RefStore, 'resolveDirect'>, …)` (resolve-ref.ts L205). `ref-write-chain.ts`: `walkSymbolicChain` (L49) and `resolveWithoutDeref` (L106) call `store.resolveDirectForWrite`; `readReferentValue` (L88) passes `{ resolveDirect: store.resolveDirectForWrite }`. No change in `rev-parse.ts`, `refs-verify.ts` or `path-layout.ts` |
| Keep | `refDir`/`perWorktreeRefDir` and every write path builder unchanged (requirement 13); `resolveHeadDirect` for `HEAD` |
| Tests | `test/unit/application/primitives/commondir-refs.test.ts` (main and child Contexts: `main-worktree/HEAD`, `main-worktree/refs/bisect/bad` loose; B15's packed pair: `main-worktree/refs/bisect/packed` missing although `refs/bisect/packed` is packed, `main-worktree/refs/bisect/fullname` found under its full packed name; `main-worktree/refs/heads/main` missing even when `refs/heads/main` exists, `worktrees/wt/HEAD`, `worktrees/wt/refs/bisect/bad`, `worktrees/wt/refs/heads/side` and `worktrees/nope/HEAD` missing); `resolve-ref.test.ts` (`resolveRef` through `refs/heads/x` = `ref: main-worktree/HEAD` → main HEAD → `refs/heads/main`; `readRefCandidate('main-worktree/HEAD')` found from both Contexts); `ref-write-chain.test.ts` (the guard: a fake `RefStore` whose `resolveDirect` and `resolveDirectForWrite` answer differently; `walkSymbolicChain`, `resolveWithoutDeref` and `readReferentValue` consume only `resolveDirectForWrite`); `ref-store-transaction-prepare.test.ts` (one characterization row per store-internal write reader, `checkExpected` and `refIsPresent`, on a mapped name: it reads at `writeLocation`, as today. The write-side change flips these rows); `fsck-broken-ref-chain.test.ts` (A25, B8: `symrefTargetIsNotARef` only, no `badRefOid`, exit 0); `rev-parse.test.ts` (C3 from both Contexts) |

**Part 8 — interop.**

| | |
|---|---|
| Files | new `test/integration/fsck-worktree-private-refs-interop.test.ts`; `test/integration/fsck-broken-ref-chain-interop.test.ts` |
| New suite | Its own seeder: main repo + N linked worktrees in a given creation order + hand-made admin dirs + `files`/`links`/`restricted` keyed by gitdir-relative path; cwd `w` or a named worktree. One row per required-column row above. Content and walk lines compared as a sorted multiset, pointer lines in sequence (house rule); the die rows (P4, P5, Q7) compare the whole multiset, so a lost store shows. Store order (P6, Q7) is derived from git's own output on the same throwaway, never hard-coded (lesson 026). Every `openRepository`/`createNodeContext` goes through `test/integration/repository-lifecycle.ts` `trackedRepositories`/`trackedContexts` from the first draft. Rows needing `chmod` are POSIX + non-root only, as `UNPRIVILEGED` gates them today. |
| Rows from Part 7 | fsck rows A25, B8 and A26/A27 (regression), from `w` and `wt`. `rev-parse --verify` rows B14/C3 from `w` and `wt`: git's `rev-parse --verify <name>` against `revParse(name)` on the same throwaway, rebuilt from structured fields: a single `object` entry prints its `id`, exit 0; `OBJECT_NOT_FOUND` rebuilds `fatal: Needed a single revision`, exit 128. Names: `main-worktree/HEAD`, `worktrees/wt/HEAD`, `worktrees/wt/refs/bisect/bad` (seeded at `.git/worktrees/wt/refs/bisect/bad`), `main-worktree/refs/heads/main`, `worktrees/wt/refs/heads/side`, `worktrees/nope/HEAD`; and B15's names on its own throwaway. |
| Old suite | `shownRef` (L1198) is deleted: tsgit now carries the prefix. `printedPath` (L1176) follows the spelling rule above (linked cwd: absolute; main cwd: relative except a linked store's root-ref path). The body lookup in `rebuiltLines` strips the prefix before indexing `row.refs`/`row.root`. |

**Part 9 — docs.**

| | |
|---|---|
| Files | `docs/use/commands/fsck.md` (L131, L163, L180, L270, new arm row); `docs/design/fsck.md` msg-id table (`badRefName`, `badHeadTarget` now emitted); `docs/design/fsck-broken-ref-chain-unreadable.md` L616 (replace the unpinned assumption with a pointer to this design's A1/B12/B13); `docs/use/commands/rev-parse.md` (`main-worktree/<per-worktree ref>` and `worktrees/<id>/<per-worktree ref>` resolve; other names under those prefixes do not); `docs/BACKLOG.md` ticks rows 32.48 and 32.49 (the documentation phase does the tick) |

## Decisions

Every candidate of the first draft is settled. The planning phase reads these rows, not the
earlier alternatives, which live in each ADR.

| # | Choice | ADR | Outcome | Settled as |
|---|---|---|---|---|
| DC-1 | Walk scope and store enumeration | ADR-1150 | adopted as recommended | every store from any cwd, through `linkedWorktreeAdmins` (id, admin dir, OS order, `gitdir` skip rule), which `worktreeContexts` also builds on |
| DC-2 | Where the store loop lives | ADR-1151 | adopted as recommended | inside `verifyIntegrity()`, no signature change, one `IntegrityRun` across stores |
| DC-3 | Display names | ADR-1152 | ratified by the user | `worktrees/<id>/` + bare name in `ref` for every linked store, the current one included; bare for the main store; `badRefOid` keeps the current view's bare names; P2's `ref` becomes `HEAD`; breaking data change named in the changelog |
| DC-4 | A store root that is not a directory | ADR-1153 | adopted as recommended | `refs-walk-failed` with `reason: 'NOT_A_DIRECTORY'`, no `unreadable-ref-path` |
| DC-5 | A store gitdir whose root refs cannot be listed | ADR-1154 | adopted as recommended | integrity finding `rootRefsUnreadable` → arm `{ type: 'unreadable-root-refs'; path; reason: 'PERMISSION_DENIED' }`, bit 8, gated by `checkReferences`, rendered as no line |
| DC-6 | Source of an unreadable HEAD's `cannotReadRef` | ADR-1155 | adopted as recommended | the store walk's root-ref step; `UnreadableHead`, `WorktreeHeadSnapshot.unreadable` and `unreadableHeadFinding` are retired |
| DC-7 | Garbage HEAD in the snapshot | ADR-1156 | adopted as recommended | `headOf` treats `INVALID_OBJECT_ID` as "names nothing"; the shared HEAD reader is unchanged |
| DC-8 | Worktree order | ADR-1157 | adopted as recommended | OS `readdir` order in `linkedWorktreeAdmins`, inherited by every `worktreeContexts` caller |
| DC-9 | 32.49 (`main-worktree/` resolution) | ADR-1158 | ratified by the user **against** the recommendation | the read side folds in: requirement 12, Part 7, the A25/B8/B14/B15/C3 rows; write routes stay out (requirement 13, DC-14) |
| DC-10 | `badHeadTarget` | ADR-1159 | adopted as recommended | one fact on every store's `HEAD`, graded by `fsck.badHeadTarget`; when error it shadows `badReferentName` and `symrefTargetIsNotARef` |
| DC-11 | `.lock` and dot-led names | ADR-1160 | ratified by the user | both halves: `isSkippedByRefsVerify` in the integrity walk, `isSkippedByLooseIterator` in `walkRefDir` |
| DC-12 | `badRefName` | ADR-1161 | adopted as recommended | the content fact on the prefixed name with `isSafeRefName`, plus a zero pointer in `snapshotTargets` for a listed name failing it |
| DC-13 | Interop layout | ADR-1162 | adopted as recommended | new suite `test/integration/fsck-worktree-private-refs-interop.test.ts` with a multi-worktree seeder; the old suite drops `shownRef` and fixes `printedPath` |

## Decision candidates

The fold of ADR-1158 raises one new load-bearing choice. Two others it might have raised are
pinned and leave nothing to choose:

- From the main worktree, `main-worktree/<pw>` is located at `<common>/<pw>`, its own gitdir
  (B14 from `w`).
- `worktrees/<id>/<pw>` whose admin dir is missing reads at a path that does not exist and
  stays unresolved (B14 `worktrees/nope/HEAD`). `worktrees/<id>` with no slash is unresolved
  too (B15).

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| DC-14 | How the write side is kept off the read-side mapping (requirement 13) | (a) two locators in the files store: `resolveDirect` reads at `readLocation`, a new port method `resolveDirectForWrite` reads at today's `writeLocation`; every write-route reader that can meet a mapped name takes it (`checkExpected`, `refIsPresent`, `ref-write-chain.ts`), and `resolveDirectChain` narrows to `Pick<RefStore, 'resolveDirect'>` so the write chain hands it the write view; (b) map inside `resolveDirect` for every caller and leave the write path builders on `refDir` | **(a)** | (a) keeps every write route byte-identical to today (W14 unchanged) until the write side is pinned, as ADR-1158 requires. The guard is the routed call sites, each pinned by a test. (b) is one edit, but a write would then read at one path and write at another. With a detached main HEAD, `updateRef('main-worktree/HEAD')` would compare against `<common>/HEAD` and write the stray `<common>/main-worktree/HEAD`. With a symbolic main HEAD the chain would follow it to `refs/heads/main`. That matches W14's git row, but only by accident, and the rest of the write side would change without pins. A refusal of these names on the write routes is not an option: git accepts all three writes (W14), and an unpinned refusal is the regression the house rules forbid. |

Pinned, no choice left:

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
- **Resolver unit rows** (Part 7). One test per locator branch: a mapped name, a
  `main-worktree/` name whose remainder is shared, a name without the prefix, and the
  `worktrees/<id>/` path identity. One test per write-route reader proves it reads at
  `writeLocation`: through a fake store for the write chain, and as characterization rows
  for the store's own readers. Run on both a main and a derived worktree Context.
- **Interop** (Part 8). Every row of the matrix that is not n/a or out of scope (E1, W14),
  from each cwd it was pinned from. That includes the `rev-parse --verify` rows (B14, B15,
  C3), rebuilt from `revParse`'s structured result. Git's lines are the oracle; tsgit's are rebuilt from structured fields (ADR-249).
  OS-order rows derive their expectation from git's output on the same throwaway, and run on
  fresh fixtures several times per lesson 022/023 (the suite's `it` repeats the arrange; no
  hard-coded order).
- **Mutation.** Run Stryker narrowed per mutated file, on its own suites
  (`.claude/workflow/mutation.md`). The likely survivors are the prefix-key reset in
  `collectContentNotices`, the dot-led exception in `isSkippedByRefsVerify`, the
  `isPerWorktreeRef` conjunct in `mainWorktreeBareName`, and the `readLocation` branch (its
  `dir` matters only to the packed probe and the `ENOTDIR` climb, so B15's packed pair and a
  blocked-path row kill it). Each has an isolated test.
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
  linked store's `refs`. Linked stores hold few refs; the main-store walk is unchanged. The
  read locator adds one `startsWith` per `resolveDirect` call that misses the prefix.
- **Read and write disagree on `main-worktree/<pw>`.** After Part 7 a read of
  `main-worktree/HEAD` answers the main HEAD, while `updateRef('main-worktree/HEAD')` still
  writes the stray `<common>/main-worktree/HEAD` (W14, as today). DC-14 keeps that gap
  self-consistent on the write side (the write side reads and writes the same path); closing
  it needs the write-side pins.
- **`RefStore` port grows** `resolveDirectForWrite`. The interface is internal:
  `reports/api.json` carries no `RefStore` symbol.
- **Reftable** resolves `main-worktree/…` as it does today: `stackFor(perWorktreeRefDir)` looks
  the full name up in the common stack. git's reftable backend also runs
  `parse_worktree_ref`. Unpinned here; requirement 11 keeps it as it is.

## Out of scope

- **Writes** through `main-worktree/<pw>` and `worktrees/<id>/<pw>` (W14): git routes them
  through `files_ref_path` as it routes reads. tsgit's write routes (`refDir` in every path
  builder, the write chain, reflog paths in `record-ref-update.ts` and `reflog-store.ts`) stay
  as they are, because no write row beyond W14 is pinned (ADR-1158). DC-14 keeps the read
  mapping out of them.
- `main-worktree/` resolution in the reftable backend (unpinned, see Risks).
- Reflog reads of `main-worktree/<pw>` and `worktrees/<id>/<pw>` (`main-worktree/HEAD@{0}`):
  `reflog-store.ts` keeps `perWorktreeRefDir`. No row pins them, and ADR-1158 names only the
  ref resolver.
- `branch` and `for-each-ref` hiding broken-named refs with `ignoring ref with broken name`
  (E1): a listing-consumer change outside fsck.
- Reftable linked-worktree stores: tsgit's reftable `verifyIntegrity` is unchanged.
- The fsck file-system call count (32.50).
