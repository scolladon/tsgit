# 436 — SSH duplex channel uses web streams

- **Status:** accepted
- **Date:** 2026-07-02
- **Design:** docs/design/ssh-transport.md · **Relates:** ADR-435 (port shape)
- **Decision class:** D-api (adopted-as-recommended, no user judgment)

## Context

The `SshChannel` returned by the port (ADR-435) must expose the child process's stdin
and stdout in some streaming shape. The codebase already consumes HTTP response bodies
as web streams and owns a `readableStreamToAsyncIterable` bridge.

## Options considered

1. **Web streams** *(recommended)* — `stdin: WritableStream<Uint8Array>`,
   `stdout: ReadableStream<Uint8Array>`. Matches `HttpResponse.body`; the existing
   bridge feeds the pkt-line parser unchanged.
2. **`AsyncIterable<Uint8Array>` + sink callback** — iterable-first; but writes need an
   ad-hoc sink shape, and the HTTP side would then carry two stream vocabularies.
3. **Node streams** — platform-idiomatic on node but leaks a platform type through a
   port, breaking the ports-are-platform-neutral rule.

## Decision

**Adopted-as-recommended (no user judgment): option 1.** `SshChannel` carries
`WritableStream<Uint8Array>` / `ReadableStream<Uint8Array>`. The node adapter wraps
the child's stdio via the standard node↔web stream conversions; consumers reuse the
same stream-to-iterable bridge the HTTP path already uses to feed the protocol parser.

## Consequences

### Positive
- One stream vocabulary across all transports; no new bridging code on the consumer
  side.
- Ports stay platform-neutral (web streams exist in node, browser, and workers).

### Negative
- None identified beyond the general verbosity of web-stream plumbing in adapters.

### Neutral
- Abort/close flows through `close()` killing the child; in-flight reads reject via
  the existing abort-aware stream unwinding.
