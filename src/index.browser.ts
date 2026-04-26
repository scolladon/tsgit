/// <reference lib="dom" />
/**
 * Browser-runtime entry point. Selected by `package.json` `"exports"` for the
 * `browser` condition. Builds the runtime fallback (OPFS-backed FS +
 * SubtleCrypto-backed hash + browser HTTP transport) and forwards every
 * `openRepository(opts)` call to the core factory with the fallback pre-bound.
 */
import { BrowserCompressor } from './adapters/browser/browser-compressor.js';
import { BrowserFileSystem } from './adapters/browser/browser-file-system.js';
import { BrowserHashService } from './adapters/browser/browser-hash-service.js';
import { BrowserHttpTransport } from './adapters/browser/browser-http-transport.js';
import { SHA1_CONFIG } from './domain/objects/hash-config.js';
import { createLruCache } from './domain/storage/lru-cache.js';
import {
  type OpenRepositoryOptions,
  openRepository as openRepositoryCore,
  type Repository,
} from './repository.js';

const DEFAULT_DELTA_CACHE_BYTES = 16 * 1024 * 1024;
const DEFAULT_DELTA_CACHE_ENTRIES = 65_536;
const DEFAULT_GIT_DIR_NAME = '.git';
const ROOT_WORK_DIR = '/';

/**
 * Browser-runtime extension to `OpenRepositoryOptions`. The browser cannot
 * derive a default `rootHandle` (no equivalent of `process.cwd()`), so the
 * caller must provide it. `gitDirName` controls the in-OPFS directory name
 * used for `.git` (escapes the dot when running under hosts that disallow
 * dot-prefixed names).
 */
export interface OpenBrowserRepositoryOptions extends OpenRepositoryOptions {
  readonly rootHandle: FileSystemDirectoryHandle;
  readonly gitDirName?: string;
  readonly bare?: boolean;
  readonly deltaCacheMaxBytes?: number;
  readonly deltaCacheMaxEntries?: number;
}

export const openRepository = async (opts: OpenBrowserRepositoryOptions): Promise<Repository> => {
  const gitDirName = opts.gitDirName ?? DEFAULT_GIT_DIR_NAME;
  const fallback = {
    fs: new BrowserFileSystem(opts.rootHandle),
    hash: new BrowserHashService(),
    compressor: new BrowserCompressor(),
    transport: new BrowserHttpTransport(),
    runtime: 'browser' as const,
    layout: {
      workDir: ROOT_WORK_DIR,
      gitDir: `${ROOT_WORK_DIR}${gitDirName}`,
      bare: opts.bare ?? false,
    },
    hashConfig: SHA1_CONFIG,
    deltaCache: createLruCache<Uint8Array>(
      opts.deltaCacheMaxBytes ?? DEFAULT_DELTA_CACHE_BYTES,
      opts.deltaCacheMaxEntries ?? DEFAULT_DELTA_CACHE_ENTRIES,
    ),
  };
  // Strip the browser-only opts before forwarding so the core sees only its
  // own option surface.
  const {
    rootHandle: _r,
    gitDirName: _g,
    bare: _b,
    deltaCacheMaxBytes: _d,
    deltaCacheMaxEntries: _e,
    ...coreOpts
  } = opts;
  return openRepositoryCore({ cwd: ROOT_WORK_DIR, ...coreOpts }, fallback);
};

export type { AdapterSet } from './adapter-detect.js';
export { detectRuntime, isBrowser, isNode } from './adapter-detect.js';
export { consoleProgress, noopProgress, type ProgressReporter } from './progress.js';
export type {
  OpenRepositoryOptions,
  Repository,
  RepositoryLayoutInput,
  RuntimeFallback,
} from './repository.js';
