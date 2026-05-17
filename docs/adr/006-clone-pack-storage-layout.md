# ADR-006: Received Packs Are Kept As `.pack` + `.idx`, Not Unpacked to Loose

## Status

Accepted (at `1c23aae`)

## Context

After `git-upload-pack` returns, tsgit holds the pack bytes in memory. Two storage strategies are possible for committing them to disk:

1. **Loose-unpack** — walk every entry in the pack, resolve OFS/REF deltas to base bytes, hash each object, and write each as `.git/objects/<xx>/<yyyy...>` via `writeObject`. Discard the pack.
2. **Keep-as-pack** — verify the pack trailer SHA, build an `.idx` over the entry table, write `pack-<sha>.pack` + `pack-<sha>.idx` to `.git/objects/pack/`. Do not unpack.

Both produce a repository whose `readObject(id)` returns the expected bytes. The trade-offs are concrete:

| Dimension | Loose-unpack | Keep-as-pack |
|-----------|--------------|--------------|
| Disk usage for a 50 MiB pack | ~150 MiB (loose objects are zlib-compressed individually; lose pack-level delta savings) | 50 MiB |
| Write count | N file writes (one per entry — 10k+ for a typical clone) | 2 writes (.pack + .idx) |
| Time to commit | O(N) syscalls + N decompress operations | O(1) syscalls + 0 decompress operations |
| `readObject` first-call cost | Already inflated — fast | Cold pack-registry probe + per-call inflate — slower first call, identical second-call cost (LRU cache) |
| Matches real git's layout | No — real git also keeps packs as packs | Yes |
| Compatibility with `git fsck` on the result | Yes (loose is valid) | Yes (pack + idx is standard) |
| Compatibility with existing `pack-registry` lookup path | Forces the read path to traverse loose-first then pack — pack-registry is unused | Pack-registry is used as designed |
| Future `repack` / `gc` work | Inverted — would need to re-pack later | Aligned — repack consolidates additional packs |

The Phase 2 `serializePackfile` + `serializePackIndex` were explicitly built so received packs could be written back to disk in the canonical format. The existing `pack-registry.ts` already handles cold-load of `.idx` files. The existing `object-resolver.ts` already inflates pack entries on demand, with the LRU `deltaCache` covering hot-path warmth.

A loose-unpack implementation would also need to handle delta-chain resolution mid-walk (already implemented in `object-resolver.ts`, but currently designed for the read path, not for bulk-unpack). Reusing it bulk-style would require building a transient pack-registry over the in-memory pack just to use the same resolver — a self-defeating round-trip.

## Decision

Received packs are written as **`.pack` + `.idx` to `.git/objects/pack/`**. No loose-unpack. The pack trailer SHA names the files (`pack-<sha>.pack`, `pack-<sha>.idx`) — matching canonical git's naming and making subsequent `git` CLI inspection of the cloned repo work without surprises.

The `.idx` is computed during pack-walk: for each entry, record `crc32(rawBytes)`, `offset`, and `resolvedObjectId`. `serializePackIndex` (Phase 2.8) handles the rest.

## Consequences

### Positive

- 3x smaller `.git` directory after clone.
- O(1) write count instead of O(N) — eliminates filesystem stress and brings the post-receive step to milliseconds on a small clone.
- `readObject` follows the same code path it does after every subsequent fetch — no special case for "just-cloned" repositories.
- The result is byte-identical to what `git clone` produces on disk, simplifying interop tests with the real git CLI.

### Negative

- The pack walker that builds the `.idx` lives in `fetch-pack.ts` and is its densest piece of new logic. It must correctly resolve OFS and REF deltas, including out-of-order REF_DELTAs (entries whose base appears later in the pack). Mitigation: extensive unit tests; mutation-testing target 100% on the walker.
- First-time `readObject` on a freshly-cloned ref pays the cold-cache inflate cost. Mitigation: the LRU `deltaCache` is shared with all subsequent reads, so steady-state perf is identical to the loose-unpack scenario.

### Neutral

- Subsequent fetches (Phase 12.2) add additional `.pack` files. Eventually a `repack` primitive (deferred, not in v1 scope) would consolidate them. Real git accumulates packs the same way until `git gc` runs.
- Pack-write uses `writeExclusive`. Filename collision on `pack-<sha>` is treated as a bug (the same SHA would mean the same pack, but the `TARGET_DIRECTORY_NOT_EMPTY` gate at clone start rules out the re-clone-into-existing-dir case).
