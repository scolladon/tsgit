# Internal building blocks

Internal building blocks that power the Tier-1 commands. Most are exported from `@scolladon/tsgit/primitives` for advanced composition (but **not** bound on `repo.primitives.*`); a few are **fully internal** — reachable only by the commands themselves — and are listed here to document how the porcelain works, not as a public surface. Each entry names the source file under `src/application/primitives/`; that file is the canonical reference for the signature.

Alphabetical.

### `applyChangeset`
`apply-changeset.ts`. Apply a computed working-tree changeset (writes, deletes, chmods). Used by [`checkout`](../commands/checkout.md) and [`reset`](../commands/reset.md) (`hard`).

### `buildIndexFromTree`
`build-index-from-tree.ts`. Project a tree to a stage-0 IndexEntry list with stat-cache donor preservation. Used by [`reset`](../commands/reset.md) (`mixed`), [`checkout`](../commands/checkout.md).

### `buildPack`
`build-pack.ts`. Construct a packfile from an enumerated object set. Used by [`push`](../commands/push.md).

### `computeChangeset`
`compute-changeset.ts`. Tree-vs-working-tree diff for the dirty-tree guard. Used by [`checkout`](../commands/checkout.md), [`reset`](../commands/reset.md), [`status`](../commands/status.md).

### `enumerateObjects`
`enumerate-objects.ts`. Enumerate every object id in the database (loose ∪ pack-index), sorted and de-duplicated. Used by [`fsck`](../commands/fsck.md).

### `enumeratePushObjects`
`enumerate-push-objects.ts`. Diff local vs remote heads to compute the push-pack object set. Used by [`push`](../commands/push.md).

### `enumerateRefs`
`enumerate-refs.ts`. List every ref (loose + packed). Used by [`branch`](../commands/branch.md), [`tag`](../commands/tag.md), [`fetch`](../commands/fetch.md).

### `fetchPack`
`fetch-pack.ts`. Smart-HTTP `git-upload-pack` exchange — discover refs, send `want`/`have`, receive pack. Used by [`clone`](../commands/clone.md), [`fetch`](../commands/fetch.md), [`fetchMissing`](../commands/fetch-missing.md).

### `invalidateConfigCache`
`config-read.ts`. Drop the in-memory `.git/config` cache. Use after an out-of-band edit.

### `isWorkingTreeDirty`
`apply-changeset.ts`. Predicate over a computed changeset. Used by [`checkout`](../commands/checkout.md)'s dirty-tree guard.

### `loadSparseMatcher`
`read-sparse-checkout.ts`. Compile `.git/info/sparse-checkout` to a `(path) => boolean` matcher. Used by [`sparseCheckout`](../commands/sparse-checkout.md), [`checkout`](../commands/checkout.md), [`reset`](../commands/reset.md).

### `materializeTree`
`materialize-tree.ts`. Apply a tree to the working tree (writes, deletes, chmods, symlinks). Used by [`checkout`](../commands/checkout.md), [`reset`](../commands/reset.md) (`hard`), [`merge`](../commands/merge.md) clean path.

### `readConfig`
`config-read.ts`. Read `.git/config` (INI tokenizer; reused by `.gitmodules` parsing in submodules).

### `recordRefUpdate`
`record-ref-update.ts`. **Fully internal.** The single reflog *writer*: reads config, applies the autocreate gate, resolves identity, sanitises the message, appends one entry. It moves no ref — [`updateRef`](update-ref.md) is the coherent public surface that writes the ref *and* records the matching reflog atomically. Used internally by [`clone`](../commands/clone.md), [`checkout`](../commands/checkout.md), [`commit`](../commands/commit.md), [`rebase`](../commands/rebase.md), and `updateRef`.

### `writeSymbolicRef`
`write-symbolic-ref.ts`. **Fully internal.** Write a `ref: <target>` symbolic ref (HEAD and friends) atomically, validating both names. Used internally by [`init`](../commands/init.md), [`checkout`](../commands/checkout.md), [`branch`](../commands/branch.md), [`rebase`](../commands/rebase.md) to set or move HEAD's symbolic pointer.

### `appendReflog`
`reflog-store.ts`. Append one entry to `.git/logs/<ref>`. Called via `recordRefUpdate`.

### `deleteReflog`
`reflog-store.ts`. Drop one entry by index, optionally rewriting subsequent entries.

### `listReflogs`
`reflog-store.ts`. Enumerate refs that have a reflog.

### `readReflog`
`reflog-store.ts`. Read entries for one ref.

### `readShallow`
`shallow-file.ts`. Read `.git/shallow` boundaries.

### `readSparsePatternText`
`read-sparse-checkout.ts`. Read raw `.git/info/sparse-checkout` text (no compilation).

### `reflogExists`
`reflog-store.ts`. Predicate over `.git/logs/<ref>`.

### `resolveReflogIdentity`
`reflog-identity.ts`. Resolve the identity for reflog entries (config + portable fallback).

### `writeReflog`
`reflog-store.ts`. Bulk write entries for one ref (used by `expire`).

### `setConfigEntry` · `setCoreConfigEntry` · `updateConfigEntries` · `updateCoreConfig`
`update-config.ts`. Targeted line-surgery writers for `.git/config`. Used by [`clone`](../commands/clone.md) (promisor + partial-clone config), [`sparseCheckout`](../commands/sparse-checkout.md).

### `sparseCheckoutPath`
`path-layout.ts`. Canonical path for `.git/info/sparse-checkout`.

### `synthesizeTreeFromIndex`
`synthesize-tree-from-index.ts`. Inverse of `buildIndexFromTree` — synthesize a tree from staged entries. Used by [`checkout`](../commands/checkout.md) (`{ paths, source: 'index' }`).

### `updateShallow`
`shallow-file.ts`. Write `.git/shallow` boundaries.

### `writeSparsePatternText`
`write-sparse-checkout.ts`. Write raw `.git/info/sparse-checkout` text.
