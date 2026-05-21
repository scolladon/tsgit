import * as commands from './application/commands/index.js';
import * as primitives from './application/primitives/index.js';
import { disposeAdapters } from './dispose-adapters.js';
import { repositoryDisposed } from './domain/commands/error.js';
import type { Compressor } from './ports/compressor.js';
import type { Context, RepositoryConfig } from './ports/context.js';
import type { FileSystem } from './ports/file-system.js';
import type { HashService } from './ports/hash-service.js';
import type { HookRunner } from './ports/hook-runner.js';
import type { HttpTransport } from './ports/http-transport.js';
import { type Logger, wrapLoggerSanitizer } from './ports/logger.js';
import type { ProgressReporter } from './ports/progress-reporter.js';
import { noopProgress } from './progress.js';
import { composeAdapters } from './repository/compose-adapters.js';
import { deepFreeze } from './repository/deep-freeze.js';
import { defaultCwd } from './repository/default-cwd.js';
import { validateOptions } from './repository/validate-options.js';
import { wrapFsValidator } from './repository/wrap-fs-validator.js';
import { wrapTransportValidator } from './repository/wrap-transport-validator.js';

/**
 * Helper that strips the leading `Context` parameter from a function type so
 * the bound version on `Repository` exposes the user-facing signature.
 */
type BindCtx<F> = F extends (ctx: Context, ...rest: infer A) => infer R ? (...args: A) => R : never;

/**
 * User-facing options passed to `openRepository`. Subset of the design's
 * `OpenRepositoryOptions` that this Step 3 implementation honors. Every field
 * is optional; the facade fills sensible defaults. Field-level validation runs
 * eagerly before the Repository is returned.
 */
export interface OpenRepositoryOptions {
  /** Working directory. Default: `process.cwd()` on Node, `'/'` on browser/memory. */
  readonly cwd?: string;
  /** Adapter overrides. Each is optional; missing slots fall back to runtime detection. */
  readonly fs?: FileSystem;
  readonly hash?: HashService;
  readonly compressor?: Compressor;
  readonly transport?: HttpTransport;
  /** Repository config (auth, parallelism, SSRF allowlist, etc.). Frozen via deepFreeze. */
  readonly config?: RepositoryConfig;
  /** Logger for diagnostics. Wrapped to prevent mutation post-construction. */
  readonly logger?: Logger;
  /** Progress reporter; defaults to `noopProgress`. */
  readonly progress?: ProgressReporter;
  /** AbortSignal threaded into every bound method's ctx.signal. */
  readonly signal?: AbortSignal;
  /**
   * Hook runner. Omit to inherit the runtime default (Node wires one; the
   * browser does not). Pass `false` to disable hooks entirely.
   */
  readonly hooks?: HookRunner | false;
  /**
   * Opt OUT of adapter validator wrapping for `fs` and `transport`. NEVER set
   * with adapters whose code you do not control; a raw transport receives
   * `config.auth` credentials with no SSRF guard.
   */
  readonly unsafeRawAdapters?: boolean;
}

/**
 * Caller-supplied physical layout for the in-construction Context.'s
 * design defers full layout discovery (walk up from cwd until `.git` is found)
 * to a follow-up; for this iteration the caller must provide the resolved
 * layout explicitly (the runtime shims do this in Step 5).
 *
 * @internal
 */
export interface RepositoryLayoutInput {
  readonly workDir: string;
  readonly gitDir: string;
  readonly bare: boolean;
  readonly homeDir?: string;
}

/**
 * Internal-runtime fallback set provided by the calling shim — each runtime
 * (`index.node.ts`, `index.browser.ts`, `index.default.ts`) supplies its own
 * pre-built adapter set + layout discovery + hashConfig + deltaCache. The
 * fallback shape stays internal because the user-facing `OpenRepositoryOptions`
 * does not expose these details.
 *
 * @internal
 */
export interface RuntimeFallback {
  readonly fs: FileSystem;
  readonly hash: HashService;
  readonly compressor: Compressor;
  readonly transport: HttpTransport;
  /** Optional runtime-default hook runner (Node supplies one; others omit it). */
  readonly hooks?: HookRunner;
  readonly runtime: 'node' | 'browser' | 'memory';
  readonly layout: RepositoryLayoutInput;
  readonly hashConfig: Context['hashConfig'];
  readonly deltaCache: Context['deltaCache'];
}

