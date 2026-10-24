# `status`

Compare the working tree, the index, and HEAD. Returns a structured `StatusResult` — caller-side filtering is straightforward via array methods (pathspec filtering at the command level is deferred per ADR-039).

## Signature

```ts
repo.status(opts?: StatusOptions): Promise<StatusResult>;

interface StatusOptions {
  /** Default true. false = git `--no-optional-locks status`: the index is never written. */
  readonly refresh?: boolean;
}

interface StatusResult {
  readonly branch: RefName | undefined; // the branch HEAD names; undefined when detached or unknown
  readonly detached: boolean; // true only when HEAD holds an object id
  readonly changes: ReadonlyArray<ChangedPath>;
  readonly untracked: ReadonlyArray<FilePath>;
  readonly unmerged: ReadonlyArray<UnmergedEntry>;
  readonly clean: boolean;
}

// 'modified' | 'added' | 'deleted' | 'type-changed' | 'mode-changed'
type ChangeKind = string;

interface BlobSide {
  readonly id: ObjectId;
  readonly mode: FileMode;
}

interface WorktreeSide {
  readonly mode: FileMode;       // mW — no oid (working file is not in the object store)
}

interface ChangedPath {
  readonly path: FilePath;
  readonly staged?: ChangeKind;   // X — index vs HEAD
  readonly unstaged?: ChangeKind; // Y — working tree vs index
  readonly head?: BlobSide;       // hH / mH
  readonly index?: BlobSide;      // hI / mI
  readonly worktree?: WorktreeSide;
  readonly submodule?: {          // S<c><m><u> — present when the HEAD or index side is a gitlink
    readonly commitChanged: boolean;   // C — the submodule's HEAD moved
    readonly trackedChanges: boolean;  // M — the submodule's own status shows tracked changes
    readonly untrackedChanges: boolean; // U — the submodule holds untracked files
  };
}

type ConflictKind =
  | 'both-modified' | 'both-added' | 'both-deleted'
  | 'added-by-us' | 'added-by-them' | 'deleted-by-us' | 'deleted-by-them';

interface UnmergedEntry {
  readonly kind: ConflictKind;
  readonly path: FilePath;
  readonly base?: BlobSide;       // stage 1 (merge base) — m1 / h1
  readonly ours?: BlobSide;       // stage 2 (our side)   — m2 / h2
  readonly theirs?: BlobSide;     // stage 3 (their side) — m3 / h3
  readonly worktree?: WorktreeSide; // mW — on-disk mode (no oid), omitted when absent
}
```

## Behaviour

