import type { ConcurrencyLimits } from '../domain/concurrency/derive-limits.js';
import type { HashConfig } from '../domain/objects/hash-config.js';
import type { RefName } from '../domain/objects/object-id.js';
import type { LruCache } from '../domain/storage/lru-cache.js';
import type { CommandRunner } from './command-runner.js';
import type { Compressor } from './compressor.js';
import type { EnvReader } from './env-reader.js';
import type { FileSystem } from './file-system.js';
import type { HashService } from './hash-service.js';
import type { HookRunner } from './hook-runner.js';
import type { HttpTransport } from './http-transport.js';
import type { Logger } from './logger.js';
import type { ProgressReporter } from './progress-reporter.js';
import type { PromisorRemote } from './promisor.js';
import type { SshTransport } from './ssh-channel.js';

/**
 * The repository-format acceptance verdict — git's `core.repositoryformatversion`
 * / `extensions.*` gate. Absent means accepted. `version` is always the
 * PARSED integer (`1k` carries `1024`, `0777` carries `511`), never the
 * config literal. `kind: 'extensions'` is not yet populated by any reader.
 */
export type RepositoryFormatRefusal =
  | { readonly kind: 'version'; readonly version: number }
  | {
      readonly kind: 'extensions';
      readonly version: number;
      readonly extensions: ReadonlyArray<string>;
    };

/**
 * Repository physical layout — where the working tree and.git directory live.
 * Renamed in from the previous `RepositoryConfig` (port-tier) to free that
 * name for the facade-tier `RepositoryConfig` shape (auth/parallelism/etc.).
 */
