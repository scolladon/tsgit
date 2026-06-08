# Implementation plan — `worktree`

TDD, one slice = one atomic commit, `npm run validate` green before each commit.
Tests follow GWT describe/it + AAA + `sut`. Each slice lists Red → Green.
Behaviour-preserving threading slices (2–4) keep every existing test green
(`commonDir` defaults to `gitDir`).

## Slice 0 — reflog codec: empty message ⇔ no tab (ADR-295)

- **Red** `domain/reflog/reflog-format.test.ts` (+ `.properties.test.ts`):
  - `serializeReflogLine({…, message: ''})` ⇒ `…<tz>\n` (no `\t`).
  - `parseReflogLine('<old> <new> <ident> <t> <tz>')` (tab-less) ⇒ entry with
    `message === ''`.
  - property: `parseReflogLine(serializeReflogLine(x)) ≡ x` for arbitrary entries
    incl. empty message.
- **Green** `serializeReflogLine`: append `\t${message}` only when
  `message !== ''`. `parseReflogLine`: when no `\t`, treat the whole line as
  meta with `message = ''` (keep the field-separator position checks).
- Commit: `fix(reflog): serialise an empty message without a tab (git parity)`.

## Slice 1 — `commonDir` layout field + helper + per-worktree-ref predicate

- **Red**
  - `domain/refs/per-worktree-ref.test.ts` (+ property): `isPerWorktreeRef`
    true for `HEAD`/`ORIG_HEAD`/`MERGE_HEAD`/`CHERRY_PICK_HEAD`/`REVERT_HEAD`/
    `BISECT_HEAD`/`FETCH_HEAD` and `refs/bisect|worktree|rewritten/*`; false for
    `refs/heads|tags|remotes/*`. Property: any `refs/heads/<x>` is shared.
  - `path-layout.test.ts`: `commonGitDir(ctx)` returns `layout.commonDir` when
    set, else `layout.gitDir`.
- **Green**
  - `ports/context.ts`: `RepositoryLayout.commonDir?: string` (+ doc).
  - `path-layout.ts`: `export const commonGitDir = (ctx) => ctx.layout.commonDir ?? ctx.layout.gitDir`.
  - `domain/refs/per-worktree-ref.ts`: pure predicate.
- Commit: `feat(layout): add commonDir + per-worktree-ref predicate`.

## Slice 2 — object resolution from the common dir

- **Red** `object-resolver` / `pack-registry` / `resolve-oid-prefix` tests: with
  a context whose `commonDir` ≠ `gitDir`, a loose/packed object written under
  `commonDir/objects` resolves; one under `gitDir/objects` does not.
- **Green** swap `ctx.layout.gitDir` → `commonGitDir(ctx)` at
  `object-resolver.ts:151`, `pack-registry.ts:68`, `resolve-oid-prefix.ts:25`.
- Existing object tests stay green (default `commonDir === gitDir`).
- Commit: `feat(objects): resolve loose + pack objects from the common dir`.

## Slice 3 — ref + reflog split (per-worktree rule)

- **Red** `ref-store.test.ts` / `reflog-store.test.ts`: with `commonDir` ≠
  `gitDir`, `HEAD`/`ORIG_HEAD` read+write under `gitDir`; `refs/heads/*`,
  `packed-refs`, and `logs/refs/heads/*` under `commonDir`.
- **Green**
  - `ref-store`: `packedRefsPath(commonGitDir(ctx))`; `looseRefPath(isPerWorktreeRef(name) ? ctx.layout.gitDir : commonGitDir(ctx), name)` at all four sites.
  - `reflog-store`: `reflogPath(isPerWorktreeRef(ref) ? ctx.layout.gitDir : commonGitDir(ctx), ref)` at the append/read/exists/write/delete sites. `logsDir` (listReflogs) stays `gitDir` (not on the v1 worktree path; documented).
- Commit: `feat(refs): split per-worktree vs shared ref + reflog storage`.

## Slice 4 — config + info/exclude from the common dir

- **Red** `config-read.test.ts` / `config-scope.test.ts` /
  `read-gitignore.test.ts`: with `commonDir` ≠ `gitDir`, local `config`,
  `extensions.worktreeConfig` probe, and `info/exclude` resolve under
  `commonDir`; `config.worktree` stays under `gitDir`.
- **Green** `config-read.ts:84` local read → `commonGitDir(ctx)`;
  `config-scope.ts` `resolveScopePath('local')` + `isWorktreeScopeActive` →
  `commonGitDir(ctx)` (leave `worktree` scope on `gitDir`);
  `read-gitignore.ts:26` → `commonGitDir(ctx)`.
