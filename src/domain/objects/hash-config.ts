export interface HashConfig {
  readonly digestLength: 20 | 32;
  readonly hexLength: 40 | 64;
}

export const SHA1_CONFIG: HashConfig = Object.freeze({
  digestLength: 20,
  hexLength: 40,
});

export const SHA256_CONFIG: HashConfig = Object.freeze({
  digestLength: 32,
  hexLength: 64,
});