export interface RepositoryLayout {
  /**
   * Absolute path to the working tree. Absent when the repository has none
   * (bare, or a git dir opened without one) — git's `get_git_work_tree() ==
   * NULL`.
   */
  readonly workDir?: string;
  /** Absolute path to the.git directory (usually `${workDir}/.git`, but may differ for bare repos or worktrees). */
  readonly gitDir: string;
  /**
   * Absolute path to the shared **common** git dir — objects, `packed-refs`,
   * `config`, and shared refs/reflogs. Absent for a normal repo or the main
   * worktree (it equals `gitDir`); set only for a linked worktree, whose
   * `gitDir` is its own admin dir while shared state lives here. Resolve via
   * `commonGitDir(ctx)` (or `commonDirOf(layout)` when holding a bare
   * layout) rather than reading this field directly — both are exported as
   * `import { commonGitDir, commonDirOf } from '@scolladon/tsgit/primitives'`,
   * with `commonGitDir` also bound at `repo.primitives.commonGitDir`.
   */
  readonly commonDir?: string;
  /** git's `is_bare_repository()`: `core.bare` is not false AND there is no work tree. */
  readonly bare: boolean;
  /**
   * `core.bare` and `core.worktree` are both set — git's
   * `work_tree_config_is_bogus`. Work-tree commands refuse with a distinct
   * error code instead of the plain "no work tree" refusal.
   */
  readonly workTreeConfigBogus?: boolean;
  /** Discovery reached a repository whose metadata the caller does not own. Present only when true. */
  readonly untrusted?: true;
  /** Discovery walked into a gitdir under a name other than `.git`, with `bareRepositories: 'explicit'` set. Present only when true. */
  readonly implicitBare?: true;
  /** The first checked path the ownership predicate reported unowned. Present only when one was found. */
  readonly foreignPath?: string;
  /**
   * The repository-format acceptance verdict — absent when accepted. Frozen
   * at open time so the command tier can read it synchronously; see
   * `RepositoryFormatRefusal`.
   */
  readonly formatRefusal?: RepositoryFormatRefusal;
  /**
   * Home directory for `~`-expansion in config-driven paths (e.g.
   * `core.excludesFile = ~/.config/git/ignore`). Populated by the node
   * shim from `os.homedir()`; memory adapter accepts an option; browser
   * leaves it `undefined`. When `undefined`, loaders that need home
   * expansion treat the source as missing.
   */
  readonly homeDir?: string;
  /**
   * The repository's declared `extensions.objectFormat`. Absent means sha1
   * (git's default when the key is unset) — the same convention every other
   * optional field on this interface follows. Populated by `finishLayout`
   * at open time; the option channel (`OpenRepositoryOptions.algorithm`)
   * and this declared channel are reconciled in `openRepository`, which
   * refuses a contradiction between the two.
   */
  readonly objectFormat?: 'sha1' | 'sha256';
  /**
   * The repository's ref-storage backend — `extensions.refStorage`'s
   * resolved value, defaulting to `'files'` (git's default when the key is
   * unset). REQUIRED, unlike every other optional field on this interface:
   * an optional field whose absence means `'files'` would reintroduce the
   * exact misread this field exists to close on any path that builds a
   * `Context` without the facade — the raw adapter constructors
   * (`createNodeContext`, `createMemoryContext`, `createBrowserContext`)
   * set it by explicit assignment for this reason. Populated by
   * `finishLayout` at open time; readable synchronously, consumed by no
   * command surface yet.
   */
  readonly refStorage: 'files' | 'reftable';
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
  /**
   * Bounded parallelism for fan-out work, overriding the concurrency policy's
   * derived bound (each 1..32, enforced by facade validation). A bare number
   * applies to both buckets; `{ cpu, io }` overrides them independently.
   * Absent members keep taking the derived bound for that bucket.
   */
  readonly parallelism?: number | { readonly cpu?: number; readonly io?: number };
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
   * Server-controlled `uint32` values above this raise `PACK_TOO_LARGE`
   * before the pack is walked at all. The declared count itself is never an
   * allocation input past this point — the indexer's record arrays grow
   * from the pack's real entry count as they are parsed, clamped
   * underneath by the pack's own byte length, not by what the header
   * claims. Default 50_000_000.
   */
  readonly maxObjectsPerPack?: number;
  readonly detectRenames?: boolean;
  /**
   * Programmatic facade defaults for whitespace-diff modes. These are NOT git's
   * `.git/config` settings and NOT `core.whitespace` — they are library-tier
   * defaults applied by the `diff` command when no per-call option overrides them.
   */
  readonly ignoreWhitespace?: 'all' | 'change' | 'at-eol';
  readonly ignoreCrAtEol?: boolean;
  readonly ignoreBlankLines?: boolean;
  readonly breakStaleLockMs?: number;
  readonly dnsResolver?: (host: string) => Promise<ReadonlyArray<string>>;
  /** Hard cap on `dnsResolver` return-array length to bound resolver-amplification DoS. Default 64. */
  readonly maxDnsResults?: number;
}

/**
 * Opaque per-repository cache-identity anchor. Every identity-keyed cache
 * under `src/application/primitives` keys on `Context['session']` instead of
 * `Context` itself, so a Context derived through `deriveContext`
 * (`src/application/primitives/derive-context.ts` — the ONLY derivation path)
 * keeps every one of those caches as long as the derivation keeps the same
 * session: two Context objects sharing a session are the SAME cache identity,
 * no matter how many other fields a spread swaps. This closes the
 * "write via a spread Context, read via the original → intermittent
 * OBJECT_NOT_FOUND" bug family structurally, in place of the informal
 * `deltaCache`-as-identity-anchor trick `load-reftable-stack.ts` used before
 * this field existed.
 *
 * Internal and opaque by contract, not by type-level enforcement: never
 * exported from the package entry point, never documented as constructible.
 * An embedder has no reason to build one, and a public constructor would let
 * a caller forge cache identity — so the only two sites that ever create one
 * are `createContext` (below) and `deriveContext`.
 */
export type Session = Readonly<Record<never, never>>;

/** A fresh, frozen, empty session token — a new cache-identity anchor. */
export function createSession(): Session {
  return Object.freeze({});
}

