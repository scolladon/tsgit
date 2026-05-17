import { remoteAdvertisesNoRefs, targetDirectoryNotEmpty } from '../../domain/index.js';
import type { ObjectId, RefName } from '../../domain/objects/index.js';
import type { FilePath } from '../../domain/objects/object-id.js';
import type { Advertisement } from '../../domain/protocol/index.js';
import type { Context } from '../../ports/context.js';
import { fetchPack } from '../primitives/fetch-pack.js';
import { updateShallow } from '../primitives/shallow-file.js';
import { bootstrapRepository } from './internal/bootstrap.js';
import { withDefaults } from './internal/network-pipeline.js';
import {
  discoverRefs,
  selectFetchCapabilities,
  uniqueRefOids,
} from './internal/upload-pack-client.js';
import { type DnsResolver, validateUrl } from './internal/url-validate.js';

export interface CloneOptions {
  readonly url: string;
  readonly bare?: boolean;
  readonly initialBranch?: string;
  /**
   * Shallow clone depth. When set, sends `deepen N` and persists the
   * resulting shallow boundaries to `.git/shallow`. Phase 12.2 (see ADR-009).
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
 * Performs URL validation (SSRF guards), bootstraps a `.git` skeleton,
 * discovers refs via smart-HTTP v1, fetches the pack, writes it under
 * `.git/objects/pack/`, propagates remote refs into the local layout
 * (HEAD-tracked branch under `refs/heads/<branch>`, all branches under
 * `refs/remotes/origin/<branch>`, tags under `refs/tags/<tag>`), and
 * points `HEAD` at the remote's HEAD line.
 *
 * Working-tree materialization is Phase 13.1 — out of scope here.
 *
 * Throws `TARGET_DIRECTORY_NOT_EMPTY` if `gitDir` already exists and
 * `REMOTE_ADVERTISES_NO_REFS` when discovery returns no refs.
 */
const CLONE_DISCOVER_OP = 'clone:discover';
const CLONE_WRITE_OBJECTS_OP = 'clone:write-objects';

export const clone = async (ctx: Context, opts: CloneOptions): Promise<CloneResult> => {
  if (await ctx.fs.exists(`${ctx.layout.gitDir}/HEAD`)) {
    throw targetDirectoryNotEmpty(ctx.layout.workDir as FilePath);
  }
  if (opts.url === '') throw remoteAdvertisesNoRefs();
  ctx.progress.start(CLONE_DISCOVER_OP);
  try {
    // Defense-in-depth URL validation. Production callers go through
    // `openRepository`, which wraps `ctx.transport` with `wrapTransportValidator`
    // — every transport.request() then runs `validateUrl` using
    // `config.dnsResolver` from the facade. This in-clone path only fires when
    // a caller manually constructs a Context and passes `opts.resolver`; both
    // layers run when both are configured, which is harmless.
    if (opts.resolver !== undefined) {
      await validateUrl(opts.url, {
        resolver: opts.resolver,
        ...(opts.allowInsecure !== undefined ? { allowInsecure: opts.allowInsecure } : {}),
        ...(opts.allowPrivateNetworks !== undefined
          ? { allowPrivateNetworks: opts.allowPrivateNetworks }
          : {}),
      });
    }
    const bootstrap = await bootstrapRepository(ctx, {
      initialBranch: opts.initialBranch ?? 'main',
      bare: opts.bare ?? false,
    });
    try {
      return await fetchAndPropagate(ctx, opts, bootstrap.gitDir);
    } catch (err) {
      // Bootstrap rolls itself back on its own error path; we mirror the
      // semantics for failures past that point so callers always get a clean
      // workspace on any clone failure.
      await ctx.fs.rmRecursive(ctx.layout.gitDir).catch(() => undefined);
      throw err;
    }
  } finally {
    ctx.progress.end(CLONE_DISCOVER_OP);
  }
};

const fetchAndPropagate = async (
  ctx: Context,
  opts: CloneOptions,
  gitDir: FilePath,
): Promise<CloneResult> => {
  // withDefaults composes withRetry around ctx.transport. We omit `logger`
  // here because the transport-tier Logger shape (event-based) differs from
  // the ports Logger shape on ctx.logger (level-based). Hooking the two up
  // is wiring work better suited to a dedicated adapter in Phase 12.x.
  const transport = withDefaults(ctx, {
    ...(ctx.config?.auth !== undefined ? { auth: ctx.config.auth } : {}),
  });
  const advertisement = await discoverRefs(ctx, transport, opts.url);
  if (advertisement.refs.length === 0) throw remoteAdvertisesNoRefs();
  const capabilities = selectFetchCapabilities(advertisement.capabilities);
  const wants = uniqueRefOids(advertisement.refs);
  const packResult = await fetchPack(ctx, transport, {
    wants,
    haves: [],
    capabilities,
    url: opts.url,
    progressOp: CLONE_WRITE_OBJECTS_OP,
    ...(opts.depth !== undefined ? { depth: opts.depth } : {}),
  });
  if (packResult.shallow.length > 0) {
    // Clone never sees `unshallow` (the local repo is empty until now), but
    // updateShallow handles a populated `unshallow` correctly — pass the
    // packResult array verbatim instead of dropping it.
    await updateShallow(ctx, {
      shallow: packResult.shallow,
      unshallow: packResult.unshallow,
    });
  }
  const fetchedRefs = await writeFetchedRefs(ctx, advertisement);
  const head = await applyRemoteHead(ctx, advertisement);
  return { path: gitDir, head, fetchedRefs };
};

const writeFetchedRefs = async (
  ctx: Context,
  advertisement: Advertisement,
): Promise<ReadonlyArray<{ readonly name: RefName; readonly id: ObjectId }>> => {
  const headBranch = headTrackedBranch(advertisement);
  const written: Array<{ name: RefName; id: ObjectId }> = [];
  for (const ref of advertisement.refs) {
    if (ref.name === 'HEAD') continue;
    if (ref.name.startsWith('refs/heads/')) {
      const branch = ref.name.slice('refs/heads/'.length);
      const remoteRef = `refs/remotes/origin/${branch}` as RefName;
      await writeRef(ctx, remoteRef, ref.id);
      written.push({ name: remoteRef, id: ref.id });
      if (headBranch !== undefined && branch === headBranch) {
        const localRef = ref.name as RefName;
        await writeRef(ctx, localRef, ref.id);
        written.push({ name: localRef, id: ref.id });
      }
      continue;
    }
    if (ref.name.startsWith('refs/tags/')) {
      const tagRef = ref.name as RefName;
      await writeRef(ctx, tagRef, ref.id);
      written.push({ name: tagRef, id: ref.id });
      continue;
    }
    // Other namespaces (refs/notes/*, refs/pull/*, …) are skipped per the
    // ref-layout policy in design §3.7.
    ctx.logger?.debug?.('clone: skipping unsupported ref namespace', { name: ref.name });
  }
  return written;
};

const writeRef = async (ctx: Context, name: RefName, id: ObjectId): Promise<void> => {
  const refPath = `${ctx.layout.gitDir}/${name}`;
  await ctx.fs.writeUtf8(refPath, `${id}\n`);
};

const headTrackedBranch = (ad: Advertisement): string | undefined => {
  const symref = ad.capabilities.find((c) => c.startsWith('symref=HEAD:refs/heads/'));
  if (symref === undefined) return undefined;
  return symref.slice('symref=HEAD:refs/heads/'.length);
};

const applyRemoteHead = async (
  ctx: Context,
  advertisement: Advertisement,
): Promise<RefName | undefined> => {
  const branch = headTrackedBranch(advertisement);
  if (branch !== undefined) {
    const ref = `refs/heads/${branch}` as RefName;
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, `ref: ${ref}\n`);
    return ref;
  }
  // Detached HEAD — write the HEAD oid directly. The advertisement carries it
  // via head.id even when symref is missing (e.g., for a server that does not
  // expose the symref capability).
  if (advertisement.head !== undefined) {
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, `${advertisement.head.id}\n`);
    return undefined;
  }
  return undefined;
};
