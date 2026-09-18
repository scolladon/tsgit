# `branch`

List, create, delete, or rename branches via the `repo.branch.{list,create,delete,rename}` nested namespace.

## Signature

```ts
interface BranchInfo {
  readonly name: RefName;
  readonly id: ObjectId;
  readonly current: boolean;
}

interface BranchNamespace {
  list(): Promise<{ branches: ReadonlyArray<BranchInfo> }>;
  create(input: { name: string; startPoint?: string; force?: boolean }): Promise<{
    name: RefName;
    id: ObjectId;
  }>;
  delete(input: { name: string; force?: boolean }): Promise<{ name: RefName }>;
  rename(input: { from: string; to: string; force?: boolean }): Promise<{
    from: RefName;
    to: RefName;
  }>;
}

repo.branch: BranchNamespace;
```

Each method returns a concrete result — no discriminator to narrow on at the call site (ADR-181, ADR-192).

## Methods

| Method | Meaning |
|---|---|
| `list()` | List local branches (`refs/heads/*`), sorted by name; `current` flags the checked-out branch. |
| `create({ name, startPoint?, force? })` | Create a branch. `startPoint` defaults to HEAD; `force` overwrites an existing branch with the same name. |
| `delete({ name, force? })` | Delete a local branch. |
| `rename({ from, to, force? })` | Rename a branch, moving its reflog; updates HEAD when the renamed branch is checked out. `force` overrides an existing `to`. |

## Behaviour

- **`create` refuses a start point that does not peel to a commit.** `startPoint` is resolved and, when it is a ref or an annotated tag, peeled through the tag chain; the resulting object is then typed — a tree or blob (by full oid, abbreviated oid, lightweight tag, or annotated tag pointing at one) throws `UNEXPECTED_OBJECT_TYPE` with `expected: 'commit'` and **nothing is written**. An annotated tag over a commit is accepted and peeled — the branch lands on the commit, never on the tag object. The existing-name check (`BRANCH_EXISTS`, unless `force`) runs **before** the start point resolves, so `create({ name: '<existing>', startPoint: 'nope' })` reports `BRANCH_EXISTS`, not `BRANCH_NOT_FOUND`. See [errors](../errors.md#refs-reflog-revparse) and [ADR-860](../../adr/860-branch-create-verifies-its-start-point-is-a-commit.md) / [ADR-861](../../adr/861-the-non-commit-branch-point-refusal-reuses-unexpected-object-type.md). Known divergence: annotated-tag chains are capped at a depth of 5 (the repo-wide peel-depth limit) — a legitimate 6-deep chain git accepts is refused here.
- **`create` on an unborn HEAD names the current branch.** With no `startPoint`, the start point is HEAD; when no commit backs it the refusal is `BRANCH_NOT_FOUND` carrying the current branch's short name, matching git's `fatal: not a valid object name: '<branch>'`. An explicit `startPoint` that does not resolve is reported verbatim instead.
- **A symbolic ref is deleted as itself.** `delete` on a name that holds a symbolic ref removes that ref and leaves its target alone — git's `--no-deref` on this delete. A forced `create` goes the other way and moves the symref's **target**, keeping the symref in place; the reflog message it writes is `branch: Reset to <start point>` when the name resolves, and `branch: Created from <start point>` when it is a *dangling* symref, which reads as a creation.
- **`rename` of the checked-out branch writes git's two `logs/HEAD` entries** — `<tip> 0{40}` from the source delete while `HEAD` is still coupled to the old name, then `0{40} <tip>` from the HEAD re-point, once the old name is already gone. Both carry `Branch: renamed refs/heads/<from> to refs/heads/<to>`, with full ref paths and a capital `B` — unlike every sibling `branch: …` message, measured against the git binary, not a typo. A forced rename onto a live branch writes the same two; renaming a branch no worktree has checked out, or onto its own name, writes none.
- **Reflog move, not rewrite.** `rename` moves the source's reflog file byte-for-byte instead of parsing and re-serializing it, so a malformed line survives verbatim under the new name; the rename entry is appended afterward.
- **The renamed branch's own log takes a different shape per backend.** On the **files** backend the moved history gains a single `<tip> <tip>` rename entry. On **reftable** it gains **two** — `<tip> 0{40}` then `0{40} <tip>`, git's delete-then-create pair — and a forced rename **merges** the destination's existing history in at its own update indices instead of replacing it, where the files backend drops the destination's log first. Both shapes are git's own for that backend.
- **Renaming a branch onto its own name succeeds** — the ref and its log stay put, and only the rename entry is appended.
- **On the files backend, `force` onto an existing branch replaces its reflog**, not concatenates it: the destination's prior history is dropped before the source's log moves in. Reftable merges instead, per the bullet above.
- **An orphan reflog file under the destination name** (no live ref, left behind by an earlier delete) survives when the branch being renamed has no reflog of its own — the rename entry is appended onto it, matching git; when the source does have a reflog, moving it overwrites whatever log already sits at the destination.

## Examples

```ts
const { branches } = await repo.branch.list();
await repo.branch.create({ name: 'feature/x', startPoint: 'main' });
await repo.branch.rename({ from: 'feature/x', to: 'feature/y' });
await repo.branch.delete({ name: 'feature/y' });
```

## Throws

- `BRANCH_EXISTS` — `create` with an existing name and no `force`; `rename` whose `to` already exists and no `force`.
- `INVALID_REF` — name violates git ref syntax.
- `BRANCH_NOT_FOUND` — `delete` / `rename` on a name that does not exist, or an unresolvable `startPoint`. On an unborn HEAD with no `startPoint`, `name` carries the current branch's short name — the label git substituted for the omitted start point — never `HEAD`.
- `UNEXPECTED_OBJECT_TYPE` — `create` whose (peeled) `startPoint` is not a commit.
- `BRANCH_CHECKED_OUT` — `delete`, or a forced `create`, on a branch some worktree's HEAD names; `path` carries that worktree.
- `CONFIG_BAD_NUMERIC_VALUE` — `delete` on a repository with a malformed `core.maxTreeDepth` / `core.deltaBaseCacheLimit` (the repo-settings class, checked right after the gate, before the worktree-holder / not-found checks); `create` reaches the same class through its own read of the start point's object, structurally, with no separate check. `list` and `rename` do **not** refuse on this class — git runs them without touching the object store.

## See also

- Primitives: [`resolveRef`](../primitives/resolve-ref.md), [`updateRef`](../primitives/update-ref.md), [`RefStore.moveReflog`](../primitives/internals.md#refstore--getrefstore)
- Related commands: [`checkout`](checkout.md), [`tag`](tag.md), [`merge`](merge.md)
- ADRs: [181](../../adr/181-nested-namespace-porcelain.md), [192](../../adr/192-crud-namespace-per-verb-results.md), [193](../../adr/193-no-transition-shim-hard-remove-callable.md), [740](../../adr/740-branch-rename-moves-the-reflog-through-a-move-reflog-verb.md), [860](../../adr/860-branch-create-verifies-its-start-point-is-a-commit.md), [861](../../adr/861-the-non-commit-branch-point-refusal-reuses-unexpected-object-type.md)
- Recipes: [navigate ref history](../recipes.md#navigate-ref-history)