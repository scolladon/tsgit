/**
 * Lazy scan + cache of .idx files under .git/objects/pack/.
 * Returns a PackRegistry facade used by object-resolver and readObject.
 */
import { TsgitError, type TsgitErrorData } from '../../domain/error.js';
import type { ObjectId } from '../../domain/objects/index.js';
import { invalidPackHeader, invalidPackIndex } from '../../domain/storage/error.js';
import {
  entryOffsets,
  lookupPackIndex,
  type MultiPackIndex,
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
import {
  bindMidx,
  computeMidxHealth,
  findMidxHit,
  type LoadedMidx,
  type MidxHealth,
} from './internal/midx-binding.js';
import { errorDataCode, loadMidxSet, type MidxLoadResult } from './internal/midx-source.js';
import {
  type ArtefactLoad,
  loadBitmapBytes,
  loadPackRevIndex,
  midxBitmapName,
} from './internal/pack-artefact-source.js';
import {
  emptyGeneration,
  NO_PACKS,
  type PackGeneration,
  resolveIndexes,
} from './internal/pack-generation.js';
import {
  nextOffsetForEntry,
  type PackOffsetTable,
  resolveSortedOffsets,
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
import { createPromiseMemo, type PromiseMemo } from './internal/promise-memo.js';
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
  readonly readSlice: (offset: number, length: number) => Promise<Uint8Array>;
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
}

function isCandidate(entry: { isFile: boolean; name: string }): boolean {
  return entry.isFile && entry.name.endsWith('.idx') && isSafePackName(entry.name);
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

function loadPack(
  ctx: Context,
  dir: string,
  entryName: string,
  fileNames: ReadonlySet<string>,
): RegisteredPack {
  const idxPath = `${dir}/${entryName}`;
  const name = packBaseName(entryName);
  const packPath = `${dir}/${name}.pack`;
  const revPath = `${dir}/${name}.rev`;
  const hasRevIndex = fileNames.has(`${name}.rev`);
  const bitmapPath = `${dir}/${name}.bitmap`;
  const hasBitmap = fileNames.has(`${name}.bitmap`);

  // Not read here — scanPacks builds the candidate list with no `.idx` I/O.
  // The first caller to force this memo (directly, or via the generation's
  // resolveIndexes classification) pays the one bounded read.
  const indexMemo = createPromiseMemo(
    async (): Promise<PackIndex> => parsePackIndex(await readBoundedIdx(ctx, idxPath)),
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
  // out-of-range value falls back to `packPositionMap`, exactly as
  // `resolveSortedOffsets` falls back for the offset table. Never warns
  // here: `buildOffsetTable`'s own fallback already warns once for the SAME
  // `.rev` fault when it runs, and this memo has no independent finding to
  // report.
  const packPositionsMemo = createPromiseMemo(async (): Promise<Uint32Array> => {
    const index = await indexMemo.get();
    const load = await revIndexMemo.get();
    if (load.kind === 'usable') {
      const stored = revIndexPositions(load.value, index.objectCount);
      if (stored !== undefined) return stored;
    }
    return packPositionMap(index);
  });

  const headerMemo = createPromiseMemo(async (): Promise<PackHeader> => {
    const index = await indexMemo.get();
    const header = parsePackHeader(await ctx.fs.readSlice(packPath, 0, PACK_HEADER_SIZE));
    if (header.objectCount !== index.objectCount) {
      throw invalidPackHeader(
        `object count disagrees with index: pack ${header.objectCount}, index ${index.objectCount}`,
      );
    }
    return header;
  });

  const buildOffsetTable = async (): Promise<PackOffsetTable> => {
    const index = await indexMemo.get();
    const stat = await ctx.fs.stat(packPath);
    const packFileSize = stat.size;
    const raw = entryOffsets(index);
    // The memo is handed over UNFORCED: below its object-count threshold
    // `resolveSortedOffsets` sorts without ever calling it, so a small pack
    // pays no `.rev` read at all.
    const sortedOffsets = await resolveSortedOffsets(ctx, name, raw, revIndexMemo.get);
    // The pack file trailer is a single pack-checksum digest (SHA-1: 20 bytes,
    // SHA-256: 32 bytes). The last entry's data ends exactly at trailerStart.
    const trailerStart = packFileSize - ctx.hashConfig.digestLength;
    if (trailerStart < 0) {
      throw invalidPackIndex('pack file too small to contain a trailer');
    }
    return { sortedOffsets, packFileSize, trailerStart };
  };
  const offsetTable = createPromiseMemo(buildOffsetTable).get;

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

  const readSlice = async (offset: number, length: number): Promise<Uint8Array> => {
    if (retired) return ctx.fs.readSlice(packPath, offset, length);
    const read = (async (): Promise<Uint8Array> => {
      const handle = await handleMemo.get();
      const buffer = new Uint8Array(length);
      const bytesRead = await handle.read(buffer, 0, length, offset);
      return buffer.subarray(0, bytesRead);
    })();
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
 */
function loadCandidatePack(
  ctx: Context,
  dir: string,
  entry: { readonly name: string },
  fileNames: ReadonlySet<string>,
): RegisteredPack | undefined {
  const name = packBaseName(entry.name);
  if (!fileNames.has(`${name}.pack`)) {
    ctx.logger?.warn?.('packRegistry: skipping pack index with no pack file', {
      idx: entry.name,
    });
    return undefined;
  }
  return loadPack(ctx, dir, entry.name, fileNames);
}

const unusableEntry = (
  name: string,
  layer: UnusablePack['layer'],
  data: TsgitErrorData,
): UnusablePack => ({ name, layer, data });

/**
 * Node's `readdir` on a missing directory maps to `FILE_NOT_FOUND`.
 * `NOT_A_DIRECTORY` covers two distinct real shapes: the memory adapter's
 * code for a MISSING directory, and node's `ENOTDIR` when `objects/pack` is
 * itself a regular file. Both mean the same thing here — there are no packs
 * to list — and canonical git agrees, serving a loose read at exit 0 while
 * printing `error: unable to open object pack directory: …: Not a directory`.
 *
 * Structural on `data.code`, never `instanceof`: this classifies an error
 * thrown by `ctx.fs`, so in a mixed-module-graph harness (a source-graph
 * registry over a dist-bundle Context) the adapter's `TsgitError` is a
 * different class identity than this module's — the same hazard
 * `internal/midx-source.ts` documents for the gate's own probes, which is
 * why both now share `errorDataCode`.
 */
function isMissingPackDir(error: unknown): boolean {
  const code = errorDataCode(error);
  return code === 'FILE_NOT_FOUND' || code === 'NOT_A_DIRECTORY';
}

// git dies during object-store setup ahead of every read, and the ONLY
// thing it dies on is a structurally self-inconsistent multi-pack-index —
// the directory listing and pack construction below are invisible to a
// successful loose read's outcome. So the gate is exactly the midx load,
// and its Tier-B discard diagnostic belongs here too: git prints that one
// on a loose read.
function createStoreGate(ctx: Context): PromiseMemo<MidxLoadResult> {
  const loadStoreGate = async (): Promise<MidxLoadResult> => {
    const midxLoad = await loadMidxSet(ctx, packsDir(commonGitDir(ctx)));
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

export function createPackRegistry(ctx: Context): PackRegistry {
  const storeGate = createStoreGate(ctx);

  const scanPacks = async (): Promise<PackGeneration> => {
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
    // No separate `exists(dir)` guard: a missing (or non-directory)
    // `objects/pack` folds to an empty listing right here, inside the same
    // `Promise.all` arm — never a sequential probe-then-list round trip.
    // Everything else (PERMISSION_DENIED, …) is a real fault and propagates
    // to the only consumers that actually need the pack store — `all()` and
    // `lookup()` — never to a loose-only read, which never forces this scan.
    const [midxLoad, entries] = await Promise.all([
      storeGate.get(),
      ctx.fs.readdir(dir).catch((error: unknown) => {
        if (isMissingPackDir(error)) return [];
        throw error;
      }),
    ]);
    // git registers a pack only when its .pack exists by name — an orphaned
    // .idx is garbage, never a pack. The listing already in hand is the same
    // data, so the check costs no I/O.
    // Regular files only: a symlinked .pack is out of scope by the same
    // no-follow policy the data reads enforce, so its .idx drops here too.
    const fileNames = new Set(entries.filter((entry) => entry.isFile).map((entry) => entry.name));
    const packs: RegisteredPack[] = [];
    for (const entry of entries) {
      if (!isCandidate(entry)) continue;
      const pack = loadCandidatePack(ctx, dir, entry, fileNames);
      if (pack !== undefined) packs.push(pack);
    }
    const midx =
      midxLoad.set === undefined ? undefined : bindMidx(ctx, packs, midxLoad.set, fileNames);
    // Named from the in-use layer's STORED trailer bytes (Pin K rule 3),
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
    return {
      packs,
      midxLoad,
      midx,
      indexed: createPromiseMemo(() => resolveIndexes(ctx, packs)),
      warnedIdx: new Set(),
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

  // Step 3 of lookup: the ordinary .idx scan over packs the midx does not
  // claim. With no midx, the generation's classified snapshot is forced once
  // and walked synchronously (every parse already settled). With a midx,
  // ONLY unclaimed packs are touched — git never opens a midx-covered `.idx`
  // in find_pack_entry, and forcing the snapshot here would re-pay the P
  // eager reads the lazy scan exists to avoid. Each unclaimed `.idx` loads
  // lazily; a classified-corrupt one is skipped per pack, mirroring the
  // snapshot's own classification.
  // No midx: force the generation's classified snapshot once, then walk it
  // synchronously — every parse already settled, and the header probe is
  // awaited only on the index match, so a full-scan miss costs zero awaits.
  const lookupViaIndexedSnapshot = async (
    generation: PackGeneration,
    id: ObjectId,
  ): Promise<PackLookupHit | undefined> => {
    const { packs } = await generation.indexed.get();
    for (const { pack, index } of packs) {
      const offset = lookupPackIndex(index, id);
      if (offset === undefined) continue;
      const fault = await probeHeader(pack);
      if (fault !== undefined) continue;
      return { pack, offset };
    }
    return undefined;
  };

  // The one lazy per-pack classification site outside the snapshot: an
  // unclaimed pack's corrupt `.idx` is skipped exactly as `resolveIndexes`
  // would skip it, with the same warn shape.
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

  const lookupViaUnclaimedPacks = async (
    generation: PackGeneration,
    midx: LoadedMidx,
    id: ObjectId,
  ): Promise<PackLookupHit | undefined> => {
    for (const pack of generation.packs) {
      if (midx.claimedNames.has(`${pack.name}.idx`)) continue;
      const index = await unclaimedIndexOrSkip(pack, generation.warnedIdx);
      if (index === undefined) continue;
      const offset = lookupPackIndex(index, id);
      if (offset === undefined) continue;
      const fault = await probeHeader(pack);
      if (fault !== undefined) continue;
      return { pack, offset };
    }
    return undefined;
  };

  const lookupViaIdxScan = (
    generation: PackGeneration,
    id: ObjectId,
  ): Promise<PackLookupHit | undefined> => {
    const midx = generation.midx;
    return midx === undefined
      ? lookupViaIndexedSnapshot(generation, id)
      : lookupViaUnclaimedPacks(generation, midx, id);
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
      healthMemo.clear();
      midxHealthMemo.clear();
      // Cleared before the early return below: a Context that only ever
      // called assertLoadable (a loose-only read) never forces the scan, so
      // clearing the gate here — not after the guard — is the only way a
      // stale multi-pack-index load doesn't outlive this refresh().
      storeGate.clear();
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
    async dispose(): Promise<void> {
      disposed = true;
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
