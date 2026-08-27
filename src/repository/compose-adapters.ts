import { adapterUnavailable } from '../domain/commands/error.js';
import type { Compressor } from '../ports/compressor.js';
import type { FileSystem } from '../ports/file-system.js';
import type { HashService } from '../ports/hash-service.js';
import type { HttpTransport } from '../ports/http-transport.js';

/**
 * The four-port set the facade plumbs into Context. §5 gives users
 * partial-override granularity: any subset of the four can be supplied, with
 * the rest falling back to the runtime-detected set.
 */
interface AdapterOverrides {
  readonly fs?: FileSystem;
  readonly hash?: HashService;
  readonly compressor?: Compressor;
  readonly transport?: HttpTransport;
}

/**
 * Fallback set provided by the calling runtime shim. Each slot is the
 * detected adapter for that runtime; `runtime` carries the label so missing-
 * adapter errors can surface the right context.
 */
interface AdapterFallback {
  readonly fs: FileSystem;
  readonly hash: HashService;
  readonly compressor: Compressor;
  readonly transport: HttpTransport;
  readonly runtime: 'node' | 'browser' | 'memory';
}

/** Resolved four-port set ready for Context construction. */
interface ResolvedAdapters {
  readonly fs: FileSystem;
  readonly hash: HashService;
  readonly compressor: Compressor;
  readonly transport: HttpTransport;
}

/**
 * Provenance brand for the `fs` slot: membership means "this exact object
 * came from the runtime's own fallback set, never from a caller-supplied
 * `opts.fs`". A `WeakSet` (not a field on the object) so the brand can never
 * leak into the `FileSystem` port's structural shape or be spoofed by a
 * caller building a look-alike object — membership is by REFERENCE only, set
 * once, here, in the one place that knows which arm supplied the value.
 *
 * This is what lets the facade skip the containment wrapper's read guarding
 * for first-party adapters (Node/Memory/browser), whose own read surfaces
 * already enforce containment, while a user-supplied `fs` keeps both layers
 * exactly as before.
 */
const firstPartyFs = new WeakSet<FileSystem>();

/**
 * True when `fs` is the exact object `composeAdapters` sourced from the
 * runtime fallback (never from `overrides.fs`) on some prior call. A
 * user-supplied `fs` — even one that happens to be a `NodeFileSystem`/
 * `MemoryFileSystem` instance the caller obtained elsewhere — is NEVER
 * branded: the provenance signal is "which arm supplied it", not "what class
 * is it".
 */
export const isFirstPartyFs = (fs: FileSystem): boolean => firstPartyFs.has(fs);

/**
 * Merge user overrides with the runtime fallback. For each port: user-supplied
 * wins; missing falls back to the detected adapter. If the merged slot is
 * still undefined (e.g., a runtime didn't supply that port and the user didn't
 * either), throws `ADAPTER_UNAVAILABLE` with the runtime label and the missing
 * port name.
 */
export const composeAdapters = (
  overrides: AdapterOverrides,
  fallback: AdapterFallback,
): ResolvedAdapters => {
  const resolved = {
    fs: overrides.fs ?? fallback.fs,
    hash: overrides.hash ?? fallback.hash,
    compressor: overrides.compressor ?? fallback.compressor,
    transport: overrides.transport ?? fallback.transport,
  };
  if (resolved.fs === undefined) throw adapterUnavailable(fallback.runtime, 'fs adapter missing');
  if (resolved.hash === undefined)
    throw adapterUnavailable(fallback.runtime, 'hash adapter missing');
  if (resolved.compressor === undefined)
    throw adapterUnavailable(fallback.runtime, 'compressor adapter missing');
  if (resolved.transport === undefined)
    throw adapterUnavailable(fallback.runtime, 'transport adapter missing');
  if (overrides.fs === undefined) firstPartyFs.add(resolved.fs);
  return resolved;
};
