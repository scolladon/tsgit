/**
 * Lazy scan + cache of .idx files under .git/objects/pack/.
 * Returns a PackRegistry facade used by object-resolver and readObject.
 */
import { TsgitError, type TsgitErrorData } from '../../domain/error.js';
import { errorDataCode } from '../../domain/error-data-code.js';
import type { ObjectId } from '../../domain/objects/index.js';
import { invalidPackHeader, invalidPackIndex } from '../../domain/storage/error.js';
import {
  createLruCache,
  type LruCache,
  lookupPackIndex,
  type MultiPackIndex,
  type PackEntryHeader,
  type PackIndex,
  type PackRevIndex,
  parsePackIndex,
} from '../../domain/storage/index.js';
import {
  PACK_HEADER_SIZE,
  type PackHeader,
  parsePackHeader,
} from '../../domain/storage/pack-entry.js';
import type { Context } from '../../ports/context.js';
import type { DirEntry } from '../../ports/file-system.js';
import {
  bindMidx,
  computeMidxHealth,
  findMidxHit,
  type MidxHealth,
} from './internal/midx-binding.js';
import { loadMidxSet, type MidxLoadResult } from './internal/midx-source.js';
import {
  type ArtefactLoad,
  loadBitmapBytes,
  loadPackRevIndex,
  midxBitmapName,
} from './internal/pack-artefact-source.js';
import {
  emptyGeneration,
  type IndexedPack,
  NO_PACKS,
  type PackGeneration,
  resolveIndexes,
} from './internal/pack-generation.js';
import {
  nextOffsetForEntry,
  type PackOffsetTable,
  resolveOffsetTable,
} from './internal/pack-offset-table.js';
import { packPositionMap, revIndexPositions } from './internal/pack-positions.js';
import {
  faultContext,
  faultReason,
  isSafePackName,
  isSkippableIdxFault,
  isSkippablePackFault,
  packBaseName,
} from './internal/pack-shared.js';
import {
  createPackWindowCache,
  type PackWindowCache,
  packWindowBudgetFor,
} from './internal/pack-window-cache.js';
import { createPromiseMemo, type PromiseMemo } from './internal/promise-memo.js';
import { assertRepoSettingsValid } from './internal/repo-settings-gate.js';
import { deltaBaseCacheBudgetFor } from './internal/resolve-delta-base-cache-limit.js';
import { commonGitDir, packsDir } from './path-layout.js';
import { exceedsMaxPackIdxBytes, REASON_PACK_IDX_EXCEEDS_MAX } from './validators.js';

export type { MidxHealth, PackGeneration, PackOffsetTable };
export { faultReason, isSkippableIdxFault, isSkippablePackFault, nextOffsetForEntry };

// Discriminates "this adapter cannot open persistent handles" (the browser
// adapter's openWithNoFollow refusal) from errno-mapped faults that share the
// same code — mapErrno folds unrecognised errnos (EMFILE, EIO, …) into
// UNSUPPORTED_OPERATION with operation 'filesystem', and those must surface,
// not silently reroute every later read through the per-call fallback.
function isUnsupportedOperation(err: unknown): boolean {
  return (
    err instanceof TsgitError &&
    err.data.code === 'UNSUPPORTED_OPERATION' &&
    err.data.operation === 'openWithNoFollow'
  );
}

export interface RegisteredPack {
  readonly name: string;
  /**
   * Memoised `.idx` read + parse — one bounded read per pack, on first use,
   * never at scan time. A rejection is **not** memoised (the next caller
   * retries); the ONE site that classifies a rejection as skippable (a
   * corrupt or unreadable `.idx`) rather than propagating it is the
   * generation's `resolveIndexes`, never a call site of `index()` itself.
   */
  readonly index: () => Promise<PackIndex>;
  readonly packPath: string;
  readonly idxPath: string;
  /**
   * Memoised 12-byte header read + validation — git's `open_packed_git_1` gate.
   * Rejects with `INVALID_PACK_HEADER` for a bad signature, a short file, a
   * version outside 2|3, or a header/index `objectCount` disagreement. One read
   * per pack per successful validation; a rejection clears the memo, so a
   * refused pack is re-probed on the next lookup that hits its index.
   */
  readonly header: () => Promise<PackHeader>;
  /**
   * Lazily-built, cached sorted entry offsets + trailer bound for this pack.
   * Callers must hold a `PackLookupHit` from `lookup` — the header gate's
   * completeness rests on every pack-byte read passing through `lookup` first,
   * and nothing here structurally forces that to stay true.
   */
  readonly offsetTable: () => Promise<PackOffsetTable>;
  /**
   * Read `length` bytes at `offset` via a lazily-opened, memoised persistent
   * `FileHandle` — one `open` per pack for its whole delta-chain walk, not one
   * per step. Falls back to a per-call `ctx.fs.readSlice` on adapters that
   * cannot open a handle (browser OPFS throws `UNSUPPORTED_OPERATION`).
   * Callers must hold a `PackLookupHit` from `lookup` — the header gate's
   * completeness rests on every pack-byte read passing through `lookup` first,
   * and nothing here structurally forces that to stay true.
   */
  readonly readSlice: (offset: number, length: number) => Promise<Readonly<Uint8Array>>;
  /** Release the persistent handle, if one was ever opened. Idempotent. */
  readonly close: () => Promise<void>;
  /** Whether this pack's `.rev` sibling was present in the scan's own file
   *  listing — a symlinked `.rev` is not present, the same no-follow rule
   *  every other artefact's discovery already enforces. */
  readonly hasRevIndex: boolean;
  /**
   * Memoised, bounded read + parse of this pack's reverse index — one read
   * per pack, on first use, never at scan time. An unusable `.idx` is never
   * reachable here in practice: the fsck rev-index pass only calls this for
   * packs in `registry.all()`, which already excludes any pack whose `.idx`
   * never parsed, mirroring canonical git's own "no index, no reverse
   * index" rule.
   */
  readonly revIndex: () => Promise<ArtefactLoad<PackRevIndex>>;
  /**
   * Pack position → index position, for every position `[0, objectCount)` —
   * the `.rev` body read in O(n) when usable, `packPositionMap(index)`
   * (O(n log n)) otherwise: absent, unreadable, refused, or a body carrying
   * an out-of-range value. A second memo, distinct from
   * `buildOffsetTable`'s own fallback (which keeps its plain-sort path
   * verbatim); both depend on the same `revIndex()` loader, so the `.rev` is
   * read at most once per pack per generation and classified once. Read by
   * the bitmap closure tier to turn a decoded pack position into an oid —
   * never by anything that must run before an artefact's range validation
   * has passed.
   */
  readonly packPositions: () => Promise<Uint32Array>;
  /** Whether this pack's `.bitmap` sibling was present in the scan's own
   *  file listing — a symlinked `.bitmap` is not present, the same
   *  no-follow rule every other artefact's discovery enforces. */
  readonly hasBitmap: boolean;
  /**
   * Memoised, bounded read of this pack's bitmap — one read per pack, on
   * first use, never at scan time. Never parsed: the `fsck` bitmap pass's
   * entire obligation is a trailing-checksum comparison over these raw
   * bytes. An unusable `.idx` is never reachable here in practice, the same
   * rule `revIndex` documents: the fsck bitmap pass only calls this for
   * packs in `registry.all()`.
   */
  readonly bitmapBytes: () => Promise<ArtefactLoad<Uint8Array>>;
}

