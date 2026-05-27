# Snapshots

`tsgit` exposes a unified snapshot+join surface for querying the four git
"sources" — tree, index, working tree, and stash — through a single pipeline
API. This page introduces the mental model and links to the worked examples.

## Mental model

A **snapshot** is a *description*, not data. Calling `repo.snapshot.head()`
returns immediately and performs zero I/O. Reading happens only when you
iterate the result:

```ts
const tree = repo.snapshot.head();
for await (const entry of tree.entries()) {
  console.log(entry.path, await entry.read());
}
```

Three properties hold for every snapshot kind (design §8.0, ADR-149):

1. **Lazy** — no syscall until `.entries()` is consumed.
2. **Atomic per handle** — the data captured on the first iteration is
   replayed for subsequent iterations on the same handle. Concurrent writes
   never disturb an in-flight `for await` loop.
3. **Fresh per call to the factory** — `repo.snapshot.index()` always
   re-reads the cache state at call time; an external write between two
   factory calls produces two different snapshots.

## The factory

`repo.snapshot` returns a `SnapshotFactory`:

| Method | Returns | Notes |
|---|---|---|
| `head()` | `TreeSnapshot` | the HEAD commit's tree |
| `commit(oid)` | `TreeSnapshot` | a specific commit's tree |
| `tree(oid)` | `TreeSnapshot` | a tree by oid (no peeling) |
| `index()` | `IndexSnapshot` | the current `.git/index` |
| `workdir(opts)` | `WorkdirSnapshot` | the working tree |
| `mergeHead()` | `Promise<TreeSnapshot \| null>` | compound state |
| `cherryPickHead()` | `Promise<TreeSnapshot \| null>` | compound state |
| `revertHead()` | `Promise<TreeSnapshot \| null>` | compound state |
| `fetchHead()` | `Promise<TreeSnapshot \| null>` | compound state |
| `stashEntry(i)` | `Promise<StashSnapshot \| null>` | a stash entry (index + workdir + untracked) |

The compound-state factories return `Promise` because they have to check
whether the underlying ref file exists. They still don't parse the tree
until iterated.

## Worked example — `status`

Compare head, index, and workdir in a single pass:

```ts
import { join, count } from 'tsgit';

const rows = join({
  head: repo.snapshot.head(),
  index: repo.snapshot.index(),
  workdir: repo.snapshot.workdir(),
});

for await (const row of rows) {
  // row.head / row.index / row.workdir are optional — undefined when that
  // source has no entry at row.path
}
```

## Worked example — `diff`

```ts
import { innerJoin } from 'tsgit';

const changed = innerJoin({
  before: repo.snapshot.commit(parentOid),
  after: repo.snapshot.head(),
});

for await (const row of changed) {
  // row.before.oid !== row.after.oid (when content differs)
}
```

## Worked example — untracked

```ts
import { join } from 'tsgit';

const rows = join({
  index: repo.snapshot.index(),
  workdir: repo.snapshot.workdir(),
});

for await (const row of rows) {
  if (row.index === undefined && row.workdir !== undefined) {
    // untracked file
  }
}
```

## Working with `null`-returning factories

Compound-state factories return `Promise<TreeSnapshot | null>`. You must
null-check or wrap with `requireSnapshot` before passing to `join`:

```ts
import { requireSnapshot } from 'tsgit';

const theirs = await requireSnapshot(repo.snapshot.mergeHead(), 'no merge in progress');
const rows = join({ ours: repo.snapshot.head(), theirs });
```

Passing a `Promise<… | null>` directly into `join` is a type error by
design — the row's slot type cannot be inferred through a promise wrapper.

## Operators

The pipeline composes via async-iterable operators (see
`tsgit/application/primitives/snapshot-operators`):

- `hashWorkdir({ concurrency })` — pre-warms `WorkdirEntry.hash()` calls.
- `loadBlob(slot, { maxInflightBytes })` — pre-loads blob bytes with a
  bounded byte budget (default 64 MiB).
- `verifyWorkdir({ onRace: 'throw' | 'skip' | 'emit' })` — re-`lstat`s
  workdir entries on iteration for race detection.
- `groupByDir()` — groups consecutive rows by parent directory.
- `count`, `toArray`, `first` — terminal operators returning `Promise<T>`.

## Order invariant

All snapshot+join iterables yield rows in **canonical git path order**.
Operators consuming a row stream MUST preserve order; a downstream
`assertOrdered` will throw `ORDER_INVARIANT_VIOLATION` if a stage reorders
rows. This guarantees compositions like `groupByDir` see contiguous rows
per directory without needing buffering.

## Cancellation

Every iteration honours three signals composed by an AND-of-aborts:

1. `ctx.signal` from `openRepository`,
2. `SnapshotOptions.signal` per snapshot,
3. `JoinOptions.signal` from the join call.

The first abort wins; downstream iterators surface the abort as
`OPERATION_ABORTED`.

## Further reading

- [docs/understand/caching.md](../understand/caching.md) — caching protocol,
  generation tracking, racy-stat handling.
- [docs/adr/148–161](../adr) — every design decision behind the
  snapshot+join surface.
- [docs/design/phase-20-1-snapshot-and-join.md](../design/phase-20-1-snapshot-and-join.md)
  — the full design spec.
