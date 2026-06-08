# `submodule`

The `repo.submodule.*` namespace: inspect (`list`) and register/sync/unregister
submodules in local state. `list` reads a tree-ish (so it works in bare repos and
is deterministic for a ref); the write verbs (`init` / `sync` / `deinit`) read the
working-tree `.gitmodules` and mutate `.git/config` (and, for `deinit`, the
submodule working tree). The network half (`add` / `update`) is roadmap 24.1b.

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

## Write verbs

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
repo.submodule.sync(opts?: { paths?: ReadonlyArray<string> }): Promise<SubmoduleSyncResult>;

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
out, its own `remote.origin.url` is updated to the same resolved url.

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
- ADRs: [083](../../adr/083-submodule-api-surface.md), [084](../../adr/084-submodule-data-source.md), [085](../../adr/085-nested-submodule-recursion.md), [086](../../adr/086-gitmodules-ini-reuse.md), [286](../../adr/286-submodule-write-side-local-scope.md), [287](../../adr/287-unified-submodule-namespace.md), [288](../../adr/288-relative-url-verbatim-port.md)
- Roadmap: 24.1b — submodule network write side (`add` / `update`)
