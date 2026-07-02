/**
 * Node-runtime entry point. Selected by `package.json` `"exports"` for the
 * `node` condition. Builds the runtime fallback (Node-backed adapters +
 * cwd-walked layout) and forwards every `openRepository(opts)` call to the
 * core factory with the fallback pre-bound.
 */
import { realpath, stat } from 'node:fs/promises';
import * as nodePath from 'node:path';

import { NodeCommandRunner } from './adapters/node/node-command-runner.js';
import { NodeCompressor } from './adapters/node/node-compressor.js';
import { NodeEnvReader } from './adapters/node/node-env-reader.js';
import { NodeFileSystem } from './adapters/node/node-file-system.js';
import { NodeHashService } from './adapters/node/node-hash-service.js';
import { NodeHookRunner } from './adapters/node/node-hook-runner.js';
import { NodeHttpTransport } from './adapters/node/node-http-transport.js';
import { NodeSshTransport } from './adapters/node/node-ssh-transport.js';
import { SHA1_CONFIG } from './domain/objects/hash-config.js';
import { createLruCache } from './domain/storage/lru-cache.js';
import { commonAncestor } from './repository/common-ancestor.js';
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
  // Resolve to the real path (follows symlinks). On macOS, /var/folders/...
  // symlinks to /private/var/folders/..., and the NodeFileSystem's containment
  // check compares against the realpath of paths it operates on. Without
  // resolving here, every operation under a symlinked cwd would be rejected
  // with PERMISSION_DENIED. realpath() throws if the path does not exist; fall
  // back to nodePath.resolve in that case (init/clone callers legitimately
  // point at a not-yet-existing directory).
  const resolvedCwd = await realpath(nodePath.resolve(cwd)).catch(() => nodePath.resolve(cwd));
  // Discover layout BEFORE constructing the bounded NodeFileSystem. Layout
  // discovery walks up the parent chain looking for `.git`; the bounded FS
  // would reject paths outside its rootDir, preventing the walk from reaching
  // a repo whose root is an ancestor of the user's cwd.
  const layout = (await discoverLayout(resolvedCwd)) ?? {
    workDir: resolvedCwd,
    gitDir: nodePath.join(resolvedCwd, '.git'),
    bare: false,
  };
  const fs = new NodeFileSystem(layout.workDir);
  const hash = new NodeHashService();
  const compressor = new NodeCompressor();
  const transport = new NodeHttpTransport({
    allowInsecureHttp: opts.allowInsecureHttp ?? false,
  });
  const fallback = {
    fs,
    hash,
    compressor,
    transport,
    hooks: new NodeHookRunner(),
    command: new NodeCommandRunner(),
    env: new NodeEnvReader(),
    ssh: new NodeSshTransport(),
    runtime: 'node' as const,
    layout,
    hashConfig: SHA1_CONFIG,
    deltaCache: createLruCache<Uint8Array>(
      opts.deltaCacheMaxBytes ?? DEFAULT_DELTA_CACHE_BYTES,
      opts.deltaCacheMaxEntries ?? DEFAULT_DELTA_CACHE_ENTRIES,
    ),
    // A linked worktree lives outside `workDir`; root a fresh adapter at the
    // common ancestor of the repo and the worktree paths so it can reach both
    // (the facade's multi-root validator then narrows access; ADR-298).
    makeWorktreeFs: (worktreePaths: ReadonlyArray<string>): NodeFileSystem =>
      new NodeFileSystem(commonAncestor([layout.workDir, ...worktreePaths])),
  };
  // Strip the node-only opts AND `cwd` (we override with the realpath-resolved
  // form) before forwarding so the core sees only its own option surface.
  const {
    cwd: _cwd,
    allowInsecureHttp: _a,
    deltaCacheMaxBytes: _b,
    deltaCacheMaxEntries: _c,
    ...coreOpts
  } = opts;
  return openRepositoryCore({ ...coreOpts, cwd: resolvedCwd }, fallback);
};

/**
 * Walk up from `start` looking for a `.git` directory. Uses raw `fs.promises`
 * so the walk is not gated by any NodeFileSystem containment check — must run
 * BEFORE the bounded FS is constructed.
 */
const discoverLayout = async (
  start: string,
): Promise<{ workDir: string; gitDir: string; bare: boolean } | undefined> => {
  let current = start;
  while (true) {
    const candidate = nodePath.join(current, '.git');
    const result = await stat(candidate).catch(() => undefined);
    if (result?.isDirectory()) {
      return { workDir: current, gitDir: candidate, bare: false };
    }
    const parent = nodePath.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
};

export type { AdapterSet } from './adapter-detect.js';
export { detectRuntime, isBrowser, isNode } from './adapter-detect.js';
export { consoleProgress, noopProgress, type ProgressReporter } from './progress.js';
export * from './public-types.js';
export type { OpenRepositoryOptions, Repository } from './repository.js';
