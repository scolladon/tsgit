---
subjects:
  - src/adapters/adler32.ts
  - src/adapters/inflate.ts
---
# 889 — The adler32 and growable-buffer riders land in this slice

- **Status:** accepted
- **Date:** 2026-09-22
- **Design:** docs/design/node-io-cold-read-pipeline.md (D9, DC-9) · **Supersedes/Refines:** none

## Context

`adler32.ts` is 55 % of the bundled inflate decoder's self time: a `for…of` loop with two
modulo operations per byte runs at 111 MiB/s where the NMAX = 5552 deferred-modulo loop runs at
1177 MiB/s with bit-identical output. `GrowableBuffer` in `inflate.ts` grows from a fixed start
although the declared entry size is known before inflate begins. Backlog item 31.6 owns the Node
compressor's per-entry stream cost; these two files do not overlap with it.

## Options considered

1. **In this slice, isolated, bit-identical, property-pinned** — pros: no file overlap with
   31.6; halves the bundled-vs-native gap at 1 MiB; a property test proves identity / cons: one
   more part. *Recommended by the design.*
2. **Defer to 31.6 with the compressor work** — cons: no dependency justifies the wait.

## Decision

**Option 1 — adopted-as-recommended (no user judgment).** The adler32 loop becomes the
deferred-modulo form with NMAX = 5552, pinned bit-identical to the current implementation by a
property test over arbitrary byte arrays and lengths, and `GrowableBuffer` is pre-sized from the
declared entry size when one is known.

## Consequences

- The bundled decoder's self time drops on every runtime without a native inflate.
- 31.6 touches `node-compressor.ts` only; no merge collision with this slice.
