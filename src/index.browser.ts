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
import { resolveFixedEntryLayout } from './repository/fixed-entry-layout.js';
import { portablePosixPolicy } from './repository/portable-posix-policy.js';
import { resolveAgainst } from './repository/resolve-layout.js';
import { validateOptions } from './repository/validate-options.js';
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

/**
 * The browser has no walk (OPFS's `/` root means `dirname('/') === '/'`
 * terminates on the first iteration), so `opts.gitDir` cannot skip a
 * discovery walk the way it does on node/memory — instead it OVERRIDES the
 * fixed `/{gitDirName}` entry point itself. Relative values resolve against
 * the fixed work dir, the same "relative resolves against cwd" rule the
 * core option documents; the browser's cwd is always `ROOT_WORK_DIR`.
 * `resolveAgainst` carries the absolute-wins rationale a bare two-arg
 * policy `resolve` would get wrong.
 */
const resolveGitDirEntry = (gitDirOpt: string | undefined, gitDirName: string): string =>
  gitDirOpt === undefined
    ? `${ROOT_WORK_DIR}${gitDirName}`
    : resolveAgainst(ROOT_WORK_DIR, gitDirOpt, portablePosixPolicy);

export const openRepository = async (opts: OpenBrowserRepositoryOptions): Promise<Repository> => {
  validateOptions(opts);
  const gitDirName = opts.gitDirName ?? DEFAULT_GIT_DIR_NAME;
  const fs = new BrowserFileSystem(opts.rootHandle);
  // A walk-up is meaningless in OPFS (`dirname('/') === '/'` terminates on
  // the first iteration), so — unlike the node/memory shims — the browser
  // resolves its fixed `/{gitDirName}` entry (or `opts.gitDir`'s override of
  // it) pointer-aware via `resolveFixedEntryLayout` rather than calling
  // `findLayout`. `ceilingDirs` has no effect here (no walk to bound) and is
  // therefore not threaded through — the core still validates it.
  const layout = await resolveFixedEntryLayout(
    fs,
    ROOT_WORK_DIR,
    resolveGitDirEntry(opts.gitDir, gitDirName),
    opts.bare,
    opts.workDir,
  );
  const fallback = {
    fs,
    hash: new BrowserHashService(),
    compressor: new BrowserCompressor(),
    transport: new BrowserHttpTransport(),
    runtime: 'browser' as const,
    layout,
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
export * from './public-types.js';
export type { OpenRepositoryOptions, Repository } from './repository.js';
