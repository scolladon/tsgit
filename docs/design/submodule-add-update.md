# Submodule network write side — `add` / `update` (+ `sync --recursive`)

## Goal & scope

Extend the `repo.submodule.*` namespace (24.1a registered `init`/`sync`/`deinit`,
17.5 `list`) with the two **network** write verbs and the recursive sync flag:

- **`add`** — clone a brand-new submodule into the superproject worktree at
  `<path>` and the absorbed gitdir `.git/modules/<name>`, write `.gitmodules`,
  stage the gitlink + `.gitmodules` into the **superproject** index, and register
  `submodule.<name>.{url,active}` in `.git/config`.
- **`update`** — for each registered submodule: read the pinned commit recorded
  by the superproject gitlink, clone the module gitdir **if missing**, then check
  out that commit **detached**.
- **`sync --recursive`** — 24.1a's `sync` gains a `recursive` flag that descends
  into each checked-out submodule and re-points its nested submodules too.

Reuses 24.1a wholesale: `relativeUrl` / `parseGitmodules` / `deriveSubmoduleContext`
/ the `repo.submodule` namespace / `ParsedConfig.submodule`. The only genuinely
new substrate is **clone → materialise a working tree into a nested gitdir** — the
prerequisite the backlog flags (tsgit's `clone` fetches a pack + refs but never
materialises a worktree, clone.ts:61).

**Precondition (git-faithful):** `update`/`sync` operate on a superproject whose
own worktree is **already checked out** — `.gitmodules` on disk, the index
gitlink present — exactly as git requires. This PR's substrate materialises the
**submodule** worktrees, not the **superproject** worktree (top-level
clone-with-worktree stays the 24.x gap). So the interop twins build the
superproject's *starting state* with **real git** (a tsgit-cloned super has no
worktree/index yet); the tool under test then runs only the submodule verb.

All four `update` modes are implemented faithfully (ADR-290) and `add --branch`
(ADR-292). **Out of scope (documented non-goals):** incremental fetch when the
pinned commit is absent after the initial clone (tsgit is smart-HTTP-v1, no
`multi_ack` — gated on 25.3, refused per ADR-291); `add --reference`/`--depth`
shallow submodules; `.mailmap`; superproject auto-commit (git doesn't auto-commit
either — both verbs leave the index staged for the caller to commit).

## Surface — two new verbs, one extended flag

```ts
// repo.submodule.add(opts)
export interface SubmoduleAddOptions {
  readonly url: string;            // raw url, stored verbatim in .gitmodules
  readonly path: string;           // worktree-relative checkout path
  readonly name?: string;          // default: path (git's --name default)
  readonly branch?: string;        // -b: track this branch (else remote HEAD); ADR-292
}
export interface SubmoduleAddResult {
  readonly name: string;
  readonly path: FilePath;
  readonly url: string;            // RESOLVED url written to .git/config + module remote.origin
  readonly id: ObjectId;           // submodule HEAD oid staged as the gitlink
  readonly branch: string;         // checked-out branch (remote HEAD branch, or `branch` opt)
}

// repo.submodule.update(opts)
export interface SubmoduleUpdateOptions {
  readonly paths?: ReadonlyArray<string>;   // default: every registered submodule
  readonly init?: boolean;                  // --init: register before updating
  readonly mode?: SubmoduleUpdateMode;      // --checkout/--rebase/--merge override of configured mode
}
export interface SubmoduleUpdateEntry {
  readonly name: string;
  readonly path: FilePath;
  readonly id: ObjectId;           // pinned gitlink oid the submodule was reconciled to
  readonly mode: SubmoduleUpdateMode;  // mode actually applied
  readonly cloned: boolean;        // true ⇒ this call cloned the module gitdir
  readonly changed: boolean;       // true ⇒ submodule HEAD/branch moved (false ⇒ already in sync / none)
}
export interface SubmoduleUpdateResult { readonly entries: ReadonlyArray<SubmoduleUpdateEntry>; }

// repo.submodule.sync(opts) — 24.1a SubmoduleSyncOptions gains:
export interface SubmoduleSyncOptions {
  readonly paths?: ReadonlyArray<string>;
  readonly recursive?: boolean;    // NEW — descend into checked-out submodules
}
```

