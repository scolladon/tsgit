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
 * There is deliberately no config-free "looks like an oid" companion that
 * accepts 40 OR 64 hex. Such a predicate cannot tell a full SHA-1 oid from a
 * 40-character PREFIX of a SHA-256 one, and every caller in this codebase
 * knows its repository's config, so the width-permissive form has no correct
 * use here.
 */
// One frozen pattern per algorithm, selected rather than constructed. These
// are module CONSTANTS, not a cache: nothing is ever inserted or evicted, so
// there is no mutable shared state. `.test()` keeps no cursor without the `g`
// or `y` flag, so handing the same instance to every caller is safe.
const SHA1_OID_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_OID_PATTERN = /^[0-9a-f]{64}$/;

export function oidPattern(config: HashConfig): RegExp {
  return config.algorithm === 'sha256' ? SHA256_OID_PATTERN : SHA1_OID_PATTERN;
}

export function isOid(value: string, config: HashConfig): boolean {
  return oidPattern(config).test(value);
}
