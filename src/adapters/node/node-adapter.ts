import { homedir } from 'node:os';
import * as nodePath from 'node:path';
import { SHA1_CONFIG } from '../../domain/objects/hash-config.js';
import { createLruCache } from '../../domain/storage/lru-cache.js';
import { type Context, createContext, type RepositoryLayout } from '../../ports/context.js';
import { noopProgress } from '../../progress.js';
import { NodeCompressor } from './node-compressor.js';
import { NodeFileSystem } from './node-file-system.js';
import { NodeHashService } from './node-hash-service.js';
import { NodeHttpTransport } from './node-http-transport.js';

const DEFAULT_DELTA_CACHE_BYTES = 16 * 1024 * 1024;
const DEFAULT_DELTA_CACHE_ENTRIES = 65_536;

export interface NodeAdapterOptions {
  readonly workDir: string;
  readonly gitDir?: string;
  readonly bare?: boolean;
  readonly allowInsecureHttp?: boolean;
  readonly signal?: AbortSignal;
  readonly deltaCacheMaxBytes?: number;
  readonly deltaCacheMaxEntries?: number;
}

export function createNodeContext(options: NodeAdapterOptions): Context {
  const workDir = nodePath.resolve(options.workDir);
  const gitDir =
    options.gitDir !== undefined
      ? nodePath.resolve(options.gitDir)
      : nodePath.join(workDir, '.git');
  const fs = new NodeFileSystem(workDir);
  const hash = new NodeHashService();
  const compressor = new NodeCompressor();
  const transport = new NodeHttpTransport({
    allowInsecureHttp: options.allowInsecureHttp ?? false,
  });
  const layout = buildLayout(workDir, gitDir, options.bare ?? false, safeHomedir());
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
    hashConfig: SHA1_CONFIG,
    deltaCache,
  };
  return options.signal !== undefined
    ? createContext({ ...parts, signal: options.signal })
    : createContext(parts);
}

/**
 * Normalize the raw home-dir value: empty string → undefined, otherwise
 * passthrough. Extracted as a pure helper so the empty-string branch is
 * unit-testable without mocking `os.homedir()`.
 *
 * @internal — exported for tests only.
 */
export const resolveHomeDir = (raw: string): string | undefined => (raw === '' ? undefined : raw);

/**
 * Pure layout builder — splits the optional `homeDir` field so the
 * `exactOptionalPropertyTypes` branch is unit-testable.
 *
 * @internal — exported for tests only.
 */
export const buildLayout = (
  workDir: string,
  gitDir: string,
  bare: boolean,
  homeDir: string | undefined,
): RepositoryLayout =>
  homeDir === undefined ? { workDir, gitDir, bare } : { workDir, gitDir, bare, homeDir };

const safeHomedir = (): string | undefined => resolveHomeDir(homedir());
