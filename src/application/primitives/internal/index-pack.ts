/**
 * The pack entry indexer: walks a pack's entries from either an
 * already-resident buffer (`walkPackEntries`) or a quarantined pack file
 * read back from disk in bounded windows (`indexQuarantinedPack`), in two
 * bounded-memory passes. Pass 1 (`scanEntries`) scans every entry once,
 * sequentially, hashing base entries incrementally and recording delta
 * positions into a typed-array store (`./pack-records.js`) — nothing but
 * fixed-width records survives the pass. Pass 2 (`resolveFromRoots`) walks
 * the delta forest root-down from every base entry, resolving each delta
 * against its already-resolved parent's content, held on an explicit stack
 * rather than the JS call stack so depth costs heap, never frames. Split out
 * of `fetch-pack.ts` purely to keep that module under the repo's line
 * ceiling — nothing about the pipeline's observable behaviour changes here.
 */
import { TsgitError } from '../../../domain/error.js';
import { bytesToHex, hexToBytes } from '../../../domain/objects/encoding.js';
import type { ObjectId } from '../../../domain/objects/object-id.js';
import {
  applyDelta,
  type BasePackEntryHeader,
  type BasePackEntryType,
  crc32,
  invalidPackEntry,
  invalidPackHeader,
  PACK_ENTRY_TYPE,
  type PackEntryHeader,
  type PackEntryType,
  type PackHeader,
  type PackIndexEntries,
  parsePackEntryHeader,
  parsePackHeader,
} from '../../../domain/storage/index.js';
import { PACK_HEADER_SIZE } from '../../../domain/storage/pack-entry.js';
import type { InflateStreamResult } from '../../../ports/compressor.js';
import type { Context } from '../../../ports/context.js';
import { errorDataCode } from './error-data-code.js';
import { createPackRecordStore, type PackRecordStore } from './pack-records.js';

/**
 * Resolves an object referenced by a REF_DELTA whose base is absent from the
 * pack being walked. Used by `bundle verify` to complete thin packs against
 * the local object store. Return `undefined` when the base is not available;
 * the caller will treat the delta as unresolvable.
 */
export type ExternalBaseResolver = (
  baseOid: ObjectId,
) => Promise<
  { readonly type: 'commit' | 'tree' | 'blob' | 'tag'; readonly content: Uint8Array } | undefined
>;

/**
 * Default cap on the entry count declared in the pack header. The 32-bit
 * field is server-controlled; without an explicit ceiling, a malicious server
 * could declare 2^32 entries and drive `walkPackEntries` into a DoS loop even
 * though the pack body itself is bounded by `maxResponseBytes`. Matches the
 * order of magnitude beyond which canonical git refuses to operate. Callers
 * can tighten the limit via `ctx.config?.maxObjectsPerPack`.
 */
const DEFAULT_MAX_OBJECT_COUNT = 50_000_000;

/** Reads the quarantined pack back from disk (it was never resident in
 *  memory during receive) and indexes its entries through
 *  `diskPackByteSource` — the same two-pass `indexPackEntries` core
 *  `walkPackEntries` uses, fed by bounded `readSlice` windows instead of one
 *  whole-pack buffer. Failures here mean the body is malformed even though
 *  its trailer verified, so `onFailure` — the caller's quarantine cleanup —
 *  runs before rethrow. */
export const indexQuarantinedPack = async (
  ctx: Context,
  tmpPath: string,
  totalBytes: number,
  onFailure: (path: string) => Promise<void>,
): Promise<PackIndexEntries> => {
  try {
    return await indexPackEntries(ctx, diskPackByteSource(ctx, tmpPath, totalBytes));
  } catch (err) {
    await onFailure(tmpPath);
    throw err;
  }
};

interface WalkedEntry {
  readonly id: string;
  readonly crc32: number;
  readonly offset: number;
}

type BaseTypeName = 'commit' | 'tree' | 'blob' | 'tag';

/**
 * Byte-source seam for the two-pass indexer's sequential and root-down
 * walks: reads either an already-resident pack buffer
 * (`inMemoryPackByteSource` — every existing `walkPackEntries` caller:
 * `bundle-verify.ts`, in-memory fetch paths, unchanged) or the quarantined
 * pack file on disk in bounded windows (`diskPackByteSource` —
 * `indexQuarantinedPack`). Both report entry data through this one shape so
 * the walks below are written once and behave identically over either
 * source.
 *
 * `TCrcContext` lets a source thread whatever it needs from `inflateEntry`
 * into the matching `entryCrc32` call as an ordinary parameter, instead of
 * the caller trusting an undocumented "these two calls happen in this order"
 * invariant enforced only by a shared mutable variable. The in-memory source
 * has nothing to thread (`undefined`); the disk source threads the window
 * `inflateEntry` actually read from.
 */
