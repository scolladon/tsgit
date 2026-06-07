# `name-rev`

Name a commit by the **nearest ref that contains it** — a descendant-or-self ref
— expressed as a path down from that ref via git's `~`/`^` notation
(`tags/v2.0~3^2~1`). The inverse of [`describe`](describe.md)'s
nearest-*ancestor*-tag walk, faithful to `git name-rev`. Returns **structured
data**: the chosen ref (full name), whether it is an annotated tag, and the
ordered navigation steps — the library renders no name string and abbreviates no
ref, per the [structured-output rule](../../adr/249-describe-structured-data-only.md)
([ADR-283](../../adr/283-name-rev-structured-path.md)).

## Signature

```ts
repo.nameRev(rev?: string, opts?: NameRevOptions): Promise<NameRevResult>;
// rev defaults to 'HEAD'

interface NameRevOptions {
  readonly tags?: boolean;                            // restrict sources to refs/tags/*
  readonly refs?: string | ReadonlyArray<string>;    // full-refname globs to include (*/? cross /)
  readonly exclude?: string | ReadonlyArray<string>; // full-refname globs to drop
}

type NameRevStep =
  | { readonly kind: 'ancestor'; readonly count: number }   // ~count — first-parent chain (count ≥ 1)
  | { readonly kind: 'parent'; readonly number: number };   // ^number — number-th parent (number ≥ 2)

interface NameRevResult {
  readonly oid: ObjectId;                       // queried commit, full 40-hex
  readonly ref: RefName | undefined;            // naming ref (full name); undefined when unnameable
  readonly tagDeref: boolean;                   // ref is an annotated tag (render `^0` at the tip)
  readonly steps: ReadonlyArray<NameRevStep>;   // navigation from the ref's commit down to oid
}
```

## Behaviour

- **All refs by default:** every ref under `refs/` (branches, remotes, tags) is a
  naming source; `HEAD` is never used. `tags: true` restricts to `refs/tags/*`;
  `refs`/`exclude` filter by full-refname glob where `*`/`?` **cross `/`** (git's
  `name-rev --refs`/`--exclude`; a different dialect from `describe`'s anchored
  short-name `match`, [ADR-285](../../adr/285-name-rev-ref-glob-dialect.md)).
- **Selection:** a ref containing the commit wins over a non-tag at any distance
  (tag preference); among same-kind names the nearer wins, then the older tagger
  date breaks an equal-distance tie (git's `is_better_name`, pinned against git
  2.54's observed behaviour).
- **Path:** `~n` follows the first parent `n` times; `^n` takes the `n`-th parent
  (`n ≥ 2`); `^0` (rendered by the caller when `tagDeref` and there are no steps)
  peels an annotated tag to its commit.
- **Unnameable:** a commit reachable from no qualifying ref returns
  `ref: undefined` (git prints `undefined`) — `name-rev` never throws.
- **Caller renders the string** — the full `ref`, `tagDeref`, and `steps` are
  enough to reconstruct git's line under either short-name rule (plain
  `name-rev`'s `tags/…`/bare-branch, or `describe --contains`'s `refs/tags/`-stripped
  form). The library never abbreviates.

## `describe --contains`

`git describe --contains` is exactly `name-rev` restricted to tags with a refusal
on the unnameable case. `repo.describe(rev, { contains: true })` delegates here
and returns a `NameRevResult`
([ADR-284](../../adr/284-describe-contains-delegation.md)): default mode uses
tags only (`match`/`exclude` scoped to `refs/tags/<glob>`); `all: true` uses every
ref; an unnameable commit refuses with `CANNOT_DESCRIBE` unless `always: true`.
Ancestor-walk options (`candidates`/`exactMatch`/`firstParent`/`dirty`/`broken`)
are refused with `contains` (`INVALID_OPTION`).

## Examples

```ts
const n = await repo.nameRev(commitOid);
// caller renders git's line from the data:
const shortName = (ref: string) =>
  ref.replace(/^refs\/heads\//, '').replace(/^refs\//, '');
const render = (r: NameRevResult): string => {
  if (r.ref === undefined) return r.oid;                 // git's `undefined` / `--always` oid
  const base = shortName(r.ref);
  if (r.steps.length === 0) return r.tagDeref ? `${base}^0` : base;
  return base + r.steps.map((s) => (s.kind === 'ancestor' ? `~${s.count}` : `^${s.number}`)).join('');
};

await repo.nameRev('HEAD', { tags: true });             // only tags name it
await repo.nameRev(commitOid, { refs: 'refs/tags/v*' }); // restrict to v-tags
await repo.describe(commitOid, { contains: true });      // the nearest containing tag
```

## See also

- Primitives: [`readObject`](../primitives/read-object.md), [`resolveRef`](../primitives/resolve-ref.md)
- Related commands: [`describe`](describe.md), [`tag`](tag.md), [`log`](log.md)
- ADRs: [283](../../adr/283-name-rev-structured-path.md), [284](../../adr/284-describe-contains-delegation.md), [285](../../adr/285-name-rev-ref-glob-dialect.md)
- Roadmap: Phase 23 — Inspection (v3)
```
