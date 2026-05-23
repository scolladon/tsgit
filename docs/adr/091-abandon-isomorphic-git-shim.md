# ADR-091: Abandon the isomorphic-git compatibility shim (17.7)

## Status

Accepted (at `272c00d`)

## Context

Backlog item **17.7** queued a runtime-namespace compatibility shim that would
let an `isomorphic-git` consumer swap imports to `@scolladon/tsgit` and keep
their existing per-call style:

```js
// isomorphic-git
await git.log({ fs, dir, depth: 10 })
// shim would let the same call shape resolve through tsgit
```

The intent was to lower the migration cost for codebases already wired to
isomorphic-git's stateless, parameter-bag API.

`MIGRATION.md` already records why it was held out of v1: the two libraries
surface different lifetime + validation models. tsgit binds an opened
repository (`openRepository(...)` → bound methods) so that resource lifetime,
disposal, and input validation happen **once** at open time. isomorphic-git
re-derives `{ fs, dir, gitdir, ... }` on every call and re-runs validation
per-call — historically the source of several silent-failure / partial-state
bugs we deliberately closed at the type and adapter layer.

A literal namespace shim would have to either:

1. **Re-validate per call**, re-introducing the per-call gaps and forfeiting
   the design property the rest of the library is built on, or
2. **Hide a process-wide singleton repo** behind the shim, which moves
   lifetime management out of the user's sight and breaks multi-repo,
   sandboxed, and disposal-sensitive callers.

Neither variant is a faithful shim, and both undermine the invariants the
v1 surface exists to enforce.

The only remaining argument for shipping it was speculative adoption uplift:
"users currently on isomorphic-git will switch faster if they don't have to
touch call sites." There is no traction signal for this today — no issues
asking for it, no migration-friction reports, no downstream PoC stuck on it.
The escape hatch (`MIGRATION.md` recommends a thin per-codebase adapter) is
already documented and works against the v1 API without us committing to a
surface we'd then have to support forever.

## Decision

**Abandon 17.7.** No compatibility shim ships in v1, and none is queued.

If meaningful demand surfaces later — concrete issues, a documented migration
blocker from a real isomorphic-git codebase — the right next artifact is a
small adapter PoC against the top ~10 isomorphic-git calls (`clone`, `log`,
`readObject`, `listFiles`, `status`, `walk`, `readBlob`, `readTree`,
`resolveRef`, `writeRef`) to measure how lossy the mapping is for the common
80%. That PoC, not a spike, is what would decide whether a shim is worth
publishing. Until then this stays closed.

17.7 is moved from the queued section of `docs/BACKLOG.md` to "Abandoned
work", ticked `[x]` and linking this ADR.

## Consequences

### Positive

- The v1 surface keeps a single, validated lifetime model — no parallel API
  with weaker invariants to maintain, document, or defend in reviews.
- No commitment to track isomorphic-git's surface area, deprecations, or
  bug-for-bug behaviour. Their API can move; ours doesn't follow.
- Backlog stops carrying a speculative item; "Compat & adoption shims" is
  closed under Phase 17.

### Negative

- A team migrating from isomorphic-git has to write a small adapter per
  call site instead of swapping the import. `MIGRATION.md` already documents
  this path; the cost is real but contained, and it stays in user code where
  the user owns the lifetime decisions.

### Neutral

- No code change. The decision and the backlog flip are the artifacts.
- Cheap to re-open: a single backlog entry plus an adapter PoC, gated on a
  real adoption signal.

## Alternatives considered

- **Ship a literal isomorphic-git namespace shim** — rejected: forces a
  choice between re-introducing per-call validation gaps or hiding a
  singleton repo, both of which violate v1 invariants.
- **Ship a partial shim covering the top ~10 calls only** — rejected *now*,
  not in principle: with zero adoption signal it's a solution in search of a
  problem, and the partial surface would still anchor us to isomorphic-git's
  call shape. Worth revisiting once demand is concrete.
- **Run a technical spike before deciding** — rejected: the unknowns here
  are demand-side (does anyone need this?), not technical. A spike can't
  manufacture the market signal that would justify the work.
- **Keep 17.7 queued indefinitely** — rejected: an item with no intent to
  ship clutters the backlog and misrepresents roadmap. Abandonment with an
  ADR is more honest and equally reversible.
