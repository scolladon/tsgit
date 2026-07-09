# `describe`

Name a commit by its **nearest reachable tag**, faithful to `git describe`. The
target is peeled to a commit; the closest tag and the number of commits between
them are returned as **structured data** — the library renders no `git describe`
line and abbreviates no oid. Assembling `<name>-<distance>-g<abbrev>` (or applying
`--abbrev` / `--long` cosmetics) is the caller's job, per the
[structured-output rule](../../adr/249-describe-structured-data-only.md).

## Signature

```ts
repo.describe(rev?: string, opts?: DescribeOptions): Promise<DescribeResult>;
// rev defaults to 'HEAD'

interface DescribeOptions {
  readonly tags?: boolean;        // include lightweight tags (priority ≥ 1)
  readonly all?: boolean;         // include every ref (branches/remotes; priority 0)
  readonly always?: boolean;      // fall back to the oid instead of refusing
  readonly exactMatch?: boolean;  // only an exact tag counts (≡ candidates: 0)
  readonly candidates?: number;   // max tags considered; default 10
  readonly firstParent?: boolean; // follow only first parents
  readonly match?: string | ReadonlyArray<string>;   // short-name globs to include
  readonly exclude?: string | ReadonlyArray<string>; // short-name globs to drop
  readonly dirty?: boolean;       // report HEAD's tracked dirtiness (HEAD only)
  readonly broken?: boolean;      // tolerate an unreadable tree, reporting dirty
}

interface DescribeResult {
  readonly tag: RefName | undefined; // chosen ref; undefined on the `always` fallback
  readonly name: string;             // describe short-name ('v2.0', 'heads/main'); '' on fallback
  readonly distance: number;         // commits between ref and target (0 = exact)
  readonly oid: ObjectId;            // full 40-hex oid of the described commit
  readonly exact: boolean;           // distance === 0 && tag !== undefined
  readonly dirty: boolean;           // HEAD had staged or unstaged tracked changes
}
```

## Behaviour

- **Annotated by default:** only annotated tags are considered; `tags: true` adds
  lightweight tags, `all: true` adds every ref (branch/remote names projected as
  `heads/…` / `remotes/…`).
- **Selection (git's early-termination):** the committer-date-ordered walk
  collects candidate tags until the `candidates` budget — or every reachable name
  — is taken, then picks the smallest distance **at that freeze point** (ties
  broken by discovery order, newest-dated first) and finalises only the winner's
  exact distance. This is byte-faithful to `git describe`: on a merge where a
  newer-dated tag is structurally **farther** than an older, nearer one, the
  farther first-met tag is kept, and a smaller `candidates` budget can change
  which tag is reported. Depth still beats priority (a depth-0 branch beats a
  deeper annotated tag under `all`).
- **Traversal cost:** the walk stops as soon as the reported tag and distance are
  settled — once the last remaining path is covered by every nearest candidate,
  and once the winner covers the whole frontier — so a nearby tag on a deep
  history reads O(distance) commits, not the full ancestry. This is a pure
  traversal optimisation: the reported tag and distance are identical to a full
  walk (git's two output-inert breaks).
- **Same-commit ties:** two annotated tags on one commit resolve to the newer
  tagger date (git's `replace_name`).
- **`exactMatch`:** only a tag on the target itself counts; otherwise refuses
  (`NO_EXACT_MATCH`) unless `always` is set.
- **`dirty` / `broken`:** describe HEAD and report whether it has **tracked**
  changes — staged (index-vs-HEAD), unstaged, **or unmerged** (a mid-merge index
  with conflicted paths is dirty; `git diff-index HEAD` over every `status`
  column); untracked files don't count. Incompatible with an explicit
  commit-ish (`INVALID_OPTION`).
- **Refusals:** `NO_NAMES` (no tags at all), `NO_ANNOTATED_NAMES` (only lightweight
  tags in default mode), `NO_REACHABLE_NAMES` (tags exist but none reach the
  target), `NO_EXACT_MATCH`. `always: true` returns the oid fallback instead.

## Examples

```ts
const d = await repo.describe();
// caller renders git's line from the data:
const line = d.tag === undefined
  ? d.oid.slice(0, 7)                              // --always
  : d.exact
    ? d.name                                       // exact tag
    : `${d.name}-${d.distance}-g${d.oid.slice(0, 7)}`;

await repo.describe('HEAD', { tags: true });       // lightweight tags too
await repo.describe(commitOid, { match: 'v*' });   // only v-prefixed tags
const { dirty } = await repo.describe(undefined, { dirty: true });
```

## See also

- Primitives: [`readObject`](../primitives/read-object.md), [`resolveRef`](../primitives/resolve-ref.md), [`walkCommits`](../primitives/walk-commits.md)
- Related commands: [`tag`](tag.md), [`show`](show.md), [`log`](log.md)
- ADRs: [249](../../adr/249-describe-structured-data-only.md), [276](../../adr/276-describe-early-termination-output-only.md), [460](../../adr/460-describe-early-termination-frontier-step.md)
- Roadmap: Phase 23 — Inspection (v3)
