# `worktree` — add / list / move / remove

## Goal & scope

A `repo.worktree.*` namespace that manages **linked working trees** over one
object store — the four verbs `list` / `add` / `move` / `remove`. A linked
worktree is a second checkout sharing the main repository's objects and shared
refs, with its own `HEAD` / `index` / per-worktree state, tracked by an admin
directory `<commonDir>/worktrees/<id>/`.

This is the structurally-invasive item flagged in the backlog: a faithful
materialising `add` and dirty-checking `remove` force the repository layout to
distinguish the **per-worktree gitdir** from the **shared common dir**. That
split is the core of the work; the four verbs sit on top of it.

**In scope (faithful-by-default, byte-for-byte on-disk, interop-pinned):**

- `commonDir` on `RepositoryLayout` + git's per-worktree-ref rule, threaded
  through object / ref / reflog / config resolution.
- `list` — every worktree (main first), structured: path, HEAD oid, branch (or
  detached), bare, locked, prunable.
- `add` — the default modes: new branch from the path basename, `-b <branch>`,
  check out an existing branch, and `--detach`. Creates the admin dir, the `.git`
  gitfile, the branch + reflog (when a branch is created), and materialises the
  working tree + index.
- `move` — relocate a linked worktree's directory and rewrite its three pointer
  files.
- `remove` — dirty-check (refuse unless `force`) then delete the working tree +
  admin dir.
- Lock awareness — `list` reports `locked`; `move`/`remove` refuse a locked
  worktree. (The `lock`/`unlock` verbs themselves are out of scope — see below.)

**Out of scope (documented non-goals, not faithfulness gaps):**

- `lock` / `unlock` / `prune` / `repair` verbs (24.2 is add/list/move/remove).
  Lock state is **read** (for `list` + refusals); it is not written here.
- `add` advanced flags: `-B` force-create semantics beyond the basic
  already-exists refusal, `--track` / `--guess-remote`, `--orphan`,
  `--no-checkout`, `--lock` on add, `--relative-paths`.
- `openRepository(<linked-worktree-path>)` **discovery** — operating tsgit from
  *inside* a linked worktree (resolving its `.git` gitfile → admin dir →
  commondir at construction time). The four verbs operate from the main (or any
  already-open) worktree's Context; threading `commonDir` here lays the
  groundwork, but wiring runtime layout discovery is a deferred follow-up.
- Sparse-checkout interaction on `add` (a fresh linked worktree materialises the
  full tree; sparse config is not inherited). Documented non-goal.

## Surface — one new namespace, four verbs

`repo.worktree.{ list, add, move, remove }`. Each verb is a Context-aware
function returning a per-verb concrete result (no discriminator), bound through
`internal/worktree-namespace.ts` exactly like `repo.submodule.*`.

Per the structured-output directive (ADR-249), `list` returns **fields**, not a
rendered table; the porcelain layout (`worktree <path>` / `HEAD <oid>` /
`branch …` / `detached` / `locked`) is the caller's to render.

```ts
// list
interface WorktreeListOptions { }                       // (no rendering knobs)
interface WorktreeEntry {
  readonly path: FilePath;                               // absolute worktree path
  readonly head?: ObjectId;                              // absent for a bare main worktree
  readonly branch?: RefName;                             // full refname; absent ⇒ detached/bare
  readonly detached: boolean;
  readonly bare: boolean;
  readonly locked?: { readonly reason: string };         // present ⇒ locked (reason may be '')
  readonly prunable?: { readonly reason: string };       // present ⇒ admin entry whose worktree is gone
  readonly main: boolean;                                // the primary worktree
}
interface WorktreeListResult { readonly entries: ReadonlyArray<WorktreeEntry>; }

// add
interface WorktreeAddOptions {
  readonly path: string;                                 // worktree-relative or absolute target dir
  readonly commitish?: string;                           // start point; default HEAD
  readonly branch?: string;                              // -b: create this new branch
  readonly detach?: boolean;                             // --detach: detached HEAD at commitish
  readonly force?: boolean;                              // override refusals (existing branch / checked-out)
}
interface WorktreeAddResult {
  readonly path: FilePath;
  readonly id: string;                                   // admin id under worktrees/
  readonly head: ObjectId;
  readonly branch?: RefName;                             // created/checked-out branch; absent ⇒ detached
  readonly detached: boolean;
}

// move
interface WorktreeMoveOptions { readonly force?: boolean; }  // force unlocks lock refusal
interface WorktreeMoveResult { readonly from: FilePath; readonly to: FilePath; readonly id: string; }

// remove
interface WorktreeRemoveOptions { readonly force?: boolean; }
interface WorktreeRemoveResult { readonly path: FilePath; readonly id: string; }
```

