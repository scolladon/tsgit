# 440 — Pure parseRemoteUrl owns ssh/scp parsing; SSRF validation stays HTTP-only

- **Status:** accepted
- **Date:** 2026-07-02
- **Design:** docs/design/ssh-transport.md · **Relates:** ADR-434 (dispatch point), ADR-438 (refusal codes)
- **Decision class:** D-security (adopted-as-recommended, no user judgment)

## Context

git accepts two SSH remote syntaxes — `ssh://[user@]host[:port]/path` and the
scp-like `[user@]host:path` — plus the http(s) forms. The scp-like form is **not** a
WHATWG URL, so the existing `validateUrl` (which also performs the SSRF guard: DNS
resolution pinning, `allowInsecure`, `allowPrivateNetworks`) cannot parse it. A
transport-selection point (ADR-434) needs one classifier for every remote string.

## Options considered

1. **New pure `parseRemoteUrl`** *(recommended)* — classifies http/https/ssh/scp-like,
   extracts user/host/port/path, refuses control characters and leading-dash
   host/path (the CVE-2017-1000117 analog); `validateUrl` + DNS pinning remain
   HTTP-only; ssh remotes bypass DNS validation entirely.
2. **Extend `validateUrl` to accept ssh** — forces scp-like strings through a WHATWG
   parser they don't fit, and applies a DNS pre-resolution that is meaningless for
   ssh: the `ssh` process does its own resolution (through `~/.ssh/config`
   aliases, ProxyJump, etc.), so a pre-pinned IP proves nothing about what ssh will
   contact.

## Decision

**Adopted-as-recommended (no user judgment): option 1.** `parseRemoteUrl` is a pure
domain-adjacent function; its scp-like disambiguation is pinned against git's own
rules (a colon before the first slash makes it scp-like; a Windows-drive-letter-style
single character is not a host). The SSH analog of the SSRF guard is the dash-guard
plus strict single-quoting of the remote path in the spawned argv (ADR-435): tsgit
never lets remote-controlled strings reach `ssh` as options or the remote shell
unquoted.

## Consequences

### Positive
- One classifier at the single dispatch point; commands never re-parse remotes.
- scp-like parsing is testable as a pure function, property-testable over its
  grammar.
- The HTTP SSRF story is untouched — no weakening of the existing guard.

### Negative
- Two parsing paths exist (WHATWG for http, hand parser for ssh/scp) — accepted,
  they parse genuinely different grammars.

### Neutral
- `ssh://` port syntax maps to `-p <port>` in argv; the scp-like form has no port
  syntax, matching git.
