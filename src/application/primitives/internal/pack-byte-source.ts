/**
 * `PackByteSource` — the byte-source seam `index-pack.ts`'s two-pass walk
 * runs over: reads either an already-resident pack buffer
 * (`inMemoryPackByteSource` — every existing `walkPackEntries` caller:
 * `bundle-verify.ts`, in-memory fetch paths, unchanged) or the quarantined
 * pack file on disk in bounded windows (`diskPackByteSource` —
 * `indexQuarantinedPack`). Both report entry data through this one shape so
 * the walks in `index-pack.ts` are written once and behave identically over
 * either source. Split into its own module purely to keep `index-pack.ts`
 * under the repo's line ceiling — nothing about either source's observable
 * behaviour changes here.
 */

import type { PackEntryHeader, PackHeader } from '../../../domain/storage/index.js';
import {
  crc32,
  invalidPackEntry,
  parsePackEntryHeader,
  parsePackHeader,
} from '../../../domain/storage/index.js';
import { PACK_HEADER_SIZE } from '../../../domain/storage/pack-entry.js';
import type { InflateStreamResult } from '../../../ports/compressor.js';
import type { Context } from '../../../ports/context.js';
import { errorDataCode } from './error-data-code.js';

/**
 * `TCrcContext` lets a source thread whatever it needs from `inflateEntry`
 * into the matching `entryCrc32` call as an ordinary parameter, instead of
 * the caller trusting an undocumented "these two calls happen in this order"
 * invariant enforced only by a shared mutable variable. The in-memory source
 * has nothing to thread (`undefined`); the disk source threads the window
 * `inflateEntry` actually read from.
 */
export interface PackByteSource<TCrcContext = undefined> {
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
export const inMemoryPackByteSource = (ctx: Context, packBytes: Uint8Array): PackByteSource => ({
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
 * quarantine file without ever holding it whole in memory; reading it back
 * for the entry walk must keep that same bound rather than reintroducing a
 * whole-pack buffer. 256 KiB is large enough that a typical object's header
 * plus compressed data (commits and trees run a few KB; most blobs too) is
 * satisfied by a single `readSlice` call, small enough that RSS stays flat
 * no matter how large the pack is. On a valid pack this is also the peak:
 * every window growth restarts its doubling ladder from this size, anchored
 * fresh at the entry that needed it, so an entry whose compressed span
 * exceeds one window still resolves correctly with a peak single read of at
 * most that one entry's own compressed span (rounded up to the next
 * doubling, never past `trailerStart`) — never the whole pack, and never
 * inflated by an unrelated entry's earlier growth.
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
export const diskPackByteSource = (
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