interface PackByteSource<TCrcContext = undefined> {
  readonly totalBytes: number;
  /** Parses the 12-byte pack header. */
  header(): Promise<PackHeader>;
  /** Parses the entry header starting at `offset`. */
  entryHeader(offset: number): Promise<PackEntryHeader>;
  /**
   * Inflates the zlib stream starting at `dataOffset`. `declaredSize` — the
   * entry header's own declared output length — is passed through so a
   * source can bound the inflate to it; every source does, since every
   * conformant entry inflates to exactly this many bytes, so the bound costs
   * nothing on a valid pack and stops a mismatched stream at the declared
   * size rather than the adapter's much larger default cap. `offset` (the
   * entry's own start) is also given — the disk source anchors its read
   * window there rather than at `dataOffset`, so the window that ends up
   * satisfying inflation also covers the entry's header bytes, letting
   * `entryCrc32` read the whole `[offset, entryEnd)` range back with no
   * further I/O. Returns the inflate result alongside whatever `crcContext`
   * the matching `entryCrc32` call needs.
   */
  inflateEntry(
    offset: number,
    dataOffset: number,
    declaredSize: number,
  ): Promise<{ readonly result: InflateStreamResult; readonly crcContext: TCrcContext }>;
  /** CRC32 over the raw entry bytes `[offset, entryEnd)`. Always called
   *  immediately after `inflateEntry` has resolved that same range, with
   *  the `crcContext` that call returned. */
  entryCrc32(offset: number, entryEnd: number, crcContext: TCrcContext): Promise<number>;
}

/** Wraps an already-resident pack buffer — the shape every existing
 *  `walkPackEntries` caller already provides. No windowing: the buffer IS
 *  the whole pack, exactly as before this change. */
const inMemoryPackByteSource = (ctx: Context, packBytes: Uint8Array): PackByteSource => ({
  totalBytes: packBytes.length,
  header: async () => parsePackHeader(packBytes),
  entryHeader: async (offset) => parsePackEntryHeader(packBytes, offset, ctx.hashConfig),
  inflateEntry: async (_offset, dataOffset, declaredSize) => ({
    result: await ctx.compressor.streamInflate(packBytes, dataOffset, declaredSize),
    crcContext: undefined,
  }),
  entryCrc32: async (offset, entryEnd) => crc32(packBytes.subarray(offset, entryEnd)),
});

/**
 * Bounded read window for walking the quarantined pack back off disk
 * (`diskPackByteSource`). The receive path streams the pack to the
 * quarantine file without ever holding it whole in memory (see the module
 * doc comment); reading it back for the entry walk must keep that same
 * bound rather than reintroducing a whole-pack buffer. 256 KiB is large
 * enough that a typical object's header plus compressed data (commits and
 * trees run a few KB; most blobs too) is satisfied by a single `readSlice`
 * call, small enough that RSS stays flat no matter how large the pack is.
 * On a valid pack this is also the peak: every window growth restarts its
 * doubling ladder from this size, anchored fresh at the entry that needed
 * it, so an entry whose compressed span exceeds one window still resolves
 * correctly with a peak single read of at most that one entry's own
 * compressed span (rounded up to the next doubling, never past
 * `trailerStart`) — never the whole pack, and never inflated by an
 * unrelated entry's earlier growth.
 */
export const DISK_WALK_WINDOW_BYTES = 256 * 1024;

interface DiskWindow {
  readonly start: number;
  readonly bytes: Uint8Array;
}

/**
 * Reads an error's `data.reason` structurally, mirroring `errorDataCode`
 * (`./error-data-code.js`) — a mixed-module-graph harness gives the
 * adapter's `TsgitError` a different class identity than this module's, so
 * `instanceof` can't be trusted; the `data` shape is the stable contract.
 */
const errorDataReason = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null) return undefined;
  const data = (error as { readonly data?: { readonly reason?: unknown } }).data;
  return typeof data?.reason === 'string' ? data.reason : undefined;
};

/**
 * The decompress failure reason that means "the window ended before the
 * entry's zlib stream did" — worth a bigger window. Every adapter's decoder
 * is normalized to raise this exact reason for premature end of input: the
 * zero-dependency decoder (memory/browser adapters, `inflateZlibMember`)
 * raises it directly, and `NodeCompressor.streamInflate` classifies node:zlib's
 * `Z_BUF_ERROR` structurally and re-emits this same string rather than the
 * one node itself uses — node's wording is node's to change, not a contract
 * this module can pin against. Every other decode failure (bad huffman
 * codes, an out-of-range back-reference, a checksum mismatch, the
 * inflated-output safety cap) means the bytes already read are already
 * enough to prove the entry invalid — retrying would only redo the same
 * failing decode against a needlessly larger read, or, for the safety cap,
 * redo the very inflate work the cap exists to cut short. This reason is
 * itself ambiguous — a corrupted length or code table can walk a decoder
 * off the end of a genuinely well-sized window exactly the way a real
 * truncation does — but retrying stays bounded by `trailerStart`, so the
 * worst case is a few extra bounded re-reads, never an unbounded one.
 */
