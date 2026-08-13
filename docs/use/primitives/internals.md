# Internal building blocks

Internal building blocks that power the Tier-1 commands. Most are exported from `@scolladon/tsgit/primitives` for advanced composition (but **not** bound on `repo.primitives.*`); a few are **fully internal** — reachable only by the commands themselves — and are listed here to document how the porcelain works, not as a public surface. Each entry names the source file under `src/application/primitives/`; that file is the canonical reference for the signature.

Alphabetical.

### `applyChangeset`
`apply-changeset.ts`. Apply a computed working-tree changeset (writes, deletes, chmods). Used by [`checkout`](../commands/checkout.md) and [`reset`](../commands/reset.md) (`hard`).

### `buildIndexFromTree`
`build-index-from-tree.ts`. Project a tree to a stage-0 IndexEntry list with stat-cache donor preservation. Used by [`reset`](../commands/reset.md) (`mixed`), [`checkout`](../commands/checkout.md).

### `buildPack`
`build-pack.ts`. Construct a packfile from an enumerated object set. Returns the pack bytes, the trailer SHA, the object count, and `entries` — `serializePackfile`'s own per-entry crc32 and offset metadata, in `input.oids` order, so a caller writing a matching `.idx` reuses the offsets and checksums the serializer already computed instead of deriving them a second time. Used by [`push`](../commands/push.md), [`packObjects`](../commands/pack-objects.md), [`bundle`](../commands/bundle.md) (`create`).

### `computeChangeset`
`compute-changeset.ts`. Tree-vs-working-tree diff for the dirty-tree guard. Used by [`checkout`](../commands/checkout.md), [`reset`](../commands/reset.md), [`status`](../commands/status.md).

### `computeClosure`
`internal/closure-engine.ts` (plus `internal/bitmap-binding.ts`, `internal/pack-bitmap-binding.ts`, `internal/midx-bitmap-binding.ts`, `internal/bitmap-container.ts`, `internal/pack-artefact-source.ts`, `internal/closure-not-marks.ts`, `internal/object-emit.ts`). **Fully internal.** The shared reachability closure [`revList`](../commands/rev-list.md) and [`packObjects`](../commands/pack-objects.md) both compose over the same `wants AND NOT not` question. The caller supplies a required `tier` (`'walk'` or `'bitmap'`) — the engine holds no default, since the two commands disagree on which to default to. `'bitmap'` prefers a usable multi-pack-index bitmap for the in-use generation, then a usable per-pack bitmap, decoding the EWAH streams and trusting them exactly as git trusts them — no digest check on this read path; verification stays in [`fsck`](../commands/fsck.md). Any fault along that path — none present, unreadable, structurally refused, or a decoded position out of range for the artefact it indexes — falls back to the walk silently: no error, no signal that the fallback happened. Object `path` is a walk-only product: a bitmap encodes reachability and each object's type, never a name, so `path` is always absent on the bitmap tier regardless of `objects`.

