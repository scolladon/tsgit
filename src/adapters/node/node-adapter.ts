import * as nodePath from 'node:path';
import { SHA1_CONFIG } from '../../domain/objects/hash-config.js';
import { createLruCache } from '../../domain/storage/lru-cache.js';
import { type Context, createContext, type RepositoryConfig } from '../../ports/context.js';
import { noopProgressReporter } from '../../ports/progress-reporter.js';
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
  const config: RepositoryConfig = {
    workDir,
    gitDir,
    bare: options.bare ?? false,
  };
  const deltaCache = createLruCache<Uint8Array>(
    options.deltaCacheMaxBytes ?? DEFAULT_DELTA_CACHE_BYTES,
    options.deltaCacheMaxEntries ?? DEFAULT_DELTA_CACHE_ENTRIES,
  );
  const parts = {
    fs,
    hash,
    compressor,
    transport,
    progress: noopProgressReporter,
    config,
    hashConfig: SHA1_CONFIG,
    deltaCache,
  };
  return options.signal !== undefined
    ? createContext({ ...parts, signal: options.signal })
    : createContext(parts);
}
