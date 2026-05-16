# Migrating from isomorphic-git

This guide maps every `isomorphic-git` API used by typical consumers to its
tsgit equivalent. Numbers below come from the Phase 11 benchmark suite —
roughly 2× faster on `status`, on par for `log` and `readBlob`, with the
LRU delta cache narrowing further as the working set grows.

## Differences at a glance

| Concern | isomorphic-git | tsgit |
|---|---|---|
| Entry point | named-function imports (`git.log({...})`) | `openRepository(opts)` returns a frozen `Repository` |
| Runtime detection | manual `fs` and `http` injection per call | auto-detected (`/auto/node`, `/auto/browser`, `/auto/memory`) |
| Lifetime | implicit, per call | explicit — `repo.dispose()` aborts in-flight work |
| Validation | per-call, partial | every option validated at `openRepository` time |
| SSRF guards | opt-in | always-on, opt-out via `unsafeRawAdapters` |
| Bundle size | ~250 KiB gzipped | ~86 KiB gzipped (full library) |

## Setup

```typescript
// isomorphic-git
import * as git from 'isomorphic-git';
import * as fs from 'node:fs';
import http from 'isomorphic-git/http/node';

// tsgit (Node — auto)
import { openRepository } from '@scolladon/tsgit';
const repo = await openRepository({ cwd: '.' });
// …
await repo.dispose();
```

The browser story is symmetric: `import { openRepository } from '@scolladon/tsgit/auto/browser';` plus a `rootHandle: await navigator.storage.getDirectory()`.

## Command-by-command

### `git.init` → `repo.init`

```typescript
// isomorphic-git
await git.init({ fs, dir: '.', defaultBranch: 'main' });

// tsgit
await repo.init({ initialBranch: 'main' });
```

### `git.clone` → `repo.clone`

```typescript
// isomorphic-git
await git.clone({ fs, http, dir: '.', url: 'https://github.com/owner/repo' });

// tsgit
await repo.clone({ url: 'https://github.com/owner/repo' });
```

### `git.add` → `repo.add`

```typescript
// isomorphic-git
await git.add({ fs, dir: '.', filepath: 'README.md' });

// tsgit
await repo.add(['README.md']);   // also accepts ReadonlyArray<string>
```

### `git.commit` → `repo.commit`

```typescript
// isomorphic-git
await git.commit({
  fs, dir: '.', message: 'first',
  author: { name: 'A', email: 'a@b' },
});

// tsgit
await repo.commit({
  message: 'first',
  author: {
    name: 'A', email: 'a@b',
    timestamp: Math.floor(Date.now() / 1000),
    timezoneOffset: '+0000',
  },
});
```

`tsgit` requires an explicit timestamp + tz offset so commit hashes are
reproducible — no hidden `new Date()` call.

### `git.status` / `git.statusMatrix` → `repo.status`

```typescript
// isomorphic-git
const matrix = await git.statusMatrix({ fs, dir: '.' });
// matrix is Array<[path, headStatus, workdirStatus, stageStatus]>

// tsgit
const result = await repo.status();
// { clean: boolean, branch?: RefName, changes: ChangeEntry[] }
```

### `git.log` → `repo.log`

```typescript
// isomorphic-git
const commits = await git.log({ fs, dir: '.', depth: 100 });

// tsgit
const commits = await repo.log({ depth: 100 });
```

### `git.branch` / `git.listBranches` / `git.deleteBranch` → `repo.branch`

```typescript
// isomorphic-git
const list = await git.listBranches({ fs, dir: '.' });
await git.branch({ fs, dir: '.', ref: 'feature' });
await git.deleteBranch({ fs, dir: '.', ref: 'feature' });

// tsgit
const list = await repo.branch({ kind: 'list' });
await repo.branch({ kind: 'create', name: 'feature' });
await repo.branch({ kind: 'delete', name: 'feature' });
```

### `git.checkout` → `repo.checkout`

```typescript
// isomorphic-git
await git.checkout({ fs, dir: '.', ref: 'main' });

// tsgit
await repo.checkout({ target: 'main' });
```

`tsgit`'s v1 checkout only moves `HEAD`; working-tree materialization
lands in v1.x. The semantics that DO ship are documented in the result
shape returned to the caller.

### `git.tag` / `git.listTags` → `repo.tag`

```typescript
// isomorphic-git
await git.tag({ fs, dir: '.', ref: 'v1.0.0' });
const tags = await git.listTags({ fs, dir: '.' });

// tsgit
await repo.tag({ kind: 'create', name: 'v1.0.0' });
const tags = await repo.tag({ kind: 'list' });
```

### `git.push` → `repo.push`

```typescript
// isomorphic-git
await git.push({ fs, http, dir: '.', ref: 'main' });

// tsgit
await repo.push({ remote: 'origin', refSpecs: ['refs/heads/main:refs/heads/main'] });
```

### `git.fetch` → `repo.fetch`

```typescript
// isomorphic-git
await git.fetch({ fs, http, dir: '.', singleBranch: true, ref: 'main' });

// tsgit
await repo.fetch({ remote: 'origin', refSpecs: ['refs/heads/main:refs/remotes/origin/main'] });
```

### `git.merge` → `repo.merge`

```typescript
// isomorphic-git
await git.merge({
  fs, dir: '.', theirs: 'feature',
  author: { name: 'A', email: 'a@b' },
});

// tsgit
await repo.merge({
  theirs: 'refs/heads/feature',
  author: { name: 'A', email: 'a@b', timestamp: …, timezoneOffset: '+0000' },
});
```

v1 `repo.merge` records the merge commit using HEAD's tree (3-way tree
walk lands in v1.x); conflict detection is fully wired today.

### `git.readBlob` → `repo.primitives.readBlob`

```typescript
// isomorphic-git
const { blob } = await git.readBlob({ fs, dir: '.', oid });

// tsgit
const blob = await repo.primitives.readBlob(oid);
console.log(blob.content);   // Uint8Array
```

### `git.walk` / `git.TREE` → `repo.primitives.walkTree`

```typescript
// isomorphic-git
await git.walk({
  fs, dir: '.', trees: [git.TREE({ ref: 'HEAD' })],
  map: async (filename, [entry]) => { /* … */ },
});

// tsgit
for await (const entry of repo.primitives.walkTree('HEAD')) {
  // entry: TreeEntry — { name, mode, id, type }
}
```

`tsgit`'s walk is a real `AsyncIterable`, so the [operator toolkit](src/operators)
(`filter`, `map`, `flatMap`, `take`, `find`, `groupBy`, `toArray`) composes
directly.

## Cleanup

Always `dispose` to abort in-flight work and release adapter resources:

```typescript
const repo = await openRepository({ cwd: '.' });
try {
  await repo.commit({ /* … */ });
} finally {
  await repo.dispose();
}
```

`dispose` is idempotent and aborts every primitive in-flight via the
internal `AbortSignal`. After it resolves, every bound method on the
repo throws `REPOSITORY_DISPOSED`.

## Compatibility shim?

A drop-in `isomorphic-git` namespace shim is **out of scope** for v1.
The two APIs surface different lifetime + validation models, and a
literal shim would re-introduce isomorphic-git's per-call validation
gaps. If you need a transitional layer, wrap `tsgit` in your own
adapter and migrate one call site at a time.
