# `revList`

Enumerate the objects reachable from `wants` and not reachable from `not` — the reachability core of git's `git rev-list`. Walks commits (and, with `objects`, their trees and blobs), returning structured data only; no `--pretty`/`--format`/`--date`/`--abbrev`/`--header`/`-z`/`--object-names` — those are all presentation, left to the caller.

## Signature

```ts
repo.revList(opts?: RevListOptions): Promise<RevListResult>;

interface RevListOptions {
  readonly wants?: ReadonlyArray<string>;
  readonly not?: ReadonlyArray<string>;
  readonly objects?: boolean;
  readonly count?: boolean;
  readonly all?: boolean;
  readonly maxCount?: number;
  readonly firstParent?: boolean;
  readonly noWalk?: boolean;
  readonly useBitmapIndex?: boolean;
}

interface RevListEntry {
  readonly id: ObjectId;
  readonly type: 'commit' | 'tree' | 'blob' | 'tag';
  readonly path?: FilePath;
}

interface RevListResult {
  readonly entries: ReadonlyArray<RevListEntry>;
  readonly count: number;
}
```

## Options

| Field | Type | Default | Meaning |
|---|---|---|---|
| `wants` | `ReadonlyArray<string>` | `['HEAD']` | Revisions to walk from (full rev grammar, resolved through `revParse`). |
| `not` | `ReadonlyArray<string>` | `(none)` | Revisions whose reachability is excluded. |
| `objects` | `boolean` | `false` | Include trees and blobs, not just commits and tags. |
| `count` | `boolean` | `false` | Documents intent only — `entries` is always populated and `count` is always `entries.length` on the same call; there is no separate count-only fast path. |
| `all` | `boolean` | `false` | Union the tip of every ref (branches, tags, remotes, `HEAD`) into `wants`, deduplicated. |
| `maxCount` | `number` | `(unbounded)` | At most this many commits emitted; bounds the commit walk only, not the object stream. |
| `firstParent` | `boolean` | `false` | Follow only the first parent of each commit. Ignored on the bitmap tier. |
| `noWalk` | `boolean` | `false` | Emit the resolved tips themselves and stop — no parent traversal. Ignored on the bitmap tier. |
| `useBitmapIndex` | `boolean` | `false` | Ask for the bitmap tier. See "Tiers" below. |

## Behaviour

- **The walk, not the exact set difference.** `not` tips are marked uninteresting along with their own trees, then the interesting commits are walked and every unmarked object reached is emitted. An object reachable only through an *ancestor* of a `not` tip — not through that tip's own tree — is never marked, so it is emitted too. This over-report is the walk's own behaviour, not a bug: a peer that already has a `not` tip already has everything reachable from it, ancestors included.
- **Wants are peeled first.** An annotated tag in `wants` is unwrapped; the tag oid(s) join the result and the peeled commit seeds the walk. A want that resolves directly to a tree or blob has no parents — it contributes itself plus (for a tree) its own subtree, and nothing else.
- **Empty `wants`** returns an empty result, never an error and never "everything". `wants` fully covered by `not` also returns empty.
- **An unresolvable revision refuses**, on either side — never a silent degradation.
- **Ordering is deterministic but unspecified.** It is not git's own order (git's own bitmap and walk paths do not even agree with each other), so a caller that needs a stable display order sorts the result itself; every equality check here compares the result as a set.
- **`all`** resolves every ref's tip the same way an explicit want is resolved, then unions it with `wants` (deduplicated). A ref that does not peel to an object — a symbolic `HEAD` on an unborn branch is the live case — is skipped rather than refusing the whole call.
- **`maxCount`** bounds the commit walk, not the object stream: with `objects`, it is still N commits and everything *they* reach, not N objects overall. `maxCount: 0` yields an empty result rather than an unbounded one.
- **`firstParent`** follows only the first parent at each step, so a merge commit's second-parent branch is never walked.
- **`noWalk`** emits the resolved tips themselves and stops there — no parent is ever enqueued. Under `objects`, each tip's own tree still counts.

## Tiers

`revList` answers from one of two tiers over the same reachability question, `W AND NOT N`:

- **The walk** (default, `useBitmapIndex` unset or `false`) — the behaviour described above. This is what git's own `rev-list` does unless asked otherwise.
- **The bitmap tier** (`useBitmapIndex: true`) — answers from a pack (or multi-pack-index) bitmap when one is usable, computing the exact set difference rather than the walk's superset. If no usable bitmap exists — none is present, it is unreadable, structurally refused, or any position it decodes is out of range for the pack it indexes — the call falls back to the walk silently: no error, no signal that the fallback happened, exactly as git degrades.

The bitmap tier changes what three other options mean:

- **No `path`.** A bitmap encodes reachability and each object's type, never a name — `entries[].path` is always `undefined` on the bitmap tier, even under `objects`. A caller that needs paths must leave `useBitmapIndex` off.
- **`firstParent` and `noWalk` are ignored.** The bitmap tier does not traverse parent-by-parent — it resolves the full closure in one step — so both options have no effect and the full reachability closure is returned, exactly as git does when it loads a bitmap for these options.
- **`maxCount` still walks.** Passing `maxCount` alongside `useBitmapIndex` forces the walk tier regardless — git itself abandons the bitmap for a bounded count, so this is reproduction, not policy.

## Examples

```ts
// Every commit reachable from HEAD.
const { entries } = await repo.revList();

// Full object closure of a tag, including trees and blobs.
const { entries, count } = await repo.revList({ wants: ['v1.0'], objects: true });

// Objects introduced by a feature branch relative to main.
const incoming = await repo.revList({ wants: ['feature/x'], not: ['main'], objects: true });
```

## Throws

- `OBJECT_NOT_FOUND` / `REVPARSE_UNRESOLVED` — a `wants` or `not` entry does not resolve.
- `NOT_A_REPOSITORY` — `ctx` does not point at an initialized repository.
- `PACK_TOO_LARGE` — the closure exceeds the walk's object cap.

## See also

- Primitives: [`walkCommits`](../primitives/walk-commits.md), [`walkTree`](../primitives/walk-tree.md)
- Related commands: [`log`](log.md), [`revParse`](rev-parse.md)