## The layout split (core architectural change)

### `RepositoryLayout.commonDir`

```ts
interface RepositoryLayout {
  readonly workDir: string;
  readonly gitDir: string;       // per-worktree admin dir for a linked worktree
  readonly commonDir?: string;   // shared dir; absent ⇒ same as gitDir (main worktree / normal repo)
  readonly bare: boolean;
  readonly homeDir?: string;
}
```

A single helper resolves it: `commonGitDir(ctx) = ctx.layout.commonDir ?? ctx.layout.gitDir`.
Every existing repository (main worktree, normal, bare) leaves `commonDir`
undefined, so **all current call sites are byte-for-byte unchanged** — the field
defaults to `gitDir`. Only a worktree **child Context** sets it.

### What lives where (git's rule)

| state | location | resolver consumes |
|---|---|---|
| objects (loose + packs) | `commonDir/objects` | `commonGitDir` |
| `packed-refs`, `config` | `commonDir` | `commonGitDir` |
| shared refs `refs/heads,tags,remotes/**`, their reflogs | `commonDir` | `commonGitDir` |
| `HEAD`, `ORIG_HEAD`, `index` | `gitDir` | `gitDir` |
| per-worktree refs `refs/bisect,worktree,rewritten/**`, `*_HEAD`, in-progress markers | `gitDir` | `gitDir` |
| `logs/HEAD` | `gitDir` | `gitDir` |

The loose-ref / reflog selection is a pure predicate
`isPerWorktreeRef(name): boolean` (git's `is_per_worktree_ref` +
`is_pseudoref` set): `HEAD`, `ORIG_HEAD`, `MERGE_HEAD`, `CHERRY_PICK_HEAD`,
`REVERT_HEAD`, `BISECT_HEAD`, `FETCH_HEAD`, and any ref under `refs/bisect/`,
`refs/worktree/`, `refs/rewritten/`. Everything else is shared.

### Threaded primitives (commonDir-aware)

Behaviour-preserving for the main worktree (`commonDir === gitDir`):

- `object-resolver`, `pack-registry`, `resolve-oid-prefix` → objects from `commonGitDir`.
- `ref-store` → `looseRefPath` picks `gitDir` for `isPerWorktreeRef`, else
  `commonGitDir`; `packedRefsPath` from `commonGitDir`.
- `reflog-store` → `reflogPath` picks `gitDir` for `isPerWorktreeRef(ref)`, else `commonGitDir`.
- `config-read` / `config-scope` → shared config from `commonGitDir`.
- `internal/read-gitignore` → `info/exclude` from `commonGitDir` (the worktree's
  own `.gitignore`/nested ignores stay under `workDir`).
- `read-index` / `index-lock` → **unchanged** (`gitDir`; index is per-worktree).

Each is exercised by a worktree path: object/oid-prefix resolution by `add`'s
materialise and `remove`'s dirty-check; ref/config/gitignore by `remove`'s child
`status`; reflog by `add`'s `logs/HEAD`. The full set is what a worktree child
Context needs to behave like a real linked worktree.

### The worktree child Context

