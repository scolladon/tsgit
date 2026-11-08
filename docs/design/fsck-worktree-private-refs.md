# Design — fsck checks every worktree's private refs and names them as git does

> Brief: backlog 32.48. `fsck` never checks another worktree's per-worktree refs, and it
> names its own without the `worktrees/<id>/` prefix. git 2.56's `refs verify` child walks
> **every** worktree's ref store from any cwd: the main store first with no prefix, then each
> `.git/worktrees/<id>` with the prefix `worktrees/<id>/`. tsgit walks only the current
> worktree's view, reads each body by name instead of at the walked path, and crashes on
> another worktree's garbage HEAD. Bring the ref-content pass to git's store-by-store walk.
> Pinned on git 2.56.0. The read side of 32.49 (`main-worktree/` and `worktrees/<id>/` names
> in the shared resolver) folds in (ADR-1158), so this change ticks backlog rows 32.48 and
> 32.49. The write side folds in too (ADR-1164).
> Status: draft → self-reviewed ×3 → revised against ADRs 1150–1162 (self-reviewed ×3) →
> revised against ADR-1164
>
> **Revision** (2026-11-08): folds ADR-1164. Writes through `main-worktree/<per-worktree
> name>` and `worktrees/<id>/<per-worktree name>` go to the store the prefix selects, through
> the one locator reads already use. ADR-1163's second locator (`resolveDirectForWrite`) is
> retired. The write side is pinned in rows W1–W44 ("Write-side matrix"), against git's
> source for the refusals. Requirement 13 is replaced, and requirements 14–17 are new. DC-9 and
> DC-14 are superseded. The pins leave five decision candidates (DC-15 to DC-19). The largest
> is the reftable backend: git selects the store there but keys the record by the full
> prefixed name.

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
  - **The write side** (ADR-1164). The sources are `refs.c` and `refs/files-backend.c`,
    `refs/reftable-backend.c` at v2.56.0, byte-identical to the copies the read side was
    pinned on:
    - `files_reflog_path` (files-backend.c L239) routes the log the same way as the ref:
      `REF_WORKTREE_CURRENT` → `<gitdir>/logs/<name>`; `SHARED` and `MAIN` →
      `<common>/logs/<bare>`; `OTHER` → `<common>/worktrees/<id>/logs/<bare>`. The
      auto-create gate (`should_autocreate_reflog`, refs.c L1064) sees the **full** name, so
      a prefixed name only appends to a log that already exists.
    - `transaction_refname_valid` (refs.c L1368) checks each queued update. An update with
      a non-null new id takes `check_refname_format(…, REFNAME_ALLOW_ONELEVEL)` (L1384).
      Every other update (a delete, a symbolic-ref write) takes `refname_is_safe` (L382):
      either `refs/` plus a rest that normalizes to itself, or `[A-Z_]+` only. Otherwise it
      fails with `refusing to update ref with bad name '<name>'` (L1390). Every prefixed name
      fails that test.
    - `lock_ref_for_update` (files-backend.c L2687) runs on every update of the
      transaction, log-only splits included. It looks up an existing lock by
      **refname** in the transaction's `ref_locks` map (L2714) and
      otherwise calls `lock_raw_ref`. That call builds the path with `files_ref_path`
      (L789) and fails `EEXIST` through `unable_to_lock_message` (L859) when another refname
      of the same transaction already holds that file's lock. The message names
      `ref_update_original_update_refname(update)` (refs.c L3150), the name the caller
      gave.
    - The HEAD split: `files_transaction_prepare` reads the current worktree's `HEAD` with
      `RESOLVE_REF_NO_RECURSE` and keeps its referent only when `HEAD` is symbolic (L3004–
      L3010). `split_head_update` (L2499) then adds a log-only `HEAD` update for any update
      whose refname **string** equals that referent (L2512). `split_symref_update` (L2555)
      marks the referent's update `REF_UPDATE_VIA_HEAD`, which suppresses that split, only
      when the symref's refname is literally `HEAD` (L2579). So
      `update-ref main-worktree/HEAD` from a main worktree on a branch locks `<gitdir>/HEAD`
      twice, once for `main-worktree/HEAD` and once for the added `HEAD`, and refuses. With
      a detached `HEAD` there is no split and no refusal.
    - The reftable backend's `backend_for` (reftable-backend.c L229) selects the stack the
      same way: `OTHER` → that worktree's stack, `CURRENT` → the own stack, `MAIN`/`SHARED`
      → the main stack. Reads and the symref split use the rewritten (bare) name, and the
      split marks `REF_UPDATE_VIA_HEAD` when that bare name is `HEAD` (L1194).
      `write_transaction_table` keys every ref and log record by `u->refname`, the **full**
      prefixed name (L1593, L1630). Stacks hold no per-ref file lock, so no shape collides.
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
  - **The write side at f36503d0** (Parts 1–9 landed, with ADR-1163's guard in place):
    - `ref-store.ts` keeps two locators: `writeLocation` (L1079, today's `refDir` path) and
      `readLocation` (L1090, `mainWorktreeBareName` → `<common>/<bare>`).
      `resolveDirectForWrite` (L1100) reads at `writeLocation`. It serves `checkExpected`
      (L1739), `refIsPresent` (L2338) and `ref-write-chain.ts` (`walkSymbolicChain` L42,
      `readReferentValue` L82, `resolveWithoutDeref` L105). The reftable store aliases it
      to `resolveDirect` (reftable-ref-store.ts L400).
    - Every write path is built from `refDir(name)` = `perWorktreeRefDir`: `writeLooseRef`
      (L2038), `assertNoFileInTheWay` (L2023), `deleteTargetFor` (L2277), `nameCheckFor`
      (L2401), `raiseLockRefusals` (L2484), `refuseRefsUnder` (L2136), `looseFileAt`
      (L2343), and the reflog paths in `removeReflogFile` (L1760), `applyReflogReplace`
      (L1816), `readReflogBytes` (L1827), `moveReflog`/`copyReflog` (L1883–L1895).
      `record-ref-update.ts` (`prepareRefUpdate` L72, `appendReflogFile` L129) and
      `reflog-store.ts` (L19, L39, L58) build reflog paths with `perWorktreeRefDir` too.
      Hence `worktrees/wt/HEAD`'s log is looked up at `<common>/logs/worktrees/wt/HEAD`,
      not at git's `<common>/worktrees/wt/logs/HEAD` (W9, W11).
    - `applyRefWrite` (L1961) and `removeLooseAndLog` (L2238) drop the cached `HEAD`
      (`invalidateHeadSlot`, head-file.ts L178) only for the literal name `HEAD`.
    - `update-ref.ts` validates every name with `validateRefName` and nothing more, deletes
      included (L58, L90). `writeSymbolicRef` (write-symbolic-ref.ts L24) is internal.
      `repo.primitives` exposes `updateRef` only (repository.ts L1070), so `deleteRef` is
      `updateRef(name, zero, { delete: true })`. `deleteRefs` (update-ref.ts L85) is
      internal (fetch, push, remote).
    - The coupled `HEAD` entry (`coupledHeadEntry` L181) and `walksHead` (L168) compare
      names literally, as git's files backend does. Nothing refuses two names of one
      transaction that share a loose file.
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
| W14 | `update-ref <name> <older oid>` for `main-worktree/HEAD`, `main-worktree/refs/bisect/x`, `worktrees/wt/refs/bisect/y` (write side, git and tsgit each on a fresh throwaway) | wt | — ; git moves `refs/heads/main` through the main HEAD, writes `<common>/refs/bisect/x`, writes `<common>/worktrees/wt/refs/bisect/y` | 0 | ✗ the first two write the stray files `<common>/main-worktree/HEAD` and `<common>/main-worktree/refs/bisect/x`; the third ✓ | superseded by ADR-1164: re-pinned as W2, W6 and W8 in the write-side matrix, whose required column governs |
| X1 | linked admin dir renamed to `w:t` (its work tree's `.git` file rewritten) holding `refs/bisect/good`, `ORIG_HEAD`, `BISECT_HEAD`, all valid ids | w, wt | `error: worktrees/w:t/refs/bisect/good: badRefName: invalid refname format` and `error: worktrees/w:t/BISECT_HEAD: badRefName: invalid refname format` (`ORIG_HEAD` unreported: the per-store root-ref check stops at its first error, `BISECT_HEAD` listed first) | 8 | ✗ no name fact on a root ref | `badRefName` on the prefixed name of a linked store's root ref, before its body facts; the main store's bare root names are exempt |
| X2 | `mkfifo worktrees/wt/refs/bisect/bad` | w, wt | `error: worktrees/wt/refs/bisect/bad: badRefFiletype: unexpected file type` (never opened; name and content checks do not run) | 8 | ✗ opens it, hangs | `worktrees/wt/refs/bisect/bad badRefFiletype error`, never read, never listed |
| X3 | `mkfifo BISECT_HEAD` in the main gitdir and in `worktrees/wt` | w, wt | — | 0 | ✗ opens it, hangs | nothing: a root ref that is not a regular file is passed over |
| X4 | main gitdir `BISECT_HEAD` a symbolic link to a named pipe | w | — | 0 | ✗ opens it, hangs | nothing: a root-ref link is followed by a stat, and a target that is not a regular file is passed over |
| X5 | `mkfifo refs/bisect/bad` in the main store | w | `error: refs/bisect/bad: badRefFiletype: unexpected file type` | 8 | ✗ opens it, hangs | `refs/bisect/bad badRefFiletype error` |
| C | main `refs/heads/sub/x.lock` = oid, `refs/heads/sub` mode 0444 | w | `warning: failed to stat '.git/refs/heads/sub/x.lock': Permission denied` (the iterator lstats every entry before a `.lock` basename is skipped) | 0 | ✗ the entry is filtered before any lstat, nothing reported | `unreadable-ref-path` with `operation: 'stat'` for the lock file, no content finding |
| D | `.git/worktrees` a regular file, or mode 000 with a linked `wt` inside | w | — (a directory that cannot be opened lists no linked worktree) | 0 | ✗ throws `NOT_A_DIRECTORY` / `PERMISSION_DENIED` | no linked store listed, nothing reported |
| V1 | main `LONG_HEAD` a link whose resolution exceeds the path length limit (`t1` → 450 `./` components, `LONG_HEAD` → `t1/` + 600 chars) | w | — (the failed `stat` passes the entry over) | 0 | ✗ rejects `PATH_TOO_LONG` | nothing; the link is never read |
| V2 | main `refs/heads/n/long` such a link; `for-each-ref` | w | lists the other refs, exit 0 (`fsck` itself dies `fatal: Invalid path …`, exit 8, as before) | 0 | ✗ `listRefs`/`listRefNames` reject `PATH_TOO_LONG` | the link is not listed |
| V3 | main `-_HEAD` = `garbage` (a root name the ref grammar rejects) | w | `error: -_HEAD: badRefContent: garbage` | 8 | ✓ | `badRefContent` only: the main store's root names are exempt from the name check |
| V4 | `mkfifo refs/heads/sub/f`, `refs/heads/sub` mode 0444 | w | `warning: failed to stat '.git/refs/heads/sub/f': Permission denied` | 0 | ✗ `badRefFiletype` error, 8 | `unreadable-ref-path` (stat) only: the iterator's `lstat` comes before the file-type verdict |
| V5 | `refs/heads/sub/b@{` = oid, `refs/heads/sub` mode 0444 | w | the same warning on `b@{` + `error: refs/heads/sub/b@{: invalid sha1 pointer 0{40}` | 2 | ✗ `badRefName` + stat + pointer, 10 | the stat finding and the pointer only: the `lstat` comes before the name verdict |
| V6 | an entry (a `.lock` file, an unsafe-named file, a pipe, a directory, a link) removed between the listing and the iterator's `lstat` — pinned from git's source, `dir-iterator.c` `prepare_next_entry_data` (`if (err && errno != ENOENT) warning_errno("failed to stat …")`, the entry then skipped), not from a run: the race cannot be staged against the binary | w | — (nothing; a concurrent `update-ref` creating and removing `<ref>.lock` is the realistic shape) | 0 | ✗ the up-front `lstat` throws `FILE_NOT_FOUND` and the walk aborts | nothing: the entry is passed over and the walk carries on |
| V7 | a directory below `refs/` gone between the iterator's `lstat` and its open — pinned from `dir-iterator.c` `push_level` (`if (errno != ENOENT) warning_errno("error opening directory …")`, the level dropped, the walk carrying on); the `refs` root itself keeps the verdict `rootKind` took a moment earlier | w | — (nothing; `git branch -D a/b` pruning the emptied `refs/heads/a` under a running fsck is the realistic shape) | 0 | ✗ the listing throws `FILE_NOT_FOUND` and the walk aborts | nothing: the directory is passed over and the walk carries on |
| V8 | a component turned regular file under the walk before an entry's `lstat` (`git branch -D a/b && git branch a`) — `prepare_next_entry_data` warns every `errno` but `ENOENT` | w | `warning: failed to stat '…/a/b': Not a directory` | 0 | ✗ `NOT_A_DIRECTORY` rejected from the up-front `lstat`; the deferred read of a safe regular file took it for absent | `unreadable-ref-path` `stat` with `reason: 'NOT_A_DIRECTORY'`, from either route |
| V9 | a directory turned regular file between its `lstat` and its open — `push_level` warns every `errno` but `ENOENT` | w | `warning: error opening directory '…/a/': Not a directory` | 0 | ✗ `NOT_A_DIRECTORY` rejected from the listing | `unreadable-ref-path` `open-directory` with `reason: 'NOT_A_DIRECTORY'`, the walk carrying on |

**Path spelling in git's lines** (the interop harness rebuilds it; tsgit always reports the
absolute path it opened):

- From a linked cwd, every path is absolute (A11, A13, B5, B6, P9, P10).
- From the main cwd:
  - main-store paths are relative to the top (`.git/refs/heads/u`, `.git/ORIG_HEAD`);
  - a linked store's `refs/` walk paths are relative too (`.git/worktrees/wt/refs/…`: A11,
    A13, B5, B6, P10);
  - a linked store's **root-ref** paths are the absolute realpath, because they are built
    from the store's common-dir spelling (P1).

### Write-side matrix (ADR-1164)

These rows were pinned on 2026-11-08, with git 2.56.0 and tsgit at f36503d0, under the same
isolation as above.

- **Fixture.** Each row ran on a fresh throwaway: `git init -b main [--ref-format=reftable]
  repo`, commits A and B, then `refs/heads/main` reset to A. `git worktree add wt -b side`
  (`side` = A), `refs/bisect/s` = A in the main store and `refs/bisect/t` = A in `wt`'s
  store. In the "HEAD" column, "detached" means `update-ref --no-deref HEAD A` in that
  worktree. Every write sets B.
- **Spelling.** `<common>` is `repo/.git`. `<RB>` is the throwaway's realpath.
- **git.** `update-ref -m probe <name> B`, `update-ref -m probe --no-deref`,
  `update-ref -m probe -d`, `symbolic-ref -m probe`, or a two-line `update-ref --stdin`.
- **tsgit.** `openRepository({ cwd }).primitives.updateRef(name, B, { reflogMessage })`
  (`noDeref: true`; a delete is `{ delete: true }` with the zero id). Symbolic rows call the
  internal `writeSymbolicRef(repo.ctx, …)`. Transaction rows call `deleteRefs`, or the
  store-level `getRefStore(ctx).applyRefUpdates` with two `set`s (no public surface queues
  two caller names in one write).
- **Reading the results.** "git changes" is a before/after listing of `<common>` outside
  `objects/`: the ref values and each log's line count and last entry. The reftable rows
  list every ref and log record by name, decoded with tsgit's reftable reader. Rows marked
  ×3 were re-run on two more fresh throwaways with the same outcome.
  "→ ✓" marks a row the write-side parts turned green;
  test/integration/worktree-ref-namespace-write-interop.test.ts pins it.
- **Expected column.** It assumes the recommendation of each decision candidate that
  governs the row (DC-15 to DC-19).
- **W14** keeps its id in the matrix above. Its three writes are W2, W6 and W8.

Files backend, `updateRef`:

| id | name | cwd | HEAD (main / wt) | git line, exit | git changes | tsgit at f36503d0 | expected |
|---|---|---|---|---|---|---|---|
| W1 ×3 | `main-worktree/HEAD` | main | branch / branch | `fatal: update_ref failed for ref 'main-worktree/HEAD': cannot lock ref 'main-worktree/HEAD': Unable to create '<RB>/repo/.git/HEAD.lock': File exists.` + the `Another git process…` hint, 128 | nothing | ✗ ok; stray `<common>/main-worktree/HEAD` → ✓ | `REF_LOCKED { name: 'main-worktree/HEAD' }`, nothing written (requirement 15) |
| W2 ×3 | `main-worktree/HEAD` | wt | branch / branch | —, 0 | `refs/heads/main` = B; `logs/refs/heads/main` and `logs/HEAD` each gain `A B probe` | ✗ ok; stray `<common>/main-worktree/HEAD`; `main` unmoved → ✓ | git's changes |
| W3 ×3 | `main-worktree/HEAD` | main | detached / branch | —, 0 | `<common>/HEAD` = B; `logs/HEAD` gains `A B probe` | ✗ stray file → ✓ | git's changes; the cached `HEAD` is dropped |
| W4 | `main-worktree/HEAD` | wt | detached / branch | —, 0 | as W3 | ✗ stray file → ✓ | git's changes |
| W5 | `main-worktree/refs/bisect/x` | main | branch / branch | —, 0 | new `<common>/refs/bisect/x` = B, no log | ✗ stray `<common>/main-worktree/refs/bisect/x` → ✓ | git's changes |
| W6 | `main-worktree/refs/bisect/x` | wt | branch / branch | —, 0 | as W5 | ✗ stray file → ✓ | git's changes |
| W7 | `worktrees/wt/refs/bisect/y` | main | branch / branch | —, 0 | new `<common>/worktrees/wt/refs/bisect/y` = B | ✓ | — |
| W8 | `worktrees/wt/refs/bisect/y` | wt | branch / branch | —, 0 | as W7 | ✓ | — |
| W9 ×3 | `worktrees/wt/HEAD` | main | branch / branch | —, 0 | `refs/heads/side` = B; `logs/refs/heads/side` and `<common>/worktrees/wt/logs/HEAD` each gain `A B probe` | ✗ no `worktrees/wt/logs/HEAD` entry (the log is looked up at `<common>/logs/worktrees/wt/HEAD`) → ✓ | git's changes |
| W10 ×3 | `worktrees/wt/HEAD` | wt | branch / branch | `fatal: update_ref failed for ref 'worktrees/wt/HEAD': cannot lock ref 'worktrees/wt/HEAD': Unable to create '<RB>/repo/.git/worktrees/wt/HEAD.lock': File exists.` + hint, 128 | nothing | ✗ ok; moves `side`, logs `side` and `wt`'s `HEAD` → ✓ | `REF_LOCKED { name: 'worktrees/wt/HEAD' }` |
| W11 ×3 | `worktrees/wt/HEAD` | wt | branch / detached | —, 0 | `<common>/worktrees/wt/HEAD` = B; `worktrees/wt/logs/HEAD` gains `A B probe` | ✗ no log entry → ✓ | git's changes; the cached `HEAD` is dropped |
| W12 | `main-worktree/HEAD`, `noDeref` | wt | branch / branch | —, 0 | `<common>/HEAD` = B (detached); `logs/HEAD` gains `A B probe` | ✗ stray file → ✓ | git's changes |
| W13 ×3 | `main-worktree/HEAD`, `noDeref` | main | branch / branch | —, 0 | as W12: no refusal, since the update's name is not `HEAD`'s referent | ✗ stray file → ✓ | git's changes; the cached `HEAD` is dropped |
| W15 ×3 | `worktrees/wt/HEAD`, `noDeref` | wt | branch / branch | —, 0 | `wt`'s `HEAD` = B; `worktrees/wt/logs/HEAD` gains `A B probe` | ✗ no log entry → ✓ | git's changes |
| W16 | `refs/heads/x` = `ref: main-worktree/HEAD` (hand-written) | main | branch / branch | `fatal: update_ref failed for ref 'refs/heads/x': cannot lock ref 'refs/heads/x': Unable to create '<RB>/repo/.git/HEAD.lock': File exists.` + hint, 128 | nothing | ✗ ok; stray `main-worktree/HEAD`; new `logs/refs/heads/x` `0{40} B` → ✓ | `REF_LOCKED { name: 'refs/heads/x' }` |
| W17 | same | wt | branch / branch | —, 0 | `main` = B; new `logs/refs/heads/x` `A B probe`; `logs/HEAD`, `logs/refs/heads/main` each gain `A B probe` | ✗ stray file; `x`'s log `0{40} B` → ✓ | git's changes |
| W18 | `refs/bisect/c` = `ref: main-worktree/refs/bisect/c` (one file naming itself) | main | branch / branch | `fatal: update_ref failed for ref 'refs/bisect/c': cannot lock ref 'refs/bisect/c': Unable to create '<RB>/repo/.git/refs/bisect/c.lock': File exists.` + hint, 128 | nothing | ✗ ok; stray `<common>/main-worktree/refs/bisect/c` → ✓ | `REF_LOCKED { name: 'refs/bisect/c' }`, not `REF_CYCLE_DETECTED` |
| W19 | `main-worktree/refs/heads/main` (shared bare name) | wt | branch / branch | —, 0 | new `<common>/main-worktree/refs/heads/main` (git's `SHARED` path) | ✓ | — |
| W20 | `worktrees/wt/refs/heads/side` | main | branch / branch | —, 0 | new `<common>/worktrees/wt/refs/heads/side` | ✓ | — |
| W21 | `worktrees/nope/HEAD` (no such worktree) | main | branch / branch | —, 0 | new `<common>/worktrees/nope/HEAD` | ✓ | — |
| W22 | `worktrees/nope/refs/bisect/z` | main | branch / branch | —, 0 | new `<common>/worktrees/nope/refs/bisect/z` | ✓ | — |
| W23 | `worktrees/wt` (no bare name) | main | branch / branch | `fatal: update_ref failed for ref 'worktrees/wt': cannot lock ref 'worktrees/wt': there is a non-empty directory '.git/worktrees/wt/' blocking reference 'worktrees/wt'`, 128 | nothing | refuses `FILE_EXISTS` on `<common>/worktrees/wt/HEAD` | out of perimeter (Risks) |

Files backend, refusals of the delete and symbolic-ref gate (`refs.c` `transaction_refname_valid`):

| id | shape | cwd | git line, exit | tsgit at f36503d0 | expected |
|---|---|---|---|---|---|
| W24 ×3 | delete `main-worktree/refs/bisect/s` | main, wt | `error: refusing to update ref with bad name 'main-worktree/refs/bisect/s'`, 1 | ✗ ok, no-op (absent at the spelled path) → ✓ | `INVALID_REF`, nothing removed (requirement 16) |
| W25 | delete `worktrees/wt/refs/bisect/t` | main, wt | the same line on that name, 1 | ✗ **deletes** `wt`'s `refs/bisect/t` → ✓ | `INVALID_REF` |
| W26 | delete `main-worktree/HEAD` | wt | the same line, 1 | ✗ ok, no-op → ✓ | `INVALID_REF` |
| W27 ×3 | delete `worktrees/wt/HEAD` | main | the same line, 1 | ✗ **deletes** `refs/heads/side` and its log → ✓ | `INVALID_REF` |
| W28 | delete `foo/bar` (created by `update-ref foo/bar A`) | main | `error: refusing to update ref with bad name 'foo/bar'`, 1 | ✗ deletes it → ✓ | `INVALID_REF` (DC-16) |
| W29 | `symbolic-ref main-worktree/HEAD refs/heads/side` | main, wt | `error: refusing to update ref with bad name 'main-worktree/HEAD'`, 1 | ✗ writes the stray `<common>/main-worktree/HEAD` → ✓ | `INVALID_REF` from `writeSymbolicRef` |
| W30 | `symbolic-ref worktrees/wt/HEAD refs/heads/main` | main | the same line on that name, 1 | ✗ rewrites `wt`'s `HEAD` to `ref: refs/heads/main` → ✓ | `INVALID_REF` |

Files backend, transactions (`update-ref --stdin`):

| id | updates | cwd | git line, exit | tsgit at f36503d0 | expected |
|---|---|---|---|---|---|
| W31 ×3 | `update refs/bisect/x B`, `update main-worktree/refs/bisect/x B` | main | `fatal: cannot lock ref 'main-worktree/refs/bisect/x': Unable to create '<RB>/repo/.git/refs/bisect/x.lock': File exists.` + hint, 128 | store level: writes both, one at the stray path | no tsgit surface; store level unchanged (DC-17) |
| W32 | `update main-worktree/HEAD B`, `update refs/heads/main B`, either order | wt | `fatal: multiple updates for 'refs/heads/main' (including one via symref 'main-worktree/HEAD') are not allowed`, 128 | store level: writes both | no tsgit surface |
| W33 ×3 | `update worktrees/wt/refs/bisect/y B`, `update refs/bisect/y B` | wt | `fatal: cannot lock ref 'refs/bisect/y': Unable to create '<RB>/repo/.git/worktrees/wt/refs/bisect/y.lock': File exists.` + hint, 128 (the name is the **later** update's) | store level: writes the first | no tsgit surface |
| W34 | `delete refs/bisect/s`, `delete main-worktree/refs/bisect/s` | main | `fatal: refusing to update ref with bad name 'main-worktree/refs/bisect/s'`, 128; nothing deleted | ✗ `deleteRefs` removes `refs/bisect/s` → ✓ | `deleteRefs` refuses `INVALID_REF` before any write |

Reflog reads:

| id | read | cwd | git | tsgit at f36503d0 | expected |
|---|---|---|---|---|---|
| W35 | `git reflog main-worktree/HEAD`; `RefStore.readReflog` | wt | the main `HEAD`'s log, `<common>/logs/HEAD` (on reftable too) | ✗ 0 entries, on both backends → ✓ | the main `HEAD`'s log (DC-18) |
| W36 | `git reflog worktrees/wt/HEAD` | main | `wt`'s log, `<common>/worktrees/wt/logs/HEAD` | ✗ 0 entries → ✓ | `wt`'s log (DC-18) |

Reftable backend (`git init --ref-format=reftable`; records listed by stack):

| id | write | cwd | HEAD (main / wt) | git line, exit | git records | tsgit at f36503d0 | expected |
|---|---|---|---|---|---|---|---|
| W37 | `main-worktree/HEAD` | main, wt | branch / branch | —, 0 (no refusal from main) | main stack: `refs/heads/main` = B, its log +1, log record `main-worktree/HEAD` +1, no `HEAD` log record | ✗ ref record `main-worktree/HEAD` = B in the main stack; `main` unmoved → ✓ | git's records (DC-15) |
| W38 | `main-worktree/HEAD` with the main `HEAD` detached, and `noDeref` from main | main | detached or branch / branch | —, 0 | main stack: ref record **and** log record `main-worktree/HEAD`; `HEAD` itself unchanged (`rev-parse HEAD` = A) | ✗ the ref record only → ✓ | git's records (DC-15) |
| W39 | `main-worktree/refs/bisect/x` | main, wt | branch / branch | —, 0 | main stack: ref record `main-worktree/refs/bisect/x`; `refs/bisect/x` absent | ✓ same record | — |
| W40 | `worktrees/wt/refs/bisect/y` | main, wt | branch / branch | —, 0 | **`wt`'s stack**: ref record `worktrees/wt/refs/bisect/y` | ✗ the record lands in the main stack → ✓ | git's stack (DC-15) |
| W41 | `worktrees/wt/HEAD` | main, wt | branch / branch | —, 0 (no refusal from `wt`) | main stack: `refs/heads/side` = B and its log +1; `wt`'s stack: log record `worktrees/wt/HEAD` | ✗ ref record `worktrees/wt/HEAD` in the main stack; `side` unmoved → ✓ | git's records (DC-15) |
| W42 | `worktrees/wt/HEAD` | wt | branch / detached | —, 0 | `wt`'s stack: ref and log record `worktrees/wt/HEAD`; `wt`'s `HEAD` unchanged | ✗ ref record in the main stack → ✓ | git's records (DC-15) |
| W43 | W31's transaction | main | branch / branch | —, 0 | main stack: both `refs/bisect/x` and `main-worktree/refs/bisect/x` | ✓ (store level) | — |
| W44 | delete `main-worktree/refs/bisect/s`, `worktrees/wt/refs/bisect/t` | main | branch / branch | `error: refusing to update ref with bad name '…'`, 1 | nothing | ✗ ok, no-op → ✓ | `INVALID_REF` |

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
11. A reftable repository's fsck walk behaves as today. Its write and read namespace follows
    requirement 17.
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
13. *Superseded by ADR-1164* (it read "write side unchanged", DC-14). Requirements 14–17
    replace it.
14. **Write-side worktree ref namespace** (ADR-1164). On the files backend, one locator, git's
    `files_ref_path`, serves every read and every write route. It places the loose file, its
    lock, the compare-and-swap and presence reads, and each write-chain hop. A second
    function, git's `files_reflog_path`, places the log. So:
    - `main-worktree/<pw>` → `<common>/<pw>`, log `<common>/logs/<pw>` (W2–W6, W12, W13);
    - `worktrees/<id>/<pw>` → `<common>/worktrees/<id>/<pw>`, log
      `<common>/worktrees/<id>/logs/<pw>` (W9, W11, W15);
    - every other name keeps today's path and log (W7, W8, W19–W22).

    The write chain follows `main-worktree/HEAD` and `worktrees/<id>/HEAD` like that store's
    `HEAD` (W2, W9, W17). The reflog auto-create gate keeps the **full** name, so a
    prefixed name only appends to a log that exists (W5: none). A write or delete that lands
    on `<gitdir>/HEAD` drops the cached `HEAD`, whatever name it came through (W3, W11, W13).
15. **Shared-lock refusal** (files backend). `updateRef` is refused before anything is
    written when two different names of its transaction share one loose file. The names are
    the given name, each symbolic hop, the terminal, and the coupled `HEAD` entry when it is
    added. The refusal is `REF_LOCKED { name }`, where `name` is the name the caller gave
    (W1, W10, W16, W18). A detached `HEAD` adds no coupled entry and nothing is refused
    (W3, W11). Under `noDeref` the update's name is not `HEAD`'s referent, so nothing is
    refused either (W13, W15). The compare-and-swap refusal keeps its place ahead of this
    one, as git checks the terminal's old value before it processes the added `HEAD`
    update.
16. **Delete and symbolic-ref gate.** On both backends, a delete (`delete: true` or the zero
    id, `updateRef` and `deleteRefs`) and a `writeSymbolicRef` are refused with
    `INVALID_REF` before any I/O when the name fails git's `refname_is_safe` (W24–W30, W34,
    W44). `deleteRefs` checks every name before it plans any (W34). DC-16 sets the scope.
17. **Reftable** (DC-15). The stack follows git's `backend_for`: `main-worktree/<pw>` → the
    main stack, `worktrees/<id>/<pw>` → `<common>/worktrees/<id>`'s stack. Reads and the
    symref walk use the bare name, while writes key the ref and log records by the full
    name (W37–W42). Nothing is refused for a shared lock, and a hop whose bare name is
    `HEAD` adds no coupled `HEAD` entry (W37).

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

resolve-ref.ts resolveDirectChain ─┐
ref-write-chain.ts, checkExpected,  ├─ RefStore.resolveDirect(name)
refIsPresent, every write path     ─┘   one locator: refLocation(ctx, name)   (ADR-1164)
                                          { dir, loose, reflog } = git's files_ref_path
                                          + files_reflog_path over parseWorktreeRef(name)
record-ref-update.ts, reflog-store.ts ── refLocation(ctx, name).reflog
update-ref.ts updateRef / deleteRefs ── refname_is_safe gate on deletes (requirement 16)
                                     ── shared-lock refusal over the chain + coupled HEAD
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
  unit and interop rows pin the path. That holds for the loose path only. The log path does differ:
  git's is `<common>/worktrees/<id>/logs/<bare>`, today's is `<common>/logs/worktrees/<id>/<bare>`
  (W9, W11). So Part 10's `parseWorktreeRef` carries an `other` arm.
- **Writes: the guard** (DC-14 option (a), ADR-1163) is *superseded by ADR-1164*. That guard
  added `resolveDirectForWrite`, which read at today's `writeLocation`. It served
  `checkExpected`, `refIsPresent`, `walkSymbolicChain`, `resolveWithoutDeref` and
  `readReferentValue`. ADR-1163's inventory of those readers stands: each now reads through
  `resolveDirect`, on the one locator of "Write-side worktree ref namespace (ADR-1164)"
  below. `stillHoldsPackedValue`, `update-ref.ts`'s `HEAD` read (`resolveHeadForCoupling`)
  and `branch.ts`'s `refs/heads/*` reads were already on `resolveDirect`.
- **fsck and rev-parse need no code.** fsck's `targetOf` → `resolveRef`, and `revParse` →
  `readRefCandidate`, both reach the read locator through `resolveDirectChain`. The
  `symrefTargetIsNotARef` info on `main-worktree/…` referents stays as it is today.
- **From the main worktree,** `main-worktree/HEAD` is read at `<common>/HEAD` (its own HEAD)
  by the loose reader, not by `resolveHeadDirect`. Both readers apply `resolveSymlinkedRef`'s
  rule, so the value is the same. No row pins a symlinked main HEAD read through the
  namespace.

### Write-side worktree ref namespace (ADR-1164)

The write rows and every read row share one locator. The two-locator guard of ADR-1163 goes,
and the write-route readers it listed read through `resolveDirect`.

**Domain.** git's whole `parse_worktree_ref` replaces `mainWorktreeBareName`:

```ts
// src/domain/refs/per-worktree-ref.ts
/** Which store a ref name selects and the name inside it — git's `parse_worktree_ref`. */
export type WorktreeRefTarget =
  | { readonly kind: 'current'; readonly bare: RefName } // per-worktree, the own store
  | { readonly kind: 'shared'; readonly bare: RefName } // the full name, the common store
  | { readonly kind: 'main'; readonly bare: RefName } // main-worktree/<pw>
  | { readonly kind: 'other'; readonly id: string; readonly bare: RefName }; // worktrees/<id>/<pw>
export const parseWorktreeRef = (name: RefName): WorktreeRefTarget

// src/domain/refs/ref-validation.ts
/** git's `refname_is_safe`: `refs/` plus a rest that normalizes to itself, or `[A-Z_]+`. */
export const isRefnameSafe = (name: RefName): boolean
```

`worktrees/<id>` with no slash parses as `shared`. git calls it `OTHER` with an empty bare
name, but both spell the path `<common>/worktrees/<id>`. A name such as `worktrees/<id>/refs/heads/x`, whose
bare form is not per-worktree, parses as `shared` too, as git's does. `isRefnameSafe`'s root
arm is `[A-Z_]+`. It is narrower than `isPerWorktreeRef`'s root syntax, which also admits
`-`. Note that `validateRefName` already refuses a `..`, `//` or `.`-led component, so only
the outside-`refs/` arm can fail on a name that passed it.

**Locator** (`path-layout.ts`, beside `perWorktreeRefDir`):

```ts
export interface RefLocation {
  readonly dir: string; // packed-refs probe root and `${dir}/refs` file-in-the-way climb root
  readonly loose: string; // files_ref_path: the loose file and its `.lock`
  readonly reflog: string; // files_reflog_path
}
export const refLocation = (ctx: Context, name: RefName): RefLocation
//   current → { gitDir,  `${gitDir}/${name}`,                 `${gitDir}/logs/${name}` }
//   shared  → { common,  `${common}/${name}`,                 `${common}/logs/${name}` }
//   main    → { common,  `${common}/${bare}`,                 `${common}/logs/${bare}` }
//   other   → { common,  `${common}/worktrees/${id}/${bare}`, `${common}/worktrees/${id}/logs/${bare}` }
```

`perWorktreeRefDir` stays for the callers that classify **walked** names (listing, fsck,
packing, the reftable listing), which never carry a prefix.

**Files store** (`ref-store.ts`):

- `readLocation` and `writeLocation` merge into `location(name) = refLocation(ctx, name)`.
  `resolveDirect(name)` = `HEAD` ? `resolveHeadDirect()` : `resolveDirectAt(name,
  location(name))`. `resolveDirectForWrite` leaves the files store, `withPseudoRefFiles`
  and the reftable store.
- `checkExpected` and `refIsPresent` call `resolveDirect`.
- Every path built from `refDir(x)` on a write or reflog route takes `location(x)`:
  - `looseRefPath(refDir(x), x)` becomes `.loose`, and `${refDir(x)}/${REFS_DIR}` becomes
    `${location(x).dir}/${REFS_DIR}`;
  - `reflogPath(refDir(x), x)` becomes `.reflog`, and `DeleteTarget.gitDir` becomes `.dir`;
  - the routes: `writeLooseRef`, `assertNoFileInTheWay`, `deleteTargetFor`,
    `nameCheckFor`, `raiseLockRefusals`, `refuseRefsUnder`, `looseFileAt`,
    `smallestLooseRefUnder`, `removeReflogFile`, `applyReflogReplace`, `readReflogBytes`,
    `moveReflog`, `copyReflog`, `hasReflog`.

  For a name without a prefix nothing changes, because `location` returns today's paths.
- **The `HEAD` slot.** `applyRefWrite` and `removeLooseAndLog` call `invalidateHeadSlot`
  when `location(name).loose === ${ctx.layout.gitDir}/HEAD`, not when `name === 'HEAD'`
  (W3, W11, W13, W15).

**Reflog writer and store.** `record-ref-update.ts` (`prepareRefUpdate`,
`appendReflogFile`) and `reflog-store.ts` (`appendReflog`, `reflogExists`, `deleteReflog`)
take `refLocation(ctx, ref).reflog`. The auto-create gate keeps `shouldAutocreateReflog(ref)`
on the full name, as `should_autocreate_reflog` does (W5, W2's `logs/HEAD` append).

**Write chain** (`internal/ref-write-chain.ts`):

- `walkSymbolicChain`, `resolveWithoutDeref` and `readReferentValue` call
  `store.resolveDirect`, and `readReferentValue` passes `store` to `resolveDirectChain`.
- `walkSymbolicChain` keeps a `Map` from loose file to name. It checks each next hop
  before reading it. A hop whose file an earlier hop of a **different** name already holds
  throws `refLocked(<given name>)` (W18). A repeated name keeps today's
  `REF_CYCLE_DETECTED`.
- The file key comes from the backend table below, so the reftable walk never collides.

**`update-ref.ts`:**

- `updateRef` runs `assertSafeWithoutNewId(name)` (`isRefnameSafe`, else `invalidRef('refusing
  to update ref with bad name')`) when `isDelete`, before `planTransaction`.
  `deleteRefs` runs it on every name before planning any (W34). `writeSymbolicRef` runs
  it on `name` (W29, W30).
- After `assertExpected`, `assertNoSharedHeadLock(plan, name)`: when the transaction adds a
  coupled `HEAD` entry and `HEAD`'s loose file is the file of a walked link or of the
  terminal under another name, it throws `refLocked(name)` (W1, W10, W16).
  `coupledHeadEntry` and `walksHead` keep git's literal-name comparison on the files
  backend (W13, W15: no refusal).

**Backend table** (`internal/ref-transaction-logging.ts`, DC-17). Two fields join the
existing five:

```ts
/** files: two names of one transaction on one loose file refuse, as git's per-refname lock
 *  map meets `EEXIST`; reftable: stacks hold no per-ref lock, so nothing collides. */
readonly sharedLooseFile: 'refused' | 'allowed';
/** files: a hop marks the referent "via HEAD" only when its name is literally `HEAD`;
 *  reftable: when its bare name is `HEAD` (W37: no `HEAD` log record). */
readonly viaHeadName: 'literal' | 'bare';
```

**Reftable store** (DC-15 (a)):

- `stackFor(name)` selects by `parseWorktreeRef`: `main` and `shared` → the common stack,
  `current` → the own stack, `other` → `<common>/worktrees/<id>`'s stack.
- `resolveDirect` looks up the bare name there, and so does every write-chain hop.
- `reftable-transaction.ts` (L1353) picks each update's stack the same way and keeps the
  record and log name as given: `main-worktree/HEAD`'s log record lands in the main stack
  (W37, W38), and `worktrees/wt/refs/bisect/y`'s ref record lands in `wt`'s stack (W40).
- `readReflog` and `hasReflog` read the bare name in the selected stack (W35 on reftable).
- The reftable log gate (`isReftableLoggable`, the existing-log probe and
  `shouldAutocreateReflog`) judges the bare name in the selected stack, where the files gate
  judges the full name (requirement 14); the implementation diverged from the plan here.

**API changes.** `repo.primitives.updateRef` keeps its signature. Its new refusals reuse
existing codes, and `reports/api.json` carries none of the internal symbols below.

| symbol | file | change |
|---|---|---|
| `parseWorktreeRef`, `WorktreeRefTarget` | `src/domain/refs/per-worktree-ref.ts` | new |
| `mainWorktreeBareName` | `src/domain/refs/per-worktree-ref.ts` | removed; its only caller, `readLocation`, goes |
| `isRefnameSafe` | `src/domain/refs/ref-validation.ts` | new |
| `refLocation`, `RefLocation` | `src/application/primitives/path-layout.ts` | new |
| `perWorktreeRefDir` | `src/application/primitives/path-layout.ts` | kept, walked names only |
| `RefStore.resolveDirectForWrite` | `src/application/primitives/ref-store.ts` | removed (port, files, reftable, `withPseudoRefFiles`) |
| `readLocation`, `writeLocation`, `LooseLocation` | `src/application/primitives/ref-store.ts` (internal) | merged into `location` over `RefLocation` |
| `resolveDirectChain(refStore: Pick<RefStore, 'resolveDirect'>, …)` | `src/application/primitives/resolve-ref.ts` | kept |
| `TransactionLogging.sharedLooseFile`, `.viaHeadName` | `src/application/primitives/internal/ref-transaction-logging.ts` | new |
| `updateRef`, `deleteRefs` | `src/application/primitives/update-ref.ts` | new refusals `INVALID_REF` (requirement 16), `REF_LOCKED` (requirement 15) |
| `writeSymbolicRef` | `src/application/primitives/write-symbolic-ref.ts` | new refusal `INVALID_REF` |

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
| Decision | DC-14 (a), ratified as ADR-1163, *superseded by ADR-1164*. The rows below describe what landed. Part 10 retires `resolveDirectForWrite`, `writeLocation` and the write view |
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

**Part 10 — one locator for reads, writes and logs (ADR-1164, files backend).**

| | |
|---|---|
| Files | `src/domain/refs/per-worktree-ref.ts`; `src/domain/refs/ref-validation.ts`; `src/application/primitives/path-layout.ts`; `ref-store.ts`; `record-ref-update.ts`; `reflog-store.ts`; `internal/ref-write-chain.ts`; `internal/ref-transaction-logging.ts`; `update-ref.ts`; `write-symbolic-ref.ts` |
| Change | See "Write-side worktree ref namespace (ADR-1164)" and its API table. It undoes Part 7's `resolveDirectForWrite`, `writeLocation` and write view. Part 7's read locator becomes `location`. |
| Order | (1) `parseWorktreeRef` + `isRefnameSafe` (domain); (2) `refLocation` (path-layout); (3) the store on `location`, with `resolveDirectForWrite` retired and the `HEAD` slot rule; (4) the reflog writer and store on `.reflog`; (5) the write chain on `resolveDirect` with the file-key walk; (6) `update-ref.ts`/`write-symbolic-ref.ts` refusals. Each step is green on its own. |
| Tests | `per-worktree-ref.test.ts` (one row per arm: `current`, `shared`, `main`, `other`; `worktrees/wt` with no slash, `worktrees/wt/refs/heads/x`, `main-worktree/refs/heads/main` → `shared`). `per-worktree-ref.properties.test.ts`: the round-trip and totality properties move from `mainWorktreeBareName` to `parseWorktreeRef` (`main-worktree/` + per-worktree `n` → `{ main, n }`; `worktrees/<id>/` + per-worktree `n` → `{ other, id, n }`; a shared `n` under either prefix → `shared`). `ref-validation.test.ts` + a property: `isRefnameSafe` true on `refs/` names `validateRefName` accepts and on `[A-Z_]+`, false on `-`, lowercase and digits outside `refs/`. `path-layout.test.ts` (each arm's three paths, main and linked Context). `commondir-refs.test.ts` write rows W2–W13, W15, W17 (paths and logs, both Contexts). `ref-write-chain.test.ts`: the guard's fake-store test is replaced by "every reader goes through `resolveDirect`", plus W18's file-key refusal and a same-name cycle that stays `REF_CYCLE_DETECTED`. `update-ref.test.ts`: W1, W10, W16 (`REF_LOCKED` data, nothing written, and the compare-and-swap refusal first when `expected` mismatches); W24–W28, W34 (`INVALID_REF`, nothing touched); W13, W15 not refused. `write-symbolic-ref.test.ts`: W29, W30. `ref-store-transaction-prepare.test.ts`: Part 7's characterization rows flip to the mapped location. The `HEAD` slot: a `revParse('HEAD')` after W3 or W11 returns B. |

**Part 11 — reftable (DC-15 (a)).**

| | |
|---|---|
| Files | `src/application/primitives/reftable-ref-store.ts`; `src/application/primitives/reftable-transaction.ts`; `internal/ref-transaction-logging.ts` |
| Change | `stackFor` selects by `parseWorktreeRef` and looks up the bare name; `reftable-transaction.ts` L1353 picks the stack the same way and keeps the full record name; `readReflog`/`hasReflog` read the bare name; `REFTABLE.sharedLooseFile = 'allowed'`, `viaHeadName = 'bare'`. `everyStack`/`stackDirs`/`gitDirs` (listing, fsck, packing) are unchanged. |
| Tests | `reftable-ref-store.test.ts` and the reftable `update-ref` suite: W37–W42 by record name and stack, W43, W44, W35 on reftable. |

**Part 12 — write-side interop and docs.**

| | |
|---|---|
| Files | new `test/integration/worktree-ref-namespace-write-interop.test.ts`; `docs/use/commands/rev-parse.md`; `docs/use/primitives/update-ref.md`; `docs/use/errors.md` (`REF_LOCKED`, `INVALID_REF` cases) |
| Rows | Every W row except W23, W31–W33 and W43, which have no tsgit surface or are out of perimeter, from each cwd and `HEAD` shape it was pinned on. Files rows compare the before/after listing of `<common>` outside `objects/` against git's on the same fixture: ref values, and the log lines with the timestamp dropped. Reftable rows compare record names per stack through the reftable reader. Refusals rebuild git's line from the structured data: `REF_LOCKED { name }` gives `fatal: update_ref failed for ref '<name>': cannot lock ref '<name>': Unable to create '<lock of the colliding file>': File exists.`, the path coming from `refLocation` in the test; `INVALID_REF` gives `error: refusing to update ref with bad name '<name>'`. Exit 128 and 1. Each `HEAD` shape runs ×3 on fresh fixtures. |
| Docs | `rev-parse.md` L51 stops stating that writes through these names are unchanged, and that reftable looks up the full name, as ADR-1164 says. `update-ref.md` gains the two refusals and the store routing. `docs/BACKLOG.md`: row 32.56 is not filed (ADR-1164). |

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
| DC-9 | 32.49 (`main-worktree/` resolution) | ADR-1158 | ratified by the user **against** the recommendation; write-side clause *superseded by ADR-1164* | the read side folds in: requirement 12, Part 7, the A25/B8/B14/B15/C3 rows. ADR-1164 (ratified by the user against the impact triage's recommendation) folds the write side too: requirements 14–17, Parts 10–12, rows W1–W44 |
| DC-10 | `badHeadTarget` | ADR-1159 | adopted as recommended | one fact on every store's `HEAD`, graded by `fsck.badHeadTarget`; when error it shadows `badReferentName` and `symrefTargetIsNotARef` |
| DC-11 | `.lock` and dot-led names | ADR-1160 | ratified by the user | both halves: `isSkippedByRefsVerify` in the integrity walk, `isSkippedByLooseIterator` in `walkRefDir` |
| DC-12 | `badRefName` | ADR-1161 | adopted as recommended | the content fact on the prefixed name with `isSafeRefName`, plus a zero pointer in `snapshotTargets` for a listed name failing it |
| DC-13 | Interop layout | ADR-1162 | adopted as recommended | new suite `test/integration/fsck-worktree-private-refs-interop.test.ts` with a multi-worktree seeder; the old suite drops `shownRef` and fixes `printedPath` |
| DC-14 | Keeping the write side off the read mapping | ADR-1163 | adopted as recommended; *superseded by ADR-1164* | was: two locators, `resolveDirectForWrite` at today's `writeLocation`. Now: one locator (`refLocation`) for every reader and writer, Part 10. ADR-1163's inventory of write-route readers carries forward as the list of call sites Part 10 moves to `resolveDirect` |

## Decision candidates

ADR-1158's read-side candidates are settled, and DC-14 sits in the table above. Two read-side
facts were pinned and leave nothing to choose:

- From the main worktree, `main-worktree/<pw>` is located at `<common>/<pw>`, its own gitdir
  (B14 from `w`).
- `worktrees/<id>/<pw>` whose admin dir is missing reads at a path that does not exist and
  stays unresolved (B14 `worktrees/nope/HEAD`). `worktrees/<id>` with no slash is unresolved
  too (B15).

ADR-1164's fold, pinned on W1–W44, leaves five choices:

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| DC-15 | The reftable backend (W37–W44) | (a) git's shape: the stack follows `backend_for`; reads and the symref walk use the bare name; ref and log records are keyed by the **full** prefixed name; no shared-lock refusal; a hop whose bare name is `HEAD` adds no coupled `HEAD` entry; (b) ADR-1164's letter: the selected stack with bare-name record keys, a divergence from git's records that needs its own ADR; (c) keep requirement 11 as written ("behaves as today") and leave the reftable gaps open | **(a)** | git's own reftable writes are the oracle for the data: W38's detached write leaves a `main-worktree/HEAD` record and an unchanged `HEAD`; W40 puts the record in `wt`'s stack. ADR-1164 was ruled on files-backend rows only, and its "on every backend" clause speaks of the store the prefix selects, which (a) honours. Only the record key differs from its letter, so the user rules on it. (b) writes records git never writes. (c) keeps W37 (`main` unmoved), W40 (wrong stack) and W41 (`side` unmoved) as silent divergences. Cost: Part 11. |
| DC-16 | Breadth of the delete and symbolic-ref gate (requirement 16) | (a) git's whole `refname_is_safe` on every delete and symbolic write: it refuses every prefixed name, and also W28's `foo/bar`; (b) only the names `parseWorktreeRef` maps (`main`, `other`), leaving W28's delete accepted | **(a)** | git refuses W24–W30 and W28 through one function, `transaction_refname_valid` (refs.c L1368), so W28 sits on the refusal path this change adds and the fold rule takes it in. (b) needs a second predicate that git does not have. Risk: an internal caller that deletes a lowercase name outside `refs/` would start refusing. See Risks for the proof route. |
| DC-17 | Where the shared-lock key comes from (requirement 15) | (a) a field in the backend table, `TransactionLogging.sharedLooseFile`, with the key `refLocation(ctx, name).loose` computed in `update-ref.ts` and `ref-write-chain.ts`, and no port change; (b) a port method `RefStore.lockIdentity(name)` that each backend answers | **(a)** | The backend table is where the house already keeps per-backend transaction shapes (`noOpDeleteLogs`, `headOldThroughLink`, …), and `viaHeadName` joins it for DC-15. With `resolveDirectForWrite` gone, (a) leaves the port one method smaller. (b) adds a method whose reftable answer never collides. The store-level batch stays permissive under both (W31–W33): no surface queues two caller names in one write. |
| DC-18 | Reflog reads through a prefix (W35, W36) | (a) fold: every reflog path of the store and of `reflog-store.ts` takes `refLocation(...).reflog`, so `readReflog('main-worktree/HEAD')` reads `<common>/logs/HEAD` as git's `reflog` does; (b) writes only: a second reflog locator keeps reads at today's path | **(a)** | With (a), W2 appends to `<common>/logs/HEAD` and the same name reads it back. (b) brings back, for logs, the read/write split ADR-1164 removed for refs: a write lands in a log its own name cannot read. The reflog path builders are shared, so (a) is no extra code, and (b) is the extra code. |
| DC-19 | The shared-lock refusal's data | (a) the existing `REF_LOCKED { name }`, with `name` the caller's name (git's `ref_update_original_update_refname`); (b) a new arm carrying the colliding file's path too | **(a)** | `REF_LOCKED` is already tsgit's "cannot lock ref" refusal for a held `.lock`, which is the same git text. The path follows from `refLocation` of the walked names, so the interop rebuilds git's `Unable to create '<path>.lock'` from data it already has (ADR-249). (b) widens the public error union for one display field. |

Pinned, no choice left:

- the cwd-relative referent strip (requirement 7: A1, A6, B12, B13);
- the exit bits of requirement 5;
- the snapshot's pointer scope (A17 from `w`: another worktree's refs get no pointer);
- the main store's packed-refs-only `packed_fsck` (A14, A15);
- the write store and path for each name, and its log path, from `files_ref_path` and
  `files_reflog_path` (W2–W13, W15, W17, W19–W22);
- the reflog auto-create gate on the full name (W5: no log; W2: `logs/HEAD` appended
  because it exists);
- the shared-lock refusal, its condition and its name (requirement 15: git's source plus
  W1, W10, W16, W18). The detached and `noDeref` shapes pass (W3, W11, W13, W15);
- the compare-and-swap refusal ahead of the shared-lock one (`lock_ref_for_update` checks
  the terminal's old value at its own lock, before the added `HEAD` update is processed);
- deletes and symbolic writes through a prefix are refused (W24–W27, W29, W30, W44). Only
  the gate's breadth is DC-16.

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
- **Locator unit rows** (Parts 7 and 10). One test per `parseWorktreeRef` arm and per
  `refLocation` path (loose, log, `dir`), on both a main and a derived worktree Context. Part
  7's tests that proved each write-route reader read at `writeLocation` flip: each reader now
  reads at the mapped location. Each write row of the files matrix gets a store-level test:
  path, log and the `HEAD` slot. Each refusal gets its own test with `.data` asserted: W1,
  W10, W16, W18 for `REF_LOCKED`; W24–W30, W34 for `INVALID_REF`. One more shows the
  compare-and-swap refusal winning over the shared-lock one.
- **Interop** (Parts 8 and 12). Every row of the matrix that is not n/a or out of scope (E1;
  W14 is replayed as W2, W6 and W8; W23, W31–W33, W43),
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
  blocked-path row kill it). The write side adds four:
  - each `parseWorktreeRef` arm's prefix test;
  - `isRefnameSafe`'s `[A-Z_]` class (W28 against a `-` or digit name);
  - the `HEAD` slot's path comparison (a read of `HEAD` after W3 kills it);
  - the shared-lock check's "different name" conjunct (a same-name cycle kills it).

  Each has an isolated test.
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
- **Breaking behaviour for direct `updateRef` callers** (ADR-1164). Some writes that
  succeeded now refuse: W1, W10, W16, W18, and the deletes W24–W28. Two of those deletes
  removed the wrong ref: W25 removed `wt`'s `refs/bisect/t` and W27 removed
  `refs/heads/side`. Some writes now land elsewhere: W2–W6, W9, W11–W13, W15, W17. The
  changelog names both kinds. No tsgit command writes a prefixed name, so only direct
  primitive callers notice.
- **DC-16 (a) also refuses a delete outside `refs/` with a lowercase name** (W28). Proof
  route, run before Part 10 lands: list every internal `deleteRefs`/`updateRef(… delete)`
  caller's names (fetch, push, remote, branch, tag, notes, stash, the sequencer) and check
  each against `isRefnameSafe`. A failing internal name blocks (a).
- **The cached `HEAD`.** A prefixed write landing on `<gitdir>/HEAD` (W3, W11, W13, W15) that
  failed to drop the slot would serve a stale `HEAD` until the next gate. Part 10 keys the
  invalidation on the path and tests it.
- **Reftable under DC-15 (a)** reproduces git's own stray records: W38's
  `main-worktree/HEAD` and W39's `main-worktree/refs/bisect/x` are invisible to both
  tools' reads, by git's design and not by this change.
- **The store-level batch** (W31–W33) keeps writing two names that share a file. Only
  internal code can queue that shape, and none does. The check lives where the names
  come from: the chain and the coupled `HEAD`.
- **Write-side cost.** `refLocation` replaces `perWorktreeRefDir` on the write routes with one prefix
  test per name. The shared-lock check compares at most chain length + 1 paths, and only on
  the files backend.
- **`RefStore` port shrinks** by `resolveDirectForWrite`. The interface is internal:
  `reports/api.json` carries no `RefStore` symbol.
- **Out of perimeter, found while pinning (W23).** `update-ref worktrees/wt B`: git refuses
  `cannot lock ref 'worktrees/wt': there is a non-empty directory '.git/worktrees/wt/'
  blocking reference 'worktrees/wt'`, exit 128. tsgit refuses `FILE_EXISTS` on
  `<common>/worktrees/wt/HEAD`. Both refuse, but the data differs. It is not designed here,
  and whether to take it up is the user's call.

## Out of scope

- Writes through `main-worktree/<pw>` and `worktrees/<id>/<pw>` left this list with
  ADR-1164 (requirements 14–17).
- The reftable namespace and reflog reads through a prefix are in scope, governed by
  DC-15 and DC-18. A `@{n}` revision through a prefix (`main-worktree/HEAD@{0}`) reaches
  them through `readReflog` and has no row of its own.
- `update-ref worktrees/<id>` with no bare name (W23): see Risks.
- Refusing two caller names that share a file in one store-level batch (W31–W33): no
  surface queues that shape.
- `branch` and `for-each-ref` hiding broken-named refs with `ignoring ref with broken name`
  (E1): a listing-consumer change outside fsck.
- Reftable linked-worktree stores: tsgit's reftable `verifyIntegrity` is unchanged.
- The fsck file-system call count (32.50).
