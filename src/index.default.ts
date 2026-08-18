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
import { fileSystemLayoutProbe } from './repository/file-system-layout-probe.js';
import { portablePosixPolicy } from './repository/portable-posix-policy.js';
import { resolveLayout, syntheticFallbackLayout } from './repository/resolve-layout.js';
import { validateOptions } from './repository/validate-options.js';
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
  // Stryker disable next-line CallExpression: equivalent — `openRepositoryCore` (below, forwarding the SAME unmodified `opts` fields) runs `validateOptions` again at `repository.ts`; removing this eager call cannot change any thrown error, only where it is thrown from — confirmed empirically (an invalid `gitDir` still throws the identical `INVALID_OPTION` shape via the core's re-check).
  validateOptions(opts);
  const algorithm = opts.algorithm ?? 'sha1';
  const fsOptions =
    opts.files === undefined
      ? { rootDir: DEFAULT_WORK_DIR }
      : { rootDir: DEFAULT_WORK_DIR, files: opts.files };
  const fs = new MemoryFileSystem(fsOptions);
  const cwd = opts.cwd ?? DEFAULT_WORK_DIR;
  // `portablePosixPolicy`, not the node-backed `posixPolicy`: this entry is the
  // runtime-agnostic default condition, and a value import of the node policy
  // would drag `node:path` into runtimes that lack it. Safe subset: the core
  // rejects a non-absolute `cwd` and the default is `/repo`. No realpath
  // step (unlike the node shim): the sandboxed adapter has no symlinks to
  // resolve, so `gitDir`/`workDir`/`ceilingDirs` are forwarded lexically.
  const probe = fileSystemLayoutProbe(fs);
  const explicit = {
    ...(opts.workDir !== undefined ? { workDir: opts.workDir } : {}),
    ...(opts.bare !== undefined ? { bare: opts.bare } : {}),
  };
  // The found-nothing fallback anchors at the fixed `/repo` root (this
  // runtime's historical bootstrap contract) and honours `opts.bare` /
  // `opts.workDir` — but reads NOTHING from disk: discovery already judged
  // there is no repository, so no config of a rejected `.git` participates.
  // A relative `opts.workDir` resolves against the caller's `cwd`, the same
  // base as on the discovery path.
  const layout =
    (await resolveLayout(probe, cwd, portablePosixPolicy, {
      ...(opts.gitDir !== undefined ? { gitDir: opts.gitDir } : {}),
      ...explicit,
      ...(opts.ceilingDirs !== undefined ? { ceilingDirs: opts.ceilingDirs } : {}),
    })) ??
    syntheticFallbackLayout(DEFAULT_GIT_DIR, DEFAULT_WORK_DIR, cwd, explicit, portablePosixPolicy);
  const fallback = {
    fs,
    hash: new MemoryHashService(algorithm),
    compressor: new MemoryCompressor(),
    transport: new MemoryHttpTransport(),
    runtime: 'memory' as const,
    layout,
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
export { TsgitError, type TsgitErrorData } from './domain/error.js';
export { consoleProgress, noopProgress, type ProgressReporter } from './progress.js';
export * from './public-types.js';
export type { OpenRepositoryOptions, Repository } from './repository.js';
