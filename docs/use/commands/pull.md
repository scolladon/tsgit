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
  readonly ref?: string;           // refspec to fetch and merge (git pull <remote> <ref>); default: FETCH_HEAD's merge heads
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
- **what is merged** — the fetch runs first, as git's `pull` runs it: `opts.ref`
  is fetched as a command-line refspec (`git pull <remote> <ref>`), else the
  remote's configured refspecs run. Pull then merges what [`fetch`](fetch.md)
  marked for merging in `FETCH_HEAD` — `opts.ref`'s ref, else
  `branch.<current>.merge` when `branch.<current>.remote` names the remote
  (a merge without a remote is ignored, as git ignores it) — wherever the
  refspecs store it locally. When nothing is marked, pull refuses after the
  fetch with git's `die_no_merge_candidates` diagnosis: `PULL_NO_MERGE_CANDIDATES`
  or `NO_UPSTREAM_CONFIGURED`. Several refs marked (an octopus pull) are refused
  with `INVALID_OPTION`.

After a normal `clone`, `branch.<default>.remote/merge` are set, so a no-argument
`repo.pull()` works on the cloned branch. A locally-created branch with no
upstream needs an explicit `repo.pull({ ref })`.

## Behaviour

| Outcome | `merge.kind` | Effect |
|---|---|---|
| Already current | `up-to-date` | No commit; reflog unchanged. |
| Behind upstream | `fast-forward` | Branch advances; reflog `pull: Fast-forward`. |
| Diverged, clean | `merge` | Two-parent commit titled from the `FETCH_HEAD` line as git's `fmt_merge_msg` titles it — `Merge branch '<branch>' of <url>` (`tag`, `remote-tracking branch`, `commit '<ref>'`, or the url alone for a remote `HEAD`), the url shortened as `FETCH_HEAD` records it, then ` into <current>` unless the current branch is `main` or `master`; reflog `pull: Merge made by the 'tsgit' strategy.`. |
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

- `NO_UPSTREAM_CONFIGURED` — after the fetch, nothing to merge and no `ref`, on a
  detached HEAD or a branch with no `branch.<current>.merge` + `branch.<current>.remote`.
- `PULL_NO_MERGE_CANDIDATES` — after the fetch, nothing to merge: `ref` matched
  nothing (`reason: 'refspec-unmatched'`), an explicit `remote` other than the
  branch's upstream remote and no `ref` (`'not-default-remote'`), or the configured
  `branch.<current>.merge` was not fetched (`'merge-ref-not-fetched'`, with `ref`).
- `CONFIG_MISSING_VALUE` — `branch.<current>.remote` or `branch.<current>.merge` is
  present but valueless (git NULL); carries `{ key, source, line }`. Distinct from
  the absent case (`NO_UPSTREAM_CONFIGURED`).
- `REMOTE_NOT_CONFIGURED` — the resolved remote has no configured URL.
- `REMOTE_REF_NOT_FOUND` — the remote does not advertise the requested `ref` (from the fetch).
- `FETCH_REJECTED` — the fetch rejected a ref update (a non-fast-forward or a moved tag under a refspec without `+`); raised after the fetch's other updates and `FETCH_HEAD`, before merging, carrying each rejected update.
- `INVALID_OPTION` — the fetch marked several refs for merging (an octopus pull).
- `WORK_TREE_REQUIRED` / `OPERATION_IN_PROGRESS` — refused before the fetch. `WORK_TREE_REQUIRED` fires when the repository has no work tree (bare, or opened without one).
- `NON_FAST_FORWARD` — `fastForward: 'only'` and a true merge is required.

## See also

- Composed from: [`fetch`](fetch.md) + [`merge`](merge.md).
- Conflict resolution: [`merge.continue` / `merge.abort`](merge.md#state-machine--mergecontinue-and-mergeabort).
- ADRs: [196](../../adr/196-pull-strict-upstream-clone-writes-tracking.md), [197](../../adr/197-pull-oid-passthrough-merge-reflog-label.md), [198](../../adr/198-pull-omit-rebase-until-22-3.md), [199](../../adr/199-merge-resolve-target-gitrevisions-dwim.md), [456](../../adr/456-branch-remote-resolution-primitives.md), [457](../../adr/457-fetch-default-remote-canonical-git.md)
