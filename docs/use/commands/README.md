# Commands — Tier-1 reference

Every method bound on a `Repository` handle. 35 entries, alphabetical.

| Command | Summary |
|---|---|
| [`add`](add.md) | Stage paths into `.git/index`. Literal paths or `all: true` bulk mode. |
| [`blame`](blame.md) | Line-by-line authorship for a file at a revision; returns structured per-line data (no rendered line). |
| [`branch`](branch.md) | List, create, or delete branches. |
| [`catFile`](cat-file.md) | Batch read of git objects in strict input order. |
| [`checkout`](checkout.md) | Switch branches or restore working-tree files. |
| [`cherryPick`](cherry-pick.md) | Apply commits onto HEAD as new single-parent commits (single + `A..B` range), preserving author/message, with a git-faithful resumable sequencer. Nested-namespace surface (`repo.cherryPick.run/continue/skip/abort`). |
| [`clone`](clone.md) | Clone a remote repository over smart-HTTP (full / shallow / partial). |
| [`commit`](commit.md) | Create a commit from the current index. |
| [`config`](config.md) | Read and write git config across all four scopes (`system`/`global`/`local`/`worktree`). Nested-namespace surface (`repo.config.get/set/...`). |
| [`describe`](describe.md) | Name a commit by its nearest reachable tag; returns structured data (no rendered line). |
| [`diff`](diff.md) | Compare two tree-like targets; returns a `TreeDiff` object. |
| [`fetch`](fetch.md) | Fetch refs and objects from a remote. |
| [`fetchMissing`](fetch-missing.md) | Prefetch promisor-remote objects in batch (partial clone). |
| [`init`](init.md) | Initialize a fresh repository. |
| [`log`](log.md) | Walk first-parent commit history. |
| [`merge`](merge.md) | Three-way merge with conflict materialisation. Nested-namespace surface (`repo.merge.run/continue/abort`). |
| [`mv`](mv.md) | Rename/move tracked paths in the index and working tree. |
| [`pull`](pull.md) | Fetch a remote branch and merge it into the current branch. |
| [`push`](push.md) | Push refs and objects to a remote. |
| [`rangeDiff`](range-diff.md) | Compare two commit ranges (two versions of a patch series); returns the structured correspondence list (`= ! < >`) with a per-changed-pair diff-of-diffs (no rendered line). |
| [`readFileAt`](read-file-at.md) | Read a file's bytes as of a revision (`git show <rev>:<path>`); returns structured `{ id, mode, content }` (no rendered output). |
| [`rebase`](rebase.md) | Replay the current branch's commits onto another base (non-interactive), preserving authors, dropping cherry-pick equivalents, with a git-faithful resumable `.git/rebase-merge/` state. Nested-namespace surface (`repo.rebase.run/continue/skip/abort`). |
| [`reflog`](reflog.md) | Show, query, delete, or expire reflog entries. |
| [`remote`](remote.md) | CRUD porcelain for `[remote "<name>"]` config + tracking refs. |
| [`reset`](reset.md) | Move HEAD with `soft` / `mixed` / `hard` semantics. |
| [`revParse`](rev-parse.md) | Resolve revision expressions to `ObjectId`. |
| [`revert`](revert.md) | Record new commits that undo earlier commits (inverse of cherry-pick). |
| [`rm`](rm.md) | Remove files from the index (and optionally the working tree). |
| [`shortlog`](shortlog.md) | Summarise reachable commits grouped by author/committer identity; returns structured per-author groups (no rendered line). |
| [`show`](show.md) | Formatted output for commit / tag / tree / blob objects. |
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
