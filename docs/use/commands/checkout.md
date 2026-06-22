# `checkout`

Switch branches or restore working-tree files from a tree-ish or the index. Two modes, selected by the option shape.

## Signature

```ts
repo.checkout(opts: CheckoutOptions): Promise<CheckoutResult>;

type CheckoutOptions = CheckoutSwitchOptions | CheckoutPathsOptions;

interface CheckoutSwitchOptions {
  readonly rev: string;
  readonly force?: boolean;
}

interface CheckoutPathsOptions {
  readonly paths: ReadonlyArray<string>;
  readonly source?: 'index' | 'HEAD' | ObjectId;
}
```

## Modes

| Mode | Triggered by | Effect |
|---|---|---|
| **Switch** | `{ rev }` | Materialise `rev`'s tree onto the working tree, commit a new index, move HEAD. Atomic per-file. |
| **Restore from index** (default) | `{ paths }` (no `source` or `source: 'index'`) | Restore staged content into the working tree. Index untouched. |
| **Restore from HEAD or tree** | `{ paths, source: 'HEAD' \| <ObjectId> }` | Restore content from HEAD's tree (or an arbitrary tree). Index entries for the listed paths are also rewritten. |

## Behaviour

- **Dirty-tree guard.** Switch mode refuses to overwrite tracked modifications or to clobber untracked paths that would collide. Use `force: true` to override.
- **Atomicity.** Per-file (matches canonical git). The index commit is atomic; working-tree writes are not all-or-nothing if power is cut mid-write.
- **Sparse checkout.** Switch mode honours the active sparse pattern on the target branch.
- **Path restore via globs.** `paths` accepts the same pathspec syntax as [`add`](add.md).

## Examples

```ts
// Switch branches (or to any commit)
await repo.checkout({ rev: 'main' });
await repo.checkout({ rev: '<oid>' });

// Restore a file from the index
await repo.checkout({ paths: ['src/foo.ts'] });

// Restore a file from HEAD's tree
await repo.checkout({ paths: ['src/foo.ts'], source: 'HEAD' });

// Force-switch through a dirty tree
await repo.checkout({ rev: 'main', force: true });
```

## Throws

- `CHECKOUT_OVERWRITE_DIRTY` — switch without `force` against a dirty working tree.
- `REF_NOT_FOUND` / `INVALID_REF` — `rev` does not resolve.
- `PATHSPEC_NO_MATCH` — a literal path pattern matched nothing.
- `BARE_REPOSITORY` — checkout is not valid in a bare repository.

## Smudge filter drivers (`filter=<name>`)

When a path carries a `filter=<name>` attribute in `.gitattributes` and
`[filter "<name>"].smudge` is configured, `checkout` runs the smudge command over
the committed blob bytes before writing to the working tree — the file on disk
holds the **smudged** content.

- **Smudge is a stdin → stdout transform.** The blob bytes are fed to the
  command's stdin; the captured stdout is written to the working tree file.
- **Symlinks and gitlinks are not smudged.** Only regular-file content is
  passed through the smudge command, as git does.
- **Clean-only (no smudge key) ⇒ identity smudge.** If `[filter "<name>"].clean`
  is set but `smudge` is absent, the blob bytes are written verbatim — the file
  on disk is identical to the committed bytes.
- **`required` failure semantics.** If the smudge command exits non-zero:
  - `filter.<name>.required = true` — the checkout is **refused**: `checkout`
    throws `SMUDGE_FILTER_FAILED` (`{ path, filter, exitCode }`). The file is not
    written to the working tree.
  - `required` absent or `false` — the failure is a warning; raw blob bytes are
    written and `checkout` succeeds (git's fallback behaviour).
- **Named-but-unconfigured driver.** If `filter=<name>` is set but no `[filter
  "<name>"]` section (or no `smudge` key) exists in the config, blob bytes are
  written verbatim — identity smudge.
- **Independent of `diff=`.** Clean/smudge and textconv are orthogonal. A path
  with `filter=<name>` only is diffed against raw committed bytes; textconv only
  applies to paths carrying `diff=<name>`.

**Node.** The smudge command runs through the `CommandRunner` port (same trust
model as merge drivers and hooks). In the browser / memory adapters, or in Node
with `openRepository({ command: false })`, no driver is wired and blob bytes are
written raw (identity smudge). See the [RUNBOOK](../../../RUNBOOK.md) "Operating filter
and textconv drivers" section.

## See also

- Primitives: [`materializeTree`](../primitives/internals.md#materializetree), [`buildIndexFromTree`](../primitives/internals.md#buildindexfromtree), [`synthesizeTreeFromIndex`](../primitives/internals.md#synthesizetreefromindex), [`readIndex`](../primitives/read-index.md)
- Related commands: [`reset`](reset.md), [`add`](add.md), [`rm`](rm.md), [`sparseCheckout`](sparse-checkout.md)
- Recipes: [clone + checkout](../recipes.md#clone-and-checkout)
- ADRs: [018](../../adr/018-checkout-atomicity-model.md), [019](../../adr/019-checkout-dirty-tree-guard.md), [020](../../adr/020-checkout-paths-api-shape.md)