/**
 * The in-use multi-pack-index's bitmap. `artefact` is the composed file name
 * (`multi-pack-index-<hex>.bitmap`), carried alongside the load so a
 * consumer need not recompute it; `midx` is the in-use midx LAYER itself
 * (never parsed by this module — only carried through), the object a bitmap
 * consumer needs for `objectCount`/`reverseIndexOffset` and for mapping a
 * decoded position back to an oid. Present regardless of the bitmap load's
 * own outcome: it costs nothing beyond what `scanPacks` already computed to
 * bind the midx, and the `fsck` bitmap pass still verifies only the
 * trailing checksum over the raw bytes, never reaching into `midx`.
 */
export type MidxBitmapLoad = {
  readonly artefact: string;
  readonly midx: MultiPackIndex;
} & ArtefactLoad<Uint8Array>;

export interface PackLookupHit {
  readonly pack: RegisteredPack;
  readonly offset: number;
}

/**
 * A resolved OFS/REF-delta chain level's `(type, content)` — already
 * header-split, so a hit never re-runs the loose-format split a raw-bytes
 * cache would need. `(packName, offset)` is only meaningful within the
 * generation that produced it, which is exactly the registry's lifetime
 * between one `refresh()` and the next.
 */
export interface DeltaBaseCacheEntry {
  readonly type: PackEntryHeader['type'];
  readonly content: Uint8Array;
  /**
   * How many MORE delta applications lie between this entry and the true
   * base of its chain (0 for the base itself). A probe hit short-circuits
   * the walk that would otherwise have counted those levels one at a time —
   * without this, a warm cache lets a chain deeper than
   * `MAX_DELTA_CHAIN_DEPTH` succeed by resuming from a shallower point that
   * hides how much chain lies beneath it.
   */
  readonly chainDepth: number;
}

/** The one key shape for {@link PackRegistry.deltaBaseCache} — a pack name and
 *  an on-disk byte offset are only meaningful together, within one generation. */
export function deltaBaseCacheKey(packName: string, offset: number): string {
  return `${packName}:${offset}`;
}

/**
 * A pack or index `health()` could not use, and at which layer. `data` is the
 * raw fault and may carry an absolute `path` — never forward it across the
 * library boundary; project to `code`/`reason` as the fsck pack pass does.
 */
export interface UnusablePack {
  readonly name: string;
  readonly layer: 'pack' | 'index';
  readonly data: TsgitErrorData;
}

/** Per-pack accessibility for the current generation — see `PackRegistry.health`. */
export interface PackHealth {
  readonly accessible: ReadonlyArray<RegisteredPack>;
  readonly unusable: ReadonlyArray<UnusablePack>;
}

export interface PackRegistry {
  all(): Promise<ReadonlyArray<RegisteredPack>>;
  /**
   * Every regular-file name the current generation's directory scan saw —
   * the SAME set `hasRevIndex`/`hasBitmap` already consult per pack. Exposed
   * so a caller can classify a pack by sibling marker
   * (`.keep`/`.promisor`/`.mtimes`, see {@link classifyPackFiles}) at zero
   * extra I/O — never a second `readdir` of `objects/pack/`.
   */
  fileNames(): Promise<ReadonlySet<string>>;
  lookup(id: ObjectId): Promise<PackLookupHit | undefined>;
  /**
   * Await the store gate — the multi-pack-index load alone — for its
   * rejection only, discarding the result. Canonical git dies during
   * object-store setup on exactly one thing, a structurally
   * self-inconsistent multi-pack-index, and on nothing else: this is the
   * single gate that reproduces that death ahead of EVERY read — loose
   * objects included — before any loose-vs-pack branch is even reached.
   * Returns `void` on purpose: it must never become a second way to reach
   * the packs. Never forces the deferred pack-directory scan or
   * `generation.indexed` — that would pay every pack's `.idx` load eagerly
   * and defeat the point of loading indexes lazily.
   */
  assertLoadable(): Promise<void>;
  /** Drop BOTH the cached multi-pack-index gate and the `.idx` scan, so the
   *  next read re-probes the multi-pack-index and the next `all`/`lookup`
   *  re-lists the pack directory — used after a lazy-fetch writes a new pack,
   *  which may ship a new midx as well as new packs. */
  refresh(): void;
  /**
   * Incremental re-scan for a full-object-miss retry — git's
   * `reprepare_packed_git`, never `refresh()`'s teardown. Re-lists
   * `objects/pack` and the multi-pack-index gate, but REUSES the existing
   * `RegisteredPack` instance (same `.idx` memo, handle, window keys) for
   * every pack whose NAME the new listing still carries — git's own
   * `pack_map` identity, keyed by path/name, never mtime or size. A pack
   * whose name vanished from the listing is retired (closed, in the
   * background — see `settleRefresh`); a newly-listed name is loaded fresh.
   * Deliberately leaves the delta-base cache and the pack window cache
   * untouched: a reused instance's per-instance window keys stay valid, and
   * a retired instance's keys become unreachable on their own, so nothing
   * needs evicting. Never call from a caller that just WROTE a pack — that
   * caller wants `refresh()`'s full teardown, not a reuse-preserving rescan.
   */
  reprepare(): Promise<void>;
  /**
   * Await every handle close a prior `refresh()`/`reprepare()` parked for
   * background completion, without disposing the registry. A caller about to
   * unlink a retired pack must drain first: on Windows an open `FileHandle`
   * may refuse the unlink outright, and on every platform an unlinked-but-open
   * pack keeps its bytes allocated until the fd closes.
   */
  settleRefresh(): Promise<void>;
  /** Close every loaded pack's persistent handle. Idempotent; a registry
   *  that never scanned the pack directory disposes without touching `fs`. */
  dispose(): Promise<void>;
  /**
   * Per-pack health for the CURRENT generation — the integrity view `fsck`
   * needs and nothing else needs. Probes every registered pack's header, so
   * it is the ONE caller that opens packs a lookup would have left alone:
   * never call it from a read path. Costs one 12-byte `ctx.fs.readSlice` per
   * registered pack whose header memo is not already settled, and opens no
   * `FileHandle`. Rejects — never reports — on a fault outside the two
   * allow-lists. The verdict is memoised per generation so every consumer in
   * one run sees ONE consistent report (`refresh()` resets it); the per-pack
   * header memo itself still clears on rejection, so the read path keeps its
   * no-negative-cache property.
   */
  health(): Promise<PackHealth>;
  /**
   * The scan layer's skip records alone — every `.idx` the generation
   * excluded, with its fault. Derived from the memoised scan: never probes a
   * pack header, never opens anything. The cheap half of `health()` for
   * consumers (fsck's ungated rev-index term) that must not pay the probe.
   */
  indexFaults(): Promise<ReadonlyArray<UnusablePack>>;
  /**
   * The multi-pack-index's own accessibility + integrity verdict — the ONE
   * state `fsck`'s midx pass consumes. A second, independent reader of the
   * same bytes `lookup` reads: it re-derives pack binding and
   * entry resolution rather than reusing `lookup`'s memoised view, so a
   * fault that only a full walk surfaces (an entry whose `pack-int-id` or
   * `large-offset` decodes out of range) is caught here even when no read
   * ever touched it. The verdict is memoised per generation, exactly as
   * `health()` is, and reset by `refresh()` with the scan.
   */
  midxHealth(): Promise<MidxHealth>;
  /**
   * The in-use multi-pack-index's bitmap, or `undefined` when there is no
   * usable midx for the current generation — the state `fsck`'s bitmap pass
   * needs and nothing else needs. Memoised per **generation**, not per
   * pack: the artefact's name depends on the midx layer in use, so a
   * `refresh()` that changes the midx changes the artefact this resolves
   * to.
   */
  midxBitmap(): Promise<MidxBitmapLoad | undefined>;
  /**
   * Offset-keyed cache for delta-chain intermediates — every OFS/REF-delta
   * level `collectDeltaChain`/`resolvePackChain` (object-resolver.ts) walks
   * through, not just a chain's tip. Lives here, per-registry, rather than
   * on a `Context`: `(packName, offset)` is only meaningful within the
   * generation that produced it, and `refresh()`/`dispose()` clear it
   * alongside everything else generation-scoped. Sized once, from the
   * Context that first creates this registry — see `createPackRegistry`.
   */
  readonly deltaBaseCache: LruCache<DeltaBaseCacheEntry>;
}

