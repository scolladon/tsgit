# `checkout`

Switch branches or restore working-tree files from a tree-ish or the index. Two modes, selected by the option shape.

## Signature

```ts
repo.checkout(opts: CheckoutOptions): Promise<CheckoutResult>;

type CheckoutOptions = CheckoutSwitchOptions | CheckoutPathsOptions;

interface CheckoutSwitchOptions {
  readonly rev: string;
  readonly detach?: boolean;
  readonly force?: boolean;
  readonly createBranch?: CheckoutCreateBranch;  // git's `checkout -b`
}

interface CheckoutCreateBranch {
  readonly name: string;
  readonly track?: BranchTrack;                  // `--track[=direct|inherit]`
  readonly noTrack?: boolean;                    // `--no-track`
}

interface CheckoutPathsOptions {
  readonly paths: ReadonlyArray<string>;
  readonly source?: 'index' | string;            // 'index', or a revision naming a commit or a tree
}
```

## Modes

| Mode | Triggered by | Effect |
|---|---|---|
| **Switch** | `{ rev }` | Materialise `rev`'s tree onto the working tree, commit a new index, move HEAD. Atomic per-file. |
| **Restore from index** (default) | `{ paths }` (no `source` or `source: 'index'`) | Restore staged content into the working tree. Takes `index.lock` and writes the index (restored entries' stat data refreshed), as git's `checkout_paths` does. |
| **Restore from a revision** | `{ paths, source: <revision> }` | Restore content from the tree of a commit or tree-ish: a branch or tag name, `HEAD`, an object id or an expression such as `HEAD~1`. Index entries for the listed paths are also rewritten. |
| **Create and switch** | `{ rev, createBranch }` | Create `createBranch.name` at `rev` (with `track` / `noTrack` as [`branch.create`](branch.md) takes them), then switch to it. Refuses `INVALID_OPTION` with `detach`, and `BRANCH_EXISTS` for a name already taken, before the work tree moves. |

## Behaviour

- **The branch lookup runs first, whatever `detach` says.** Switch mode reads `rev` as `refs/heads/<rev>` before anything else, the way git's own branch-argument parse does. A name a branch carries attaches HEAD to that branch — or checks out the same commit detached when `detach: true`. A name no branch carries goes down git's revision ladder instead and **detaches** HEAD onto what it finds: a full object id first, then the tag and remote-tracking namespaces in gitrevisions order, then an unambiguous abbreviated id. So `detach` decides only whether a *branch* name attaches; it no longer decides how `rev` is resolved, and a tag or a remote-tracking name checks out detached without it.
- **The reflog entry echoes the argument you passed.** `checkout: moving from <old> to <rev>` carries `rev` verbatim — the branch name, the tag, or the object id exactly as you spelled it — where it used to abbreviate an id to seven characters. git echoes the argument it was handed.
- **`-` is `@{-1}`.** A lone `-` as `rev` names the branch the previous switch left, and the reflog entry echoes it as spelt.
- **A switch target must peel to a commit.** A tag peels to the commit it names; a tree refuses `CHECKOUT_NON_COMMIT`. A `rev` no revision answers matches nothing as a pathspec (`PATHSPEC_NO_MATCH`), or, under `createBranch`, refuses `CHECKOUT_START_POINT_NOT_COMMIT`.
- **Dirty-tree guard.** Switch mode refuses to overwrite tracked modifications or to clobber untracked paths that would collide. Use `force: true` to override. The "is something already here?" probe does not follow symbolic links, so a **dangling** symlink at a target path counts as occupying it and refuses, rather than being silently replaced.
- **Writes never follow a symlink.** A write never goes through a symlink in its leading path: links are written first, and leading directories are created one component at a time. An add beyond an untracked symlink is refused naming the link.
- **Lossy entries stay off disk.** An entry whose name is not valid UTF-8 is never written or unlinked; it reads as deleted in [`status`](status.md), as git does on macOS.
- **Pruning.** Directories a checkout leaves empty are removed, as git does.
- **File and directory swaps.** A path may change between file and directory. A directory being replaced by a file lets ignored occupants go (with `force`, every occupant) and refuses untracked ones.
- **Atomicity.** Per-file (matches canonical git). The index commit is atomic; working-tree writes are not all-or-nothing if power is cut mid-write.
- **Sparse checkout.** Switch mode honours the active sparse pattern on the target branch.
- **Path restore takes the index lock.** Both path-restore sources lock the index first and refuse `RESOURCE_LOCKED` when it is held. Entries of other paths keep their conflict stages.
- **Path restore via globs.** `paths` accepts the same pathspec syntax as [`add`](add.md). Scope is matched on raw path bytes, so a literal never restores a lossy entry through its U+FFFD view.

## Examples

```ts
// Switch branches (or to any commit)
await repo.checkout({ rev: 'main' });
await repo.checkout({ rev: '<oid>' });

// Restore a file from the index
await repo.checkout({ paths: ['src/foo.ts'] });

// Restore a file from HEAD's tree
await repo.checkout({ paths: ['src/foo.ts'], source: 'HEAD' });

// Restore a file from another revision
await repo.checkout({ paths: ['src/foo.ts'], source: 'HEAD~1' });

// Create a branch at a start point and switch to it
await repo.checkout({ rev: 'origin/main', createBranch: { name: 'topic' } });

// Force-switch through a dirty tree
await repo.checkout({ rev: 'main', force: true });
```

## Throws

- `CHECKOUT_OVERWRITE_DIRTY` — switch without `force` against a dirty working tree.
- `CHECKOUT_NON_COMMIT` — switch mode where `rev` names a tree.
- `CHECKOUT_START_POINT_NOT_COMMIT` — `createBranch` whose start point names no revision; `revision` and `branch` carry both.
- `BRANCH_EXISTS` — `createBranch.name` is already a branch.
- `INVALID_OPTION` — `createBranch` combined with `detach`.
- `BRANCH_NOT_FOUND` — switch mode where `rev` names no branch and resolves to nothing on the revision ladder either; `name` carries `refs/heads/<rev>`, the branch git names in its own refusal.
- `INVALID_REF` — `rev` cannot be spelled as a ref name and does not resolve as an object id.
- `AMBIGUOUS_OID_PREFIX` — an abbreviated `rev` matches more than one object.
- `REF_NOT_FOUND` — HEAD itself does not resolve (an unborn branch).
- `PATHSPEC_NO_MATCH` — a literal path pattern matched nothing.
- `WORK_TREE_REQUIRED` — the repository has no work tree (bare, or opened without one).

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
- **A malformed `required` value throws.** `filter.<d>.required` set to a
  value git's boolean grammar refuses throws `CONFIG_BAD_BOOLEAN_VALUE` —
  checked across every `[filter "<d>"]` section whenever `checkout` writes a
  regular file's content, even a file whose own `filter=` attribute names a
  different, unaffected driver.

**Node.** The smudge command runs through the `CommandRunner` port (same trust
model as merge drivers and hooks). In the browser / memory adapters, or in Node
with `openRepository({ command: false })`, no driver is wired and blob bytes are
written raw (identity smudge). See the [RUNBOOK](../../../RUNBOOK.md) "Operating filter
and textconv drivers" section.

## See also

- Primitives: [`materializeTree`](../primitives/internals.md#materializetree), [`buildIndexFromTree`](../primitives/internals.md#buildindexfromtree), [`synthesizeTreeFromIndex`](../primitives/internals.md#synthesizetreefromindex), [`readIndex`](../primitives/read-index.md)
- Related commands: [`reset`](reset.md), [`add`](add.md), [`rm`](rm.md), [`sparseCheckout`](sparse-checkout.md)
- Recipes: [clone + checkout](../recipes.md#clone-and-checkout)
- ADRs: [018](../../adr/018-checkout-atomicity-model.md), [019](../../adr/019-checkout-dirty-tree-guard.md), [020](../../adr/020-checkout-paths-api-shape.md), [627](../../adr/627-boolean-config-values-are-refused-as-git-refuses-them.md)
