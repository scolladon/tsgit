# Migrate from `isomorphic-git`

This guide maps every `isomorphic-git` API used by typical consumers to its tsgit equivalent.

## Differences at a glance

| Concern | isomorphic-git | tsgit |
|---|---|---|
| Entry point | named-function imports (`git.log({...})`) | `openRepository(opts)` returns a frozen `Repository` |
| Runtime detection | manual `fs` and `http` injection per call | auto-detected (`/auto/node`, `/auto/browser`, `/auto/memory`) |
| Lifetime | implicit, per call | explicit — `repo.dispose()` aborts in-flight work |
| Validation | per-call, partial | every option validated at `openRepository` time |
| SSRF guards | opt-in | always-on, opt-out via `unsafeRawAdapters` |
| Bundle size | larger | Node entry < 60 KB gz, tree-shakeable |

## Setup

```ts
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

The browser story is symmetric: `import { openRepository } from '@scolladon/tsgit/auto/browser';` plus `rootHandle: await navigator.storage.getDirectory()`.

## Command-by-command

### `git.init` → `repo.init`

```ts
// isomorphic-git
await git.init({ fs, dir: '.', defaultBranch: 'main' });

// tsgit
await repo.init({ initialBranch: 'main' });
```

### `git.clone` → `repo.clone`

```ts
// isomorphic-git
await git.clone({ fs, http, dir: '.', url: 'https://github.com/owner/repo' });

// tsgit
await repo.clone({ url: 'https://github.com/owner/repo' });
```

### `git.add` → `repo.add`

```ts
// isomorphic-git
await git.add({ fs, dir: '.', filepath: 'README.md' });

// tsgit — literal paths
await repo.add(['README.md']);

// tsgit — bulk mode
await repo.add([], { all: true });
```

`all: true` requires an empty pathspec. The host `.git` directory and embedded clones are skipped. Ignore evaluation honours `core.excludesFile`, `.git/info/exclude`, `.gitignore`, and nested `.gitignore`.

Pathspec globs are supported across `add`, `rm`, and `checkout({ paths })`:

```ts
await repo.add(['*.ts', '!*.test.ts']);
await repo.rm(['*.log']);
await repo.checkout({ paths: ['src/**'], source: 'HEAD' });
```

`*`, `?`, `**`, `!` are supported. Character classes (`[abc]`) and magic prefixes (`:(top)`, `:(literal)`) are not in v1.

### `git.commit` → `repo.commit`

```ts
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

tsgit requires an explicit `timestamp` + `timezoneOffset` so commit hashes are reproducible — no hidden `new Date()` call.

### `git.status` / `git.statusMatrix` → `repo.status`

```ts
// isomorphic-git
const matrix = await git.statusMatrix({ fs, dir: '.' });

// tsgit
const result = await repo.status();
// { clean, branch, detached, changes, untracked, unmerged }
```

The shape changes: tsgit returns one correlated `ChangedPath` per path (its `staged`/`unstaged` kinds plus the `head`/`index`/`worktree` blob endpoints — the structured form of `git status --porcelain=v2`), with `untracked` and `unmerged` as separate fields, instead of a 4-tuple matrix. Filter caller-side.

### `git.log` → `repo.log`

```ts
// isomorphic-git
const commits = await git.log({ fs, dir: '.', depth: 100 });

// tsgit
const commits = await repo.log({ limit: 100 });
```

### `git.branch` / `git.listBranches` / `git.deleteBranch` → `repo.branch`

```ts
// isomorphic-git
const list = await git.listBranches({ fs, dir: '.' });
await git.branch({ fs, dir: '.', ref: 'feature' });
await git.deleteBranch({ fs, dir: '.', ref: 'feature' });

// tsgit
const list = await repo.branch.list();
await repo.branch.create({ name: 'feature' });
await repo.branch.delete({ name: 'feature' });
```

### `git.checkout` → `repo.checkout`

```ts
// isomorphic-git
await git.checkout({ fs, dir: '.', ref: 'main' });

// tsgit — branch switch
await repo.checkout({ rev: 'main' });

// tsgit — path restore
await repo.checkout({ paths: ['src/foo.ts'] });                  // from index
await repo.checkout({ paths: ['src/foo.ts'], source: 'HEAD' });  // from HEAD's tree
```

Without `force: true`, the checkout refuses to overwrite a dirty working-tree file or to clobber an untracked path with `CHECKOUT_OVERWRITE_DIRTY`.

### `git.resetIndex` → `repo.reset({ mode: 'mixed' })`

```ts
// isomorphic-git
await git.resetIndex({ fs, dir: '.', filepath: 'src/foo.ts' });

// tsgit
await repo.reset({ mode: 'mixed', rev: 'HEAD~1' });
```

Working tree is untouched; index rebuilt from the target commit's tree under the same lock that commits it. Pathspec scoping (`reset --mixed -- <pathspec>`) is roadmap (Phase 22).

### `git.checkout({ force: true })` for full reset → `repo.reset({ mode: 'hard' })`

```ts
// isomorphic-git
await git.checkout({ fs, dir: '.', ref: 'HEAD', force: true });

// tsgit
await repo.reset({ mode: 'hard', rev: 'HEAD' });
```

Atomic; rewrites both the working tree and `.git/index` to match the target commit's tree.

### `git.tag` / `git.listTags` → `repo.tag`

```ts
// isomorphic-git
await git.tag({ fs, dir: '.', ref: 'v1.0.0' });
const tags = await git.listTags({ fs, dir: '.' });

// tsgit
await repo.tag.create({ name: 'v1.0.0' });
const tags = await repo.tag.list();
```

