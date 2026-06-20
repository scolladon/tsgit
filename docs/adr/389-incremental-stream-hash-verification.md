# ADR-389: `streamBlob` verifies the object hash incrementally, default-on

## Status

Accepted

- **Date:** 2026-06-20
- **Design:** [design/blob-streaming.md](../design/blob-streaming.md)
- **Refines:** [ADR-384](384-blob-stream-asynciterable-return.md)

## Context

`readObject`/`readBlob` default `verifyHash` to **on**: the resolver re-hashes the
materialised object and throws `objectHashMismatch` on corruption. A streaming path
cannot buffer the whole object to hash it at the end without defeating the purpose, so
the verification posture is a deliberate choice. Dropping verification silently would
weaken faithfulness relative to the buffered API.

## Options considered

1. **(chosen) Verify incrementally, default-on** — feed each yielded chunk into a
   running hash of the canonical `<type> <size>\0` + content, throw `objectHashMismatch`
   at end-of-stream if it differs — pros: matches `readObject`'s default-on posture; no
   buffering; corruption is still caught / cons: the mismatch surfaces only after the
   last chunk, so a consumer must treat the stream as provisional until it completes
   (documented).
2. **Don't verify** — Rejected: silently weaker than `readBlob`; a corrupt blob would
   stream wrong bytes with no signal.
3. **Opt-in (default off)** — Rejected: inconsistent with `readObject`'s default-on; a
   caller migrating from `readBlob` would silently lose verification.

## Decision

`streamBlob` hashes incrementally as it yields and throws `objectHashMismatch` at
end-of-stream when the recomputed id differs from the requested id. Verification is on by
default, matching `readObject`; an explicit `verifyHash: false` opts out (parity with the
buffered options). The end-of-stream timing — consumers must treat the final chunk as
provisional until the stream completes without throwing — is documented on the API.

## Consequences

### Positive

- Faithfulness parity with the buffered read; no buffering required.

### Negative

- Mismatch is detected only at end-of-stream (inherent to streaming).

### Neutral

- The deltified path (ADR-386) reconstructs in full, so its verification is effectively
  end-of-buffer; the incremental machinery still applies uniformly.