`deriveWorktreeContext(ctx, adminId, absWorktreePath)` builds a frozen child:
`gitDir = <commonDir>/worktrees/<id>`, `commonDir = <parent commonDir>`,
`workDir = <absWorktreePath>`, `bare: false`. `promisor`/`hooks` are dropped
(they close over the parent), mirroring `deriveSubmoduleContext`. Used by:

- `add`'s materialise (objects ← commonDir, index → admin, files → worktree),
- `remove`'s dirty-check (`status(child)`).

## Faithful on-disk behaviour (verified against git 2.54.0)

### Admin layout, per linked worktree

`<commonDir>/worktrees/<id>/` contains:

- `HEAD` — `ref: refs/heads/<b>\n` (branch) or `<oid>\n` (detached).
- `commondir` — `../..\n` (admin dir is two levels under commonDir).
- `gitdir` — absolute path to the worktree's own `.git` file, `<absPath>/.git\n`.
- `ORIG_HEAD` — `<oid>\n`.
- `index` — the worktree's index (materialised).
- `logs/HEAD` — the worktree HEAD reflog (see below).

The worktree directory gets a `.git` **file** (not dir):
`gitdir: <abs admin dir>\n`.

**Admin id** = the path's last component, integer-deduplicated against existing
admin dirs: `shared`, then `shared1`, `shared2`, … (no separator; git's
`worktree.c` counter). Unsafe components (`.`/`..`/empty) are rejected.

### `add` writes, in order

1. Validate: `path` non-empty & safe; refuse a non-empty existing target dir
   (an **empty** existing dir is allowed — git's behaviour); resolve `commitish`
   (default `HEAD`) → start oid + tree.
2. Decide mode:
   - `branch` set (`-b`) → create new branch `<branch>` at start oid; refuse
     `BRANCH_EXISTS` unless `force`.
   - else `commitish` names an existing local branch & not `detach` → check that
     branch out (no new branch); refuse if it is already used by another
     worktree (`BRANCH_CHECKED_OUT`) unless `force`.
   - else no `commitish` & not `detach` → new branch = path basename at HEAD oid
     (refuse `BRANCH_EXISTS` unless `force`).
   - else (`detach`, or a non-branch commitish) → detached HEAD at start oid.
3. When a branch is created: write `refs/heads/<b>` (commonDir) + its reflog
   `branch: Created from <commitish ?? 'HEAD'>` (the start point exactly as
   typed) via the parent Context, reusing the existing branch-creation path.
4. Allocate admin id; write `commondir`, `gitdir`, `HEAD`, then the worktree
   `.git` gitfile.
5. Materialise the start tree into the worktree dir with the index at
   `<admin>/index` (child Context).
6. Write `ORIG_HEAD = <oid>` and `logs/HEAD`.

**`logs/HEAD` bytes (byte-faithful, per mode):**

- branch / existing-branch: **two** entries —
  `0…0 <oid> <ident> <t> <tz>\n` (empty message, **no tab**) then
  `<oid> <oid> <ident> <t> <tz>\treset: moving to HEAD\n`.
- detached: **one** entry — `0…0 <oid> <ident> <t> <tz>\n` (empty message, no tab).

The empty-message-with-no-tab form is git's canonical reflog rule
(`if (msg && *msg) append '\t' + msg`). tsgit's `serializeReflogLine` currently
**always** emits the tab; this PR makes the codec faithful — empty message ⇒ no
tab on serialize, and `parseReflogLine` tolerates a tab-less line (empty
message). This is the first place tsgit needs an empty reflog message; it is a
small, property-tested round-trip improvement to the domain codec.

### `add` refusals

- target dir exists & non-empty → `WORKTREE_PATH_EXISTS`.
- new branch already exists (no `force`) → `BRANCH_EXISTS`.
- requested branch already used by another worktree (no `force`) → `BRANCH_CHECKED_OUT`.
- `commitish` unresolvable → `REVPARSE_UNRESOLVED` (existing).
- bare-repo guard where a working tree is required is N/A — `add` is the verb
  that *creates* a working tree; it is permitted from a bare main repo.

### `list`

Main worktree first (path = `workDir`, HEAD from `commonDir/HEAD`), then each
`<commonDir>/worktrees/<id>/` in git's enumeration order (pinned by interop —
confirmed against `git worktree list` rather than assumed). Per entry:

