# ADR-291: `submodule update` refuses `OBJECT_NOT_FOUND` when the pinned oid is absent after clone

## Status

Accepted (at `6adba128c25b`)

## Context

When the superproject's gitlink points to a commit the submodule's object store
does not (yet) contain — the remote advanced past the initial clone — canonical
git runs a `fetch` in the submodule to obtain it, then checks it out. tsgit's
transport is smart-HTTP **v1** with a single negotiation round and no
`multi_ack_detailed`: it cannot fetch new objects when the client already holds a
base (the incremental-fetch gap tracked by **25.3**). So the git "fetch the
missing pin" step cannot be reproduced today.

## Decision

When the pinned oid is absent from the module's objects after the clone-if-missing
step, `update` **refuses** with an `OBJECT_NOT_FOUND`-class error naming the
missing oid and submodule path, rather than attempting a fetch that would (today)
be a no-op and fail with a murkier error. Interop fixtures pin a commit always
present in the initial clone, so the faithful path is exercised; the refusal is
the honest boundary of the v1 transport.

## Consequences

### Positive

- Honest, specific failure instead of a confusing transport error or silent
  partial state.
- No dead/aspirational fetch code added ahead of 25.3.

### Negative

- A documented divergence from git for the "remote advanced" case — `update` works
  where git would `fetch`-then-checkout. Lifted for free once 25.3 lands real
  incremental fetch (the refusal becomes a fetch).

### Neutral

- The refusal is pinned by a unit test; the interop suite stays on the present-oid
  happy path.