export interface Context {
  readonly fs: FileSystem;
  readonly hash: HashService;
  readonly compressor: Compressor;
  readonly transport: HttpTransport;
  readonly progress: ProgressReporter;
  /** Repository physical layout. Required — every primitive needs gitDir/workDir. */
  readonly layout: RepositoryLayout;
  /**
   * User-supplied working directory (may be a sub-path of layout.workDir).
   * Defaults to layout.workDir when not set by the facade, and to
   * layout.gitDir when the repository has no work tree — matching git,
   * whose `--show-prefix` is empty and `--is-inside-git-dir` is `true` in
   * exactly that shape.
   */
  readonly cwd: string;
  /** The runtime this context was built for — names the adapter set in refusal messages. */
  readonly runtime: 'node' | 'browser' | 'memory';
  /** Object serialization parameters (sha1 vs sha256 digest+hex sizes). */
  readonly hashConfig: HashConfig;
  /** Shared delta-base LRU cache; consumed by primitives' iterative delta walker. */
  readonly deltaCache: LruCache<Uint8Array>;
  /**
   * This Context's cache-identity anchor — internal and opaque, never
   * constructible outside `createContext`/`deriveContext`.
   */
  readonly session: Session;
  /**
   * Resolved concurrency policy for this host, derived from machine facts by
   * the composition root. Absent means "unknown" — consumers resolve it via
   * `limitFor`, which falls back to the safe floor rather than a fast guess.
   */
  readonly concurrency?: ConcurrencyLimits;
  /** Optional facade-tier configuration (auth, parallelism, SSRF, …). Populated by openRepository. */
  readonly config?: RepositoryConfig;
  /** Optional sanitized logger. Populated by openRepository. */
  readonly logger?: Logger;
  /** Optional abort signal for cancelling long-running operations. */
  readonly signal?: AbortSignal;
  /** Optional hook runner. Absent ⇒ hooks are inert (browser, or opted out). */
  readonly hooks?: HookRunner;
  /**
   * Optional shell-command runner. Absent ⇒ a configured external merge driver
   * falls back to the built-in merge (browser / memory adapters cannot spawn a
   * process).
   */
  readonly command?: CommandRunner;
  /**
   * Optional environment-variable reader. Absent ⇒ every variable is unset (browser /
   * memory, where there is no process env). Notes-ref selection reads GIT_NOTES_REF through it.
   */
  readonly env?: EnvReader;
  /**
   * Optional SSH transport. Absent ⇒ ssh/scp remotes refuse — browser/memory
   * cannot spawn a process.
   */
  readonly ssh?: SshTransport;
  /**
   * Optional promisor-remote capability. Populated by `openRepository`;
   * `readObject` consults it to lazy-fetch an object a partial clone omitted.
   */
  readonly promisor?: PromisorRemote;
  /**
   * Optional facade capability returning a `FileSystem` confined to one or more
   * linked worktree paths AND the common dir (ADR-298). The worktree commands
   * route worktree-directory I/O through it so worktrees outside `workDir` stay
   * faithful without dropping containment (`move` passes both endpoints). Absent
   * on sandboxed adapters (memory/browser), where worktrees are confined under
   * the adapter root.
   */
  readonly worktreeFs?: (worktreePath: string | ReadonlyArray<string>) => FileSystem;
}

export interface CreateContextParts {
  readonly fs: FileSystem;
  readonly hash: HashService;
  readonly compressor: Compressor;
  readonly transport: HttpTransport;
  readonly progress: ProgressReporter;
  readonly layout: RepositoryLayout;
  readonly cwd?: string;
  readonly runtime: 'node' | 'browser' | 'memory';
  readonly hashConfig: HashConfig;
  readonly deltaCache: LruCache<Uint8Array>;
  readonly concurrency?: ConcurrencyLimits;
  readonly config?: RepositoryConfig;
  readonly logger?: Logger;
  readonly signal?: AbortSignal;
  readonly hooks?: HookRunner;
  readonly command?: CommandRunner;
  readonly env?: EnvReader;
  readonly ssh?: SshTransport;
}

/** Assemble a frozen Context from its constituent ports + layout. */
export function createContext(parts: CreateContextParts): Context {
  return Object.freeze({
    ...parts,
    cwd: parts.cwd ?? parts.layout.workDir ?? parts.layout.gitDir,
    session: createSession(),
  });
}
