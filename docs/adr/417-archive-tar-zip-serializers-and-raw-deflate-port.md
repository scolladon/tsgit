# 417 — archive ships tar + zip; raw-DEFLATE is a native, zero-dependency port capability

- **Status:** accepted
- **Date:** 2026-06-26
- **Design:** docs/design/archive.md · **Refines:** ADR-226 (git-faithfulness) · **Relates:** the Compressor port (`src/ports/compressor.ts`), `domain/storage/crc32.ts`
- **Decision class:** D-SCOPE user-ratified (deviates from the design's "defer zip" recommendation)

## Context

The design recommended shipping the tar serializer now and **deferring zip**, on the
grounds that zip's compressed entries use **raw DEFLATE (RFC 1951)** while the `Compressor`
port only exposes zlib-wrapped DEFLATE (RFC 1950) — apparently a port-capability change.
The user asked whether raw DEFLATE is already reachable through the existing packing stack
without adding a dependency or a browser shim.

Investigation of the three adapters settled it:

- **node** (`src/adapters/node/node-compressor.ts`) uses `node:zlib`, which exposes
  `deflateRawSync` in the *same module* it already imports.
- **browser** (`src/adapters/browser/browser-compressor.ts`) and **memory**
  (`src/adapters/memory/memory-compressor.ts`) use the Web `CompressionStream`, which
  accepts `'deflate-raw'` in the *same API* they already call with `'deflate'`.
- **CRC32 already exists** — `src/domain/storage/crc32.ts` (used by `fetch-pack`).

So zip needs **no new dependency and no browser shim**: raw DEFLATE is native in every
adapter, and CRC32 is in-tree. The "port capability" is one method delegating to a
primitive each adapter already uses. This materially de-risks shipping zip now.

## Options considered

1. **Entry stream only** — pros: smallest; cons: ships a Tier-1 `archive` that cannot
   itself produce an archive — surprising, dumps framing on every consumer.
2. **tar now, defer zip** *(designer recommendation)* — pros: tar needs no compression at
   all; cons: leaves `archive` half-built and proposes a follow-up for a capability that,
   it turns out, is already native.
3. **tar + zip now, via a native `deflateRaw` port capability** *(user choice)* — pros:
   complete in one PR, no dependency, no shim; cons: adds one port method + three thin
   adapter implementations and their tests.

## Decision

**Option 3 — user-ratified.** Ship both serializers in this change.

- Add `deflateRaw(data: Uint8Array, level?: number): Promise<Uint8Array>` to the
  `Compressor` port. Each adapter delegates to the platform primitive it **already uses**:
  node → `node:zlib` `deflateRawSync`; browser + memory → `new CompressionStream('deflate-raw')`.
  **Zero new dependencies, no shim.**
- Reuse the in-tree `crc32` for zip's CRC fields.

**Byte-identity contract (faithfulness) — empirically pinned, NOT universal.** The DEFLATE
*bitstream* is zlib-implementation-coupled: git's linked zlib and node's bundled zlib
produce **different valid** raw-DEFLATE for some inputs. Verified against git 2.54.0: a
highly-compressible blob (`20000×'A'`) coincides byte-for-byte (both 37 bytes), but a
varied 69-byte `.gitmodules` **diverges** — git emits 64 bytes, node:zlib emits 67 (no
level matches). git's own `git archive` output is likewise not stable across zlib/git
versions. So perfect method-8 byte-faithfulness is **portably impossible** and is **not**
the contract. The faithful, achievable contract — the same **equivalence-under-readback**
precedent the loose-object compressors already document — is:

- **method-0 (stored) entries and ALL framing** — local file headers, the central
  directory, CRC32, the *uncompressed* size, extra fields, external/internal attrs, the
  end-of-central-directory record + commit-oid comment — are **byte-identical to git on
  every adapter** (none of it passes through DEFLATE). The store-vs-deflate **method
  decision** matches git.
- **method-8 (compressed) entries are faithful by ROUND-TRIP, not by byte-identity**: the
  payload is valid raw-DEFLATE that inflates to git's exact content. Its compressed bytes
  (and hence that entry's `csize` field and the downstream byte offsets) match git's only
  *incidentally*, when the two zlibs coincide for that input — never relied upon. This
  holds equally for node-vs-git and for cross-adapter (browser/memory) — node is **not**
  privileged.
- The interop test therefore compares **structurally**: same entry set/order/method, same
  CRC/usize/attrs/comment, method-0 payloads byte-equal, method-8 payloads round-trip to
  git's content. A whole-archive byte-equality assertion is kept **only** for an
  all-stored fixture (no DEFLATE in play), where it is robust.

## Consequences

- The `Compressor` port gains `deflateRaw` (interface + node/browser/memory implementations
  + tests). It is additive — existing `deflate` is untouched.
- Both `domain/archive/tar.ts` and `domain/archive/zip.ts` ship in this change.
- The deviation from the design's "defer zip" prose and DC2 recommendation, plus the
  design's "Out of scope: zip", are revised under the scope-fold rule before planning.
- No deferred-zip backlog follow-up is filed — zip lands here.
