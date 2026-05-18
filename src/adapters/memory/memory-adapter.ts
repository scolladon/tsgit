import { SHA1_CONFIG, SHA256_CONFIG } from '../../domain/objects/hash-config.js';
import { createLruCache } from '../../domain/storage/lru-cache.js';
import { type Context, createContext, type RepositoryLayout } from '../../ports/context.js';
import { noopProgress } from '../../progress.js';
import { MemoryCompressor } from './memory-compressor.js';
import { MemoryFileSystem, type MemoryFileSystemOptions } from './memory-file-system.js';
import { MemoryHashService } from './memory-hash-service.js';
import { MemoryHttpTransport } from './memory-http-transport.js';

const DEFAULT_DELTA_CACHE_BYTES = 16 * 1024 * 1024;
const DEFAULT_DELTA_CACHE_ENTRIES = 65_536;

export interface MemoryAdapterOptions {
  readonly files?: Readonly<Record<string, Uint8Array>>;
  readonly algorithm?: 'sha1' | 'sha256';
  readonly signal?: AbortSignal;
  readonly deltaCacheMaxBytes?: number;
  readonly deltaCacheMaxEntries?: number;
  /** Optional home directory exposed via `ctx.layout.homeDir` (default: undefined). */
  readonly homeDir?: string;
}

const DEFAULT_WORK_DIR = '/repo';
const DEFAULT_GIT_DIR = '/repo/.git';

export function createMemoryContext(options: MemoryAdapterOptions = {}): Context {
  const fsOptions: MemoryFileSystemOptions =
    options.files === undefined
      ? { rootDir: DEFAULT_WORK_DIR }
      : { rootDir: DEFAULT_WORK_DIR, files: options.files };
  const fs = new MemoryFileSystem(fsOptions);
  const algorithm = options.algorithm ?? 'sha1';
  const hash = new MemoryHashService(algorithm);
  const compressor = new MemoryCompressor();
  const transport = new MemoryHttpTransport();
  const layout: RepositoryLayout =
    options.homeDir === undefined
      ? { workDir: DEFAULT_WORK_DIR, gitDir: DEFAULT_GIT_DIR, bare: false }
      : {
          workDir: DEFAULT_WORK_DIR,
          gitDir: DEFAULT_GIT_DIR,
          bare: false,
          homeDir: options.homeDir,
        };
  const hashConfig = algorithm === 'sha256' ? SHA256_CONFIG : SHA1_CONFIG;
  const deltaCache = createLruCache<Uint8Array>(
    options.deltaCacheMaxBytes ?? DEFAULT_DELTA_CACHE_BYTES,
    options.deltaCacheMaxEntries ?? DEFAULT_DELTA_CACHE_ENTRIES,
  );
  const parts = {
    fs,
    hash,
    compressor,
    transport,
    progress: noopProgress,
    layout,
    hashConfig,
    deltaCache,
  };
  return options.signal === undefined
    ? createContext(parts)
    : createContext({ ...parts, signal: options.signal });
}
