/**
 * Lazy scan + cache of .idx files under .git/objects/pack/.
 * Returns a PackRegistry facade used by object-resolver and readObject.
 */
import { TsgitError, type TsgitErrorData } from '../../domain/error.js';
import { bytesEqual, hexToBytes } from '../../domain/objects/encoding.js';
import type { ObjectId } from '../../domain/objects/index.js';
import { invalidPackHeader, invalidPackIndex } from '../../domain/storage/error.js';
import {
  entryOffsets,
  lookupPackIndex,
  type MidxEntry,
  midxEntryAt,
  midxOidAt,
  type PackIndex,
  parsePackIndex,
} from '../../domain/storage/index.js';
import { lookupMultiPackIndexBytes } from '../../domain/storage/midx.js';
import {
  PACK_HEADER_SIZE,
  type PackHeader,
  parsePackHeader,
} from '../../domain/storage/pack-entry.js';
import type { Context } from '../../ports/context.js';
import {
  loadMidxSet,
  type MidxFault,
  type MidxLoadResult,
  type MidxSet,
} from './internal/midx-source.js';
import { createPromiseMemo, type PromiseMemo } from './internal/promise-memo.js';
import { commonGitDir, packsDir } from './path-layout.js';
import { exceedsMaxPackIdxBytes, REASON_PACK_IDX_EXCEEDS_MAX } from './validators.js';

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

function isSkippableIoFault(err: unknown): boolean {
  return (
    err instanceof TsgitError &&
    (err.data.code === 'FILE_NOT_FOUND' || err.data.code === 'PERMISSION_DENIED')
  );
}

// The pack file itself is unusable: bad signature, short file, version outside
// 2|3, or a header/index object-count disagreement. Scoped to the lookup layer
// ONLY — INVALID_PACK_INDEX is deliberately absent, because nextOffsetForEntry
// and buildOffsetTable throw it for a MID-READ corruption, and folding those in
// would turn a detected corruption into a silent miss after the gate passed.
// Exported so a test can audit that it never admits INVALID_MULTI_PACK_INDEX —
// a midx fault escaping this allow-list by construction is Part 3's whole
// argument for why a Tier-A multi-pack-index fault is never laundered into
// "skip one pack".
export function isSkippablePackFault(err: unknown): err is TsgitError {
  return (
    (err instanceof TsgitError && err.data.code === 'INVALID_PACK_HEADER') ||
    isSkippableIoFault(err)
  );
}

// Scan layer: the .idx cannot be turned into a PackIndex (a corrupt or
// unreadable index). Deliberately NOT unioned with isSkippablePackFault —
// INVALID_PACK_INDEX is skippable only here, where the parse happens; at the
// lookup layer it also means a mid-read corruption, which must never be
// laundered into "this pack has no objects". Exported for the same audit
// reason as isSkippablePackFault above.
export function isSkippableIdxFault(err: unknown): err is TsgitError {
  return (
    (err instanceof TsgitError && err.data.code === 'INVALID_PACK_INDEX') || isSkippableIoFault(err)
  );
}

// Flat and string-valued on purpose: the Logger port sanitises TOP-LEVEL string
// values only, and a pack name comes from a readdir entry an attacker with repo
// write access controls. Nesting `err.data` would route it round the sanitiser.
const faultContext = (data: TsgitErrorData): Readonly<Record<string, string>> =>
  'reason' in data ? { code: data.code, reason: data.reason } : { code: data.code };

/** The one narrowing of a fault's display reason — shared with the fsck pack pass. */
export const faultReason = (data: TsgitErrorData): string =>
  'reason' in data ? data.reason : data.code;

export interface PackOffsetTable {
  readonly sortedOffsets: ReadonlyArray<number>;
  readonly packFileSize: number;
  readonly trailerStart: number;
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
}

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

/**
 * The multi-pack-index's accessibility + integrity verdict for the current
 * generation — the state `fsck`'s midx pass needs and nothing else needs.
 * A sibling of `PackHealth` (§D3: a midx fault is not a pack fault), never a
 * widening of it.
 */