**Structured data only (ADR-249):** results carry oids/booleans/names — git's
stdout (`Cloning into …`, `Submodule path '<p>': checked out '<oid>'`, the
`registered for path` line) is the caller's to render from these fields. No verb
returns a pre-rendered string.

## Faithful on-disk behaviour (verified against git 2.54.0)

All facts below are pinned from real `git submodule add`/`update --init` runs
(see the interop suite). Name=path unless `--name` overrides.

### `add` writes, in order

1. **Clone** the remote into the **absorbed gitdir** `.git/modules/<name>` — a
   full clone identical to `git clone`: `HEAD → refs/heads/<remoteHead>`,
   `refs/remotes/origin/*`, `[remote "origin"] url+fetch`, `[branch "<head>"]
   remote/merge`, one `clone: from <url>` reflog line. The module stays **on the
   branch** (not detached).
2. **`core.worktree`** in the module config: `(../ × (2 + nameSegs)) + <path>`
   (e.g. name `libs/sub`, path `libs/sub` → `../../../../libs/sub`).
3. **`.git` gitfile** at `<path>/.git`: `gitdir: (../ × pathSegs).git/modules/<name>`
   (e.g. path `libs/sub` → `gitdir: ../../.git/modules/libs/sub`).
4. **Materialise the worktree** at the remote-HEAD branch's tree (git's clone
   checkout — only the `clone: from` reflog entry, **no** separate `checkout`
   entry).
5. **`.gitmodules`** in the superproject worktree: `[submodule "<name>"]` with
   `path = <path>` then `url = <raw url>` (the **un-resolved** url as typed —
   tab-indented, `\n`-terminated, keys in path→url order).
6. **Stage** into the superproject index: the gitlink (`160000 <subHEAD> 0 <path>`)
   **and** the `.gitmodules` blob (`100644`). Neither is committed.