### `createPackRegistry`
`pack-registry.ts` (plus the internal `midx-source.ts`, `midx-binding.ts` and `pack-shared.ts`). Fully internal. Lazy, single-flight scan of `.git/objects/pack/` — one scan no matter how many concurrent first readers — plus one persistent, promise-memoised `FileHandle` per pack for delta-chain reads. The same scan also discovers `objects/pack/multi-pack-index` (flat, else the `multi-pack-index.d/` chain) and, when one loads, treats it as **authoritative** for the packs it names: a pack the midx claims that is gone or unusable makes its objects report missing even though a sibling pack in the same midx still holds them, exactly like git; a pack the midx does not name is served by the ordinary per-pack scan as before. A `.idx` missing its sibling `.pack` is excluded from the generation at scan time (one warn, no I/O — the listing is already in hand); a `.idx` that is corrupt or unreadable is now classified lazily, the first time something touches that pack (a lookup, or a forced `health()`/`all()` walk), rather than eagerly for every pack at scan time. A pack whose index claims a requested object gets a memoised 12-byte header probe at lookup — signature, version (2 or 3), header-vs-index object count — and is skipped per pack if unusable (its objects report missing, other packs and loose objects still serve, no negative cache), mirroring git's open-time validation. Midx corruption follows git's own two tiers: a structurally self-inconsistent midx or chain layer denies every read through the `Context` — loose objects included — until the on-disk state changes; a merely-unusable one (too small, unreadable, an offset outside the file, a hash-version mismatch) is discarded with one warn and every read falls back to the `.idx` scan. [`fsck`](../commands/fsck.md) audits the same registry through a cache-bypassing `Context` view (the session delta cache is cleared, never a second registry) so an integrity check never gets an answer the cache masked for an object a fresh decode would refuse. `refresh()` retires and closes the outgoing pack set — and re-reads the midx — after a lazy fetch; `dispose()` awaits any in-flight scan, closes every handle it ever opened, and is terminal. One registry per `Context`, behind every packed-object read ([`readObject`](read-object.md), [`readBlob`](read-blob.md), [`streamBlob`](stream-blob.md)) and `fsck`'s enumeration. The offset table (`buildOffsetTable`, behind `nextOffsetForEntry`'s successor lookup on every packed-object read) consults a pack's own `.rev` only once that pack carries at least `REV_INDEX_MIN_OBJECTS` objects, the measured point from which the O(n) gather outruns sorting the offsets directly; below it the artefact is never opened at all, because the cost of opening one is essentially fixed per pack and a repository between `git gc` runs would otherwise pay it once per pack for no gain. When it does load, the body is trusted exactly as git trusts it — no digest check on this path. Every other artefact state (absent, unreadable, structurally refused, or a decoded position out of range for the pack it indexes) falls back silently to sorting the offsets, comparator-free over a `Float64Array` — the same job canonical git does with a radix sort. The registry also exposes `midxBitmap()`, the accessor `computeClosure`'s bitmap tier consumes for the midx-bitmap preference; the per-pack bitmap fallback loads directly off the packs `all()` already lists.

### `enumerateObjects`
`enumerate-objects.ts`. Enumerate every object id in the database (loose ∪ pack-index), sorted and de-duplicated. Takes an optional `accessiblePacksOnly` flag (default `false`) that restricts the pack half to packs whose header gate passes — [`fsck`](../commands/fsck.md)'s own universe knob, not a general filter; the default preserves cat-file-like enumeration, since every other surface (git's `cat-file --batch-all-objects`, `count-objects`) still lists a refused pack's ids. Used by `fsck`.

### `enumeratePushObjects`
`enumerate-push-objects.ts`. Diff local vs remote heads to compute the push-pack object set. Used by [`push`](../commands/push.md).

### `enumerateRefs`
`enumerate-refs.ts`. List every ref (loose + packed). Used by [`branch`](../commands/branch.md), [`tag`](../commands/tag.md), [`fetch`](../commands/fetch.md).

### `fetchPack`
`fetch-pack.ts`. Smart-HTTP `git-upload-pack` exchange — discover refs, send `want`/`have`, receive pack. Used by [`clone`](../commands/clone.md), [`fetch`](../commands/fetch.md), [`fetchMissing`](../commands/fetch-missing.md).

### `invalidateConfigCache`
`config-read.ts`. Drop the in-memory `.git/config` cache. Use after an out-of-band edit.

### `isWorkingTreeDirty`
`apply-changeset.ts`. Predicate over a computed changeset. Used by [`checkout`](../commands/checkout.md)'s dirty-tree guard.

### `loadSparseMatcher`
`read-sparse-checkout.ts`. Compile `.git/info/sparse-checkout` to a `(path) => boolean` matcher. Used by [`sparseCheckout`](../commands/sparse-checkout.md), [`checkout`](../commands/checkout.md), [`reset`](../commands/reset.md).

### `materializeTree`
`materialize-tree.ts`. Apply a tree to the working tree (writes, deletes, chmods, symlinks). Used by [`checkout`](../commands/checkout.md), [`reset`](../commands/reset.md) (`hard`), [`merge`](../commands/merge.md) clean path.