- `head` = the admin `HEAD` oid (resolved through the symref when present).
- `branch` = the symref target when `HEAD` is `ref: refs/heads/<b>`, else absent
  (`detached: true`).
- `locked` present iff `<admin>/locked` exists; `reason` is its trimmed content
  (`''` when empty).
- `prunable` present iff the admin `gitdir` target no longer exists.
- `bare` true for a bare main worktree (no `head`, no `branch`).

`list` is also the substrate for `add`'s "already used by another worktree"
check and for `move`/`remove`'s target resolution.

### `move`

Refuse a locked source (no `force`) → `WORKTREE_LOCKED`; refuse a non-empty
existing destination → `WORKTREE_PATH_EXISTS`; refuse moving the main worktree
→ `INVALID_OPTION`. Then: rename the worktree directory, rewrite
`<admin>/gitdir` (new `<absDest>/.git`) and the moved `<dest>/.git` gitfile
(`gitdir:` is unchanged — it points at the admin dir, which does not move). Admin
id is stable across a move.

### `remove`

Refuse a locked worktree (no `force`) → `WORKTREE_LOCKED`; refuse the main
worktree → `INVALID_OPTION`; dirty-check via `status(child)` and refuse
`WORKTREE_DIRTY` (modified tracked **or** untracked non-ignored files) unless
`force`. Then `rmRecursive` the worktree directory and the admin dir. The branch
is left intact (git leaves it).

## Module structure

```
src/domain/worktree/
  admin-id.ts          # worktreeAdminId(basename, taken) + safety (pure)
  admin-files.ts       # commondir / gitdir / gitfile / HEAD formatters (pure)
  per-worktree-ref.ts  # isPerWorktreeRef(name) (pure predicate)
  error.ts             # worktree* error factories
src/domain/reflog/reflog-format.ts   # (edit) empty-message ⇔ no-tab faithfulness

src/ports/context.ts                 # (edit) RepositoryLayout.commonDir
src/application/primitives/
  path-layout.ts                     # (edit) commonGitDir(ctx) helper
  object-resolver.ts pack-registry.ts resolve-oid-prefix.ts   # (edit) commonDir
  ref-store.ts reflog-store.ts       # (edit) per-worktree-ref rule
  config-read.ts internal/config-scope.ts                     # (edit) commonDir
  list-worktrees.ts                  # (new) read admin dirs → WorktreeEntry[]
  internal/worktree-context.ts       # (new) deriveWorktreeContext

src/application/commands/
  worktree.ts                        # (new) worktreeList/Add/Move/Remove
  internal/worktree-namespace.ts     # (new) bindWorktreeNamespace
  index.ts                           # (edit) barrel exports
src/repository.ts                    # (edit) repo.worktree binding + interface
```

## Algorithms

### `worktreeAdd(ctx, opts)`

```
assertRepository(ctx)
target = resolveTargetDir(ctx, opts.path)          # abs; refuse non-empty existing
start  = resolveStartPoint(ctx, opts.commitish)    # {oid, tree, typedName}
mode   = decideMode(ctx, opts, start)              # new-branch | checkout-branch | detached
if mode.createsBranch: writeBranchAndReflog(ctx, mode.branch, start)   # parent ctx, commonDir
id     = worktreeAdminId(basename(target), existingAdminIds(ctx))
writeAdminFiles(ctx, id, target, mode.head)        # commondir, gitdir, HEAD, ORIG_HEAD
writeWorktreeGitfile(target, adminDir(ctx, id))
child  = deriveWorktreeContext(ctx, id, target)
# under the child index lock: readIndex(child) (empty) → materializeTree → lock.commit
materializeTree(child, { targetTree: start.tree, currentIndex: readIndex(child) })
writeWorktreeHeadReflog(child, mode, start.oid)    # 1 or 2 entries; empty-message-faithful
return { path: target, id, head: start.oid, branch?, detached }
```

