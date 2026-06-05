# Recipes

Composed flows. Each recipe is a self-contained snippet plus a paragraph explaining the trade-offs and which commands / primitives it builds on.

For per-command reference see [`commands/`](commands/). For low-level building blocks see [`primitives/`](primitives/).

## Clone and checkout

`clone` populates `.git/` but does not materialise the working tree. Pair with [`checkout`](commands/checkout.md):

```ts
import { openRepository } from '@scolladon/tsgit';

const repo = await openRepository({
  cwd: '/tmp/clone',
  config: {
    dnsResolver: async (host) => (await import('node:dns')).promises.resolve(host),
  },
});

const result = await repo.clone({ url: 'https://github.com/owner/repo.git' });
await repo.checkout({ rev: result.head });
```

The split is deliberate: callers who want a bare clone (`{ bare: true }`) or who want to inspect refs before materialisation never pay for the working-tree write.

## Partial clone

Clone with a `filter` to omit blob content; reads transparently lazy-fetch missing objects from the recorded promisor remote.

```ts
const repo = await openRepository({ cwd: '/tmp/blobless' });
await repo.clone({ url: 'https://github.com/owner/repo.git', filter: 'blob:none' });

// Reads of any blob trigger a single-shot fetch from origin
const tree = await repo.primitives.readTree('HEAD');
for (const entry of tree.data.entries) {
  if (entry.type === 'blob') {
    const blob = await repo.primitives.readBlob(entry.id);  // first read fetches; subsequent reads hit local
    process(blob.content);
  }
}

// Bulk prefetch when you know the working set
await repo.fetchMissing({ oids: [blobA, blobB, blobC] });
```

A regular `fetch` into a partial repo re-applies the stored filter, so the repo stays partial.

## Stage with globs

```ts
// Glob — every .ts except tests
await repo.add(['*.ts', '!*.test.ts']);

// Directory prefix as a literal — stages `src/` and every descendant
await repo.add(['src']);

// `!` exclusions, last-match wins
await repo.add(['src/**', '!src/legacy/**']);
```

Literal-no-match throws `PATHSPEC_NO_MATCH`. Glob-no-match is a silent no-op — matches git's behaviour. Character classes (`[abc]`) and magic prefixes (`:(top)`, `:(literal)`) are not supported in v1.

## Bulk `add --all`

```ts
const result = await repo.add([], { all: true });
console.log(result.added, result.modified, result.removed);
```

Walks the working tree, stages every change. The host `.git` is skipped; embedded clones (directories with a `.git` child) are not auto-staged. Symlinks stage as mode `120000` (lstat-only, never followed). Files larger than 256 MiB throw `WORKING_TREE_FILE_TOO_LARGE` with no partial index commit.

Ignore evaluation honours the standard sources in order: `core.excludesFile`, `.git/info/exclude`, repo-root `.gitignore`, nested `.gitignore` per directory.

## Hook integration

Hooks run by default on Node when scripts are present under `.git/hooks/`:

```ts
try {
  await repo.commit({ message: 'add feature' });
} catch (err) {
  // pre-commit / commit-msg returning non-zero surfaces as HOOK_FAILED
}

// Skip hooks for a single call (git's --no-verify)
await repo.commit({ message: 'wip', noVerify: true });
await repo.push({ noVerify: true });

// Disable hooks globally for the lifetime of the handle
const sandbox = await openRepository({ cwd: '.', hooks: false });
```

`core.hooksPath` is honoured. The browser adapter has no hook runner — hooks are inert in browser contexts.

## Progress and cancellation

Two orthogonal concerns: `progress` reports per-step progress; `signal` cancels in-flight work.

```ts
import { openRepository, consoleProgress } from '@scolladon/tsgit';

const controller = new AbortController();
const repo = await openRepository({
  cwd: '.',
  signal: controller.signal,
  progress: consoleProgress((line) => console.log(line)),
});

setTimeout(() => controller.abort(), 5000);   // hard cancel after 5 s

try {
  await repo.clone({ url: 'https://github.com/owner/big-repo.git' });
} catch (err) {
  // REPOSITORY_DISPOSED on abort
}
```

`dispose()` does the same as `controller.abort()` and then tears down adapters. Idempotent.

## Navigate ref history

Every ref movement records an entry in `.git/logs/<ref>`:

```ts
// Show HEAD reflog
const { entries } = await repo.reflog();
for (const e of entries) console.log(e.selector, e.entry.message);

// Resolve a ref at N moves ago, or at a date
const previous = await repo.revParse('HEAD@{2}');
const yesterday = await repo.revParse('main@{yesterday}');

// Prune old entries
await repo.reflog({ action: 'expire', all: true, expire: '90.days.ago' });
```

