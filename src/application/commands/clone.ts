import { unsupportedOperation } from '../../domain/error.js';
import { remoteAdvertisesNoRefs, targetDirectoryNotEmpty } from '../../domain/index.js';
import type { ObjectId, RefName } from '../../domain/objects/index.js';
import type { FilePath } from '../../domain/objects/object-id.js';
import type { AdvertisedRef, Advertisement } from '../../domain/protocol/index.js';
import {
  AGENT,
  buildDiscoveryUrl,
  CLIENT_CAPABILITIES_FETCH,
  decodePktStream,
  negotiateCapabilities as negotiateProtocolCapabilities,
  parseAdvertisedRefs,
} from '../../domain/protocol/index.js';
import type { Context } from '../../ports/context.js';
import type { HttpTransport } from '../../ports/http-transport.js';
import { fetchPack } from '../primitives/fetch-pack.js';
import { bootstrapRepository } from './internal/bootstrap.js';
import { withDefaults } from './internal/network-pipeline.js';
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
 * Performs URL validation (SSRF guards), bootstraps a `.git` skeleton,
 * discovers refs via smart-HTTP v1, fetches the pack, writes it under
 * `.git/objects/pack/`, propagates remote refs into the local layout
 * (HEAD-tracked branch under `refs/heads/<branch>`, all branches under
 * `refs/remotes/origin/<branch>`, tags under `refs/tags/<tag>`), and
 * points `HEAD` at the remote's HEAD line.
 *
 * Working-tree materialization is Phase 13.1 — out of scope here.
 *
 * Throws `TARGET_DIRECTORY_NOT_EMPTY` if `gitDir` already exists,
 * `REMOTE_ADVERTISES_NO_REFS` when discovery returns no refs, and
 * `UNSUPPORTED_OPERATION` when `depth: N` is set (ADR-008).
 */
const CLONE_DISCOVER_OP = 'clone:discover';
const CLONE_WRITE_OBJECTS_OP = 'clone:write-objects';

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
  ctx.progress.start(CLONE_DISCOVER_OP);
  try {
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
  const capabilities = selectCapabilities(advertisement.capabilities);
  const wants = uniqueOids(advertisement.refs);
  await fetchPack(ctx, transport, {
    wants,
    haves: [],
    capabilities,
    url: opts.url,
    progressOp: CLONE_WRITE_OBJECTS_OP,
  });
  const fetchedRefs = await writeFetchedRefs(ctx, advertisement);
  const head = await applyRemoteHead(ctx, advertisement);
  return { path: gitDir, head, fetchedRefs };
};

const discoverRefs = async (
  ctx: Context,
  transport: HttpTransport,
  url: string,
): Promise<Advertisement> => {
  const discoveryUrl = buildDiscoveryUrl(url, 'git-upload-pack');
  const response = await transport.request({
    url: discoveryUrl,
    method: 'GET',
    headers: { accept: 'application/x-git-upload-pack-advertisement' },
    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
  });
  // 2xx responses pass through; HTTP errors surface via withRetry / the
  // adapter as TsgitError. We don't gate on a specific status here — the
  // pkt-line parser will reject any non-protocol payload below.
  const pktStream = decodePktStream(readableStreamToAsyncIterable(response.body));
  return parseAdvertisedRefs(pktStream, 'git-upload-pack');
};

const readableStreamToAsyncIterable = (
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> => ({
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    const reader = stream.getReader();
    return {
      next: async (): Promise<IteratorResult<Uint8Array>> => {
        const { done, value } = await reader.read();
        return done ? { done: true, value: undefined } : { done: false, value };
      },
      return: async (): Promise<IteratorResult<Uint8Array>> => {
        reader.releaseLock();
        return { done: true, value: undefined };
      },
    };
  },
});

const selectCapabilities = (advertised: ReadonlyArray<string>): ReadonlyArray<string> => {
  // Drop client capabilities Phase 12.1 cannot honor end-to-end (see design
  // §3.6): no negotiation rounds (`multi_ack_detailed`), no thin-pack repair,
  // no `no-progress` (we want channel-2 text for the reporter).
  const clientWants = CLIENT_CAPABILITIES_FETCH.filter(
    (c) => c !== 'multi_ack_detailed' && c !== 'thin-pack' && c !== 'no-progress' && c !== AGENT,
  );
  const intersected = negotiateProtocolCapabilities(advertised, clientWants);
  // Always send our agent — server doesn't need to advertise it.
  return [...intersected, AGENT];
};

const uniqueOids = (refs: ReadonlyArray<AdvertisedRef>): ReadonlyArray<ObjectId> => {
  const seen = new Set<string>();
  const out: ObjectId[] = [];
  for (const r of refs) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r.id);
    if (r.peeled !== undefined && !seen.has(r.peeled)) {
      seen.add(r.peeled);
      out.push(r.peeled);
    }
  }
  return out;
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