- **Refresh write-back.** Like git, `status` refreshes the index's cached stat data. The optional `index.lock` is taken **after** the tracked scan and held across the report and the untracked scan. The refreshed index is written only when an entry's stat data was refreshed or an entry is racy against the index file's mtime (compared at second granularity), and only while the on-disk index is unchanged since it was read (a trailer check); otherwise nothing is written. `refresh: false` (git's `--no-optional-locks`) takes no lock and never writes. The `GIT_OPTIONAL_LOCKS` variable, read from the context env, disables it too (`0`, `false`, `off`, `no` or the empty string); `refresh: false` wins without reading the variable. A value that is not a boolean refuses with `ENV_BAD_BOOLEAN_VALUE`. A failure to take the lock or to write the refresh degrades to a read-only status, reported through `ctx.logger.warn('status: index refresh skipped', { code, path, reason })` and never in the result.
- **Index extensions on a refresh write.** `TREE`, `REUC` and `UNTR` are kept byte-for-byte; any other extension is dropped, as git does on every index write.
- **No filter section, no filter resolution.** With no `[filter]` section in the config, the comparison skips filter-driver resolution entirely.
- **One correlated record per path.** `changes` holds one `ChangedPath` per tracked path with a change — the structured form of `git status --porcelain=v2`'s ordinary line. `staged` (git's X, index vs HEAD) and `unstaged` (git's Y, working tree vs index) live on the **same** record, so correlating the two columns is a lookup, not a join. `clean` is `true` only when `changes`, `untracked`, **and** `unmerged` are all empty.
- **Self-describing endpoints → hunks.** Each record carries the blobs that form its diffs: `head`/`index` (`{ id, mode }`) and `worktree` (`{ mode }` only — git prints `mW` but no working oid). The hunks for any path are one read away — staged: `readBlob(head)` vs `readBlob(index)`; unstaged: `readBlob(index)` vs the working file at `path`. A side is omitted when the path does not exist there (staged add → no `head`; staged delete → no `index`; deleted in the worktree → no `worktree`).
- **Untracked.** `untracked` is the separate set of untracked paths (git's `?` lines). A directory the index records as a gitlink is never scanned, whatever its `.git` is, so a submodule's files never appear here. An untracked directory that holds a repository is listed once, as `<dir>/`, and its files are not listed; the directory's `.git` must lead to a usable repository, otherwise it is a plain directory and its files are listed. A path removed from the index but kept on disk (`git rm --cached`) appears as a staged `deleted` record in `changes` **and** in `untracked` — git's `D ` + `??`.
- **First-class `type-changed` / `mode-changed`.** Both columns distinguish a kind change (file↔symlink, git porcelain `T`) as `type-changed` and a same-blob mode-only change (exec bit, git `M`) as `mode-changed`, alongside content `modified` (ADR-255). To reconstruct git's porcelain `XY`, map `type-changed → T` and `mode-changed → M`.
- **Gitlinks.** A gitlink is compared with its submodule's checked-out HEAD, not hashed: an unresolvable HEAD counts as unchanged. Its worktree mode is `160000` over a directory; a file or symlink at its path is `type-changed`. Its row carries `submodule` with the three flags (`commitChanged` = HEAD moved, `trackedChanges` = the submodule's own status shows tracked changes, `untrackedChanges` = it holds untracked files); rows without a gitlink on the HEAD or index side have none. Rebuild git's field with `` `S${c ? 'C' : '.'}${m ? 'M' : '.'}${u ? 'U' : '.'}` `` (or `N...` when `submodule` is absent).
- **Submodule ignore modes.** Each gitlink's mode is, first set wins, its own `submodule.<name>.ignore` in `.git/config`, the `ignore` of its `.gitmodules` row (the working-tree file, else the `.gitmodules` blob the index holds; an unknown value there reads as unset), then `diff.ignoreSubmodules`, else `none`. `all` hides the gitlink's working-tree changes (staged rows stay); `dirty` keeps only `commitChanged` and never opens the submodule; `untracked` drops `untrackedChanges`. A value outside the four modes in `.git/config` refuses `CONFIG_INVALID_ENUM_VALUE`, and a key without a value `CONFIG_MISSING_VALUE`; `diff.ignoreSubmodules` is checked on every run, even without a submodule. A symlink at a gitlink path refuses `SUBMODULE_PATH_IS_SYMLINK` under `none` and `untracked` (under `dirty` the row is a `type-changed`). A `.git` that leads to no repository refuses `GITFILE_TOO_LARGE` or `NOT_A_REPOSITORY` (`all` and `dirty` never read it), and an error from the submodule's own status propagates unchanged. Without a `.gitmodules` row naming the path, git reads no per-submodule key at all: only `diff.ignoreSubmodules` applies, and a `submodule.<path>.ignore` key in `.git/config` is neither honoured nor validated. A skip-worktree or assume-valid gitlink never reaches the submodule config either, so an invalid key for it is not refused.
- **Unmerged paths.** `unmerged` reports conflicted paths (index stages 1/2/3 — git's "Unmerged paths"), each with a `kind` (the seven git conflict states, reconstructing the `UU`/`AA`/`DD`/`AU`/`UA`/`DU`/`UD` codes), the present per-stage blobs (`base`/`ours`/`theirs`), and the conflicted file's on-disk mode (`worktree`, git's `mW`; omitted when the file is absent on disk — `git status --porcelain=v2` then prints `000000`). With the stages plus `worktree`, the full v2 `u` line (`u <XY> N... <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`) reconstructs byte-for-byte. A conflicted path is reported **only** here, never in `changes`/`untracked` (ADR-256).
- **Byte-exact paths.** A lossy entry (a name that is not valid UTF-8) is never read from disk, so it reports as deleted from the work tree, as git does on macOS. Index, `HEAD` and work-tree sides are joined by raw path bytes; every `path` in the result is the U+FFFD view.
- **Unborn HEAD.** With no commit yet, the HEAD tree is empty, so every staged entry is `added` (no `head` side).
- **Line-ending conversion before comparing.** The worktree bytes of a regular file go through the check-in conversion (clean filter, `core.autocrlf` / `core.eol` / `text` / `eol` / `ident`) before being hashed against the index blob, so a file checked out as CRLF under `core.autocrlf=true` and left alone reads clean. The comparison never writes an object and never raises a `core.safecrlf` refusal or notice. The index-CRLF rule (`text=auto` family) reads the entry's own blob. Attributes come from the worktree `.gitattributes`, else the index blob. Symlinks are compared raw.
- **Racy-clean entries** (same-second as the index) are re-checked through the same conversion, so a converted checkout stays clean after the racy smudge.
- **Size-0 entries.** An entry whose recorded size is 0 (never stat'd: `reset --mixed`, `read-tree`) is not trusted on size; its content is compared, as git's `ie_modified` does.
- **Malformed config.** A `core.autocrlf` or `core.safecrlf` value outside git's boolean grammar (plus `input` / `warn`) refuses with `CONFIG_BAD_BOOLEAN_VALUE`; an unknown `core.eol` is treated as unset.
- **Stat-cache fast path:** entries whose `mtime/ctime/size/ino` match the index's recorded stat fields are not re-hashed. This is the hot path that `add`/`commit`/`reset --mixed` populate.
- **One stat sample per path.** The tracked pass (`compareWorkingTreeDelta`) and the untracked walk never `lstat` the same path: the untracked walk excludes every tracked path by construction and never reads a leaf's stat at all, so the two passes' `lstat`ed paths are structurally disjoint — a path is `lstat`ed at most once per `status()` call. (Earlier revisions deduplicated this with a stat cache shared across both passes; the cache was write-only — the untracked pass never consulted it — so it was removed once the structural guarantee was confirmed, not replaced by another cache.)
- **Sparse-aware:** out-of-cone paths marked `skip-worktree` are not reported as deletions.
- **`.gitignore` integration:** untracked files matched by an ignore rule are filtered out before `clean` is computed.
- **HEAD states.** On a branch, `branch` is set and `detached` is `false` (an unborn branch keeps its name). Detached, `branch` is `undefined` and `detached` is `true`. Unknown, `branch` is `undefined` and `detached` is `false`, git's `# branch.head (unknown)`. HEAD is unknown when its chain cannot be read: a target whose loose path the file system refuses as too long, a target name git refuses, or a symbolic cycle. The report then has no HEAD tree, so every staged entry is `added` with no `head` side, as in git's `# branch.oid (initial)`.

## Examples

```ts
const { clean, branch, changes, untracked } = await repo.status();
if (!clean) {
  const staged = changes.filter(c => c.staged !== undefined).length;
  const unstaged = changes.filter(c => c.unstaged !== undefined).length;
  console.log(`on ${branch}, ${staged} staged, ${unstaged} unstaged, ${untracked.length} untracked`);
}

// Caller-side filter — only TS files
const ts = changes.filter(c => c.path.endsWith('.ts'));

// Hunks for a staged change, straight from its endpoints
const c = changes.find(x => x.path === 'src/app.ts');
if (c?.head && c.index) {
  const before = await repo.primitives.readBlob(c.head.id);
  const after = await repo.primitives.readBlob(c.index.id);
  // diffLines(before.content, after.content) → the staged hunks
}
```

## See also

- Primitives: [`readIndex`](../primitives/read-index.md), [`walkWorkingTree`](../primitives/walk-working-tree.md), [`diffTrees`](../primitives/diff-trees.md), [`readBlob`](../primitives/read-blob.md)
- Related commands: [`add`](add.md), [`diff`](diff.md), [`checkout`](checkout.md), [`describe`](describe.md)
- ADRs: [039](../../adr/039-defer-status-pathspec.md), [254](../../adr/254-status-staged-column-coarse-changekind.md) (superseded), [255](../../adr/255-status-first-class-type-and-mode-change.md), [256](../../adr/256-status-unmerged-paths-field.md), [950](../../adr/950-conversion-extends-the-clean-smudge-pipeline.md), [269](../../adr/269-status-correlated-changed-path-record.md), [633](../../adr/633-walk-working-tree-lazy-stat.md), [634](../../adr/634-status-shared-stat-map.md) (superseded — the shared stat map it introduced proved write-only and was removed; the passes' `lstat`s are disjoint structurally, not via a cache)
- Roadmap: Phase 22 — pathspec scoping on `status`
