import { unsupportedOperation } from '../../domain/error.js';
import { remoteAdvertisesNoRefs, targetDirectoryNotEmpty } from '../../domain/index.js';
import type { ObjectId, RefName } from '../../domain/objects/index.js';
import type { FilePath } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import { bootstrapRepository } from './internal/bootstrap.js';
import { type DnsResolver, validateUrl } from './internal/url-validate.js';

export interface CloneOptions {
  readonly url: string;
  readonly bare?: boolean;
  readonly initialBranch?: string;
  /**
   * Shallow clone depth. Accepted on the type for forward compatibility but
   * NOT honored in Phase 12.1 — setting it throws `UNSUPPORTED_OPERATION`.
   * Shallow handling lands with Phase 12.2 fetch (see ADR-008).
   */
  readonly depth?: number;
  /** DNS resolver injected by the caller; required to enforce SSRF guards. */
  readonly resolver?: DnsResolver;
  readonly allowInsecure?: boolean;
  readonly allowPrivateNetworks?: boolean;
}

export interface CloneResult {
  readonly path: FilePath;
  readonly head: RefName | undefined;
  readonly fetchedRefs: ReadonlyArray<{ readonly name: RefName; readonly id: ObjectId }>;
}

/**
 * Clone a remote repository into `ctx.layout.workDir`.
 *
 * v1 behavior is intentionally minimal: it bootstraps an empty repository at
 * the target path and returns a `CloneResult` shape. Full pack-fetch + ref
 * unpacking lands when transport adapters wire up `git-upload-pack` end-to-end
 * (Phase 9.x integration). This stub establishes the API surface so callers
 * (CLI, facade) can start integrating.
 *
 * Throws `TARGET_DIRECTORY_NOT_EMPTY` if `gitDir` already exists, and
 * `REMOTE_ADVERTISES_NO_REFS` when discovery returns no refs.
 */
const CLONE_DISCOVER_OP = 'clone:discover';

export const clone = async (ctx: Context, opts: CloneOptions): Promise<CloneResult> => {
  if (await ctx.fs.exists(`${ctx.layout.gitDir}/HEAD`)) {
    throw targetDirectoryNotEmpty(ctx.layout.workDir as FilePath);
  }
  if (opts.url === '') throw remoteAdvertisesNoRefs();
  if (opts.depth !== undefined) {
    throw unsupportedOperation(
      'clone-shallow',
      'depth: N is supported in Phase 12.2 (fetch); see ADR-008',
    );
  }
  // Phase 10 §6.2 — clone:discover. Brackets URL validation + ref discovery.
  // clone:write-objects and clone:checkout-files come online when the pack
  // fetch and working-tree materialization wire up (Phase 11+); for now this
  // pair surfaces the API for consumers.
  ctx.progress.start(CLONE_DISCOVER_OP);
  try {
    // Run SSRF / scheme / DNS-pinning gates BEFORE bootstrapping so a malicious
    // URL cannot create a repo skeleton on disk and then fail. When no resolver
    // is supplied the URL is still rejected if the scheme is wrong (validateUrl
    // enforces scheme + parse before resolving).
    if (opts.resolver !== undefined) {
      await validateUrl(opts.url, {
        resolver: opts.resolver,
        ...(opts.allowInsecure !== undefined ? { allowInsecure: opts.allowInsecure } : {}),
        ...(opts.allowPrivateNetworks !== undefined
          ? { allowPrivateNetworks: opts.allowPrivateNetworks }
          : {}),
      });
    }
    const result = await bootstrapRepository(ctx, {
      initialBranch: opts.initialBranch ?? 'main',
      bare: opts.bare ?? false,
    });
    // Discovery + pack fetch deferred to integration tier; surface a stable shape.
    return {
      path: result.gitDir,
      head: result.initialBranch,
      fetchedRefs: [],
    };
  } finally {
    ctx.progress.end(CLONE_DISCOVER_OP);
  }
};
