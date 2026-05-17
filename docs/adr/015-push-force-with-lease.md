# ADR-015: Push Force-With-Lease Semantics

## Status

Accepted (at `d7ecbac`)

## Context

`PushOptions.forceWithLease?: ObjectId | 'auto'` exists since the Phase 11
stub. Phase 12.3 must give it concrete semantics.

Canonical git supports three forms of `--force-with-lease`:

1. **Bare**: `--force-with-lease` — lease is "the value of the
   remote-tracking ref at the start of the operation". Per-ref.
2. **Per-ref expected**: `--force-with-lease=<refname>:<expect>` — lease
   is `<expect>` for `<refname>` and "no force" for everything else.
3. **Per-ref auto**: `--force-with-lease=<refname>` — same as bare, but
   only applies to `<refname>`.

Forms (2) and (3) are per-refspec. Form (1) is global to the push.

tsgit's v1 API has a single global `forceWithLease` field on
`PushOptions`. Extending it to per-refspec leases requires either:
- A new shape (`Map<RefName, ObjectId | 'auto'>`), which changes the
  public type surface; or
- A new optional field per refspec in a parallel array, which is fragile.

For v1 we keep the global field and document the semantics. Per-refspec
leases land in a follow-up if user feedback demands them.

## Decision

`forceWithLease`'s semantics in v1:

- **`undefined`** — no lease. Refspecs without `+` perform fast-forward
  checks; refspecs with `+` skip the check unconditionally.
- **`'auto'`** — for every non-delete refspec, the lease is the value of
  the cached remote-tracking ref `refs/remotes/<remote>/<branch>` at the
  start of the push. If that cached ref does not exist, throw
  `REF_NOT_FOUND` — the user has no basis for asserting a lease against
  an unobserved remote.
- **`<oid: ObjectId>`** — single explicit oid applied to every
  non-delete refspec. Use this only when pushing one refspec (the
  intuitive case).

For every refspec carrying a lease:
1. Discover `git-receive-pack` refs to obtain the server's currently
   advertised oid for the dst.
2. If `serverOid !== lease`, throw `PUSH_REJECTED` with reason
   `'lease-mismatch'`. Pack is NOT sent.
3. If `serverOid === lease`, proceed AS IF the refspec carried `+`
   (skip ancestor check).

Tag dsts (`refs/tags/*`) reject `'auto'` because the cached
remote-tracking ref pattern does not apply to tags. The user must
supply an explicit oid for a tag lease. Throws `INVALID_OPTION` with
reason `'lease-on-non-branch'`.

Delete refspecs (`:dst`) ignore `forceWithLease` — the user is asserting
the delete, not a content invariant. Canonical git's `--force-with-lease`
on a delete behaves the same.

## Consequences

### Positive

- **Race-condition-safe push when used correctly.** A user who calls
  `fetch` then immediately `push({ forceWithLease: 'auto' })` is
  protected from a concurrent third-party push between the two
  operations: if the third party advanced the remote, the lease fails.
- **Lease check happens before pack transmission.** A failed lease
  costs one round-trip (discovery) plus one error. No wasted bandwidth.
- **Surface stays narrow.** Single global field; no new shape.
- **Tag rejection is explicit.** Returning `'lease-on-non-branch'`
  prevents the user from believing the lease applies when it cannot.

### Negative

- **No per-refspec leases.** Pushing two branches where one is force
  and one is normal is awkward: either supply a lease and both are
  force-with-lease, or supply none and both are subject to
  fast-forward check / `+` prefix. v1 trade-off; reconsider in a v1.x
  patch.
- **`'auto'` requires a prior fetch.** The cached remote-tracking ref
  must exist. New users who push without ever fetching will see
  `REF_NOT_FOUND`. Error message should hint at this.

### Neutral

- **Force-without-lease is still possible** via `+` in the refspec.
  Leases are opt-in; the `+` short-circuit remains.
- **Symmetric with `git --force-with-lease` semantics.** The user
  mental model carries over from canonical git for the common case
  (single-branch push with `auto`).

### Alternatives considered

- **Per-refspec lease via a parallel `leases?: ReadonlyArray<ObjectId | 'auto' | null>`
  array.** Rejected: positional alignment with `refspecs` is fragile
  and easy to misalign. If we expose per-ref leases, do it via a
  structured option shape, not parallel arrays.
- **Map-shaped option `forceWithLease: Map<RefName, ...>`.** Cleaner
  than parallel arrays but doubles the public surface for an
  uncommon-in-v1 use case. Defer until evidence of demand.
- **Lease check at the report-status layer.** Could compare
  `serverOid` to `lease` after a successful push. Wrong — the lease's
  purpose is to abort BEFORE the push, not to reject after the fact.
  Rejected.