Approxidate parser accepts `now`, `yesterday`, `<N>.days.ago`, `YYYY-MM-DD`, `YYYY-MM-DD HH:MM:SS`.

## Materialise a subset of the tree

```ts
// Restrict the working tree to two directories (cone mode — the default)
const applied = await repo.sparseCheckout.set({
  patterns: ['src/app', 'docs'],
});
console.log(applied.materialized, 'files written');
console.log(applied.removed, 'files removed');

// Widen
await repo.sparseCheckout.add({ patterns: ['src/lib'] });

// `.gitignore`-style non-cone mode
await repo.sparseCheckout.set({
  cone: false,
  patterns: ['*.ts', '!*.test.ts'],
});

// Inspect / re-apply / disable
const { cone, patterns } = await repo.sparseCheckout.list();
await repo.sparseCheckout.reapply();
await repo.sparseCheckout.disable();
```

Excluded files stay in the index (marked `skip-worktree`) — `commit` still records the whole tree, `status` does not report the absences as deletions. `checkout` honours the cone on branch switch. Dirty out-of-cone files are retained, not discarded, unless `force: true`.

## Walk submodules

```ts
// List submodules pinned at HEAD
const { entries } = await repo.submodules();
for (const e of entries) console.log(e.path, e.commit, e.url ?? '(no .gitmodules row)');

// Recurse into nested submodules whose absorbed gitdir is locally available
const nested = await repo.submodules({ ref: 'main', recursive: true });

// Stream form — bounded memory; iterate and stop when you want
for await (const e of repo.primitives.walkSubmodules({ recursive: true })) {
  if (e.depth >= 2) break;
}
```

Network is never touched — `url` is opaque data. Uninitialised, missing-commit, cycle-detected, and depth-capped submodules contribute their own entry but no children — git-faithful with `git submodule status --recursive`.

## Streaming object reader

Equivalent to `git cat-file --batch` but yields parsed objects:

```ts
// Tier-1 — collect entries for a known set of ids
const { entries } = await repo.catFile({
  ids: [oid1, oid2, missingOid],
  maxBytes: 16 * 1024 * 1024,
});
for (const entry of entries) {
  if (entry.ok) console.log(entry.id, entry.type, entry.size);
  else console.log(entry.id, 'missing');
}

// Tier-2 — back-pressure-friendly stream for very large batches
async function* ids() { yield oid1; yield oid2; yield oid3; }
for await (const entry of repo.primitives.catFileBatch(ids())) {
  if (entry.ok && entry.type === 'blob') process(entry.object);
}
```

Entries land in strict input order, one per id, sequentially. A missing object yields `{ ok: false, id, reason: 'missing' }` — the stream survives sparse misses. Partial-clone lazy-fetch is transparent.

## Compose your own walk

The walker primitives are real `AsyncIterable`s; the [operator toolkit](primitives/README.md#composition-pattern) composes against them:

```ts
import { pipe, filter, map, take, toArray } from '@scolladon/tsgit/operators';

// Recent .ts blobs by author
const blobs = pipe(
  repo.primitives.walkCommits({ from: 'HEAD' }),
  take(20),
  filter(c => c.data.author.name === 'Alice'),
  map(async c => ({ id: c.id, tree: await repo.primitives.walkTree(c.data.tree) })),
);

for await (const commit of blobs) {
  for await (const entry of commit.tree) {
    if (entry.type === 'blob' && entry.path.endsWith('.ts')) {
      console.log(commit.id, entry.path);
    }
  }
}
```

Back-pressure is native — walkers advance only when the consumer pulls. Memory stays bounded across arbitrarily large repos.

## Render a patch

`repo.diff({ format: 'patch' })` returns canonical unified-diff text plus
the structured `TreeDiff`. The text is byte-identical to
`git diff --no-ext-diff --no-color`, so it pipes directly into `patch(1)`
or any review UI that consumes git's diff format:

```ts
const patch = await repo.diff({
  from: 'HEAD~1',
  to: 'HEAD',
  format: 'patch',
});

console.log(`Changed files: ${patch.diff.changes.length}`);
process.stdout.write(patch.text);
```

Bundling the structured view inside `PatchResult` removes the two-call
pattern (`diff` + `diff({ format: 'patch' })`) every UI consumer would
otherwise need; the `TreeDiff` came for free on the way to the text.