const RETRYABLE_DECOMPRESS_REASON = 'unexpected end of deflate stream';

/** Entry-header parse failures sharing this prefix (`decodeTypeAndSize`,
 *  `decodeOfsDistance`, the REF_DELTA base-id read — see `pack-entry.ts`)
 *  all mean a varint or fixed-width field ran off the end of the bytes it
 *  was given: the same window-too-small shape as the decompress case above.
 *  A reserved/unknown type byte or an over-long size/distance encoding
 *  reports a *different* reason — those are read from bytes that WERE
 *  present, so they are never window-sizing artifacts. */
const RETRYABLE_ENTRY_HEADER_REASON_PREFIX = 'unexpected end of';

/** Whether `w` already IS a fresh window anchored exactly at `anchor`, sized
 *  to the documented window — i.e. growth's next rung must double past it
 *  rather than re-fetch the identical bytes. Any other window (in
 *  particular a REUSED one, started earlier than `anchor`) has not yet had
 *  the documented size tried from `anchor` itself. */
const isFreshDocumentedWindow = (w: DiskWindow, anchor: number, documented: number): boolean =>
  w.start === anchor && w.bytes.length === documented;

/** Whether `w` was itself delivered by a fetch anchored exactly at `anchor`
 *  — as opposed to a REUSED window carried over from an earlier, smaller
 *  offset. Only a window satisfying this has a length that means anything
 *  as a "what did the last fetch AT THIS ANCHOR deliver" baseline. */
const isAnchoredHere = (w: DiskWindow, anchor: number): boolean => w.start === anchor;

const isRetryableWindowFailure = (err: unknown): boolean => {
  const reason = errorDataReason(err);
  if (reason === undefined) return false;
  switch (errorDataCode(err)) {
    case 'INVALID_PACK_ENTRY':
      return reason.startsWith(RETRYABLE_ENTRY_HEADER_REASON_PREFIX);
    case 'DECOMPRESS_FAILED':
      return reason === RETRYABLE_DECOMPRESS_REASON;
    default:
      return false;
  }
};

/**
 * `parsePackEntryHeader` reports `INVALID_PACK_ENTRY.data.offset` as
 * whatever offset it was called with — here, `offset - windowStart`,
 * relative to the currently-held window rather than the pack. Every other
 * offset this module reports (and the in-memory source, where `offset`
 * already IS absolute) is pack-absolute, so the window-relative value is
 * corrected back to absolute before the error can leave this source.
 * Errors of any other shape pass through unchanged.
 */
const withAbsoluteEntryOffset = (err: unknown, windowStart: number): unknown => {
  // Stryker disable next-line EqualityOperator: equivalent — withAbsoluteEntryOffset has one caller (entryHeader's catch, fed only by parsePackEntryHeader), and every throw site in parsePackEntryHeader (pack-entry.ts) uses invalidPackEntry — the pass-through arm for a different code is unreachable.
  if (errorDataCode(err) !== 'INVALID_PACK_ENTRY') return err;
  const data = (err as { readonly data: { readonly offset: number; readonly reason: string } })
    .data;
  return invalidPackEntry(data.offset + windowStart, data.reason);
};

/**
 * Reads the quarantine file at `tmpPath` in bounded `DISK_WALK_WINDOW_BYTES`
 * windows. Pass 1 slides forward through entries in strictly increasing
 * offset order (per the receive-path contract: header parse at `offset`,
 * zlib stream from `dataOffset`, `bytesConsumed` advances to `entryEnd`);
 * pass 2 re-anchors at arbitrary — often earlier — offsets as it re-reads
 * delta bases and walks the forest. A window is reused whenever the next
 * read's start already falls inside it — the common case for pass 1's
 * forward scan, since most objects are far smaller than the window; pass
 * 2's backward anchors fall through to a fresh fetch (`windowCovering`
 * below), which is the same fallback path a forward anchor past the held
 * window already takes.
 *
 * When a header parse or a compressed stream turns out to straddle or
 * exceed the window currently held, `withGrowth` retries — but only for
 * failures `isRetryableWindowFailure` recognises as "ran off the end of the
 * bytes available", and always by re-anchoring fresh at the entry's own
 * `offset` and restarting the doubling ladder at `DISK_WALK_WINDOW_BYTES`,
 * never by doubling whatever window happened to be held (a window reused
 * from an earlier, larger entry would otherwise ratchet the ladder up
 * further with every later entry that also needs to grow, even though each
 * one only ever needs a window sized to its own span). Every other failure
 * — a corrupt type nibble, an over-long size/distance encoding, corrupt
 * zlib data, the inflated-output safety cap — propagates immediately,
 * without growing the window at all. Growth that IS attempted is still
 * capped at `trailerStart`: a retryable failure that persists once the
 * window already reaches every byte the entry could legitimately span is a
 * genuine parse/inflate error, not a sizing problem.
 */
