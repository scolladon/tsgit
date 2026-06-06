# `log`

Walk commit history starting from a tip. By default this is git's default `git log` order — every reachable commit, across **all** parents, newest committer-date first. Returns an array; for streaming back-pressure use the [`walkCommitsByDate`](../primitives/walk-commits-by-date.md) / [`walkCommits`](../primitives/walk-commits.md) primitives directly.

## Signature

```ts
repo.log(opts?: LogOptions): Promise<ReadonlyArray<LogEntry>>;

type LogOrder = 'date' | 'first-parent';

interface LogOptions {
  readonly rev?: string;                      // commit-ish, full grammar; default 'HEAD'
  readonly order?: LogOrder;                  // default 'date'
  readonly limit?: number;                    // bound the walk
  readonly excluding?: ReadonlyArray<string>; // commit-ish stops (negative range)
  readonly before?: Date;                     // only commits with committer.timestamp < before
}

interface LogEntry {
  readonly id: ObjectId;
  readonly tree: ObjectId;
  readonly parents: ReadonlyArray<ObjectId>;
  readonly author: AuthorIdentity;
  readonly committer: AuthorIdentity;
  readonly message: string;
}
```

## Behaviour

- **Order — `'date'` (default):** every reachable commit across all parents, newest committer-date first (git's default `git log`). **`'first-parent'`:** follows only the first parent of each merge (`git log --first-parent`).
- **`rev` / `excluding` grammar:** both resolve through the full rev grammar — short names, `~`/`^`, `@{…}`, abbreviated oids, and annotated-tag peeling (`repo.log({ rev: 'v1.0~3' })` works). An unresolvable `rev` or `excluding` entry refuses (it is not silently skipped).
- **Message:** the raw commit-object body, returned verbatim. Since the `commit` porcelain applies git's `stripspace` normalization, a message written via [`repo.commit`](commit.md) ends with exactly one trailing `\n` (e.g. `'fix bug\n'`). Fold it yourself (e.g. first line) for a subject.

## Examples

```ts
// Last 10 on the current branch (date order, all parents)
const recent = await repo.log({ limit: 10 });

// First-parent spine only
const spine = await repo.log({ order: 'first-parent' });

// Range A..B (commits reachable from B but not from A)
const incoming = await repo.log({ rev: 'feature/x', excluding: ['main'] });

// Grammar selector + time bound
const last = await repo.log({ rev: 'HEAD~20', before: new Date('2026-01-01') });
```

## Throws

- `OBJECT_NOT_FOUND` / `INVALID_REF` — `rev` (or an `excluding` entry) does not resolve.

## See also

- Primitives: [`walkCommitsByDate`](../primitives/walk-commits-by-date.md), [`walkCommits`](../primitives/walk-commits.md), [`resolveRef`](../primitives/resolve-ref.md)
- Related commands: [`diff`](diff.md), [`revParse`](rev-parse.md), [`reflog`](reflog.md)