function isCandidate(entry: { isFile: boolean; name: string }): boolean {
  return entry.isFile && entry.name.endsWith('.idx') && isSafePackName(entry.name);
}

/** Every registered pack sorted into exactly one of gc's four file classes. */
export interface PackFileClassification {
  /** `*.keep`-marked — git's total opt-out. Not read for repacking,
   *  not rewritten, not deleted; its objects are neither duplicated into the
   *  new pack nor migrated to the cruft pack, even when unreachable. */
  readonly kept: ReadonlyArray<RegisteredPack>;
  /** `.promisor`-marked — a second, disjoint consolidation class. Every
   *  promisor object repacks whole into one new promisor pack, never merged
   *  with the normal one; it is not an exclusion the way a kept pack is. */
  readonly promisor: ReadonlyArray<RegisteredPack>;
  /** `.mtimes`-marked — the existing cruft pack, owned by the cruft
   *  lifecycle, never by consolidation. */
  readonly cruft: ReadonlyArray<RegisteredPack>;
  /** Carries none of the three markers — consolidated into the one new pack. */
  readonly normal: ReadonlyArray<RegisteredPack>;
}

/**
 * Step 1b's classifier: sorts every candidate pack into exactly one of four
 * file classes by pure sibling lookup against `fileNames` — the SAME set
 * `hasRevIndex`/`hasBitmap` already consult, so this costs zero extra I/O.
 * Checked in this order and mutually exclusive: `.keep` wins over
 * everything (a pack carrying `.keep` AND `.mtimes`, or `.keep` AND
 * `.promisor`, is kept — never cruft or promisor), `.promisor` wins over
 * `.mtimes` and the default, and only a pack with none of the three markers
 * is normal.
 */
export function classifyPackFiles(
  packs: ReadonlyArray<RegisteredPack>,
  fileNames: ReadonlySet<string>,
): PackFileClassification {
  const kept: RegisteredPack[] = [];
  const promisor: RegisteredPack[] = [];
  const cruft: RegisteredPack[] = [];
  const normal: RegisteredPack[] = [];
  for (const pack of packs) {
    if (fileNames.has(`${pack.name}.keep`)) kept.push(pack);
    else if (fileNames.has(`${pack.name}.promisor`)) promisor.push(pack);
    else if (fileNames.has(`${pack.name}.mtimes`)) cruft.push(pack);
    else normal.push(pack);
  }
  return { kept, promisor, cruft, normal };
}

async function readBoundedIdx(ctx: Context, idxPath: string): Promise<Uint8Array> {
  // Pre-check stat; reject .idx files large enough to exhaust heap before
  // any allocation. Mirrors the readIndex pattern.
  const stat = await ctx.fs.stat(idxPath);
  if (exceedsMaxPackIdxBytes(stat.size)) {
    throw invalidPackIndex(REASON_PACK_IDX_EXCEEDS_MAX);
  }
  const bytes = await ctx.fs.read(idxPath);
  // Post-check defends against TOCTOU growth between stat and read.
  if (exceedsMaxPackIdxBytes(bytes.length)) {
    throw invalidPackIndex(REASON_PACK_IDX_EXCEEDS_MAX);
  }
  return bytes;
}

// Every `loadPack` call gets its own token — a replaced pack reuses the same
// NAME, but never the same token, so a late window fill from an outgoing
// pack's in-flight read can never land under a successor's own cache key
// (see `loadPack`'s `windowCacheKey`).
let nextPackInstanceToken = 0;

