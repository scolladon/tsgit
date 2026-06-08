import type { HashConfig } from '../domain/objects/hash-config.js';
import type { RefName } from '../domain/objects/object-id.js';
import type { LruCache } from '../domain/storage/lru-cache.js';
import type { Compressor } from './compressor.js';
import type { FileSystem } from './file-system.js';
import type { HashService } from './hash-service.js';
import type { HookRunner } from './hook-runner.js';
import type { HttpTransport } from './http-transport.js';
import type { Logger } from './logger.js';
import type { ProgressReporter } from './progress-reporter.js';
import type { PromisorRemote } from './promisor.js';

/**
 * Repository physical layout — where the working tree and.git directory live.
 * Renamed in from the previous `RepositoryConfig` (port-tier) to free that
 * name for the facade-tier `RepositoryConfig` shape (auth/parallelism/etc.).
 */
export interface RepositoryLayout {
  /** Absolute path to the repository root (working tree). */
  readonly workDir: string;
  /** Absolute path to the.git directory (usually `${workDir}/.git`, but may differ for bare repos or worktrees). */
  readonly gitDir: string;
  /**
   * Absolute path to the shared **common** git dir — objects, `packed-refs`,
   * `config`, and shared refs/reflogs. Absent for a normal repo or the main
   * worktree (it equals `gitDir`); set only for a linked worktree, whose
   * `gitDir` is its own admin dir while shared state lives here. Resolve via
   * `commonGitDir(ctx)` rather than reading this field directly.
   */
  readonly commonDir?: string;
  /** Whether this is a bare repository. */
  readonly bare: boolean;
  /**
   * Home directory for `~`-expansion in config-driven paths (e.g.
   * `core.excludesFile = ~/.config/git/ignore`). Populated by the node
   * shim from `os.homedir()`; memory adapter accepts an option; browser
   * leaves it `undefined`. When `undefined`, loaders that need home
   * expansion treat the source as missing.
   */
  readonly homeDir?: string;
}

/**
 * Author / committer identity shape.
 */
export interface AuthorIdentity {
  readonly name: string;
  readonly email: string;
}

/**
 * Authentication strategy for transport — narrowed shape consumed by withAuth.
 */
export type AuthStrategy =
  | { readonly type: 'bearer'; readonly token: string }
  | { readonly type: 'basic'; readonly username: string; readonly password: string };

/**
 * Facade-tier configuration. introduces this shape; it carries the
 * auth/parallelism/SSRF/network options the facade plumbs into network-pipeline.
 * All fields are optional — primitives and commands consult only the keys they need.
 */
export interface RepositoryConfig {
  readonly user?: AuthorIdentity;
  readonly auth?: AuthStrategy;
  /** Bounded parallelism for fan-out work. 1..32, default 8 (enforced by facade validation). */
  readonly parallelism?: number;
  readonly upstreamRef?: RefName;
  readonly allowInsecure?: boolean;
  readonly allowPrivateNetworks?: boolean;
  /**
   * Hard cap (bytes) on a single pack body buffered in memory by `fetchPack`.
   * Server-controlled byte counts above this raise `PACK_TOO_LARGE`. Default
   * 512 MiB. Lower it for hardened deployments that clone only small repos.
   */
  readonly maxResponseBytes?: number;
  /**
   * Hard cap on the entry-count field declared in a received pack header.
   * Server-controlled `uint32` values above this raise `PACK_TOO_LARGE` before
   * `fetchPack` allocates per-entry state. Default 50_000_000.
   */
  readonly maxObjectsPerPack?: number;
  readonly detectRenames?: boolean;
  readonly breakStaleLockMs?: number;
  readonly dnsResolver?: (host: string) => Promise<ReadonlyArray<string>>;
  /** Hard cap on `dnsResolver` return-array length to bound resolver-amplification DoS. Default 64. */
  readonly maxDnsResults?: number;
}

export interface Context {
  readonly fs: FileSystem;
  readonly hash: HashService;
  readonly compressor: Compressor;
  readonly transport: HttpTransport;
  readonly progress: ProgressReporter;
  /** Repository physical layout. Required — every primitive needs gitDir/workDir. */
  readonly layout: RepositoryLayout;
  /** User-supplied working directory (may be a sub-path of layout.workDir). Defaults to layout.workDir when not set by the facade. */
  readonly cwd: string;
  /** Object serialization parameters (sha1 vs sha256 digest+hex sizes). */
  readonly hashConfig: HashConfig;
  /** Shared delta-base LRU cache; consumed by primitives' iterative delta walker. */
  readonly deltaCache: LruCache<Uint8Array>;
  /** Optional facade-tier configuration (auth, parallelism, SSRF, …). Populated by openRepository. */
  readonly config?: RepositoryConfig;
  /** Optional sanitized logger. Populated by openRepository. */
  readonly logger?: Logger;
  /** Optional abort signal for cancelling long-running operations. */
  readonly signal?: AbortSignal;
  /** Optional hook runner. Absent ⇒ hooks are inert (browser, or opted out). */
  readonly hooks?: HookRunner;
  /**
   * Optional promisor-remote capability. Populated by `openRepository`;
   * `readObject` consults it to lazy-fetch an object a partial clone omitted.
   */
  readonly promisor?: PromisorRemote;
}

export interface CreateContextParts {
  readonly fs: FileSystem;
  readonly hash: HashService;
  readonly compressor: Compressor;
  readonly transport: HttpTransport;
  readonly progress: ProgressReporter;
  readonly layout: RepositoryLayout;
  readonly cwd?: string;
  readonly hashConfig: HashConfig;
  readonly deltaCache: LruCache<Uint8Array>;
  readonly config?: RepositoryConfig;
  readonly logger?: Logger;
  readonly signal?: AbortSignal;
  readonly hooks?: HookRunner;
}

/** Assemble a frozen Context from its constituent ports + layout. */
export function createContext(parts: CreateContextParts): Context {
  return Object.freeze({ ...parts, cwd: parts.cwd ?? parts.layout.workDir });
}
