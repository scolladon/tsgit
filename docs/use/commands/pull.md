# `pull`

Integrate a remote branch into the current branch: `fetch` the remote, then
`merge` the fetched tip into `HEAD`. Returns the underlying `fetch` and `merge`
results — **conflicts do not throw**; `pull` inherits `merge`'s state machine, so
`merge.abort` / `merge.continue` resolve a pull-initiated conflict unchanged.

Integration is merge-only; the `rebase` mode is added when `rebase` lands.

## Signature

```ts
repo.pull(opts?: PullOptions): Promise<PullResult>;

interface PullOptions {
  readonly remote?: string;        // default: branch.<current>.remote ?? sole configured remote ?? 'origin'
  readonly ref?: string;           // remote ref to merge; default: short form of branch.<current>.merge
  readonly fastForward?: 'only' | 'never' | 'allow'; // default 'allow'; forwarded to merge
  readonly prune?: boolean;        // forwarded to fetch
  readonly depth?: number;         // forwarded to fetch
  readonly message?: string;       // override the merge-commit message / MERGE_MSG
  readonly author?: AuthorIdentity;
  readonly committer?: AuthorIdentity;
}

interface PullResult {
  readonly fetch: FetchResult;     // url, updatedRefs, prunedRefs, shallow, …
  readonly merge: MergeResult;     // up-to-date | fast-forward | merge | conflict
}
```

## Upstream resolution

`pull` reads the same tracking config `clone` writes:

- **remote** — `opts.remote` ?? `branch.<current>.remote` ?? the sole configured remote (only when exactly one `remote.*` block exists) ?? `'origin'`.
- **ref** — `opts.ref` ?? short form of `branch.<current>.merge`. When
  neither resolves (no upstream and no explicit ref, or a detached HEAD),
  pull throws `NO_UPSTREAM_CONFIGURED`.

After a normal `clone`, `branch.<default>.remote/merge` are set, so a no-argument
`repo.pull()` works on the cloned branch. A locally-created branch with no
upstream needs an explicit `repo.pull({ ref })`.

## Behaviour

| Outcome | `merge.kind` | Effect |
|---|---|---|
| Already current | `up-to-date` | No commit; reflog unchanged. |
| Behind upstream | `fast-forward` | Branch advances; reflog `pull: Fast-forward`. |
| Diverged, clean | `merge` | Two-parent commit `Merge branch '<branch>' of <url>`; reflog `pull: Merge made by the 'tsgit' strategy.`. |
| Diverged, clashing | `conflict` | `MERGE_HEAD`/`MERGE_MSG`/`ORIG_HEAD` + conflicted index written. |

The reflog action is `pull` (git-faithful), achieved via `merge`'s internal
reflog-action channel (the `GIT_REFLOG_ACTION` analogue), not a public option.

`pull` does **not** materialise the working tree on the fast-forward / clean
paths — it delegates integration to `merge`, inheriting its contract exactly.

## Examples

```ts
// Fetch + integrate the configured upstream.
const result = await repo.pull();
if (result.merge.kind === 'conflict') {
  // resolve the working-tree files, then:
  await repo.add(result.merge.conflicts.map((c) => c.path));
  await repo.merge.continue({ message: 'resolve pull' });
  // …or give up:
  // await repo.merge.abort();
}

// Pull a specific remote ref from a specific remote.
await repo.pull({ remote: 'upstream', ref: 'main' });
```

## Throws

- `NO_UPSTREAM_CONFIGURED` — no `branch` argument and no `branch.<current>.merge`
  (or a detached HEAD).
- `CONFIG_MISSING_VALUE` — `branch.<current>.remote` or `branch.<current>.merge` is
  present but valueless (git NULL); carries `{ key, source, line }`. Distinct from
  the absent case (`NO_UPSTREAM_CONFIGURED`).
- `REMOTE_NOT_CONFIGURED` — the resolved remote has no configured URL.
- `REF_NOT_FOUND` — the remote does not advertise the requested branch.
- `BARE_REPOSITORY` / `OPERATION_IN_PROGRESS` — refused before the fetch.
- `NON_FAST_FORWARD` — `fastForward: 'only'` and a true merge is required.

## See also

- Composed from: [`fetch`](fetch.md) + [`merge`](merge.md).
- Conflict resolution: [`merge.continue` / `merge.abort`](merge.md#state-machine--mergecontinue-and-mergeabort).
- ADRs: [196](../../adr/196-pull-strict-upstream-clone-writes-tracking.md), [197](../../adr/197-pull-oid-passthrough-merge-reflog-label.md), [198](../../adr/198-pull-omit-rebase-until-22-3.md), [199](../../adr/199-merge-resolve-target-gitrevisions-dwim.md), [456](../../adr/456-branch-remote-resolution-primitives.md), [457](../../adr/457-fetch-default-remote-canonical-git.md)