function loadPack(
  ctx: Context,
  dir: string,
  entryName: string,
  fileNames: ReadonlySet<string>,
  windowCache: PackWindowCache,
): RegisteredPack {
  const idxPath = `${dir}/${entryName}`;
  const name = packBaseName(entryName);
  // Distinct from `name`: `name` is the stable, human-facing pack identity
  // (`RegisteredPack.name`, log context, cache keys elsewhere); this is the
  // window cache's OWN key, scoped to this one `loadPack` call so a
  // same-named successor never shares a cached window with the pack it
  // replaced.
  const windowCacheKey = `${name}#${nextPackInstanceToken++}`;
  const packPath = `${dir}/${name}.pack`;
  const revPath = `${dir}/${name}.rev`;
  const hasRevIndex = fileNames.has(`${name}.rev`);
  const bitmapPath = `${dir}/${name}.bitmap`;
  const hasBitmap = fileNames.has(`${name}.bitmap`);

  // Not read here — scanPacks builds the candidate list with no `.idx` I/O.
  // The first caller to force this memo (directly, or via the generation's
  // resolveIndexes classification) pays the one bounded read.
  const indexMemo = createPromiseMemo(
    async (): Promise<PackIndex> =>
      parsePackIndex(await readBoundedIdx(ctx, idxPath), ctx.hashConfig.digestLength),
  );

  // Depends on indexMemo for objectCount — safe even for an unindexable pack:
  // the fsck rev-index pass never calls this on a pack outside `all()`, and
  // any other caller forcing it on such a pack simply inherits indexMemo's
  // own rejection, same as every other index-derived accessor here.
  const revIndexMemo = createPromiseMemo(async (): Promise<ArtefactLoad<PackRevIndex>> => {
    const index = await indexMemo.get();
    return loadPackRevIndex(
      ctx,
      revPath,
      hasRevIndex,
      ctx.hashConfig.digestLength,
      index.objectCount,
    );
  });

  // Depends on indexMemo for objectCount — same trust rule as revIndexMemo:
  // the fsck bitmap pass only calls this for packs in `registry.all()`,
  // which already excludes any pack whose `.idx` never loaded.
  const bitmapMemo = createPromiseMemo(async (): Promise<ArtefactLoad<Uint8Array>> => {
    const index = await indexMemo.get();
    return loadBitmapBytes(ctx, bitmapPath, hasBitmap, index.objectCount);
  });

  // Pack position -> index position, read straight out of the same `.rev`
  // load `revIndexMemo` already memoises — one `Uint32Array` filled in
  // place, since the body already stores exactly this table. An
  // out-of-range value falls back to `packPositionMap`, the same posture
  // `buildOffsetTable`'s successor lookup takes for a corrupt `.rev` value.
  // Never warns here for a REFUSED artefact: `buildOffsetTable`'s own
  // `resolveOffsetTable` call already warns once for that fault when it
  // runs, and this memo has no independent finding to report. An
  // out-of-range STORED VALUE is different — `buildOffsetTable`'s lazy
  // successor discovers that lazily, on the first query that probes it, and
  // now DOES warn once (the whole pack degrades to the sorted fallback at
  // that point, not just the one query), so this memo's own silent fallback
  // here is a second, independent path to the same degraded state — the
  // `fsck` pass remains the authority for surfacing it as a finding.
  const packPositionsMemo = createPromiseMemo(async (): Promise<Uint32Array> => {
    const index = await indexMemo.get();
    const load = await revIndexMemo.get();
    if (load.kind === 'usable') {
      const stored = revIndexPositions(load.value, index.objectCount);
      if (stored !== undefined) return stored;
    }
    return packPositionMap(index);
  });

  // Lazily-opened, memoised persistent handle for this pack's slice reads.
  // The memo clears itself on any open rejection (a transient EMFILE must
  // not pin later reads — or dispose() — to a stale fault), and the
  // known-unsupported arm below (browser OPFS) clears it too so every later
  // `readSlice` falls back cleanly; `close()` tolerates a rejected memo and
  // closes nothing.
  const handleMemo = createPromiseMemo(() => ctx.fs.openWithNoFollow(packPath, 'read'));
  // `refresh()` closes outgoing packs while sibling reads may still be
  // mid-slice on this instance: in-flight reads are tracked so `close()`
  // drains them first, and a read arriving after `close()` falls back to the
  // per-call path instead of re-opening a handle nothing would ever close.
  const inFlight = new Set<Promise<unknown>>();
  let retired = false;

  // The handle-based half of `packSize` — split out so its whole span (open
  // + fstat) can be tracked in `inFlight` the same way `readSlice` tracks its
  // own reads: without that, `close()`'s `Promise.allSettled(inFlight)` drain
  // sails past a probe still mid-`fstat`, and the handle it closes underneath
  // that probe surfaces as a raw, unmapped fault instead of a clean size.
  const sizeViaHandle = async (): Promise<number> => {
    const handle = await handleMemo.get();
    return (await handle.stat()).size;
  };

  // Pack file size via fstat on the held handle — one syscall cheaper than a
  // path stat, and consistent with every other read now going through this
  // same handle. A retired pack (closed by refresh()) never reopens one, so
  // it stats by path instead, mirroring readSlice's own retired arm; the
  // browser-shaped UNSUPPORTED_OPERATION arm (no persistent handles) falls
  // back to the same path stat.
  const packSize = async (): Promise<number> => {
    if (retired) return (await ctx.fs.stat(packPath)).size;
    const probe = sizeViaHandle();
    inFlight.add(probe);
    try {
      return await probe;
    } catch (err) {
      if (!isUnsupportedOperation(err)) throw err;
      handleMemo.clear();
      return (await ctx.fs.stat(packPath)).size;
    } finally {
      inFlight.delete(probe);
    }
  };
  const sizeMemo = createPromiseMemo(packSize);

  // Loads `size` bytes at `base` through the held handle into a FRESH
  // buffer — no per-call zero-fill of a caller-supplied length, since the
  // window cache owns the allocation and reuses it across every request the
  // window covers. Clamped to the pack's own end, mirroring the window
  // cache's "a short window at file end returns a short view" contract.
  const loadWindow = async (base: number, size: number): Promise<Uint8Array> => {
    const handle = await handleMemo.get();
    const packFileSize = await sizeMemo.get();
    const clampedSize = Math.max(0, Math.min(size, packFileSize - base));
    const buffer = new Uint8Array(clampedSize);
    const bytesRead = await handle.read(buffer, 0, clampedSize, base);
    return buffer.subarray(0, bytesRead);
  };

  const readSlice = async (offset: number, length: number): Promise<Uint8Array> => {
    if (retired) return ctx.fs.readSlice(packPath, offset, length);
    const read = windowCache.read(windowCacheKey, offset, length, loadWindow);
    inFlight.add(read);
    try {
      return await read;
    } catch (err) {
      if (!isUnsupportedOperation(err)) throw err;
      handleMemo.clear();
      return ctx.fs.readSlice(packPath, offset, length);
    } finally {
      // NOTE: this block's BlockStatement mutant (`{}`) is equivalent — inFlight's only
      // reader is close()'s `Promise.allSettled(inFlight)`, which settles identically
      // whether or not already-settled entries remain (an already-settled promise adds no
      // wait and its outcome is discarded), so dropping this deletion cannot change any
      // observable return value or thrown error — only when the settled reference becomes
      // eligible for GC. No inline ignore-comment can attach here and stay equivalent-only,
      // scoped: a comment placed before this block (outside the catch clause) would need
      // `} finally {` split across lines, which the formatter always collapses back onto
      // one line, and a comment placed inside the block (as here) attaches to the first
      // STATEMENT's line, not the block's own line, so it can never target this exact
      // mutant's reported location (verified against the instrumenter's comment handling).
      inFlight.delete(read);
    }
  };

  // The header now rides the pack window cache, sharing its window with
  // whatever else falls in [0, windowBytes) — the header is no longer a
  // special path-based read, so a scan that only ever probes headers still
  // opens the pack exactly once. The browser-shaped UNSUPPORTED_OPERATION
  // arm inside readSlice already falls back to a path read, so this needs
  // no fallback of its own.
  const headerMemo = createPromiseMemo(async (): Promise<PackHeader> => {
    const index = await indexMemo.get();
    const header = parsePackHeader(await readSlice(0, PACK_HEADER_SIZE));
    if (header.objectCount !== index.objectCount) {
      throw invalidPackHeader(
        `object count disagrees with index: pack ${header.objectCount}, index ${index.objectCount}`,
      );
    }
    return header;
  });

  const buildOffsetTable = async (): Promise<PackOffsetTable> => {
    const index = await indexMemo.get();
    const packFileSize = await sizeMemo.get();
    // The pack file trailer is a single pack-checksum digest (SHA-1: 20 bytes,
    // SHA-256: 32 bytes). The last entry's data ends exactly at trailerStart.
    const trailerStart = packFileSize - ctx.hashConfig.digestLength;
    if (trailerStart < 0) {
      throw invalidPackIndex('pack file too small to contain a trailer');
    }
    // A present, loadable `.rev` always wins — resolveOffsetTable answers
    // with a lazy, `.rev`-backed table and never materialises an O(n) sorted
    // array for it. `revIndexMemo.get` is passed through rather than
    // awaited here, so the SAME single-flight `.rev` load this pack's other
    // consumers (packPositionsMemo) share is reused, not duplicated.
    return resolveOffsetTable(ctx, name, index, revIndexMemo.get, packFileSize, trailerStart);
  };
  const offsetTable = createPromiseMemo(buildOffsetTable).get;

  const close = async (): Promise<void> => {
    retired = true;
    const pending = handleMemo.clear();
    if (pending === undefined) return;
    // Let sibling reads that already hold the handle finish before closing
    // it under them (their own rejections surface to their callers).
    await Promise.allSettled(inFlight);
    // A pending open that rejected has no handle to close; its error already
    // surfaced to the read that triggered it and must not resurface here.
    const handle = await pending.catch(() => undefined);
    if (handle === undefined) return;
    await handle.close();
  };

  return {
    name,
    index: indexMemo.get,
    packPath,
    idxPath,
    header: headerMemo.get,
    offsetTable,
    readSlice,
    close,
    hasRevIndex,
    revIndex: revIndexMemo.get,
    packPositions: packPositionsMemo.get,
    hasBitmap,
    bitmapBytes: bitmapMemo.get,
  };
}