export interface MidxHealth {
  /**
   * The artefact actually IN USE — the flat file, or the chain head.
   * `undefined` covers both "there is none" and "every candidate was
   * Tier-B-unusable"; `flatFilePresent` tells those two apart.
   */
  readonly artefact: string | undefined;
  /**
   * Tier-B faults the read path discarded, plus — when the entry-resolution
   * walk below hits a Tier-A fault decoding one specific entry — the single
   * fault that ended the walk (`fsck` treats that case unconditionally,
   * never through the "no usable artefact" verdict the other faults here
   * feed).
   */
  readonly faults: ReadonlyArray<MidxFault>;
  /** Whether a flat `multi-pack-index` file exists — a stat, not a
   *  successful read (the verdict gate). */
  readonly flatFilePresent: boolean;
  /** Chain-global pack positions whose `PNAM` entry resolves to no pack this
   *  generation registered. */
  readonly unresolvedPacks: ReadonlyArray<{ readonly position: number; readonly pack: string }>;
  /** Oids the midx assigns to a pack that cannot serve them — either the
   *  `PNAM` binding failed (see `unresolvedPacks`) or the bound pack's own
   *  `.idx`/header gate rejects. */
  readonly unresolvedEntries: ReadonlyArray<ObjectId>;
  /** The in-use artefact's trailer digest, verified once. `undefined` when
   *  there is no artefact to hash. */
  readonly checksumOk: boolean | undefined;
}

export interface PackRegistry {
  all(): Promise<ReadonlyArray<RegisteredPack>>;
  lookup(id: ObjectId): Promise<PackLookupHit | undefined>;
  /**
   * Await the current generation for its rejection only, discarding the
   * result. A structurally self-inconsistent multi-pack-index must deny
   * EVERY read — loose objects included — before any loose-vs-pack branch is
   * even reached, and this is the single gate that makes that true. Returns
   * `void` on purpose: it must never become a second way to reach the packs.
   * Never forces `generation.indexed` — that would pay every pack's `.idx`
   * load eagerly and defeat the point of loading indexes lazily.
   */
  assertLoadable(): Promise<void>;
  /** Drop the cached `.idx` scan so the next `all`/`lookup` re-scans the
   *  pack directory — used after a lazy-fetch writes a new pack. */
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
   * same bytes `lookup` reads (§D11.10): it re-derives pack binding and
   * entry resolution rather than reusing `lookup`'s memoised view, so a
   * fault that only a full walk surfaces (an entry whose `pack-int-id` or
   * `large-offset` decodes out of range) is caught here even when no read
   * ever touched it. The verdict is memoised per generation, exactly as
   * `health()` is, and reset by `refresh()` with the scan.
   */
  midxHealth(): Promise<MidxHealth>;
}

// Control characters are rejected at this boundary so a hostile filename can
// never carry a newline into a line-oriented logger sink downstream — the
// display sanitiser deliberately preserves tab and newline.
const isControlChar = (ch: string): boolean => ch.charCodeAt(0) < 0x20;

function isSafePackName(name: string): boolean {
  return (
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('..') &&
    ![...name].some(isControlChar)
  );
}

function isCandidate(entry: { isFile: boolean; name: string }): boolean {
  return entry.isFile && entry.name.endsWith('.idx') && isSafePackName(entry.name);
}

// Single source for the `.idx` → base-name rule: both the scan layer's
// sibling-.pack check and loadPack's own packPath derivation depend on it.
const packBaseName = (idxEntryName: string): string => idxEntryName.slice(0, -'.idx'.length);

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

function loadPack(ctx: Context, dir: string, entryName: string): RegisteredPack {
  const idxPath = `${dir}/${entryName}`;
  const name = packBaseName(entryName);
  const packPath = `${dir}/${name}.pack`;

  // Not read here — scanPacks builds the candidate list with no `.idx` I/O.
  // The first caller to force this memo (directly, or via the generation's
  // resolveIndexes classification) pays the one bounded read.
  const indexMemo = createPromiseMemo(
    async (): Promise<PackIndex> => parsePackIndex(await readBoundedIdx(ctx, idxPath)),
  );

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
    const sortedOffsets = [...raw].sort((a, b) => a - b);
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
  };
}

