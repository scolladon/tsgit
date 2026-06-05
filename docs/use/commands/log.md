# `log`

Walk first-parent commit history starting from a tip. Returns an array; for streaming back-pressure use the [`walkCommits`](../primitives/walk-commits.md) primitive directly.

## Signature

```ts
repo.log(opts?: LogOptions): Promise<ReadonlyArray<LogEntry>>;

interface LogOptions {
  readonly rev?: string;                     // ref / oid / 'HEAD'; default 'HEAD'
  readonly limit?: number;                   // bound the walk
  readonly excluding?: ReadonlyArray<string>; // stop oids (negative range)
  readonly before?: Date;                    // only commits with committer.timestamp < before
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

- **First-parent walk:** for merge commits, only the first parent is followed. Use [`walkCommits`](../primitives/walk-commits.md) for arbitrary parent ordering.
- **Order:** newest first.
- **Message:** the raw commit-object body, returned verbatim. Since the `commit` porcelain applies git's `stripspace` normalization, a message written via [`repo.commit`](commit.md) ends with exactly one trailing `\n` (e.g. `'fix bug\n'`). Trim it yourself if you need the bare subject.

## Examples

```ts
// Last 10 on the current branch
const recent = await repo.log({ limit: 10 });

// Range A..B (commits reachable from B but not from A)
const incoming = await repo.log({ rev: 'feature/x', excluding: ['main'] });

// Time-bounded
const before = new Date('2026-01-01');
const last = await repo.log({ before });
```

## Throws

- `REF_NOT_FOUND` / `INVALID_REF` — `rev` does not resolve.

## See also

- Primitives: [`walkCommits`](../primitives/walk-commits.md), [`resolveRef`](../primitives/resolve-ref.md)
- Related commands: [`diff`](diff.md), [`revParse`](rev-parse.md), [`reflog`](reflog.md)