- Commit: `feat(config): read shared config + info/exclude from the common dir`.

## Slice 5 — pure worktree domain (admin id / files / errors)

- **Red**
  - `domain/worktree/admin-id.test.ts` (+ property): `worktreeAdminId(base, taken)`
    returns `base` when free, else `base`+smallest free integer (`shared`→`shared1`);
    rejects `.`/`..`/empty. Property: result never ∈ `taken`.
  - `domain/worktree/admin-files.test.ts`: `worktreeCommondir()` ⇒ `'../..'`;
    `worktreeGitdirFile(abs)` ⇒ `'<abs>/.git'`; `worktreeGitfile(absAdmin)` ⇒
    `'gitdir: <absAdmin>'`; `worktreeHead({branch})`/`{oid}` content.
  - `domain/worktree/error.test.ts`: each factory carries its code + data
    (`WORKTREE_PATH_EXISTS`/`BRANCH_CHECKED_OUT`/`WORKTREE_LOCKED`/
    `WORKTREE_DIRTY`/`NOT_A_WORKTREE`).
- **Green** the three pure modules; add the error codes to the `CommandError`
  union + factories (mirroring `domain/submodule/error.ts`).
- Commit: `feat(worktree): pure admin-id, admin-file + error helpers`.

## Slice 6 — `list-worktrees` primitive + `deriveWorktreeContext`

- **Red**
  - `list-worktrees.test.ts` (memory adapter): main-only repo ⇒ one `main`
    entry; a linked branch worktree ⇒ `{ branch, head, detached:false }`; a
    detached one ⇒ `{ detached:true }`; a `locked` file ⇒ `locked.reason`
    (`''` when empty); a missing `gitdir` target ⇒ `prunable`.
  - `internal/worktree-context.test.ts`: `deriveWorktreeContext(ctx,id,abs)` ⇒
    `gitDir = commonDir/worktrees/<id>`, `commonDir = parent commonGitDir`,
    `workDir = abs`, `bare:false`, no `promisor`/`hooks`.
- **Green** both modules. `listWorktrees` resolves each admin `HEAD` (symref →
  branch ref via parent ref-store) to `head`; sorts main-first then git's order.
- Commit: `feat(worktree): list primitive + child-context derivation`.

## Slice 7 — `worktreeList` command

- **Red** `commands/worktree.test.ts`: `worktreeList(ctx)` returns the structured
  entries (delegates to the primitive); `assertRepository` guard.
- **Green** `commands/worktree.ts` `worktreeList`.
- Commit: `feat(worktree): list command`.

## Slice 8 — `worktreeAdd` command (all default modes + refusals)

Large slice; build the mode decision first, then refusals.

- **Red** (memory adapter, asserting structured result + admin bytes):
  - new-branch-from-basename (`{path}`): branch `basename` at HEAD; admin `HEAD`
    `ref: refs/heads/<basename>`; gitfile; `ORIG_HEAD`; index + worktree files;
    `logs/HEAD` two entries (empty-msg + `reset: moving to HEAD`).
  - `-b` (`{path, branch, commitish?}`): new branch `<branch>` at commitish||HEAD.
  - checkout-existing (`{path, commitish: <branch>}`): `HEAD` symref to the
    branch, branch ref unmoved.
  - detached (`{path, detach, commitish}` or non-branch commitish): `HEAD` = oid;
    `logs/HEAD` single empty-msg entry.
  - refusals: non-empty existing target ⇒ `WORKTREE_PATH_EXISTS`; new branch
    exists (no force) ⇒ `BRANCH_EXISTS`; branch already used by a worktree (no
    force) ⇒ `BRANCH_CHECKED_OUT`; unresolvable commitish ⇒ `REVPARSE_UNRESOLVED`.
    Each guard isolated.
