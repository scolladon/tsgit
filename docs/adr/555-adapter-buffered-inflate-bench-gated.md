# 555 — Browser and memory adapters get buffered inflate, gated on a bench

- **Status:** accepted
- **Date:** 2026-07-30
- **Design:** docs/design/whitespace-drop-fast-path.md · **Supersedes/Refines:** none

## Context

The fast path's win is not adapter-neutral. `NodeCompressor.inflate` is already
`inflateSync` — a pre-resolved Promise, no thread-pool hop, no `Zlib` instance churn — so
on Node the buffered arm is strictly cheaper. `BrowserCompressor.inflate` builds
`Blob → DecompressionStream → Response` and `MemoryCompressor.inflate` builds a
`DecompressionStream` per call, so on those adapters buffered inflate is at best a wash
against the streaming arm. Both, however, already ship a synchronous zero-dependency
whole-member decoder, `inflateZlibMember` in `src/adapters/inflate.ts`, which already
powers their `streamInflate`.

## Options considered

1. **Accept a Node-only win** — the gate stays adapter-blind, browser and memory see no
   improvement (but no regression either).
2. **Reimplement `BrowserCompressor.inflate` / `MemoryCompressor.inflate` over
   `inflateZlibMember`, gated on a bench against native `DecompressionStream`**
   (designer's recommendation) — pros: the fast path pays off on OPFS and e2e too, over
   an already-tested code path / cons: it changes every *other* `inflate` caller on those
   adapters (`tryLoose`, `collectDeltaChain`) — a wider blast radius than the rest of
   this design.
3. **A `Compressor` capability flag** so the gate is skipped where buffered inflate is
   not cheaper — rejected: a performance-detail capability verb on a port is exactly the
   surface ADR-387 refused to add.

## Decision

**Option 2**, ratified by the user, *with the bench gate intact*: reimplement only if the
comparison against native `DecompressionStream` on large inputs is clearly better;
otherwise fall back to option 1.

## Outcome of the gate

**The bench said no; the fallback applies.** Measured on this host over a 64 KiB / 1 MiB /
8 MiB ladder in both compressible and incompressible payloads, native
`DecompressionStream` beat the bundled decoder at **every** size — by 2.5× at 64 KiB
widening to 6.6× at 8 MiB — in both runs and both profiles. That is the opposite of the
failure mode this ADR guarded against (a decoder that wins small and loses large); the
pure-JS decoder loses at every scale and increasingly so. Option 2 is therefore **not**
taken: `BrowserCompressor.inflate` and `MemoryCompressor.inflate` are unchanged and the
Node-only win of option 1 stands. The bench is committed so the decision is reproducible
rather than asserted, and the numbers are in the design's Results section.

Because no adapter changed, the `test:parity:workers` / `deno` / `bun` obligation below
does not arise for this decision.

## Consequences

This is the one decision that is settled as a *conditional*, so the plan carries both
branches and an explicit, recorded decision point — the bench result and the branch taken
are stated in the PR body either way. Because the change would touch every `inflate`
caller on those adapters, the bench must use large inputs, not the small blobs this
design otherwise optimises for: the risk is a decoder that wins on 56 bytes and loses on
multi-megabyte objects. The `test:parity:workers` / `deno` / `bun` suites are **not** part
of `npm run validate` and must be run explicitly when this branch is taken.
