# 439 — Protocol v0/v1 over SSH; GIT_PROTOCOL never set

- **Status:** accepted
- **Date:** 2026-07-02
- **Design:** docs/design/ssh-transport.md · **Relates:** ADR-434 (transport seam), backlog 25.3 (protocol v2)
- **Decision class:** D-scope (adopted-as-recommended, no user judgment)

## Context

Over SSH, protocol v2 is requested by sending the `GIT_PROTOCOL=version=2`
environment variable across the connection (`SendEnv`/server allowlist). tsgit's
protocol client speaks v0/v1 only today; v2 is backlog 25.3, which owns the `fetch`
command's `ack`/`ready`/`done` negotiation.

## Options considered

1. **v0/v1 only — never set `GIT_PROTOCOL`** *(recommended)* — omitting the variable
   yields the classic v0 advertisement stream the existing parser already handles;
   pinned against real servers.
2. **Request v2 now** — the advertisement would switch to the v2 capability list,
   which the current parser cannot consume; would force a partial v2 client into this
   item, duplicating 25.3.

## Decision

**Adopted-as-recommended (no user judgment): option 1.** The SSH session invokes
`git-upload-pack` / `git-receive-pack` with no `GIT_PROTOCOL`, receiving the v0
stream. This matches git's own behaviour for push (which stays v0/v1 even in modern
git) and is byte-compatible with the existing pure client. When 25.3 lands v2 behind
the `GitServiceSession` seam, the SSH implementation gains the env knob without
changing shape.

## Consequences

### Positive
- The pure v0/v1 client and its pins are reused verbatim; no protocol work in this
  item.
- A clean, single-owner boundary with 25.3.

### Negative
- SSH fetch inherits the known v1 negotiation limitation (single round, no
  `multi_ack_detailed`) already documented for HTTP in backlog 25.3 — incremental
  fetch with common history remains 25.3's deliverable.

### Neutral
- No divergence from git observable bytes: the wire stream tsgit consumes is a
  stream real git servers produce for v0 clients.
