# ADR-007: Restart-Only Resume Semantics; Pack Body Buffered In Memory

## Status

Accepted (at `1c23aae`)

## Context

Smart-HTTP v1 has no protocol-level resume mechanism. A `git-upload-pack` POST returns a single response whose body carries `ACK / NAK / pack`. If the connection drops mid-response, the client cannot tell the server "resume at byte N" — the server has no notion of "where we were", since pack generation is stateless from request to request.

The available options for handling mid-pack server hang-ups:

1. **Restart only.** On any network error during the pack transfer, the request is retried from scratch. The existing `withRetry` middleware already implements this — it retries the entire HTTP request, including the POST body. The server regenerates a fresh pack with the same `want / have` set; the bytes are not byte-identical (timestamps and entry ordering can vary) but the resulting object graph is.
2. **HTTP Range resume.** On a mid-stream failure, issue a new request with `Range: bytes=<received>-`. This requires:
   - The server supports `Range` on `git-upload-pack` responses — most do NOT. `git-http-backend` does not.
   - The client remembering the byte offset where the original stream failed.
   - Negotiating "same pack" semantics so the resumed range overlays the original stream's content — not guaranteed and unsafe.
   Real git does not implement this; isomorphic-git does not implement this. The capability appears in no spec.
3. **Buffered-write resume on disk.** Stream the pack to a `.pack.tmp` file as it arrives; on failure, the tmp survives and the next retry resumes. Only useful if the server supports Range; reduces to option 2 server-side.

The orthogonal question is whether to buffer the pack body in memory before write or stream-write it to a `.pack.tmp` file:

- **In-memory buffer.** Simpler. Bounded by `config.maxResponseBytes`. RAM cost = pack size during the brief commit window. Browser and Node both work without filesystem temp-file primitives.
- **Stream-to-temp-file.** Lower RAM ceiling. Needs a filesystem-only path; OPFS in the browser supports it but the code branches by adapter. Adds rollback complexity if any step after the temp write fails.

For small/medium repos (the v1.0 target), in-memory is acceptable. For large repos (Phase 15.2 "Large bench fixture: 50k commits / 200k blobs / ~500 MB"), the in-memory ceiling becomes a concern — but Phase 15 hasn't shipped, the benchmark fixture doesn't exist, and "clone a half-gig repo in one shot" is a future-optimization use case.

## Decision

Phase 12.1 ships **restart-only** resume semantics. The existing `withRetry` middleware is the sole mechanism for transient-failure recovery. No Range-resume, no `.pack.tmp` streaming.

The pack body is **buffered in memory** before any disk write. The buffer is bounded by `config.maxResponseBytes` (default 512 MiB; existing `RepositoryConfig` field). Exceeding the cap raises `PACK_TOO_LARGE` — the existing application-tier error variant.

The trailer SHA is verified against the buffered bytes BEFORE the `.pack` file hits disk. A trailer mismatch never produces an orphan `.pack` file.

A `.pack.tmp` streaming path is recorded as a future optimization (referenced from BACKLOG Phase 15) but not implemented in v1.0.

## Consequences

### Positive

- Single, simple code path. The pack walker can operate on a fully-resident buffer, eliminating async chunk-boundary handling inside the walker.
- Trailer verification is trivial: slice the last 20 bytes, hash the rest, compare.
- `withRetry`'s existing exponential backoff + idempotency notes (Phase 8 §5.1.2) cover all transient errors.
- Aborted requests (caller cancels the AbortSignal) immediately free the buffer — GC reclaims it next cycle.

### Negative

- A single failed clone of a 400 MiB repo wastes 400 MiB of RAM, briefly. Adversarial server can force the client up to `maxResponseBytes` of RAM by streaming slowly. Mitigation: `maxResponseBytes` default = 512 MiB; callers can lower it; abort signal cuts the buffer short.
- A mid-stream failure on a 400 MiB pack restarts the entire 400 MiB download. The bandwidth cost falls on the user; no protocol fix is possible in v1 without server changes.
- The first big-pack regression will likely come from a user who has not adjusted `maxResponseBytes`. The error message names the limit so the fix is obvious.

### Neutral

- Server-emitted progress over side-band channel-2 is still delivered to the reporter as it arrives — buffering happens at a lower layer than reporter callbacks.
- The `withRetry` config that controls attempt count is unchanged. The user's existing tuning (Phase 8 `withDefaults` defaults) applies.
- Future work to stream-write to a temp file lives behind a config flag so it can be A/B-tested against the current path without breaking callers.
