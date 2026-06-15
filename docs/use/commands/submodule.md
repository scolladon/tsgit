# `submodule`

The `repo.submodule.*` namespace: inspect (`list`), clone/checkout (`add` /
`update`), and register/sync/unregister submodules. `list` reads a tree-ish (so it
works in bare repos and is deterministic for a ref); the local write verbs
(`init` / `sync` / `deinit`) read the working-tree `.gitmodules` and mutate
`.git/config` (and, for `deinit`, the submodule working tree); the network verbs
(`add` / `update`) clone a submodule into `.git/modules/<name>` and materialise
its working tree over smart-HTTP.

## `list`

```ts
repo.submodule.list(opts?: SubmoduleListOptions): Promise<SubmoduleListResult>;

interface SubmoduleListOptions {
  readonly ref?: string;          // tree-ish; default 'HEAD'
  readonly recursive?: boolean;   // descend into nested submodules
  readonly maxDepth?: number;     // recursion cap; default MAX_SUBMODULE_DEPTH
}

interface SubmoduleListResult {
  readonly entries: ReadonlyArray<SubmoduleEntry>;
}

interface SubmoduleEntry {
  readonly name: string;
  readonly path: FilePath;
  readonly url?: string;
  readonly branch?: string;
  readonly commit: ObjectId;
  readonly depth: number;
  readonly parent?: FilePath;
}
```

- **Source of truth = the tree.** Every gitlink (mode `160000`) at any depth becomes one entry; joined with `submodule.<name>.{path,url,branch}` from the tree's `.gitmodules` blob.
- **Network is never touched.** `url` is opaque data carried through from `.gitmodules`.
- **Nested recursion** descends only when the absorbed gitdir (`<gitDir>/modules/<name>`) is locally available. Uninitialised, missing-commit, cycle-detected, and depth-capped submodules yield their own entry but no children — git-faithful with `git submodule status --recursive`.
- **Name validation** rejects CVE-2018-17456-style attacks (empty / `.` / `..` segments, backslash, absolute, drive-prefixed, leading `-`, control characters).
- **CVE-2018-11235 hardening:** `.gitmodules` is only read when the tree entry mode is `100644` / `100755` (symlink / directory / gitlink modes are ignored).

For streaming use [`walkSubmodules`](../primitives/walk-submodules.md) directly.

```ts
// List submodules pinned at HEAD
const { entries } = await repo.submodule.list();
for (const e of entries) console.log(e.path, e.commit, e.url ?? '(no .gitmodules row)');

// At a specific commit, recursively, with a depth cap
await repo.submodule.list({ ref: 'main', recursive: true, maxDepth: 2 });
```

## Network verbs (`add` / `update`)

`add` and `update` clone a submodule over smart-HTTP into the absorbed gitdir
`.git/modules/<name>`, write the `.git` gitfile + `core.worktree`, and materialise
its working tree. **Structured data only** — git's stdout (`Cloning into …`,
`Submodule path '<p>': checked out '<oid>'`) is the caller's to render. tsgit's
clone is smart-HTTP-only, so the submodule url must be an HTTP(S) endpoint.

### `add`

```ts
repo.submodule.add(opts: SubmoduleAddOptions): Promise<SubmoduleAddResult>;

interface SubmoduleAddOptions {
  readonly url: string;      // stored raw in .gitmodules; resolved for .git/config
  readonly path: string;     // worktree-relative checkout path
  readonly name?: string;    // .gitmodules subsection name; default = path
  readonly branch?: string;  // -b: track this branch instead of remote HEAD
}

interface SubmoduleAddResult {
  readonly name: string;
  readonly path: FilePath;
  readonly url: string;      // resolved url written to config + module remote.origin
  readonly id: ObjectId;     // submodule HEAD oid staged as the gitlink
  readonly branch: string;   // checked-out branch
}
```

