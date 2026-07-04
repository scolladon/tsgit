# 451 — Correct v1 fallback request framing; advertise multi_ack_detailed

- **Status:** accepted
- **Date:** 2026-07-04
- **Design:** docs/design/incremental-fetch-negotiation.md · **Refines:** ADR-010 (fetch haves strategy) · **Relates:** ADR-450 (v2 primary), ADR-226 (git-faithfulness)
- **Decision class:** D-faithfulness (user judgment) — deviates from the design's recommendation

## Context

With v2 primary (ADR-450), v1 remains the fallback for v2-incapable servers. The v1 fetch
path carries a request-framing defect, pinned against real git 2.55.0 + `git-http-backend`:
`buildUploadPackRequest` builds the have-list with `encodePktStream`, which **unconditionally
appends a `0000` flush** (`domain/protocol/pkt-line.ts`), so a `haves + done:true` request
serializes as `want C1 <caps>\n · 0000 · have C0\n · 0000 · done\n`. That second `0000` is a
`compute-end = flush-pkt` in git's grammar — the server reads it as "non-final round, more
`have`s coming", replies ACK/NAK, and returns **no pack**. `clone` works (no haves → no flush).
A raw-POST matrix proved that removing the flush before `done` returns the pack **even without**
`multi_ack_detailed`. Separately, ADR-010 §Neutral left `multi_ack_detailed` unrequested;
canonical git advertises it and tsgit's parser already tolerates its `common` acks.

## Options considered

1. **Framing fix only, keep `multi_ack_detailed` stripped** *(design recommendation for the
   capability)* — self-contained; the outbound wire diverges from git's advertised caps but
   packs/refs/on-disk state are identical.
2. **Framing fix + advertise `multi_ack_detailed`** *(user choice)* — also un-strip the
   capability in `selectFetchCapabilities`; the outbound wire is closer to git; amends
   ADR-010 §Neutral.

The framing fix itself is a correctness bug fix, not a fork — it is adopted under both options.

## Decision

**Framing fix adopted (correctness, no fork):** a `haves + done` request serializes as
`want… \n · 0000 · have… \n · done\n` with **no flush between the last `have` and `done`**
(a no-flush encode path). `clone` (no haves) is unchanged. **Capability: Option 2, ratified by
the user** — un-strip `multi_ack_detailed`, amending ADR-010 §Neutral. ADR-010's single-round
strategy is **retained**: all `have`s (≤ `MAX_HAVES`) plus `done` in one POST; `common` acks are
tolerated but the client terminates in that one round — not multi-round negotiation (ADR-010
Strategy 2 stays subsumed by v2).

## Consequences

### Positive
- The v1 fallback correctly fetches incrementally (`want C1 / have C0 / done` → pack),
  byte-identical packs/refs to git.
- Advertised caps match canonical git's v1 wire.

### Negative
- Touches `domain/protocol/upload-pack.ts` (framing), a `domain/protocol/pkt-line.ts` no-flush
  encode helper, `domain/protocol/capabilities.ts`, and
  `application/commands/internal/upload-pack-client.ts` (`selectFetchCapabilities`).

### Neutral
- Under v2 (primary) the framing fix is dormant — v2 uses its own `fetch` request builder — but
  it guards every v1-fallback fetch, so it is load-bearing for no-regression.
- The bug slipped through because the `haves + done:true` case was untested in
  `upload-pack.test.ts`; a kill-test for it is mandatory.
