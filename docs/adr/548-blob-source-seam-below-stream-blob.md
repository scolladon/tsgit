# 548 — The buffered/streamed choice lives in a seam below `streamBlob`

- **Status:** accepted
- **Date:** 2026-07-30
- **Design:** docs/design/whitespace-drop-fast-path.md · **Supersedes/Refines:** refines ADR-385

## Context

The whitespace drop-pass predicate pays ~147 µs per modified pair on many-small-files
repositories, almost all of it per-blob pipeline construction: a WHATWG
TransformStream/WritableStream stack plus a `createInflate` instance per blob, for
~56-byte content. A buffered read of the same blob costs ~22 µs loose and ~1.4 µs warm
from the delta cache. Removing the streaming scaffolding for small blobs requires
deciding *where* the buffered-versus-streamed choice is made, which in turn decides
what happens to ADR-385's "`streamBlob` always streams".

## Options considered

1. **A shared internal `openBlobSource` seam below `streamBlob`** (designer's
   recommendation) — the seam returns either split `{ type, content }` bytes or a
   stream; `streamBlob` calls it with a threshold of `0` and wraps a `bytes` arm as a
   one-chunk iterable. Pros: ADR-385's decision text stays literally true, its Neutral
   note ("escalation lives inside `streamBlob`") is honoured by the shared
   implementation, and `streamBlob`'s observable contract is byte-for-byte unchanged /
   cons: one more internal module.
2. **Put the gate inside `streamBlob` itself** — pros: every caller inherits the win /
   cons: supersedes ADR-385 outright and silently changes behaviour for
   `apply-changeset`, `apply-merge-to-worktree`, `merge`, `stash` and the public
   `repo.primitives.streamBlob`, none of which asked for it.
3. **No seam — the predicate calls `readRawObject(…, { maxBytes: T })` and falls back
   to `streamBlob` on `OBJECT_TOO_LARGE`** — cons: **unsound**. `enforceLooseCap`
   fires *after* the full inflate, so an oversized loose blob — exactly the case
   streaming exists for — is materialised in full before the cap can refuse it.

## Decision

Adopted-as-recommended (no user judgment): **option 1**. `openBlobSource(ctx, id,
maxBufferedBytes, options?)` resolves the delta cache (consulted only when
`maxBufferedBytes > 0`), then loose, then pack base, then pack delta, returning
`bytes` below the gate and `stream` above it. `streamBlob` becomes
`openBlobSource(ctx, id, 0, options)` plus a wrap tail.

## Consequences

`test/unit/application/primitives/stream-blob.test.ts` must pass **unmodified** — that
is the executable statement of "contract unchanged". Gating the delta-cache probe at
`maxBufferedBytes > 0` is load-bearing: it preserves `streamBlob`'s exact
loose-first-then-pack precedence and stops a cache hit becoming a `materialised: true`
stream where it reports `false` today. The seam reports `type` but leaves the
blob-specific `UNEXPECTED_OBJECT_TYPE` refusal with its callers, so a future non-blob
consumer is not foreclosed. The seam deliberately does **not** adopt
`resolveObjectBytes`'s virtual empty-tree short-circuit, which would turn
`streamBlob`'s `OBJECT_NOT_FOUND` into `UNEXPECTED_OBJECT_TYPE`, and deliberately does
not acquire `readRawObject`'s promisor lazy-fetch retry, which would make lazy-fetch
asymmetric between small and large blobs.
