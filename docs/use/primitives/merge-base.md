# `mergeBase`

Best common ancestor(s) of one or more commits. Always returns an array, empty when the histories are disjoint; `{ all: true }` sorts the result by oid.

By default it returns at most one base — the single result git 2.56's paint
walk yields. The walk's queue is always ordered by generation, then committer
date, then insertion. It stops once no merge-base candidate is queued and either
both sides are exhausted, or one side is exhausted and the popped generation is
below the topological ceiling: `GENERATION_NUMBER_V1_MAX` when the chain serves
no corrected commit dates, unbounded when it does. The single-result break fires
only below that ceiling. Without a commit-graph, or with one serving corrected
commit dates, the result is the same as git 2.55's; under a
`commitGraph.generationVersion=1` graph it can be a higher-generation base where
2.55 returned an older, newest-dated one
([ADR-1114](../../adr/1114-merge-base-follows-git-2-56-s-paint-queue.md)). Two
flags extend it:

- `{ all: true }` — every best common ancestor (`git merge-base --all`). In criss-cross histories there can be more than one.
- `{ octopus: true }` — the n-way octopus base (`git merge-base --octopus`), folded pairwise across all commits. `all` still controls truncation.

## Signature

```ts
repo.primitives.mergeBase(
  commits: readonly ObjectId[],
  options?: { readonly all?: boolean; readonly octopus?: boolean },
): Promise<readonly ObjectId[]>;
```

`commits[0]` is treated as `one`, the rest as the others. An empty `commits` array throws `INVALID_WALK_INPUT`.

Each id is looked up as a commit first, as `git merge-base` looks up its
arguments: an annotated tag peels to the commit it names, and every lookup
shares one object table, so a type an earlier argument's parse assigned binds
a later one. `{ octopus: true }` looks them up last first, as git does. The
first id that names no commit — absent, another kind of object, or a commit
or tag git cannot parse — throws `INVALID_COMMIT_NAME` naming it, after the
`error:` lines git prints for it go to `ctx.logger.error`:

```ts
// git: error: object <tree> is a tree, not a commit
//      fatal: Not a valid commit name <tree>
try {
  await repo.primitives.mergeBase([head, treeId]);
} catch (error) {
  if (error.data.code === 'INVALID_COMMIT_NAME') console.error(`fatal: Not a valid commit name ${error.data.name}`);
}
```

The walk then parses each parent it reaches. One the store lacks, or one of
another kind, throws `COMMIT_PARSE_FAILED` naming it, after git's `Could not
read <id>` / `Object <id> not a commit` line goes to `ctx.logger.error` — git
prints `error: could not parse commit <id>` and exits 255 (128 under
`--octopus`).

Each parse types its pointers into the call's one object table, the table
the argument lookup filled. A commit read from its object types its tree a
tree, then each parent a commit; a pointer an earlier read typed otherwise
logs `object <x> is a <type>, not a <type>` and `bad tree pointer <x> in
commit <id>` / `bad parent <x> in commit <id>`, then refuses
`COMMIT_PARSE_FAILED` for that commit. A commit the commit-graph serves types
only its parents (`fill_commit_in_graph`); a conflict there logs the same
first line and refuses `COMMIT_LOOKUP_FAILED` naming the parent — git dies
`could not find commit <x>`.

## Examples

```ts
const head = await repo.primitives.resolveRef('HEAD');
const feature = await repo.primitives.resolveRef('refs/heads/feature/x');

// single best base (or [] for disjoint histories)
const [base] = await repo.primitives.mergeBase([head, feature]);

// all best bases — multiple in criss-cross merges
const bases = await repo.primitives.mergeBase([head, feature], { all: true });

// octopus base of three branches
const a = await repo.primitives.resolveRef('refs/heads/a');
const b = await repo.primitives.resolveRef('refs/heads/b');
const [octopusBase] = await repo.primitives.mergeBase([head, a, b], { octopus: true });
```

## See also

- Tier-1: [`merge`](../commands/merge.md), [`log`](../commands/log.md) (range A..B)
- Related primitives: [`walkCommits`](walk-commits.md), [`resolveRef`](resolve-ref.md)
