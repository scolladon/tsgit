# Migrating from isomorphic-git

This guide maps every `isomorphic-git` API used by typical consumers to its
tsgit equivalent. Numbers below come from the Phase 11 benchmark suite —
roughly 2× faster on `status`, on par for `log` and `readBlob`, with the
LRU delta cache narrowing further as the working set grows.

## v2.0 Breaking Changes

### `updateRef` options is now a discriminated union

In v1.x, `updateRef` accepted `{ expected?, delete? }`. In v2.0, a ref **write** requires an explicit `reflogMessage`:

```typescript
// v1.x
await repo.primitives.updateRef(ctx, 'refs/heads/main', newId, {});

// v2.0 — write: reflogMessage required
await repo.primitives.updateRef(ctx, 'refs/heads/main', newId, {
  reflogMessage: 'commit: my message',
});

// v2.0 — delete: no message required
await repo.primitives.updateRef(ctx, 'refs/heads/main', someId, {
  delete: true,
});
```

This change is enforced by TypeScript's type system: omitting `reflogMessage` on a write is a compile error, ensuring every ref movement is logged with a human-readable reason.

### `config-read` moved from commands to primitives

The `.git/config` reader relocated from `src/application/commands/internal/config-read.ts` to `src/application/primitives/config-read.ts`. Update imports if you depend on it directly:

```typescript
// v1.x
import { readConfig } from '@scolladon/tsgit/commands/internal/config-read';

// v2.0
import { readConfig } from '@scolladon/tsgit/primitives';
```

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

// tsgit — literal paths
await repo.add(['README.md']);   // also accepts ReadonlyArray<string>

// tsgit — bulk mode (Phase 14.1): walk the working tree and stage
// every modified/new tracked file plus every untracked non-ignored
// file. Drops tracked paths that disappeared from disk.
await repo.add([], { all: true });
```

`all: true` requires an empty pathspec (mixing the two would be
ambiguous); pass paths the literal way or `all: true` — not both. The
host `.git` directory and embedded clones are skipped. Phase 14.3
honours `.gitignore`, `.git/info/exclude`, nested `.gitignore`, and
`core.excludesFile` (from git config; `~`-expanded against the
runtime home directory).

Phase 14.2 adds pathspec globs to `add`, `rm`, and
`checkout({ paths })`:

```typescript
// Stage every .ts except tests.
await repo.add(['*.ts', '!*.test.ts']);

// Remove every .log from the index.
await repo.rm(['*.log']);

// Restore everything under src/ from HEAD.
await repo.checkout({ paths: ['src/**'], source: 'HEAD' });
```

A pattern containing `*`, `?`, or `**` is a glob; otherwise it is a
literal (treated as a directory prefix). `!`-prefixed entries exclude.
Last-match wins. Literal-no-match throws `PATHSPEC_NO_MATCH`;
glob-no-match is a silent no-op.

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

// Path-restore (Phase 13.1):
await repo.checkout({ paths: ['src/foo.ts'] });                // from index
await repo.checkout({ paths: ['src/foo.ts'], source: 'HEAD' }); // from HEAD's tree
```

Phase 13.1 wires the full working-tree materialisation: switching branches
writes / deletes / chmods every file, commits a new `.git/index`, and moves
HEAD — atomic per file (matches canonical git, see ADR-018). Without
`force: true`, the checkout refuses to overwrite a dirty working-tree
file or to clobber an untracked path with `CHECKOUT_OVERWRITE_DIRTY`.

### `git.resetIndex` / `git.checkout({ noUpdateHead })` → `repo.reset({ mode: 'mixed' })`

```typescript
// isomorphic-git — manual index rebuild
await git.resetIndex({ fs, dir: '.', filepath: 'src/foo.ts' });

// tsgit
await repo.reset({ mode: 'mixed', target: 'HEAD~1' });
```

Phase 13.2 makes `mode: 'mixed'` rebuild `.git/index` from the target
commit's tree — atomically, under the same lock that commits it.
Stat-cache fields survive for paths whose `id + mode` match the prior
index (the "stat-cache donor" strategy — ADR-021), so `repo.status()`
stays fast on the next call. Working tree is untouched. Pathspec
scoping (`reset --mixed -- <pathspec>`) is deferred to Phase 14.2
(ADR-022).

### `git.checkout({ force: true, ref })` for full reset → `repo.reset({ mode: 'hard' })`

