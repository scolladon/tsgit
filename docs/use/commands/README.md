# Commands — Tier-1 reference

Every method bound on a `Repository` handle. 21 entries, alphabetical.

| Command | Summary |
|---|---|
| [`add`](add.md) | Stage paths into `.git/index`. Literal paths or `all: true` bulk mode. |
| [`branch`](branch.md) | List, create, or delete branches. |
| [`catFile`](cat-file.md) | Batch read of git objects in strict input order. |
| [`checkout`](checkout.md) | Switch branches or restore working-tree files. |
| [`clone`](clone.md) | Clone a remote repository over smart-HTTP (full / shallow / partial). |
| [`commit`](commit.md) | Create a commit from the current index. |
| [`diff`](diff.md) | Compare two tree-like targets; returns a `TreeDiff` object. |
| [`fetch`](fetch.md) | Fetch refs and objects from a remote. |
| [`fetchMissing`](fetch-missing.md) | Prefetch promisor-remote objects in batch (partial clone). |
| [`init`](init.md) | Initialize a fresh repository. |
| [`log`](log.md) | Walk first-parent commit history. |
| [`merge`](merge.md) | Three-way merge with conflict materialisation. |
| [`push`](push.md) | Push refs and objects to a remote. |
| [`reflog`](reflog.md) | Show, query, delete, or expire reflog entries. |
| [`reset`](reset.md) | Move HEAD with `soft` / `mixed` / `hard` semantics. |
| [`revParse`](rev-parse.md) | Resolve revision expressions to `ObjectId`. |
| [`rm`](rm.md) | Remove files from the index (and optionally the working tree). |
| [`sparseCheckout`](sparse-checkout.md) | Materialise a subset of the tree (cone / non-cone). |
| [`status`](status.md) | Compare working tree, index, and HEAD. |
| [`submodules`](submodules.md) | Walk submodules pinned at a tree-ish. |
| [`tag`](tag.md) | List, create, or delete tags. |

Each page follows the same shape: signature · options · behaviour notes (when applicable) · examples · throws · see also.

For Tier-2 building blocks see [`../primitives/`](../primitives/). For composed flows see [`../recipes.md`](../recipes.md). For error codes see [`../errors.md`](../errors.md).