const diskPackByteSource = (
  ctx: Context,
  tmpPath: string,
  totalBytes: number,
): PackByteSource<DiskWindow> => {
  const trailerStart = totalBytes - ctx.hash.digestLength;
  let window: DiskWindow | undefined;

  const fetchWindow = async (start: number, length: number): Promise<DiskWindow> => {
    const bytes = await ctx.fs.readSlice(tmpPath, start, length);
    const fresh: DiskWindow = { start, bytes };
    window = fresh;
    return fresh;
  };

  /** The window size to start from for a fresh read anchored at `anchor`:
   *  the documented window, clamped so it never reaches past the trailer. */
  const initialWindowSize = (anchor: number): number =>
    Math.min(DISK_WALK_WINDOW_BYTES, Math.max(0, trailerStart - anchor));

  /** The size of the next growth-fetch, given the size of the last one
   *  `withGrowth`'s own loop fetched fresh at `anchor` (`0` means none yet).
   *  The first growth fetch is always the plain documented window size —
   *  never a doubling of whatever window happened to be held before the
   *  retry, reused or otherwise; only the second and later growth fetches
   *  for this same anchor double, clamped so growth never reaches past the
   *  trailer. */
  const nextRung = (priorRung: number, anchor: number): number =>
    priorRung === 0 ? initialWindowSize(anchor) : Math.min(priorRung * 2, trailerStart - anchor);

  /** Reuses the held window when `anchor` already falls inside it; fetches
   *  a fresh one, anchored at `anchor`, otherwise — including when `anchor`
   *  falls BEFORE the held window, which pass 2's backward base re-reads
   *  make a real, exercised path rather than a merely theoretical one.
   *  Reuse never checks how much room is left past `anchor` — that is
   *  `withGrowth`'s job below. */
  const windowCovering = async (anchor: number): Promise<DiskWindow> => {
    if (
      window !== undefined &&
      anchor >= window.start &&
      // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent — a window wrongly deemed to cover an anchor past its real extent immediately trips decodeTypeAndSize's own `offset >= bytes.length` guard (pack-entry.ts) with the retryable "unexpected end of header" reason, so growOrRethrow re-fetches at the correct anchor on the very next attempt before any byte is read — same final window and result, one wasted parse in between.
      anchor < window.start + window.bytes.length
    ) {
      return window;
    }
    return fetchWindow(anchor, initialWindowSize(anchor));
  };

  /**
   * Given a retryable failure caught against `w`, fetches the next growth
   * window and folds it into `withGrowth`'s running state — or rethrows
   * `err` when growth cannot help: the failure isn't a sizing problem, the
   * window already reaches `trailerStart`, or — the short-read-filesystem
   * case (NFS/SMB/FUSE — NodeFileSystem.readSlice issues one non-looping
   * handle.read) — the fetch delivered no more than the last one anchored
   * HERE did. Growth is driven by the REQUESTED size (`rung`), but a
   * short-read adapter can keep returning the same capped window forever
   * regardless of how large `rung` grows; the exhaustion check above reads
   * DELIVERED size, so it alone would never trip against such an adapter.
   * `deliveredAtAnchor` is `undefined` only for the very first fetch
   * anchored here (a REUSED window carries no baseline to compare against,
   * so it can never fail this check) — see `isAnchoredHere`.
   */
  const growOrRethrow = async (
    err: unknown,
    w: DiskWindow,
    anchor: number,
    rung: number,
    deliveredAtAnchor: number | undefined,
  ): Promise<{
    readonly w: DiskWindow;
    readonly rung: number;
    readonly deliveredAtAnchor: number;
  }> => {
    if (!isRetryableWindowFailure(err)) throw err;
    if (w.start + w.bytes.length >= trailerStart) throw err;
    const grownRung = nextRung(rung, anchor);
    const grown = await fetchWindow(anchor, grownRung);
    if (deliveredAtAnchor !== undefined && grown.bytes.length <= deliveredAtAnchor) throw err;
    return { w: grown, rung: grownRung, deliveredAtAnchor: grown.bytes.length };
  };

  const withGrowth = async <T>(
    anchor: number,
    attempt: (w: DiskWindow) => Promise<T> | T,
  ): Promise<T> => {
    let w = await windowCovering(anchor);
    const documented = initialWindowSize(anchor);
    // 0 means "no growth fetch made at `anchor` yet" (see `nextRung`); `w`'s
    // first value can instead already BE that fetch — `windowCovering`
    // returns a fresh, documented-size window whenever it didn't reuse one
    // — in which case growth should double past it, not repeat it.
    let rung = isFreshDocumentedWindow(w, anchor, documented) ? documented : 0;
    // `undefined` means "no delivery observed AT THIS ANCHOR yet" — a window
    // REUSED from an earlier, smaller-offset anchor carries no baseline: its
    // length reflects an unrelated fetch, not what a fetch anchored HERE
    // delivers, so it must never fail the non-progress check in
    // `growOrRethrow` (a coincidentally equal length there is not a stall,
    // just two unrelated fetches both clamped to the same documented size).
    let deliveredAtAnchor = isAnchoredHere(w, anchor) ? w.bytes.length : undefined;
    for (;;) {
      try {
        return await attempt(w);
      } catch (err) {
        ({ w, rung, deliveredAtAnchor } = await growOrRethrow(
          err,
          w,
          anchor,
          rung,
          deliveredAtAnchor,
        ));
      }
    }
  };

  return {
    totalBytes,
    header: async () => parsePackHeader(await ctx.fs.readSlice(tmpPath, 0, PACK_HEADER_SIZE)),
    entryHeader: (offset) =>
      withGrowth(offset, (w) => {
        try {
          // `parsePackEntryHeader` reports `dataOffset` as an index into the
          // buffer it was handed — i.e. relative to `w.start`, not the
          // pack's own absolute offsets. Every other seam in this file (and
          // every caller of `entryHeader`) works in absolute offsets, so the
          // shift back happens right here, once, at the window boundary.
          const local = parsePackEntryHeader(w.bytes, offset - w.start, ctx.hashConfig);
          return { ...local, dataOffset: local.dataOffset + w.start };
        } catch (err) {
          throw withAbsoluteEntryOffset(err, w.start);
        }
      }),
    inflateEntry: (offset, dataOffset, declaredSize) =>
      withGrowth(offset, async (w) => ({
        result: await ctx.compressor.streamInflate(w.bytes, dataOffset - w.start, declaredSize),
        crcContext: w,
      })),
    entryCrc32: async (offset, entryEnd, crcContext) => {
      // `crcContext` is the window `inflateEntry` actually read from for
      // this same `offset`. That call cannot have consumed more bytes than
      // it was handed, so `crcContext` necessarily spans through `entryEnd`
      // already — no extra read.
      return crc32(
        crcContext.bytes.subarray(offset - crcContext.start, entryEnd - crcContext.start),
      );
    },
  };
};