```typescript
// isomorphic-git — `force: true` checkout to discard local mods
await git.checkout({ fs, dir: '.', ref: 'HEAD', force: true });

// tsgit
await repo.reset({ mode: 'hard', target: 'HEAD' });
```

Phase 13.3 makes `mode: 'hard'` rewrite both the working tree and
`.git/index` to match the target commit's tree — atomically, under
the same `acquireIndexLock` that wraps `readIndex → materializeTree →
commit`. Locally-modified files are force-overwritten, untracked
files outside the target tree are left alone, bare repos still
reject the operation upfront. The new index entries carry
post-write `lstat`-derived stat fields (not donor stats, which would
be stale for files we just rewrote — see ADR-023). Pathspec scoping
deferred to Phase 14.2.

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
await repo.push({ remote: 'origin', refspecs: ['refs/heads/main:refs/heads/main'] });

// Phase 12.3 surface:
//   - `force: true` skips the non-fast-forward guard. `+<src>:<dst>` at the
//     refspec level has the same effect for that single refspec.
//   - `forceWithLease: 'auto'` reads `refs/remotes/<remote>/<branch>` as the
//     lease; mismatch throws PUSH_REJECTED before the pack is sent.
//   - `forceWithLease: <ObjectId>` accepts an explicit expected oid.
//   - `':<dst>'` deletes the remote ref (empty pack body).
//   - `result.pushedRefs[i].status` is `'ok'` or `'rejected'`; per-ref
//     `ng` from the server surfaces as `'rejected'` with `reason`.
//   - On accepted heads-branch pushes, `refs/remotes/<remote>/<branch>` is
//     updated to the new oid.
await repo.push({
  remote: 'origin',
  refspecs: ['refs/heads/main:refs/heads/main'],
  forceWithLease: 'auto',
});
```

### `git.fetch` → `repo.fetch`

```typescript
// isomorphic-git
await git.fetch({ fs, http, dir: '.', singleBranch: true, ref: 'main' });

// tsgit
await repo.fetch({ remote: 'origin', refSpecs: ['refs/heads/main:refs/remotes/origin/main'] });

// Phase 12.2 surface:
//   - `depth: N` performs a shallow fetch and writes `.git/shallow`.
//   - `prune: true` deletes `refs/remotes/<remote>/<branch>` entries the
//     server no longer advertises. Local branches and tags are never
//     touched (ADR-012).
//   - `result.updatedRefs`, `result.prunedRefs`, `result.shallow`,
//     `result.unshallow` are surfaced for programmatic inspection.
await repo.fetch({ remote: 'origin', depth: 1 });
```

### `git.merge` → `repo.merge`

```typescript
// isomorphic-git
await git.merge({
  fs, dir: '.', theirs: 'feature',
  author: { name: 'A', email: 'a@b' },
});

// tsgit
const result = await repo.merge({
  target: 'feature',
  author: { name: 'A', email: 'a@b', timestamp: …, timezoneOffset: '+0000' },
});
switch (result.kind) {
  case 'up-to-date': /* HEAD already contains target */ break;
  case 'fast-forward': /* branch advanced */ break;
  case 'merge': /* merge commit created — result.id, result.parents */ break;
  case 'conflict':
    // Working tree has <<<<<<< markers; index has stage-1/2/3 entries;
    // .git/MERGE_HEAD / MERGE_MSG / ORIG_HEAD are written. Resolve
    // each path, then `repo.add(paths)` + `repo.commit({ message })`.
    break;
}
```

Conflict handling is fully wired (Phase 13.4a + 13.4b). Conflicting
merges return `{ kind: 'conflict', conflicts, mergeHead, origHead }`
rather than throwing — callers that handled the `MERGE_HAS_CONFLICTS`
error code in pre-1.x builds should switch to the discriminated
result. `commit` honours `.git/MERGE_HEAD` automatically: when
present, the resulting commit has two parents and the merge-state
files are cleared.

### `git.readBlob` → `repo.primitives.readBlob`

```typescript
// isomorphic-git
const { blob } = await git.readBlob({ fs, dir: '.', oid });

// tsgit
const blob = await repo.primitives.readBlob(oid);
console.log(blob.content);   // Uint8Array

// Optional cap rejects oversized blobs upfront with OBJECT_TOO_LARGE,
// bypassing the inflate/parse path for the loose-object case.
const bounded = await repo.primitives.readBlob(oid, { maxBytes: 4 * 1024 * 1024 });
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