- **Green** `worktreeAdd`:
  1. `assertRepository`; resolve `target` (abs; refuse non-empty existing dir —
     empty allowed).
  2. `oid = resolveCommit(ctx, opts.commitish ?? 'HEAD')`; `tree = readTree(ctx, oid)`.
  3. decide mode (in order): `opts.branch` ⇒ **create** `<branch>`;
     else `opts.detach` ⇒ **detached** at oid; else `opts.commitish` names a
     local branch (`refs/heads/<commitish>` resolves) ⇒ **checkout-existing**
     (refuse via `listWorktrees` if already used, unless force); else no
     `commitish` ⇒ **create** `basename(path)`; else ⇒ **detached**.
  4. if `createsBranch`: `branchCreate(ctx, { name, startPoint: opts.commitish ?? 'HEAD', force })`.
  5. `id = worktreeAdminId(basename(target), existingAdminIds(ctx))`; write
     `commondir`/`gitdir`/`HEAD`/`ORIG_HEAD`; write the worktree `.git` gitfile.
  6. `child = deriveWorktreeContext(ctx, id, target)`; under the child index lock
     `materializeTree(child, { targetTree: tree.id, currentIndex: readIndex(child) })`
     → `lock.commit`.
  7. write `logs/HEAD` via `recordRefUpdate(child, 'HEAD', …)` — entry 1
     `(zero→oid, '')`; for the branch/checkout modes also entry 2
     `(oid→oid, 'reset: moving to HEAD')`.
  8. return `{ path, id, head: oid, branch?, detached }`.
- Commit: `feat(worktree): add command (new-branch / -b / checkout / detached)`.

## Slice 9 — `worktreeMove` + `worktreeRemove`

- **Red** `commands/worktree.test.ts`:
  - move: relocates the dir, rewrites admin `gitdir` (new `<dest>/.git`) + the
    moved `<dest>/.git` gitfile (`gitdir:` unchanged); refusals: locked (no
    force) ⇒ `WORKTREE_LOCKED`; non-empty destination ⇒ `WORKTREE_PATH_EXISTS`;
    main worktree ⇒ `INVALID_OPTION`; non-worktree path ⇒ `NOT_A_WORKTREE`.
  - remove: deletes worktree dir + admin dir, branch intact; refusals: locked
    ⇒ `WORKTREE_LOCKED`; main ⇒ `INVALID_OPTION`; dirty (modified/untracked, via
    `status(child)`) ⇒ `WORKTREE_DIRTY` unless force; non-worktree ⇒ `NOT_A_WORKTREE`.
- **Green** `worktreeMove` / `worktreeRemove`; both resolve the admin entry via
  `listWorktrees`, share the lock + main + path guards.
- Commit: `feat(worktree): move + remove commands`.

## Slice 10 — namespace + facade + surface gates

- **Red** `repository.test.ts`: `repo.worktree.{list,add,move,remove}` present
  in the facade key-set; browser scenario (memory adapter) for `list`.
- **Green**
  - `internal/worktree-namespace.ts`: `bindWorktreeNamespace` (guard + forward).
  - `commands/index.ts`: export verbs, options/results, `WorktreeNamespace`,
    `bindWorktreeNamespace`, `WorktreeEntry`.
  - `repository.ts`: `worktree: commands.WorktreeNamespace` interface field +
    `commands.bindWorktreeNamespace(ctx, guard)` binding.
  - README command count; regenerate `reports/api.json`; browser scenario;
    doc-coverage page.
- Commit: `feat(worktree): expose repo.worktree namespace`.

## Slice 11 — interop (node adapter, real git twin)

- **Red/Green** `test/integration/worktree-interop.test.ts` (scrubbed `GIT_*`,
  signing off): twin git/tsgit repos; for each, assert byte parity of
  - `add` (all four modes): admin `HEAD`/`commondir`/`gitdir`/`ORIG_HEAD`, the
    `.git` gitfile, branch ref + `logs/refs/heads/<b>` reflog, `logs/HEAD`
    (per-mode bytes), index + working-tree files. Reflog lines compare on
    old/new oid + identity + message; the unix-time/tz fields are normalised, as
    in the existing reflog interop suites.
  - `list` (reconstruct `git worktree list --porcelain` from the structured
    entries — path/HEAD/branch/detached/locked/prunable).
  - `move`: admin `gitdir` + moved gitfile.
  - `remove`: dir + admin gone, branch intact; the dirty + locked refusals.
  - cross-adapter parity for the structured `list`.
- Commit: `test(worktree): real-git interop for add/list/move/remove`.

## Notes

- `add`'s ref/branch/reflog/admin writes run on the **parent** Context
  (`commonDir === gitDir`); only materialise + `logs/HEAD` use the **child**
  Context. So the only commonDir-threading `add` needs is objects (slice 2);
  `remove`'s `status(child)` exercises the ref/config/gitignore threads (3–4).
- `worktreeAdminId` integer dedup starts at `1`, no separator (git `worktree.c`).
- Bare-main `add` is permitted (HEAD resolves to a branch tip); pinned by one
  smoke case, not the full matrix.
- Sparse-checkout on `add`, `lock`/`unlock`/`prune` verbs, and
  `openRepository` linked-worktree discovery are documented non-goals
  (ADRs 296–297).
