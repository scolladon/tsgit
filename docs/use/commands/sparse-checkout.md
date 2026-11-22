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
| `list()` | Return the active patterns and the mode (`cone` vs non-cone). Refuses on a worktree that is not sparse, as git does. |
| `set({ patterns, cone?, force? })` | Replace patterns. `cone: false` switches to non-cone (`.gitignore`-style); `cone: true` selects cone (directory list, O(1) membership). Without `cone`, the current mode is kept when sparse is on, else cone. |
| `add({ patterns, force? })` | Widen the cone with more directories. Writes no config. |
| `reapply({ force? }?)` | Writes no config. Re-run materialisation against the on-disk patterns (e.g. after hand-editing `.git/info/sparse-checkout`). |
| `disable({ force? }?)` | Turn sparse off in `config.worktree`; restore every file. |

## Behaviour

- **Cone mode** (default): patterns are directory paths. O(1) membership test. Matches git's modern default.
- **Non-cone mode**: `.gitignore`-style patterns, last-match wins.
- **Writes go to the worktree config.** `core.sparseCheckout` / `core.sparseCheckoutCone` are written to the current worktree's `<gitDir>/config.worktree`, after `extensions.worktreeConfig = true` is set in the common config. Turning the scope on also moves a local `core.bare = true`, then a local `core.worktree`, into the main worktree's `<commonDir>/config.worktree`. A key set more than once in the local file makes `set` / `disable` refuse with `CONFIG_MULTIPLE_VALUES`.
- **Patterns fold case under `core.ignorecase`.** With `core.ignorecase = true` the patterns match ASCII case-insensitively, for every consumer of the matcher (`sparseCheckout`, `checkout`, `merge`, `cherryPick`, `revert`, `rebase`, `stash`, `reset`).
- **Non-cone patterns are judged level by level, as git does.** A directory-only rule (`dir/`) matches only a directory, and a path no rule decides inherits its nearest decided directory. A checked-out gitlink, or a directory standing at a tracked file's path, counts as a directory. `set` and `add` honour `core.ignorecase` when they apply the patterns, as `reapply` does.
- **An absent in-pattern file stays absent.** `reapply`, `set`, `add` and `disable` write only an entry they re-include (one that was skip-worktree); a tracked in-pattern file missing from the work tree is not recreated.
- **Reads resolve per key.** Each of the two keys is read from the local config, then from `config.worktree` (last entry wins); the worktree file is read only when the extension is on. Each linked worktree is independent.
- **`set` without `cone`** keeps the current mode when sparse is already on (and writes no config), else uses cone. `set` records its config before updating the work tree, so a refused update (e.g. a locked index) leaves the config written and no pattern file, as git does.
- **`add` and `reapply` write no config.** Non-cone `add` rewrites the pattern file from the existing patterns as git reads them: comments and empty lines dropped, unescaped trailing spaces trimmed, a whitespace-only line kept as an empty pattern. Each pattern ends in a newline. Non-cone `list` returns the patterns trimmed the same way.
- **`disable` writes** `core.sparseCheckout = false`, `core.sparseCheckoutCone = false` and `index.sparse = false` to `config.worktree`; the local file is left as it is.
- **`sparse.expectFilesOutsideOfPatterns`.** Read from the local config and, when `extensions.worktreeConfig` is on, from `config.worktree` (which wins). At its default (`false`) every index read clears the skip-worktree bit of an entry whose path is present on disk, in memory only; see [`readIndex`](../primitives/read-index.md). When `true` the bits are read as stored.
- **A bad boolean refuses.** A value outside git's boolean grammar for either key in `config.worktree` refuses every operational command with `CONFIG_BAD_BOOLEAN_VALUE`, after a bad local value.
- **Dirty out-of-cone files are retained**, not discarded, unless `force: true`.
- **The dirty check converts first.** The narrowing pre-scan compares the on-disk file with its index blob through the check-in conversion (`core.autocrlf`, `core.eol`, `text`/`eol`/`ident`, clean filter), so a CRLF-checked-out file that converts back to its blob is not dirty and is removed without `force`.
- **Re-inclusion keeps an occupant.** A re-included entry with anything at its path (a dangling symlink counts), or a regular file or symlink in a leading path, is not written and the occupant stays; its skip-worktree bit is cleared. For the leading-path case one warning is logged through the logger, listing the obstructing components, as git's "already present and thus not updated despite sparse patterns" does.
- **Narrowing removes a tracked dangling symlink.** The presence probe does not follow symlinks, so an excluded tracked entry whose link dangles is removed.
- **Materialised files are converted.** Files written back into the cone go through the checkout conversion (LF to CRLF, `ident`, smudge), reading attributes from the stage-0 index entries first, then the worktree.
- **`checkout` honours the cone on branch switch.** `reset --hard` / `--mixed` and the conflicting-`merge` path also respect the cone. `merge` fast-forward and clean three-way merges honour it too: out-of-pattern paths are recorded skip-worktree and left off disk. `pull` fast-forward already did.

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
- `INVALID_OPTION` (`option: 'action'`) — `list`, `add` or `reapply` on a worktree whose resolved `core.sparseCheckout` is off (git: `this worktree is not sparse`).
- `SPARSE_PATTERN_FILE_TOO_LARGE` — `.git/info/sparse-checkout` exceeds the size cap.
- `CONFIG_BAD_BOOLEAN_VALUE` — a malformed `core.sparseCheckout` / `core.sparseCheckoutCone`, in the local config or in `config.worktree`; also a malformed `sparse.expectFilesOutsideOfPatterns`, which every operational command refuses even with sparse checkout off.
- `CONFIG_MULTIPLE_VALUES` — `set` / `disable` while turning the worktree scope on, when the local file holds `core.bare` or `core.worktree` more than once.
- `CONFIG_BAD_NUMERIC_VALUE` — a malformed `core.maxTreeDepth` / `core.deltaBaseCacheLimit` (the repo-settings class), checked right after the operational gate and **before** the work-tree check, transcribing git's own per-builtin prologue — so a bare repository with a malformed value reports this rather than `WORK_TREE_REQUIRED`. See [`internals.md`](../primitives/internals.md#assertreposettingsvalid).