/**
 * Resolve one `.idx` candidate to a `RegisteredPack`, or `undefined` when its
 * sibling `.pack` is missing from this scan's own listing (an orphaned `.idx`
 * is garbage, never a pack). The orphan warn fires here, at scan time,
 * because it needs no I/O to detect. The pack's `.idx` itself is not read
 * here — that happens lazily, the first time something forces `pack.index()`
 * (see `resolveIndexes`).
 *
 * `reusable` is `reprepare()`'s carry-forward set, keyed by pack name — the
 * SAME identity git's `pack_map` uses. A name still present there is served
 * its EXISTING instance (warm `.idx` memo, handle, window keys) instead of a
 * freshly constructed one; `undefined` (the cold-scan and `refresh()` path)
 * always constructs fresh.
 */
function loadCandidatePack(
  ctx: Context,
  dir: string,
  entry: { readonly name: string },
  fileNames: ReadonlySet<string>,
  windowCache: PackWindowCache,
  reusable: ReadonlyMap<string, RegisteredPack> | undefined,
): RegisteredPack | undefined {
  const name = packBaseName(entry.name);
  if (!fileNames.has(`${name}.pack`)) {
    ctx.logger?.warn?.('packRegistry: skipping pack index with no pack file', {
      idx: entry.name,
    });
    return undefined;
  }
  return reusable?.get(name) ?? loadPack(ctx, dir, entry.name, fileNames, windowCache);
}

const unusableEntry = (
  name: string,
  layer: UnusablePack['layer'],
  data: TsgitErrorData,
): UnusablePack => ({ name, layer, data });

/**
 * List `objects/pack` once per generation — the single listing the store
 * gate and the scan now share. `readdir` on a missing directory maps to
 * `FILE_NOT_FOUND` on every adapter; `NOT_A_DIRECTORY` covers a regular file
 * sitting where the directory should be (node's `ENOTDIR`); `PERMISSION_DENIED`
 * and any other coded errno fold the same way. Canonical git agrees on every
 * one of these shapes: it prints an `error: unable to open object pack
 * directory: …` line and keeps serving loose reads at exit 0, never
 * refusing. An absent directory is the ordinary state of a young repository
 * and stays silent, as git's `opendir` ENOENT path does; every other coded
 * fault is reported once here, through `ctx.logger?.warn` with the fault
 * attached (no logger → silent, never a refusal), where git prints its
 * `unable to open object pack directory` line. An error carrying no data code is a programming error and is
 * rethrown, never folded.
 *
 * Structural on `data.code`, never `instanceof`: this classifies an error
 * thrown by `ctx.fs`, so in a mixed-module-graph harness (a source-graph
 * registry over a dist-bundle Context) the adapter's `TsgitError` is a
 * different class identity than this module's — the hazard
 * `domain/error-data-code.ts` documents, and the reason every `ctx.fs`
 * absence probe shares `errorDataCode`.
 */
async function listPackDir(ctx: Context): Promise<ReadonlyArray<DirEntry>> {
  const dir = packsDir(commonGitDir(ctx));
  try {
    return await ctx.fs.readdir(dir);
  } catch (error) {
    const code = errorDataCode(error);
    if (code === undefined) throw error;
    if (code === 'FILE_NOT_FOUND') return [];
    const { data } = error as { readonly data: TsgitErrorData };
    ctx.logger?.warn?.('packRegistry: unreadable pack directory', { dir, ...faultContext(data) });
    return [];
  }
}

// git dies during object-store setup ahead of every read, and the ONLY
// thing it dies on is a structurally self-inconsistent multi-pack-index —
// the directory listing and pack construction below are invisible to a
// successful loose read's outcome. So the gate is exactly the midx load,
// and its Tier-B discard diagnostic belongs here too: git prints that one
// on a loose read. `listing` is the shared `packDirListing` memo's `get` —
// forcing the gate now also answers "does objects/pack name a
// multi-pack-index (or a chain)" for `loadMidxSet`, at no I/O beyond the one
// listing every read already pays.
function createStoreGate(
  ctx: Context,
  listing: () => Promise<ReadonlyArray<DirEntry>>,
): PromiseMemo<MidxLoadResult> {
  const loadStoreGate = async (): Promise<MidxLoadResult> => {
    const entries = await listing();
    const midxLoad = await loadMidxSet(
      ctx,
      packsDir(commonGitDir(ctx)),
      new Set(entries.map((entry) => entry.name)),
    );
    for (const fault of midxLoad.faults) {
      ctx.logger?.warn?.('packRegistry: discarding unusable multi-pack-index', {
        artefact: fault.artefact,
        ...faultContext(fault.data),
      });
    }
    return midxLoad;
  };
  return createPromiseMemo(loadStoreGate);
}

/**
 * Passive promotion onto the settled (synchronous) lookup walk — for the
 * plain read-walk shape (log, checkout, diff) that never calls `all()`/
 * `health()` and so never forces `generation.indexed`'s own bounded-parallel
 * scan. Tracks each UNCLAIMED candidate's own `index()` outcome as
 * `lookupUnsettled`'s lazy loop resolves it organically, one lookup at a
 * time; once every unclaimed candidate in a generation has settled —
 * typically once enough misses have walked the whole list — a later lookup
 * takes the cheap synchronous walk with zero further `pack.index()` calls,
 * exactly like the `all()`/`health()`-forced case already does. Never forces
 * anything itself: an untouched pack simply never contributes an entry, and
 * settlement never completes until it does. Keyed by generation OBJECT
 * identity, so a `refresh()`/`reprepare()`'s new generation starts tracking
 * from empty; no explicit cleanup is needed; the old generation's entry
 * drops once nothing else references it.
 *
 * Measured (30 packs, no midx, 20k sequential misses, in-memory adapter):
 * ~30% faster once settled than staying on the per-pack-await walk forever.
 */
interface UnclaimedProgress {
  readonly results: Map<RegisteredPack, PackIndex | undefined>;
  readonly total: number;
  settledPacks: ReadonlyArray<IndexedPack> | undefined;
}

const unclaimedProgressByGeneration = new WeakMap<PackGeneration, UnclaimedProgress>();

function unclaimedProgressFor(
  generation: PackGeneration,
  isClaimed: (pack: RegisteredPack) => boolean,
): UnclaimedProgress {
  const existing = unclaimedProgressByGeneration.get(generation);
  if (existing !== undefined) return existing;
  const total = generation.packs.reduce((count, pack) => (isClaimed(pack) ? count : count + 1), 0);
  const created: UnclaimedProgress = { results: new Map(), total, settledPacks: undefined };
  unclaimedProgressByGeneration.set(generation, created);
  return created;
}

/** Records one candidate's outcome and, once every candidate has one,
 *  materialises the synchronous-walk snapshot exactly once — later fixes to
 *  a since-repaired `.idx` are out of scope: a pack's bytes never change
 *  without a new generation, which tracks fresh under its own object. */
