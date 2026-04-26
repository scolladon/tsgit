/**
 * Node-runtime entry point. Selected by `package.json` `"exports"` for the
 * `node` condition. Builds the runtime fallback (Node-backed adapters +
 * cwd-walked layout) and forwards every `openRepository(opts)` call to the
 * core factory with the fallback pre-bound.
 */
import * as nodePath from 'node:path';

import { NodeCompressor } from './adapters/node/node-compressor.js';
import { NodeFileSystem } from './adapters/node/node-file-system.js';
import { NodeHashService } from './adapters/node/node-hash-service.js';
import { NodeHttpTransport } from './adapters/node/node-http-transport.js';
import { SHA1_CONFIG } from './domain/objects/hash-config.js';
import { createLruCache } from './domain/storage/lru-cache.js';
import { findLayout } from './repository/find-layout.js';
import {
  type OpenRepositoryOptions,
  openRepository as openRepositoryCore,
  type Repository,
} from './repository.js';

const DEFAULT_DELTA_CACHE_BYTES = 16 * 1024 * 1024;
const DEFAULT_DELTA_CACHE_ENTRIES = 65_536;

/**
 * Node-runtime extension to `OpenRepositoryOptions`. Adds `allowInsecureHttp`
 * (forwarded to the Node HTTP transport — separate from the facade-tier
 * `config.allowInsecure` which controls the SSRF guard). Adds delta-cache
 * tuning for callers with non-standard memory budgets.
 */
export interface OpenNodeRepositoryOptions extends OpenRepositoryOptions {
  readonly allowInsecureHttp?: boolean;
  readonly deltaCacheMaxBytes?: number;
  readonly deltaCacheMaxEntries?: number;
}

export const openRepository = async (opts: OpenNodeRepositoryOptions = {}): Promise<Repository> => {
  const cwd = opts.cwd ?? process.cwd();
  const resolvedCwd = nodePath.resolve(cwd);
  const fs = new NodeFileSystem(resolvedCwd);
  const hash = new NodeHashService();
  const compressor = new NodeCompressor();
  const transport = new NodeHttpTransport({
    allowInsecureHttp: opts.allowInsecureHttp ?? false,
  });
  // Walk up from cwd to find an existing repo. When none, default to a fresh
  // layout rooted at cwd — appropriate for `init`/`clone` callers; commands
  // that require a repo will throw `NOT_A_REPOSITORY` on first I/O.
  const discovered = await findLayout(fs, resolvedCwd);
  const layout = discovered ?? {
    workDir: resolvedCwd,
    gitDir: nodePath.join(resolvedCwd, '.git'),
    bare: false,
  };
  const fallback = {
    fs,
    hash,
    compressor,
    transport,
    runtime: 'node' as const,
    layout,
    hashConfig: SHA1_CONFIG,
    deltaCache: createLruCache<Uint8Array>(
      opts.deltaCacheMaxBytes ?? DEFAULT_DELTA_CACHE_BYTES,
      opts.deltaCacheMaxEntries ?? DEFAULT_DELTA_CACHE_ENTRIES,
    ),
  };
  // Strip the node-only opts before forwarding so the core sees only its own
  // option surface.
  const {
    allowInsecureHttp: _a,
    deltaCacheMaxBytes: _b,
    deltaCacheMaxEntries: _c,
    ...coreOpts
  } = opts;
  return openRepositoryCore({ cwd: resolvedCwd, ...coreOpts }, fallback);
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
