# ADR-011: Ref Updates Are Per-Ref Atomic (No Batch Transaction)

## Status

Accepted (at `22f0594`)

## Context

After a fetch downloads a pack, the client needs to update its local
remote-tracking refs (`refs/remotes/<remote>/*`). There are two strategies:

**Strategy A — Per-ref atomic, no batch transaction.** For each advertised
ref, call `updateRef(name, newId)` immediately. Uses the existing Phase 3
atomic write (lock-rename) so each individual ref update is atomic and a
concurrent reader sees either the old or new value.

If `updateRef` fails partway through (e.g., disk full on ref number 7 of
12), the first 6 refs are advanced and the remaining 5 are not. The throw
propagates to the caller.

**Strategy B — Stage all refs, flip atomically.** Build a snapshot of every
ref that should be updated, write each into a staging area (e.g.,
`refs/remotes/<remote>.staging/`), then `rename` the entire directory once
all stages are written. If any single ref fails the stage, the entire
batch is discarded; the existing refs are untouched.

Strategy B is closer to what `git fetch` does on a fully-modern repo via
`reftable` (Git 2.45+). It's stronger atomicity but more complex —
directory-level renames don't always have the right cross-filesystem
semantics (e.g., temp dirs on a different filesystem from the repo
break it), and partial-rollback paths multiply the failure modes.

A concurrent reader (e.g., `status` or `log`) running while `fetch` is
midway through Strategy A would see the new value of some refs and the
old value of others. For `refs/remotes/<remote>/*`, this is benign:
remote-tracking refs are read-only from the rest of the system, and a
slightly out-of-date snapshot is not a correctness issue.

A failed fetch leaving some remote-tracking refs advanced is also benign:
the next fetch sees those advanced refs as `haves` and the server will
not re-send the corresponding objects. The repo is consistent.

## Decision

Adopt Strategy A: each ref update is a per-ref atomic `updateRef` call.
There is no batch transaction.

On failure partway through, the partial state is preserved (no rollback).
The error propagates with the original `TsgitError` from `updateRef`.

## Consequences

### Positive

- Reuses the existing `updateRef` machinery directly. No new code paths
  for ref state management.
- The atomic-per-ref guarantee is sufficient: a concurrent reader of a
  specific ref sees old XOR new, never mid-write garbage.
- Failure recovery is "run fetch again" — idempotent, no leftover
  staging directories to clean up.

### Negative

- A partial-failure fetch leaves the repository in an intermediate state:
  some remote-tracking refs are advanced, others are not. Callers that
  want stronger atomicity must wrap fetch in their own retry / cleanup.
- A `git status` run while fetch is mid-flight might show one new ref
  oid and one old ref oid simultaneously. Confusing but not incorrect.

### Neutral

- Local refs (`refs/heads/*`, `refs/tags/*`) are NEVER written by fetch
  per the layout policy in §3.8. Only `refs/remotes/<remote>/*` and
  `refs/tags/*` (server-side tag refs propagate to local-side tag refs
  identically; this is canonical-git behavior). The transactional
  question only applies to those.
- If Phase 17.x lands `reftable` support, this ADR can be revisited
  alongside Strategy B. The migration would be backward-compatible
  because the caller-visible result shape doesn't change.
