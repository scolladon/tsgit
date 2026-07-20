import { SHA1_CONFIG, SHA256_CONFIG } from '../../domain/objects/hash-config.js';
import { createLruCache } from '../../domain/storage/lru-cache.js';
import type { CommandRunner } from '../../ports/command-runner.js';
import { type Context, createContext, type RepositoryLayout } from '../../ports/context.js';
import type { EnvReader } from '../../ports/env-reader.js';
import type { HookRunner } from '../../ports/hook-runner.js';
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
  /** Optional hook runner exposed via `ctx.hooks` (default: undefined — hooks inert). */
  readonly hooks?: HookRunner;
  /** Optional command runner exposed via `ctx.command` (default: undefined — drivers fall back). */
  readonly command?: CommandRunner;
  /** Optional environment-variable reader exposed via `ctx.env` (default: undefined — every var is unset). */
  readonly env?: EnvReader;
  /** Override for `fs.homedir()` (default: `'/home/user'`). */
  readonly home?: string;
  /** Override for `fs.xdgConfigHome()` (default: `'/home/user/.config'`). */
  readonly xdg?: string;
  /** Override for `fs.systemConfigPath()` (default: `'/etc/gitconfig'`). */
  readonly systemConfig?: string;
}

const DEFAULT_WORK_DIR = '/repo';
const DEFAULT_GIT_DIR = '/repo/.git';

export function createMemoryContext(options: MemoryAdapterOptions = {}): Context {
  const fsOptions: MemoryFileSystemOptions = {
    rootDir: DEFAULT_WORK_DIR,
    ...(options.files !== undefined ? { files: options.files } : {}),
    // Stryker disable next-line ConditionalExpression,EqualityOperator,ObjectLiteral: equivalent — when `home` is undefined the always-spread mutant yields `{ home: undefined }`, which MemoryFileSystem coalesces (`?? DEFAULT_HOME`) to the same value as omitting the key. The killable always-`{}` half is covered by the home-propagation test.
    ...(options.home !== undefined ? { home: options.home } : {}),
    ...(options.xdg !== undefined ? { xdg: options.xdg } : {}),
    ...(options.systemConfig !== undefined ? { systemConfig: options.systemConfig } : {}),
  };
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
    runtime: 'memory' as const,
    hashConfig,
    deltaCache,
    // Stryker disable next-line ConditionalExpression,EqualityOperator,ObjectLiteral: equivalent — when `signal` is undefined the always-spread mutant yields `{ signal: undefined }`, which createContext freezes indistinguishably from omitting the key (consumers read `ctx.signal` by value). The killable always-`{}` half is covered by the signal-propagation test.
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    // Stryker disable next-line ConditionalExpression,EqualityOperator,ObjectLiteral: equivalent — when `hooks` is undefined the always-spread mutant yields `{ hooks: undefined }`, indistinguishable from omitting the key once createContext freezes it (consumers read `ctx.hooks` by value). The killable always-`{}` half is covered by the hooks-propagation test.
    ...(options.hooks !== undefined ? { hooks: options.hooks } : {}),
    // Stryker disable next-line ConditionalExpression,EqualityOperator,ObjectLiteral: equivalent — when `command` is undefined the always-spread mutant yields `{ command: undefined }`, indistinguishable from omitting the key once createContext freezes it (consumers read `ctx.command` by value). The killable always-`{}` half is covered by the command-propagation test.
    ...(options.command !== undefined ? { command: options.command } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
  };
  return createContext(parts);
}
