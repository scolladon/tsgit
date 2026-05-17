# ADR-010: `haves` Derived From Full Graph Walk, One Round

## Status

Accepted (at `22f0594`)

## Context

`git fetch` reduces bandwidth by telling the server which objects the client
already has via `have <oid>` lines. The server then constructs a pack
containing only the objects the client is missing.

Three strategies for derivation:

**Strategy 1 — Full graph walk over remote-tracking tips.** Walk every
commit reachable from `refs/remotes/<remote>/*` and send each as a `have`.
Send `done` after the last have to declare end-of-negotiation. The server
returns the pack in one round-trip. Works with `multi_ack_detailed`
disabled (single-round, smart-HTTP v1 semantics — matches
[ADR-005](005-clone-protocol-v1.md)).

**Strategy 2 — Negotiated multi-round (`multi_ack_detailed`).** Send a
batch of haves; receive ACK/NAK; send a more refined batch based on the
ACKs; repeat until `ready` ack or both sides exhausted. Saves bandwidth
on large histories (server can short-circuit once it sees common
ancestors). Roughly doubles the protocol surface (multi-round response
parsing, ACK status tracking, NAK termination).

**Strategy 3 — Send only the tip oids (no walk).** Cheapest to compute on
the client side; worst bandwidth (server has no way to skip ancestors).

Smart-HTTP v1 with one round (`done: true` on the first request) is the
[ADR-005](005-clone-protocol-v1.md) baseline. Multi-round negotiation
doubles the response parser surface and adds new failure modes (mid-round
disconnect, retry semantics). It's worth doing eventually but not in v1.x.

A practical concern: a 100k-commit repo with no cap would send 100k `have`
lines, blowing the HTTP request body limit (typical reverse-proxy default
~1 MB). canonical git caps single-round haves around 256 with similar
reasoning.

## Decision

Adopt Strategy 1 with a cap: walk every commit reachable from
`refs/remotes/<remote>/*`, in BFS-topo order, send at most `MAX_HAVES = 256`
of the most recent commits, then `done`. Server replies with one pack
containing every object reachable from the wanted tips that is not
reachable from the supplied haves.

`MAX_HAVES = 256` is a constant in `application/primitives/types.ts`
alongside `MAX_WALK_SEEDS` and `MAX_WALK_QUEUE_SIZE`. The cap is generous
for typical repos (a year of weekly merges is ~52 entries) and prevents
the request body from growing pathologically on monorepos.

When the local repo has no remote-tracking refs (first fetch — `haves` is
empty), the request body just contains `want`s + `done`. Equivalent to
the clone-time call path, which is what we want.

## Consequences

### Positive

- One code path for haves derivation. Reuses `walkCommits` directly.
- One round-trip per fetch, same as Phase 12.1's clone (consistency with
  ADR-005).
- Cap keeps the request body bounded regardless of repo size.
- Implementation is ~20 LOC plus tests; pulls its weight.

### Negative

- A repository with hundreds of thousands of commits and a stale
  remote-tracking branch will receive more objects than strictly necessary
  (the server has fewer cut-points than it would with multi-round
  negotiation). Mitigation: real git's `multi_ack_detailed` becomes
  Phase 12.x or v2 work. The bandwidth penalty in v1.x is acceptable per
  the < 200 MiB target user (ADR-008's mitigation already documents this).
- The cap can in pathological cases miss the cut-point the server would
  have used. The result is a marginally bigger pack, not a wrong pack —
  acceptable.

### Neutral

- The `MAX_HAVES` cap interacts with `MAX_WALK_QUEUE_SIZE`. The walker
  stops yielding once the cap is reached, so we never need to overrun the
  queue.
- `multi_ack_detailed` capability is NOT requested. The server may still
  advertise it; we ignore it. Phase 12.x would re-open this ADR.