7. **`.git/config`** of the superproject: `[submodule "<name>"]` `url = <resolved>`
   then `active = true` (order **url, active** — `add`'s order, distinct from
   `init`'s active,url; no `update` key).

**`add --branch <b>` (ADR-292):** after the clone (HEAD on remote-default `main`),
create the local tracking branch `refs/heads/<b>` at `origin/<b>` with
`branch.<b>.{remote,merge}`, `checkout(child, { rev: <b> })` (reflog
`checkout: moving from main to <b>`, materialise `<b>`'s tree), append
`branch = <b>` to `.gitmodules` (after `path`, `url`), and stage `<b>`'s commit as
the gitlink. The module gitdir keeps **both** local branches (`main` from the
clone, `<b>` from the checkout) — git-faithful. The superproject `.git/config`
gets no `branch` key (the branch lives only in `.gitmodules`).

### `add` refusals

- `path` already in the index (tracked file **or** existing submodule) →
  `INVALID_OPTION`-class refusal mirroring git's
  `fatal: '<path>' already exists in the index`, written **before** any clone.
- `name`/`path` failing `isUnsafeSubmoduleName` (24.1a hardening: `..`, empty
  segment, absolute, drive-prefix, backslash, control char) → refuse, no write.
- empty `url`/`path` → refuse.

### `update` writes, per selected+registered submodule

1. Resolve the **pinned oid** = the superproject's gitlink for `<path>` (the
   index entry's `160000` oid; falls back to the `HEAD` tree gitlink when absent
   from the index — git reads the index).
2. With `init: true` (`--init`): register `submodule.<name>.{active,url}` first
   (delegates to 24.1a `submoduleInit` for that path) — order **active, url**.
3. **Clone if missing**: if `.git/modules/<name>/HEAD` is absent, clone the module
   gitdir (as in `add` steps 1–4 — gitfile + core.worktree + worktree
   materialise). `cloned: true`.
4. **Reconcile to the pinned oid by mode** (ADR-290) — `mode` = `opts.mode` (the
   `--checkout/--rebase/--merge` override) ?? `submodule.<name>.update` ?? `checkout`:
   - `checkout` → `checkout(child, { rev: pinned, detach: true })`; **detached**
     HEAD, reflog `checkout: moving from <from> to <oid>`. Skipped (`changed:false`)
     when module HEAD already equals pinned (git's idempotent no-op).
   - `rebase` → `rebaseRun(child, { upstream: pinned })`; stays on the branch,
     reflog `rebase (start)/(finish)`.
   - `merge` → `mergeRun(child, { rev: pinned })`; merges into the current branch.
   - `none` → skip (`changed:false`).

### `update` refusals

- a `paths` entry that is **not** a submodule (no gitlink) → `PATHSPEC_NO_MATCH`
  (git: `pathspec '<p>' did not match`).
- a selected submodule **not registered** and `init !== true` → skipped with a
  refusal mirroring git's "not initialized" (the caller must pass `init`).
- the pinned oid **absent** from the freshly-cloned module objects (remote
  advanced past the initial clone) → `OBJECT_NOT_FOUND` (ADR-291, the 25.3
  incremental-fetch gap); the interop fixtures pin a commit always present.
- `rebase`/`merge` propagate the underlying `rebaseRun`/`mergeRun` refusals +
  conflict states (`rebase-merge/`, `MERGE_HEAD`) unchanged — the submodule is left
  mid-operation, resolved through its own `repo.rebase`/`repo.merge` (ADR-290).

### `sync --recursive`

24.1a `sync` re-points `submodule.<name>.url` (+ module `remote.origin.url`) from
`.gitmodules`. `recursive` additionally derives each **checked-out** submodule's
child Context (`deriveSubmoduleContext`) and runs `sync({recursive:true})` there,
bounded by `MAX_SUBMODULE_DEPTH` (the read-walk cap) and the `visited` cycle
guard. An uninitialised/uncheckout submodule is silently skipped (no child HEAD).

## Substrate — clone into a nested gitdir + materialise a worktree

The one new capability. Decomposed to **maximise reuse** and keep the existing
top-level `clone` untouched (its faithfulness goldens stay green):

```
add/update
  └─ deriveSubmoduleCloneContext(ctx, name, path)   → child Context @ .git/modules/<name>, workdir <path>
  └─ clone(childCtx, { url: resolved })             → existing command, into the child gitdir
  └─ materializeWorktreeFromHead(childCtx)           → NEW primitive: HEAD tree → worktree + index
  └─ writeGitlinkFile(ctx, name, path)               → NEW: .git gitfile + core.worktree (pure path algebra)
```

- **`deriveSubmoduleCloneContext`** — sibling of 24.1a's `deriveSubmoduleContext`,
  factored over a shared private builder. The difference: the clone-target variant
  does **not** require `HEAD` to pre-exist (the gitdir is about to be created),
  so it skips the existence guard. Both freeze the child layout (gitDir
  `${gitDir}/modules/<name>`, workDir `${workDir}/<path>`, `bare:false`), drop
  `promisor`/`hooks` (they close over the parent gitdir), and inherit the
  SSRF-wrapped `transport` + `config` so the child clone is guarded identically.
- **`materializeWorktreeFromHead`** (Tier-2 primitive) — resolve `HEAD` → commit →
  tree, `materializeTree(targetTree, emptyIndex)`, commit the module's index under
  its own lock. Updates **no** ref and writes **no** reflog (git's clone checkout
  is silent beyond the clone entry). Composes `resolveRef`/`readCommit`/`readTree`
  /`materializeTree`/`acquireIndexLock` — no new domain logic. Reusable by a future
  top-level `clone` worktree (24.x), but introduced only because `add`/`update`
  are its first two consumers (rule-of-two satisfied).
- **`update`'s detached checkout** reuses the existing `checkout` command:
  `checkout(childCtx, { rev: pinnedOid, detach: true })` — already byte-faithful
  for the reflog `checkout: moving from <from> to <oid>` + worktree materialise +
  detached HEAD. For `update`, the clone step is **clone-only** (no
  `materializeWorktreeFromHead`); the detach-checkout materialises. For `add`, no
  detach — `materializeWorktreeFromHead` leaves HEAD on the branch.

## Gitlink path algebra (new pure domain)

`src/domain/submodule/gitlink-path.ts` — two total string functions over an
already-safe (`isUnsafeSubmoduleName`-passed) `name`/`path`:

```ts
// .git file content in the submodule worktree (path-segment depth)
export const submoduleGitfile = (name: string, path: string): string =>
  `gitdir: ${'../'.repeat(segmentCount(path))}.git/modules/${name}`;

// core.worktree in the module config (.git/modules/<name> is 2 + nameSegs deep)
export const submoduleCoreWorktree = (name: string, path: string): string =>
  `${'../'.repeat(2 + segmentCount(name))}${path}`;
```

`segmentCount` splits on `/` over the trailing (no-leading-slash, safe) form.
Pure, deterministic, no I/O — property-test target (lens 1: the gitfile's `../`
count round-trips the path depth; lens 3: total over any safe name/path).

## Module structure

```
src/
├── domain/submodule/
│   ├── gitlink-path.ts                    (NEW — submoduleGitfile + submoduleCoreWorktree, pure)
│   └── index.ts                           (MODIFIED — re-export)
├── application/
│   ├── primitives/
│   │   ├── materialize-worktree-from-head.ts   (NEW — Tier-2: HEAD tree → worktree + index)
│   │   └── internal/
│   │       └── submodule-context.ts       (MODIFIED — add deriveSubmoduleCloneContext, shared builder)
│   └── commands/
│       ├── submodule.ts                   (MODIFIED — submoduleAdd, submoduleUpdate, sync gains recursive)
│       └── internal/
│           └── submodule-namespace.ts     (MODIFIED — bind add, update)
└── repository.ts                          (MODIFIED — SubmoduleNamespace doc + types)
```

## Algorithms

### `submoduleAdd(ctx, opts)`

```
assertRepository; assertNotBare
name := opts.name ?? opts.path
reject if isUnsafeSubmoduleName(name) || isUnsafeSubmoduleName(path) || url==='' || path===''
index := readIndex(ctx)
reject INDEX-ALREADY if index has any entry at `path` (or under it / gitlink)   // git's "already exists in the index"
config := readConfig(ctx); base := resolveBaseUrl(ctx, config)                  // 24.1a helper
resolved := resolveSubmoduleUrl(base, url)
child := deriveSubmoduleCloneContext(ctx, name, path)
mkdir -p ${workDir}/${path}
clone(child, { url: resolved })                                                 // module gitdir, on remote-HEAD branch
writeConfig(child, core.worktree = submoduleCoreWorktree(name, path))
write `${workDir}/${path}/.git` = submoduleGitfile(name, path)
if opts.branch:                                                                 // ADR-292
   createTrackingBranch(child, opts.branch)                                     // refs/heads/<b>@origin/<b> + branch.<b>.{remote,merge}
   checkout(child, { rev: opts.branch })                                        // HEAD→<b>, materialise
   branch := opts.branch
else:
   materializeWorktreeFromHead(child); branch := remoteHeadBranch              // stay on remote HEAD branch
subHead := resolveRef(child, 'HEAD')
writeGitmodules(ctx, name, path, rawUrl=url, branch?)                           // [submodule name] path,url(raw),branch?
stage(ctx index): gitlink 160000 subHead @path  +  .gitmodules blob 100644      // single index lock
updateConfig(ctx): submodule.<name>.url=resolved, then active=true              // order url,active
return { name, path, url: resolved, id: subHead, branch }
```

### `submoduleUpdate(ctx, opts)`

```
assertRepository; assertNotBare
rows := readWorktreeGitmodules(ctx)                                             // 24.1a helper
selected := selectRows(rows, opts.paths)                                        // PATHSPEC_NO_MATCH on miss
config := readConfig(ctx)
index := readIndex(ctx); headTree := HEAD tree (for index-miss fallback)
for row in selected (incremental, git order):
  pinned := gitlinkOid(index, headTree, row.path)                              // OBJECT_NOT_FOUND-class if none
  registered := config.submodule?.get(row.name)?.url !== undefined
  if !registered:
     if opts.init: submoduleInit(ctx, { paths:[row.path] }); refresh config
     else: skip (not initialised)
  mode := opts.mode ?? updateModes.get(row.name) ?? 'checkout'
  if mode==='none': push {…, mode, changed:false}; continue
  child := deriveSubmoduleCloneContext(ctx, row.name, row.path)
  cloned := !exists(child gitDir/HEAD)
  if cloned: clone(child, { url: config.submodule.<name>.url }); gitfile+core.worktree+materialize
  reject OBJECT_NOT_FOUND if !objectExists(child, pinned)                       // remote-advanced gap (ADR-291)
  changed := reconcile(child, pinned, mode)                                     // checkout-detach | rebaseRun | mergeRun
  push { name, path, id: pinned, mode, cloned, changed }
```

### `submoduleSync(ctx, { recursive })` — extend 24.1a

After the existing per-row re-point loop, when `recursive`:
`for row in selected: child := deriveSubmoduleContext(ctx, row.name, row.path);
 if child: submoduleSync(child, { recursive:true })` — depth-bounded, cycle-guarded.

## Security

- **Path containment** — `name`/`path` pass `isUnsafeSubmoduleName` before any
  join (24.1a rule: no `..`/empty-segment/absolute/drive/backslash/control). The
  gitfile, `core.worktree`, the module gitdir, and the worktree checkout all join
  only validated segments → cannot escape the superproject. Tested with a
  `../`-laden name (refused) + a path collision (refused).
- **SSRF** — the child clone inherits the parent's `wrapTransportValidator`
  transport (DNS/insecure/private-network policy from `openRepository`); a blocked
  submodule url is refused on the first transport request, exactly as top-level
  `clone`.
- **Resource exhaustion** — `.gitmodules` read is capped at `MAX_GITMODULES_BYTES`
  (24.1a); the recursion is bounded by `MAX_SUBMODULE_DEPTH` + `visited`.
- **No credential leakage** — the resolved url written to config/remote is the
  same url git writes; no auth material is embedded in `.gitmodules` (raw url).

## Surface gates (new Tier-1 verbs)

Per the "adding a Tier-1 command" checklist: `SubmoduleNamespace` gains
`add`/`update`; `repository.test` namespace key-set; the `submodule` doc-coverage
page; the browser scenario list (network verbs are node-only — documented inert in
browser, mirroring `clone`); README command count + `reports/api.json`
regeneration (the prepush `check:doc-typedoc` gate).

## Testing strategy

### Domain (unit + properties)
- `gitlink-path` — example tests pinning the two real-git strings (name=path 1-seg,
  name=path 2-seg, name≠path); `gitlink-path.properties.test.ts` (lens 1 round-trip
  `../`-count↔depth, lens 3 totality over safe names) with a shared `arbitraries.ts`.

### Primitive (unit, memory adapter)
- `materializeWorktreeFromHead` — empty index → full tree materialised + index
  written; HEAD unchanged, no reflog entry; isolated guard tests.
- `deriveSubmoduleCloneContext` — layout shape, no HEAD-existence guard, transport
  inherited, promisor/hooks dropped.

### Command (unit, memory adapter, no network)
- `add`/`update` orchestration with an in-memory remote stub for the clone step
  (mirroring existing clone unit tests): refusals (index collision, unsafe name,
  rebase/merge mode, uninitialised-without-init, missing pinned oid), config key
  order, gitfile/core.worktree contents, gitlink staging, detached-vs-branch HEAD,
  idempotent re-update no-op, `sync --recursive` descent + depth bound.

### Integration / interop (node adapter, real git, http-backend)
- `submodule-add-update-interop.test.ts` — twin git/tsgit superprojects over a
  local `git-http-backend` serving a committed submodule fixture. Reconstructs and
  byte-compares: `.gitmodules`, superproject `.git/config` submodule section,
  `git ls-files -s` (gitlink + `.gitmodules`), the module `core.worktree`/gitfile,
  the module `HEAD`/`refs`, and the checked-out worktree files — against a real
  `git submodule add` / `git submodule update --init` on the same fixture.
  Cross-adapter parity where applicable (memory adapter has no network → the
  network verbs are node-interop-only, like `clone`).
- A nested-submodule fixture drives `sync --recursive` parity.

## Decisions (resolved — ADRs 289–292)

1. **Substrate shape** — reuse `clone` + new `materializeWorktreeFromHead`
   primitive; top-level `clone` untouched. **ADR-289.**
2. **`update` modes** — implement all four faithfully; `rebase`/`merge` delegate to
   `rebaseRun`/`mergeRun` on the child; `none` skips. **ADR-290.**
3. **Remote-advanced pinned oid** — refuse `OBJECT_NOT_FOUND` (honest about the
   25.3 incremental-fetch gap). **ADR-291.**
4. **`add --branch`** — implemented: track a named branch (`.gitmodules branch=`,
   dual-branch module config, branch-only-in-`.gitmodules`). **ADR-292.**
```
