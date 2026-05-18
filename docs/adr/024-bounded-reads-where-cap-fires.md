# ADR-024: Where the `readObject({ maxBytes })` cap fires

## Status

Accepted (at `af6de38608353eb7d12ad4b83d137940fa9f5c56`)

## Context

Phase 13.8 introduces an opt-in cap on the maximum serialised size
of an object returned by `readObject` / `readBlob`. The goal is to
let `merge` (and any other caller that builds full-object buffers
in memory) reject obviously-too-large inputs upfront, before they
materialise. The question is **where** in the read pipeline the
cap should fire.

The read pipeline has three distinct shapes:

1. **Loose object** — `tryLoose` reads the compressed file from
   disk, `compressor.inflate` produces a `<type> <size>\0...`
   buffer, `parseObject` consumes it.
2. **Pack base entry** — `readEntryHeaderWithChunk` returns the
   header (which includes the declared inflated `length`), then
   `streamInflate` produces the payload.
3. **Pack delta entry** — `collectDeltaChain` walks
   OFS_DELTA/REF_DELTA chains, `applyDelta` reconstructs the
   final payload from the base + instructions.

Possible cap points:

- **A — inside `parseObject`** (domain). One point of enforcement,
  but `parseObject` is a pure domain function that has no concept
  of caller policy.
- **B — pre-inflate, header-only**. For loose objects we don't
  have the size until inflate completes (compressed → inflated
  ratio is unbounded). For pack base entries we DO have it from
  `parsePackEntryHeader`. For pack delta entries we have only the
  target-size varint at the top of the delta instructions.
- **C — post-inflate, post-resolve**. The most concrete point —
  after `current = applyDelta(...)` the final payload is in
  memory. We can measure and reject.
- **D — inside `resolveBaseForRefDelta`'s recursive call**. Recurse
  with the cap so the base of a REF_DELTA also enforces.

## Decision

The cap fires in three places, chosen for the bounded shape of
each pipeline branch:

1. **Loose objects** — after `compressor.inflate` returns and
   before `parseObject` is called. We check the inflated buffer
   length (a tight upper bound on the payload + a small header)
   against `maxBytes`. If over: throw. This is "B+inflate" in the
   taxonomy: we cannot avoid the inflate (compressed size doesn't
   tell us anything useful), but we DO avoid the parser pass.
2. **Pack base entries** — inside `collectDeltaChain`'s
   `isBase(header)` branch, we check `header.length > maxBytes`
   BEFORE the `streamInflate` call. This is the cheapest possible
   point: we pay the entry header parse (already required for
   chain traversal) and reject before any inflate happens. For
   adversarial 100 MiB-base scenarios, the inflate is bypassed.
3. **Pack delta entries** — POST-`applyDelta`, inside
   `resolvePackChain`'s bottom-up loop. After the final `current`
   payload is materialised but BEFORE `prependHeader` doubles the
   allocation. We check `current.length > maxBytes` once at the
   end. We do NOT attempt to pre-read the target-size varint
   inside the delta instructions to short-circuit earlier — see
   "Alternatives considered".
4. **REF_DELTA base recursion** — `resolveBaseForRefDelta` keeps
   passing `false` for `verifyHash`, but it currently does NOT
   plumb `maxBytes`. We deliberately omit propagation: the base
   of a REF_DELTA is a different object, the cap applies to the
   caller's target, not to intermediate dependencies. A 200 MiB
   base that resolves a 1 MiB target is allowed when the cap is
   set for the target.

We do NOT cap inside `parseObject` (rejection A). The domain
layer stays policy-free.

## Consequences

### Positive

- **Cheap pre-inflate rejection for the common pack case.** A
  hostile remote that delivers a 1 GiB base entry never causes us
  to inflate; the cap fires after a 64-byte header parse.
- **Loose objects bound the memory at the inflate boundary.** A
  hostile `.git/objects/xx/yy` file inflates once; the parser is
  never invoked on oversized input.
- **Delta chains pay the resolve cost but cap the peak.** The
  intermediate buffers during apply are bounded by the base size
  (which itself was capped if it came from a base entry). The
  final `current` is measured and rejected before
  `prependHeader` allocates the loose-format buffer.
- **The cap is at the application tier where Context lives.** The
  domain (`parseObject`, `applyDelta`) stays pure.

### Negative

- **Three enforcement sites, not one.** A future reader has to
  understand why. This ADR documents the rationale; the source
  comments back-reference §3 of the design doc.
- **Delta entries pay the apply cost even when oversized.** We
  could in principle read the top delta's target-size varint and
  reject earlier. We don't, because the simpler implementation
  has acceptable cost in practice — see Alternatives.
- **REF_DELTA bases bypass the cap when reached transitively.**
  This is the intended scope (cap = "the caller-visible object's
  size") but it does mean a chain of 200 MiB bases can still
  appear in memory during a 1 MiB target's resolution. The
  `deltaCache` caps cumulative residency through its byte budget.

### Neutral

- Matches the canonical-git `core.bigFileThreshold` philosophy:
  the threshold applies to the final returned object, not every
  intermediate buffer.
- Forward-compatible with adding `maxBytes` propagation into
  `resolveBaseForRefDelta` if a future audit decides recursive
  caps are needed.

## Alternatives considered

- **Cap inside `parseObject` (option A).** Rejected. Domain
  function, no Context, no caller policy. Adding `maxBytes` to
  the parser signature pollutes domain code with application
  concerns.
- **Cap by inspecting the delta target-size varint pre-apply.**
  Rejected for now. Delta chains are bounded at
  `MAX_DELTA_CHAIN_DEPTH = 50`, base sizes are typically modest,
  and the apply loop is in-place. The wins are marginal; the
  varint-parse code path adds a new failure mode (corrupted
  varint) for negligible benefit.
- **Cap at the LRU `deltaCache` boundary.** Rejected.
  `deltaCache` already enforces a byte budget; capping at the
  cache layer would conflate per-call limits with the cache's
  cross-call budget.
- **Propagate `maxBytes` into `resolveBaseForRefDelta`.**
  Considered. The semantic question is "does the cap apply to
  the target, or to every object reached during target
  resolution?" We picked target-only. If a future security
  review wants tighter limits on transitive base reads, the
  recursion is the right place to plumb it.
- **Reject by file size before inflate for loose objects (read
  compressed size, multiply by a conservative ratio).** Rejected.
  zlib's compression ratio is unbounded; a 1 KB compressed file
  can inflate to several GiB. The conservative multiplier would
  either be so loose it offers no protection, or so tight it
  rejects legitimate compressed objects.