function bisectLeft(arr: ReadonlyArray<number>, value: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((arr[mid] as number) < value) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

export function nextOffsetForEntry(table: PackOffsetTable, offset: number): number {
  const { sortedOffsets, trailerStart } = table;
  const rank = bisectLeft(sortedOffsets, offset);
  // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent — bisectLeft returns rank in [0, len], so rank > len is unreachable; at rank===len sortedOffsets[len] is undefined !== any numeric offset, so whether the first clause is forced always-false or its >= is mutated, the second clause fires the identical throw
  if (rank >= sortedOffsets.length || sortedOffsets[rank] !== offset) {
    throw invalidPackIndex('offset not in pack index: corrupt index');
  }
  if (rank === sortedOffsets.length - 1) {
    return trailerStart;
  }
  return sortedOffsets[rank + 1] as number;
}

const NO_PACKS: ReadonlyArray<RegisteredPack> = Object.freeze([]);
const NO_INDEX_FAULTS: ReadonlyArray<{ readonly name: string; readonly data: TsgitErrorData }> =
  Object.freeze([]);

/**
 * The scan layer's classification of one generation's candidates: which
 * ones have a loaded, parsed `.idx` (`packs`), and which were skipped as
 * unreadable/unparseable (`indexFaults`). Built once per generation by
 * `resolveIndexes`, behind `PackGeneration.indexed`.
 */
interface IndexedPack {
  readonly pack: RegisteredPack;
  /** The settled parse — held here so lookup's fallback loop stays synchronous. */
  readonly index: PackIndex;
}

interface IndexedPacks {
  readonly packs: ReadonlyArray<IndexedPack>;
  /** The same packs projected once — `all()` returns one stable reference per generation. */
  readonly packList: ReadonlyArray<RegisteredPack>;
  readonly indexFaults: ReadonlyArray<{ readonly name: string; readonly data: TsgitErrorData }>;
}

const NO_INDEXED_PACKS: ReadonlyArray<IndexedPack> = Object.freeze([]);

const EMPTY_INDEXED: IndexedPacks = Object.freeze({
  packs: NO_INDEXED_PACKS,
  packList: NO_PACKS,
  indexFaults: NO_INDEX_FAULTS,
});

const EMPTY_MIDX_LOAD: MidxLoadResult = Object.freeze({
  set: undefined,
  faults: Object.freeze([]),
  flatFilePresent: false,
});

/**
 * One generation's midx bound to the `RegisteredPack` objects the SAME scan
 * produced. `packsByLayer[layerIndex][packIndex]` is `undefined` exactly
 * when that layer's `PNAM` entry names nothing this scan registered —
 * either it failed `isSafePackName`, or it matched no candidate (an
 * orphaned/excluded `.idx`, or a name no file on disk carries at all).
 * `claimedNames` holds only the names that DID bind, `.idx`-suffixed as
 * `PNAM` stores them — the subtraction set the `.idx` loop skips.
 */
interface LoadedMidx {
  readonly set: MidxSet;
  readonly packsByLayer: ReadonlyArray<ReadonlyArray<RegisteredPack | undefined>>;
  readonly claimedNames: ReadonlySet<string>;
  /**
   * Whether each `PNAM` entry's sibling `.pack` file exists in the scan's own
   * listing. An unbound entry whose `.pack` IS on disk (its `.idx` alone is
   * missing) resolved to a real pack in git's eyes — its objects go
   * unresolved but the pack itself is not reported missing.
   */
  readonly packFileOnDiskByLayer: ReadonlyArray<ReadonlyArray<boolean>>;
}

/**
 * Binds every layer's `PNAM` entries to the `RegisteredPack` the same scan
 * produced, by exact string equality against the already-audited `.idx`
 * base names — never by constructing a path from a `PNAM` value (a hostile
 * repository controls that value). A name is resolved only when it passes
 * `isSafePackName` AND matches a pack this scan actually registered; either
 * failure binds `undefined` and withholds the name from `claimedNames`, so
 * the real pack of that name, if any, is scanned normally through the
 * ordinary `.idx` loop. A safe-but-unmatched name warns once, mirroring the
 * orphan-`.idx` warn discipline; an unsafe name never reaches the logger
 * raw — `isSafePackName` exists precisely to keep a hostile filename out of
 * it.
 */
function bindMidx(
  ctx: Context,
  packs: ReadonlyArray<RegisteredPack>,
  set: MidxSet,
  fileNames: ReadonlySet<string>,
): LoadedMidx {
  const packsByIdxName = new Map(packs.map((pack) => [`${pack.name}.idx`, pack]));
  const claimedNames = new Set<string>();
  const packsByLayer = set.layers.map((layer) =>
    layer.packNames.map((name) => {
      if (!isSafePackName(name)) return undefined;
      const pack = packsByIdxName.get(name);
      if (pack === undefined) {
        ctx.logger?.warn?.(
          'packRegistry: multi-pack-index names a pack this scan did not register',
          {
            pack: name,
          },
        );
        return undefined;
      }
      claimedNames.add(name);
      return pack;
    }),
  );
  const packFileOnDiskByLayer = set.layers.map((layer) =>
    layer.packNames.map(
      (name) => isSafePackName(name) && fileNames.has(`${packBaseName(name)}.pack`),
    ),
  );
  return { set, packsByLayer, claimedNames, packFileOnDiskByLayer };
}

interface PackGeneration {
  /** Every candidate with a sibling `.pack` — orphans excluded, `.idx` not
   *  yet read. The safe superset for `refresh()`/`dispose()` to close: a
   *  pack whose index never loaded simply has nothing to close. */
  readonly packs: ReadonlyArray<RegisteredPack>;
  /** The multi-pack-index this generation's scan discovered, produced by the
   *  SAME `scanPacks` call as `packs` — so no consumer can ever pair one
   *  generation's midx with another's packs. Has no reader beyond
   *  `assertLoadable` propagating its rejection: `midx` below is the bound,
   *  lookup-facing view. */
  readonly midxLoad: MidxLoadResult;
  /** `midxLoad.set` bound to this generation's own `packs`, or `undefined`
   *  exactly when `midxLoad.set` is. The one field `lookup` reads to decide
   *  whether the midx is authoritative for this generation. */
  readonly midx: LoadedMidx | undefined;
  /** Forces every candidate's `.idx` load, once, on first use. */
  readonly indexed: PromiseMemo<IndexedPacks>;
}

function emptyGeneration(): PackGeneration {
  return {
    packs: NO_PACKS,
    midxLoad: EMPTY_MIDX_LOAD,
    midx: undefined,
    indexed: createPromiseMemo(() => Promise.resolve(EMPTY_INDEXED)),
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
  return loadPack(ctx, dir, entry.name);
}

/**
 * The single site that classifies an index-layer fault — run once per
 * generation, behind `PackGeneration.indexed`, sequentially in candidate
 * order, never per lookup — so a generation warns for each unreadable index
 * exactly once no matter how many consumers later force the memo. Forces
 * every candidate's `.idx` load, not just the ones a lookup needed, so
 * `all()`, `indexFaults()` and `health()` see a complete classification even
 * when no lookup ever ran.
 */
async function resolveIndexes(
  ctx: Context,
  packs: ReadonlyArray<RegisteredPack>,
): Promise<IndexedPacks> {
  const loaded: IndexedPack[] = [];
  const faults: Array<{ readonly name: string; readonly data: TsgitErrorData }> = [];
  for (const pack of packs) {
    try {
      loaded.push({ pack, index: await pack.index() });
    } catch (err) {
      if (!isSkippableIdxFault(err)) throw err;
      ctx.logger?.warn?.('packRegistry: skipping unreadable pack index', {
        idx: `${pack.name}.idx`,
        ...faultContext(err.data),
      });
      faults.push({ name: pack.name, data: err.data });
    }
  }
  return { packs: loaded, packList: loaded.map((entry) => entry.pack), indexFaults: faults };
}

const unusableEntry = (
  name: string,
  layer: UnusablePack['layer'],
  data: TsgitErrorData,
): UnusablePack => ({ name, layer, data });

/**
 * Walk the midx's layers newest-first and resolve the first hit. A layer's
 * `lookupMultiPackIndex` can throw a deferred `pack-int-id` or
 * `large-offset` Tier-A fault — never caught here, so it propagates to
 * `lookup`'s caller unchanged. A hit whose pack never bound (an
 * unresolvable `PNAM` entry) and no hit in any layer both return
 * `undefined`: either way the caller falls through to the `.idx` loop.
 */
function findMidxHit(midx: LoadedMidx, id: ObjectId): PackLookupHit | undefined {
  const targetBytes = hexToBytes(id);
  for (let layerIndex = midx.set.layers.length - 1; layerIndex >= 0; layerIndex -= 1) {
    const entry = lookupMultiPackIndexBytes(midx.set.layers[layerIndex]!, targetBytes);
    if (entry === undefined) continue;
    // packsByLayer is built by mapping set.layers, so the layer index always
    // exists; only the pack binding itself can be undefined.
    const pack = midx.packsByLayer[layerIndex]![entry.packIndex];
    return pack === undefined ? undefined : { pack, offset: entry.offset };
  }
  return undefined;
}

// The display sanitiser deliberately preserves tab and newline, which are
// exactly the bytes a finding field must not carry raw — hex-escape every
// control byte instead.
const escapeControlBytes = (name: string): string =>
  [...name]
    .map((ch) => {
      const code = ch.charCodeAt(0);
      const isControl = code < 0x20 || code === 0x7f;
      return isControl ? `\\x${code.toString(16).padStart(2, '0')}` : ch;
    })
    .join('');

// `PNAM` carries `pack-<hex>.idx`; findings elsewhere in this file carry the
// pack BASE name, so the suffix is stripped here to match. A name failing
// `isSafePackName` has every control byte hex-escaped rather than reaching a
// finding (or a path) raw — an attacker-controlled midx fully controls this
// string.
const midxPackNameForFinding = (name: string): string =>
  isSafePackName(name) ? packBaseName(name) : escapeControlBytes(name);

/**
 * Chain-global position + safe pack name for every `PNAM` entry this scan's
 * binding left unresolved (O22/O23/O24, P14/P15) — a pure walk over the
 * already-bound `packsByLayer`, no I/O, so it can never contribute a
 * contained fault.
 */
function unresolvedMidxPacks(
  midx: LoadedMidx,
): ReadonlyArray<{ readonly position: number; readonly pack: string }> {
  const unresolved: Array<{ readonly position: number; readonly pack: string }> = [];
  let base = 0;
  for (const [layerIndex, layer] of midx.set.layers.entries()) {
    const bound = midx.packsByLayer[layerIndex]!;
    const packOnDisk = midx.packFileOnDiskByLayer[layerIndex]!;
    layer.packNames.forEach((name, packIndex) => {
      // An unbound entry whose .pack survives on disk resolved as a pack in
      // git's eyes (only its .idx is gone): its objects are unresolved, but
      // no pack-level finding is emitted for it.
      if (bound[packIndex] === undefined && !packOnDisk[packIndex]) {
        unresolved.push({ position: base + packIndex, pack: midxPackNameForFinding(name) });
      }
    });
    base += layer.packNames.length;
  }
  return unresolved;
}

/** Whether a bound pack can actually serve the entry the midx routes to it —
 *  the same two allow-lists `lookup`'s own header gate and the scan layer's
 *  index gate use, so a corrupt `.idx` or a header-refused pack both count
 *  as "cannot serve" without laundering an unrecognised fault into a skip. */
async function probeMidxEntryServiceable(pack: RegisteredPack): Promise<boolean> {
  try {
    await pack.index();
    await pack.header();
    return true;
  } catch (err) {
    if (isSkippableIdxFault(err) || isSkippablePackFault(err)) return false;
    throw err;
  }
}

interface MidxEntryWalkResult {
  readonly unresolvedEntries: ReadonlyArray<ObjectId>;
  /** The fault that ended the walk early, when `lookupMultiPackIndex` hit a
   *  deferred Tier-A check (`pack-int-id`, `large-offset`) decoding one
   *  specific entry — git's own child process dies there too, so the walk
   *  stops at the SAME point git's would, and every entry already
   *  classified stays classified. */
  readonly containedFault: MidxFault | undefined;
}

/**
 * Resolve every oid the midx lists, per layer, oldest first: the same
 * per-entry walk git's `verify` child runs. A pack that never bound makes
 * its oids unresolved without touching the pack; a bound pack's oids are
 * unresolved when it cannot serve them (`probeMidxEntryServiceable`). A
 * Tier-A fault surfacing HERE — not at load, since every layer already
 * parsed — is contained: the walk ends and the fault it hit is returned
 * alongside whatever was classified before it.
 */
async function walkMidxEntries(midx: LoadedMidx): Promise<MidxEntryWalkResult> {
  const unresolvedEntries: ObjectId[] = [];
  const headArtefact = midx.set.artefacts[midx.set.artefacts.length - 1]!;
  // One serviceability probe per distinct pack, not per entry: the verdict
  // cannot change mid-walk, and the header memo clears on rejection, so a
  // per-entry probe would re-issue the header read for every routed oid.
  const serviceable = new Map<RegisteredPack, boolean>();
  const packServes = async (pack: RegisteredPack): Promise<boolean> => {
    const cached = serviceable.get(pack);
    if (cached !== undefined) return cached;
    const verdict = await probeMidxEntryServiceable(pack);
    serviceable.set(pack, verdict);
    return verdict;
  };
  for (const [layerIndex, layer] of midx.set.layers.entries()) {
    const bound = midx.packsByLayer[layerIndex]!;
    for (let i = 0; i < layer.objectCount; i += 1) {
      let entry: MidxEntry;
      try {
        // Index-addressed: the walk already knows every position, so it
        // never re-derives one through the fanout binary search, and an oid
        // is hex-materialised only for the entries that turn out unresolved.
        entry = midxEntryAt(layer, i);
      } catch (err) {
        if (!(err instanceof TsgitError) || err.data.code !== 'INVALID_MULTI_PACK_INDEX') throw err;
        return { unresolvedEntries, containedFault: { artefact: headArtefact, data: err.data } };
      }
      const pack = bound[entry.packIndex];
      if (pack === undefined || !(await packServes(pack))) {
        unresolvedEntries.push(midxOidAt(layer, i));
      }
    }
  }
  return { unresolvedEntries, containedFault: undefined };
}

/** Once, over exactly the artefact in use (the flat file, or the chain
 *  head) — never a base layer. `MultiPackIndex._bytes` is the whole file,
 *  so no second read is needed. The digest algorithm is never selected
 *  here: `hashVersion`'s width is checked against the repository's own
 *  `ctx.hashConfig.digestLength` at parse time (a disagreement is a Tier-B
 *  `hash-version` discard before the artefact could ever reach this point),
 *  so the surviving artefact's width always agrees with
 *  `ctx.hash.digestLength` by construction. */
async function verifyMidxTrailer(ctx: Context, midx: LoadedMidx): Promise<boolean> {
  const head = midx.set.layers[midx.set.layers.length - 1]!;
  const bodyEnd = head._bytes.length - head.digestLength;
  const digest = await ctx.hash.hash(head._bytes.subarray(0, bodyEnd));
  return bytesEqual(digest, head._bytes.subarray(bodyEnd));
}

/**
 * Compute this generation's `MidxHealth` once. Never rejects for a midx
 * fault: a contained Tier-A walk fault is folded into the returned `faults`
 * (tagged with the in-use artefact so the fsck pass can recognise it
 * unconditionally, never through the "no usable artefact" verdict), so the
 * memo's usual clear-on-rejection never fires for one — the resolved value
 * already IS the fault set.
 */
async function computeMidxHealth(ctx: Context, generation: PackGeneration): Promise<MidxHealth> {
  const { midxLoad, midx } = generation;
  if (midx === undefined) {
    return {
      artefact: undefined,
      faults: midxLoad.faults,
      flatFilePresent: midxLoad.flatFilePresent,
      unresolvedPacks: [],
      unresolvedEntries: [],
      checksumOk: undefined,
    };
  }
  const artefact = midx.set.artefacts[midx.set.artefacts.length - 1]!;
  const checksumOk = await verifyMidxTrailer(ctx, midx);
  const unresolvedPacks = unresolvedMidxPacks(midx);
  const { unresolvedEntries, containedFault } = await walkMidxEntries(midx);
  return {
    artefact,
    faults: containedFault === undefined ? midxLoad.faults : [...midxLoad.faults, containedFault],
    flatFilePresent: midxLoad.flatFilePresent,
    unresolvedPacks,
    unresolvedEntries,
    checksumOk,
  };
}

export function createPackRegistry(ctx: Context): PackRegistry {
  const scanPacks = async (): Promise<PackGeneration> => {
    const dir = packsDir(commonGitDir(ctx));
    if (!(await ctx.fs.exists(dir))) return emptyGeneration();
    // A SEPARATE step from the .idx candidate loop below — never folded into
    // it, so a structurally self-inconsistent midx fault is never caught by
    // isSkippableIdxFault and laundered into "skip one pack". A rejection
    // here aborts the whole scan, and the scan memo never caches a
    // rejection, so the very next lookup re-attempts it from scratch.
    // Parallel with the listing: the two rejection paths stay distinct (the
    // catch scope, not the ordering, is what keeps a Tier-A midx fault out of
    // isSkippableIdxFault), and every Context's first pack access saves one
    // sequential round-trip on high-latency adapters.
    const [midxLoad, entries] = await Promise.all([loadMidxSet(ctx, dir), ctx.fs.readdir(dir)]);
    for (const fault of midxLoad.faults) {
      ctx.logger?.warn?.('packRegistry: discarding unusable multi-pack-index', {
        artefact: fault.artefact,
        ...faultContext(fault.data),
      });
    }
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
    return { packs, midxLoad, midx, indexed: createPromiseMemo(() => resolveIndexes(ctx, packs)) };
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
  const hitIfServiceable = async (
    pack: RegisteredPack,
    index: PackIndex,
    id: ObjectId,
  ): Promise<PackLookupHit | undefined> => {
    const offset = lookupPackIndex(index, id);
    if (offset === undefined) return undefined;
    const fault = await probeHeader(pack);
    return fault === undefined ? { pack, offset } : undefined;
  };

  // No midx: force the generation's classified snapshot once, then walk it
  // synchronously — every parse already settled.
  const lookupViaIndexedSnapshot = async (
    generation: PackGeneration,
    id: ObjectId,
  ): Promise<PackLookupHit | undefined> => {
    const { packs } = await generation.indexed.get();
    for (const { pack, index } of packs) {
      const hit = await hitIfServiceable(pack, index, id);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };

  // The one lazy per-pack classification site outside the snapshot: an
  // unclaimed pack's corrupt `.idx` is skipped exactly as `resolveIndexes`
  // would skip it, with the same warn shape.
  const unclaimedIndexOrSkip = async (pack: RegisteredPack): Promise<PackIndex | undefined> => {
    try {
      return await pack.index();
    } catch (err) {
      if (!isSkippableIdxFault(err)) throw err;
      ctx.logger?.warn?.('packRegistry: skipping unreadable pack index', {
        idx: `${pack.name}.idx`,
        ...faultContext(err.data),
      });
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
      const index = await unclaimedIndexOrSkip(pack);
      if (index === undefined) continue;
      const hit = await hitIfServiceable(pack, index, id);
      if (hit !== undefined) return hit;
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
      await currentGeneration();
    },
    midxHealth: midxHealthMemo.get,
    refresh(): void {
      if (disposed) return;
      healthMemo.clear();
      midxHealthMemo.clear();
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