function recordUnclaimedResult(
  generation: PackGeneration,
  progress: UnclaimedProgress,
  pack: RegisteredPack,
  index: PackIndex | undefined,
): void {
  progress.results.set(pack, index);
  if (progress.settledPacks !== undefined || progress.results.size < progress.total) return;
  const settled: IndexedPack[] = [];
  for (const candidate of generation.packs) {
    const result = progress.results.get(candidate);
    if (result !== undefined) settled.push({ pack: candidate, index: result });
  }
  progress.settledPacks = settled;
}

/**
 * Entry-count ceiling for the delta-base cache, mirroring the parsed-object
 * memo and the commit-graph header cache's own caps — a byte cap alone
 * under-defends a repo of many small, cheap-to-cache intermediates.
 */
const DELTA_BASE_CACHE_MAX_ENTRIES = 65_536;

export async function createPackRegistry(ctx: Context): Promise<PackRegistry> {
  await assertRepoSettingsValid(ctx);
  const packDirListing = createPromiseMemo(() => listPackDir(ctx));
  const storeGate = createStoreGate(ctx, packDirListing.get);
  // Both budgets read `core.*` config independently, but NEVER sequentially:
  // run concurrently, their two `readConfig` calls fall inside the same
  // coalescing window (`config-read.ts`'s per-session single-flight stat),
  // so construction pays one shared stat for the pair instead of two
  // separate ones stacked after the repo-settings gate's own.
  const [deltaBaseCacheBudget, windowBudget] = await Promise.all([
    deltaBaseCacheBudgetFor(ctx),
    packWindowBudgetFor(ctx),
  ]);
  // A SEPARATE, ADDITIONAL byte budget from the ordinary delta cache's own —
  // not a share carved out of it. The two caches hold different things (raw
  // loose-format bytes vs. header-split reconstructed delta bases) and
  // compete only for process memory, not a shared accounting ledger. Sized
  // from `core.deltaBaseCacheLimit` (git's own dial for this cache, resolved
  // once here, at construction — never re-derived on `refresh()`), an
  // explicit `ctx.cacheBudgets` override, or git's 96 MiB default.
  const deltaBaseCache = createLruCache<DeltaBaseCacheEntry>(
    deltaBaseCacheBudget,
    DELTA_BASE_CACHE_MAX_ENTRIES,
  );
  // Registry-wide window cache backing every RegisteredPack.readSlice — one
  // LRU shared across every pack this registry loads, so a window evicted
  // for one pack can make room for another's. Sized once here, at
  // construction; never re-derived on `refresh()`.
  const windowCache = createPackWindowCache(windowBudget);

  // `reprepare()`'s carry-forward set, consumed exactly once by the NEXT
  // `scanPacks` run it triggers — set and read with no `await` between, so no
  // other caller can observe or steal it mid-flight. `undefined` for every
  // other path (the cold first scan, and `refresh()`), which always builds
  // fresh instances.
  let reuseFrom: ReadonlyMap<string, RegisteredPack> | undefined;

  const scanPacks = async (): Promise<PackGeneration> => {
    const priorPacks = reuseFrom;
    reuseFrom = undefined;
    const dir = packsDir(commonGitDir(ctx));
    // storeGate.get() directly, not currentGate(): scanPacks is reachable
    // only through currentGeneration(), which already refuses to start once
    // disposed, so the gate wrapper's own disposal check would be dead
    // weight here. Captured synchronously alongside the listing — not
    // awaited first — so a scan in flight keeps its own consistent
    // MidxLoadResult. The midx warn now lives inside the gate (above); the
    // orphan-.idx warn below stays here, on the deferred side, because git is
    // silent about an orphan .idx on a loose read — only the midx load denies
    // one.
    //
    // The Promise.all overlap now only pays off for a consumer that forces the
    // scan with NO prior read — fsck's health/midxHealth/indexFaults, a bare
    // all(). On the object-read paths assertLoadable has already settled the
    // gate, so this arm resolves immediately and the listing is serial: that
    // costs a packed cold read the round-trip the two used to share, which is
    // the accepted price of not listing the directory on a loose hit.
    //
    // packDirListing is the SAME memo the store gate above forces to build
    // loadMidxSet's entry set — a directory fault (a missing directory,
    // PERMISSION_DENIED, …) already folded to an empty listing there, with
    // its own warn; scanPacks never re-classifies it and never sees it as a
    // rejection.
    const [midxLoad, entries] = await Promise.all([storeGate.get(), packDirListing.get()]);
    // git registers a pack only when its .pack exists by name — an orphaned
    // .idx is garbage, never a pack. The listing already in hand is the same
    // data, so the check costs no I/O.
    // Regular files only: a symlinked .pack is out of scope by the same
    // no-follow policy the data reads enforce, so its .idx drops here too.
    const fileNames = new Set(entries.filter((entry) => entry.isFile).map((entry) => entry.name));
    const packs: RegisteredPack[] = [];
    for (const entry of entries) {
      if (!isCandidate(entry)) continue;
      const pack = loadCandidatePack(ctx, dir, entry, fileNames, windowCache, priorPacks);
      if (pack !== undefined) packs.push(pack);
    }
    const midx =
      midxLoad.set === undefined ? undefined : bindMidx(ctx, packs, midxLoad.set, fileNames);
    // Named from the in-use layer's STORED trailer bytes,
    // never a recomputed digest: a rename, or a midx whose own trailer
    // disagrees with its bytes, both simply compose a name this scan's own
    // `fileNames` does not carry — "not present" needs no special case.
    const midxBitmapMemo = createPromiseMemo(async (): Promise<MidxBitmapLoad | undefined> => {
      if (midx === undefined) return undefined;
      const head = midx.set.layers[midx.set.layers.length - 1]!;
      const artefact = midxBitmapName(head);
      const load = await loadBitmapBytes(
        ctx,
        `${dir}/${artefact}`,
        fileNames.has(artefact),
        head.objectCount,
      );
      return { artefact, midx: head, ...load };
    });
    // Created before `indexed` below so both share the SAME set: a lazy
    // lookup's `unclaimedIndexOrSkip` and this generation's bulk
    // `resolveIndexes` warn into it interchangeably, and whichever runs
    // first claims the one warn for a given `.idx`.
    const warnedIdx = new Set<string>();
    return {
      packs,
      midxLoad,
      midx,
      indexed: createPromiseMemo(() => resolveIndexes(ctx, packs, warnedIdx)),
      warnedIdx,
      fileNames,
      midxBitmap: midxBitmapMemo,
    };
  };
  const scan = createPromiseMemo(scanPacks);

  let disposed = false;
  const pendingCloses = new Set<Promise<unknown>>();

  // Only ever handed a promise that cannot reject (Promise.allSettled never does),
  // or this bookkeeping .finally would become an unhandled rejection of its own.
  const trackClose = (settled: Promise<unknown>): void => {
    pendingCloses.add(settled);
    // Stryker disable next-line BlockStatement: equivalent — a never-shrinking pendingCloses only makes drainPendingCloses's Promise.allSettled await already-settled entries too, which resolves immediately with no observable outcome change; the only effect is the settled reference staying reachable instead of becoming eligible for GC
    void settled.finally(() => {
      pendingCloses.delete(settled);
    });
  };

  const drainPendingCloses = async (): Promise<void> => {
    // allSettled, not all: the drain must never re-raise — a tracked batch is
    // allSettled-derived and cannot reject, but the drain does not rest on
    // that invariant holding forever.
    await Promise.allSettled([...pendingCloses]);
  };

  // Terminal disposal binds the read path too: once disposed, never start a
  // scan — its packs would be unreachable from refresh() (a no-op by then)
  // and from dispose() (already resolved), so nothing could ever close their
  // handles. A memo still populated keeps returning the closed, retired
  // generation — including a pending scan that later rejects, whose error
  // reaches these read callers exactly as it reaches pre-dispose joiners. An
  // empty memo (never scanned, or self-cleared by a scan rejection) resolves
  // empty instead of scanning.
  const currentGeneration = (): Promise<PackGeneration> => {
    if (!disposed) return scan.get();
    return scan.peek() ?? Promise.resolve(emptyGeneration());
  };
  // Mirrors currentGeneration's terminal-disposal rule for the gate alone:
  // once disposed, never start a new midx load. A gate already forced keeps
  // returning its settled (or still in-flight) result; an idle gate — never
  // forced, or self-cleared by its own rejection — resolves to the empty
  // load instead of starting one.
  const currentGate = (): Promise<unknown> =>
    disposed ? (storeGate.peek() ?? Promise.resolve()) : storeGate.get();
  const allPacks = async (): Promise<ReadonlyArray<RegisteredPack>> => {
    const generation = await currentGeneration();
    return (await generation.indexed.get()).packList;
  };

  // Pure over its fault list, so computeHealth can derive both halves of one
  // report from the SAME indexed snapshot — awaiting the memo twice would let
  // a refresh() interleave and mix two generations into one verdict.
  const indexFaultsOf = (
    faults: ReadonlyArray<{ readonly name: string; readonly data: TsgitErrorData }>,
  ): UnusablePack[] => faults.map((fault) => unusableEntry(fault.name, 'index', fault.data));

  const indexFaultEntries = async (): Promise<UnusablePack[]> => {
    const generation = await currentGeneration();
    return indexFaultsOf((await generation.indexed.get()).indexFaults);
  };

  // The one site that classifies a pack-open refusal — lookup() and health()
  // both call it, so the refusal reason cannot drift between them. Returns
  // the fault when the pack is unusable, undefined when healthy; anything
  // outside the allow-list propagates. Awaits the same header memo
  // everywhere: a failed probe clears it (no negative cache).
  const probeHeader = async (pack: RegisteredPack): Promise<TsgitError | undefined> => {
    try {
      await pack.header(); // git's open_packed_git_1 / is_pack_valid gate
      return undefined;
    } catch (err) {
      if (!isSkippablePackFault(err)) throw err;
      ctx.logger?.warn?.('packRegistry: skipping unusable pack', {
        pack: pack.name,
        ...faultContext(err.data),
      });
      return err;
    }
  };

  // The one lazy per-pack classification site every lookup shares, whether
  // or not a midx exists: a corrupt `.idx` is skipped exactly as
  // `resolveIndexes` would skip it, with the same warn shape, deduped
  // against the generation's own set so a pack `resolveIndexes` already
  // warned about (or vice versa) never warns twice.
  const unclaimedIndexOrSkip = async (
    pack: RegisteredPack,
    warnedIdx: Set<string>,
  ): Promise<PackIndex | undefined> => {
    try {
      return await pack.index();
    } catch (err) {
      if (!isSkippableIdxFault(err)) throw err;
      const idxName = `${pack.name}.idx`;
      if (!warnedIdx.has(idxName)) {
        warnedIdx.add(idxName);
        ctx.logger?.warn?.('packRegistry: skipping unreadable pack index', {
          idx: idxName,
          ...faultContext(err.data),
        });
      }
      return undefined;
    }
  };

  // The fast half of lookupLazily: every candidate's `.idx` has ALREADY
  // settled (someone forced `generation.indexed` first — `all()`, `health()`
  // — or `lookupUnsettled`'s own passive tracking completed it), so the walk
  // needs no per-pack await at all until an actual index hit forces one —
  // the common "settled full miss" case pays zero awaits instead of one per
  // pack. `isClaimed` and the header-fault continue both mirror
  // `lookupLazily`'s own loop exactly. Takes a plain array, not the full
  // `IndexedPacks` shape: the passive path never builds `indexFaults`, and
  // this walk never reads it either.
  const lookupSettled = async (
    packs: ReadonlyArray<IndexedPack>,
    id: ObjectId,
    isClaimed: (pack: RegisteredPack) => boolean,
  ): Promise<PackLookupHit | undefined> => {
    for (const { pack, index } of packs) {
      if (isClaimed(pack)) continue;
      const offset = lookupPackIndex(index, id);
      if (offset === undefined) continue;
      const fault = await probeHeader(pack);
      if (fault !== undefined) continue;
      return { pack, offset };
    }
    return undefined;
  };

  // Step 3 of lookup: one `.idx` at a time, in candidate order, stopping at
  // the first hit — never a snapshot forced ahead of need. `isClaimed` is
  // the only difference between the no-midx and midx-present shapes: git
  // never opens a midx-covered `.idx` in find_pack_entry, so a midx routes
  // straight past every pack it claims and only walks the rest this way.
  // Takes the settled synchronous walk above when `generation.indexed` has
  // already resolved; otherwise falls back to the lazy, per-pack await —
  // this is the ONE place forcing `generation.indexed` would defeat the
  // point of loading indexes lazily, so it only ever PEEKS. Each step also
  // feeds the passive settled-walk tracker (`recordUnclaimedResult`), so a
  // plain read-walk that never calls `all()`/`health()` still promotes onto
  // the synchronous walk once it has organically settled every candidate.
  const lookupUnsettled = async (
    generation: PackGeneration,
    id: ObjectId,
    isClaimed: (pack: RegisteredPack) => boolean,
  ): Promise<PackLookupHit | undefined> => {
    const progress = unclaimedProgressFor(generation, isClaimed);
    for (const pack of generation.packs) {
      if (isClaimed(pack)) continue;
      const index = await unclaimedIndexOrSkip(pack, generation.warnedIdx);
      recordUnclaimedResult(generation, progress, pack, index);
      if (index === undefined) continue;
      const offset = lookupPackIndex(index, id);
      if (offset === undefined) continue;
      const fault = await probeHeader(pack);
      if (fault !== undefined) continue;
      return { pack, offset };
    }
    return undefined;
  };

  const lookupLazily = (
    generation: PackGeneration,
    id: ObjectId,
    isClaimed: (pack: RegisteredPack) => boolean,
  ): Promise<PackLookupHit | undefined> => {
    const settled = generation.indexed.peekSettled();
    if (settled !== undefined) return lookupSettled(settled.packs, id, isClaimed);
    const passivelySettled = unclaimedProgressByGeneration.get(generation)?.settledPacks;
    if (passivelySettled !== undefined) return lookupSettled(passivelySettled, id, isClaimed);
    return lookupUnsettled(generation, id, isClaimed);
  };

  const lookupViaIdxScan = (
    generation: PackGeneration,
    id: ObjectId,
  ): Promise<PackLookupHit | undefined> => {
    const midx = generation.midx;
    if (midx === undefined) return lookupLazily(generation, id, () => false);
    return lookupLazily(generation, id, (pack) => midx.claimedNames.has(`${pack.name}.idx`));
  };

  const computeHealth = async (): Promise<PackHealth> => {
    const generation = await currentGeneration();
    const { packs, indexFaults } = await generation.indexed.get();
    const unusable: UnusablePack[] = indexFaultsOf(indexFaults);
    const accessible: RegisteredPack[] = [];
    for (const { pack } of packs) {
      const fault = await probeHeader(pack);
      if (fault === undefined) accessible.push(pack);
      else unusable.push(unusableEntry(pack.name, 'pack', fault.data));
    }
    return { accessible, unusable };
  };
  // Memoised per generation: every health() consumer in one fsck run sees ONE
  // consistent verdict — a pack cannot be excluded from the universe by the
  // first call yet report healthy at the second. refresh() resets it with the
  // scan; a rejected compute self-clears (promise-memo), so an environmental
  // fault is never cached.
  const healthMemo = createPromiseMemo(computeHealth);
  // Same memoisation shape as healthMemo, reset alongside it by refresh().
  // computeMidxHealth never rejects for a midx fault (a contained one is
  // folded into the resolved value's faults), so the promise-memo's usual
  // clear-on-rejection has nothing environmental left to guard against here.
  const midxHealthMemo = createPromiseMemo(
    async (): Promise<MidxHealth> => computeMidxHealth(ctx, await currentGeneration()),
  );

  return {
    all: allPacks,
    async fileNames(): Promise<ReadonlySet<string>> {
      const generation = await currentGeneration();
      return generation.fileNames;
    },
    async assertLoadable(): Promise<void> {
      await currentGate();
    },
    midxHealth: midxHealthMemo.get,
    async midxBitmap(): Promise<MidxBitmapLoad | undefined> {
      const generation = await currentGeneration();
      return generation.midxBitmap.get();
    },
    refresh(): void {
      if (disposed) return;
      // A full teardown must never reuse an in-flight reprepare()'s carry-
      // forward set — this always builds every instance fresh.
      reuseFrom = undefined;
      healthMemo.clear();
      midxHealthMemo.clear();
      // (packName, offset) pairs are only meaningful within the generation
      // that produced them — a replaced pack can reuse the same name and
      // offset for entirely different bytes, so this MUST clear alongside
      // the scan, not survive into the next generation.
      deltaBaseCache.clear();
      // Same reasoning as deltaBaseCache above: a replaced pack can reuse
      // its name, and `${packName}:${base}` would otherwise serve the OLD
      // pack's bytes to a read against the new one.
      windowCache.clear();
      // Cleared before the early return below: a Context that only ever
      // called assertLoadable (a loose-only read) never forces the scan, so
      // clearing the gate — and the listing it shares with the scan — here,
      // not after the guard, is the only way a stale multi-pack-index load
      // or a stale directory listing doesn't outlive this refresh().
      storeGate.clear();
      packDirListing.clear();
      // The outgoing packs may hold open persistent handles; close them before
      // dropping the references or every refresh leaks one fd per touched pack.
      const outgoing = scan.clear();
      if (outgoing === undefined) return;
      trackClose(
        outgoing.then(
          (generation) => Promise.allSettled(generation.packs.map((pack) => pack.close())),
          // A rejected scan produced no packs and therefore no handles. The error is
          // not discarded: it is delivered to the all()/lookup() caller that triggered
          // the scan — this arm only declines to close a set that does not exist.
          // Stryker disable next-line ArrowFunction: equivalent — this .then result is consumed only by trackClose, which discards it via Promise.allSettled; returning undefined instead of NO_PACKS changes nothing observable (unlike dispose()'s empty-generation fallback below, whose result feeds packs.map and whose mutant was killed)
          () => NO_PACKS,
        ),
      );
    },
    async reprepare(): Promise<void> {
      if (disposed) return;
      // The OUTGOING generation's packs are the reuse candidates — captured
      // before anything is cleared, by name (git's own `pack_map` identity:
      // keyed by path, never mtime/size — a repack always mints a new name,
      // so a same-named pack is the same bytes).
      const previous = await currentGeneration();
      if (disposed) return;
      const priorByName = new Map(previous.packs.map((pack) => [pack.name, pack] as const));
      // Generation-scoped verdicts, reset alongside the scan they were
      // computed against — same reasoning as refresh()'s own clear.
      healthMemo.clear();
      midxHealthMemo.clear();
      // Unlike refresh(): deltaBaseCache and windowCache are NOT cleared. A
      // reused RegisteredPack instance keeps its own window keys valid; a
      // retired one's keys simply become unreachable once closed below —
      // nothing needs evicting either way.
      storeGate.clear();
      packDirListing.clear();
      scan.clear();
      // Set and consumed with no `await` between: scanPacks reads this
      // before its own first await, so nothing else can observe or steal it.
      reuseFrom = priorByName;
      const fresh = await scan.get();
      const freshNames = new Set(fresh.packs.map((pack) => pack.name));
      const vanished = [...priorByName.values()].filter((pack) => !freshNames.has(pack.name));
      if (vanished.length === 0) return;
      // Same background-close discipline as refresh(): a vanished pack's
      // handle closes off the read path, drained by settleRefresh().
      trackClose(Promise.allSettled(vanished.map((pack) => pack.close())));
    },
    settleRefresh: drainPendingCloses,
    async lookup(id: ObjectId): Promise<PackLookupHit | undefined> {
      const generation = await currentGeneration();
      const midx = generation.midx;
      if (midx === undefined) return lookupViaIdxScan(generation, id);
      const hit = findMidxHit(midx, id);
      if (hit === undefined) return lookupViaIdxScan(generation, id);
      const fault = await probeHeader(hit.pack);
      // A midx hit on an unusable pack is a miss for every claimed pack, but
      // git still walks the packs the midx does NOT name (find_pack_entry's
      // !p->multi_pack_index loop) — the claimed-skipping scan is exactly
      // that loop, so a duplicate in an unclaimed pack is still served.
      return fault === undefined ? hit : lookupViaIdxScan(generation, id);
    },
    health(): Promise<PackHealth> {
      return healthMemo.get();
    },
    indexFaults: indexFaultEntries,
    deltaBaseCache,
    async dispose(): Promise<void> {
      disposed = true;
      deltaBaseCache.clear();
      windowCache.clear();
      // A registry that never scanned the pack directory has no handles to
      // close — skip the scan entirely rather than triggering one just to
      // find nothing. Peek, not clear: all() keeps returning the closed,
      // retired set after disposal. A refresh that ran before this dispose
      // may still have a close batch in flight, so this arm must still
      // drain it.
      const pending = scan.peek();
      if (pending === undefined) return drainPendingCloses();
      // A pending scan's own rejection already has an owner — the all()/
      // lookup() caller that triggered it. Absorb it here without closing
      // anything: a rejected scan produced no packs and therefore no handles.
      const generation = await pending.catch(() => emptyGeneration());
      // Settle every close so one failing handle cannot strand the others.
      const results = await Promise.allSettled(generation.packs.map((pack) => pack.close()));
      await drainPendingCloses();
      const failure = results.find(
        (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
      );
      if (failure !== undefined) throw failure.reason;
    },
  };
}
