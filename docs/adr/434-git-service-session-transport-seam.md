# 434 — GitServiceSession seam unifies HTTP and SSH transport dispatch

- **Status:** accepted
- **Date:** 2026-07-02
- **Design:** docs/design/ssh-transport.md · **Relates:** ADR-226 (git-faithfulness), backlog 25.3 (protocol v2)
- **Decision class:** D-architecture (user judgment)

## Context

`clone` / `fetch` / `push` today drive the smart-protocol v0/v1 client directly against
the HTTP helpers (advertisement GET + service POST). SSH is a different wire shape: one
long-lived full-duplex channel per service invocation, where the advertisement arrives
unsolicited on stdout and the request/response exchange happens on the same channel.
The commands need a seam that abstracts "talk one git service to a remote" without
distorting either transport.

## Options considered

1. **Stateful `GitServiceSession` seam** *(user choice)* — one interface both HTTP and
   SSH implement (`advertisement()`, `exchange(requestBytes)`, `close()`); commands pick
   the implementation from the parsed remote kind at a single transport-selection point
   and drive the pure protocol client uniformly.
2. **Parallel SSH path** — leave the HTTP command path untouched; SSH reuses only the
   pure domain primitives (pkt-line, pack). Zero HTTP regression risk, but duplicates
   the orchestration logic and 25.3 must unify the two paths later anyway.
3. **Force SSH into `HttpTransport`** — fake request/response pairs over the SSH
   channel. No new seam, but SSH is a duplex conversation; the request/response shape
   distorts it and blocks incremental negotiation later.

## Decision

**Option 1, ratified by the user.**

```ts
export interface GitServiceSession {                 // one per network operation, one service
  readonly advertisement: () => Promise<AsyncIterable<PktLine>>;
  readonly exchange: (requestBytes: Uint8Array) => Promise<AsyncIterable<PktLine>>;
  readonly close: () => Promise<void>;
}
```

- The **HTTP** implementation wraps the existing helpers — `advertisement()` is the GET
  (v0 prologue handling on), `exchange()` is the POST. It is stateless and its concrete
  wire bytes are **unchanged**.
- The **SSH** implementation is stateful: `advertisement()` opens the channel and reads
  the pre-flush advertisement (prologue off); `exchange()` writes to the same channel's
  stdin and returns the rest of stdout.

`openGitSession(ctx, url, service)` dispatches on `parseRemoteUrl(url).kind`
(ADR-440); commands contain no per-transport branching beyond that single point.

## Consequences

### Positive
- One seam for every current and future transport; 25.3 (protocol v2 `fetch`
  negotiation) lands behind the same interface.
- HTTP bytes are untouched — existing interop pins keep proving the HTTP path.
- The pure protocol client stays transport-agnostic, matching the hexagonal
  dependency rule.

### Negative
- The existing HTTP command path is refactored onto the new seam — a
  behavior-preserving migration that must be re-proven by the existing tests.

### Neutral
- The session is per-operation, per-service, mirroring git's own one-service-per-
  connection model.
