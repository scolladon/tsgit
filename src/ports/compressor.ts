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

  /** Inflate (decompress) zlib-compressed data. */
  readonly inflate: (data: Uint8Array) => Promise<Uint8Array>;

  /**
   * Inflate one zlib stream starting at `offset` in `bytes`, stopping at the
   * zlib terminator. Used by the pack-file resolver, where each entry is a
   * separate zlib stream concatenated with other entries; the resolver does
   * not know the compressed length of a single entry a priori.
   *
   * Returns the inflated output and the number of input bytes consumed
   * (measured from `offset`). Throws DECOMPRESS_FAILED when the input at
   * `offset` is not a valid zlib stream.
   */
  readonly streamInflate: (bytes: Uint8Array, offset: number) => Promise<InflateStreamResult>;

  /**
   * Create a streaming inflate transform.
   * Returns a TransformStream that inflates chunks incrementally.
   * Used for large packfile entries to avoid buffering entire objects.
   */
  readonly createInflateStream: () => TransformStream<Uint8Array, Uint8Array>;
}
