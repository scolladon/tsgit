# `commit`

Create a commit from the current index. Honours `.git/MERGE_HEAD` automatically — when present, the resulting commit has two parents and the merge-state files are cleared.

## Signature

```ts
repo.commit(opts: CommitOptions): Promise<CommitResult>;

interface CommitOptions {
  readonly message: string;
  readonly author?: AuthorIdentity;
  readonly committer?: AuthorIdentity;
  readonly noVerify?: boolean;
  readonly breakStaleLockMs?: number;
}

interface AuthorIdentity {
  readonly name: string;
  readonly email: string;
  readonly timestamp: number;     // epoch seconds
  readonly timezoneOffset: string; // e.g. '+0000', '-0530'
}
```

## Options

| Field | Type | Default | Meaning |
|---|---|---|---|
| `message` | `string` | (required) | Commit message. Round-tripped through `.git/COMMIT_EDITMSG` so `commit-msg` hooks can rewrite it. |
| `author` | `AuthorIdentity` | from config | Author identity. `timestamp` and `timezoneOffset` are **required** — tsgit never calls `new Date()` on your behalf. |
| `committer` | `AuthorIdentity` | `author` | Committer identity. |
| `noVerify` | `boolean` | `false` | Skip `pre-commit` and `commit-msg` hooks (git's `--no-verify`). |
| `breakStaleLockMs` | `number` | (none) | Break a stale `.git/index.lock` older than this many ms. |

## Behaviour

- **Hooks (Node only):** `pre-commit` runs before the index is read (so a re-staging hook is honoured); `commit-msg` runs after `pre-commit` with the message round-tripped through `.git/COMMIT_EDITMSG`. A non-zero exit throws `HOOK_FAILED`.
- **Merge follow-up:** if `.git/MERGE_HEAD` exists, the commit has two parents and the merge-state files (`MERGE_HEAD`, `MERGE_MSG`, `ORIG_HEAD`) are cleared atomically.
- **Reproducible hashes:** because `timestamp` is caller-provided, repeated calls with identical inputs produce identical commit oids.

## Examples

```ts
await repo.commit({
  message: 'first',
  author: {
    name: 'Alice', email: 'alice@example.com',
    timestamp: Math.floor(Date.now() / 1000),
    timezoneOffset: '+0000',
  },
});

// Skip hooks for a fast commit
await repo.commit({ message: 'wip', noVerify: true });

// Allow staging during a conflicted merge, then resolve
await repo.add(['src/conflicted.ts'], /* during conflict */);
await repo.commit({ message: 'resolve conflict' });
```

## Throws

- `EMPTY_COMMIT` — index matches HEAD's tree (no changes to commit).
- `HOOK_FAILED` — `pre-commit` or `commit-msg` returned non-zero exit (when hooks are enabled).
- `BARE_REPO` — commit is not valid in a bare repository.
- `MERGE_CONFLICTS_PENDING` — unresolved unmerged entries in the index.

## See also

- Primitives: [`createCommit`](../primitives/create-commit.md), [`writeTree`](../primitives/write-tree.md), [`recordRefUpdate`](../primitives/record-ref-update.md), [`runHook`](../primitives/run-hook.md)
- Related commands: [`add`](add.md), [`merge`](merge.md), [`reset`](reset.md)
- ADRs: [065](../../adr/065-hook-runner-port.md), [066](../../adr/066-hooks-default-on.md), [067](../../adr/067-commit-msg-editmsg-roundtrip.md), [068](../../adr/068-windows-hook-execution.md)
