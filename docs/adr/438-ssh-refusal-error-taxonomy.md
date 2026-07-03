# 438 — SSH refusals reuse the existing error taxonomy

- **Status:** accepted
- **Date:** 2026-07-02
- **Design:** docs/design/ssh-transport.md · **Relates:** ADR-437 (inert mechanism), ADR-440 (URL parsing)
- **Decision class:** D-api (adopted-as-recommended, no user judgment)

## Context

Two refusal surfaces need codes: (a) the browser/memory **inert** refusal when an
ssh/scp remote is used with no `ctx.ssh` capability (ADR-437); (b) the **dash-guard**
and malformed-remote refusals from the URL parser (ADR-440, the CVE-2017-1000117
analog where a host or path starting with `-` would be interpreted by `ssh` as an
option).

## Options considered

1. **Reuse `UNSUPPORTED_OPERATION` for both** — one code, but it conflates "this
   runtime can't do SSH" with "this remote string is dangerous/malformed", losing the
   caller's ability to react differently.
2. **New `SSH_UNSUPPORTED` code** — invents a transport-specific code where the
   taxonomy already has idiomatic members.
3. **Existing codes, split by meaning** *(recommended)* — the inert refusal uses the
   existing adapter-capability code (`ADAPTER_UNAVAILABLE`, carrying the runtime and
   the missing capability in its data); the dash-guard and malformed remotes use
   `INVALID_URL` (carrying the offending value), same as the HTTP parser's refusals.

## Decision

**Adopted-as-recommended (no user judgment): option 3.** No new error codes.
`ctx.ssh === undefined` on an ssh/scp remote → `ADAPTER_UNAVAILABLE` with data naming
the `ssh` capability; control characters, leading-dash host/path, and unparseable
remotes → `INVALID_URL` with the offending input in the error data. An `ssh` process
exiting non-zero surfaces as the existing `NETWORK_ERROR` with the exit code in
`reason` (ssh's stderr is inherited, never captured — no credential capture).

## Consequences

### Positive
- Callers distinguish capability absence from dangerous input with codes they already
  handle.
- Error-assertion tests stay specific (code + data), per the repo's mutation-testing
  conventions.

### Negative
- None identified — both codes pre-exist with matching semantics.

### Neutral
- The per-code error data shapes are pinned in unit tests; the refusal conditions are
  pinned against real git in the interop suite (git refuses the same dash-form
  remotes).
