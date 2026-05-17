# ADR-013: Push Pack Encoding — Non-Delta v1

## Status

Accepted (at `d7ecbac`)

## Context

`push` (Phase 12.3) needs to send a packfile to `git-receive-pack`. The
client controls every byte the server receives, so the encoding choice is
purely local. Three encodings are candidates:

1. **Non-delta** — every object as a base entry (type 1–4), content
   `deflate`d directly. Pack body is the sum of compressed object sizes
   plus per-entry headers.
2. **OFS_DELTA against the previous-emitted similar object** — pick a
   "similar" base via heuristic (same path, same filename, prior commit),
   emit `OFS_DELTA` to that base. Saves bytes when consecutive trees or
   blobs share content.
3. **REF_DELTA against haves the server advertised** — emit deltas whose
   base is a server-side oid. Server can resolve the delta because it
   already has the base. Requires the `thin-pack` capability.

Delta computation requires a non-trivial similarity selector, the actual
delta encoder, and (for option 2) maintenance of an "emitted bases" lookup
that survives across the enumeration. The encoder is bounded but not
trivial: roughly 200–400 LOC of state machine across a sliding-window
hash.

`fetchPack` already implements the *reader* side of all three formats, so
the reception side is paid for. The question is which encoding the writer
produces.

## Decision

Phase 12.3 emits **only non-delta entries (option 1)**.

Concretely, `buildPack(ctx, { oids })` reads each oid via `readObject` →
`serializeObject` to canonical loose form (`<type> <size>\0<content>`) →
strip the loose-form header → `ctx.compressor.deflate(content)` → assemble
the entry with `encodePackEntryHeader(type, uncompressedSize)`. The pack
header declares `objectCount = oids.length`, the body is the concatenation
of those entries in arbitrary stable order (we use the order
`enumeratePushObjects` yielded), and the trailer is
`ctx.hash.hashBytes(body)`.

## Consequences

### Positive

- **Minimal scope.** No delta selector, no delta encoder, no base cache.
  The encoder is ~80 LOC and a single test pins the wire format
  bit-for-bit against canonical git's `pack-objects` output.
- **Faster client.** No CPU spent on delta computation. `push` becomes
  I/O-bound on the network, not compression.
- **Easier to audit.** Every object the server receives is base-encoded;
  there is no "delta against unknown server-side oid" surface. The pack
  is self-contained.
- **Mutation-resistant.** Non-delta encoding has fewer state machine
  branches; Stryker's mutation hit rate on a delta encoder is
  notoriously brittle.

### Negative

- **Wasted bandwidth.** A push of a single one-line README edit re-sends
  the full blob. Canonical git's delta encoder would emit ~30 bytes
  instead of (compressed-content) bytes. For Phase 12.3's target
  workload (developer pushes branch with a few commits), this is small —
  typical commits touch trees that compress well in isolation.
- **Server-side delta repack is still triggered.** The server's `gc`
  will eventually re-pack our objects with deltas. We pay the bandwidth,
  not the storage.

### Neutral

- **`thin-pack` capability not advertised by us.** Even though the
  server may advertise it, we never produce thin packs. The selection
  helper drops `thin-pack` from the capability intersection.
- **A future `pack-deltify` primitive can land independently.** The
  contract of `buildPack` is "produce a valid pack". Switching to delta
  encoding is a private optimization that does not change the API.
  Tracked in BACKLOG §12.5.

### Alternatives considered

- **Server-driven encoding (option 3, thin-pack).** Requires negotiating
  `thin-pack` and trusting the server's advertised oids as deltifiable
  bases. The reader side handles thin packs at receive; the writer
  side has no symmetric advantage. Rejected for scope.
- **Same-path-history heuristic (option 2).** Adds ~250 LOC of base
  selection plus a delta encoder. Deferred to a separate phase where
  the encoder + tests can be the unit of work rather than wedged into
  push.