## See also

- Primitives: [`loadSparseMatcher`](../primitives/internals.md#loadsparsematcher), [`readSparsePatternText`](../primitives/internals.md#readsparsepatterntext), [`writeSparsePatternText`](../primitives/internals.md#writesparsepatterntext), [`materializeTree`](../primitives/internals.md#materializetree)
- Related commands: [`checkout`](checkout.md), [`reset`](reset.md), [`status`](status.md)
- ADRs: [181](../../adr/181-nested-namespace-porcelain.md), [192](../../adr/192-crud-namespace-per-verb-results.md), [193](../../adr/193-no-transition-shim-hard-remove-callable.md) (namespace shape) · [069](../../adr/069-skip-worktree-index-v3.md), [070](../../adr/070-cone-and-non-cone.md), [071](../../adr/071-sparse-command-shape.md), [072](../../adr/072-sparse-dirty-file-policy.md), [073](../../adr/073-sparse-integration-scope.md), [074](../../adr/074-minimal-config-writer.md) (superseded for the target file by 1188), [077](../../adr/077-linear-glob-matcher.md) · [1184](../../adr/1184-sparse-keys-are-read-from-the-worktree-config-layer.md), [1185](../../adr/1185-the-worktree-sparse-boolean-check-runs-after-the-local-gate.md), [1186](../../adr/1186-the-gate-checks-only-the-sparse-keys-in-the-worktree-file.md), [1187](../../adr/1187-a-scoped-config-write-keeps-the-key-casing.md), [1188](../../adr/1188-sparse-checkout-writes-its-keys-to-the-worktree-config.md), [1189](../../adr/1189-a-non-cone-pattern-file-ends-each-pattern-with-a-newline.md), [1190](../../adr/1190-sparse-checkout-list-refuses-a-worktree-that-is-not-sparse.md)
