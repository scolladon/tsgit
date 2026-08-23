/// <reference lib="dom" />
import { configFor } from '../../domain/objects/hash-config.js';
import { createLruCache } from '../../domain/storage/lru-cache.js';
import { type Context, type CreateContextParts, createContext } from '../../ports/context.js';
import { noopProgress } from '../../progress.js';
import { BrowserCompressor } from './browser-compressor.js';
import { BrowserFileSystem } from './browser-file-system.js';
import { BrowserHashService } from './browser-hash-service.js';
import { BrowserHttpTransport } from './browser-http-transport.js';

const DEFAULT_DELTA_CACHE_BYTES = 16 * 1024 * 1024;
const DEFAULT_DELTA_CACHE_ENTRIES = 65_536;

export interface BrowserAdapterOptions {
  readonly rootHandle: FileSystemDirectoryHandle;
  readonly gitDirName?: string;
  readonly bare?: boolean;
  readonly signal?: AbortSignal;
  readonly deltaCacheMaxBytes?: number;
  readonly deltaCacheMaxEntries?: number;
  /**
   * Hash algorithm this context's objects are read/written under. Default
   * `'sha1'`. A sync factory has no repository to detect a declared format
   * from, so this is the only channel — pass it explicitly for a SHA-256
   * repository.
   */
  readonly algorithm?: 'sha1' | 'sha256';
}

const DEFAULT_GIT_DIR_NAME = '.git';
const ROOT_WORK_DIR = '/';

export function createBrowserContext(options: BrowserAdapterOptions): Context {
  const gitDirName = options.gitDirName ?? DEFAULT_GIT_DIR_NAME;
  const algorithm = options.algorithm ?? 'sha1';
  const deltaCache = createLruCache<Uint8Array>(
    options.deltaCacheMaxBytes ?? DEFAULT_DELTA_CACHE_BYTES,
    options.deltaCacheMaxEntries ?? DEFAULT_DELTA_CACHE_ENTRIES,
  );
  const parts: CreateContextParts = {
    fs: new BrowserFileSystem(options.rootHandle),
    hash: new BrowserHashService(algorithm),
    compressor: new BrowserCompressor(),
    transport: new BrowserHttpTransport(),
    progress: noopProgress,
    layout: {
      workDir: ROOT_WORK_DIR,
      gitDir: `${ROOT_WORK_DIR}${gitDirName}`,
      bare: options.bare ?? false,
      refStorage: 'files',
    },
    runtime: 'browser',
    hashConfig: configFor(algorithm),
    deltaCache,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  };
  return createContext(parts);
}
