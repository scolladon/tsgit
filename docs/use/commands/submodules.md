# `submodules`

Walk submodules pinned at a tree-ish. Reads from a tree-ish so it works in bare repositories and is deterministic for a given ref. For streaming use [`walkSubmodules`](../primitives/walk-submodules.md) directly.

## Signature

```ts
repo.submodules(opts?: SubmodulesAction): Promise<SubmodulesResult>;

interface SubmodulesAction {
  readonly action?: 'list';
  readonly ref?: string;          // tree-ish; default 'HEAD'
  readonly recursive?: boolean;   // descend into nested submodules
  readonly maxDepth?: number;     // recursion cap; default MAX_SUBMODULE_DEPTH
}

interface SubmodulesResult {
  readonly kind: 'list';
  readonly entries: ReadonlyArray<SubmoduleEntry>;
}

interface SubmoduleEntry {
  readonly name: string;
  readonly path: FilePath;
  readonly url?: string;
  readonly branch?: string;
  readonly commit: ObjectId;
  readonly depth: number;
  readonly parent?: SubmoduleEntry;
}
```

## Behaviour

- **Source of truth = the tree.** Every gitlink (mode `160000`) at any depth becomes one entry; joined with `submodule.<name>.{path,url,branch}` from the tree's `.gitmodules` blob.
- **Network is never touched.** `url` is opaque data carried through from `.gitmodules`.
- **Nested recursion** descends only when the absorbed gitdir (`<gitDir>/modules/<name>`) is locally available. Uninitialised, missing-commit, cycle-detected, and depth-capped submodules yield their own entry but no children — git-faithful with `git submodule status --recursive`.
- **Name validation** rejects CVE-2018-17456-style attacks (empty / `.` / `..` segments, backslash, absolute, drive-prefixed, leading `-`, control characters).
- **CVE-2018-11235 hardening:** `.gitmodules` is only read when the tree entry mode is `100644` / `100755` (symlink / directory / gitlink modes are ignored).

## Examples

```ts
// List submodules pinned at HEAD
const { entries } = await repo.submodules();
for (const e of entries) console.log(e.path, e.commit, e.url ?? '(no .gitmodules row)');

// At a specific commit, recursively
const nested = await repo.submodules({ ref: 'main', recursive: true });

// Cap recursion depth
await repo.submodules({ ref: 'HEAD', recursive: true, maxDepth: 2 });
```

## Throws

- `REF_NOT_FOUND` / `INVALID_REF_NAME` — `ref` does not resolve.
- `INVALID_SUBMODULE_NAME` — `.gitmodules` row violates CVE-2018-17456 name rules.
- `GITMODULES_TOO_LARGE` — `.gitmodules` exceeds the size cap.

## See also

- Primitives: [`walkSubmodules`](../primitives/walk-submodules.md), [`readObject`](../primitives/read-object.md), [`readConfig`](../primitives/config-read.md) (INI tokenizer reuse)
- Related commands: [`log`](log.md), [`status`](status.md)
- ADRs: [083](../../adr/083-submodule-api-surface.md), [084](../../adr/084-submodule-data-source.md), [085](../../adr/085-nested-submodule-recursion.md), [086](../../adr/086-gitmodules-ini-reuse.md)
- Roadmap: Phase 25.4 — submodule write side (`add` / `init` / `update` / `sync` / `deinit`)