/** Minimum bytes one pack entry can occupy: one type/size byte plus the
 *  8-byte zlib stream of an empty payload. Bounds the record store's growth
 *  independently of whatever `header.objectCount` claims — a pack of
 *  `totalBytes` bytes cannot hold more than
 *  `(totalBytes - PACK_HEADER_SIZE - digestLength) / MIN_PACK_ENTRY_BYTES`
 *  real entries, regardless of what its header declares, so this clamp
 *  underneath the store's own geometric growth is what keeps a lying
 *  header from sizing an allocation. */
const MIN_PACK_ENTRY_BYTES = 9;

const structuralMaxEntries = (totalBytes: number, digestLength: number): number =>
  Math.max(0, Math.floor((totalBytes - PACK_HEADER_SIZE - digestLength) / MIN_PACK_ENTRY_BYTES));

/** Whether a raw stored `PackEntryType` byte names a base (non-delta) entry
 *  — the pass-2 counterpart to `isBaseHeader` below, operating on the
 *  record store's own `typeOf(ordinal)` rather than a freshly parsed
 *  `PackEntryHeader`. */
const isBaseType = (type: PackEntryType): type is BasePackEntryType =>
  type === PACK_ENTRY_TYPE.COMMIT ||
  type === PACK_ENTRY_TYPE.TREE ||
  type === PACK_ENTRY_TYPE.BLOB ||
  type === PACK_ENTRY_TYPE.TAG;

/**
 * Pass 1 — sequential scan, retain nothing. Walks every entry once, in
 * strictly increasing offset order, inflating it to learn where the next
 * entry starts (`bytesConsumed`, counted from `dataOffset` — a pack stores
 * no entry lengths). A base entry's oid is hashed incrementally
 * (`ctx.hash.createHasher()`) and its inflated payload dropped immediately
 * after; a delta entry's base position (OFS) or base id (REF) is recorded
 * in the record store and its payload dropped without ever being applied.
 * Peak residency during this pass is one entry's inflated payload plus the
 * read window — nothing else survives the loop.
 */
