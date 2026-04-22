import type { HashConfig } from '../domain/objects/hash-config.js';
import type { LruCache } from '../domain/storage/lru-cache.js';
import type { Compressor } from './compressor.js';
import type { FileSystem } from './file-system.js';
import type { HashService } from './hash-service.js';
import type { HttpTransport } from './http-transport.js';
import type { ProgressReporter } from './progress-reporter.js';

export interface RepositoryConfig {
  /** Absolute path to the repository root (working tree). */
  readonly workDir: string;
  /** Absolute path to the .git directory (usually `${workDir}/.git`, but may differ for bare repos or worktrees). */
  readonly gitDir: string;
  /** Whether this is a bare repository. */
  readonly bare: boolean;
}

export interface Context {
  readonly fs: FileSystem;
  readonly hash: HashService;
  readonly compressor: Compressor;
  readonly transport: HttpTransport;
  readonly progress: ProgressReporter;
  readonly config: RepositoryConfig;
  /** Object serialization parameters (sha1 vs sha256 digest+hex sizes). */
  readonly hashConfig: HashConfig;
  /** Shared delta-base LRU cache; consumed by primitives' iterative delta walker. */
  readonly deltaCache: LruCache<Uint8Array>;
  /** Optional abort signal for cancelling long-running operations. */
  readonly signal?: AbortSignal;
}

export interface CreateContextParts {
  readonly fs: FileSystem;
  readonly hash: HashService;
  readonly compressor: Compressor;
  readonly transport: HttpTransport;
  readonly progress: ProgressReporter;
  readonly config: RepositoryConfig;
  readonly hashConfig: HashConfig;
  readonly deltaCache: LruCache<Uint8Array>;
  readonly signal?: AbortSignal;
}

/** Assemble a frozen Context from its constituent ports + config. */
export function createContext(parts: CreateContextParts): Context {
  return Object.freeze({ ...parts });
}