Clones the remote into `.git/modules/<name>`, writes `.gitmodules`
(`path`, raw `url`, optional `branch`), stages the gitlink (`160000`) **and** the
`.gitmodules` blob into the superproject index, and records
`submodule.<name>.{url,active}` in `.git/config`. With `branch`, creates a local
tracking branch at `origin/<branch>` and checks it out (git's `add -b`). Refuses
an unsafe/empty `name`/`path`/`url` (CVE-2018-17456 lineage) or an already-tracked
path (`SUBMODULE_PATH_EXISTS`). Neither the index nor `.gitmodules` is committed —
that is left to the caller, exactly as git.

```ts
await repo.submodule.add({ url: 'https://host/lib.git', path: 'libs/lib' });
await repo.submodule.add({ url: 'https://host/lib.git', path: 'libs/lib', branch: 'dev' });
```

### `update`

```ts
repo.submodule.update(opts?: SubmoduleUpdateOptions): Promise<SubmoduleUpdateResult>;

interface SubmoduleUpdateOptions {
  readonly paths?: ReadonlyArray<string>;          // default: every registered submodule
  readonly init?: boolean;                         // --init: register before updating
  readonly mode?: 'checkout' | 'rebase' | 'merge' | 'none'; // override the configured mode
}

interface SubmoduleUpdateEntry {
  readonly name: string;
  readonly path: FilePath;
  readonly id: ObjectId;     // pinned gitlink oid reconciled to
  readonly mode: 'checkout' | 'rebase' | 'merge' | 'none';
  readonly cloned: boolean;  // true ⇒ this call cloned the module gitdir
  readonly changed: boolean; // true ⇒ submodule HEAD/branch moved
}
```

Reads the pinned commit from the superproject index gitlink, clones the module
gitdir **if missing**, then reconciles to the pin per the resolved update mode:
`checkout` (default) detaches at the pin; `rebase`/`merge` reconcile the
submodule's current branch (delegating to `repo.rebase`/`repo.merge`); `none`
skips. The mode is resolved by precedence: the CLI **`mode`** option > `.git/config`
**`submodule.<name>.update`** > `.gitmodules` **`submodule.<name>.update`** > the
**`checkout`** default. The repo-local config value overrides the `.gitmodules`
value in both directions — it can both enable an update (config `checkout` over
`.gitmodules none`) and suppress one (config `none` over `.gitmodules checkout`).
An unregistered submodule is skipped unless `init`. When the pinned commit is
absent after cloning (the remote advanced past the initial clone), `update`
refuses `OBJECT_NOT_FOUND` — tsgit's smart-HTTP v1 has no incremental fetch
(roadmap 25.3). `rebase`/`merge` need a `[user]` identity in the module config
(tsgit reads local config only).

A valueless `submodule.<name>.update` (or `submodule.<name>.url`) in `.git/config`
refuses `CONFIG_MISSING_VALUE`; an unrecognised `submodule.<name>.update` value
refuses `INVALID_OPTION`. Both fire only when no CLI `mode` shadows the config —
a CLI `mode` wins without reading (or validating) the config value.

```ts
await repo.submodule.update({ init: true });              // clone + checkout every pin
await repo.submodule.update({ paths: ['libs/lib'], mode: 'rebase' });
```

## Local write verbs

`init` / `sync` / `deinit` read the **working-tree** `.gitmodules` (not a tree-ish)
and mutate **local state only** — `.git/config`, an already-checked-out
submodule's own config, and (for `deinit`) the submodule working tree. They never
touch the network. Each returns **structured data only** (the human strings git
prints — "registered for path …", "Synchronizing …", "Cleared directory …",
"… unregistered …" — are caller projections). `paths` selects submodules by
exact path against `.gitmodules`; an unmatched entry refuses with
`PATHSPEC_NO_MATCH`. Submodule sections whose **name or path** is unsafe
(`..`/empty segment, absolute, drive-prefixed, backslash, control chars, leading
`-`) are dropped (CVE-2018-17456 lineage); a `.gitmodules` over 1 MiB refuses.

### `init`

```ts
repo.submodule.init(opts?: { paths?: ReadonlyArray<string> }): Promise<SubmoduleInitResult>;

interface SubmoduleInitEntry {
  readonly name: string;
  readonly path: FilePath;
  readonly url: string;          // resolved url now in config (or the preserved existing one)
  readonly registered: boolean;  // true ⇒ newly registered this call
  readonly update?: 'checkout' | 'rebase' | 'merge' | 'none';
}
```

Registers each un-registered submodule into `.git/config` — `active = true`, the
resolved `url`, and (when declared) a validated `update` mode, in git's key order.
An already-registered submodule keeps its url (`registered: false`). Relative
`.gitmodules` urls (`./…`, `../…`) resolve against the superproject's
default-remote url (`branch.<HEAD>.remote` → `origin` → the worktree path); other
url forms are used verbatim. An invalid `update` (`!command` or unknown token)
refuses with `INVALID_OPTION`, writing nothing.

```ts
await repo.submodule.init();              // register every submodule
await repo.submodule.init({ paths: ['libs/a'] });
```

### `sync`

```ts
repo.submodule.sync(opts?: {
  paths?: ReadonlyArray<string>;
  recursive?: boolean;
}): Promise<SubmoduleSyncResult>;

interface SubmoduleSyncEntry {
  readonly name: string;
  readonly path: FilePath;
  readonly url: string;          // resolved url written to config
  readonly syncedRemote: boolean; // true ⇒ the checked-out submodule's remote.origin.url was updated
}
```

Re-points `submodule.<name>.url` from the current `.gitmodules` — overwriting the
existing value (unlike `init`). Operates only on **initialised** submodules (a
fresh clone with nothing initialised is a no-op). When the submodule is checked
out, its own `remote.origin.url` is updated to the same resolved url. With
`recursive`, descends into each checked-out submodule and syncs its nested ones
(depth-capped + cycle-guarded). The result lists the top level; nested syncs are
on-disk side effects.

### `deinit`

```ts
repo.submodule.deinit(opts: {
  paths?: ReadonlyArray<string>;
  all?: boolean;
  force?: boolean;
}): Promise<SubmoduleDeinitResult>;

interface SubmoduleDeinitEntry {
  readonly name: string;
  readonly path: FilePath;
  readonly url: string;     // raw .gitmodules url (git's unregister message form)
  readonly cleared: boolean; // true ⇒ a populated working tree was cleared
}
```

Unregisters submodules and clears their working-tree contents. Requires `paths`
or `all: true` (a bare `deinit` refuses). Removes each `[submodule "<name>"]`
config section and clears its working-tree directory (the empty directory,
`.gitmodules`, the index gitlink, and `.git/modules/<name>` are left intact). A
submodule with local modifications (modified tracked content **or** untracked
files) refuses with `SUBMODULE_HAS_MODIFICATIONS` unless `force: true`. Each
submodule is fully deinit-ed before the next, so a later dirty one leaves earlier
ones completely deinit-ed (git's incremental behaviour).

```ts
await repo.submodule.deinit({ paths: ['libs/a'] });
await repo.submodule.deinit({ all: true, force: true });
```

## See also

- Primitives: [`walkSubmodules`](../primitives/walk-submodules.md), [`readObject`](../primitives/read-object.md), [`readConfig`](../primitives/internals.md#readconfig) (INI tokenizer reuse)
- Related commands: [`log`](log.md), [`status`](status.md), [`remote`](remote.md)
- ADRs: [083](../../adr/083-submodule-api-surface.md), [084](../../adr/084-submodule-data-source.md), [085](../../adr/085-nested-submodule-recursion.md), [086](../../adr/086-gitmodules-ini-reuse.md), [286](../../adr/286-submodule-write-side-local-scope.md), [287](../../adr/287-unified-submodule-namespace.md), [288](../../adr/288-relative-url-verbatim-port.md), [289](../../adr/289-submodule-clone-worktree-substrate.md), [290](../../adr/290-submodule-update-all-four-modes.md), [291](../../adr/291-submodule-update-pinned-oid-absent-refuses.md), [292](../../adr/292-submodule-add-branch-option.md)