/**
 * The frozen repository handle returned by `openRepository`. Every command
 * and primitive is bound to a Context constructed at facade-creation time;
 * users never see Context except through `repo.ctx`.
 */
export interface Repository {
  // Tier-1 commands (17) — bound to ctx.
  readonly add: BindCtx<typeof commands.add>;
  readonly branch: BindCtx<typeof commands.branch>;
  readonly checkout: BindCtx<typeof commands.checkout>;
  readonly clone: BindCtx<typeof commands.clone>;
  readonly commit: BindCtx<typeof commands.commit>;
  readonly diff: BindCtx<typeof commands.diff>;
  readonly fetch: BindCtx<typeof commands.fetch>;
  readonly init: BindCtx<typeof commands.init>;
  readonly log: BindCtx<typeof commands.log>;
  readonly merge: BindCtx<typeof commands.merge>;
  readonly push: BindCtx<typeof commands.push>;
  readonly reflog: BindCtx<typeof commands.reflog>;
  readonly reset: BindCtx<typeof commands.reset>;
  readonly revParse: BindCtx<typeof commands.revParse>;
  readonly rm: BindCtx<typeof commands.rm>;
  readonly status: BindCtx<typeof commands.status>;
  readonly tag: BindCtx<typeof commands.tag>;

  // Tier-2 primitives (16) — bound under.primitives.* to keep the top-level
  // surface focused on user-facing commands.
  readonly primitives: {
    readonly createCommit: BindCtx<typeof primitives.createCommit>;
    readonly diffTrees: BindCtx<typeof primitives.diffTrees>;
    readonly getRepoRoot: BindCtx<typeof primitives.getRepoRoot>;
    readonly mergeBase: BindCtx<typeof primitives.mergeBase>;
    readonly readBlob: BindCtx<typeof primitives.readBlob>;
    readonly readIndex: BindCtx<typeof primitives.readIndex>;
    readonly readObject: BindCtx<typeof primitives.readObject>;
    readonly readTree: BindCtx<typeof primitives.readTree>;
    readonly recordRefUpdate: BindCtx<typeof primitives.recordRefUpdate>;
    readonly resolveRef: BindCtx<typeof primitives.resolveRef>;
    readonly runHook: BindCtx<typeof primitives.runHook>;
    readonly updateRef: BindCtx<typeof primitives.updateRef>;
    readonly walkCommits: BindCtx<typeof primitives.walkCommits>;
    readonly walkTree: BindCtx<typeof primitives.walkTree>;
    readonly walkWorkingTree: BindCtx<typeof primitives.walkWorkingTree>;
    readonly writeObject: BindCtx<typeof primitives.writeObject>;
    readonly writeSymbolicRef: BindCtx<typeof primitives.writeSymbolicRef>;
    readonly writeTree: BindCtx<typeof primitives.writeTree>;
  };

  /** The frozen Context backing every binding. Exposed for advanced use. */
  readonly ctx: Context;

  /**
   * Dispose the repository. Aborts `ctx.signal` synchronously, yields a
   * macrotask, then runs `disposeAdapters`. Idempotent. After dispose
   * resolves, every bound method throws `REPOSITORY_DISPOSED`.
   */
  readonly dispose: () => Promise<void>;
}

type DisposeState = 'OPEN' | 'DISPOSING' | 'DISPOSED';

/**
 * Factory for the Repository handle. The runtime fallback (adapters + layout)
 * is supplied by the calling shim — `openRepository` itself is runtime-agnostic.
 */
