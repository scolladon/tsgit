# ADR-080: Lazy-fetch requests exact oids with no filter

## Status

Accepted (at `aef8dc2`)

## Context

A lazy-fetch (ADR-079) asks the promisor remote for a specific missing object
by oid. What `filter` line, if any, should that request carry?

- **Re-apply the repo's filter.** A `blob:none` repo lazy-fetching a blob
  would send `want <blob-oid>` + `filter blob:none` — and `blob:none` omits
  *all* blobs, including the one explicitly wanted. The object would not come
  back. Re-applying the filter is therefore wrong for the very kind of object
  the filter omits.
- **Send no filter.** `want <oid>` alone. For a blob, the server packs
  exactly that blob (a blob has no reachable dependents). For a tree, the
  server walks *into* the tree and packs its whole sub-tree/blob closure.

git's own lazy-fetch resolves this with protocol-v2 `no_dependents` mode,
which tsgit does not implement (v2 is out of scope for 17.4).

## Decision

Lazy-fetch sends `want <oid>` for each requested oid with **no `filter` line
and no `have` lines**. The promisor pack written carries a `.promisor`
sentinel.

For `blob:none` / `blob:limit` partial clones — the dominant case — this is
exact: lazy-fetched objects are blobs, blobs have no dependents, the server
returns precisely the requested blobs.

For `tree:<depth>` partial clones, lazy-fetching a *tree* returns that tree
plus its full reachable closure (sub-trees and blobs). This over-fetches but
is a correct super-set: the repository only ever gains valid objects.

## Consequences

### Positive

- Always correct: the requested object is always in the response (it is the
  traversal root, never filtered out), and the repo only gains valid objects.
- Dead simple: one code path for all three filter kinds, no per-kind branching
  in the fetch request, no protocol-v2 dependency.
- Exact (no waste) for `blob:none` / `blob:limit`, which is where partial
  clone is overwhelmingly used.

### Negative

- A `tree:<depth>` clone over-fetches when a tree is lazily read: the first
  read of a high-up tree can pull much of the repository. Transfer volume
  only — never a correctness problem.

### Neutral

- A tighter incremental tree fetch (protocol-v2 `no_dependents`, or a
  per-level `tree:` filter on the lazy request) is a clean future optimisation
  and is explicitly deferred. It changes only transfer volume, not the on-disk
  result.
- `have` lines are also omitted: for exact-oid wants there is nothing to
  negotiate, and a blob want is unaffected by the client's `have` set.
</content>