### `readConfig`
`config-read.ts`. Read `.git/config` (INI tokenizer; reused by `.gitmodules` parsing in submodules).

### `recordRefUpdate`
`record-ref-update.ts`. **Fully internal.** The single reflog *writer*: reads config, applies the autocreate gate, resolves identity, sanitises the message, appends one entry. It moves no ref — [`updateRef`](update-ref.md) is the coherent public surface that writes the ref *and* records the matching reflog atomically. Used internally by [`clone`](../commands/clone.md), [`checkout`](../commands/checkout.md), [`commit`](../commands/commit.md), [`rebase`](../commands/rebase.md), and `updateRef`.

### `writeSymbolicRef`
`write-symbolic-ref.ts`. **Fully internal.** Write a `ref: <target>` symbolic ref (HEAD and friends) atomically, validating both names. Used internally by [`init`](../commands/init.md), [`checkout`](../commands/checkout.md), [`branch`](../commands/branch.md), [`rebase`](../commands/rebase.md) to set or move HEAD's symbolic pointer.

### `appendReflog`
`reflog-store.ts`. Append one entry to `.git/logs/<ref>`. Called via `recordRefUpdate`.

### `deleteReflog`
`reflog-store.ts`. Drop one entry by index, optionally rewriting subsequent entries.

### `listReflogs`
`reflog-store.ts`. Enumerate refs that have a reflog.

### `readReflog`
`reflog-store.ts`. Read entries for one ref.

### `readShallow`
`shallow-file.ts`. Read `.git/shallow` boundaries. Parses git's strict grammar at the repository's oid width; throws `SHALLOW_FILE_MALFORMED` on malformed content or more than 500 000 entries.

### `readSparsePatternText`
`read-sparse-checkout.ts`. Read raw `.git/info/sparse-checkout` text (no compilation).

### `reflogExists`
`reflog-store.ts`. Predicate over `.git/logs/<ref>`.

### `resolveReflogIdentity`
`reflog-identity.ts`. Resolve the identity for reflog entries (config + portable fallback).

### `writeReflog`
`reflog-store.ts`. Bulk write entries for one ref (used by `expire`).

### `setConfigEntry` · `setCoreConfigEntry` · `updateConfigEntries` · `updateCoreConfig`
`update-config.ts`. Targeted line-surgery writers for `.git/config`. Used by [`clone`](../commands/clone.md) (promisor + partial-clone config), [`sparseCheckout`](../commands/sparse-checkout.md).

### `sparseCheckoutPath`
`path-layout.ts`. Canonical path for `.git/info/sparse-checkout`.

### `synthesizeTreeFromIndex`
`synthesize-tree-from-index.ts`. Inverse of `buildIndexFromTree` — synthesize a tree from staged entries. Used by [`checkout`](../commands/checkout.md) (`{ paths, source: 'index' }`).

### `updateShallow`
`shallow-file.ts`. Write `.git/shallow` boundaries. Refuses (`SHALLOW_FILE_MALFORMED`) before writing when the resulting set would exceed the entry cap or an added oid's width doesn't match the repository hash.

### `writePackArtifacts`
`internal/write-pack-artifacts.ts`. **Fully internal.** Writes a pack's sibling artefacts in git's own order: `.pack`, `.idx`, an optional `.promisor` sentinel, then `.rev` last — `.rev` last because pack discovery keys on the `.pack`/`.idx` pair, so a concurrent reader that observes the pair before the `.rev` lands just takes the absent-artefact arm. The `.rev` write is gated by `pack.writeReverseIndex` (default `true`), resolved *before* any file is created, so a value git's boolean grammar refuses leaves the pack directory untouched. `buildIdx`/`buildRev` (same file) assemble each artefact's bytes — a body/trailer split where `ctx.hash` fills the trailer in place. Used by `fetchPack`, [`packObjects`](../commands/pack-objects.md).

### `writeSparsePatternText`
`write-sparse-checkout.ts`. Write raw `.git/info/sparse-checkout` text.
