# Commands — Tier-1 reference

Every method bound on a `Repository` handle. 29 entries, alphabetical.

| Command | Summary |
|---|---|
| [`abortMerge`](abort-merge.md) | End an in-progress merge by hard-resetting HEAD/index/workdir to `ORIG_HEAD` and clearing merge state. |
| [`add`](add.md) | Stage paths into `.git/index`. Literal paths or `all: true` bulk mode. |
| [`branch`](branch.md) | List, create, or delete branches. |
| [`catFile`](cat-file.md) | Batch read of git objects in strict input order. |
| [`checkout`](checkout.md) | Switch branches or restore working-tree files. |
| [`cherryPick`](cherry-pick.md) | Apply commits onto HEAD as new single-parent commits (single + `A..B` range), preserving author/message, with a git-faithful resumable sequencer. Nested-namespace surface (`repo.cherryPick.run/continue/skip/abort`). |
| [`clone`](clone.md) | Clone a remote repository over smart-HTTP (full / shallow / partial). |
| [`commit`](commit.md) | Create a commit from the current index. |
| [`config`](config.md) | Read and write git config across all four scopes (`system`/`global`/`local`/`worktree`). Nested-namespace surface (`repo.config.get/set/...`). |
| [`continueMerge`](continue-merge.md) | Finalise an in-progress merge as a two-parent commit (delegates to `commit`). |
| [`diff`](diff.md) | Compare two tree-like targets; returns a `TreeDiff` object. |
| [`fetch`](fetch.md) | Fetch refs and objects from a remote. |
| [`fetchMissing`](fetch-missing.md) | Prefetch promisor-remote objects in batch (partial clone). |
| [`init`](init.md) | Initialize a fresh repository. |
| [`log`](log.md) | Walk first-parent commit history. |
| [`merge`](merge.md) | Three-way merge with conflict materialisation. |
| [`mv`](mv.md) | Rename/move tracked paths in the index and working tree. |
| [`pull`](pull.md) | Fetch a remote branch and merge it into the current branch. |
| [`push`](push.md) | Push refs and objects to a remote. |
| [`reflog`](reflog.md) | Show, query, delete, or expire reflog entries. |
| [`remote`](remote.md) | CRUD porcelain for `[remote "<name>"]` config + tracking refs. |
| [`reset`](reset.md) | Move HEAD with `soft` / `mixed` / `hard` semantics. |
| [`revParse`](rev-parse.md) | Resolve revision expressions to `ObjectId`. |
| [`rm`](rm.md) | Remove files from the index (and optionally the working tree). |
| [`sparseCheckout`](sparse-checkout.md) | Materialise a subset of the tree (cone / non-cone). |
| [`stash`](stash.md) | Save working-tree + index changes on a stack and restore them later. |
| [`status`](status.md) | Compare working tree, index, and HEAD. |
| [`submodules`](submodules.md) | Walk submodules pinned at a tree-ish. |
| [`tag`](tag.md) | List, create, or delete tags. |

## Page shape

Every page follows the same shape — in this order:

1. `## Signature` — TypeScript signature lifted from source
2. `## Options` (or `## Actions` / `## Modes` for discriminated unions) — `Field \| Type \| Default \| Meaning` columns; `(required)` and `(none)` shown explicitly
3. `## Behaviour` — semantics worth narrating (when applicable; some pages skip)
4. `## Examples` (plural) — 2-4 minimal happy-path snippets, comments imperative
5. `## Throws` — error codes raised by this call; each cites the canonical `TsgitError.data.code` from [`../errors.md`](../errors.md)
6. `## See also` — bulleted: `Primitives:` · `Related commands:` · `Recipes:` · `ADRs:` · `Roadmap:`

For Tier-2 building blocks see [`../primitives/`](../primitives/). For composed flows see [`../recipes.md`](../recipes.md). For error codes see [`../errors.md`](../errors.md).
