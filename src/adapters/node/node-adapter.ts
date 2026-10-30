import { homedir } from 'node:os';
import * as nodePath from 'node:path';
import { gitPathSyntaxOf } from '../../application/primitives/internal/git-path-syntax.js';
import { deriveLimits } from '../../domain/concurrency/derive-limits.js';
import { configFor } from '../../domain/objects/hash-config.js';
import type { ObjectContent } from '../../domain/objects/index.js';
import { createLruCache } from '../../domain/storage/lru-cache.js';
import {
  buildCacheBudgets,
  type Context,
  createContext,
  type RepositoryLayout,
} from '../../ports/context.js';
import { noopProgress } from '../../progress.js';
import { layoutRootsOf } from '../../repository/layout-roots.js';
import {
  createAlternatePathProbe,
  createObjectSourceAccess,
} from '../../repository/object-source-access.js';
import { createWorktreeFs } from '../../repository/worktree-fs.js';
import { NodeCommandRunner } from './node-command-runner.js';
import { NodeCompressor } from './node-compressor.js';
import { nativeMachineFacts } from './node-concurrency.js';
import { NodeEnvReader } from './node-env-reader.js';
import { NodeFileSystem } from './node-file-system.js';
import { nodeFilenameProbe } from './node-filename-probe.js';
import { NodeHashService } from './node-hash-service.js';
import { NodeHookRunner } from './node-hook-runner.js';
import { NodeHttpTransport } from './node-http-transport.js';
import { NodeSshTransport } from './node-ssh-transport.js';
import { nodeWorktreeFileSystem } from './node-worktree-fs.js';
import { nativePolicy } from './path-policy.js';
import { type SyncIoPolicy, syncIoPolicyFor } from './sync-io-budget.js';

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
  /** Override for the parsed-object memo's entry cap (default: derived from `deltaCacheMaxBytes`). */
  readonly parsedObjectMemoMaxEntries?: number;
  /** Override for the FlatTree cache's own byte valve (default: derived from `deltaCacheMaxBytes`). */
  readonly flatTreeCacheMaxBytes?: number;
  /** Override for the delta-base cache's byte budget (default: `core.deltaBaseCacheLimit`, or git's own default). */
  readonly deltaBaseCacheMaxBytes?: number;
  /**
   * Wire the git-hook runner (default true). Pass `false` to disable hooks.
   * A wired runner spawns `.git/hooks/*` scripts that inherit the full
   * `process.env` — disable it for repositories you do not trust.
   */
  readonly hooks?: boolean;
  /**
   * Wire the merge-driver command runner (default true). Pass `false` to
   * disable external merge drivers. A wired runner executes the configured
   * `[merge "<driver>"].driver` shell command with the full `process.env`.
   */
  readonly command?: boolean;
  /**
   * Wire the ssh transport (default true). Pass `false` to refuse ssh/scp
   * remotes. A wired transport spawns the resolved ssh command
   * (`GIT_SSH_COMMAND`/`GIT_SSH`/`core.sshCommand`, else `ssh`) inheriting
   * the full `process.env`.
   */
  readonly ssh?: boolean;
  /**
   * Hash algorithm this context's objects are read/written under. Default
   * `'sha1'`. A sync factory has no repository to detect a declared format
   * from, so this is the only channel — pass it explicitly for a SHA-256
   * repository.
   */
  readonly algorithm?: 'sha1' | 'sha256';
  /**
   * The I/O strategy for cheap, serial filesystem calls (stat, small reads,
   * held-handle reads). Default `'sync-fast-path'`: these run synchronously,
   * under a per-turn budget that yields back to the event loop on its own.
   * Pick `'threadpool'` on a network or otherwise cold filesystem, where a
   * blocking call can stall the loop for milliseconds instead of microseconds.
   */
  readonly io?: 'sync-fast-path' | 'threadpool';
}

const syncIoOptions = (syncIo: SyncIoPolicy | undefined): { readonly syncIo?: SyncIoPolicy } =>
  syncIo === undefined ? {} : { syncIo };

/**
 * Native line ending of the given platform. Extracted as a pure helper so
 * both arms are unit-testable on any host (the inline `process.platform`
 * branch is otherwise only ever exercised on its native arm).
 * @internal
 */
export const nativeLineEndingFor = (platform: NodeJS.Platform): 'lf' | 'crlf' =>
  platform === 'win32' ? 'crlf' : 'lf';

/**
 * git's symlink-limit macro on the given platform: glibc and musl say 20, git falls back to 32
 * elsewhere.
 * @internal
 */
export const symlinkHopLimitFor = (platform: NodeJS.Platform): number =>
  platform === 'linux' ? 20 : 32;

export function createNodeContext(options: NodeAdapterOptions): Context {
  const workDir = nodePath.resolve(options.workDir);
  const gitDir =
    options.gitDir !== undefined
      ? nodePath.resolve(options.gitDir)
      : nodePath.join(workDir, '.git');
  const algorithm = options.algorithm ?? 'sha1';
  const syncIo = syncIoPolicyFor(options.io);
  const fs = new NodeFileSystem(workDir, syncIoOptions(syncIo));
  const hash = new NodeHashService(algorithm);
  const compressor = new NodeCompressor();
  const transport = new NodeHttpTransport({
    allowInsecureHttp: options.allowInsecureHttp ?? false,
  });
  const layout = buildLayout(workDir, gitDir, options.bare ?? false, safeHomedir());
  const pathSyntax = gitPathSyntaxOf({ windowsPathSyntax: nativePolicy.windowsSyntax });
  const deltaCache = createLruCache<ObjectContent>(
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
    runtime: 'node' as const,
    nativeEol: nativeLineEndingFor(process.platform),
    symlinkHopLimit: symlinkHopLimitFor(process.platform),
    hashConfig: configFor(algorithm),
    deltaCache,
    cacheBudgets: buildCacheBudgets({
      parsedObjectMemoMaxEntries: options.parsedObjectMemoMaxEntries,
      flatTreeCacheMaxBytes: options.flatTreeCacheMaxBytes,
      deltaBaseCacheMaxBytes: options.deltaBaseCacheMaxBytes,
    }),
    concurrency: deriveLimits(nativeMachineFacts()),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.hooks === false ? {} : { hooks: new NodeHookRunner() }),
    ...(options.command === false ? {} : { command: new NodeCommandRunner() }),
    ...(options.ssh === false ? {} : { ssh: new NodeSshTransport() }),
    env: new NodeEnvReader(),
    worktreeFs: createWorktreeFs(
      layoutRootsOf(layout),
      nodeWorktreeFileSystem(workDir, syncIoOptions(syncIo)),
    ),
    objectSourceAccess: createObjectSourceAccess(
      (objectsDir) => new NodeFileSystem([objectsDir], syncIoOptions(syncIo)),
      pathSyntax,
    ),
    alternatePathProbe: createAlternatePathProbe(
      (root) => new NodeFileSystem(root, syncIoOptions(syncIo)),
      pathSyntax,
    ),
    filenameProbe: nodeFilenameProbe,
    windowsPathSyntax: nativePolicy.windowsSyntax,
    windowsIndexPaths: nativePolicy.windowsSyntax,
  };
  return createContext(parts);
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
  homeDir === undefined
    ? { workDir, gitDir, bare, refStorage: 'files' }
    : { workDir, gitDir, bare, homeDir, refStorage: 'files' };

const safeHomedir = (): string | undefined => resolveHomeDir(homedir());
