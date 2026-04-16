export interface Compressor {
  /** Deflate (compress) data using zlib deflate format (RFC 1950). */
  readonly deflate: (data: Uint8Array) => Promise<Uint8Array>;

  /** Inflate (decompress) zlib-compressed data. */
  readonly inflate: (data: Uint8Array) => Promise<Uint8Array>;

  /**
   * Create a streaming inflate transform.
   * Returns a TransformStream that inflates chunks incrementally.
   * Used for large packfile entries to avoid buffering entire objects.
   */
  readonly createInflateStream: () => TransformStream<Uint8Array, Uint8Array>;
}