const scanEntries = async <TCrcContext>(
  ctx: Context,
  source: PackByteSource<TCrcContext>,
): Promise<PackRecordStore> => {
  const header = await source.header();
  const objectCountCap = ctx.config?.maxObjectsPerPack ?? DEFAULT_MAX_OBJECT_COUNT;
  if (header.objectCount > objectCountCap) {
    throw new TsgitError({
      code: 'PACK_TOO_LARGE',
      objectCount: header.objectCount,
      limit: objectCountCap,
    });
  }
  const trailerStart = source.totalBytes - ctx.hash.digestLength;
  const store = createPackRecordStore(
    ctx.hash.digestLength,
    structuralMaxEntries(source.totalBytes, ctx.hash.digestLength),
  );
  let offset = PACK_HEADER_SIZE;
  for (let i = 0; i < header.objectCount; i += 1) {
    const entryHeader = await source.entryHeader(offset);
    const inflated = await source.inflateEntry(offset, entryHeader.dataOffset, entryHeader.size);
    const entryEnd = entryHeader.dataOffset + inflated.result.bytesConsumed;
    // Defence-in-depth guard. The trailer is always verified before either
    // byte source above is ever walked — `verifyPackTrailer` for an
    // in-memory buffer (`bundle-verify.ts`), `receivePackToQuarantine`'s
    // incremental hash for the quarantine file — so the final
    // `digestLength` bytes are fixed as `sha(body)` by the time this runs;
    // `streamInflate` reports the minimal valid zlib-stream length. An
    // entry whose stream consumed bytes past `trailerStart` would require
    // those SHA bytes to also be a valid zlib continuation — unreachable
    // for any verifiable pack.
    // Stryker disable next-line ConditionalExpression,BlockStatement: equivalent — `entryEnd > trailerStart` is unreachable once the trailer has been accepted; the throw cannot fire. Restated against this scan's own loop — the pipeline this replaced made the identical argument at the identical point in an otherwise identical scan.
    if (entryEnd > trailerStart) {
      // Stryker disable next-line StringLiteral: equivalent — the guarded throw is unreachable (see above), so its message is never observed.
      throw invalidPackHeader('entry extends past pack trailer');
    }
    const entryCrc = await source.entryCrc32(offset, entryEnd, inflated.crcContext);
    const ordinal = store.append(offset, entryCrc, entryHeader.type);
    if (isBaseHeader(entryHeader)) {
      const typeName = baseTypeName(entryHeader.type);
      store.setOid(ordinal, await hashObject(ctx, typeName, inflated.result.output));
      // A base entry is resolved the moment its oid is known — pass 2 never
      // revisits this flag for it, only for the deltas that chain off it.
      store.markResolved(ordinal);
    } else if (entryHeader.type === PACK_ENTRY_TYPE.OFS_DELTA) {
      // `recordOfsDelta` applies the widened out-of-bound guard: a distance
      // landing before the pack body OR at/after the entry's own offset
      // (including the self-referential distance-0 case) refuses here with
      // git's own reason. A distance that lands in range but not on a real
      // entry boundary is not caught here — it stays an unresolved-delta
      // count, the same split git makes.
      store.recordOfsDelta(ordinal, offset - entryHeader.baseDistance);
    } else {
      store.recordRefDelta(ordinal, hexToBytes(entryHeader.baseId));
    }
    offset = entryEnd;
  }
  if (offset !== trailerStart) {
    throw invalidPackHeader('extra bytes between last entry and trailer');
  }
  store.buildChildIndexes();
  return store;
};

/** One frame of pass 2's explicit stack: a resolved parent's content, held
 *  only while it still has children left to resolve. `cursor` is the
 *  "children remaining" counter, counting UP against `children.length`
 *  rather than down — equivalent, and simpler to pair with a plain array.
 *  The frame — and with it the only remaining reference to `content` — is
 *  popped the instant `cursor` reaches `children.length`: the load-bearing
 *  release the memory bound depends on (a linear chain then retains two
 *  objects at a time regardless of depth; only a branching subtree retains
 *  more, and only for as long as it still has unresolved children). */
interface WalkFrame {
  readonly content: Uint8Array;
  readonly typeName: BaseTypeName;
  readonly children: ReadonlyArray<number>;
  cursor: number;
}

/** Every entry ordinal chained onto `offset` (OFS) or `oidBytes` (REF),
 *  merged into one plain array via a loop — never `push(...spread)`, which
 *  overflows the call stack near 125k arguments and a real clone's delta
 *  forest can exceed. */
