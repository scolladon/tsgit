# 444 — Signed push (push certificates) in scope for v1

- **Status:** accepted
- **Date:** 2026-07-03
- **Design:** docs/design/gpg-signing.md · **Relates:** ADR-226 (git-faithfulness), ADR-442 (signer), ADR-434 (SSH transport)
- **Decision class:** D-scope (user judgment) — deviates from the design's recommendation

## Context

Backlog 25.2 lists "signed pushes" alongside signed commits and tags. Unlike commit and
tag signing — both object-local — a signed push emits a **push certificate**: the client
reads a server-advertised `push-cert` nonce, builds a certificate envelope (version /
pusher / pushee / nonce / ref-update lines), signs the envelope, and sends it under the
`push-cert` receive-pack capability. This couples signing to the transport and the wire
protocol. The design **recommended deferring** push certs to a follow-up and refusing
`push --signed` in the interim.

## Options considered

1. **Defer push certs** *(design recommendation)* — land signed commits + tags now;
   `push --signed` refuses with a typed error; file a follow-up. Smaller, object-local PR.
2. **Include signed push in v1** *(user choice)* — implement the nonce handshake +
   certificate envelope + `push-cert` capability now, across the transport layer.

## Decision

**Option 2, ratified by the user**, overriding the design recommendation. v1 delivers all
three surfaces, fully closing backlog 25.2. The wire format is already pinned in the design
(push-cert version 0.1, `pusher`/`pushee`/`nonce`/ref-updates/armor/`push-cert-end`, nonce
sourced from the server advertisement). This decision triggers the **scope-fold rule**: the
design is revised to fully specify the push-cert path before planning.

## Consequences

### Positive
- Backlog 25.2 is delivered in full; no partial-delivery follow-up needed.

### Negative
- Materially larger, riskier change spanning the transport/wire layer (nonce advertisement
  parse, envelope construction, `push-cert` capability negotiation) with more interop
  surface to pin.

### Neutral
- The signer primitive (ADR-442) is shared across all three surfaces; the push path adds
  envelope construction + capability wiring, not a second signing mechanism.
