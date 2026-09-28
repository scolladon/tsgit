/**
 * Reason `DECOMPRESS_FAILED` carries when `inflate` or `streamInflate` hits
 * its output cap — owned once here so every adapter reports the identical
 * wording and a caller (e.g. `fetch-pack.ts`'s window-growth retry) can
 * classify a cap hit by reason alone.
 */
export const INFLATE_CAP_EXCEEDED_REASON = 'inflated output exceeds safety cap';

/**
 * Reason `DECOMPRESS_FAILED` carries when a zlib stream ends before its data
 * does. Owned once here (rather than each adapter re-deriving its own
 * wording, or passing node:zlib's own message through — node's wording is
 * node's to change at any point) so `inflate.ts`'s zero-dependency decoder
 * and `node-compressor.ts`'s node:zlib-backed one report one string
 * regardless of which adapter decoded the stream, letting a caller that
 * classifies `DECOMPRESS_FAILED` by reason (e.g. `fetch-pack.ts`'s
 * window-growth retry) treat both adapters identically.
 */
export const TRUNCATED_STREAM_REASON = 'unexpected end of deflate stream';

/**
 * Hard ceiling on one-shot inflated output across every adapter, defeating
 * decompression-bomb amplification. A caller-supplied `maxOutputBytes` can
 * only narrow this ceiling, never raise it.
 */
export const MAX_INFLATE_OUTPUT_BYTES = 2 * 1024 * 1024 * 1024;

export interface InflateStreamResult {
  /** The fully-inflated output bytes. */
  readonly output: Uint8Array;
  /** The number of input bytes consumed, counted from `offset`. */
  readonly bytesConsumed: number;
}

export interface Compressor {
  /**
   * Deflate (compress) data using zlib deflate format (RFC 1950).
   * `level` (when given and in zlib's -1..9 domain) tunes the compression
   * level; adapters that cannot set a level accept and ignore it.
   */
  readonly deflate: (data: Uint8Array, level?: number) => Promise<Uint8Array>;

  /**
   * Raw DEFLATE (compress) using bare RFC 1951 bitstream — no zlib (RFC 1950)
   * 2-byte header and no adler32 trailer. `level` semantics match `deflate`.
   * Used by zip archive serializer (method 8). Additive — `deflate` unchanged.
   */
  readonly deflateRaw: (data: Uint8Array, level?: number) => Promise<Uint8Array>;

  /**
   * Inflate (decompress) zlib-compressed data. `maxOutputBytes`, when given,
   * bounds the inflated output: the adapter must abort as soon as
   * cumulative output exceeds it, incrementally during decode — never by
   * inflating in full and then checking the result's length. The effective
   * cap is always the minimum of `maxOutputBytes` and the adapter's own
   * default cap; a caller can only narrow the cap, never raise it. Omitting
   * it preserves the adapter's own default behaviour. Throws
   * DECOMPRESS_FAILED with reason INFLATE_CAP_EXCEEDED_REASON when the
   * effective cap is exceeded.
   */
  readonly inflate: (data: Uint8Array, maxOutputBytes?: number) => Promise<Uint8Array>;

  /**
   * Inflate at most the leading `maxOutputBytes` of a zlib stream's output,
   * without requiring the stream to be complete. Unlike `inflate` and
   * `streamInflate`, reaching the bound is never an error: the call
   * truncates and returns exactly `maxOutputBytes` bytes, or the stream's
   * whole output when that is shorter. Throws DECOMPRESS_FAILED only when
   * the input decoded so far is not valid zlib data. Used to probe a
   * stream's leading bytes (e.g. a loose object's header) without inflating
   * the rest of it.
   */
  readonly inflateHead: (data: Uint8Array, maxOutputBytes: number) => Promise<Uint8Array>;

  /**
   * Inflate one zlib stream starting at `offset` in `bytes`, stopping at the
   * zlib terminator. Used by the pack-file resolver, where each entry is a
   * separate zlib stream concatenated with other entries; the resolver does
   * not know the compressed length of a single entry a priori.
   *
   * `maxOutputBytes`, when given, bounds this one call's inflated output: the
   * adapter must abort as soon as cumulative output exceeds it, incrementally
   * during decode — never by inflating in full and then checking the result's
   * length. The effective cap is always the minimum of `maxOutputBytes` and
   * the adapter's own default cap; a caller can only narrow the cap, never
   * raise it. Omitting it preserves the adapter's own default behaviour.
   *
   * Returns the inflated output and the number of input bytes consumed
   * (measured from `offset`). Throws DECOMPRESS_FAILED when the input at
   * `offset` is not a valid zlib stream, or when the output exceeds the
   * effective cap.
   */
  readonly streamInflate: (
    bytes: Uint8Array,
    offset: number,
    maxOutputBytes?: number,
  ) => Promise<InflateStreamResult>;

  /**
   * Create a streaming inflate transform.
   * Returns a TransformStream that inflates chunks incrementally.
   * Used for large packfile entries to avoid buffering entire objects.
   */
  readonly createInflateStream: () => TransformStream<Uint8Array, Uint8Array>;
}