const collectChildren = (
  store: PackRecordStore,
  offset: number,
  oidBytes: Uint8Array,
): number[] => {
  const children: number[] = [];
  const ofsRange = store.ofsChildren(offset);
  for (let p = ofsRange.start; p < ofsRange.end; p += 1) {
    children.push(store.ofsChildOrdinalAt(p));
  }
  const refRange = store.refChildren(oidBytes);
  for (let p = refRange.start; p < refRange.end; p += 1) {
    children.push(store.refChildOrdinalAt(p));
  }
  return children;
};

/**
 * Depth-first walk of one forest root's subtree via an explicit stack —
 * never recursion, since depth is uncapped (git itself accepts chains a
 * thousand deep) and must cost heap, not JS call frames. The `isResolved`
 * check below is not defensive padding: a pack may legally carry the same
 * oid twice (git's default fetch accepts it, `transfer.fsckObjects`
 * defaulting false), which makes a REF delta keyed on that oid a child of
 * two parents; without the check it would be applied twice and
 * `resolvedCount` would overshoot `objectCount`, turning the unresolved
 * count into nonsense.
 */
const walkFromRoot = async <TCrcContext>(
  ctx: Context,
  source: PackByteSource<TCrcContext>,
  store: PackRecordStore,
  rootContent: Uint8Array,
  typeName: BaseTypeName,
  rootChildren: ReadonlyArray<number>,
): Promise<void> => {
  const stack: WalkFrame[] = [
    { content: rootContent, typeName, children: rootChildren, cursor: 0 },
  ];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    if (frame.cursor >= frame.children.length) {
      stack.pop();
      continue;
    }
    const childOrdinal = frame.children[frame.cursor]!;
    frame.cursor += 1;
    if (store.isResolved(childOrdinal)) continue;
    const childOffset = store.offsetOf(childOrdinal);
    const childHeader = await source.entryHeader(childOffset);
    const inflated = await source.inflateEntry(
      childOffset,
      childHeader.dataOffset,
      childHeader.size,
    );
    const childContent = applyDelta(frame.content, inflated.result.output);
    const oidBytes = await hashObject(ctx, frame.typeName, childContent);
    store.setOid(childOrdinal, oidBytes);
    store.markResolved(childOrdinal);
    const grandchildren = collectChildren(store, childOffset, oidBytes);
    stack.push({
      content: childContent,
      typeName: frame.typeName,
      children: grandchildren,
      cursor: 0,
    });
  }
};

/**
 * Pass 2 — resolve from the roots down. Every base-typed entry is a forest
 * root, visited in increasing offset order (the store's own append order,
 * since pass 1 appends strictly forward) so root reads stay sequential;
 * child reads jump around, which is unavoidable — the forest's shape is the
 * server's choice. A root with no children is never re-inflated at all: its
 * oid is already known from pass 1, and content is only ever needed to
 * resolve children.
 */
const resolveFromRoots = async <TCrcContext>(
  ctx: Context,
  source: PackByteSource<TCrcContext>,
  store: PackRecordStore,
): Promise<void> => {
  const { oids } = store.view();
  for (let ordinal = 0; ordinal < store.count; ordinal += 1) {
    const type = store.typeOf(ordinal);
    if (!isBaseType(type)) continue;
    const offset = store.offsetOf(ordinal);
    const oidRange = store.oidRangeOf(ordinal);
    const oidBytes = oids.subarray(oidRange.start, oidRange.end);
    const children = collectChildren(store, offset, oidBytes);
    if (children.length === 0) continue;
    const header = await source.entryHeader(offset);
    const inflated = await source.inflateEntry(offset, header.dataOffset, header.size);
    await walkFromRoot(ctx, source, store, inflated.result.output, baseTypeName(type), children);
  }
};

/**
 * Thin-pack completion: after the in-pack walk, every REF delta still
 * unresolved is offered — in the order pass 1 recorded it — to
 * `externalBaseResolver`. A resolved external base becomes an extra forest
 * root exactly like an in-pack one: `walkFromRoot` resolves the orphaned
 * delta itself against it, then descends into whatever chains onto that
 * delta's own offset or oid, so a multi-entry thin chain hanging off one
 * missing base resolves in a single sweep regardless of which entry in the
 * chain happens to be recorded first. `applyDelta`'s own base-length guard
 * refuses a wrong-sized external base rather than reconstructing garbage.
 */
