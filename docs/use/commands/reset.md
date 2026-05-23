# `reset`

Move HEAD with `soft` / `mixed` / `hard` semantics. All three modes operate under `.git/index.lock` for atomicity.

## Signature

```ts
repo.reset(opts: ResetOptions): Promise<ResetResult>;

interface ResetOptions {
  readonly mode: 'soft' | 'mixed' | 'hard';
  readonly target: string;
}

interface ResetResult {
  readonly mode: 'soft' | 'mixed' | 'hard';
  readonly id: ObjectId;
}
```

## Modes

| Mode | Working tree | Index | HEAD |
|---|---|---|---|
| `soft` | untouched | untouched | moved to `target` |
| `mixed` | untouched | rebuilt from `target`'s tree (stat-cache preserved for unchanged paths) | moved to `target` |
| `hard` | rewritten to match `target` (force-overwriting modifications) | rebuilt | moved to `target` |

## Behaviour

- **Sparse-aware:** `mode: 'hard'` and `mode: 'mixed'` honour the active sparse pattern. Out-of-cone paths keep `skipWorktree: true`; their working-tree files are not materialised.
- **Stat-cache donor strategy** (mixed): index entries whose `id + mode` match the prior index preserve their stat fields, so the next `status()` stays fast.
- **Untracked files outside the target tree** are left alone in `hard` mode — only tracked paths are rewritten.

## Examples

```ts
// Undo the last commit; keep changes staged
await repo.reset({ mode: 'soft', target: 'HEAD~1' });

// Unstage everything; working tree intact
await repo.reset({ mode: 'mixed', target: 'HEAD' });

// Wipe local mods; restore to a known good commit
await repo.reset({ mode: 'hard', target: 'origin/main' });

// Abort a merge by going back to ORIG_HEAD
await repo.reset({ mode: 'hard', target: 'ORIG_HEAD' });
```

## Throws

- `BARE_REPOSITORY` — `hard` (or `mixed` writing the working tree) is not valid in a bare repository.
- `REF_NOT_FOUND` / `INVALID_REF` — `target` does not resolve.

## See also

- Primitives: [`materializeTree`](../primitives/internals.md#materializetree), [`buildIndexFromTree`](../primitives/internals.md#buildindexfromtree), [`recordRefUpdate`](../primitives/record-ref-update.md)
- Related commands: [`checkout`](checkout.md), [`merge`](merge.md), [`revParse`](rev-parse.md)
- ADRs: [021](../../adr/021-reset-mixed-stat-cache-donor.md), [022](../../adr/022-reset-mixed-pathspec-scope.md), [023](../../adr/023-reset-hard-index-stat-source.md), [075](../../adr/075-reset-sparse-integration.md)
- Roadmap: Phase 22 — pathspec scoping for `reset --mixed/--hard`