### `git.push` → `repo.push`

```ts
// isomorphic-git
await git.push({ fs, http, dir: '.', ref: 'main' });

// tsgit
await repo.push({ remote: 'origin', refspecs: ['refs/heads/main:refs/heads/main'] });

// Force-with-lease
await repo.push({
  remote: 'origin',
  refspecs: ['refs/heads/main:refs/heads/main'],
  forceWithLease: 'auto',
});
```

### `git.fetch` → `repo.fetch`

```ts
// isomorphic-git
await git.fetch({ fs, http, dir: '.', singleBranch: true, ref: 'main' });

// tsgit
await repo.fetch({ remote: 'origin', refspecs: ['refs/heads/main:refs/remotes/origin/main'] });

// Shallow fetch + prune
await repo.fetch({ remote: 'origin', depth: 1, prune: true });
```

### `git.merge` → `repo.merge.run`

```ts
// isomorphic-git
await git.merge({
  fs, dir: '.', theirs: 'feature',
  author: { name: 'A', email: 'a@b' },
});

// tsgit — merge is a namespace: run / continue / abort
const result = await repo.merge.run({
  rev: 'feature',
  author: { name: 'A', email: 'a@b', timestamp: 0, timezoneOffset: '+0000' },
});

switch (result.kind) {
  case 'up-to-date': break;
  case 'fast-forward': break;
  case 'merge': break;       // result.id, result.parents
  case 'conflict':            // working tree has markers; index has stage 1/2/3
    // resolve, then:
    await repo.add(result.conflicts.map(c => c.path));
    await repo.merge.continue({ message: 'resolve' });
    break;
}
```

Fast-forward policy is the `fastForward: 'only' | 'never' | 'allow'` field (git `--ff-only` / `--no-ff` / `--ff`), replacing the older `fastForwardOnly` / `noFastForward` boolean pair.

Conflicting merges **return** a discriminated `'conflict'` result rather than throwing. Callers that handled the `MERGE_HAS_CONFLICTS` error code in pre-1.x builds should switch to the result discriminator. `commit` honours `.git/MERGE_HEAD` automatically.

### `git.pull` → `repo.pull`

```ts
// isomorphic-git
await git.pull({ fs, http, dir: '.', ref: 'main', author: { name: 'A', email: 'a@b' } });

// tsgit — upstream resolved from clone-written tracking config
const { fetch, merge } = await repo.pull({
  author: { name: 'A', email: 'a@b', timestamp: 0, timezoneOffset: '+0000' },
});

// Explicit remote + ref (no upstream configured)
await repo.pull({ remote: 'origin', ref: 'main' });
```

`pull` is `fetch` + `merge`; it returns both results (`{ fetch, merge }`) and, like `merge`, surfaces conflicts via `merge.kind === 'conflict'` rather than throwing — resolve and `repo.merge.continue`, or `repo.merge.abort`. `rebase` mode arrives with `rebase` itself.

### `git.readBlob` → `repo.primitives.readBlob`

```ts
// isomorphic-git
const { blob } = await git.readBlob({ fs, dir: '.', oid });

// tsgit
const blob = await repo.primitives.readBlob(oid);
console.log(blob.content);   // Uint8Array

// Optional size cap rejects oversized blobs upfront
const bounded = await repo.primitives.readBlob(oid, { maxBytes: 4 * 1024 * 1024 });
```

### `git.walk` / `git.TREE` → `repo.primitives.walkTree`

```ts
// isomorphic-git
await git.walk({
  fs, dir: '.', trees: [git.TREE({ ref: 'HEAD' })],
  map: async (filename, [entry]) => { /* … */ },
});

// tsgit
for await (const entry of repo.primitives.walkTree(await repo.primitives.resolveRef('HEAD'))) {
  // entry: TreeEntry — { name, path, mode, id, type }
}
```

tsgit's walks are real `AsyncIterable`s, so the [operator toolkit](../use/primitives/) (`filter`, `map`, `flatMap`, `take`, `find`, `groupBy`, `toArray`) composes directly.

A unified parallel walker (`walk({ trees: [TREE, WORKDIR, STAGE], map })` matching `isomorphic-git`'s signature) is roadmap (Phase 20.1).

## Cleanup

Always `dispose` to abort in-flight work and release adapter resources:

```ts
const repo = await openRepository({ cwd: '.' });
try {
  await repo.commit({ /* … */ });
} finally {
  await repo.dispose();
}
```

`dispose` is idempotent and aborts every primitive in-flight via the internal `AbortSignal`. After it resolves, every bound method on the repo throws `REPOSITORY_DISPOSED`.

## Compatibility shim?

A drop-in `isomorphic-git` namespace shim is **not planned** ([ADR-091](../adr/091-abandon-isomorphic-git-shim.md)). The two APIs surface different lifetime + validation models, and a literal shim would either re-introduce isomorphic-git's per-call validation gaps or hide a singleton repo behind the namespace — both undermine the invariants the v1 surface exists to enforce.

If you need a transitional layer, wrap tsgit in your own adapter and migrate one call site at a time. If you hit a migration blocker that a per-codebase adapter can't paper over, open an issue with a concrete example — that's the signal that would justify revisiting.

## What's next

| Want to… | Read |
|---|---|
| See every command available | [Commands reference](../use/commands/) |
| Compose your own walks | [Primitives reference](../use/primitives/) |
| See real-world flows | [Recipes](../use/recipes.md) |
| Understand the design | [Architecture](../understand/architecture.md) · [design decisions](../understand/design-decisions.md) |
