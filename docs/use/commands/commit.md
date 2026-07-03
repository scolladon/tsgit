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
  readonly sign?: boolean;
  readonly signKey?: string;
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
| `message` | `string` | (required) | Commit message. Normalized with git's `stripspace` (see Behaviour) and round-tripped through `.git/COMMIT_EDITMSG` so `commit-msg` hooks can rewrite it. |
| `author` | `AuthorIdentity` | from config | Author identity. `timestamp` and `timezoneOffset` are **required** — tsgit never calls `new Date()` on your behalf. |
| `committer` | `AuthorIdentity` | `author` | Committer identity. |
| `noVerify` | `boolean` | `false` | Skip `pre-commit` and `commit-msg` hooks (git's `--no-verify`). |
| `breakStaleLockMs` | `number` | (none) | Break a stale `.git/index.lock` older than this many ms. |
| `sign` | `boolean` | `commit.gpgsign` | GPG-sign the commit (git's `-S`). The armored signature is inserted as the `gpgsig` header, so the commit oid changes. Requires a signing program (`gpg`, or `ssh-keygen` when `gpg.format=ssh`) via the command runner — off-node this throws `SIGNING_FAILED`. |
| `signKey` | `string` | `user.signingkey` | Signing-key selector. Falls back to `user.signingkey`, then the committer identity. |

## Behaviour

- **Hooks (Node only):** in git's order — `pre-commit` runs before the index is read (so a re-staging hook is honoured); then the message round-trips through `.git/COMMIT_EDITMSG` via `prepare-commit-msg` (args `<editmsg-path> <source>`, where `source` is `message` or `merge`) and `commit-msg`; either may rewrite it. `post-commit` runs after the commit lands (informational — its exit code is ignored). A non-zero exit from a blocking hook throws `HOOK_FAILED`. `noVerify` skips `pre-commit` + `commit-msg` only — `prepare-commit-msg` still runs, as in git.
- **Merge follow-up:** if `.git/MERGE_HEAD` exists, the commit has two parents and the merge-state files (`MERGE_HEAD`, `MERGE_MSG`, `ORIG_HEAD`) are cleared atomically.
- **Message normalization:** the message is run through git's `stripspace` (the `whitespace` cleanup mode `git commit -m` uses) — per-line trailing whitespace is stripped, runs of blank lines collapse to one, leading/trailing blank lines are dropped, and a single trailing newline is guaranteed. This makes commit-object SHAs byte-identical to canonical git. Leading whitespace on a content line is preserved (git keeps it), and only ASCII whitespace is treated as blank. The low-level `repo.primitives.createCommit` is the verbatim escape hatch — it does **not** normalize.
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

- `NOTHING_TO_COMMIT` — index matches HEAD's tree (no changes to commit).
- `HOOK_FAILED` — `pre-commit` or `commit-msg` returned non-zero exit (when hooks are enabled).
- `BARE_REPOSITORY` — commit is not valid in a bare repository.
- `AUTHOR_UNCONFIGURED` — no `user.name` / `user.email` in config and no caller-supplied identity.
- `CONFIG_MISSING_VALUE` — a `[user]` `name` or `email` line is present but valueless (git NULL); carries `{ key, source, line }`. Distinct from the absent case (`AUTHOR_UNCONFIGURED`). The first valueless `user.*` entry by config-file line order is reported.
- `SIGNING_FAILED` — `sign` requested but the signing program failed or is unavailable (e.g. off-node, no `gpg`, bad key, or `gpg.format=x509` which is unsupported).

## See also

- Primitives: [`createCommit`](../primitives/create-commit.md), [`writeTree`](../primitives/write-tree.md), [`recordRefUpdate`](../primitives/internals.md#recordrefupdate), [`runHook`](../primitives/run-hook.md)
- Related commands: [`add`](add.md), [`merge`](merge.md), [`reset`](reset.md)
- ADRs: [065](../../adr/065-hook-runner-port.md), [066](../../adr/066-hooks-default-on.md), [067](../../adr/067-commit-msg-editmsg-roundtrip.md), [068](../../adr/068-windows-hook-execution.md), [442](../../adr/442-reuse-command-runner-for-signing.md), [445](../../adr/445-narrow-commit-signature-injection-guard.md), [446](../../adr/446-signing-success-exit-and-armor.md), [447](../../adr/447-off-node-signing-hard-refuse.md)