const resolveExternalBases = async <TCrcContext>(
  ctx: Context,
  source: PackByteSource<TCrcContext>,
  store: PackRecordStore,
  externalBaseResolver: ExternalBaseResolver,
): Promise<void> => {
  for (let r = 0; r < store.refDeltaCount; r += 1) {
    const ordinal = store.refDeltaOrdinalAt(r);
    if (store.isResolved(ordinal)) continue;
    const baseOid = bytesToHex(store.refDeltaBaseOidAt(r)) as ObjectId;
    const external = await externalBaseResolver(baseOid);
    if (external === undefined) continue;
    const offset = store.offsetOf(ordinal);
    const header = await source.entryHeader(offset);
    const inflated = await source.inflateEntry(offset, header.dataOffset, header.size);
    const content = applyDelta(external.content, inflated.result.output);
    const oidBytes = await hashObject(ctx, external.type, content);
    store.setOid(ordinal, oidBytes);
    store.markResolved(ordinal);
    const children = collectChildren(store, offset, oidBytes);
    if (children.length > 0) {
      await walkFromRoot(ctx, source, store, content, external.type, children);
    }
  }
};

/**
 * Module-private core: both passes over one `PackByteSource`, then the
 * refusal check. After the walk (and, when given a resolver, the thin-pack
 * sweep), `resolvedCount < objectCount` means some delta was never
 * reachable — a REF cycle, an all-deltas pack with no base entry, or an OFS
 * base offset landing mid-entry (three cases that converge here, exactly as
 * they do in git). The refusal is git's own count, singular at one, under
 * the unchanged `INVALID_PACK_HEADER` code.
 */
const indexPackEntries = async <TCrcContext>(
  ctx: Context,
  source: PackByteSource<TCrcContext>,
  externalBaseResolver?: ExternalBaseResolver,
): Promise<PackIndexEntries> => {
  const store = await scanEntries(ctx, source);
  await resolveFromRoots(ctx, source, store);
  if (externalBaseResolver !== undefined && store.resolvedCount < store.count) {
    await resolveExternalBases(ctx, source, store, externalBaseResolver);
  }
  const unresolvedCount = store.count - store.resolvedCount;
  if (unresolvedCount > 0) {
    throw invalidPackHeader(
      `pack has ${unresolvedCount} unresolved delta${unresolvedCount === 1 ? '' : 's'}`,
    );
  }
  return store.view();
};

export const walkPackEntries = async (
  ctx: Context,
  packBytes: Uint8Array,
  externalBaseResolver?: ExternalBaseResolver,
): Promise<ReadonlyArray<WalkedEntry>> => {
  const entries = await indexPackEntries(
    ctx,
    inMemoryPackByteSource(ctx, packBytes),
    externalBaseResolver,
  );
  const walked: WalkedEntry[] = [];
  for (let i = 0; i < entries.count; i += 1) {
    const start = i * entries.digestLength;
    const end = start + entries.digestLength;
    walked.push({
      id: bytesToHex(entries.oids.subarray(start, end)),
      // `crcValues` is a signed `Int32Array` (the `.idx`/`.rev` byte-level
      // shape); `crc32()` and this module's own `WalkedEntry` contract are
      // unsigned, so the bit pattern is reinterpreted back on the way out.
      crc32: (entries.crcValues[i] ?? 0) >>> 0,
      offset: entries.offsets[i] ?? 0,
    });
  }
  return walked;
};

const isBaseHeader = (header: PackEntryHeader): header is BasePackEntryHeader => {
  return (
    header.type === PACK_ENTRY_TYPE.COMMIT ||
    header.type === PACK_ENTRY_TYPE.TREE ||
    header.type === PACK_ENTRY_TYPE.BLOB ||
    header.type === PACK_ENTRY_TYPE.TAG
  );
};

const baseTypeName = (type: BasePackEntryHeader['type']): BaseTypeName => {
  switch (type) {
    case PACK_ENTRY_TYPE.COMMIT:
      return 'commit';
    case PACK_ENTRY_TYPE.TREE:
      return 'tree';
    case PACK_ENTRY_TYPE.BLOB:
      return 'blob';
    case PACK_ENTRY_TYPE.TAG:
      return 'tag';
  }
};

const TEXT_ENCODER = new TextEncoder();

/**
 * Computes an object's oid incrementally: `ctx.hash.createHasher()` fed the
 * loose header then the content, never a second concatenated copy the way
 * the deleted `computeLooseObjectId` used to build purely to hand
 * `ctx.hash.hashHex` one buffer. Node's `createHasher()` wraps
 * `crypto.createHash` and streams genuinely; the memory and browser adapters
 * collect chunks and concatenate at `digest()` time (no streaming digest in
 * SubtleCrypto), so this is a clear win on Node and exactly neutral
 * elsewhere — it never regresses.
 */
const hashObject = async (
  ctx: Context,
  typeName: BaseTypeName,
  content: Uint8Array,
): Promise<Uint8Array> => {
  const headerBytes = TEXT_ENCODER.encode(`${typeName} ${content.length}\0`);
  const hasher = ctx.hash.createHasher();
  hasher.update(headerBytes);
  hasher.update(content);
  return hexToBytes(await hasher.digestHex());
};
