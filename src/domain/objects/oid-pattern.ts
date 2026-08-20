import type { HashConfig } from './hash-config.js';

/**
 * Repository-aware oid predicate. `isOid` is true iff `value` is exactly
 * `config.hexLength` lower-case hex characters — width alone does NOT
 * determine validity: a 40-hex string is a full oid under `SHA1_CONFIG`
 * but only a *prefix* under `SHA256_CONFIG` (measured against real git —
 * `rev-parse --verify` on a 40-hex string resolves in a SHA-256 repository).
 * Never branch on `hexLength === 40` or `digestLength === 20` to mean
 * "sha1": the discriminator is `config.algorithm`.
 *
 * `config` is a plain argument, not read from ambient context, so a caller
 * can pass a different repository's (or a bundle's) declared algorithm
 * instead of the current repository's.
 *
 * `looksLikeObjectId` (`application/primitives/validators.ts`) is a
 * config-free FORMAT check (accepts 40 OR 64 hex) — it is not a substitute
 * for this predicate anywhere the repository's hash config is known.
 */
export function oidPattern(config: HashConfig): RegExp {
  return new RegExp(`^[0-9a-f]{${config.hexLength}}$`);
}

export function isOid(value: string, config: HashConfig): boolean {
  return oidPattern(config).test(value);
}