### `worktreeList(ctx)`

```
entries = [ mainEntry(ctx) ]
for id in sort(readdir(commonDir/worktrees)):
  gitdirTarget = read(admin/gitdir)
  entries.push(linkedEntry(id, admin/HEAD, locked?, prunable = !exists(dirname(gitdirTarget))))
return { entries: entries sorted main-first-then-by-path }
```

### `worktreeMove` / `worktreeRemove`

Resolve the target admin entry from `list` (matching the normalised path); a
path that is not a linked worktree refuses `NOT_A_WORKTREE`. `move`: guard lock +
destination, `fs.rename(dir)`, rewrite `gitdir` + gitfile. `remove`: guard lock +
main + dirty (`status(child)`), `rmRecursive(dir)` + `rmRecursive(adminDir)`.

## Security

- **Path containment.** `path` components are validated by the same
  `isUnsafeSubmoduleName`-class rules (no `.`/`..`/empty/abs/drive/backslash/
  control) before any join, so an admin id and a worktree path can never escape
  the repo. The target may be absolute (worktrees can live anywhere) but is
  realpath-normalised; the FS validator still guards reads/writes under the
  containment root for the admin dir and the object store.
- **Symlink-safety.** Admin-dir and worktree removals go through the
  symlink-safe `rmRecursive`; the gitfile/admin writes use the existing
  exclusive/no-follow FS contract.
- **No new network / credential surface.** All four verbs are local-only.
- **Lock + dirty gating** prevent destroying a worktree another process guards
  or a user has uncommitted work in.

## Surface gates (new Tier-1 namespace)

A new namespace touches the standard gate set: command barrel export, facade
interface + binding, `repository.test` key-set, README command count + an
`api.json` regeneration, a browser scenario (memory adapter), and the
doc-coverage page. All are part of this PR.

## Testing strategy

- **Domain (unit + properties).** `admin-id` (basename + integer dedup, safety),
  `admin-files` (pure formatters), `per-worktree-ref` (predicate sweep + a
  property: shared refs ↔ commonDir), `reflog-format` empty-message round-trip
  (property: `parse(serialize(x)) ≡ x` incl. empty message).
- **Primitive (unit, memory adapter).** `list-worktrees` (main-only, linked,
  detached, locked, prunable), `deriveWorktreeContext` (layout split),
  commonDir-threaded resolvers (object/ref/config read from commonDir, index from
  gitDir).
- **Command (unit, memory adapter).** Each verb's modes + every refusal,
  asserting structured results + on-disk admin bytes.
- **Integration / interop (node adapter, real git twin).** `worktree-interop`
  reconstructs `git worktree add` (all four modes) / `list --porcelain` / `move`
  / `remove` byte-for-byte: admin files, `.git` gitfile, branch ref + reflog,
  `logs/HEAD` (per-mode), `ORIG_HEAD`, index + working tree parity, and each
  refusal. Cross-adapter parity for the structured `list`.

## Decisions (for ADRs)

1. **`commonDir` on the layout + per-worktree-ref rule** — the split that makes
   linked worktrees faithful; defaults to `gitDir` so existing repos are
   unchanged. (ADR)
2. **Reflog codec: empty message ⇔ no tab** — make the domain codec faithful to
   git's `if (msg && *msg)` rule, required by `add`'s `logs/HEAD` line 1. (ADR)
3. **Four verbs operate from the main Context; `openRepository` discovery
   deferred** — bounds the blast radius (no runtime layout-discovery change);
   the user selected the single-PR, discovery-deferred scope. (ADR)
4. **Lock is read-only here; `lock`/`unlock`/`prune` verbs deferred** — `list`
   reports lock/prunable and `move`/`remove` honour the lock, but writing lock
   state is a later item. (ADR)
```
