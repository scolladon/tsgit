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

## See also

- Primitives: [`walkSubmodules`](../primitives/walk-submodules.md), [`readObject`](../primitives/read-object.md), [`readConfig`](../primitives/internals.md#readconfig) (INI tokenizer reuse)
- Related commands: [`log`](log.md), [`status`](status.md)
- ADRs: [083](../../adr/083-submodule-api-surface.md), [084](../../adr/084-submodule-data-source.md), [085](../../adr/085-nested-submodule-recursion.md), [086](../../adr/086-gitmodules-ini-reuse.md), [287](../../adr/287-unified-submodule-namespace.md)
- Roadmap: 24.1b — submodule network write side (`add` / `update`)
