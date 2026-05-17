# ADR-005: Clone Uses Smart-HTTP Protocol v1

## Status

Accepted (at `1c23aae`)

## Context

Phase 12.1 wires the first real network-bound clone. The git wire protocol comes in two flavors that affect tsgit's request shape and response parser:

- **v1** — what Phase 8 already implements. Discovery returns advertised refs in pkt-line text. The `git-upload-pack` POST body is a `want / have / done` block followed by an optional `deepen` line. Capabilities are negotiated via a NUL-suffixed list on the first ref of the discovery body. The response is `ACK / NAK / pack` with optional side-band.
- **v2** — newer, request-driven. The client opts in via `Git-Protocol: version=2` request header. The server's discovery advertises `version 2` plus the list of supported commands. The client then issues per-command requests (`ls-refs`, `fetch`, …) using `0001` (delim) pkt-frames. Capabilities like `filter`, `wait-for-done`, and partial-clone filters are v2-only. Bandwidth is similar; round-trip count is comparable for clone (v2 still uses one POST for the pack body); the win is per-operation negotiation flexibility.

The decision is which protocol Phase 12.1 ships against. v1 is already implemented end-to-end in `domain/protocol/upload-pack.ts` (request builder + response parser) and exercised by `test/unit/domain/protocol/upload-pack-integration.test.ts`. v2 has no implementation today — the `decodePktStream` accepts a `v2` flag and recognizes delim/response-end frames, but the higher-level command parsers (`ls-refs`, v2 `fetch`) do not exist.

The four practical questions:

1. How much new code does each option require for Phase 12.1?
2. Which option leaves Phase 12.2 (fetch) in a better state?
3. Does v2 unlock features Phase 12.1 specifically needs?
4. Is there a real-world server that *only* speaks v2 and would block v1 clones?

Answers:

1. v1 requires ~0 LOC in `domain/protocol/`. v2 requires a full `ls-refs` parser, a v2 `fetch` request builder, a delim-frame-aware response parser, and capability-discovery parsing for the `version 2` header. ~600 LOC. The Phase 8 design explicitly punted v2 as future work.
2. v2 would let Phase 12.2 fetch use the `filter` capability for partial clones — but partial clones are explicitly Phase 17.4 (v2.0). For non-filter fetch, v1 want/have is sufficient.
3. The capabilities Phase 12.1 needs (`side-band-64k`, `ofs-delta`, `include-tag`, `agent=…`) are all v1 capabilities. None require v2.
4. As of 2026, every major host (GitHub, GitLab, Bitbucket Cloud, Gitea, Codeberg, self-hosted `git-http-backend`) advertises both v1 and v2 and accepts v1 requests indefinitely. No production host has dropped v1.

## Decision

Phase 12.1 ships smart-HTTP **v1** only. The `Git-Protocol` request header is not set. Discovery uses the existing `parseAdvertisedRefs`. Upload-pack uses the existing `buildUploadPackRequest` + `parseUploadPackResponse`.

v2 implementation is deferred. A future phase — likely the partial-clone work in Phase 17.4 — will revisit the decision when filter capabilities become required.

## Consequences

### Positive

- Zero new wire-format parsing code. Phase 12.1's net new LOC stays around ~350.
- Re-uses every Phase 8 test fixture (`buildDiscoveryBody`, `buildUploadPackResponseBody`).
- Faster shipping; smaller PR; easier review.
- No risk of mis-implementing the still-evolving v2 spec.

### Negative

- Slightly more bytes on the wire per discovery (v2's `ls-refs` can filter to a ref prefix, v1 always returns the full advertisement). Irrelevant for clone, where every ref is wanted anyway.
- Forecloses the partial-clone capability path until v2 lands. Phase 17.4 must do the v2 work before partial clones are possible.

### Neutral

- The `decodePktStream` v2 flag remains, unused. Removing it would shrink the bundle by ~30 bytes; keeping it preserves the surface for the future implementation.
- A user who explicitly sets `Git-Protocol: version=2` via a custom transport middleware would get a server response tsgit cannot parse — undocumented today; if the use case appears we add a check.
