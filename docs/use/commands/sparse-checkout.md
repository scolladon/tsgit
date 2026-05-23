# `sparseCheckout`

Materialise a subset of the tracked tree into the working tree. Excluded files stay in the index (marked `skip-worktree` via index v3) so `commit` still records the whole tree and `status` does not report the absences as deletions.

## Signature

```ts
repo.sparseCheckout(action: SparseCheckoutAction): Promise<SparseCheckoutResult>;

type SparseCheckoutAction =
  | { action: 'list' }
  | { action: 'set'; patterns: ReadonlyArray<string>; cone?: boolean; force?: boolean }
  | { action: 'add'; patterns: ReadonlyArray<string>; force?: boolean }
  | { action: 'reapply'; force?: boolean }
  | { action: 'disable'; force?: boolean };
```

## Actions

| Action | Meaning |
|---|---|
| `list` | Return the active patterns and the mode (`cone` vs non-cone). |
| `set` | Replace patterns. `cone: false` switches to non-cone (`.gitignore`-style); default is cone (directory list, O(1) membership). |
| `add` | Widen the cone with more directories. |
| `reapply` | Re-run materialisation against the on-disk patterns (e.g. after hand-editing `.git/info/sparse-checkout`). |
| `disable` | Turn sparse off; restore every file. |

## Behaviour

- **Cone mode** (default): patterns are directory paths. O(1) membership test. Matches git's modern default.
- **Non-cone mode**: `.gitignore`-style patterns, last-match wins.
- **`core.sparseCheckout` / `core.sparseCheckoutCone`** are written to `.git/config`.
- **Dirty out-of-cone files are retained**, not discarded, unless `force: true`.
- **`checkout` honours the cone on branch switch.** `reset --hard` / `--mixed` and the conflicting-`merge` path also respect the cone.

## Examples

```ts
// Restrict the working tree to two directories (cone mode)
const applied = await repo.sparseCheckout({ action: 'set', patterns: ['src/app', 'docs'] });
console.log(applied.materialized, applied.removed);

// Widen
await repo.sparseCheckout({ action: 'add', patterns: ['src/lib'] });

// Inspect
const { cone, patterns } = await repo.sparseCheckout({ action: 'list' });

// Re-apply after a manual edit, or disable entirely
await repo.sparseCheckout({ action: 'reapply' });
await repo.sparseCheckout({ action: 'disable' });
```

## Throws

- `SPARSE_DIRTY_OUT_OF_CONE` — `set` / `add` would discard a dirty out-of-cone file and `force` is not set.
- `INVALID_OPTION` — empty pattern list, or `cone: true` with a non-cone-compatible pattern.

## See also

- Primitives: [`loadSparseMatcher`](../primitives/internals.md#loadsparsematcher), [`readSparsePatternText`](../primitives/internals.md#readsparsepatterntext), [`writeSparsePatternText`](../primitives/internals.md#writesparsepatterntext), [`materializeTree`](../primitives/internals.md#materializetree)
- Related commands: [`checkout`](checkout.md), [`reset`](reset.md), [`status`](status.md)
- ADRs: [069](../../adr/069-skip-worktree-index-v3.md), [070](../../adr/070-cone-and-non-cone.md), [071](../../adr/071-sparse-command-shape.md), [072](../../adr/072-sparse-dirty-file-policy.md), [073](../../adr/073-sparse-integration-scope.md), [074](../../adr/074-minimal-config-writer.md), [077](../../adr/077-linear-glob-matcher.md)
