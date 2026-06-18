/**
 * Memory-runtime entry point. Selected by `package.json` `"exports"` for
 * non-Node, non-browser runtimes — and explicitly available at
 * `tsgit/auto/memory` for tests and deterministic fixtures regardless of
 * the active runtime.
 *
 * Builds the runtime fallback (memory adapters + a `/repo`-rooted layout)
 * and forwards every `openRepository(opts)` call to the core factory with
 * the fallback pre-bound.
 */

import { MemoryCompressor } from './adapters/memory/memory-compressor.js';
import { MemoryFileSystem } from './adapters/memory/memory-file-system.js';
import { MemoryHashService } from './adapters/memory/memory-hash-service.js';
import { MemoryHttpTransport } from './adapters/memory/memory-http-transport.js';
import { SHA1_CONFIG, SHA256_CONFIG } from './domain/objects/hash-config.js';
import { createLruCache } from './domain/storage/lru-cache.js';
import {
  type OpenRepositoryOptions,
  openRepository as openRepositoryCore,
  type Repository,
} from './repository.js';

const DEFAULT_WORK_DIR = '/repo';
const DEFAULT_GIT_DIR = '/repo/.git';
const DEFAULT_DELTA_CACHE_BYTES = 16 * 1024 * 1024;

/**
 * Memory-runtime extension to `OpenRepositoryOptions`. Adds the deterministic-
 * algorithm switch (sha1 vs sha256) and the optional initial in-memory FS
 * seed used by tests and lab harnesses. Anything not listed here is
 * forwarded verbatim to the core `openRepository`.
 */
export interface OpenMemoryRepositoryOptions extends OpenRepositoryOptions {
  /** Initial in-memory FS seed. Maps absolute paths to file bytes. */
  readonly files?: Readonly<Record<string, Uint8Array>>;
  /** Hash algorithm used by the runtime adapter. Default 'sha1'. */
  readonly algorithm?: 'sha1' | 'sha256';
}

export const openRepository = async (
  opts: OpenMemoryRepositoryOptions = {},
): Promise<Repository> => {
  const algorithm = opts.algorithm ?? 'sha1';
  const fsOptions =
    opts.files === undefined
      ? { rootDir: DEFAULT_WORK_DIR }
      : { rootDir: DEFAULT_WORK_DIR, files: opts.files };
  const fallback = {
    fs: new MemoryFileSystem(fsOptions),
    hash: new MemoryHashService(algorithm),
    compressor: new MemoryCompressor(),
    transport: new MemoryHttpTransport(),
    runtime: 'memory' as const,
    layout: { workDir: DEFAULT_WORK_DIR, gitDir: DEFAULT_GIT_DIR, bare: false },
    hashConfig: algorithm === 'sha256' ? SHA256_CONFIG : SHA1_CONFIG,
    deltaCache: createLruCache<Uint8Array>(DEFAULT_DELTA_CACHE_BYTES),
  };
  // Strip the memory-only opts before forwarding so the core sees only
  // its own option surface.
  const { files: _f, algorithm: _a, ...coreOpts } = opts;
  return openRepositoryCore({ cwd: DEFAULT_WORK_DIR, ...coreOpts }, fallback);
};

export type { AdapterSet } from './adapter-detect.js';
export { detectRuntime, isBrowser, isNode } from './adapter-detect.js';
export { consoleProgress, noopProgress, type ProgressReporter } from './progress.js';
export * from './public-types.js';
export type { OpenRepositoryOptions, Repository } from './repository.js';
