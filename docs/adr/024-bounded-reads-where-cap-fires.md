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
   before `parseObject` is called. We measure the **actual
   content byte count** (`inflated.length - contentOffset`), NOT
   the declared header size. The declared size is attacker-
   controllable; the actual buffer length is what zlib already
   materialised in memory, which is the quantity the cap exists
   to bound. This is "B+inflate" in the taxonomy: we cannot avoid
   the inflate (compressed size doesn't tell us anything useful),
   but we DO avoid the parser pass.
2. **Pack base entries** — inside `collectDeltaChain`'s
   `isBase(header)` branch, we check `header.size > maxBytes`
   BEFORE the `streamInflate` call (where `header.size` is the
   declared inflated payload size from the entry's varint
   header). This is the cheapest possible point: we pay the
   entry header parse (already required for chain traversal)
   and reject before any inflate happens. For adversarial 100
   MiB-base scenarios, the inflate is bypassed. The cap fires
   at any depth in the chain — see Decision §2 below.
3. **Pack delta entries — pre-apply on the outermost delta's
   varint, plus post-apply on `current`.** When `collectDeltaChain`
   reads the FIRST (outermost) delta in the chain, we call
   `readDeltaTargetSize(instructions)` to read just the two
   leading varints — cheap (~10 bytes) and bypasses BOTH the
   delta-apply loop AND the final `new Uint8Array(targetSize)`
   allocation that the cap exists to prevent. Post-apply check on
   `current.length` is retained as defence-in-depth in case the
   declared varint and actual produced size disagree. The
   defensive double-check is cheap (one comparison) and protects
   against malformed deltas whose declared target size
   underestimates the actual output.
4. **REF_DELTA base recursion — `resolveBaseForRefDelta` PLUMBS
   `maxBytes`.** Pass-1 security review flagged the original
   "target-only" semantics as a hole: a hostile REF_DELTA whose
   base is a 4 GiB object would inflate the base fully before
   any cap fired (the post-apply check sees only the combined
   result, not the raw base). We now thread `maxBytes` into both
   `resolveBaseForRefDelta`'s recursive `resolveObject` call AND
   the cache-hit branch. The cap applies to every object
   materialised during target resolution.
5. **LRU cache hits — re-enforce the cap.** A previous uncapped
   call may have admitted an oversized object into
   `ctx.deltaCache`; a later capped call returns it from cache
   without going through the read pipeline. `enforceCachedCap`
   measures content bytes (`length - (nulIdx + 1)`) before
   returning bytes from `resolveBaseForRefDelta`'s cache-hit
   branch. Pass-1 security review HIGH-2.

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

- **Four enforcement sites, not one.** A future reader has to
  understand why. This ADR documents the rationale; the source
  comments back-reference §3 of the design doc.

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
  Accepted after pass-1 perf review. Pass-1 perf reviewer
  pointed out that `applyDelta` already parses the same varint
  to size its result allocation — so there's no NEW failure
  mode (a corrupted varint surfaces the same `INVALID_DELTA`
  with or without the pre-check), and the pre-check skips the
  entire apply loop plus the `new Uint8Array(targetSize)`
  allocation that the cap exists to prevent. Cost: ~10 bytes
  of varint scan via `readDeltaTargetSize`. Net win for
  adversarial inputs.
- **Cap at the LRU `deltaCache` boundary.** Rejected.
  `deltaCache` already enforces a byte budget; capping at the
  cache layer would conflate per-call limits with the cache's
  cross-call budget.
- **Propagate `maxBytes` into `resolveBaseForRefDelta`.**
  Accepted after pass-1 security review. The semantic question
  is "does the cap apply to the target, or to every object
  reached during target resolution?" Original choice was
  target-only, with the rationale that a REF_DELTA's base is a
  different object. Pass-1 security review demonstrated that a
  large unbounded base still allocates fully in memory before
  the post-apply check fires — the cap stops protecting against
  the threat it exists to address. We now plumb `maxBytes`
  through the recursion. The cap applies to every object
  materialised during target resolution.
- **Reject by file size before inflate for loose objects (read
  compressed size, multiply by a conservative ratio).** Rejected.
  zlib's compression ratio is unbounded; a 1 KB compressed file
  can inflate to several GiB. The conservative multiplier would
  either be so loose it offers no protection, or so tight it
  rejects legitimate compressed objects.
