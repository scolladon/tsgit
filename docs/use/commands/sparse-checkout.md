# `sparseCheckout`

Materialise a subset of the tracked tree into the working tree. Excluded files stay in the index (marked `skip-worktree` via index v3) so `commit` still records the whole tree and `status` does not report the absences as deletions.

## Signature

```ts
interface SparseCheckoutListResult {
  readonly cone: boolean;
  readonly patterns: ReadonlyArray<string>;
}
interface SparseCheckoutAppliedResult {
  readonly cone: boolean;
  readonly materialized: number;
  readonly removed: number;
  readonly retained: ReadonlyArray<FilePath>;
}

interface SparseCheckoutNamespace {
  list(): Promise<SparseCheckoutListResult>;
  set(input: {
    patterns: ReadonlyArray<string>;
    cone?: boolean;
    force?: boolean;
  }): Promise<SparseCheckoutAppliedResult>;
  add(input: { patterns: ReadonlyArray<string>; force?: boolean }): Promise<SparseCheckoutAppliedResult>;
  reapply(input?: { force?: boolean }): Promise<SparseCheckoutAppliedResult>;
  disable(input?: { force?: boolean }): Promise<SparseCheckoutAppliedResult>;
}

repo.sparseCheckout: SparseCheckoutNamespace;
```

The four mutating methods share `SparseCheckoutAppliedResult`; `list` returns the pattern view. No discriminator to narrow on at the call site (ADR-181, ADR-192).

## Methods

| Method | Meaning |
|---|---|
| `list()` | Return the active patterns and the mode (`cone` vs non-cone). |
| `set({ patterns, cone?, force? })` | Replace patterns. `cone: false` switches to non-cone (`.gitignore`-style); default is cone (directory list, O(1) membership). |
| `add({ patterns, force? })` | Widen the cone with more directories. |
| `reapply({ force? }?)` | Re-run materialisation against the on-disk patterns (e.g. after hand-editing `.git/info/sparse-checkout`). |
| `disable({ force? }?)` | Turn sparse off; restore every file. |

## Behaviour

- **Cone mode** (default): patterns are directory paths. O(1) membership test. Matches git's modern default.
- **Non-cone mode**: `.gitignore`-style patterns, last-match wins.
- **`core.sparseCheckout` / `core.sparseCheckoutCone`** are written to `.git/config`.
- **Dirty out-of-cone files are retained**, not discarded, unless `force: true`.
- **`checkout` honours the cone on branch switch.** `reset --hard` / `--mixed` and the conflicting-`merge` path also respect the cone.

## Examples

```ts
// Restrict the working tree to two directories (cone mode)
const applied = await repo.sparseCheckout.set({ patterns: ['src/app', 'docs'] });
console.log(applied.materialized, applied.removed);

// Widen
await repo.sparseCheckout.add({ patterns: ['src/lib'] });

// Inspect
const { cone, patterns } = await repo.sparseCheckout.list();

// Re-apply after a manual edit, or disable entirely
await repo.sparseCheckout.reapply();
await repo.sparseCheckout.disable();
```

## Throws

- `WORKING_TREE_DIRTY` — `set` / `add` would discard a dirty out-of-cone file and `force` is not set.
- `INVALID_OPTION` — empty pattern list, or `cone: true` with a non-cone-compatible pattern.
- `SPARSE_PATTERN_FILE_TOO_LARGE` — `.git/info/sparse-checkout` exceeds the size cap.

## See also

- Primitives: [`loadSparseMatcher`](../primitives/internals.md#loadsparsematcher), [`readSparsePatternText`](../primitives/internals.md#readsparsepatterntext), [`writeSparsePatternText`](../primitives/internals.md#writesparsepatterntext), [`materializeTree`](../primitives/internals.md#materializetree)
- Related commands: [`checkout`](checkout.md), [`reset`](reset.md), [`status`](status.md)
- ADRs: [181](../../adr/181-nested-namespace-porcelain.md), [192](../../adr/192-crud-namespace-per-verb-results.md), [193](../../adr/193-no-transition-shim-hard-remove-callable.md) (namespace shape) · [069](../../adr/069-skip-worktree-index-v3.md), [070](../../adr/070-cone-and-non-cone.md), [071](../../adr/071-sparse-command-shape.md), [072](../../adr/072-sparse-dirty-file-policy.md), [073](../../adr/073-sparse-integration-scope.md), [074](../../adr/074-minimal-config-writer.md), [077](../../adr/077-linear-glob-matcher.md)
