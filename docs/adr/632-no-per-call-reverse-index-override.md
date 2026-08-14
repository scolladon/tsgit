# 632 — No per-call reverse-index override

- **Status:** accepted — **adopted-as-recommended (no user judgment)**
- **Date:** 2026-08-13
- **Design:** docs/design/rev-on-idx-write.md (DC-9)

## Context

A `writeReverseIndex?: boolean` option could be added to `PackObjectsOptions` and/or the
fetch surfaces, overriding the config per call.

## Decision

None — the config key is the only switch. git's equivalent flag lives on plumbing
`index-pack`, which tsgit does not expose; the porcelain surfaces (`clone`, `fetch`,
`pack-objects` porcelain) have no such flag. Adding one pays the full public-surface tax
(barrel, facade, `api.json`, docs page, browser scenario — the Tier-1 surface gates) for
a knob no caller asked for.

## Consequences

If a plumbing `index-pack` command ever lands, the flag belongs there, matching git's
placement.