export const openRepository = async (
  opts: OpenRepositoryOptions,
  fallback: RuntimeFallback,
): Promise<Repository> => {
  validateOptions(opts);
  const cwd = opts.cwd ?? defaultCwd();
  const detected = composeAdapters(opts, fallback);
  // Containment is rooted at the REPO (layout.workDir), not the user's cwd —
  // when cwd is a sub-directory of the repo, primitives still need to read
  // files anywhere under the workDir (e.g., gitDir/HEAD lives at the repo root,
  // not under the sub-directory). The security goal is "no paths outside
  // the repo," which is exactly the layout.workDir boundary.
  const adapters =
    opts.unsafeRawAdapters === true
      ? detected
      : {
          ...detected,
          fs: wrapFsValidator(detected.fs, fallback.layout.workDir),
          transport: wrapTransportValidator(detected.transport, opts.config),
        };
  const config = opts.config !== undefined ? deepFreeze({ ...opts.config }) : undefined;
  const controller = new AbortController();
  const signal =
    opts.signal !== undefined
      ? AbortSignal.any([controller.signal, opts.signal])
      : controller.signal;
  // Build ctx incrementally so optional fields (config, logger) are absent
  // when undefined — required by `exactOptionalPropertyTypes: true`.
  const baseCtx = {
    fs: adapters.fs,
    hash: adapters.hash,
    compressor: adapters.compressor,
    transport: adapters.transport,
    progress: opts.progress ?? noopProgress,
    layout: fallback.layout,
    cwd,
    hashConfig: fallback.hashConfig,
    deltaCache: fallback.deltaCache,
    signal,
  };
  const sanitizedLogger = opts.logger !== undefined ? wrapLoggerSanitizer(opts.logger) : undefined;
  // `false` fully disables hooks; otherwise an explicit runner overrides the
  // runtime default (Node supplies one, browser/memory do not).
  const hooks = opts.hooks === false ? undefined : (opts.hooks ?? fallback.hooks);
  const ctx: Context = Object.freeze({
    ...baseCtx,
    ...(config !== undefined ? { config } : {}),
    ...(sanitizedLogger !== undefined ? { logger: sanitizedLogger } : {}),
    ...(hooks !== undefined ? { hooks } : {}),
  });

  let state: DisposeState = 'OPEN';
  let disposePromise: Promise<void> | undefined;
  const dispose = async (): Promise<void> => {
    // Stryker disable next-line ConditionalExpression: equivalent — `state === 'DISPOSED'` implies `disposePromise` is already set (state only flips to DISPOSED inside the IIFE assigned to disposePromise), so the next guard returns the same resolved promise; removing this fast-path changes nothing observable.
    if (state === 'DISPOSED') return;
    if (disposePromise !== undefined) return disposePromise;
    state = 'DISPOSING';
    controller.abort(); // synchronous abort — gates every bound method via ctx.signal.aborted
    disposePromise = (async () => {
      // Macrotask boundary: lets queued I/O callbacks observe the abort and unwind
      // via try/finally before adapters are torn down. setImmediate is preferred
      // when available (Node); setTimeout(0) is the cross-runtime fallback.
      await new Promise<void>((resolve) => {
        if (typeof setImmediate === 'function') setImmediate(resolve);
        else setTimeout(resolve, 0);
      });
      await disposeAdapters(ctx);
      state = 'DISPOSED';
    })();
    return disposePromise;
  };
  const guard = (): void => {
    // ctx.signal is unconditionally assigned at construction (line above the
    // ctx.freeze) so the non-null assertion is safe. The aborted check is
    // synchronous against `controller.abort()` inside dispose() — atomic gate.
    // A `state !== 'OPEN'` operand would be dead code here: dispose() flips
    // state away from 'OPEN' and calls controller.abort() in the same tick
    // (no await between), so `ctx.signal.aborted` is already true in every
    // non-'OPEN' state — `aborted` alone fully covers the disposed case.
    if (ctx.signal!.aborted) {
      throw repositoryDisposed();
    }
  };

  const repo: Repository = Object.freeze({
    add: ((paths, addOpts) => {
      guard();
      return commands.add(ctx, paths, addOpts);
    }) as Repository['add'],
    branch: ((action) => {
      guard();
      return commands.branch(ctx, action);
    }) as Repository['branch'],
    checkout: ((checkoutOpts) => {
      guard();
      return commands.checkout(ctx, checkoutOpts);
    }) as Repository['checkout'],
    clone: ((cloneOpts) => {
      guard();
      return commands.clone(ctx, cloneOpts);
    }) as Repository['clone'],
    commit: ((commitOpts) => {
      guard();
      return commands.commit(ctx, commitOpts);
    }) as Repository['commit'],
    diff: ((diffOpts) => {
      guard();
      return commands.diff(ctx, diffOpts);
    }) as Repository['diff'],
    fetch: ((fetchOpts) => {
      guard();
      return commands.fetch(ctx, fetchOpts);
    }) as Repository['fetch'],
    init: ((initOpts) => {
      guard();
      return commands.init(ctx, initOpts);
    }) as Repository['init'],
    log: ((logOpts) => {
      guard();
      return commands.log(ctx, logOpts);
    }) as Repository['log'],
    merge: ((mergeOpts) => {
      guard();
      return commands.merge(ctx, mergeOpts);
    }) as Repository['merge'],
    push: ((pushOpts) => {
      guard();
      return commands.push(ctx, pushOpts);
    }) as Repository['push'],
    reflog: ((reflogOpts) => {
      guard();
      return commands.reflog(ctx, reflogOpts);
    }) as Repository['reflog'],
    reset: ((resetOpts) => {
      guard();
      return commands.reset(ctx, resetOpts);
    }) as Repository['reset'],
    revParse: ((expression) => {
      guard();
      return commands.revParse(ctx, expression);
    }) as Repository['revParse'],
    rm: ((paths, rmOpts) => {
      guard();
      return commands.rm(ctx, paths, rmOpts);
    }) as Repository['rm'],
    status: (() => {
      guard();
      return commands.status(ctx);
    }) as Repository['status'],
    tag: ((action) => {
      guard();
      return commands.tag(ctx, action);
    }) as Repository['tag'],
    primitives: Object.freeze({
      createCommit: ((input) => {
        guard();
        return primitives.createCommit(ctx, input);
      }) as Repository['primitives']['createCommit'],
      diffTrees: ((a, b, options) => {
        guard();
        return primitives.diffTrees(ctx, a, b, options);
      }) as Repository['primitives']['diffTrees'],
      getRepoRoot: (() => {
        guard();
        return primitives.getRepoRoot(ctx);
      }) as Repository['primitives']['getRepoRoot'],
      mergeBase: ((a, b) => {
        guard();
        return primitives.mergeBase(ctx, a, b);
      }) as Repository['primitives']['mergeBase'],
      readBlob: ((id, options) => {
        guard();
        return primitives.readBlob(ctx, id, options);
      }) as Repository['primitives']['readBlob'],
      readIndex: (() => {
        guard();
        return primitives.readIndex(ctx);
      }) as Repository['primitives']['readIndex'],
      readObject: ((id, options) => {
        guard();
        return primitives.readObject(ctx, id, options);
      }) as Repository['primitives']['readObject'],
      readTree: ((ref) => {
        guard();
        return primitives.readTree(ctx, ref);
      }) as Repository['primitives']['readTree'],
      recordRefUpdate: ((name, oldId, newId, message) => {
        guard();
        return primitives.recordRefUpdate(ctx, name, oldId, newId, message);
      }) as Repository['primitives']['recordRefUpdate'],
      resolveRef: ((name, options) => {
        guard();
        return primitives.resolveRef(ctx, name, options);
      }) as Repository['primitives']['resolveRef'],
      runHook: ((name, input) => {
        guard();
        return primitives.runHook(ctx, name, input);
      }) as Repository['primitives']['runHook'],
      updateRef: ((name, newId, options) => {
        guard();
        return primitives.updateRef(ctx, name, newId, options);
      }) as Repository['primitives']['updateRef'],
      walkCommits: ((options) => {
        guard();
        return primitives.walkCommits(ctx, options);
      }) as Repository['primitives']['walkCommits'],
      walkTree: ((treeIdOrObject, options) => {
        guard();
        return primitives.walkTree(ctx, treeIdOrObject, options);
      }) as Repository['primitives']['walkTree'],
      walkWorkingTree: ((options) => {
        guard();
        return primitives.walkWorkingTree(ctx, options);
      }) as Repository['primitives']['walkWorkingTree'],
      writeObject: ((object) => {
        guard();
        return primitives.writeObject(ctx, object);
      }) as Repository['primitives']['writeObject'],
      writeSymbolicRef: ((name, target) => {
        guard();
        return primitives.writeSymbolicRef(ctx, name, target);
      }) as Repository['primitives']['writeSymbolicRef'],
      writeTree: ((entries) => {
        guard();
        return primitives.writeTree(ctx, entries);
      }) as Repository['primitives']['writeTree'],
    }),
    ctx,
    dispose,
  });
  return repo;
};
