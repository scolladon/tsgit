# ADR-737: Reflog lenient read is a RefStore seam verb

## Status

Accepted (at `fc54f8cd`) — adopted-as-recommended (no user judgment)

## Context

Canonical git skips a malformed reflog line per line and keeps reading; tsgit's
`reflog` command read path is all-or-nothing. The lenient parser
(`parseReflogLenient`) exists, but the only lenient *reader* is a private helper in
`fsck/roots.ts` that builds `.git/logs/**` paths directly — a second tolerance
implementation, and one that is blind to the reftable backend (reftable keeps
reflogs in the stack, so the helper reads zero entries there and gc's retention
walk can let `gc --prune` delete objects reachable only from a reflog).

Alternatives: (b) a dispatcher-level sibling in `reflog-store.ts` only, still
files-path-bound; (c) a `{ lenient }` option on the existing `RefStore.readReflog`.

## Decision

Add `readReflogLenient(name)` to the `RefStore` interface, implemented per backend,
exposed through a `reflog-store.ts` dispatcher `readReflogLenient(ctx, ref)`.
`fsck/roots.ts` deletes its private helper and consumes the dispatcher. The
`MAX_REFLOG_BYTES` cap still throws on the lenient path — only per-line faults
become silent.

## Consequences

### Positive

- One tolerance implementation, backend-neutral; closes the reftable gc
  retention-root gap as a side effect.
- No boolean parameter on a seam verb; each backend states its own lenient shape.

### Negative

- One new published export — `reports/api.json` must be regenerated before push.

### Neutral

- The strict `readReflog` keeps its exact contract and callers.
