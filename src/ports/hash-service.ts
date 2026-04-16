/** Incremental hash computation context. Single-use: consumed after digest. */
export interface Hasher {
  /** Feed data into the hash. Can be called multiple times before digest. Throws HASH_FAILED if called after digest/digestHex. */
  readonly update: (data: Uint8Array) => void;
  /** Finalize and return the raw digest bytes. Consumes the hasher — no further update/digest calls allowed. */
  readonly digest: () => Promise<Uint8Array>;
  /** Finalize and return the hex-encoded digest. Consumes the hasher — no further update/digest calls allowed. */
  readonly digestHex: () => Promise<string>;
}

export interface HashService {
  /** Compute the digest of data in one shot. Returns raw bytes (20 for SHA-1, 32 for SHA-256). */
  readonly hash: (data: Uint8Array) => Promise<Uint8Array>;
  /** Compute the hex-encoded digest of data in one shot. */
  readonly hashHex: (data: Uint8Array) => Promise<string>;
  /** Create an incremental hasher for streaming hash computation. */
  readonly createHasher: () => Hasher;
  /** The hash algorithm name. */
  readonly algorithm: 'sha1' | 'sha256';
  /** Digest length in bytes (20 for SHA-1, 32 for SHA-256). */
  readonly digestLength: 20 | 32;
}
