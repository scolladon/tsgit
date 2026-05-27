# ADR-155: Named-slot join rows, not positional tuples

## Status

Accepted (at `1c35bc3`)

## Context

isomorphic-git's multi-source walker:

```js
walk({
  trees: [TREE({ ref: 'HEAD' }), WORKDIR(), STAGE()],
  map: async (path, [head, workdir, stage]) => { ... },
})
```

The walker yields entries as a **positional tuple**: `[head, workdir, stage]`.
Off-by-one errors are easy ("which slot was theirs again? the third one?").
Each slot is nullable (`null` if the path didn't exist there). The type
surface is uniform — `WalkerEntry | null` — so TypeScript can't help.

For a 3-way join this is awkward. For a 4-way merge inspection (base, ours,
theirs, workdir) it's a foot-gun.

## Decision

`join({head, index, workdir})` yields rows of shape:

```typescript
{
  readonly path: FilePath
  readonly head?:    TreeEntry
  readonly index?:   IndexEntry
  readonly workdir?: WorkdirEntry
}
```

Each slot is named, typed per its source, and optional (outer-join semantics).
`innerJoin(...)` yields rows where every slot is required (see ADR-159).

`JoinError<S>` is generic over the source map so `source: keyof S & string`
preserves the slot-name narrowing even at catch boundaries.

## Consequences

### Positive

- No positional foot-gun. `row.theirs` unambiguous; `row[2]` is gone.
- TypeScript narrows each slot to its source's entry shape (TreeEntry has
  `.oid` sync; WorkdirEntry has `.hash()` async — types catch the difference).
- Error messages name the slot (`JoinError: hash failed at "src/index.ts"
  source="workdir"`).
- Join composes order-agnostic: `join({a, b, c})` and `join({c, a, b})`
  produce the same row shape (just different slot accessors).
- Matches relational join thinking — a model every developer already understands.

### Negative

- Per-row object alloc slightly heavier than positional tuples. Negligible;
  JIT inlines small structs. Asserted by allocation-count test in spike §14.1.

### Neutral

- The 4-way merge example (`{base, ours, theirs, workdir}`) reads at the
  call site like the operation: "rows with base, ours, theirs, workdir."
- Mapped-type generics (`OuterJoinRow<S>`, `InnerJoinRow<S>`, `EntryOf<S[K]>`)
  preserve per-slot narrowing through the join transformation.
