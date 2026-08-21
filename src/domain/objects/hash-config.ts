export interface HashConfig {
  readonly algorithm: 'sha1' | 'sha256';
  readonly digestLength: 20 | 32;
  readonly hexLength: 40 | 64;
}

export const SHA1_CONFIG: HashConfig = Object.freeze({
  algorithm: 'sha1',
  digestLength: 20,
  hexLength: 40,
});

export const SHA256_CONFIG: HashConfig = Object.freeze({
  algorithm: 'sha256',
  digestLength: 32,
  hexLength: 64,
});

/** The canonical `HashConfig` for `algorithm` — the shared lookup every entry uses in place of a repeated ternary. */
export const configFor = (algorithm: 'sha1' | 'sha256'): HashConfig =>
  algorithm === 'sha256' ? SHA256_CONFIG : SHA1_CONFIG;
